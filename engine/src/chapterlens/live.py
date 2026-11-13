"""ライブ・ストリーム用の逐次検出(CH5。設計書 §8)。字幕(音声の認識結果)が届くたびに、暫定の印 → 確定を出す。

バッチの検出器(topic-shift@2)は、境界の後ろに 80 秒の文脈を使う。ライブでは、そこまで待てない。だから 2 段で扱う:
  1. 暫定(tentative): 境界の候補の後ろに tentative_s 秒ぶんの字幕が溜まった時点で、前の 60 秒とどれだけ違うかを測る。
     十分に違えば、すぐ印を打つ(間違いうる)。一度に出す暫定は 1 つだけ。
  2. 確定(committed): 後ろに commit_s 秒ぶん溜まったら、候補の前後 ±refine_s 秒で、位置を「変化の始まり」へ置き直す。
     後ろ commit_s 秒の話も前と違えば確定。違わなければ取り下げる(一時的な脱線だった)。**時刻は変化の始まりに戻して付ける**
     (確定が遅れても、打刻は遅れない)。
類似度は、バッチと同じ TF-IDF のコサイン(字幕 1 つを 1 文書として数える)。

数値(窓の長さ・しきい値)は**仮**で、評価データの再生(evaluate_replay)と合成データで測って決めた(README の「CH5」)。
"""

from __future__ import annotations

import bisect
import math
from collections import Counter
from dataclasses import asdict, dataclass

from .captions import Cue
from .text import term_counts


@dataclass
class LiveParams:
    pre_s: float = 60.0  # 境界の前の窓
    tentative_s: float = 8.0  # 暫定の判定に要る、境界の後ろの長さ(字幕が届く遅れで、実際の遅れは中央値 10 秒前後)
    commit_s: float = 24.0  # 確定に要る、境界の後ろの長さ(30 秒でも F1 は同じ。24 秒で、確定までの遅れの中央値が 27 秒)
    refine_s: float = 10.0  # 確定のとき、位置を置き直す範囲
    min_gap_s: float = 90.0  # 境界どうしの最小の間隔(60 秒だと、区間数が正解の 2 倍を超える)
    tentative_sim: float = 0.10  # これ以下なら、暫定の印を打つ
    commit_sim: float = 0.16  # 確定の判定(後ろ commit_s 秒との類似度がこれ以下)
    min_tokens: int = 6  # 窓の中の語がこれより少ないと判定しない(無音・相づちだけの区間)
    horizon_s: float = 180.0  # 暫定を探す範囲(いまから、これより前は見ない)
    dismiss_radius_s: float = 15.0  # 取り下げた付近は、もう印を打たない
    max_cues: int = 20000
    max_density: int = 40  # 前後 10 秒(計 20 秒)に入れる字幕の数の上限。実際の発話は多くても 10 個ほど。計算量の暴走を防ぐ


STEP_S = 30.0  # push が長い時間ぶんを一度に受けたとき、これだけずつ時刻を進めて判定する


class _C:
    """字幕 1 つぶん。本文は持たず、語の数え上げだけを残す(本文をメモリに置いておく理由がない)。"""

    __slots__ = ("start", "end", "counts")

    def __init__(self, cue: Cue) -> None:
        self.start, self.end = cue.start_s, cue.end_s
        self.counts = term_counts(cue.text)


