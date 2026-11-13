# ChapterLens engine

字幕(または音声の認識結果)から**話題の切り替えを検出**し、**投稿者のチャプターを正解にして精度を測る**、Python のエンジン。
標準ライブラリだけで動く(音声認識だけ、任意の依存 `faster-whisper`)。設計は [設計書](../ChapterLens_DESIGN.md)、全体は [README](../README.md)。

![エンジンのモジュールの層](../docs/diagrams/engine-modules.svg)

## できること

| 機能 | コマンド / API | 詳細 |
|---|---|---|
| 字幕 → 区間データ(`segments@1`) | `detect` | 検出器 `topic-shift@2`(既定) |
| 検出の評価(基準との比較) | `eval` | [評価](../docs/reference/evaluation.md) |
| 音声 → 文字起こし → 区間 | `asr` `audio` | [機能と実測](../docs/reference/engine-features.md) |
| ローカルサーバー(拡張・CLI が呼ぶ) | `serve` | 127.0.0.1・token・Origin 検査 |
| 利用者・共有・監査ログの管理 | `admin ...` | サーバーを止めていても使える |
| ダイジェスト(重要区間) | `digest` `digest-eval` | 動画は切り出さない |
| ライブの再生・評価 | `live` `live-eval` | 暫定 → 確定 |
| 書き出し(自分の動画だけ) | `export edl\|chapters-edl\|subtitles\|video\|short` | `--own` が要る |

## クイックスタート

```bash
uv sync                                                        # 依存(標準ライブラリ中心)
uv run pytest -q                                               # テスト(339 件。うち 139 件は文書の検査)
uv run python -m chapterlens detect captions.vtt --out seg.json     # 字幕 → 区間データ
uv run python -m chapterlens detect captions.vtt --target-count 8   # 境界の数を指定(拡張の「粒度」と同じ)
uv run python -m chapterlens eval dataset/ --out results/2026-11-14 # 評価(検出器 vs 基準)
```

音声認識を使うとき(GPU があれば使う): `uv sync --extra asr`。

## サーバー

```bash
uv run python -m chapterlens serve --allow-origin chrome-extension://egcgicajchobpecnggcblcbnoadlnfai
```

- 待ち受けは **127.0.0.1 だけ**。呼び出しには token(`Authorization: Bearer`)が要る。管理者の token は `~/.chapterlens/token`(**他人に見せない**)。
- `Origin` が付く呼び出し(ブラウザ)は、`--allow-origin` で許可した Origin だけ。何も許可しなければ、ブラウザからは呼べない。
- 守りの全体は [講義 第 9 回](../docs/lecture/09-server-and-security.md)。

### API(すべて `/v1`)

| 経路 | 内容 | 権限 |
|---|---|---|
| `GET /health` | 状態・使える検出器 | 利用者 |
| `POST /detect` | 字幕 → 区間データ | 利用者 |
| `POST /transcribe` | 音声(WAV 等)→ 字幕(`?language=ja&model=small&words=1`) | 利用者 |
| `POST /live` `POST /live/close` | ライブの字幕を足す → 暫定・確定の印 | 利用者 |
| `POST/GET /corrections` `POST /corrections/undo` | 境界の修正の保存(利用者ごと) | 利用者 |
| `GET /me` `POST /me/forget` | 自分の情報 / 自分のデータを全部消す | 利用者 |
| `POST/GET /shares` `POST /shares/revoke` | 区間データの共有(許可つき) | 利用者 |
| `GET/POST /admin/users` `POST /admin/users/<id>/{disable\|enable\|rotate\|purge\|role}` | 利用者の管理 | **管理者** |
| `GET/POST /admin/settings` `GET /admin/audit` | 共有範囲・監査ログ | **管理者** |

- **認可はサーバー側**: 役割は token から引く。ヘッダ・本文・クエリでの「管理者です」という申告は無視する。
- レート制限: 利用者ごと・経路の種類ごと(通常 240 回/分・音声 30 回/分・管理 60 回/分)。超えると `429` と `Retry-After`。
- 入力は検証する(型・長さ・上限)。共有は**区間データだけ**を受け付け、字幕・音声は拒否する。

## 管理(CLI)

```bash
uv run python -m chapterlens admin add-user alice      # 利用者を追加(token は 1 度だけ表示。本人にだけ渡す)
uv run python -m chapterlens admin users               # 一覧
uv run python -m chapterlens admin share-mode team     # 共有範囲(off=既定 / team / named)
uv run python -m chapterlens admin disable|enable|rotate <ID>
uv run python -m chapterlens admin purge <ID> --yes    # 利用者と、その修正・共有を完全に消す
uv run python -m chapterlens admin audit -n 50         # 監査ログの末尾
```

## 書き出し(自分の動画だけ)

```bash
uv run python -m chapterlens export edl captions.vtt --clip-name talk.mp4 --out digest.edl
uv run python -m chapterlens export short talk.mp4 captions.vtt --own --out short.mp4   # 縦 1080x1920・字幕を焼き込み
```

動画を触る `video` / `short` は、**`--own`(自分の動画・許諾済みの素材)が無いと動かない**。入力はこの PC のファイルだけ(URL は拒否)。CLI だけで、HTTP・拡張には出していない。要 `ffmpeg`。

## 実測の要約

| 項目 | 結果 | 出どころ |
|---|---|---|
| 検出(未見の 19 本・自動) | F1(±10 秒)0.165(基準 0.121) | [評価](../docs/reference/evaluation.md) |
| 検出(39 本の交差検証) | 0.238(基準 0.092) | 同上 |
| 音声認識(合成音声)の発話の頭のずれ | 中央値 0.04〜0.12 秒 | [機能と実測](../docs/reference/engine-features.md) |
| ライブ(39 本の再生) | 暫定 9.0 秒・確定 27.0 秒・置き直しのずれ 0.0 秒(中央値) | 同上 |

**現実的な目安は F1 0.17〜0.24(基準の約 1.4〜2.6 倍)。会話系(対談・ポッドキャスト)は弱い**。章は「候補」で、位置は数秒〜十数秒ずれうる。

## 注意

- 既定値(`V2_PARAMS`・`LiveParams` など)は**測って決めた仮の値**。実データで決め直す。
- テストの合成データ(`tests/synth.py`)は、話題ごとに語彙が完全に違う理想的な条件。**精度の証拠ではなく、配線の確認**。
- 評価データ(`dataset/`)は他人の動画の字幕。**git に入れない・公開しない**(設計書 §2)。
- 認証は token だけで、失敗回数での締め出しは無い(256 ビットの乱数)。ファイルの権限(0600)は Windows で効かないので、ホーム(`~/.chapterlens`)を他のユーザーに読ませない運用が前提。

## もっと知る

- 基礎から: [講義資料](../docs/lecture/index.md)(全 15 回)
- 保守・拡張: [学習資料](../docs/learn/index.md)(コードの読み方・レシピ・トラブルシュート)
- 詳細な実測: [engine-features](../docs/reference/engine-features.md)・[評価](../docs/reference/evaluation.md)
