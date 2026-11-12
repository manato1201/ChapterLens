"""交差検証(K 分割)でのパラメータ調整。評価データが 39 本になったので、1 回の分け方に頼らない。

- 動画を言語ごとに id 順に並べ、i 番目を fold = i % K に入れる(決まった分け方)
- 各 fold について: 他の fold で最良のパラメータを選び、その fold で評価する(= 未見の動画での成績)
- 最後に、全動画で選んだパラメータ(製品の既定の候補)と、基準(uniform-k)・現行の v2 を、同じ fold 成績で比べる
- モードは free(自動のしきい値)と prior(長さ ÷ L で区間数を見積もる)
使い方:  uv run python tools/cv_tune.py [--dataset dataset] [--folds 5] [--out results/cv]
"""

from __future__ import annotations

import argparse
import itertools
import json
import statistics
import sys
from dataclasses import asdict
from pathlib import Path

from chapterlens import baselines
from chapterlens.detectors.topic_shift import (
    V1_PARAMS,
    V2_PARAMS,
    PreparedCues,
    TopicShiftParams,
    select_boundaries,
    similarity_curve,
)
from chapterlens.evaluation import load_dataset
from chapterlens.metrics import score_boundaries

TOL = 10.0


def folds_of(videos: list[dict], k: int) -> list[list[dict]]:
    out: list[list[dict]] = [[] for _ in range(k)]
    for lang in sorted({v["language"] for v in videos}):
        for i, v in enumerate(
            sorted((v for v in videos if v["language"] == lang), key=lambda v: v["id"])
        ):
            out[i % k].append(v)
    return out


class Scorer:
    def __init__(self, videos: list[dict]) -> None:
        self.prepared = {v["id"]: PreparedCues(v["cues"]) for v in videos}
        self.curves: dict[tuple, list[float]] = {}

    def f1s(
        self, vs: list[dict], p: TopicShiftParams, mode: str, seg_len: float
    ) -> list[float]:
        out = []
        for v in vs:
            key = (v["id"], p.step_s, p.window_bins)
            if key not in self.curves:
                self.curves[key] = similarity_curve(
                    v["cues"], v["duration_s"], p.step_s, p.window_bins
                )
            k = (
                max(0, round(v["duration_s"] / seg_len) - 1)
                if mode == "prior"
                else None
            )
            det = select_boundaries(
                self.curves[key],
                v["cues"],
                v["duration_s"],
                p,
                target_count=k,
                name="cv",
                prepared=self.prepared[v["id"]],
            )
            out.append(score_boundaries(det.boundaries, v["ref"], TOL).f1)
        return out


def grid(mode: str):
    for step, w, gap, a, d, r in itertools.product(
        (10.0, 15.0),
        (4, 6, 8, 12),
        (30.0, 60.0, 90.0),
        (0.0, 0.5, 1.0) if mode == "free" else (0.0,),
        (0.0, 0.1, 0.2) if mode == "free" else (0.0,),
        (0.0, 10.0, 20.0),
    ):
        yield TopicShiftParams(
            step_s=step,
            window_bins=w,
            smooth_bins=3,
            min_gap_s=gap,
            alpha=a,
            min_depth=d,
            refine_radius_s=r,
            refine_window_s=45.0,
        )


def describe(p: TopicShiftParams) -> str:
    return (
        f"step {p.step_s:g}s×window {p.window_bins}・gap {p.min_gap_s:g}s・alpha {p.alpha:g}・"
        f"min_depth {p.min_depth:g}・置き直し ±{p.refine_radius_s:g}s"
    )


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="dataset")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--out", default="results/cv")
    args = ap.parse_args()

    videos, _ = load_dataset(Path(args.dataset))
    folds = folds_of(videos, args.folds)
    sc = Scorer(videos)
    report: dict = {"n_videos": len(videos), "folds": args.folds, "modes": {}}
    print(f"{len(videos)} 本・{args.folds} 分割 ・各 fold {[len(f) for f in folds]} 本")
    for mode in ("free", "prior"):
        combos = list(grid(mode))
        held: list[float] = []  # 未見の fold での、動画ごとの F1
        v2_held: list[float] = []
        v1_held: list[float] = []
        uni_held: list[float] = []
        chosen = []
        for fi, test in enumerate(folds):
            train = [v for j, f in enumerate(folds) if j != fi for v in f]
            seg_len = statistics.median(
                v["duration_s"] / (len(v["ref"]) + 1) for v in train
            )
            best = max(
                combos, key=lambda p: statistics.fmean(sc.f1s(train, p, mode, seg_len))
            )
            chosen.append(describe(best))
            held += sc.f1s(test, best, mode, seg_len)
            v2_held += sc.f1s(test, V2_PARAMS, mode, seg_len)
            v1_held += sc.f1s(test, V1_PARAMS, mode, seg_len)
            uni_held += [
                score_boundaries(
                    baselines.uniform_k(v["duration_s"], len(v["ref"])), v["ref"], TOL
                ).f1
                for v in test
            ]
        seg_all = statistics.median(
            v["duration_s"] / (len(v["ref"]) + 1) for v in videos
        )
        best_all = max(
            combos, key=lambda p: statistics.fmean(sc.f1s(videos, p, mode, seg_all))
        )
        res = {
            "cv_f1_tuned": statistics.fmean(held),
            "cv_f1_v2_fixed": statistics.fmean(v2_held),
            "cv_f1_v1_fixed": statistics.fmean(v1_held),
            "uniform_k": statistics.fmean(uni_held),
            "fold_choices": chosen,
            "best_all": describe(best_all),
            "best_all_params": asdict(best_all),
            "L_s_all": seg_all,
            "f1_all_in_sample": statistics.fmean(
                sc.f1s(videos, best_all, mode, seg_all)
            ),
            "f1_all_v2": statistics.fmean(sc.f1s(videos, V2_PARAMS, mode, seg_all)),
        }
        report["modes"][mode] = res
        print(f"\n== {mode} ({len(combos)} 通り・L={seg_all:.0f}s) ==")
        print(
            f"  未見の fold の F1@10 平均: 各 fold で調整 {res['cv_f1_tuned']:.3f} / 現行 v2(固定) {res['cv_f1_v2_fixed']:.3f} / v1 {res['cv_f1_v1_fixed']:.3f} / 基準 uniform-k {res['uniform_k']:.3f}"
        )
        print(
            f"  全 39 本で選んだ候補: {res['best_all']}(同じ 39 本での F1 {res['f1_all_in_sample']:.3f}。v2 は {res['f1_all_v2']:.3f})"
        )
        for c in chosen:
            print(f"    fold の選択: {c}")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "cv.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n結果を {out / 'cv.json'} に書きました")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
