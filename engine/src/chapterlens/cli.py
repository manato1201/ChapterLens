"""コマンド: detect(字幕 → 区間データ)/ eval(評価)/ chapters(概要欄 → 正解)。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .captions import parse_captions
from .chapters import boundaries_from_chapters, parse_description_chapters
from .detectors import available, get_detector
from .evaluation import evaluate, load_dataset, render_markdown
from .schema import segments_from_boundaries, to_document


def _cmd_detect(args: argparse.Namespace) -> int:
    cues = parse_captions(args.captions)
    if not cues:
        print("字幕が空です", file=sys.stderr)
        return 1
    duration = args.duration or max(c.end_s for c in cues)
    det = get_detector(args.detector)
    result = det.detect(cues, duration, target_count=args.target_count)
    segments = segments_from_boundaries(
        result.boundaries, duration, detector=result.detector, scores=result.scores
    )
    doc = to_document(
        {"kind": "captions", "id": Path(args.captions).stem, "duration_s": duration},
        segments,
        engine=__version__,
    )
    text = json.dumps(doc, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(f"{len(segments)} 区間を {args.out} に書きました")
    else:
        print(text)
    return 0


def _cmd_eval(args: argparse.Namespace) -> int:
    videos, skipped = load_dataset(Path(args.dataset))
    if not videos:
        print("評価に使える動画がありません。", file=sys.stderr)
        for s in skipped:
            print(f"  - {s}", file=sys.stderr)
        return 1
    result = evaluate(videos, args.detector, fixed_every_s=args.fixed_every)
    report = render_markdown(result, skipped)
    print(report)
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        (out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        (out / "report.md").write_text(report, encoding="utf-8")
        print(f"結果を {out} に書きました")
    return 0


def _cmd_chapters(args: argparse.Namespace) -> int:
    text = Path(args.description).read_text(encoding="utf-8")
    chapters = parse_description_chapters(text)
    if not chapters:
        print("チャプターと認められません(先頭が 0:00・3 つ以上・昇順が必要)", file=sys.stderr)
        return 1
    payload = {"chapters": [{"start_s": s, "title": t} for s, t in chapters]}
    out = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(out + "\n", encoding="utf-8")
    else:
        print(out)
    print(f"{len(chapters)} 件(境界 {len(boundaries_from_chapters(chapters))})", file=sys.stderr)
    return 0


def _cmd_asr(args: argparse.Namespace) -> int:
    from .asr import AsrUnavailable, transcribe

    try:
        res = transcribe(args.audio, language=args.language, model_size=args.model, device=args.device)
    except AsrUnavailable as e:
        print(str(e), file=sys.stderr)
        return 2
    payload = {
        "language": res.language, "duration": res.duration_s, "model": res.model, "device": res.device,
        "cues": [{"start": c.start_s, "end": c.end_s, "text": c.text} for c in res.cues],
        "words": [{"start_s": w.start_s, "end_s": w.end_s, "text": w.text} for w in res.words],
    }
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(f"{len(res.cues)} かたまり・{len(res.words)} 単語({res.model}・{res.device})を {args.out} に書きました")
    else:
        print(text)
    return 0


def _cmd_audio(args: argparse.Namespace) -> int:
    """音声 → ASR → 検出 → 区間データ(単語の時刻で、境界を発話の頭へ寄せる)。"""
    from .asr import AsrUnavailable, snap_to_utterances, transcribe

    try:
        res = transcribe(args.audio, language=args.language, model_size=args.model, device=args.device)
    except AsrUnavailable as e:
        print(str(e), file=sys.stderr)
        return 2
    det = get_detector(args.detector).detect(res.cues, res.duration_s, target_count=args.target_count)
    boundaries = snap_to_utterances(det.boundaries, res.words)
    segments = segments_from_boundaries(boundaries, res.duration_s, detector=det.detector)
    doc = to_document({"kind": "audio", "id": Path(args.audio).stem, "duration_s": res.duration_s}, segments,
                      engine=__version__, asr=f"{res.model} ({res.device})")
    text = json.dumps(doc, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(f"{len(segments)} 区間を {args.out} に書きました")
    else:
        print(text)
    return 0


def _cmd_serve(args: argparse.Namespace) -> int:
    from .server import serve

    serve(port=args.port, allow_origins=args.allow_origin or [], max_audio_mb=args.max_audio_mb)
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(prog="chapterlens", description="ChapterLens engine (CH0)")
    sub = parser.add_subparsers(dest="command", required=True)

    d = sub.add_parser("detect", help="字幕から区間データ(JSON)を作る")
    d.add_argument("captions", help="字幕ファイル(.vtt / .srt / .json3)")
    d.add_argument("--detector", default="topic-shift@2", choices=available())
    d.add_argument("--target-count", type=int, help="境界の数を指定(省略すると自動)")
    d.add_argument("--duration", type=float, help="動画の長さ(秒)。省略すると字幕の終わり")
    d.add_argument("--out", help="書き出し先(省略すると標準出力)")
    d.set_defaults(func=_cmd_detect)

    e = sub.add_parser("eval", help="評価データで、検出器と基準を比べる")
    e.add_argument("dataset", help="評価データのフォルダ(動画 1 本 = 1 フォルダ)")
    e.add_argument("--detector", action="append", default=None, choices=available())
    e.add_argument("--fixed-every", type=float, default=300.0, help="基準 fixed の間隔(秒)")
    e.add_argument("--out", help="結果の書き出し先フォルダ(result.json と report.md)")
    e.set_defaults(func=_cmd_eval, detector=None)

    c = sub.add_parser("chapters", help="概要欄の本文から、正解の chapters.json を作る")
    c.add_argument("description", help="概要欄の本文(テキスト)")
    c.add_argument("--out", help="書き出し先(省略すると標準出力)")
    c.set_defaults(func=_cmd_chapters)

    a = sub.add_parser("asr", help="音声を文字起こしする(単語ごとの時刻つき。要 `uv sync --extra asr`)")
    a.add_argument("audio")
    a.add_argument("--language", help="ja / en など。省略すると自動判定")
    a.add_argument("--model", default="small")
    a.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    a.add_argument("--out")
    a.set_defaults(func=_cmd_asr)

    u = sub.add_parser("audio", help="音声から区間データを作る(ASR → 検出 → 発話の頭へ寄せる)")
    u.add_argument("audio")
    u.add_argument("--language")
    u.add_argument("--model", default="small")
    u.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    u.add_argument("--detector", default="topic-shift@2", choices=available())
    u.add_argument("--target-count", type=int)
    u.add_argument("--out")
    u.set_defaults(func=_cmd_audio)

    sv = sub.add_parser("serve", help="ローカルエンジンの HTTP サーバーを起動する(127.0.0.1 だけ・token 認証)")
    sv.add_argument("--port", type=int, default=8787)
    sv.add_argument("--allow-origin", action="append", help="呼ぶことを許す Origin(例 chrome-extension://<id>)。複数可")
    sv.add_argument("--max-audio-mb", type=int, default=300)
    sv.set_defaults(func=_cmd_serve)

    args = parser.parse_args(argv)
    if args.command == "eval" and not args.detector:
        args.detector = ["topic-shift@1", "topic-shift@2"]
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
