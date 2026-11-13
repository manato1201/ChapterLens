"""ライブ検出(live.py)の評価。字幕を時間順に流し込み(replay)、遅れとずれを測る(設計書 §7「遅延」・§8)。

  暫定の遅れ  = 暫定の印が初めて出た時刻 − 確定した境界の時刻(変化から、印が見えるまで)
  確定の遅れ  = 確定した時刻 − 確定した境界の時刻
  置き直しのずれ = |確定した境界 − 暫定の印の位置|(確定でどれだけ動いたか)
  取り下げ率   = 取り下げた暫定 ÷ (確定 + 取り下げ)(空振りの多さ)
遅れは、正解(投稿者のチャプター)の ±30 秒以内に対応づいた境界だけで数える(対応づかない印は、変化の時刻が分からない)。
バッチの検出器(topic-shift@2、同じ区間数)と同じ物差し(F1)で並べる。バッチは動画全体を見られるので、これが上限の目安。
"""

from __future__ import annotations

from .detectors import get_detector
from .live import LiveParams, replay
from .metrics import aggregate, percentile, score_boundaries

TOLERANCES = (10.0, 30.0)
MATCH_S = 30.0


def _stats(values: list[float]) -> dict:
    if not values:
        return {"n": 0, "median": None, "p90": None}
    return {"n": len(values), "median": round(percentile(values, 50), 2), "p90": round(percentile(values, 90), 2)}


def evaluate_live(videos: list[dict], params: LiveParams | None = None) -> dict:
    per_video = []
    scores = {tol: [] for tol in TOLERANCES}
    base_scores = {tol: [] for tol in TOLERANCES}
    seen_lag: list[float] = []
    commit_lag: list[float] = []
    shifts: list[float] = []
    committed = dismissed = 0
    for v in videos:
        det = replay(v["cues"], params)
        pred = [m["t"] for m in det.committed]
        committed += len(pred)
        dismissed += det.n_dismissed
        k = max(0, round(v["duration_s"] / 220.0) - 1)
        batch = get_detector("topic-shift@2").detect(v["cues"], v["duration_s"], target_count=k).boundaries
        for tol in TOLERANCES:
            scores[tol].append(score_boundaries(pred, v["ref"], tol))
            base_scores[tol].append(score_boundaries(batch, v["ref"], tol))
        for m in det.committed:
            shifts.append(abs(m["t"] - m["tentative_t"]))
            if any(abs(m["t"] - r) <= MATCH_S for r in v["ref"]):
                seen_lag.append(m["tentative_at"] - m["t"])
                commit_lag.append(m["committed_at"] - m["t"])
        per_video.append({"id": v["id"], "n_ref": len(v["ref"]), "n_live": len(pred), "n_batch": len(batch),
                          "dismissed": det.n_dismissed})
    return {
        "videos": len(videos),
        "params": (params or LiveParams()).__dict__,
        "live": {f"{t:g}": aggregate(scores[t]) for t in TOLERANCES},
        "batch_prior": {f"{t:g}": aggregate(base_scores[t]) for t in TOLERANCES},
        "tentative_lag_s": _stats(seen_lag),
        "commit_lag_s": _stats(commit_lag),
        "refine_shift_s": _stats(shifts),
        "dismissed_ratio": round(dismissed / (committed + dismissed), 3) if committed + dismissed else None,
        "committed": committed,
        "per_video": per_video,
    }


def evaluate_synthetic(streams: list[tuple[list, list[float]]], params: LiveParams | None = None) -> dict:
    """変化の時刻が分かっている合成の字幕(streams = [(cues, 正解の境界)])での、遅れ・ずれ。"""
    seen, commit, offset = [], [], []
    missed = extra = 0
    for cues, ref in streams:
        det = replay(cues, params)
        for r in ref:
            near = [m for m in det.committed if abs(m["t"] - r) <= MATCH_S]
            if not near:
                missed += 1
                continue
            m = min(near, key=lambda m: abs(m["t"] - r))
            seen.append(m["tentative_at"] - r)
            commit.append(m["committed_at"] - r)
            offset.append(abs(m["t"] - r))
        extra += sum(1 for m in det.committed if not any(abs(m["t"] - r) <= MATCH_S for r in ref))
    return {"tentative_lag_s": _stats(seen), "commit_lag_s": _stats(commit), "offset_s": _stats(offset),
            "missed": missed, "extra": extra}


def render_markdown(result: dict) -> str:
    f = lambda x: "-" if x is None else f"{x:.3f}"  # noqa: E731
    lines = [f"# ライブ検出の評価({result['videos']} 本・字幕を時間順に流し込み)", "",
             "| 系 | F1 ±10s(macro) | F1 ±30s(macro) | 適合率 ±30s | 再現率 ±30s |", "|---|---:|---:|---:|---:|"]
    for name, key in (("ライブ(確定のみ)", "live"), ("バッチ(topic-shift@2・動画全体を見る)", "batch_prior")):
        a, b = result[key]["10"], result[key]["30"]
        lines.append(f"| {name} | {f(a['macro_f1'])} | {f(b['macro_f1'])} | {f(b['micro_precision'])} | {f(b['micro_recall'])} |")
    t, c, s = result["tentative_lag_s"], result["commit_lag_s"], result["refine_shift_s"]
    lines += ["", "| 指標 | 件数 | 中央値(秒) | 90 パーセンタイル(秒) |", "|---|---:|---:|---:|",
              f"| 暫定の印が出るまで(変化から) | {t['n']} | {t['median']} | {t['p90']} |",
              f"| 確定するまで(変化から) | {c['n']} | {c['median']} | {c['p90']} |",
              f"| 確定での置き直しのずれ | {s['n']} | {s['median']} | {s['p90']} |",
              "", f"取り下げ率(空振りの暫定): {result['dismissed_ratio']}  /  確定した境界: {result['committed']}"]
    return "\n".join(lines) + "\n"
