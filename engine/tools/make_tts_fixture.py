"""正解の時刻が分かるテスト音声を作る(Windows の音声合成。他人の動画・音声は使わない)。

話題ごとに合成してつなぎ、つなぎ目(次の話題の発話の始まり)を正解の境界にする。
  results/tts/<lang>.wav   つないだ音声(16kHz・16bit・モノラル)
  results/tts/<lang>.json  {"duration_s", "boundaries_s": [...], "topics": [{name, start_s, end_s, text}]}
使い方:  uv run python tools/make_tts_fixture.py [en|ja|all]
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GAP_S = 0.5  # 話題の間の、ごく短い無音(自然な「間」)


def synth(text: str, voice: str, out: Path) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write(text)
        txt = f.name
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "tools" / "tts" / "speak.ps1"),
             "-TextFile", txt, "-Out", str(out), "-Voice", voice],
            check=True, capture_output=True,
        )
    except subprocess.CalledProcessError as e:
        raise SystemExit(f"音声合成に失敗: {e.stderr.decode('utf-8', 'replace')[:400]}")
    finally:
        Path(txt).unlink(missing_ok=True)


def read_wav(path: Path) -> tuple[bytes, int]:
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, "16bit モノラルのはず"
        return w.readframes(w.getnframes()), w.getframerate()


def build(lang: str) -> Path:
    spec = json.loads((ROOT / "tools" / "tts" / f"topics_{lang}.json").read_text(encoding="utf-8"))
    out_dir = ROOT / "results" / "tts"
    out_dir.mkdir(parents=True, exist_ok=True)
    pieces, rate = [], 16000
    for t in spec["topics"]:
        tmp = out_dir / f"_{lang}_{t['name']}.wav"
        synth(t["text"], spec["voice"], tmp)
        data, rate = read_wav(tmp)
        pieces.append(data)
        tmp.unlink()
    gap = b"\x00\x00" * int(rate * GAP_S)
    audio, topics, cursor = b"", [], 0.0
    for i, (t, data) in enumerate(zip(spec["topics"], pieces)):
        if i > 0:
            audio += gap
            cursor += GAP_S
        dur = len(data) / 2 / rate
        topics.append({"name": t["name"], "start_s": round(cursor, 3), "end_s": round(cursor + dur, 3), "text": t["text"]})
        audio += data
        cursor += dur
    wav_path = out_dir / f"{lang}.wav"
    with wave.open(str(wav_path), "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(rate)
        w.writeframes(audio)
    meta = {"language": spec["language"], "voice": spec["voice"], "duration_s": round(cursor, 3),
            "boundaries_s": [t["start_s"] for t in topics[1:]], "topics": topics}
    (out_dir / f"{lang}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{lang}: {meta['duration_s']:.1f} 秒・境界 {meta['boundaries_s']} → {wav_path}")
    return wav_path


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    for lang in ("en", "ja") if which == "all" else (which,):
        build(lang)
