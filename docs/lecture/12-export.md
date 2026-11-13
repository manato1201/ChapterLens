# 第 12 回 書き出し(EDL・字幕・ffmpeg)と、権利の関門

> 所要時間の目安: 3 時間 / 前提: 第 11 回

## この回のゴール

- **EDL**(編集の指示書)・**SRT/VTT**(字幕)の書式と、**時刻の詰め直し**を説明できる。
- ffmpeg の `filter_complex`(切り出して → つなぐ → 切り抜く → 字幕を焼く)を読める。
- **権利の関門**(`--own`・URL 拒否・CLI だけ・上書き拒否)を、なぜ・どう作ったか説明できる。
- 外部プログラム(ffmpeg)を、**安全に呼ぶ**書き方が分かる。

## 1. 何を書き出すか

| 出力 | 動画に触るか | 用途 |
|---|---|---|
| EDL(CMX3600) | 触らない(時刻の表) | 編集ソフトで、区間をつなぐ・章のマーカーを置く |
| SRT / VTT | 触らない(文字と時刻) | 字幕ファイル。ダイジェストの時間に**詰め直す**こともできる |
| ダイジェスト動画 | **触る** | 区間をつないだ動画(元の縦横比) |
| 縦の短い動画 | **触る** | 縦 1080×1920・字幕を焼き込み(59 秒以内) |

## 2. 権利の関門

他人の動画の切り出し・再配布はしない、という方針を、**コードで強制**します。

```python
# 引用: engine/src/chapterlens/export.py::check_input
def check_input(path: str, own: bool) -> Path:
    """動画ファイルを検査する。--own が無い・URL・無い・動画でない、は ExportError。"""
    if not own:
        raise ExportError(OWN_NOTICE)
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", path) or "youtube.com" in path.lower() or "youtu.be" in path.lower():
        raise ExportError("動画の URL は受け付けません(この PC にある、自分の動画ファイルだけ)")
    p = Path(path)
    if not p.is_file():
        raise ExportError(f"動画ファイルがありません: {path}")
    if p.suffix.lower() not in VIDEO_SUFFIXES:
        raise ExportError(f"動画の拡張子ではありません: {p.suffix}")
    return p
```

- **`--own` が無いと動かない**(自分の動画・許諾を得た素材、と明示)。
- 入力は**この PC の動画ファイルだけ**。`https://…`・`youtube.com` を含む指定は拒否。
- 動画を触る書き出しは **CLI だけ**。HTTP にも拡張にも出さない(遠隔・他人のページから呼べない)。
- 出力は、**既存ファイルを上書きしない**(`--overwrite` が要る)・入力と同じ名前も拒否。
- 書き出したことは監査ログに残る(**ファイルの名前・パスは残さない**)。

```python
# 実行できる
import tempfile
from pathlib import Path
from chapterlens.export import ExportError, check_input

with tempfile.TemporaryDirectory() as tmp:
    mine = Path(tmp) / "mine.mp4"
    mine.write_bytes(b"x")
    cases = [("自分の動画・--own なし", str(mine), False),
             ("YouTube の URL", "https://www.youtube.com/watch?v=abc", True),
             ("短縮 URL", "youtu.be/abc", True),
             ("存在しないファイル", str(Path(tmp) / "none.mp4"), True),
             ("自分の動画・--own あり", str(mine), True)]
    for label, path, own in cases:
        try:
            check_input(path, own)
            print(f"通過 : {label}")
        except ExportError as e:
            print(f"拒否 : {label} → {str(e)[:12]}")
```

```text
# 出力
拒否 : 自分の動画・--own なし → 動画を切り出して作るのは
拒否 : YouTube の URL → 動画の URL は受け付
拒否 : 短縮 URL → 動画の URL は受け付
拒否 : 存在しないファイル → 動画ファイルがありません
通過 : 自分の動画・--own あり
```

## 3. 時刻の計算(純粋な関数)

動画の外に出る副作用(ffmpeg の実行)を**薄い外側**に置き、時刻と書式の計算は**純粋な関数**にします(第 1 回)。テストが速く、確実です。

### 3.1 ショートの長さに収める

