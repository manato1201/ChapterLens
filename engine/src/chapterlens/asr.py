"""ローカルの音声認識(CH2): faster-whisper で、単語ごとの時刻つきの文字起こしを作る。

- faster-whisper は**任意の依存**(`uv sync --extra asr`)。入っていなければ、分かりやすいエラーにする
- モデルは HuggingFace のローカルキャッシュ(Systran/faster-whisper-<size>)を使う。ネットワークには出ない
- 出力: 発話の「かたまり(Cue)」と、単語ごとの時刻(Word)。Cue は検出器(字幕と同じ形)にそのまま渡せる
- 単語の時刻は、CH0 の字幕(1 秒刻み・数秒のかたまり)より細かい。境界を**発話の頭**に合わせる(snap_to_utterances)のに使う
"""

from __future__ import annotations

import bisect
import glob
import os
import shutil
import subprocess
import sys
import wave
from dataclasses import dataclass
from pathlib import Path

from .captions import Cue


@dataclass(frozen=True)
class Word:
    start_s: float
    end_s: float
    text: str
    prob: float = 1.0


@dataclass
class AsrResult:
    language: str
    duration_s: float
    cues: list[Cue]
    words: list[Word]
    model: str
    device: str


class AsrUnavailable(RuntimeError):
    pass


