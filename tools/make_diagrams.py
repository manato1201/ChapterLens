"""docs/diagrams/ の構成図(SVG)を作る。図を直すときは、ここを直して `python tools/make_diagrams.py` を実行する。

  architecture.svg        全体の構成図(ブラウザ・拡張・ローカルエンジン・CLI)
  phases.svg              段階(CH0〜CH6)ごとの機能の地図
  engine-modules.svg      エンジンのモジュールの層
  extension-messages.svg  拡張の中のメッセージの経路

部品は tools/svgkit.py。座標は手で決める(自動配置にしない: 図の読みやすさを、人が決める)。
決まり: ①矢印は、カードの「横」から出入りする(カードの下には文字があるので、縦に重ねない)②縦に渡るときは、カードの間の「すき間」を通る
③流れを説明する文は、図に詰めず、本文(Mermaid のシーケンス図)に書く。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from svgkit import Diagram  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "docs" / "diagrams"


def architecture() -> Diagram:
    d = Diagram(1640, 1000, "ChapterLens の全体の構成",
                "ブラウザの拡張(目次の画面・背景・音声の取り込み)が、この PC の中のエンジン(127.0.0.1)と通信する。"
                "字幕から作る処理は拡張の中だけで完結し、音声・ライブ・共有はエンジンを使う。CLI は管理と書き出しに使う。")
    d.text(40, 44, "ChapterLens — 全体の構成", cls="hd")
    d.text(40, 66, "青=主役の流れ / オレンジ=音声(利用者が操作したときだけ) / 灰の破線=補助", cls="note")

    user = d.card(90, 300, "user", "利用者", "動画を見る")
    d.group(170, 100, 840, 600, "BROWSER — CHROME", color="blue")
    yt = d.card(270, 300, "video", "YouTube の\n動画ページ", "文字起こし(字幕)\n再生中の音")
    d.group(380, 140, 600, 540, "EXTENSION — ChapterLens (MV3)", color="orange")

    content = d.card(500, 250, "list", "content script", "目次の画面・検出\ncore.js(Python と同じ結果)")
    bg = d.card(740, 250, "gear", "background", "service worker\nエンジンの API を中継")
    off = d.card(500, 440, "mic", "offscreen", "タブの音を受ける\nAudioWorklet → WAV")
    pop = d.card(740, 440, "extension", "popup", "音声の取り込みの開始\nURL・token の設定")
    adm = d.card(620, 590, "users", "共有と管理", "admin.html\n(管理者だけ)")

    d.arrow([user.right, (238, 300)], "視聴")
    d.arrow([(302, 300), (340, 300), (340, 250), (468, 250)], "字幕を読む", at=1, dy=-12)
    d.arrow([content.right, bg.left], "sendMessage", both=True)
    d.arrow([(270, 380), (270, 440), (468, 440)], "タブ音声", kind="accent", at=1, dy=-10)
    d.arrow([pop.left, off.right], "開始 tabCapture", kind="secondary", dy=-10)
    d.arrow([(620, 558), (620, 266), (708, 266)], "", kind="secondary")
    d.arrow([(772, 440), (860, 440), (860, 266), (772, 266)], "", kind="secondary")

    d.group(1100, 100, 500, 600, "LOCAL ENGINE — 127.0.0.1 (PYTHON)", color="teal")
    srv = d.card(1200, 400, "shield", "HTTP サーバー", "Host・Origin・token\nロール・レート制限")
    asr = d.card(1450, 190, "wave", "音声認識", "faster-whisper (GPU)")
    det = d.card(1450, 330, "chart", "検出器", "topic-shift@2 / ライブ\n暫定 → 確定")
    db = d.card(1450, 470, "db", "SQLite", "利用者・共有・修正")
    log = d.card(1450, 600, "doc", "監査ログ", "token・字幕は残さない")
    for tgt in (asr, det, db, log):
        d.arrow([(1232, 400), (1330, 400), (1330, tgt.cy), (tgt.left[0], tgt.cy)], "")

    d.arrow([(772, 234), (1040, 234), (1040, 392), (1168, 392)], "共有・ライブ・管理(許可した 13 経路)", at=0, dx=140, dy=-10)
    d.arrow([(440, 440), (440, 538), (1060, 538), (1060, 408), (1168, 408)], "WAV 30 秒(Bearer token)", kind="accent", at=1, dx=0, dy=20)

    d.group(170, 770, 1430, 190, "CLI — この PC のファイルを触れる人(管理者・開発者)", color="purple")
    a = d.card(330, 840, "terminal", "admin", "利用者・共有範囲\n監査ログ")
    d.card(590, 840, "chart", "eval / digest / live", "精度の測定\nダイジェスト・ライブの再生")
    x = d.card(850, 840, "scissors", "export", "EDL・字幕・動画\n(--own が必要)")
    ff = d.card(1110, 840, "film", "ffmpeg", "区間をつなぐ・縦動画\n字幕を焼き込む")
    mv = d.card(1370, 840, "video", "自分の動画", "許諾済みの素材だけ")
    d.arrow([x.right, ff.left], "引数のリスト")
    d.arrow([ff.right, mv.left], "", both=True, kind="secondary")
    d.arrow([(a.cx + 32, 840), (a.cx + 70, 840), (a.cx + 70, 735), (1330, 735), (1330, 700)], "ホームの DB・ログを直接操作", kind="secondary", at=2, dy=-10)
    return d


def phases() -> Diagram:
    d = Diagram(1640, 520, "段階ごとの機能の地図", "CH0 の測る土台から CH6 の書き出しまで、各段階で追加した機能。")
    d.text(40, 44, "段階(CH0〜CH6)の機能の地図", cls="hd")
    d.text(40, 66, "すべて実装済み。実際の Chrome・本物のライブ配信での確認は、利用者の操作で行う", cls="note")
    d.group(40, 110, 1560, 330, "ROADMAP", color="blue")
    items = [
        ("chart", "CH0 測る土台", "評価ハーネス\n検出器・F1"),
        ("list", "CH1 目次", "拡張(字幕から)\nコピー・シーク"),
        ("mic", "CH2 音声", "音声認識・サーバー\nタブ音声(CH2b)"),
        ("users", "CH3 共有", "利用者・ロール\n共有・監査ログ"),
        ("film", "CH4 ダイジェスト", "重要区間を選ぶ\n自動シーク"),
        ("pulse", "CH5 ライブ", "暫定 → 確定\n9 秒 / 27 秒"),
        ("scissors", "CH6 書き出し", "EDL・字幕\n縦動画(--own)"),
    ]
    prev = None
    for i, (g, t, s) in enumerate(items):
        c = d.card(135 + i * 228, 230, g, t, s, size=72)
        d.badge(c.cx + 34, c.cy - 40, "実装済", color="teal", w=58)
        if prev:
            d.arrow([prev.right, c.left], "")
        prev = c
    d.text(80, 420, "CH3b: 拡張の共有・管理の画面と、章の調整(拡張側)  ·  土台の考え方: 先に「測れる」ようにしてから作る(CH0)", cls="note")
    return d


def engine_modules() -> Diagram:
    d = Diagram(1640, 980, "エンジンのモジュールの層",
                "上の層ほど利用者に近い。CLI と道具が、評価とサーバーを呼び、どちらも核(検出・ライブ・ダイジェスト・音声認識)を使う。")
    d.text(40, 44, "エンジン(engine/src/chapterlens)の層", cls="hd")
    d.text(40, 66, "矢印は「使う」。下の層は、上の層を知らない(核は、サーバーも CLI も知らない)", cls="note")

    d.group(40, 110, 1560, 210, "CLI & TOOLS — 入口", color="purple")
    cx = [140, 400, 660, 920, 1180, 1440]
    d.card(cx[0], 200, "terminal", "cli", "detect・eval\nserve・admin")
    d.card(cx[1], 200, "terminal", "cli_tools", "digest・live\nexport")
    d.card(cx[2], 200, "lock", "--own", "書き出しの関門\n(CLI だけ)")
    d.card(cx[3], 200, "chart", "live_eval", "遅れとずれの測定")
    d.card(cx[4], 200, "check", "tools/", "golden・調整\nASR の確認")
    d.card(cx[5], 200, "branch", "__main__", "python -m chapterlens")

    d.group(40, 400, 560, 230, "EVALUATION — 測る", color="orange")
    for x, (g, t, s) in zip((110, 235, 360, 485), (("check", "evaluation", "読み込み・判定"), ("chart", "metrics", "F1・ずれ"),
                                                    ("branch", "baselines", "N 秒ごと"), ("tag", "chapters", "概要欄→正解"))):
        d.card(x, 490, g, t, s)

    d.group(680, 400, 860, 230, "SERVER — 127.0.0.1", color="teal")
    sx = [775, 905, 1035, 1165, 1295, 1425]
    for x, (g, t, s) in zip(sx, (("shield", "server", "HTTP・認証"), ("users", "accounts", "利用者・ロール"), ("folder", "sharing", "共有の検証"),
                                  ("doc", "audit", "ログ・制限"), ("db", "corrections", "修正の保存"), ("pulse", "live_sessions", "セッション"))):
        d.card(x, 490, g, t, s, size=56)

    d.group(40, 710, 1560, 220, "CORE — 核(サーバーも CLI も知らない)", color="blue")
    kx = [130, 330, 530, 730, 930, 1130, 1330, 1520]
    core = (("doc", "captions", "VTT・SRT・json3"), ("tag", "text", "分かち書き"), ("chart", "detectors/\ntopic_shift", "topic-shift@2"), ("list", "schema", "segments@1"),
            ("pulse", "live", "暫定 → 確定"), ("film", "digest", "重要区間"), ("wave", "asr", "faster-whisper"), ("scissors", "export", "EDL・SRT・ffmpeg"))
    for x, (g, t, s) in zip(kx, core):
        d.card(x, 800, g, t, s, size=56)

    # 層をまたぐ矢印は、グループの間のすき間を通る
    d.arrow([(420, 320), (420, 400)], "eval", at=0, dx=22, dy=2)
    d.arrow([(1140, 320), (1140, 400)], "serve / admin", at=0, dx=48, dy=2)
    d.arrow([(420, 630), (420, 710)], "検出器を呼ぶ", at=0, dx=52, dy=2)
    d.arrow([(1140, 630), (1140, 710)], "検出・ライブ・ASR", at=0, dx=62, dy=2)
    d.arrow([(1570, 320), (1570, 710)], "", kind="secondary")
    d.text(40, 960, "灰の破線: CLI は、サーバーを通さず、核(digest・live・export)を直接使う", cls="note")
    return d


def extension_messages() -> Diagram:
    d = Diagram(1640, 900, "拡張の中のメッセージの経路",
                "popup・管理ページ・content script が background へ依頼し、background がエンジンを呼ぶ。音声は offscreen がエンジンへ送り、結果を background 経由で content script へ返す。")
    d.text(40, 44, "拡張(extension/src)のメッセージの経路", cls="hd")
    d.text(40, 66, "fetch は background(エンジン API の中継)と offscreen(音声)だけ。画面と content script は直接送らない", cls="note")

    d.group(40, 110, 360, 290, "EXTENSION PAGES", color="orange")
    pop = d.card(130, 220, "extension", "popup", "開始・停止\nURL・token")
    d.card(310, 220, "users", "admin", "共有と管理")

    d.group(40, 480, 360, 360, "TAB — youtube.com", color="blue")
    yt = d.card(130, 600, "video", "YouTube", "字幕(DOM)\nvideo 要素")
    ct = d.card(310, 600, "list", "content script", "目次・調整\nダイジェスト・共有")
    d.arrow([ct.left, yt.right], "DOM・再生位置", kind="secondary", both=True, dy=-10)

    d.group(520, 330, 280, 250, "SERVICE WORKER", color="orange")
    bg = d.card(660, 440, "gear", "background", "中継・許可リスト\nsender の検査")

    d.group(900, 110, 340, 250, "OFFSCREEN DOCUMENT", color="orange")
    off = d.card(1070, 220, "mic", "offscreen", "getUserMedia(tab)\nAudioWorklet")

    d.group(1330, 330, 270, 250, "LOCAL ENGINE", color="teal")
    eng = d.card(1465, 440, "server", "127.0.0.1", "/v1/transcribe\n/v1/live /v1/shares")

    # background.left への 3 つの入口は、15px 以上あける(矢印の頭が重ならないように)
    d.arrow([(130, 188), (130, 150), (470, 150), (470, 410), (628, 410)], "start {streamId, serverUrl, token}", at=1, dy=-10)
    d.arrow([(342, 220), (430, 220), (430, 440), (628, 440)], "engine {method, path, body}", at=2, dx=-20, dy=-10)
    d.arrow([ct.right, (470, 600), (470, 470), (628, 470)], "engine / stop  ⇄  cl-*", both=True, at=2, dx=-20, dy=18)
    d.arrow([bg.right, eng.left], "fetch(Bearer token・127.0.0.1 だけ)", dy=-10)
    d.arrow([(692, 420), (860, 420), (860, 205), (1038, 205)], "start / stop / status", at=2, dx=-10, dy=-10)
    d.arrow([(1038, 235), (880, 235), (880, 460), (692, 460)], "relay {tabId, payload: cl-cues}", kind="secondary", at=0, dx=-70, dy=20)
    d.arrow([(1102, 220), (1465, 220), (1465, 408)], "POST /v1/transcribe(WAV 30 秒)", kind="accent", at=0, dy=-10)

    d.text(40, 880, "cl-started / cl-cues / cl-status / cl-error / cl-ended は、background → content script(chrome.tabs.sendMessage)", cls="note")
    return d


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in (("architecture", architecture), ("phases", phases), ("engine-modules", engine_modules), ("extension-messages", extension_messages)):
        (OUT / f"{name}.svg").write_text(fn().svg(), encoding="utf-8")
        print("wrote", OUT / f"{name}.svg")


if __name__ == "__main__":
    main()
