# ChapterLens engine(CH0)

字幕だけで話題の切り替えを検出し、**投稿者のチャプターを正解にして精度を測る**ための土台。設計は [../ChapterLens_DESIGN.md](../ChapterLens_DESIGN.md)。
**状態**: CH0(評価・検出器)は完了。**CH2 のエンジン側(ローカル ASR・修正の保存・HTTP サーバー)を実装**(2026-11-12。下の「CH2」)。テスト 90 件+実機 ASR の統合テスト 2 件。既定の検出器は `topic-shift@2`。標準ライブラリだけで動く(依存なし)。

## 使い方
```bash
uv sync
uv run pytest -q                                              # テスト
uv run python -m chapterlens detect captions.vtt --out seg.json   # 字幕 → 区間データ(chapterlens/segments@1)
uv run python -m chapterlens detect captions.vtt --target-count 8  # 境界の数を指定
uv run python -m chapterlens chapters description.txt --out chapters.json   # 概要欄 → 正解
uv run python -m chapterlens eval dataset/ --out results/2026-11-12         # 評価(検出器 vs 基準)
```

## CH2: ローカルエンジン(音声認識・修正の保存・サーバー)
```bash
uv sync --extra asr                                         # faster-whisper を入れる(任意の依存)
uv run python -m chapterlens asr talk.wav --language ja --out talk.json    # 文字起こし(単語ごとの時刻つき)
uv run python -m chapterlens audio talk.wav --out segments.json            # 音声 → ASR → 検出 → 発話の頭へ寄せる → 区間データ
uv run --extra asr python -m chapterlens serve --allow-origin chrome-extension://<拡張の ID>   # HTTP サーバー(127.0.0.1:8787)
```
- **ASR**: faster-whisper(HuggingFace のローカルキャッシュの重みを使い、ネットワークに出ない)。GPU があれば使い、無ければ CPU(ただし CPU は実時間より遅い)。音声の読み込みは ffmpeg(WAV 16kHz モノラルは不要)。cuBLAS 12・cuDNN 9 の DLL は、CUDA 版 PyTorch が同梱するものを自動で探す(`CHAPTERLENS_CUDA_LIB_DIR` で指定もできる)。
- **単語の時刻で境界を寄せる**(`snap_to_utterances`): 検出した境界を、近く(±5 秒)の「発話の頭」(直前に 0.35 秒以上の間がある単語)へ動かす。
- **修正の保存**(`corrections.py`): move / add / delete を SQLite に積む。元の検出は書き換えず、結果にだけ適用する。owner ごとに分ける(S-F)。`to_reference` で、評価データの `chapters.json` の形にできる(「直された動画を評価セットへ」)。
- **サーバー**(`server.py`・標準ライブラリだけ): `/v1/health`・`/v1/detect`・`/v1/transcribe`・`/v1/corrections`。**守り**: 127.0.0.1 だけ・全呼び出しに token(Bearer。`~/.chapterlens/token`)・Host は 127.0.0.1/localhost だけ(DNS リバインディング対策)・ブラウザの Origin は `--allow-origin` で許可したものだけ・本文のサイズ上限(JSON 8MB・音声 300MB)・入力の検証・監査ログ(`~/.chapterlens/audit.log`。時刻・経路・結果・所要時間だけで、本文・音声・token は残さない)。
- **設計書との違い**: 設計書は Native Messaging を第一候補にしていたが、CLI・他のツールからも同じ入口で呼べるよう、まず「localhost + token + Origin 検査」で作った。CH2b(拡張のタブ音声の取り込み)も、この localhost + token + Origin 検査の入口をそのまま使う(拡張の ID は固定で、`--allow-origin chrome-extension://egcgicajchobpecnggcblcbnoadlnfai`。手順は [../extension/README.md](../extension/README.md) の「音声から作る」)。Native Messaging は採らなかった。

