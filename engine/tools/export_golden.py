"""拡張(JavaScript 版 core.js)の期待値を、Python 版(topic-shift@2)から出す。

- golden: 合成データ(tests/synth.py)で作る。**コミットしてよい**(他人の字幕を含まない)→ extension/test/golden/golden.json
- real:   実データ(dataset/)の結果。**ローカルだけ**(results/ は .gitignore)→ results/parity_python.json
  extension/tools/parity_real.mjs が、これと JavaScript 版を突き合わせる

使い方:  uv run python tools/export_golden.py [golden|real|all]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))

from chapterlens.detectors import get_detector  # noqa: E402
from chapterlens.digest import select_digest  # noqa: E402
from chapterlens.evaluation import load_dataset  # noqa: E402
from synth import make_video  # noqa: E402

CASES = [
    ("en-6topics", [210, 380, 150, 520, 270, 330], "en", 11),
    ("ja-5topics", [300, 140, 460, 200, 380], "ja", 12),
    ("en-4topics", [180, 420, 260, 610], "en", 13),
    ("ja-single", [900], "ja", 14),
    ("en-short", [90, 80], "en", 15),
]
TARGETS = (None, 3, 6)
DIGEST_RATIOS = (0.2, 0.35)  # ダイジェスト(digest@1)の、予算の割合


def run(det, cues, duration, k):
    d = det.detect(cues, duration, target_count=k)
    return {"boundaries": d.boundaries, "scores": d.scores}


def export_golden() -> Path:
    det = get_detector("topic-shift@2")
    cases = []
    for name, lengths, lang, seed in CASES:
        cues, ref, duration = make_video(lengths, lang=lang, seed=seed)
        cases.append(
            {
                "name": name,
                "duration": duration,
                "cues": [
                    {"start": c.start_s, "end": c.end_s, "text": c.text} for c in cues
                ],
                "expect": {
                    ("free" if k is None else f"k{k}"): run(det, cues, duration, k)
                    for k in TARGETS
                },
                # ダイジェストは、k3 の境界を入力にする(JavaScript 版も同じ境界で呼ぶ)
                "digest": {
                    f"r{r}": [
                        {"start": s["start_s"], "end": s["end_s"], "score": s["score"], "chapter": s["chapter"]}
                        for s in select_digest(cues, run(det, cues, duration, 3)["boundaries"], duration, ratio=r)
                    ]
                    for r in DIGEST_RATIOS
                },
            }
        )
    out = ROOT.parent / "extension" / "test" / "golden" / "golden.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps({"detector": "topic-shift@2", "cases": cases}, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"golden: {len(cases)} ケース → {out}")
    return out


def export_real() -> Path:
    det = get_detector("topic-shift@2")
    videos, _ = load_dataset(ROOT / "dataset")
    rows = []
    for v in videos:
        rows.append(
            {
                "id": v["id"],
                "duration": v["duration_s"],
                "cues": [
                    {"start": c.start_s, "end": c.end_s, "text": c.text}
                    for c in v["cues"]
                ],
                "free": run(det, v["cues"], v["duration_s"], None),
                "k6": run(det, v["cues"], v["duration_s"], 6),
                "digest": [  # k6 の境界を入力にしたダイジェスト(JavaScript 版と突き合わせる)
                    {"start": d["start_s"], "end": d["end_s"], "chapter": d["chapter"]}
                    for d in select_digest(v["cues"], run(det, v["cues"], v["duration_s"], 6)["boundaries"], v["duration_s"])
                ],
            }
        )
    out = ROOT / "results" / "parity_python.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    print(f"real: {len(rows)} 本 → {out}(ローカルのみ・コミットしない)")
    return out


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("golden", "all"):
        export_golden()
    if what in ("real", "all"):
        export_real()
