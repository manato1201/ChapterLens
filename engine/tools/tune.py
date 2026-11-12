"""検出器のパラメータ調整(CH0)。**調整用と確認用に分けて**、過学習を見張る。

- 動画を言語ごとに id 順に並べ、偶数番目を「調整用」、奇数番目を「確認用」にする(決まった分け方。乱数なし)
- 調整用でだけ、格子探索で最良のパラメータを選ぶ。確認用は**選んだ後に 1 回だけ**見る
- 類似度の曲線の出どころ(source):
    lexical  語彙(TF-IDF)。エンジンの中で計算
    embed    埋め込み(multilingual-e5-large)。tools/embed_curves.py が dataset/<id>/curves_e5l.json に出したもの
    blend    上の 2 つの重みつき平均(β = 埋め込みの重み)。設計書 §5 の「検出器を並べて合議」
- モード:
    free   正解の区間数を知らない(自動のしきい値)。製品の既定に近い
    prior  区間数を「動画の長さ ÷ 1 区間の長さ L」で見積もる(L は調整用の中央値)。「粒度」を利用者が選ぶ形
    oracle 正解の区間数を教える(上限の目安。製品では使えない)
使い方:  uv run python tools/tune.py [--dataset dataset] [--out results/tune]
"""

from __future__ import annotations

import argparse
import itertools
import json
import statistics
import sys
from pathlib import Path

from chapterlens.detectors.topic_shift import TopicShiftParams, select_boundaries, similarity_curve
from chapterlens.evaluation import load_dataset
from chapterlens.metrics import score_boundaries

TOL = 10.0
EMBED_TAG = "e5l"


def split(videos: list[dict]) -> tuple[list[dict], list[dict]]:
    tune, val = [], []
    for lang in sorted({v["language"] for v in videos}):
        group = sorted((v for v in videos if v["language"] == lang), key=lambda v: v["id"])
        for i, v in enumerate(group):
            (tune if i % 2 == 0 else val).append(v)
    return tune, val


class Evaluator:
    def __init__(self, dataset: Path) -> None:
        self.dataset = dataset
        self._lex: dict[tuple, list[float]] = {}
        self._emb: dict[tuple, list[float]] = {}
        self._emb_files: dict[str, dict] = {}

    def lexical(self, v: dict, step: float, w: int) -> list[float]:
        key = (v["id"], step, w)
        if key not in self._lex:
            self._lex[key] = similarity_curve(v["cues"], v["duration_s"], step, w)
        return self._lex[key]

    def embed(self, v: dict, w: int) -> list[float] | None:
        if v["id"] not in self._emb_files:
            path = self.dataset / v["id"] / f"curves_{EMBED_TAG}.json"
            self._emb_files[v["id"]] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        data = self._emb_files[v["id"]]
        return data.get("curves", {}).get(str(w))

    def curve(self, v: dict, source: str, step: float, w: int, beta: float) -> list[float]:
        if source == "lexical":
            return self.lexical(v, step, w)
        emb = self.embed(v, w)
        if emb is None:
            raise FileNotFoundError(f"{v['id']}: 埋め込みの曲線がありません(tools/embed_curves.py を先に実行)")
        if source == "embed":
            return emb
        lex = self.lexical(v, 10.0, w)
        n = min(len(lex), len(emb))
        return [(1 - beta) * lex[i] + beta * emb[i] for i in range(n)]

    def macro_f1(self, videos, p: TopicShiftParams, source: str, beta: float, mode: str, seg_len_s: float, tol: float = TOL) -> float:
        total = 0.0
        for v in videos:
            k = len(v["ref"]) if mode == "oracle" else (max(0, round(v["duration_s"] / seg_len_s) - 1) if mode == "prior" else None)
            curve = self.curve(v, source, p.step_s, p.window_bins, beta)
            det = select_boundaries(curve, v["cues"], v["duration_s"], p, target_count=k, name="tune")
            total += score_boundaries(det.boundaries, v["ref"], tol).f1
        return total / len(videos)


