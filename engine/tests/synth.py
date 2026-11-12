"""テスト用の合成データ: 話題ごとに語彙が違う字幕を作る(実データではない)。

話題の長さをばらつかせて、「等間隔に区切る基準」では当たらないようにする。
"""

from __future__ import annotations

import random

from chapterlens.captions import Cue

FILLER_EN = ["really", "thing", "maybe", "today", "actually", "little"]
FILLER_JA = ["ここ", "それ", "たとえば", "ちなみに", "まず", "では"]


def _vocab_en(topic: int, n: int = 40) -> list[str]:
    return [f"topic{topic}word{i}x" for i in range(n)]


def _vocab_ja(topic: int, n: int = 40) -> list[str]:
    base = 0x4E00 + topic * 60
    chars = [chr(base + i) for i in range(30)]
    rng = random.Random(topic)
    return ["".join(rng.choice(chars) for _ in range(rng.choice((2, 3)))) for _ in range(n)]


def make_video(
    lengths_s: list[int],
    lang: str = "en",
    seed: int = 0,
    cue_s: int = 4,
) -> tuple[list[Cue], list[float], float]:
    """(字幕, 正解の境界, 長さ)を返す。"""
    rng = random.Random(seed)
    cues: list[Cue] = []
    boundaries: list[float] = []
    t = 0
    for topic, length in enumerate(lengths_s):
        if topic > 0:
            boundaries.append(float(t))
        vocab = _vocab_en(topic + seed * 7) if lang == "en" else _vocab_ja(topic + seed * 7)
        filler = FILLER_EN if lang == "en" else FILLER_JA
        end = t + length
        while t < end:
            words = [rng.choice(vocab) for _ in range(5)] + [rng.choice(filler) for _ in range(2)]
            rng.shuffle(words)
            text = " ".join(words) if lang == "en" else "の".join(words) + "です"
            cues.append(Cue(float(t), float(t + cue_s), text))
            t += cue_s
    return cues, boundaries, float(t)
