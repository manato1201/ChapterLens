"""精度の指標(設計書 §7): 境界の F1(許容つき)・打刻のずれ・区間数の比。

境界 = 区間の切れ目の時刻(先頭の 0 秒は含めない)。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

DEFAULT_TOLERANCES = (3.0, 10.0)


def match_boundaries(pred: list[float], ref: list[float], tol: float) -> list[tuple[float, float]]:
    """予測と正解を 1 対 1 で対応づける。

    両方を昇順に並べ、許容 tol 以内の組を先頭から取る(直線上の点の対応づけでは、
    この貪欲法が対応数の最大を与える)。
    """
    p = sorted(pred)
    r = sorted(ref)
    i = j = 0
    pairs: list[tuple[float, float]] = []
    while i < len(p) and j < len(r):
        d = p[i] - r[j]
        if abs(d) <= tol + 1e-9:
            pairs.append((p[i], r[j]))
            i += 1
            j += 1
        elif d < 0:
            i += 1
        else:
            j += 1
    return pairs


def percentile(values: list[float], q: float) -> float | None:
    """線形補間のパーセンタイル(q は 0〜100)。空なら None。"""
    if not values:
        return None
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    pos = (len(s) - 1) * q / 100.0
    lo = math.floor(pos)
    hi = math.ceil(pos)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


@dataclass
class BoundaryScore:
    tolerance_s: float
    n_pred: int
    n_ref: int
    tp: int
    precision: float
    recall: float
    f1: float
    errors_s: list[float] = field(default_factory=list)  # 対応づいた組の (予測 - 正解)。符号つき


def score_boundaries(pred: list[float], ref: list[float], tol: float) -> BoundaryScore:
    pairs = match_boundaries(pred, ref, tol)
    tp = len(pairs)
    if not pred and not ref:
        precision = recall = f1 = 1.0  # どちらも「境界なし」で一致
    else:
        precision = tp / len(pred) if pred else 0.0
        recall = tp / len(ref) if ref else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall > 0 else 0.0
    return BoundaryScore(
        tolerance_s=tol,
        n_pred=len(pred),
        n_ref=len(ref),
        tp=tp,
        precision=precision,
        recall=recall,
        f1=f1,
        errors_s=[p - r for p, r in pairs],
    )


def offset_stats(errors_s: list[float]) -> dict:
    """打刻のずれ。abs_median / abs_p90 は絶対値、bias は符号つきの中央値(+ なら遅れ)。"""
    if not errors_s:
        return {"n": 0, "abs_median": None, "abs_p90": None, "bias": None}
    abs_e = [abs(e) for e in errors_s]
    return {
        "n": len(errors_s),
        "abs_median": percentile(abs_e, 50),
        "abs_p90": percentile(abs_e, 90),
        "bias": percentile(errors_s, 50),
    }


def count_ratio(pred: list[float], ref: list[float]) -> float | None:
    """区間数の比(予測 / 正解)。正解の境界が 0 なら None。"""
    if not ref:
        return None
    return len(pred) / len(ref)


def aggregate(scores: list[BoundaryScore]) -> dict:
    """複数の動画をまとめる。macro = 動画ごとの F1 の平均 / micro = 全境界を 1 つにして計算。"""
    if not scores:
        return {"videos": 0}
    tp = sum(s.tp for s in scores)
    n_pred = sum(s.n_pred for s in scores)
    n_ref = sum(s.n_ref for s in scores)
    precision = tp / n_pred if n_pred else 0.0
    recall = tp / n_ref if n_ref else 0.0
    micro_f1 = 2 * precision * recall / (precision + recall) if precision + recall > 0 else 0.0
    errors = [e for s in scores for e in s.errors_s]
    return {
        "videos": len(scores),
        "tolerance_s": scores[0].tolerance_s,
        "macro_f1": sum(s.f1 for s in scores) / len(scores),
        "micro_precision": precision,
        "micro_recall": recall,
        "micro_f1": micro_f1,
        "offset": offset_stats(errors),
    }