```python
# 引用: engine/src/chapterlens/export.py::fit_spans
def fit_spans(spans: list[dict], max_s: float) -> list[dict]:
    """合計が max_s 以内になるよう、点の高い区間から選ぶ(最後に入りきらないものは、短く切って入れる)。時間順に返す。"""
    chosen: list[dict] = []
    left = max_s
    for s in sorted(spans, key=lambda s: (-s.get("score", 0.0), s["start_s"])):
        length = s["end_s"] - s["start_s"]
        if left < 3.0:
            break
        if length <= left:
            chosen.append(dict(s))
            left -= length
        else:  # 入りきらない: 頭から left 秒だけ(3 秒以上残っているときだけ)
            chosen.append({**s, "end_s": round(s["start_s"] + left, 3)})
            left = 0
    return sorted(chosen, key=lambda s: s["start_s"])
```

点の高い区間から入れ、入りきらない最後は**頭から必要な分だけ**切って入れます(3 秒未満の端は使わない)。時間順に返します。

### 3.2 字幕を、つないだ動画の時間に詰め直す

区間をつなぐと、2 つ目の区間は、元の動画の 120 秒でなく、**出力の動画の 10 秒**から始まります。字幕も同じだけ**ずらし**ます。

```python
# 引用: engine/src/chapterlens/export.py::retime_cues
def retime_cues(cues: list[Cue], spans: list[dict]) -> list[Cue]:
    """区間をつないだ動画の時間に、字幕を詰め直す(区間の外の字幕は捨てる。区間にまたがる字幕は切る)。"""
    out: list[Cue] = []
    offset = 0.0
    for s in spans:
        lo, hi = s["start_s"], s["end_s"]
        for c in cues:
            a, b = max(c.start_s, lo), min(c.end_s, hi)
            if b - a > 0.05 and c.text.strip():
                out.append(Cue(round(offset + (a - lo), 3), round(offset + (b - lo), 3), c.text.strip()))
        offset += hi - lo
    return out
```

```python
# 実行できる
from chapterlens.captions import Cue
from chapterlens.export import retime_cues, to_srt, to_vtt

cues = [Cue(0, 10, "導入です"), Cue(8, 14, "ここから本題"), Cue(20, 25, "別の話"), Cue(120, 126, "ダイジェストの 2 つ目")]
spans = [{"start_s": 5, "end_s": 12}, {"start_s": 120, "end_s": 130}]      # 7 秒 + 10 秒 = 17 秒の動画になる
cut = retime_cues(cues, spans)
for c in cut:
    print(f"{c.start_s:5.1f} → {c.end_s:5.1f}  {c.text}")
print(to_srt(cut[:1]))
print(to_vtt(cut[:1]))
```

```text
# 出力
  0.0 →   5.0  導入です
  3.0 →   7.0  ここから本題
  7.0 →  13.0  ダイジェストの 2 つ目
1
00:00:00,000 --> 00:00:05,000
導入です

WEBVTT

00:00:00.000 --> 00:00:05.000
導入です
```

- 区間にまたがる字幕は**切られ**、区間の外の字幕は捨てられます。
- SRT は `00:00:00,000`(カンマ)、VTT は `00:00:00.000`(ピリオド)と、**小数点の記号が違う**。

## 4. EDL

**EDL**(Edit Decision List)は、「元のどの時刻から、どの時刻までを、出力のどこへ置くか」の表です。編集ソフトが読めます。

```python
# 実行できる
from chapterlens.export import spans_to_edl, timecode

print(timecode(61.5, 30), timecode(3600, 24))
print(spans_to_edl([{"start_s": 10, "end_s": 20}, {"start_s": 100, "end_s": 105.5}], fps=30, clip_name="talk.mp4"))
```

```text
# 出力
00:01:01:15 01:00:00:00
TITLE: ChapterLens digest
FCM: NON-DROP FRAME

001  AX       AA/V  C        00:00:10:00 00:00:20:00 00:00:00:00 00:00:10:00
* FROM CLIP NAME: talk.mp4
002  AX       AA/V  C        00:01:40:00 00:01:45:15 00:00:10:00 00:00:15:15
* FROM CLIP NAME: talk.mp4
```

- `hh:mm:ss:ff` の `ff` は**フレーム番号**(`fps` が 30 なら 0〜29)。整数の fps だけ対応(29.97 のドロップフレームは非対応)。
- 出力側(右の 2 つ)は**連続**: 1 つ目が 0〜10 秒、2 つ目が 10〜15.5 秒。

## 5. ffmpeg の `filter_complex`

