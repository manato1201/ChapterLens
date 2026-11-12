"""字幕の読み込み(WebVTT・SRT・YouTube の json3)。

ソース・アダプタの一部: 「字幕をどこから取るか」はここの外に隔離し、ここは**形式の違いだけ**を吸収する(設計書 §3)。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Cue:
    start_s: float
    end_s: float
    text: str


_TIME = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?")
_TAG = re.compile(r"<[^>]*>")


def _seconds(token: str) -> float:
    m = _TIME.fullmatch(token.strip())
    if not m:
        raise ValueError(f"時刻を読めません: {token!r}")
    h, mnt, sec, frac = m.groups()
    ms = int((frac or "0").ljust(3, "0")[:3])
    return int(h or 0) * 3600 + int(mnt) * 60 + int(sec) + ms / 1000.0


def _clean(text: str) -> str:
    text = _TAG.sub("", text)
    text = text.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    return re.sub(r"[ \t　]+", " ", text).strip()


def _parse_blocks(content: str) -> list[Cue]:
    """VTT / SRT 共通: 「時刻 --> 時刻」の行の後ろが本文。"""
    cues: list[Cue] = []
    content = content.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    for block in re.split(r"\n{2,}", content):
        lines = [ln for ln in block.split("\n") if ln.strip() != ""]
        for idx, ln in enumerate(lines):
            if "-->" in ln:
                left, right = ln.split("-->", 1)
                try:
                    start = _seconds(left)
                    end = _seconds(right.strip().split()[0])
                except (ValueError, IndexError):
                    break
                cues.append(Cue(start, end, "\n".join(lines[idx + 1 :])))
                break
    return cues


def dedupe_rolling(cues: list[Cue]) -> list[Cue]:
    """YouTube の自動字幕は、前の行を次の字幕にも繰り返す(ローリング)。繰り返しを除く。"""
    out: list[Cue] = []
    prev_lines: list[str] = []
    for cue in cues:
        lines = [_clean(ln) for ln in cue.text.split("\n")]
        lines = [ln for ln in lines if ln]
        fresh = [ln for ln in lines if ln not in prev_lines]
        if lines:
            prev_lines = lines
        if fresh:
            out.append(Cue(cue.start_s, cue.end_s, " ".join(fresh)))
    return out


def parse_vtt(content: str) -> list[Cue]:
    return dedupe_rolling(_parse_blocks(content))


def parse_srt(content: str) -> list[Cue]:
    return dedupe_rolling(_parse_blocks(content))


def parse_json3(content: str) -> list[Cue]:
    data = json.loads(content)
    cues: list[Cue] = []
    for ev in data.get("events", []):
        segs = ev.get("segs")
        if not segs or "tStartMs" not in ev:
            continue
        text = _clean("".join(s.get("utf8", "") for s in segs).replace("\n", " "))
        if not text:
            continue
        start = ev["tStartMs"] / 1000.0
        end = start + ev.get("dDurationMs", 0) / 1000.0
        cues.append(Cue(start, max(end, start), text))
    return cues


def parse_captions(path: str | Path) -> list[Cue]:
    path = Path(path)
    content = path.read_text(encoding="utf-8")
    suffix = path.suffix.lower()
    if suffix == ".vtt":
        cues = parse_vtt(content)
    elif suffix == ".srt":
        cues = parse_srt(content)
    elif suffix in (".json3", ".json"):
        cues = parse_json3(content)
    else:
        raise ValueError(f"対応していない字幕の形式です: {suffix}(vtt / srt / json3)")
    cues.sort(key=lambda c: c.start_s)
    return cues