### 実測(合成音声。Windows の音声合成で作った、正解の時刻が分かる音声)
| | 英語(222 秒) | 日本語(212 秒) |
|---|---|---|
| 処理時間(RTX 3070・small・float16) | 9.9 秒 | 7.7 秒 |
| リアルタイム比 | 0.04(実時間の約 25 倍速) | 0.04 |
| 発話の始まりの時刻のずれ(絶対値の中央値 / 最大) | **0.12 秒 / 0.27 秒** | **0.04 秒 / 0.16 秒** |
- 設計 CH2 の基準(中央値 1.0 秒以内・仮)を、大きく下回る。CH0 の字幕(1 秒刻み・数秒のかたまり)の ±3 秒の F1 が 0.1 前後だった部分を、ここで伸ばせる見込み。
- **正直な限界**: ①音声は**合成音声**(静かで明瞭)。実際の動画(BGM・複数人・雑音)の精度ではない。②他人の動画の音声は、方針(設計書 §2)により取得しないので、**実データでの ±3 秒の F1 は測れていない**。自分の動画・許諾済みの素材でないと測れない。③検出器 v2 の最小間隔(60 秒)は、3 分半の短い音声には長すぎる(話題が 55 秒の合成音声では、境界が減る)。
- テスト音声: `uv run python tools/make_tts_fixture.py all`(Windows)→ `results/tts/`。確認: `uv run --extra asr python tools/asr_check.py all`・`CHAPTERLENS_ASR_TESTS=1 uv run --extra asr pytest tests/test_asr_integration.py`。

## 評価データの置き方(`dataset/`。git に入れない・公開しない)
動画 1 本 = 1 フォルダ。**動画・音声は置かない**(字幕のテキストと正解の時刻だけ)。
```
dataset/<id>/meta.json       {"id": "...", "language": "ja", "duration_s": 3612.4, "title": "..."}
dataset/<id>/captions.vtt    字幕(.vtt / .srt / .json3)
dataset/<id>/chapters.json   {"chapters": [{"start_s": 0, "title": "導入"}, ...]}   または description.txt(概要欄の本文)
```
- チャプターは **先頭が 0:00・3 つ以上・昇順**のものだけが正解になる(YouTube の規則)。使えない動画は、理由つきでレポートに出る。
- 設計の目標は **20 本**(講義・チュートリアル中心、日本語と英語の両方)。

## 何を比べるか
| 系 | 中身 |
|---|---|
| `fixed-300` | 300 秒ごと(字幕を見ない) |
| `uniform-k` | 正解と同じ区間数で等間隔(区間数を教えてもらう分、強い基準) |
| `topic-shift@1` | 検出器の既定の感度 |
| `topic-shift@1+k` | 正解の区間数に合わせた感度(粒度を揃えて比べる) |

判定(設計 R2 ④): `+k` が `uniform-k` を、既定が `fixed-300` を、**±10 秒の macro F1** で上回るか。上回らなければ検出器の方針を見直す。

## 構成
- `captions.py` 字幕の読み込み(自動字幕のローリングの重複を除く)/ `chapters.py` 概要欄の正解
- `detectors/` 差し替え式の検出器(`register` で足す)。`topic_shift.py` が TextTiling 系の v1
- `metrics.py` 境界の F1(許容つき・1 対 1)・打刻のずれ・区間数の比 / `baselines.py` 基準
- `evaluation.py` データの読み込みと評価・判定・Markdown のレポート / `schema.py` 区間と意味のデータ
- `text.py` 軽い分かち書き(かな・漢字は 2 文字の組、英語は単語)

## 注意
- **`topic_shift.py` の `min_depth`(0.4)などの既定値は仮**。合成データで決めたもので、実データで決め直す。
- テストの合成データ(`tests/synth.py`)は話題ごとに語彙が完全に違う理想的な条件。**精度の証拠ではなく、配線の確認**。
- 評価データは他人の動画の字幕。**ローカルのみ・公開しない**(設計書 §2)。

## 評価の最新(2026-11-12・39 本・日本語 21 / 英語 18。**この節が最新。以降の節は途中経過**)
最初の 20 本(プログラミング入門が中心)で調整した v2 を、**調整に使っていない追加の 19 本**(対談・ポッドキャスト・ニュース・経済・物理・講演など)で評価した。

| 条件(F1 ±10s) | topic-shift@2 | 基準 uniform-k |
|---|---|---|
| 未見の 19 本・自動(free) | **0.165** | 0.121 |
| 未見の 19 本・区間数を教える | 0.182 | 0.121 |
| 39 本の交差検証(5 分割・各 fold で再調整)・自動 | **0.238** | 0.092 |
| 39 本の交差検証・区間数を長さから見積もる(prior) | 0.241 | 0.092 |

