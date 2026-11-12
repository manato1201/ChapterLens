"""埋め込みの類似度の曲線を作って、dataset/<id>/curves_<モデル名>.json に保存する。

**ChapterLens のエンジン自体は依存ゼロ**に保つため、重い埋め込みは、すでにある環境(DevelopmentRAGEnvironment の
.venv: sentence-transformers)で動かし、結果の「曲線」だけをファイルに出す。エンジン側(tools/tune.py)は、
その曲線を読んで境界を選ぶ。モデルは HuggingFace のローカルキャッシュ(intfloat/multilingual-e5-large)を使う。

実行(エンジンのフォルダで。PYTHONPATH はエンジンの src):
  PYTHONPATH=src <DevelopmentRAGEnvironment の .venv の python> tools/embed_curves.py [--limit N] [--device cpu]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

from chapterlens.detectors.topic_shift import bin_index, num_bins
from chapterlens.evaluation import load_dataset

STEP_S = 10.0
WINDOWS = (2, 3, 4, 6, 8, 12, 16)
MODEL_ID = "intfloat/multilingual-e5-large"
TAG = "e5l"


def bin_texts(cues, duration_s: float, step_s: float) -> list[str]:
    nbins = num_bins(duration_s, step_s)
    parts: list[list[str]] = [[] for _ in range(nbins)]
    for cue in cues:
        parts[bin_index(cue.start_s, step_s, nbins)].append(cue.text)
    return [" ".join(p) for p in parts]


def curves_from_embeddings(emb: np.ndarray, has_text: np.ndarray, window: int) -> list[float]:
    """境界 g の前後の窓の平均ベクトルのコサイン。窓にテキストが無ければ 1.0(切り替えの根拠なし)。"""
    nbins = emb.shape[0]
    out = []
    for g in range(1, nbins):
        left = emb[max(0, g - window) : g][has_text[max(0, g - window) : g]]
        right = emb[g : g + window][has_text[g : g + window]]
        if len(left) == 0 or len(right) == 0:
            out.append(1.0)
            continue
        a, b = left.mean(axis=0), right.mean(axis=0)
        na, nb = np.linalg.norm(a), np.linalg.norm(b)
        out.append(float(a @ b / (na * nb)) if na > 0 and nb > 0 else 1.0)
    return out


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="dataset")
    ap.add_argument("--limit", type=int, default=0, help="先頭の N 本だけ(速度の確認用)")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--batch", type=int, default=32)
    args = ap.parse_args()

    from sentence_transformers import SentenceTransformer

    videos, _ = load_dataset(Path(args.dataset))
    if args.limit:
        videos = videos[: args.limit]
    t0 = time.time()
    model = SentenceTransformer(MODEL_ID, device=args.device)
    print(f"モデル読み込み {time.time() - t0:.1f}s({MODEL_ID}・{args.device})", flush=True)

    for v in videos:
        out_path = Path(args.dataset) / v["id"] / f"curves_{TAG}.json"
        if out_path.exists() and not args.limit:
            print(f"{v['id']}: 済(スキップ)", flush=True)
            continue
        texts = bin_texts(v["cues"], v["duration_s"], STEP_S)
        has_text = np.array([bool(t.strip()) for t in texts])
        t1 = time.time()
        # e5 は「類似度」の用途では、両側に "query: " を付ける
        emb = model.encode(
            ["query: " + t if t.strip() else "query: " for t in texts],
            batch_size=args.batch,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        dt = time.time() - t1
        payload = {
            "model": MODEL_ID,
            "step_s": STEP_S,
            "nbins": len(texts),
            "curves": {str(w): curves_from_embeddings(np.asarray(emb), has_text, w) for w in WINDOWS},
        }
        out_path.write_text(json.dumps(payload), encoding="utf-8")
        print(f"{v['id']}: {len(texts)} ビン {dt:.1f}s({len(texts) / dt:.1f} 件/秒)", flush=True)
    print(f"完了 {time.time() - t0:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
