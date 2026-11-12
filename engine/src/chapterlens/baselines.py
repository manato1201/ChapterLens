"""基準(ベースライン)。検出器は、これを**確実に上回る**ことが最低線(設計書 §0 の R2 ④・§7)。

- fixed_interval: N 秒ごとに区切る(字幕も見ない)
- uniform_k:      正解と**同じ区間数**で等間隔に区切る。区間数を教えてもらっているぶん、fixed_interval より強い基準
"""

from __future__ import annotations


def fixed_interval(duration_s: float, every_s: float = 300.0) -> list[float]:
    if every_s <= 0:
        raise ValueError("every_s は正の数です")
    out: list[float] = []
    t = every_s
    # 末尾の直前(every_s の半分以内)には切れ目を置かない
    while t < duration_s - every_s / 2:
        out.append(t)
        t += every_s
    return out


def uniform_k(duration_s: float, k: int) -> list[float]:
    """k 個の境界を等間隔に置く(区間数は k + 1)。"""
    if k <= 0:
        return []
    return [duration_s * (i + 1) / (k + 1) for i in range(k)]
