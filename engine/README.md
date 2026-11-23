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
| 記憶へ(DevRAG の任意の namespace) | `rag-export` | 題名・時刻だけ。**既定はプレビュー**、`--send` で送る。鍵は環境変数 |
| 題名・大見出し(ローカル LLM) | `POST /v1/title`・`POST /v1/sections`・`admin llm on\|off` | 既定は**無効**。窓口(LocalLLMHarness)は loopback だけ。下の「題名・大見出し」 |

## クイックスタート

```bash
uv sync                                                        # 依存(標準ライブラリ中心)
uv run pytest -q                                               # テスト(439 件が通り、3 件は環境によりスキップ。うち 148 件は文書の検査)
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
| `GET/POST /admin/settings` `GET /admin/audit` | 共有範囲・題名付けの有効化(`llm_enabled`)・監査ログ | **管理者** |
| `POST /title` `POST /sections` | 章の題名・大見出しをローカル LLM で付ける(無効のとき 403・窓口が落ちているとき 502) | 利用者(有効にするのは管理者) |

- **認可はサーバー側**: 役割は token から引く。ヘッダ・本文・クエリでの「管理者です」という申告は無視する。
- レート制限: 利用者ごと・経路の種類ごと(通常 240 回/分・音声 30 回/分・管理 60 回/分・題名付け 600 回/10 分)。超えると `429` と `Retry-After`。
- 入力は検証する(型・長さ・上限)。共有は**区間データだけ**を受け付け、字幕・音声は拒否する。

## 題名・大見出し(ローカル LLM)

章の題名を「何をしている場面か」が分かる 1 行にし(例: 魚を売る(6220ベル))、章を大見出しで束ねる。**境界は動かさない**。拡張の「題名を付ける(ローカル LLM)」が、章ごとに `POST /v1/title` を呼び、最後に `POST /v1/sections` を 1 回呼ぶ。

```bash
uv run python -m chapterlens admin llm on        # 有効にする(既定は無効。管理者だけ)
uv run python -m chapterlens admin llm           # いまの状態
# 窓口(LocalLLMHarness)を起動しておく: LocalLLMHarness で  uv run llh serve
```

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `CHAPTERLENS_LLM_URL` | `http://127.0.0.1:8800/v1` | 窓口。**loopback の http だけ**(それ以外は、送る前に断る) |
| `CHAPTERLENS_LLM_MODEL` | `llh-main` | 窓口のモデルの別名 |
| `CHAPTERLENS_LLM_TOKEN_ENV` | `LLH_TOKEN` | 窓口の token を入れた**環境変数の名前**(値は設定にも、ログにも、エラー文にも出さない) |
| `CHAPTERLENS_LLM_TIMEOUT_S` | `120` | 1 回の呼び出しの待ち時間 |

- **検証(作り話を使わない)**: 題名は 8〜24 文字・改行なし・**数字、カタカナ、英字の連なりが、その章の字幕に実在**すること。落ちたら理由を添えて 1 回だけ作り直し、それでもだめなら**題名なし(拡張が、規則の題名を残す)**。大見出しは、全章を過不足なく連続で覆い、2 区間以上で、1〜16 文字。落ちたら**見出しなし**。
- **数字は完全一致**: 題名の数字は、字幕の数字の連なりと**同じ数**でなければならない(部分一致や、離れた数字のつなぎ合わせは認めない)。**漢字の人名・地名・漢数字は検査していない**(カタカナ・英字の語だけ)。
- **プロキシは使わない・考える(thinking)モードは切る**: `HTTP_PROXY` などの設定があっても、窓口へ直接つなぐ(字幕と token を 127.0.0.1 の外へ出さない)。リクエストに `enable_thinking: false` を入れ、考える文が出力枠を使い切って本文が空になるのを防ぐ。
- **待ち時間**: 1 回の呼び出しは最大 120 秒(作り直しで 2 回)・順番待ちは最大 60 秒(超えたら 503)。拡張の中継は 300 秒まで待つ。窓口の応答は、400/401/403/404/503 を、それぞれ原因が分かる文にして返す(本文は含めない)。
- **字幕はデータとして区切って渡す**(`<<<`〜`>>>`。字幕の中の区切り記号は無害な文字に替える)。字幕中の指示には従わない。
- **文脈は 8K トークン・窓口は 1 件ずつ**: 1 章の字幕は先頭・中ほど・末尾から 4,000 文字に間引き、エンジンも 1 度に 1 つだけ呼ぶ。章が多いと、分単位かかる(`tools/measure_titles.py` で測る。結果は [docs/reference/titles-measurement.md](../docs/reference/titles-measurement.md))。
- **監査ログ**: 操作名・章数・モデル名・秒数・検証に落ちた回数だけ。**字幕・題名・動画 ID は残さない**。
- 字幕の本文が行く先は、この PC のエンジンと窓口だけ(どちらも 127.0.0.1)。外部へは出ない。

## 管理(CLI)

```bash
uv run python -m chapterlens admin add-user alice      # 利用者を追加(token は 1 度だけ表示。本人にだけ渡す)
uv run python -m chapterlens admin users               # 一覧
uv run python -m chapterlens admin share-mode team     # 共有範囲(off=既定 / team / named)
uv run python -m chapterlens admin llm on              # 題名付け(ローカル LLM)を有効にする(既定は無効)
uv run python -m chapterlens admin disable|enable|rotate <ID>
uv run python -m chapterlens admin purge <ID> --yes    # 利用者と、その修正・共有を完全に消す
uv run python -m chapterlens admin audit -n 50         # 監査ログの末尾
```

## 書き出し(自分の動画だけ)

```bash
uv run python -m chapterlens export edl captions.vtt --clip-name talk.mp4 --out digest.edl
uv run python -m chapterlens export short talk.mp4 captions.vtt --own --out short.mp4   # 縦 1080x1920・字幕を焼き込み

# 区間データの題名・時刻だけを、DevRAG(RAG Chat の記憶)へ。まずプレビュー(送らない)
uv run python -m chapterlens rag-export segments.json --namespace shared:video-notes --label talk-2026-11
# 送る(鍵は環境変数。URL は https か、この PC の http://127.0.0.1 だけ)
$env:CHAPTERLENS_RAG_KEY = "<DevRAG の API キー>"
uv run python -m chapterlens rag-export segments.json --namespace shared:video-notes --label talk-2026-11 --send --url https://<あなたの Worker>
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
