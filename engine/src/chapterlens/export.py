"""書き出し(CH6): **自分の動画・許諾済みの素材だけ**から、ダイジェスト動画・縦の短い動画・EDL・字幕ファイルを作る。

権利の方針(設計書 §2・§13): 他人の動画の切り出し・再配布はしない。そのため
  ・動画を触る書き出し(video / short)は CLI だけ(HTTP の経路には出さない。拡張からは呼べない)
  ・「自分の動画・許諾済みの素材です」と明示した(--own)ときだけ動く。入力はこの PC の動画ファイルだけ(URL は拒否)
  ・EDL・字幕(SRT/VTT)は、時刻と文字だけのテキスト。動画には触らない

このモジュールは、時刻の計算(区間の選び直し・字幕の時間の詰め直し)、書式(EDL・SRT・VTT)、ffmpeg の引数づくりを純粋な関数で持つ。
ffmpeg / ffprobe の実行(subprocess)だけが副作用で、run_ffmpeg に閉じる。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .captions import Cue

VIDEO_SUFFIXES = {".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v", ".flv", ".mpg", ".mpeg", ".ts"}
SHORT_MAX_S = 59.0
SHORT_SIZE = (1080, 1920)
OWN_NOTICE = ("動画を切り出して作るのは、自分で撮った動画・許諾を得た素材だけです(他人の動画の切り出し・再配布はしません)。"
              "該当するなら --own を付けて、もう一度実行してください。")


class ExportError(Exception):
    pass


# ---------- 区間の扱い ----------
def fit_spans(spans: list[dict], max_s: float) -> list[dict]:
    """合計が max_s 以内になるよう、点の高い区間から選ぶ(最後に入りきらないものは、短く切って入れる)。時間順に返す。"""
    chosen: list[dict] = []
    left = max_s
    for s in sorted(spans, key=lambda s: (-s.get("score", 0.0), s["start_s"])):
        length = s["end_s"] - s["start_s"]
        if left < 3.0:
            break
        if length <= left:
            chosen.append(dict(s))
            left -= length
        else:  # 入りきらない: 頭から left 秒だけ(3 秒以上残っているときだけ)
            chosen.append({**s, "end_s": round(s["start_s"] + left, 3)})
            left = 0
    return sorted(chosen, key=lambda s: s["start_s"])


def retime_cues(cues: list[Cue], spans: list[dict]) -> list[Cue]:
    """区間をつないだ動画の時間に、字幕を詰め直す(区間の外の字幕は捨てる。区間にまたがる字幕は切る)。"""
    out: list[Cue] = []
    offset = 0.0
    for s in spans:
        lo, hi = s["start_s"], s["end_s"]
        for c in cues:
            a, b = max(c.start_s, lo), min(c.end_s, hi)
            if b - a > 0.05 and c.text.strip():
                out.append(Cue(round(offset + (a - lo), 3), round(offset + (b - lo), 3), c.text.strip()))
        offset += hi - lo
    return out


# ---------- 書式 ----------
def _srt_time(sec: float, sep: str) -> str:
    ms = round(max(0.0, sec) * 1000)
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def to_srt(cues: list[Cue]) -> str:
    blocks = [f"{i}\n{_srt_time(c.start_s, ',')} --> {_srt_time(c.end_s, ',')}\n{c.text}\n" for i, c in enumerate(cues, 1)]
    return "\n".join(blocks)


def to_vtt(cues: list[Cue]) -> str:
    blocks = [f"{_srt_time(c.start_s, '.')} --> {_srt_time(c.end_s, '.')}\n{c.text}\n" for c in cues]
    return "WEBVTT\n\n" + "\n".join(blocks)


def timecode(sec: float, fps: int) -> str:
    """ノンドロップのタイムコード hh:mm:ss:ff(fps は整数)。"""
    frames = round(max(0.0, sec) * fps)
    h, rem = divmod(frames, 3600 * fps)
    m, rem = divmod(rem, 60 * fps)
    s, f = divmod(rem, fps)
    return f"{h:02d}:{m:02d}:{s:02d}:{f:02d}"


def _check_fps(fps: int) -> None:
    if not isinstance(fps, int) or not (1 <= fps <= 120):
        raise ExportError("fps は 1〜120 の整数です(29.97 などのドロップフレームには対応しません)")


def spans_to_edl(spans: list[dict], *, fps: int = 30, title: str = "ChapterLens digest", clip_name: str = "") -> str:
    """CMX3600 の EDL。区間を順につないだタイムライン(原本の時刻は、動画ファイルの時刻のまま)。"""
    _check_fps(fps)
    lines = [f"TITLE: {_one_line(title)}", "FCM: NON-DROP FRAME", ""]
    rec = 0.0
    for i, s in enumerate(spans, 1):
        length = s["end_s"] - s["start_s"]
        lines.append(
            f"{i:03d}  AX       AA/V  C        {timecode(s['start_s'], fps)} {timecode(s['end_s'], fps)} "
            f"{timecode(rec, fps)} {timecode(rec + length, fps)}"
        )
        if clip_name:
            lines.append(f"* FROM CLIP NAME: {_one_line(clip_name)}")
        rec += length
    return "\n".join(lines) + "\n"


def chapters_to_marker_edl(boundaries: list[float], titles: list[str] | None = None, *, fps: int = 30,
                           title: str = "ChapterLens chapters", start_tc_s: float = 3600.0) -> str:
    """章の境界を、編集ソフト(DaVinci Resolve など)が読めるマーカーつき EDL にする。先頭の 0 秒の章も含める。"""
    _check_fps(fps)
    starts = [0.0, *sorted(b for b in boundaries if b > 0)]
    titles = titles or []
    lines = [f"TITLE: {_one_line(title)}", "FCM: NON-DROP FRAME", ""]
    for i, t in enumerate(starts, 1):
        a, b = timecode(start_tc_s + t, fps), timecode(start_tc_s + t + 1.0 / fps, fps)
        name = _one_line(titles[i - 1]) if i - 1 < len(titles) and titles[i - 1] else f"Chapter {i}"
        lines.append(f"{i:03d}  001      V     C        {a} {b} {a} {b}")
        lines.append(f" |C:ResolveColorBlue |M:{name} |D:1")
    return "\n".join(lines) + "\n"


def _one_line(text: str) -> str:
    return re.sub(r"[\r\n|]+", " ", text).strip()


# ---------- ffmpeg ----------
def build_filter(spans: list[dict], *, has_audio: bool, vertical: bool = False, subtitles: str | None = None,
                 size: tuple[int, int] = SHORT_SIZE, font: str | None = None, font_size: int = 14) -> tuple[str, list[str]]:
    """filter_complex の文字列と、出力に使うラベル([vout] / [aout])を返す。

    各区間を trim して、concat でつなぐ。vertical なら、中央を 9:16 に切り抜いて size に拡縮。subtitles は、ffmpeg を実行する
    フォルダにあるファイル名(パスの区切りやコロンのエスケープを避けるため)。"""
    if not spans:
        raise ExportError("区間がありません")
    parts = []
    for i, s in enumerate(spans):
        a, b = f"{s['start_s']:.3f}", f"{s['end_s']:.3f}"
        parts.append(f"[0:v]trim=start={a}:end={b},setpts=PTS-STARTPTS[v{i}]")
        if has_audio:
            parts.append(f"[0:a]atrim=start={a}:end={b},asetpts=PTS-STARTPTS[a{i}]")
    n = len(spans)
    joined = "".join(f"[v{i}]" + (f"[a{i}]" if has_audio else "") for i in range(n))
    parts.append(f"{joined}concat=n={n}:v=1:a={1 if has_audio else 0}[vcat]" + ("[aout]" if has_audio else ""))
    chain = []
    if vertical:
        w, h = size
        chain.append("crop='min(iw,ih*9/16)':'min(ih,iw*16/9)'")
        chain.append(f"scale={w}:{h}:flags=lanczos,setsar=1")
    if subtitles:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", subtitles):
            raise ExportError("字幕のファイル名に使えない文字があります")
        style = f"Fontsize={font_size},Outline=2,Shadow=0,MarginV=72,Alignment=2"
        if font:
            style = f"FontName={font}," + style
        chain.append(f"subtitles={subtitles}:force_style='{_escape_style(style)}'")
    parts.append(f"[vcat]{','.join(chain) if chain else 'null'}[vout]")
    return ";".join(parts), (["[vout]", "[aout]"] if has_audio else ["[vout]"])


def _escape_style(style: str) -> str:
    return style.replace("\\", "\\\\").replace("'", "")


def ffmpeg_args(input_path: str, output_path: str, filter_complex: str, labels: list[str]) -> list[str]:
    args = ["ffmpeg", "-hide_banner", "-y", "-i", input_path, "-filter_complex", filter_complex, "-map", labels[0]]
    if len(labels) > 1:
        args += ["-map", labels[1], "-c:a", "aac", "-b:a", "160k"]
    args += ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output_path]
    return args


def check_input(path: str, own: bool) -> Path:
    """動画ファイルを検査する。--own が無い・URL・無い・動画でない、は ExportError。"""
    if not own:
        raise ExportError(OWN_NOTICE)
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", path) or "youtube.com" in path.lower() or "youtu.be" in path.lower():
        raise ExportError("動画の URL は受け付けません(この PC にある、自分の動画ファイルだけ)")
    p = Path(path)
    if not p.is_file():
        raise ExportError(f"動画ファイルがありません: {path}")
    if p.suffix.lower() not in VIDEO_SUFFIXES:
        raise ExportError(f"動画の拡張子ではありません: {p.suffix}")
    return p


def _tool(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise ExportError(f"{name} が見つかりません。ffmpeg をインストールして、PATH に通してください")
    return found


def probe(path: Path) -> dict:
    """ffprobe で、長さ・映像と音声の有無・大きさを読む。"""
    res = subprocess.run(
        [_tool("ffprobe"), "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        capture_output=True, text=True, timeout=60,
    )
    if res.returncode != 0:
        raise ExportError("動画を読めません: " + res.stderr.strip()[-300:])
    info = json.loads(res.stdout)
    streams = info.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise ExportError("映像がありません")
    return {
        "duration_s": float(info.get("format", {}).get("duration") or video.get("duration") or 0),
        "has_audio": any(s.get("codec_type") == "audio" for s in streams),
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
    }


def render(input_path: Path, output_path: Path, spans: list[dict], cues: list[Cue], *, vertical: bool = False,
           burn_subtitles: bool = True, font: str | None = None, overwrite: bool = False, timeout_s: int = 3600) -> dict:
    """区間をつないだ動画を書き出す。vertical なら 1080×1920 の縦動画(字幕を焼き込む)。結果の概要を返す。"""
    info = probe(input_path)
    duration = info["duration_s"]
    spans = [{**s, "end_s": min(s["end_s"], duration)} for s in spans if s["start_s"] < duration]
    spans = [s for s in spans if s["end_s"] - s["start_s"] > 0.1]
    if not spans:
        raise ExportError("動画の長さの中に、区間がありません(字幕と動画が別のものではありませんか)")
    out = Path(output_path)
    if out.resolve() == Path(input_path).resolve():
        raise ExportError("書き出し先が、元の動画と同じです")
    if out.exists() and not overwrite:
        raise ExportError(f"書き出し先に同じ名前のファイルがあります: {out}(別の名前にするか、--overwrite を付けてください)")
    out.parent.mkdir(parents=True, exist_ok=True)
    retimed = retime_cues(cues, spans)
    with tempfile.TemporaryDirectory() as tmp:
        sub_name = None
        if burn_subtitles and retimed:
            sub_name = "subs.srt"
            (Path(tmp) / sub_name).write_text(to_srt(retimed), encoding="utf-8")
        flt, labels = build_filter(spans, has_audio=info["has_audio"], vertical=vertical, subtitles=sub_name, font=font)
        args = ffmpeg_args(str(Path(input_path).resolve()), str(out.resolve()), flt, labels)
        args[0] = _tool("ffmpeg")
        res = subprocess.run(args, cwd=tmp, capture_output=True, text=True, timeout=timeout_s)
    if res.returncode != 0:
        raise ExportError("ffmpeg が失敗しました: " + res.stderr.strip()[-600:])
    return {"output": str(out), "spans": len(spans), "seconds": round(sum(s["end_s"] - s["start_s"] for s in spans), 2),
            "vertical": vertical, "subtitles": bool(sub_name)}
