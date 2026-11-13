# エンジンの機能と実測(CH2〜CH6)

[エンジンの README](../../engine/README.md) から移した、段階ごとの詳細と実測です(内容は、移す前と同じ)。
仕組みの説明は [講義資料](../lecture/index.md)・[学習資料](../learn/index.md) にあります。

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
- **設計書との違い**: 設計書は Native Messaging を第一候補にしていたが、CLI・他のツールからも同じ入口で呼べるよう、まず「localhost + token + Origin 検査」で作った。CH2b(拡張のタブ音声の取り込み)も、この localhost + token + Origin 検査の入口をそのまま使う(拡張の ID は固定で、`--allow-origin chrome-extension://egcgicajchobpecnggcblcbnoadlnfai`。手順は [extension/README.md](../../extension/README.md) の「音声から作る」)。Native Messaging は採らなかった。

### 実測(合成音声。Windows の音声合成で作った、正解の時刻が分かる音声)
| | 英語(222 秒) | 日本語(212 秒) |
|---|---|---|
| 処理時間(RTX 3070・small・float16) | 9.9 秒 | 7.7 秒 |
| リアルタイム比 | 0.04(実時間の約 25 倍速) | 0.04 |
| 発話の始まりの時刻のずれ(絶対値の中央値 / 最大) | **0.12 秒 / 0.27 秒** | **0.04 秒 / 0.16 秒** |
- 設計 CH2 の基準(中央値 1.0 秒以内・仮)を、大きく下回る。CH0 の字幕(1 秒刻み・数秒のかたまり)の ±3 秒の F1 が 0.1 前後だった部分を、ここで伸ばせる見込み。
- **正直な限界**: ①音声は**合成音声**(静かで明瞭)。実際の動画(BGM・複数人・雑音)の精度ではない。②他人の動画の音声は、方針(設計書 §2)により取得しないので、**実データでの ±3 秒の F1 は測れていない**。自分の動画・許諾済みの素材でないと測れない。③検出器 v2 の最小間隔(60 秒)は、3 分半の短い音声には長すぎる(話題が 55 秒の合成音声では、境界が減る)。
- テスト音声: `uv run python tools/make_tts_fixture.py all`(Windows)→ `results/tts/`。確認: `uv run --extra asr python tools/asr_check.py all`・`CHAPTERLENS_ASR_TESTS=1 uv run --extra asr pytest tests/test_asr_integration.py`。

## CH3: 少人数での利用(利用者・管理者・共有・監査ログ)
```bash
uv run python -m chapterlens admin add-user alice          # 利用者を追加(token は 1 度だけ表示。本人にだけ渡す)
uv run python -m chapterlens admin users                   # 一覧
uv run python -m chapterlens admin share-mode team         # 共有範囲(off=既定 / team / named)
uv run python -m chapterlens admin disable|enable|rotate <ID>   # 停止 / 再開 / token の再発行
uv run python -m chapterlens admin purge <ID> --yes        # 利用者と、その修正・共有を完全に消す
uv run python -m chapterlens admin audit -n 50             # 監査ログの末尾
```
`admin` は、この PC のファイルを触れる人(=管理者)用で、サーバーを止めていても使える。サーバー稼働中に追加した利用者も、再起動なしで使える(認証のたびにデータベースを見る)。