区間を**切り出して(`trim`)→ つないで(`concat`)→ 中央を縦に切り抜いて(`crop`)→ 拡縮し(`scale`)→ 字幕を焼く(`subtitles`)**、1 本のフィルタの文字列で書きます。

```python
# 実行できる
from chapterlens.export import build_filter

flt, labels = build_filter([{"start_s": 10, "end_s": 20}, {"start_s": 60, "end_s": 70}],
                           has_audio=True, vertical=True, subtitles="subs.srt")
for part in flt.split(";"):
    print(part)
print("出力ラベル:", labels)
```

```text
# 出力
[0:v]trim=start=10.000:end=20.000,setpts=PTS-STARTPTS[v0]
[0:a]atrim=start=10.000:end=20.000,asetpts=PTS-STARTPTS[a0]
[0:v]trim=start=60.000:end=70.000,setpts=PTS-STARTPTS[v1]
[0:a]atrim=start=60.000:end=70.000,asetpts=PTS-STARTPTS[a1]
[v0][a0][v1][a1]concat=n=2:v=1:a=1[vcat][aout]
[vcat]crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',scale=1080:1920:flags=lanczos,setsar=1,subtitles=subs.srt:force_style='Fontsize=14,Outline=2,Shadow=0,MarginV=72,Alignment=2'[vout]
出力ラベル: ['[vout]', '[aout]']
```

- 各区間を `[0:v]trim=…,setpts=PTS-STARTPTS[v0]` で切り、**時刻を 0 から振り直す**(`setpts`)。音声も `atrim`・`asetpts`。
- `concat=n=2:v=1:a=1` で、映像と音声を**組にして**つなぐ。
- 縦への切り抜きは `crop='min(iw,ih*9/16)':'min(ih,iw*16/9)'`(横長なら高さに合わせて、幅を 9:16 に)。
- 字幕は `subtitles=subs.srt`。**ファイル名は、`ffmpeg` を実行するフォルダ内の単純な名前**にします(Windows のパスにある `:` や `\` を、フィルタの文字列でエスケープしなくて済む)。**使える文字を制限**して(`[A-Za-z0-9_.-]+`)、注入を防ぎます。

## 6. 外部プログラムを安全に呼ぶ

```python
# 抜粋: engine/src/chapterlens/export.py::_run
def _run(args: list[str], *, timeout_s: int, cwd: str | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout_s)
```

- **引数は文字列のリスト**で渡す(`shell=True` で 1 本の文字列にしない)。ファイル名に空白・`;`・`&` があっても、**別のコマンドとして解釈されない**。
- **時間切れ**(`timeout`)を付け、止まったら `ExportError` で説明つきに失敗する。
- 出力は `encoding="utf-8", errors="replace"`(Windows の既定の文字コードで、日本語の出力が読めずに落ちるのを防ぐ)。

## 確認問題

1. `--own` を付けずに `export short` を実行すると、何が起きますか。ffmpeg は呼ばれますか。
2. 2 つ目の区間が元の動画の 120〜130 秒のとき、出力の動画の何秒目に置かれますか(1 つ目が 7 秒)。
3. SRT と VTT の、時刻の書式の違いは。
4. 字幕のファイル名を `subs.srt` のような単純な名前に限る理由を 2 つ挙げてください。
5. `shell=True` を使わないのは、なぜですか。

## 解答

1. エラー(「`--own` を付けて…」)で止まり、ffmpeg は**呼ばれない**(出力ファイルも作られない)。テストで確認済み。
2. 7 秒目から 17 秒目(`offset` は、前の区間の長さの合計)。
3. SRT は `,`(カンマ)、VTT は `.`(ピリオド)。VTT は先頭に `WEBVTT` の行が付く。
4. パスの `:`・`\` のエスケープを避けるため。ファイル名を通じて、フィルタに**別の指示を注入**されないため。
5. ファイル名や引数に含まれる記号が、シェルに**別のコマンドとして解釈される**(コマンド注入)のを防ぐため。

## まとめ

- 書き出しは、**自分の動画だけ**。権利の方針を、`--own`・URL 拒否・CLI だけ・上書き拒否の**コードで強制**する。
- 時刻と書式は純粋な関数(速くテストできる)。ffmpeg の実行だけが外側の副作用。
- EDL は「元の時刻 → 出力の位置」の表。字幕は、つないだ動画の時間に詰め直す。
- 外部プログラムは、引数のリスト・時間切れ・文字コードを明示して呼ぶ。
- 次の回は、テストの戦略。
