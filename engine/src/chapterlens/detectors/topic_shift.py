"""話題の切り替えの検出(字幕だけ。TextTiling 系)。

字幕を一定の幅(step_s 秒)の「ビン」に分け、各境界の前後の窓(window_bins 個ずつ)の語の分布の
類似度(TF-IDF のコサイン)を測る。類似度が谷になる所が話題の切り替えの候補。
谷の深さ(depth score)の大きい順に、間隔(min_gap_s)を空けて選ぶ。

- 「類似度の曲線」(similarity_curve)と「境界の選択」(select_boundaries)に分けてある。
  埋め込み版の検出器(embed_shift.py)や、調整(tools/tune.py)が、曲線だけ差し替えて選択を共有する
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
    # 置き直し(refine): 粗い窓で選んだ境界の近く(±radius)で、字幕 1 つ単位の細かい前後比較で位置を決め直す。0 = しない
    refine_radius_s: float = 0.0
    refine_window_s: float = 45.0  # 置き直しのときの、前後の窓の長さ(秒)


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


class PreparedCues:
    """字幕 1 つ単位の語の数え上げと IDF(置き直しで使う)。動画ごとに 1 度作って使い回せる。"""

    def __init__(self, cues: list[Cue]) -> None:
        self.starts = [c.start_s for c in cues]
        self.counts = [term_counts(c.text) for c in cues]
        df: Counter = Counter()
        for c in self.counts:
            df.update(c.keys())
        n = max(1, len(cues))
        self.idf = {t: math.log((n + 1) / (k + 1)) + 1.0 for t, k in df.items()}

    def vector(self, lo: int, hi: int) -> dict[str, float]:
        total: Counter = Counter()
        for i in range(lo, hi):
            total.update(self.counts[i])
        return {t: (1.0 + math.log(c)) * self.idf[t] for t, c in total.items()}


def refine_boundaries(
    boundaries: list[float], prepared: PreparedCues, radius_s: float, window_s: float, min_gap_s: float
) -> list[float]:
    """各境界を、近く(±radius_s)の字幕の開始時刻のうち、前後(window_s)の語の類似度が最も低い所へ動かす。"""
    starts = prepared.starts
    out: list[float] = []
    for b in boundaries:
        lo_i = bisect.bisect_left(starts, b - radius_s)
        hi_i = bisect.bisect_right(starts, b + radius_s)
        best_t, best_sim = b, None
        for i in range(lo_i, hi_i):
            t = starts[i]
            left = prepared.vector(bisect.bisect_left(starts, t - window_s), i)
            right = prepared.vector(i, bisect.bisect_left(starts, t + window_s))
            if not left or not right:
                continue
            sim = _cosine(left, right)
            # 同点なら、元の位置に近いほう
            if best_sim is None or sim < best_sim - 1e-9 or (abs(sim - best_sim) <= 1e-9 and abs(t - b) < abs(best_t - b)):
                best_t, best_sim = t, sim
        out.append(best_t)
    out.sort()
    kept: list[float] = []
    for t in out:
        if not kept or t - kept[-1] >= min_gap_s:
            kept.append(t)
    return kept


def num_bins(duration_s: float, step_s: float) -> int:
    return int(math.ceil(duration_s / step_s)) if duration_s > 0 else 0


def bin_index(start_s: float, step_s: float, nbins: int) -> int:
    return min(nbins - 1, max(0, int(start_s // step_s)))


def similarity_curve(cues: list[Cue], duration_s: float, step_s: float, window_bins: int) -> list[float]:
    """語彙(TF-IDF)の類似度の曲線。curve[g - 1] = 境界 g(= g × step_s 秒)の前後の類似度。

    ビンが 3 未満・字幕が無いときは空のリスト。
    """
    nbins = num_bins(duration_s, step_s)
    if nbins < 3 or not cues:
        return []
    bins: list[Counter] = [Counter() for _ in range(nbins)]
    for cue in cues:
        bins[bin_index(cue.start_s, step_s, nbins)].update(term_counts(cue.text))

    df: Counter = Counter()
    for b in bins:
        df.update(b.keys())
    idf = {t: math.log((nbins + 1) / (n + 1)) + 1.0 for t, n in df.items()}

    def vector(window: list[Counter]) -> dict[str, float]:
        total: Counter = Counter()
        for b in window:
            total.update(b)
        return {t: (1.0 + math.log(c)) * idf[t] for t, c in total.items()}

    w = window_bins
    return [_cosine(vector(bins[max(0, g - w) : g]), vector(bins[g : g + w])) for g in range(1, nbins)]


def select_boundaries(
    sims: list[float],
    cues: list[Cue],
    duration_s: float,
    p: TopicShiftParams,
    *,
    target_count: int | None,
    name: str,
    prepared: PreparedCues | None = None,
) -> Detection:
    """類似度の曲線から、境界を選ぶ(谷の深さ → しきい値 or 個数 → 最小間隔 → 置き直し)。"""
    meta = {"params": asdict(p), "target_count": target_count}
    if not sims:
        return Detection([], [], name, meta)
    nbins = len(sims) + 1
    depths = _depth_scores(_smooth(sims, p.smooth_bins))
    max_depth = max(depths) if depths else 0.0
    if max_depth <= 0:
        return Detection([], [], name, meta)

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
        t = snap(cut_time(g), starts, p.step_s)
        if all(abs(t - other) >= p.min_gap_s for other, _ in chosen):
            chosen.append((t, depth))

    chosen.sort()
    times = [t for t, _ in chosen]
    scores = [round(min(1.0, d / max_depth), 3) for _, d in chosen]
    if p.refine_radius_s > 0 and times:
        moved = refine_boundaries(times, prepared or PreparedCues(cues), p.refine_radius_s, p.refine_window_s, p.min_gap_s)
        if len(moved) == len(times):
            times = moved
        else:  # 最小間隔で落ちたものがある: 信頼度は先頭から揃える(順序は保たれる)
            times, scores = moved, scores[: len(moved)]
    return Detection([round(t, 3) for t in times], scores, name, meta)


def snap(t: float, starts: list[float], step_s: float) -> float:
    """境界を、近くの字幕の開始時刻に寄せる(話題の変わり目は、たいてい発話の頭)。"""
    i = bisect.bisect_left(starts, t)
    best = None
    for j in (i - 1, i):
        if 0 <= j < len(starts) and abs(starts[j] - t) <= step_s / 2:
            if best is None or abs(starts[j] - t) < abs(best - t):
                best = starts[j]
    return best if best is not None else t


# v1: 合成データで決めた最初の既定(比較のために残す)
V1_PARAMS = TopicShiftParams()
# v2: 実データ 20 本のうち調整用 10 本で選んだ既定(2026-11-12。確認用 10 本で効果を見た。tools/tune.py・tune_refine.py)。
# 置き直しは、調整用の上位が radius 10〜20s・窓 45s に集まっていた(4 つの設定すべて)ので、その中心を採った
V2_PARAMS = TopicShiftParams(
    step_s=10.0, window_bins=8, smooth_bins=3, min_gap_s=60.0, alpha=0.0, min_depth=0.1,
    refine_radius_s=10.0, refine_window_s=45.0,
)


class TopicShiftDetector:
    def __init__(self, params: TopicShiftParams | None = None, name: str = "topic-shift@1") -> None:
        self.params = params or V1_PARAMS
        self.name = name

    def detect(
        self,
        cues: list[Cue],
        duration_s: float,
        *,
        target_count: int | None = None,
    ) -> Detection:
        p = self.params
        sims = similarity_curve(cues, duration_s, p.step_s, p.window_bins)
        return select_boundaries(sims, cues, duration_s, p, target_count=target_count, name=self.name)


register("topic-shift@1", lambda: TopicShiftDetector(V1_PARAMS, "topic-shift@1"))
register("topic-shift@2", lambda: TopicShiftDetector(V2_PARAMS, "topic-shift@2"))
