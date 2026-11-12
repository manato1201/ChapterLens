"""CLI(CH4〜CH6): digest(ダイジェストの区間)・live(ライブ検出の再生)・export(書き出し)。cli.py から登録される。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .captions import Cue, parse_captions
from .detectors import get_detector
from .digest import DEFAULT_RATIO, agreement, select_digest, total_seconds
from .evaluation import PRIOR_SEGMENT_S, load_dataset
from .export import (SHORT_MAX_S, ExportError, chapters_to_marker_edl, check_input, fit_spans, render, retime_cues,
                     spans_to_edl, to_srt, to_vtt)
from .live import LiveParams, replay


def _load(path: str, duration: float | None, target_count: int | None) -> tuple[list[Cue], list[float], float]:
    cues = parse_captions(path)
    if not cues:
        raise ExportError("字幕が空です")
    dur = duration or max(c.end_s for c in cues)
    k = target_count if target_count is not None else max(0, round(dur / PRIOR_SEGMENT_S) - 1)
    return cues, get_detector("topic-shift@2").detect(cues, dur, target_count=k).boundaries, dur


def _write(text: str, out: str | None) -> None:
    if out:
        Path(out).write_text(text, encoding="utf-8")
        print(f"{out} に書きました", file=sys.stderr)
    else:
        print(text, end="" if text.endswith("\n") else "\n")


def _digest_spans(args: argparse.Namespace) -> tuple[list[Cue], list[float], float, list[dict]]:
    cues, bounds, dur = _load(args.captions, args.duration, args.target_count)
    return cues, bounds, dur, select_digest(cues, bounds, dur, ratio=args.ratio)


def _cmd_digest(args: argparse.Namespace) -> int:
    try:
        _, bounds, dur, spans = _digest_spans(args)
    except ExportError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    doc = {"schema": "chapterlens/digest@1", "duration_s": dur, "ratio": args.ratio, "engine": __version__,
           "seconds": round(total_seconds(spans), 1), "boundaries": bounds, "spans": spans}
    _write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", args.out)
    return 0


def _cmd_digest_eval(args: argparse.Namespace) -> int:
    """利用者が調整した区間(各動画の digest.json: {"spans":[{"start_s","end_s"}...]})と、自動の区間の一致を測る。"""
    videos, _ = load_dataset(Path(args.dataset))
    rows = []
    for v in videos:
        ref_path = Path(args.dataset) / v["id"] / "digest.json"
        if not ref_path.exists():
            continue
        ref = json.loads(ref_path.read_text(encoding="utf-8")).get("spans", [])
        k = max(0, round(v["duration_s"] / PRIOR_SEGMENT_S) - 1)
        bounds = get_detector("topic-shift@2").detect(v["cues"], v["duration_s"], target_count=k).boundaries
        auto = select_digest(v["cues"], bounds, v["duration_s"], ratio=args.ratio)
        rows.append((v["id"], agreement(auto, ref)))
    if not rows:
        print('正解の区間(各動画の digest.json)がありません。形: {"spans": [{"start_s": 0, "end_s": 30}, ...]}', file=sys.stderr)
        return 1

    def mean(key: str) -> float:
        return sum(r[key] for _, r in rows) / len(rows)

    for vid, r in rows:
        print(f"{vid}  適合率 {r['precision']:.3f}  再現率 {r['recall']:.3f}  F1 {r['f1']:.3f}")
    print(f"平均({len(rows)} 本)  適合率 {mean('precision'):.3f}  再現率 {mean('recall'):.3f}  F1 {mean('f1'):.3f}")
    return 0


def _cmd_live(args: argparse.Namespace) -> int:
    det = replay(parse_captions(args.captions), LiveParams())
    for m in det.committed:
        print(f"確定 t={m['t']:.1f}s  暫定が出た {m['tentative_at']:.1f}s  確定した {m['committed_at']:.1f}s  (信頼度 {m['score']})")
    if det.pending:
        print(f"暫定 t={det.pending['t']:.1f}s(まだ確定していない)")
    print(f"確定 {len(det.committed)} 件・取り下げ {len(det.dismissed)} 件", file=sys.stderr)
    return 0


def _cmd_live_eval(args: argparse.Namespace) -> int:
    from .live_eval import evaluate_live, render_markdown

    videos, _ = load_dataset(Path(args.dataset))
    if not videos:
        print("評価に使える動画がありません。", file=sys.stderr)
        return 1
    result = evaluate_live(videos)
    report = render_markdown(result)
    print(report)
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        (out / "live_result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        (out / "live_report.md").write_text(report, encoding="utf-8")
    return 0


def _audit(kind: str, **fields) -> None:
    """動画を書き出したことを、監査ログに残す(ファイルのパスは残さない)。"""
    from .audit import AuditLog
    from .server import default_home

    home = default_home()
    home.mkdir(parents=True, exist_ok=True)
    AuditLog(home / "audit.log").event("cli", f"export.{kind}", **fields)


def _cmd_export(args: argparse.Namespace) -> int:
    kind = args.export_kind
    try:
        if kind == "chapters-edl":
            cues, bounds, _ = _load(args.captions, args.duration, args.target_count)
            titles = []
            for s in [0.0, *bounds]:
                cue = next((c for c in cues if c.start_s >= s - 1e-6), None)
                titles.append(" ".join(cue.text.split())[:24] if cue else "")
            _write(chapters_to_marker_edl(bounds, titles, fps=args.fps), args.out)
            return 0
        cues, _, _, spans = _digest_spans(args)
        if kind == "edl":
            _write(spans_to_edl(spans, fps=args.fps, clip_name=args.clip_name or ""), args.out)
        elif kind == "subtitles":
            use = retime_cues(cues, spans) if args.digest else cues
            _write(to_vtt(use) if args.format == "vtt" else to_srt(use), args.out)
        elif kind in ("video", "short"):
            src = check_input(args.video, args.own)
            if kind == "short":
                spans = fit_spans(spans, args.max_s)
            info = render(src, Path(args.out), spans, cues, vertical=kind == "short",
                          burn_subtitles=kind == "short" or args.burn, font=args.font, overwrite=args.overwrite)
            _audit(kind, spans=info["spans"], seconds=info["seconds"], vertical=info["vertical"])
            shape = "縦 1080x1920・字幕を焼き込み" if info["vertical"] else "元の縦横比"
            print(f"書き出しました: {info['output']}({info['spans']} 区間・{info['seconds']} 秒・{shape})")
    except ExportError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    return 0


def _captions_args(p: argparse.ArgumentParser, *, ratio: bool = True) -> None:
    p.add_argument("captions", help="字幕ファイル(.vtt / .srt / .json3)")
    p.add_argument("--duration", type=float, help="動画の長さ(秒)。省略すると字幕の終わり")
    p.add_argument("--target-count", type=int, help="章の境界の数(省略すると、長さ ÷ 220 秒)")
    if ratio:
        p.add_argument("--ratio", type=float, default=DEFAULT_RATIO, help="ダイジェストに使う長さの割合(既定 0.2)")


def register(sub) -> None:
    g = sub.add_parser("digest", help="ダイジェスト(重要な区間のリスト)を作る。動画は切り出さない")
    _captions_args(g)
    g.add_argument("--out")
    g.set_defaults(func=_cmd_digest)

    ge = sub.add_parser("digest-eval", help="利用者が調整した区間(各動画の digest.json)との一致を測る")
    ge.add_argument("dataset")
    ge.add_argument("--ratio", type=float, default=DEFAULT_RATIO)
    ge.set_defaults(func=_cmd_digest_eval)

    lv = sub.add_parser("live", help="字幕を時間順に流し込んで、ライブ検出の暫定・確定の印を見る")
    lv.add_argument("captions")
    lv.set_defaults(func=_cmd_live)

    le = sub.add_parser("live-eval", help="評価データでライブ検出の遅れとずれを測る")
    le.add_argument("dataset")
    le.add_argument("--out", help="結果の書き出し先フォルダ")
    le.set_defaults(func=_cmd_live_eval)

    ex = sub.add_parser("export", help="書き出し(CH6)。動画を触るのは video / short だけで、自分の動画・許諾済みの素材のみ(--own)")
    exsub = ex.add_subparsers(dest="export_kind", required=True)

    e = exsub.add_parser("edl", help="ダイジェストの区間を EDL(CMX3600)にする")
    _captions_args(e)
    e.add_argument("--fps", type=int, default=30)
    e.add_argument("--clip-name", help="EDL に書く元ファイル名")
    e.add_argument("--out")

    c = exsub.add_parser("chapters-edl", help="章の境界を、編集ソフト用のマーカーつき EDL にする")
    _captions_args(c, ratio=False)
    c.add_argument("--fps", type=int, default=30)
    c.add_argument("--out")

    s = exsub.add_parser("subtitles", help="字幕を SRT / VTT にする(--digest で、ダイジェストの時間に詰め直す)")
    _captions_args(s)
    s.add_argument("--format", choices=["srt", "vtt"], default="srt")
    s.add_argument("--digest", action="store_true")
    s.add_argument("--out")

    v = exsub.add_parser("video", help="ダイジェストの区間をつないだ動画を書き出す(要 ffmpeg・--own)")
    v.add_argument("video", help="この PC にある、自分の動画ファイル")
    _captions_args(v)
    v.add_argument("--own", action="store_true", help="自分の動画・許諾を得た素材です(これが無いと動かない)")
    v.add_argument("--burn", action="store_true", help="字幕を映像に焼き込む")
    v.add_argument("--font")
    v.add_argument("--overwrite", action="store_true", help="同じ名前のファイルがあっても上書きする")
    v.add_argument("--out", required=True)

    sh = exsub.add_parser("short", help="縦(1080x1920)の短い動画を書き出す。字幕を焼き込む(要 ffmpeg・--own)")
    sh.add_argument("video")
    _captions_args(sh)
    sh.add_argument("--max-s", type=float, default=SHORT_MAX_S)
    sh.add_argument("--own", action="store_true", help="自分の動画・許諾を得た素材です(これが無いと動かない)")
    sh.add_argument("--font", help="字幕のフォント名(日本語は例: 'Yu Gothic')")
    sh.add_argument("--overwrite", action="store_true", help="同じ名前のファイルがあっても上書きする")
    sh.add_argument("--out", required=True)
    ex.set_defaults(func=_cmd_export)
