"""境界の「置き直し」(refine)のパラメータ調整。tools/tune.py の結果(粗い窓のパラメータ)を土台にする。

粗い窓で選んだ境界の近く(±radius)で、字幕 1 つ単位の前後比較(window)で位置を決め直す。
調整用で radius・window を選び、確認用は選んだ後に 1 回だけ見る(tune.py と同じ分け方)。
使い方:  uv run python tools/tune_refine.py [--dataset dataset] [--tune results/tune/tune.json] [--out results/tune]
"""

from __future__ import annotations

import argparse
import itertools
import json
import statistics
import sys
from dataclasses import replace
from pathlib import Path

from chapterlens.detectors.topic_shift import (
    PreparedCues,
    TopicShiftParams,
    select_boundaries,
)
from chapterlens.evaluation import load_dataset
from chapterlens.metrics import offset_stats, score_boundaries

sys.path.insert(0, str(Path(__file__).parent))
from tune import Evaluator, split  # noqa: E402

RADII = (0.0, 10.0, 20.0, 30.0, 45.0, 60.0)
WINDOWS = (20.0, 30.0, 45.0, 60.0, 90.0)
TARGETS = ("lexical/free", "lexical/prior", "blend/free", "blend/prior")


def run(
    ev: Evaluator,
    prepared: dict,
    videos,
    p: TopicShiftParams,
    source: str,
    beta: float,
    mode: str,
    seg_len: float,
):
    f3, f10, f30, errs = [], [], [], []
    for v in videos:
        k = (
            len(v["ref"])
            if mode == "oracle"
            else (
                max(0, round(v["duration_s"] / seg_len) - 1)
                if mode == "prior"
                else None
            )
        )
        curve = ev.curve(v, source, p.step_s, p.window_bins, beta)
        det = select_boundaries(
            curve,
            v["cues"],
            v["duration_s"],
            p,
            target_count=k,
            name="r",
            prepared=prepared[v["id"]],
        )
        for tol, acc in ((3.0, f3), (10.0, f10), (30.0, f30)):
            sc = score_boundaries(det.boundaries, v["ref"], tol)
            acc.append(sc.f1)
            if tol == 10.0:
                errs.extend(sc.errors_s)
    mean = lambda xs: sum(xs) / len(xs)  # noqa: E731
    return {
        "f1@3": mean(f3),
        "f1@10": mean(f10),
        "f1@30": mean(f30),
        "offset": offset_stats(errs),
    }


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="dataset")
    ap.add_argument("--tune", default="results/tune/tune.json")
    ap.add_argument("--out", default="results/tune")
    args = ap.parse_args()

    videos, _ = load_dataset(Path(args.dataset))
    tune, val = split(videos)
    tune_report = json.loads(Path(args.tune).read_text(encoding="utf-8"))
    seg_len = tune_report["seg_len_s"]
    ev = Evaluator(Path(args.dataset))
    prepared = {v["id"]: PreparedCues(v["cues"]) for v in videos}

    out: dict = {}
    print(
        "| 系 | 置き直し | 調整用 F1@10 | 確認用 F1@3 | 確認用 F1@10 | 確認用 F1@30 | 確認用 ずれ中央値(s) |"
    )
    print("|---|---|---|---|---|---|---|")
    for key in TARGETS:
        source, mode = key.split("/")
        base = dict(tune_report["results"][key]["best_params"])
        beta = base.pop("beta")
        base_p = TopicShiftParams(**base)
        rows = []
        for radius, window in itertools.product(RADII, WINDOWS):
            if radius == 0.0 and window != WINDOWS[0]:
                continue
            p = replace(base_p, refine_radius_s=radius, refine_window_s=window)
            rows.append(
                (
                    run(ev, prepared, tune, p, source, beta, mode, seg_len)["f1@10"],
                    radius,
                    window,
                )
            )
        rows.sort(key=lambda r: -r[0])
        best_score, best_r, best_w = rows[0]
        no_ref = replace(base_p, refine_radius_s=0.0)
        best_p = replace(base_p, refine_radius_s=best_r, refine_window_s=best_w)
        v0 = run(ev, prepared, val, no_ref, source, beta, mode, seg_len)
        v1 = run(ev, prepared, val, best_p, source, beta, mode, seg_len)
        out[key] = {
            "coarse": tune_report["results"][key]["best"],
            "refine": {"radius_s": best_r, "window_s": best_w},
            "tune_f1@10": best_score,
            "val_without": v0,
            "val_with": v1,
            "top3_tune": [
                {"f1@10": round(s, 4), "radius_s": r, "window_s": w}
                for s, r, w in rows[:3]
            ],
        }
        fmt = lambda x: "-" if x is None else f"{x:.1f}"  # noqa: E731
        print(
            f"| {key} | なし | - | {v0['f1@3']:.3f} | {v0['f1@10']:.3f} | {v0['f1@30']:.3f} | {fmt(v0['offset']['abs_median'])} |"
        )
        print(
            f"| {key} | ±{best_r:g}s・窓 {best_w:g}s | {best_score:.3f} | {v1['f1@3']:.3f} | {v1['f1@10']:.3f} | {v1['f1@30']:.3f} | {fmt(v1['offset']['abs_median'])} |",
            flush=True,
        )

    path = Path(args.out) / "tune_refine.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n結果を {path} に書きました")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