- **前の確認用 0.28 は楽観的だった**。題材がプログラミング入門に偏っていたため。**現実的には 0.17〜0.24(題材による)で、基準の約 2 倍**。対談・ポッドキャストは特に弱い(会話は語彙の切り替えが弱い)。
- 交差検証で選び直しても v2(0.249。調整に使った分を含む)と大差ない(0.238)。**v2 の設定は安定**しているので、既定は変えない。
- **区間数のずれが大きい**: 長いポッドキャストで 23〜30 個に分けすぎ(正解は 6〜8)、チャプターが 71 個の動画では 5 個。投稿者のチャプターの数は 6〜70 とばらつくので、「長さ ÷ 220 秒」の見積もりは当たらない。**粒度は利用者が選ぶ(粗い・標準・細かい)形にするのが妥当**。
- 評価データの除外: チャプターが規則(先頭 0:00・昇順)に合わない動画 1 本。

## 以前の評価(2026-11-12・20 本・日本語 10 / 英語 10。途中経過)
動画を言語ごとに id 順に並べ、偶数番目を**調整用**・奇数番目を**確認用**にした(`tools/tune.py`)。確認用は、パラメータを選んだ後に見ている。

| 検出器 | モード | 調整用 F1@10s | **確認用 F1@10s** | 確認用 F1@3s |
|---|---|---|---|---|
| topic-shift@1(最初の既定) | free(区間数を知らない) | 0.100 | 0.110 | 0.036 |
| topic-shift@1 | prior(長さ ÷ 220s で見積もる) | 0.273 | 0.235 | 0.106 |
| **topic-shift@2(調整後の既定)** | free | 0.380 | **0.279** | 0.101 |
| topic-shift@2 | prior | 0.373 | 0.274 | 0.110 |
| topic-shift@2 | 正解の区間数(上限の目安) | 0.371 | 0.309 | 0.118 |
| 基準 uniform-k / fixed-300(全 20 本) | | | 0.065 / 0.064 | |

- **効果**: 既定の感度で、確認用 F1@10s が 0.110 → 0.279。調整用との差(0.38 対 0.28)は過学習の分。確認用は 10 本なので、数値のぶれは大きい。
- **効いたもの**: ①窓を 60〜80 秒に広げる(最小間隔 60 秒・`min_depth` 0.1)②**境界の置き直し**(粗い窓で選んだ境界を、±10 秒・窓 45 秒の字幕単位の比較で決め直す)。
- **診断**: 許容を広げると F1 が大きく上がる(旧版・±10s 0.31 / ±30s 0.48 / ±60s 0.56)。**場所は当たっていて、位置が 10〜30 秒ずれる**のが主因。正解の境界の近くには、深い谷がある(上位 10% 以内が 53%)。
- **埋め込み(multilingual-e5-large)は採用しなかった**: 確認用で語彙と差が出ない(free: 語彙 0.243 / 埋め込み 0.206 / 混合 0.237。置き直し後は混合 0.305 / 語彙 0.284)。10 本では誤差の範囲で、重い依存に見合う改善が示せなかった。`tools/embed_curves.py`(DevelopmentRAGEnvironment の .venv とローカルのキャッシュで曲線を作る)は残してある。
- **±3 秒の F1 は 0.1 前後で低いまま**: このデータの時刻は 1 秒刻みで、字幕は数秒のかたまり。**ここを伸ばすには、ASR の単語ごとの時刻(CH2)が要る**。字幕の「間」も、パネルの文字起こしには無い(開始時刻しか持たない)。
- 偏り: 題材は**プログラミング入門が中心**。結果は「この種類の動画」の数字。
- 集め方: ブラウザの「文字起こし」パネル。スクリプトでの直接取得は、サイト側に止められた。詳細はメモリ `project-chapterlens-2026-11-12`。

## 次にやること(CH0 の残り)
1. ~~評価データ 20 本~~・~~パラメータ調整~~(済)。
2. **評価データを増やす**: 確認用が 10 本では、改善の判断にぶれが大きい。題材も広げる(講義・雑談・実況)。
3. **位置の精度(±3 秒)は CH2 で**: ASR の単語ごとの時刻(キャッシュに faster-whisper-small がある)で、境界を発話の頭に合わせる。
4. 検出器の見直しは、評価で効果を測ってから(文の埋め込み・語の手がかり「では次は」など)。
