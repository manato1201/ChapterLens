"""話題の切り替えの検出(字幕だけ。TextTiling 系)。

字幕を一定の幅(step_s 秒)の「ビン」に分け、各境界の前後の窓(window_bins 個ずつ)の語の分布の
類似度(TF-IDF のコサイン)を測る。類似度が谷になる所が話題の切り替えの候補。
谷の深さ(depth score)の大きい順に、間隔(min_gap_s)を空けて選ぶ。

- target_count を渡すと、深い順にその数だけ選ぶ(「正解の区間数に合わせたモード」。設計書 §7)
- 渡さないと、深さが「平均 + alpha × 標準偏差」と「絶対の下限 min_depth」の両方を超えるものを選ぶ
"""

from __future__ import annotations

import bisect
import math
from collections import Counter
from dataclasses import asdict, dataclass

from ..captions import Cue
from ..text import term_counts
from .base import Detection, register


@dataclass
class TopicShiftParams:
    step_s: float = 10.0  # ビンの幅(秒)
    window_bins: int = 6  # 境界の前後の窓の大きさ(ビンの数)
    smooth_bins: int = 3  # 類似度の移動平均の幅(奇数)
    min_gap_s: float = 30.0  # 境界どうしの最小の間隔(秒)
    alpha: float = 0.5  # 自動のしきい値 = depth の平均 + alpha × 標準偏差
    # 自動のときの絶対の下限。相対のしきい値だけだと、話題が 1 つの動画でも「上位 30%」が境界になってしまう。
    # **仮の値**: 合成データではノイズが 0.4 以下・本物が 1.15 以上。実データの評価(CH0)で決め直す
    min_depth: float = 0.4


def _cosine(a: dict[str, float], b: dict[str, float]) -> float:
    if not a or not b:
        return 1.0  # 片側が空なら、切り替えの根拠が無い
    if len(a) > len(b):
        a, b = b, a
    dot = sum(v * b.get(t, 0.0) for t, v in a.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 1.0


def _smooth(values: list[float], width: int) -> list[float]:
    if width <= 1:
        return list(values)
    half = width // 2
    out = []
    for i in range(len(values)):
        lo, hi = max(0, i - half), min(len(values), i + half + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out


def _depth_scores(sims: list[float]) -> list[float]:
    depths = []
    for i, s in enumerate(sims):
        left = i
        while left > 0 and sims[left - 1] >= sims[left]:
            left -= 1
        right = i
        while right < len(sims) - 1 and sims[right + 1] >= sims[right]:
            right += 1
        depths.append((sims[left] - s) + (sims[right] - s))
    return depths


class TopicShiftDetector:
    name = "topic-shift@1"

    def __init__(self, params: TopicShiftParams | None = None) -> None:
        self.params = params or TopicShiftParams()

    def detect(
        self,
        cues: list[Cue],
        duration_s: float,
        *,
        target_count: int | None = None,
    ) -> Detection:
        p = self.params
        meta = {"params": asdict(p), "target_count": target_count}
        nbins = int(math.ceil(duration_s / p.step_s)) if duration_s > 0 else 0
        if nbins < 3 or not cues:
            return Detection([], [], self.name, meta)

        bins: list[Counter] = [Counter() for _ in range(nbins)]
        for cue in cues:
            idx = min(nbins - 1, max(0, int(cue.start_s // p.step_s)))
            bins[idx].update(term_counts(cue.text))

        df: Counter = Counter()
        for b in bins:
            df.update(b.keys())
        idf = {t: math.log((nbins + 1) / (n + 1)) + 1.0 for t, n in df.items()}

        def vector(window: list[Counter]) -> dict[str, float]:
            total: Counter = Counter()
            for b in window:
                total.update(b)
            return {t: (1.0 + math.log(c)) * idf[t] for t, c in total.items()}

        w = p.window_bins
        sims = [
            _cosine(vector(bins[max(0, g - w) : g]), vector(bins[g : g + w]))
            for g in range(1, nbins)
        ]  # sims[g - 1] = 境界 g(= g × step_s 秒)の前後の類似度
        depths = _depth_scores(_smooth(sims, p.smooth_bins))
        max_depth = max(depths) if depths else 0.0
        if max_depth <= 0:
            return Detection([], [], self.name, meta)

        cut_time = lambda g: g * p.step_s  # noqa: E731
        candidates = [
            (depths[g - 1], g)
            for g in range(1, nbins)
            if p.min_gap_s <= cut_time(g) <= duration_s - p.min_gap_s and depths[g - 1] > 0
        ]
        candidates.sort(reverse=True)

        if target_count is None:
            mean = sum(depths) / len(depths)
            std = math.sqrt(sum((d - mean) ** 2 for d in depths) / len(depths))
            threshold = max(mean + p.alpha * std, p.min_depth)
            candidates = [c for c in candidates if c[0] > threshold]
            limit = None
        else:
            limit = max(0, target_count)

        chosen: list[tuple[float, float]] = []  # (時刻, depth)
        starts = [c.start_s for c in cues]
        for depth, g in candidates:
            if limit is not None and len(chosen) >= limit:
                break
            t = self._snap(cut_time(g), starts, p.step_s)
            if all(abs(t - other) >= p.min_gap_s for other, _ in chosen):
                chosen.append((t, depth))

        chosen.sort()
        return Detection(
            [round(t, 3) for t, _ in chosen],
            [round(min(1.0, d / max_depth), 3) for _, d in chosen],
            self.name,
            meta,
        )

    @staticmethod
    def _snap(t: float, starts: list[float], step_s: float) -> float:
        """境界を、近くの字幕の開始時刻に寄せる(話題の変わり目は、たいてい発話の頭)。"""
        i = bisect.bisect_left(starts, t)
        best = None
        for j in (i - 1, i):
            if 0 <= j < len(starts) and abs(starts[j] - t) <= step_s / 2:
                if best is None or abs(starts[j] - t) < abs(best - t):
                    best = starts[j]
        return best if best is not None else t


register(TopicShiftDetector.name, TopicShiftDetector)
