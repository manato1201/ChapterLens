"""CH2 の実機確認: テスト音声(合成)を ASR にかけ、速度・認識・**時刻の精度**を測る。

正解は make_tts_fixture.py が作る(話題のつなぎ目の時刻)。測るもの:
  ・処理時間とリアルタイム比
  ・各話題の最初の発話の時刻: ASR の単語の開始時刻 − 正解(秒)。設計 CH2 の基準は「中央値 1.0 秒以内(仮)」
  ・検出器(ASR の字幕に対して)で境界を出し、正解との差(置き直しなし/あり)
使い方:  uv run python tools/asr_check.py [en|ja|all] [--model small] [--device auto]
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

from chapterlens.asr import snap_to_utterances, transcribe
from chapterlens.detectors.topic_shift import TopicShiftParams, select_boundaries, similarity_curve
from chapterlens.metrics import match_boundaries

ROOT = Path(__file__).resolve().parent.parent
# 短いテスト音声(話題が約 55 秒)用の検出パラメータ。製品の既定(最小間隔 60 秒)では、短すぎて分けられない
SHORT = TopicShiftParams(step_s=5.0, window_bins=6, smooth_bins=3, min_gap_s=30.0, alpha=0.0, min_depth=0.0,
                         refine_radius_s=5.0, refine_window_s=20.0)


def nearest_word_start(words, t, back=1.0, fwd=6.0):
    cands = [w.start_s for w in words if t - back <= w.start_s <= t + fwd]
    return min(cands, key=lambda s: abs(s - t)) if cands else None


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("which", nargs="?", default="all")
    ap.add_argument("--model", default="small")
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()
    langs = ("en", "ja") if args.which == "all" else (args.which,)

    for lang in langs:
        wav = ROOT / "results" / "tts" / f"{lang}.wav"
        truth = json.loads((ROOT / "results" / "tts" / f"{lang}.json").read_text(encoding="utf-8"))
        t0 = time.time()
        res = transcribe(wav, language=lang, model_size=args.model, device=args.device)
        dt = time.time() - t0
        print(f"\n=== {lang} ===  {res.model} / {res.device}  音声 {truth['duration_s']:.0f}s を {dt:.1f}s で処理(リアルタイム比 {dt / truth['duration_s']:.2f})")
        print(f"認識: かたまり {len(res.cues)} 個・単語 {len(res.words)} 個。冒頭: {res.cues[0].text[:60] if res.cues else ''}")

        starts = [0.0] + truth["boundaries_s"]
        errs = []
        for name, s in zip([t["name"] for t in truth["topics"]], starts):
            w = nearest_word_start(res.words, s)
            if w is not None:
                errs.append(w - s)
                print(f"  話題 {name:8s} 正解 {s:7.2f}s / ASR の最初の単語 {w:7.2f}s / 差 {w - s:+.2f}s")
        if errs:
            print(f"  → 発話の始まりの時刻の差: 絶対値の中央値 {statistics.median(abs(e) for e in errs):.2f}s・最大 {max(abs(e) for e in errs):.2f}s")

        # 検出器: ASR のかたまり(字幕と同じ形)に対して
        ref = truth["boundaries_s"]
        dur = truth["duration_s"]
        for label, k in (("正解の区間数を教える", len(ref)), ("自動", None)):
            curve = similarity_curve(res.cues, dur, SHORT.step_s, SHORT.window_bins)
            det = select_boundaries(curve, res.cues, dur, SHORT, target_count=k, name="asr")
            snapped = snap_to_utterances(det.boundaries, res.words, radius_s=5.0)
            def report(b):
                pairs = match_boundaries(b, ref, 10.0)
                err = [abs(p - r) for p, r in pairs]
                return f"検出 {len(b)} 個 / 正解 {len(ref)} 個 / ±10s で一致 {len(pairs)} 個・差の中央値 {statistics.median(err) if err else float('nan'):.2f}s"
            print(f"  検出器({label}): {report(det.boundaries)}")
            print(f"      +発話の頭へ寄せる: {report(snapped)}   境界 {det.boundaries} → {[round(x,2) for x in snapped]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