def decode_audio(path: str | Path, sample_rate: int = 16000):
    """音声ファイル → 16kHz・モノラルの float32 配列(numpy)。

    16kHz・16bit・モノラルの WAV は標準ライブラリだけで読む。それ以外(webm/opus・mp3 など)は ffmpeg で読む。
    PyAV の版に依存しない(faster-whisper の組み込みのデコードは、PyAV の版で壊れることがある)。
    """
    import numpy as np

    path = Path(path)
    if path.suffix.lower() == ".wav":
        try:
            with wave.open(str(path), "rb") as w:
                if w.getnchannels() == 1 and w.getsampwidth() == 2 and w.getframerate() == sample_rate:
                    return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        except wave.Error:
            pass
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise AsrUnavailable("ffmpeg が見つかりません(WAV 以外の音声を読むのに必要です)")
    proc = subprocess.run(
        [ffmpeg, "-nostdin", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(sample_rate), "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise AsrUnavailable(f"音声を読めませんでした: {proc.stderr.decode('utf-8', 'replace')[:200]}")
    return np.frombuffer(proc.stdout, dtype=np.float32)


def _find_cached_model(size: str) -> str:
    """HuggingFace のキャッシュにある重みのフォルダ。無ければ、モデル名(= ネットワーク取得)を返す。"""
    root = Path.home() / ".cache" / "huggingface" / "hub" / f"models--Systran--faster-whisper-{size}" / "snapshots"
    if root.exists():
        for snap in sorted(root.iterdir()):
            if (snap / "model.bin").exists():
                return str(snap)
    return size


def transcribe(
    audio_path: str | Path,
    *,
    language: str | None = None,
    model_size: str = "small",
    device: str = "auto",
    compute_type: str | None = None,
) -> AsrResult:
    """音声ファイル → 文字起こし(単語ごとの時刻つき)。language を省略すると自動判定。"""
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:  # pragma: no cover - 環境依存
        raise AsrUnavailable("faster-whisper が入っていません。`uv sync --extra asr` を実行してください") from e

    model_ref = _find_cached_model(model_size)
    if device in ("auto", "cuda"):
        _prepare_cuda_dlls()
    if device == "auto":
        device = "cuda" if _cuda_ok() else "cpu"
    audio = decode_audio(audio_path)

    def run(dev: str, ctype: str | None):
        ctype = ctype or ("float16" if dev == "cuda" else "int8")
        model = WhisperModel(model_ref, device=dev, compute_type=ctype)
        segments, info = model.transcribe(audio, language=language, word_timestamps=True, vad_filter=False, beam_size=5)
        # segments は遅延評価。CUDA ライブラリ(cuBLAS・cuDNN)が無いときは、ここで初めて失敗する
        return list(segments), info, f"{dev}/{ctype}"

    try:
        segs, info, used = run(device, compute_type)
    except Exception:
        if device != "cuda":
            raise
        segs, info, used = run("cpu", None)  # GPU が使えない環境(CUDA ライブラリが無いなど)では CPU へ

    cues: list[Cue] = []
    words: list[Word] = []
    for seg in segs:
        text = seg.text.strip()
        if text:
            cues.append(Cue(float(seg.start), float(seg.end), text))
        for w in seg.words or []:
            if w.word.strip():
                words.append(Word(float(w.start), float(w.end), w.word.strip(), float(w.probability)))
    return AsrResult(info.language, float(info.duration), cues, words, f"faster-whisper {model_size}", used)


def _prepare_cuda_dlls() -> str | None:
    """GPU 用の DLL(cuBLAS 12・cuDNN 9)の置き場を、DLL の検索パスに足す。見つけたフォルダを返す。

    CTranslate2(faster-whisper)は cublas64_12.dll と cudnn64_9.dll を要る。ここの環境には、
    CUDA 版の PyTorch(torch/lib)が同梱しているものがある。環境変数 CHAPTERLENS_CUDA_LIB_DIR で明示もできる。
    """
    if os.name != "nt":
        return None
    candidates = [os.environ.get("CHAPTERLENS_CUDA_LIB_DIR", "")]
    local = os.environ.get("LOCALAPPDATA", "")
    candidates += glob.glob(os.path.join(local, "Programs", "Python", "Python3*", "Lib", "site-packages", "torch", "lib"))
    candidates += glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin"))
    found = None
    for d in candidates:
        if d and os.path.exists(os.path.join(d, "cublas64_12.dll")) and os.path.exists(os.path.join(d, "cudnn64_9.dll")):
            found = d
            break
    if found:
        os.add_dll_directory(found)
        os.environ["PATH"] = found + os.pathsep + os.environ.get("PATH", "")
    return found


def _cuda_ok() -> bool:
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


# ---------- 境界を「発話の頭」に合わせる(単語の時刻を使う) ----------


def utterance_starts(words: list[Word], *, min_pause_s: float = 0.35) -> list[float]:
    """発話の頭になりうる時刻: 先頭の単語と、直前に min_pause_s 以上の間(無音)がある単語の開始。"""
    starts: list[float] = []
    prev_end = None
    for w in words:
        if prev_end is None or w.start_s - prev_end >= min_pause_s:
            starts.append(w.start_s)
        prev_end = w.end_s
    return starts


def snap_to_utterances(
    boundaries: list[float], words: list[Word], *, radius_s: float = 5.0, min_pause_s: float = 0.35
) -> list[float]:
    """各境界を、近く(±radius_s)の「発話の頭」へ寄せる。近くに無ければ、最も近い単語の開始へ(±radius_s)。"""
    if not words:
        return list(boundaries)
    heads = utterance_starts(words, min_pause_s=min_pause_s)
    word_starts = [w.start_s for w in words]
    out: list[float] = []
    for b in boundaries:
        best = _nearest(heads, b, radius_s)
        if best is None:
            best = _nearest(word_starts, b, radius_s)
        out.append(best if best is not None else b)
    return out


def _nearest(sorted_values: list[float], x: float, radius: float) -> float | None:
    i = bisect.bisect_left(sorted_values, x)
    cands = [sorted_values[j] for j in (i - 1, i) if 0 <= j < len(sorted_values)]
    cands = [c for c in cands if abs(c - x) <= radius]
    return min(cands, key=lambda c: abs(c - x)) if cands else None


def _join(words: list[Word]) -> str:
    """単語をつなぐ。かな・漢字どうしは詰め、英単語の間は空白を入れる。"""
    out = ""
    for w in words:
        if out and out[-1].isascii() and w.text[:1].isascii():
            out += " "
        out += w.text
    return out


def cues_from_words(words: list[Word], *, max_cue_s: float = 6.0, pause_s: float = 0.5) -> list[Cue]:
    """単語の列から、字幕と同じ形の「かたまり」を作る(長さ max_cue_s ごと・間が pause_s 以上で区切る)。"""
    cues: list[Cue] = []
    cur: list[Word] = []
    for w in words:
        if cur and (w.start_s - cur[-1].end_s >= pause_s or w.end_s - cur[0].start_s > max_cue_s):
            cues.append(Cue(cur[0].start_s, cur[-1].end_s, _join(cur)))
            cur = []
        cur.append(w)
    if cur:
        cues.append(Cue(cur[0].start_s, cur[-1].end_s, _join(cur)))
    return cues