def grid(source: str, mode: str):
    if source == "lexical":
        steps, windows = (5.0, 10.0, 15.0, 20.0), (3, 4, 6, 8, 12)
        depths_free = (0.0, 0.05, 0.1, 0.15, 0.2, 0.3)
        betas = (0.0,)
    else:  # 埋め込みの曲線は step 10 固定。類似度の値の幅が小さいので、下限も小さく
        steps, windows = (10.0,), (2, 3, 4, 6, 8, 12, 16)
        depths_free = (0.0, 0.01, 0.02, 0.04, 0.08)
        betas = (1.0,) if source == "embed" else (0.3, 0.5, 0.7)
    smooths, gaps = (1, 3, 5), (30.0, 60.0, 90.0, 120.0)
    alphas, depths = ((0.0, 0.5, 1.0, 1.5), depths_free) if mode == "free" else ((0.0,), (0.0,))
    for beta, step, w, sm, gap, a, d in itertools.product(betas, steps, windows, smooths, gaps, alphas, depths):
        yield beta, TopicShiftParams(step_s=step, window_bins=w, smooth_bins=sm, min_gap_s=gap, alpha=a, min_depth=d)


def describe(beta: float, source: str, p: TopicShiftParams) -> str:
    head = f"β{beta:g}・" if source == "blend" else ""
    return (
        f"{head}step {p.step_s:g}s × window {p.window_bins}(={p.step_s * p.window_bins:g}s)・smooth {p.smooth_bins}・"
        f"gap {p.min_gap_s:g}s・alpha {p.alpha:g}・min_depth {p.min_depth:g}"
    )


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="dataset")
    ap.add_argument("--out", default="results/tune")
    ap.add_argument("--sources", default="lexical,embed,blend")
    args = ap.parse_args()

    videos, _ = load_dataset(Path(args.dataset))
    tune, val = split(videos)
    print(f"調整用 {len(tune)} 本 / 確認用 {len(val)} 本")
    seg_len = statistics.median(v["duration_s"] / (len(v["ref"]) + 1) for v in tune)
    print(f"1 区間の長さ L(調整用の中央値): {seg_len:.0f} 秒")

    ev = Evaluator(Path(args.dataset))
    default = TopicShiftParams()
    report: dict = {"tune_ids": [v["id"] for v in tune], "val_ids": [v["id"] for v in val], "seg_len_s": seg_len, "results": {}}
    print("\n| source | mode | 既定: 調整用 / 確認用 | 調整後: 調整用 / 確認用 | 確認用 ±3s | 通り数 |")
    print("|---|---|---|---|---|---|")
    for source in args.sources.split(","):
        for mode in ("free", "prior", "oracle"):
            combos = list(grid(source, mode))
            scored = sorted(
                ((ev.macro_f1(tune, p, source, beta, mode, seg_len), beta, p) for beta, p in combos),
                key=lambda x: -x[0],
            )
            best_score, best_beta, best = scored[0]
            res = {
                "n_combos": len(combos),
                "best": describe(best_beta, source, best),
                "best_params": {**best.__dict__, "beta": best_beta},
                "tune": best_score,
                "val": ev.macro_f1(val, best, source, best_beta, mode, seg_len),
                "val_f1_at_3s": ev.macro_f1(val, best, source, best_beta, mode, seg_len, 3.0),
                "top5_tune": [{"f1": round(s, 4), "params": describe(b, source, p)} for s, b, p in scored[:5]],
            }
            if source == "lexical":
                res["default"] = {"tune": ev.macro_f1(tune, default, source, 0.0, mode, seg_len), "val": ev.macro_f1(val, default, source, 0.0, mode, seg_len)}
            report["results"][f"{source}/{mode}"] = res
            d = f"{res['default']['tune']:.3f} / {res['default']['val']:.3f}" if "default" in res else "-"
            print(f"| {source} | {mode} | {d} | {res['tune']:.3f} / {res['val']:.3f} | {res['val_f1_at_3s']:.3f} | {len(combos)} |", flush=True)
    print()
    for key, res in report["results"].items():
        print(f"{key}: {res['best']}")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "tune.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n結果を {out / 'tune.json'} に書きました")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
