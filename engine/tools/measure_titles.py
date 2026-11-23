"""題名付け(ローカル LLM)の実測: 実際の窓口へ数章を送り、1 章あたりの秒・検証に落ちた率・題名の例を出す。

使い方(LocalLLMHarness を `uv run llh serve` で起動してから):
  uv run python tools/measure_titles.py <データセットの動画のフォルダ> [--chapters 5] [--total 48]

動画のフォルダには captions.json3(または .vtt / .srt)と chapters.json(投稿者の章。区間の切り方に使う)が要る。
字幕の本文は画面に出さない(題名の例だけ出す)。結果は、docs/reference/titles-measurement.md に手で書き写す。
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

from chapterlens.captions import parse_captions
from chapterlens.llm import LlmError, llm_config_from_env
from chapterlens.titles import generate_sections, generate_title


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path)
    ap.add_argument("--chapters", type=int, default=5, help="測る章の数(既定 5)")
    ap.add_argument("--total", type=int, default=48, help="推定する動画の章の数(既定 48)")
    args = ap.parse_args(argv)

    caps = next((p for p in sorted(args.folder.glob("captions.*"))), None)
    if caps is None or not (args.folder / "chapters.json").exists():
        print("captions.* と chapters.json が要ります", file=sys.stderr)
        return 2
    cues = parse_captions(caps)
    chapters = json.loads((args.folder / "chapters.json").read_text(encoding="utf-8"))["chapters"]
    ends = [c["start_s"] for c in chapters[1:]] + [float("inf")]
    spans = [(c["start_s"], e) for c, e in zip(chapters, ends)]
    # 字幕が十分ある章だけを、先頭から N 個
    picked = []
    for s, e in spans:
        text = " ".join(c.text for c in cues if s <= c.start_s < e)
        if len(text) >= 200:
            picked.append((s, e, text))
        if len(picked) >= args.chapters:
            break

    cfg = llm_config_from_env()
    secs: list[float] = []
    rejected = 0
    titles: list[str] = []
    prev = ""
    print(f"窓口: {cfg.url} / モデル: {cfg.model} / 動画: {args.folder.name} / 章: {len(picked)}")
    for i, (s, e, text) in enumerate(picked):
        t0 = time.time()
        try:
            title, rej = generate_title(cfg, text, prev)
        except LlmError as err:
            print(f"失敗({err.code}): {err}", file=sys.stderr)
            return 1
        dt = time.time() - t0
        secs.append(dt)
        rejected += rej
        titles.append(title or "(検証に落ちた=規則の題名)")
        prev = title or prev
        print(f"  章 {i + 1}: {dt:5.1f} 秒 / 字幕 {len(text)} 文字 / 落ち {rej} 回 / 題名: {titles[-1]}")
    if not secs:
        print("測れる章がありません(字幕 200 文字以上の章が無い)", file=sys.stderr)
        return 1
    mean = statistics.mean(secs)
    calls = len(secs) + rejected
    print(f"\n1 章あたり 平均 {mean:.1f} 秒(最長 {max(secs):.1f} 秒)/ 検証に落ちた回数 {rejected}(呼び出し {calls} 回中)")
    print(f"{args.total} 章の推定: 約 {mean * args.total / 60:.1f} 分(題名のみ。見出しは別に 1 回)")
    if len(titles) >= 4:
        t0 = time.time()
        try:
            sections, rej = generate_sections(cfg, titles)
        except LlmError as err:
            print(f"見出しで失敗({err.code}): {err}", file=sys.stderr)
            return 1
        print(f"見出し: {time.time() - t0:.1f} 秒 / 落ち {rej} 回 / {len(sections)} 区間: " + " | ".join(s["heading"] for s in sections))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