def _cosine(a: dict[str, float], b: dict[str, float]) -> float:
    if not a or not b:
        return 1.0  # 片側が空なら、切り替えの根拠が無い
    if len(a) > len(b):
        a, b = b, a
    dot = sum(v * b.get(t, 0.0) for t, v in a.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 1.0


class LiveDetector:
    """字幕を足していくと、markers() が「確定した境界」と「暫定の境界(最大 1 つ)」を返す。"""

    def __init__(self, params: LiveParams | None = None) -> None:
        self.p = params or LiveParams()
        self._cues: list[_C] = []
        self._starts: list[float] = []
        self._df: Counter = Counter()
        self.now_s = 0.0
        self.committed: list[dict] = []  # {t, score, tentative_at, committed_at, tentative_t}
        self.pending: dict | None = None  # {t, score, tentative_at}
        self.dismissed: list[float] = []  # 取り下げた位置(探す範囲より古いものは捨てる)
        self.n_dismissed = 0  # 取り下げた総数(評価・表示用)
        self.dropped = 0  # 上限で捨てた字幕の数

    # ---- 入力 ----
    def push(self, cues: list[Cue], now_s: float | None = None) -> None:
        target = self.now_s
        for cue in cues:
            if len(self._cues) >= self.p.max_cues:
                self.dropped += 1
                continue
            c = _C(cue)
            near = bisect.bisect_left(self._starts, c.start + 10.0) - bisect.bisect_left(self._starts, c.start - 10.0)
            if near >= self.p.max_density:
                self.dropped += 1
                continue
            i = bisect.bisect_right(self._starts, c.start)
            self._cues.insert(i, c)
            self._starts.insert(i, c.start)
            self._df.update(c.counts.keys())
            target = max(target, c.end)
        if now_s is not None:
            target = max(target, float(now_s))
        # 一度に長い時間ぶんが届いても(再接続・まとめて送信)、探す範囲(horizon)から漏れないよう、時刻を段階的に進める
        t = self.now_s
        while t < target - 1e-9:
            t = min(target, t + STEP_S)
            self.now_s = t
            self._advance()
        self._advance()

    def markers(self) -> list[dict]:
        out = [{"t": m["t"], "status": "committed", "score": m["score"]} for m in self.committed]
        if self.pending:
            out.append({"t": self.pending["t"], "status": "tentative", "score": self.pending["score"]})
        return out

    # ---- 類似度 ----
    def _vector(self, lo: float, hi: float) -> dict[str, float]:
        i, j = bisect.bisect_left(self._starts, lo), bisect.bisect_left(self._starts, hi)
        total: Counter = Counter()
        for c in self._cues[i:j]:
            total.update(c.counts)
        n = len(self._cues)
        return {t: (1.0 + math.log(k)) * (math.log((n + 1) / (self._df[t] + 1)) + 1.0) for t, k in total.items()}

    def _ntokens(self, lo: float, hi: float) -> int:
        i, j = bisect.bisect_left(self._starts, lo), bisect.bisect_left(self._starts, hi)
        return sum(sum(c.counts.values()) for c in self._cues[i:j])

    def _sim(self, t: float, post_s: float, floor_t: float) -> float | None:
        """t の前(floor_t 以降の pre_s 秒)と、t の後ろ post_s 秒の類似度。語が少なすぎれば None。"""
        lo = max(t - self.p.pre_s, floor_t)
        if self._ntokens(t, t + post_s) < self.p.min_tokens or self._ntokens(lo, t) < self.p.min_tokens * 2:
            return None
        return _cosine(self._vector(lo, t), self._vector(t, t + post_s))

    # ---- 進める ----
    def _floor(self) -> float:
        return self.committed[-1]["t"] if self.committed else 0.0

    def _advance(self) -> None:
        cutoff = self.now_s - self.p.horizon_s - self.p.dismiss_radius_s  # これより古い位置は、もう探さないので覚えておく必要がない
        if self.dismissed and self.dismissed[0] < cutoff:
            self.dismissed = [d for d in self.dismissed if d >= cutoff]
        for _ in range(8):
            if self.pending is not None:
                if self.now_s - self.pending["t"] < self.p.commit_s:
                    return
                self._resolve_pending()
            else:
                if not self._find_tentative():
                    return

    def _find_tentative(self) -> bool:
        p = self.p
        floor = self._floor()
        lo = max(floor + (p.min_gap_s if self.committed else 0.0), self.now_s - p.horizon_s)
        hi = self.now_s - p.tentative_s
        best: tuple[float, float] | None = None  # (類似度, 時刻)
        i = bisect.bisect_left(self._starts, lo)
        for c in self._cues[i:]:
            if c.start > hi:
                break
            if any(abs(c.start - d) <= p.dismiss_radius_s for d in self.dismissed):
                continue
            s = self._sim(c.start, p.tentative_s, floor)
            if s is not None and s <= p.tentative_sim and (best is None or s < best[0] - 1e-12):
                best = (s, c.start)
        if best is None:
            return False
        self.pending = {"t": best[1], "score": round(min(1.0, 1.0 - best[0]), 3), "tentative_at": self.now_s}
        return True

    def _resolve_pending(self) -> None:
        p = self.p
        pend = self.pending
        assert pend is not None
        floor = self._floor()
        lo_t = max(pend["t"] - p.refine_s, floor + (p.min_gap_s if self.committed else 0.0))
        hi_t = min(pend["t"] + p.refine_s, self.now_s - p.commit_s)
        best: tuple[float, float, float] | None = None  # (類似度, 元の位置との距離, 時刻)
        i = bisect.bisect_left(self._starts, lo_t)
        for c in self._cues[i:]:
            if c.start > hi_t:
                break
            s = self._sim(c.start, p.commit_s, floor)
            if s is None:
                continue
            key = (s, abs(c.start - pend["t"]), c.start)
            if best is None or (key[0] < best[0] - 1e-9) or (abs(key[0] - best[0]) <= 1e-9 and key[1] < best[1]):
                best = key
        self.pending = None
        if best is None or best[0] > p.commit_sim:
            self.dismissed.append(pend["t"])  # 脱線だった。この付近は、もう印を打たない
            self.n_dismissed += 1
            return
        self.committed.append({
            "t": round(best[2], 3), "score": round(min(1.0, 1.0 - best[0]), 3),
            "tentative_t": pend["t"], "tentative_at": pend["tentative_at"], "committed_at": self.now_s,
        })

    def params(self) -> dict:
        return asdict(self.p)


# ---- 評価: 字幕を時間順に流し込んで、遅れとずれを測る ----
def replay(cues: list[Cue], params: LiveParams | None = None) -> LiveDetector:
    """字幕を、終わりの時刻の順に 1 つずつ届けた場合の結果(本番の「届いたら処理する」と同じ順序)。"""
    det = LiveDetector(params)
    for cue in sorted(cues, key=lambda c: (c.end_s, c.start_s)):
        det.push([cue], now_s=cue.end_s)
    return det
