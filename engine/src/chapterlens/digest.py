"""ダイジェスト(CH4): 「重要な区間」を選ぶ。動画は切り出さない(再生位置を飛ぶための区間リストだけを作る)。

字幕のテキストだけを見る(音量・映像は見ない)。単位は 15 秒のかたまり(unit)で、各かたまりを 3 つの手がかりで採点する。
  ・情報量  そのかたまりの語の重み(TF-IDF)の合計。固有の語が多いほど高い(相づち・つなぎ言葉は低い)
  ・代表性  同じ章の「他のかたまり」の語と、どれだけ重なるか。章の中心の話をしているほど高い
  ・導入    章の最初のかたまりには加点(章の話題を言い切ることが多い)
  score = 0.5 × 情報量(最大を 1 に) + 0.5 × 代表性 + 0.25(導入のとき)

選び方: ①各章の最高点のかたまりを 1 つずつ(章を飛ばさない)②残りを点の高い順に、予算(ratio × 動画の長さ)まで
③1 つだけ空いたすき間は埋め、連続したかたまりを 1 つの区間にまとめる。区間の始まり・終わりは、発話の頭と終わりに合わせる。

**これは仮の重み**で、「重要」の正解は人によって違う。だから利用者の調整(区間を外す・足す)との一致率(agreement)で測る(設計書 §6 CH4)。
拡張の core.js に、同じ手順の JavaScript 版がある(tools/export_golden.py の golden で一致を確かめる)。
"""

from __future__ import annotations

import bisect
import math
from collections import Counter

from .captions import Cue
from .text import term_counts

DIGEST_VERSION = "digest@1"
UNIT_S = 15.0
DEFAULT_RATIO = 0.2
W_INFO, W_CENTRAL, W_LEAD = 0.5, 0.5, 0.25
MIN_SPAN_S = 5.0
REST_EPS = 1e-12  # 引き算の丸め誤差で残った、ごく小さい値は 0 とみなす(JavaScript 版と同じ)
END_SLACK_S = 5.0  # 区間の終わりは、最後のかたまりの終わりより、これ以上は延ばさない(長い字幕で区間が膨らまないように)