- **役割**: `user`(自分のデータだけ)と `admin`(利用者・共有範囲・監査ログ)。**認可はエンジンの側**で、token から引いた役割だけを見る(S-A。ヘッダ・本文・クエリで「管理者です」と名乗っても無視)。既存の `~/.chapterlens/token` の token は、そのまま管理者 `local`。`local` は、停止・削除・役割変更ができない(管理者が誰もいなくなる事故を防ぐ。token ファイルを消せば作り直せる)
- **token(S-B)**: 利用者ごとに 256 ビットの乱数。**保存するのはハッシュ(SHA-256)だけ**で、作った時に 1 度だけ表示する。不明な token も停止中の利用者も、同じ `401`(区別させない)
- **分離(S-F)**: 修正は利用者ごと。管理者でも、API では他人の修正は見えない。本人は `POST /v1/me/forget` で、自分の修正・共有を全部消せる
- **共有は許可つき**: ①管理者が共有範囲を決める(`off`=既定・誰も共有できない / `team` / `named`)②利用者が、動画ごとに明示して公開する(`audience`: `"team"` か、指定した利用者の ID)③相手に見えるのは、自分に向けて公開されたものだけ。停止された利用者のものは見えない。いつでも取り下げられる(共有範囲が `off` でも)。**共有するのは区間データだけ**(境界の秒・長さ・60 文字までの題名)。字幕・音声・動画は共有できず、余計な項目を付けると拒否する
- **監査ログ(S-C)**: 経路ごとの記録(時刻・利用者 ID・役割・結果・所要時間)に加え、**管理操作・共有・設定変更・「忘れる」**を操作名つきで残す。**token・字幕・題名・動画 ID は残さない**(動画は同じものと分かる短い印だけ)。5MB で 1 世代だけ回す
- **レート制限(S-D)**: 利用者ごと・経路の種類ごと(通常 240 回/分・音声 30 回/分・管理 60 回/分)。超えると `429` と `Retry-After`。認証に失敗した呼び出しは、他の人の枠を減らさない
- **API**: `GET /v1/me`・`POST /v1/me/forget`(ライブのセッションも消す)・`POST /v1/live`・`POST /v1/live/close`(CH5)・`POST/GET /v1/shares`・`POST /v1/shares/revoke`。管理者だけ: `GET/POST /v1/admin/users`・`POST /v1/admin/users/<id>/{disable|enable|rotate|purge|role}`・`GET/POST /v1/admin/settings`・`GET /v1/admin/audit`
- **限界(正直に)**: ①拡張の共有・管理の画面は CH3b で作った(拡張の README)。②認証は token だけ(パスワード・OAuth ではない)。token の総当たりは、256 ビットなので現実的でないが、失敗回数での締め出しは無い。③ファイルの権限(0600)は、Windows では効かない(ホーム `~/.chapterlens` を、他のユーザーに読ませない運用が前提)。④「よく直される箇所の統計」(設計書 §9 ③)は、共有の使われ方を見てから(機能の膨張を避けるため、まだ作っていない)。⑤開発者の機能(評価・生ログ)は、HTTP には出していない(CLI だけ=既定で無効)

## CH4: ダイジェスト(重要な区間を選ぶ。動画は切り出さない)
```bash
uv run python -m chapterlens digest captions.vtt --ratio 0.2 --out digest.json   # 重要な区間のリスト(飛ぶための時刻だけ)
uv run python -m chapterlens digest-eval dataset/                                # 利用者が調整した区間(各動画の digest.json)との一致
```
- **手順**(`digest.py`・`digest@1`): 字幕を 15 秒のかたまりに分け、①情報量(語の重み TF-IDF の合計)②代表性(同じ章の「他のかたまり」との重なり)③導入(章の最初に加点)で採点 → 各章の最高点を 1 つずつ → 点の高い順に予算(長さの 20%)まで → 1 つ空いたすき間を埋めて連続を 1 区間にまとめる。区間の始まり・終わりは発話の頭・終わりに合わせる。**字幕の言葉だけを見る**(音量・映像・笑い声は見ない)
- **拡張にも同じ手順の JavaScript 版**(`core.js`)がある。合成 10 通り+**実データ 39 本で、Python 版と区間が完全に一致**。
- **「重要」の正解は人によって違い、評価データには無い**。だから設計書の完了基準どおり「利用者の修正で評価できる」形にした: 拡張で区間を外す・足すと、自動案との一致率(時間の重なりの F1)が出る。`digest-eval` は、各動画に `digest.json`(`{"spans":[{"start_s":..,"end_s":..}]}`)を置くと、自動案との適合率・再現率・F1 を測る。**人の判断との一致は、まだ測っていない**(利用者が調整した区間が無い)
- 実データ 39 本での性質: 予算 20% に対し、実際の長さは 22〜29%(中央値 25%。すき間埋めと発話の端で増える)。選ばれるのは「この動画では〜」「要点は〜」「まとめると〜」のような箇所(目視で確認)。3 時間・章なしの動画でも 5 秒以内(テスト)

## CH5: ライブ(暫定の印 → 確定)
```bash
uv run python -m chapterlens live captions.vtt           # 字幕を時間順に流し込んで、暫定・確定の印を見る
uv run python -m chapterlens live-eval dataset/ --out results/live   # 遅れとずれを測る
```
- **HTTP**: `POST /v1/live {session?, cues, now_s?}` → `{session, now_s, markers:[{t, status:"tentative"|"committed", score}]}`・`POST /v1/live/close`。字幕を足すたびに印が返る。セッションはメモリだけ(保存しない)。利用者ごとに同時 4 つまで・2 時間使わなければ消える・1 回 500 個まで・1 セッション 20000 個まで・字幕の密度(20 秒に 40 個)に上限。他の利用者のセッションは見えない・足せない。監査ログには「始めた」だけ(字幕は残さない)
- **手順**(`live.py`): バッチの検出器は境界の後ろ 80 秒を使うので、ライブでは 2 段にした。①**暫定**: 候補の後ろに 8 秒ぶん溜まった時点で、前の 60 秒との類似度(TF-IDF のコサイン)が 0.10 以下なら印を打つ(一度に 1 つだけ)②**確定**: 後ろに 24 秒ぶん溜まったら、前後 ±10 秒で位置を「変化の始まり」へ置き直し、後ろの話も前と違う(0.16 以下)なら確定。違わなければ取り下げ(脱線)。**時刻は変化の始まりに戻して付く**(確定が遅れても打刻は遅れない)
- **実測**(評価データ 39 本の字幕を時間順に流し込み。変化の時刻は、投稿者のチャプターの ±30 秒以内に対応づいたものだけ):

