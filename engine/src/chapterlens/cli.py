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


def _cmd_admin(args: argparse.Namespace) -> int:
    """この PC の管理者(ファイルを触れる人)が、利用者・共有範囲・監査ログを操作する。サーバーを止めていても使える。"""
    from .accounts import AccountError, AccountStore
    from .audit import AuditLog
    from .corrections import CorrectionStore
    from .server import default_home, load_or_create_token
    from .sharing import ShareStore

    home = default_home()
    accounts = AccountStore(home / "accounts.db")
    accounts.ensure_bootstrap_admin(load_or_create_token(home))
    audit = AuditLog(home / "audit.log")
    try:
        cmd = args.admin_command
        if cmd == "users":
            for u in accounts.list_users():
                print(f"{u['id']:<12} {u['role']:<6} {'停止中' if u['disabled'] else '有効  '} {u['name']}")
        elif cmd == "add-user":
            user, token = accounts.create_user(args.name, args.role)
            audit.event("cli", "admin.user.create", target=user["id"], role=user["role"])
            print(f"作成: {user['id']}  {user['name']}  ({user['role']})")
            print(f"token(この 1 回だけ表示。保存されません。本人にだけ渡す): {token}")
        elif cmd in ("disable", "enable"):
            u = accounts.set_disabled(args.id, cmd == "disable")
            audit.event("cli", f"admin.user.{cmd}", target=u["id"])
            print(f"{u['name']} を{'停止' if cmd == 'disable' else '有効に'}しました")
        elif cmd == "rotate":
            token = accounts.rotate_token(args.id)
            audit.event("cli", "admin.user.rotate", target=args.id)
            print(f"新しい token(この 1 回だけ表示): {token}")
        elif cmd == "purge":
            if not args.yes:
                print("利用者・その修正・共有を完全に消します。元に戻せません。実行するなら --yes を付けてください")
                return 1
            accounts.check_manageable(args.id, "削除")
            store, shares = CorrectionStore(home / "corrections.db"), ShareStore(home / "shares.db")
            n_c, n_s = store.delete_owner(args.id), shares.delete_owner(args.id)
            accounts.delete_user(args.id)
            audit.event("cli", "admin.user.purge", target=args.id, corrections=n_c, shares=n_s)
            print(f"削除しました(修正 {n_c} 件・共有 {n_s} 件)")
        elif cmd == "share-mode":
            if args.mode:
                before = accounts.share_mode
                accounts.set_share_mode(args.mode)
                audit.event("cli", "admin.settings.share_mode", before=before, after=args.mode)
            print(f"共有範囲: {accounts.share_mode}(off=共有しない / team=全員か指定した人 / named=指定した人だけ)")
        elif cmd == "audit":
            for rec in audit.tail(args.n):
                print(json.dumps(rec, ensure_ascii=False))
    except AccountError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    finally:
        accounts.close()
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

    ad = sub.add_parser("admin", help="利用者・共有範囲・監査ログの管理(この PC の管理者用。サーバーを止めていても使える)")
    adsub = ad.add_subparsers(dest="admin_command", required=True)
    adsub.add_parser("users", help="利用者の一覧")
    au = adsub.add_parser("add-user", help="利用者を追加する(token は 1 度だけ表示)")
    au.add_argument("name")
    au.add_argument("--role", default="user", choices=["user", "admin"])
    for name, h in (("disable", "利用者を停止する"), ("enable", "停止を解く"), ("rotate", "token を再発行する(古い token は無効)")):
        x = adsub.add_parser(name, help=h)
        x.add_argument("id")
    pu = adsub.add_parser("purge", help="利用者と、その修正・共有を完全に消す")
    pu.add_argument("id")
    pu.add_argument("--yes", action="store_true")
    sm = adsub.add_parser("share-mode", help="共有範囲を見る/変える(off / team / named)")
    sm.add_argument("mode", nargs="?", choices=["off", "team", "named"])
    ag = adsub.add_parser("audit", help="監査ログの末尾")
    ag.add_argument("-n", type=int, default=50)
    ad.set_defaults(func=_cmd_admin)

    from . import cli_tools

    cli_tools.register(sub)

    args = parser.parse_args(argv)
    if args.command == "eval" and not args.detector:
        args.detector = ["topic-shift@1", "topic-shift@2"]
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