def _cosine(a: dict[str, float], b: dict[str, float]) -> float:
    if not a or not b:
        return 0.0
    if len(a) > len(b):
        a, b = b, a
    dot = sum(v * b.get(t, 0.0) for t, v in a.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0


def select_digest(
    cues: list[Cue],
    boundaries: list[float],
    duration_s: float,
    *,
    ratio: float = DEFAULT_RATIO,
    unit_s: float = UNIT_S,
) -> list[dict]:
    """重要な区間 [{start_s, end_s, score, chapter}](昇順・重ならない)を返す。字幕が無い・短すぎるときは空。"""
    n = math.ceil(duration_s / unit_s) if duration_s > 0 else 0
    if n < 2 or not cues or not (0 < ratio <= 1):
        return []

    unit_cues: list[list[Cue]] = [[] for _ in range(n)]
    counts: list[Counter] = [Counter() for _ in range(n)]
    for cue in cues:
        u = min(n - 1, max(0, int(cue.start_s // unit_s)))
        unit_cues[u].append(cue)
        counts[u].update(term_counts(cue.text))

    df: Counter = Counter()
    for c in counts:
        df.update(c.keys())
    idf = {t: math.log((n + 1) / (k + 1)) + 1.0 for t, k in df.items()}
    vectors = [{t: (1.0 + math.log(c)) * idf[t] for t, c in unit.items()} for unit in counts]

    info = []
    for v in vectors:
        s = 0.0
        for x in v.values():
            s += x
        info.append(s)
    top = max(info)
    if not top > 0:
        return []

    cuts = sorted(b for b in boundaries if 0 < b < duration_s)
    chapter = [bisect.bisect_right(cuts, (i + 0.5) * unit_s) for i in range(n)]  # 中間点で、どの章に入るか
    members: dict[int, list[int]] = {}
    for i, ch in enumerate(chapter):
        members.setdefault(ch, []).append(i)

    score = [0.0] * n
    for ch, idxs in members.items():
        total: dict[str, float] = {}  # 章の合計。「自分以外」は、ここから自分を引いて作る(長い章でも、かたまりの数に比例)
        for j in idxs:
            for t, x in vectors[j].items():
                total[t] = total.get(t, 0.0) + x
        for pos, i in enumerate(idxs):
            if info[i] <= 0:
                continue
            others = {}
            for t, x in total.items():
                rest = x - vectors[i].get(t, 0.0)
                if rest > REST_EPS:
                    others[t] = rest
            central = _cosine(vectors[i], others)
            score[i] = W_INFO * (info[i] / top) + W_CENTRAL * central + (W_LEAD if pos == 0 else 0.0)

    budget = max(1, math.floor(ratio * n + 0.5))  # 四捨五入(Python の round は偶数丸めで、JavaScript と食い違う)
    ranked = sorted((i for i in range(n) if info[i] > 0), key=lambda i: (-score[i], i))
    chosen: list[int] = []
    per_chapter = []  # 各章の最高点
    for ch in sorted(members):
        best = [i for i in ranked if chapter[i] == ch]
        if best:
            per_chapter.append(best[0])
    per_chapter.sort(key=lambda i: (-score[i], i))
    for i in per_chapter[:budget]:
        chosen.append(i)
    taken = set(chosen)
    for i in ranked:
        if len(chosen) >= budget:
            break
        if i not in taken:
            chosen.append(i)
            taken.add(i)
    picked = sorted(taken)
    if not picked:
        return []

    # 1 つだけ空いたすき間は埋める(細切れに飛ばない)→ 連続を 1 つの区間に
    groups: list[list[int]] = [[picked[0]]]
    for i in picked[1:]:
        if i - groups[-1][-1] <= 2:
            groups[-1].extend(range(groups[-1][-1] + 1, i + 1))
        else:
            groups.append([i])

    spans = []
    for g in groups:
        in_span = [c for u in g for c in unit_cues[u]]
        if not in_span:
            continue
        start = min(c.start_s for c in in_span)
        end = min(max(c.end_s for c in in_span), (g[-1] + 1) * unit_s + END_SLACK_S, duration_s)
        if end - start < MIN_SPAN_S:
            continue
        s = max(score[u] for u in g)
        spans.append({"start_s": round(start, 3), "end_s": round(end, 3), "score": round(min(1.0, s), 3), "chapter": chapter[g[0]]})
    # 区間どうしが重ならないように(最後のかたまりの延長で、次の区間の頭に食い込まない)
    for a, b in zip(spans, spans[1:]):
        if a["end_s"] > b["start_s"]:
            a["end_s"] = b["start_s"]
    return [s for s in spans if s["end_s"] - s["start_s"] >= MIN_SPAN_S]


def total_seconds(spans: list[dict]) -> float:
    return sum(s["end_s"] - s["start_s"] for s in spans)


def _merge(spans: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for a, b in sorted(spans):
        if b <= a:
            continue
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def agreement(auto: list[dict], reference: list[dict]) -> dict:
    """自動の区間と、利用者が調整した区間(正解)の、時間での一致。precision = 自動のうち正解と重なる割合、
    recall = 正解のうち自動が拾えた割合。どちらかが空なら、その側は 0(両方空は 1)。"""
    a = _merge([(s["start_s"], s["end_s"]) for s in auto])
    r = _merge([(s["start_s"], s["end_s"]) for s in reference])
    la, lr = sum(y - x for x, y in a), sum(y - x for x, y in r)
    inter = 0.0
    i = j = 0
    while i < len(a) and j < len(r):
        lo, hi = max(a[i][0], r[j][0]), min(a[i][1], r[j][1])
        if hi > lo:
            inter += hi - lo
        if a[i][1] < r[j][1]:
            i += 1
        else:
            j += 1
    if la == 0 and lr == 0:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0}
    p = inter / la if la else 0.0
    rc = inter / lr if lr else 0.0
    f1 = 2 * p * rc / (p + rc) if p + rc else 0.0
    return {"precision": round(p, 4), "recall": round(rc, 4), "f1": round(f1, 4)}