| 指標 | 件数 | 中央値 | 90 パーセンタイル | 目標(仮) |
|---|---:|---:|---:|---|
| 暫定の印が出るまで(変化から) | 272 | **9.0 秒** | 16.9 秒 | 10 秒以内 |
| 確定するまで(変化から) | 272 | **27.0 秒** | 33.9 秒 | 30 秒以内 |
| 確定での置き直しのずれ | 873 | **0.0 秒** | 7.0 秒 | CH2 以内(中央値 1.0 秒) |

  F1(投稿者のチャプターとの一致): ライブ(確定のみ)±10s 0.218 / ±30s 0.411。同じ物差しのバッチ(動画全体を見る)は 0.246 / 0.392。**「確定後のずれ」は中央値 0 秒だが、90 パーセンタイルは 7 秒**。取り下げ率 0.23(暫定の 4 分の 1 弱は空振り=画面では「仮」が消える)。確定した境界は正解の約 1.7 倍(過分割ぎみ。区間数の目安 0.5〜2 倍には入る)。合成の字幕 16 本×5 境界: 暫定 8 秒・確定 24 秒・位置のずれ 0 秒、取りこぼし 2/80
- **パラメータは仮**(窓 8 / 24 秒・類似度 0.10 / 0.16・最小間隔 90 秒)。39 本全部で決めたので、少し楽観的(データを半分ずつにすると、設定による差は ±0.03〜0.04 のばらつきの中)。**本物のライブ配信(音声認識の遅れ・誤り・雑音)では未測定**。字幕が届く遅れは、上の遅れにそのまま上乗せされる

## CH6: 書き出し(自分の動画・許諾済みの素材だけ)
```bash
uv run python -m chapterlens export edl captions.vtt --clip-name talk.mp4 --out digest.edl      # ダイジェストの区間 → EDL(CMX3600)
uv run python -m chapterlens export chapters-edl captions.vtt --out markers.edl                  # 章の境界 → 編集ソフト用のマーカーつき EDL
uv run python -m chapterlens export subtitles captions.vtt --digest --format srt --out cut.srt   # ダイジェストの時間に詰め直した字幕
uv run python -m chapterlens export video talk.mp4 captions.vtt --own --out highlights.mp4       # 区間をつないだ動画(元の縦横比)
uv run python -m chapterlens export short talk.mp4 captions.vtt --own --max-s 59 --font "Yu Gothic" --out short.mp4   # 縦 1080x1920・字幕を焼き込み
```
- **権限の関門**(設計書 §2): 動画を触る `video` / `short` は、**`--own`(自分の動画・許諾を得た素材です)が無いと動かない**。入力は**この PC の動画ファイルだけ**(URL・`youtube.com` を含む指定は拒否)。**CLI だけ**で、HTTP にも拡張にも出していない。出力は既存ファイルを上書きしない(`--overwrite`)・入力と同じ名前も拒否。書き出したことは監査ログに残る(ファイルの名前・パスは残さない)
- 字幕とダイジェストの区間は、動画の字幕ファイルから作る。時刻の計算(区間の選び直し・字幕の詰め直し)・EDL・SRT/VTT・ffmpeg の引数づくりは純粋な関数で、ffmpeg は引数のリストで直接呼ぶ(シェルを通さない)。要 `ffmpeg` / `ffprobe`(PATH)
- **確認**: 合成の動画(ffmpeg の testsrc)で、縦 1080×1920・長さが区間の合計と一致・音声あり、日本語の字幕が焼き込まれることを**画像で確認**(折り返し・縁取りあり)。短い動画の上限は 59 秒(点の高い区間から入れ、入りきらない最後は切る)。**未確認**: 本物の動画(自分の撮影)での見栄え・字幕の位置(縦動画の下の UI に被らない高さにしたが、アプリごとに違う)・29.97fps などのドロップフレームの EDL(整数 fps だけ対応)
