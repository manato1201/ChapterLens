# 3. 内側の仕組み

## 3.1 エンジン: 1 つのリクエストの旅

`server.py` の `_dispatch` が、すべての呼び出しの入口です。順序が決まりです(順序を変えると、守りに穴が開きます)。

```mermaid
%%{init: {"theme":"base","fontFamily":"Noto Sans JP, Hiragino Sans, Meiryo, sans-serif","themeVariables":{"fontFamily":"Noto Sans JP, Hiragino Sans, Meiryo, sans-serif","primaryColor":"#ffffff","primaryBorderColor":"#d0d5dd","primaryTextColor":"#101828","lineColor":"#667085","clusterBkg":"#f2f4f7","clusterBorder":"#d0d5dd","edgeLabelBackground":"#ffffff"},"flowchart":{"wrappingWidth":480,"nodeSpacing":40,"rankSpacing":56,"padding":14},"sequence":{"mirrorActors":false,"wrap":false,"width":150,"actorMargin":30,"messageMargin":34}}}%%
flowchart TD
    R["do_GET / do_POST"]:::input --> HO["_check_host_origin<br/>Host・Origin"]:::proc
    HO --> OP{"OPTIONS?"}:::proc
    OP -- はい --> P204["204(プリフライト。token は要らない)"]:::out
    OP -- いいえ --> AU["_authenticate<br/>token → 利用者(accounts.authenticate)"]:::proc
    AU --> RL["limiter.check<br/>(利用者, 経路の種類)"]:::proc
    RL --> RT["_route(method, route, query)"]:::out
    RT --> AD{"/v1/admin/ ?"}:::stop
    AD -- はい --> RC["役割が admin か"]:::stop
    AD -- いいえ --> H["各ハンドラ<br/>(_detect・_transcribe・_live_push・_share_*)"]:::out
    RC --> H
    H --> RS["_send(JSON)"]:::out --> AL["finally: 監査ログ(route)"]:::out
    classDef input fill:#dae8fc,stroke:#1a73e8,color:#101828
    classDef proc fill:#e6f4f1,stroke:#0f9d8a,color:#101828
    classDef out fill:#fff7ed,stroke:#e8710a,color:#101828
    classDef stop fill:#fef3f2,stroke:#d92d20,color:#101828
```

- 失敗は `HttpError(status, message)` で投げ、`_dispatch` が 1 か所で受けて JSON にする。**想定外の例外は `500`**で、内容は返さない。
- 認証に**失敗**した呼び出しは、レート制限を**数えない**(他人の枠を減らさせない)。
- 監査ログは `finally` で必ず書く(結果が何であっても)。

### 保存されるもの(`~/.chapterlens/` または `CHAPTERLENS_HOME`)

| ファイル | 中身 | 備考 |
|---|---|---|
| `token` | 管理者 `local` の token(平文) | **他人に見せない**。消すと作り直され、新しい token になる |
| `accounts.db` | 利用者・役割・**token のハッシュ**・設定(共有範囲) | |
| `corrections.db` | 利用者ごとの境界の修正 | `owner` で分離 |
| `shares.db` | 共有した区間データ | 字幕・音声は入らない |
| `audit.log`(`.1`) | 監査ログ | 5MB で 1 世代だけ回す |

ライブのセッションは**メモリだけ**(保存しない)。

## 3.2 検出の内部

[第 4 回](../lecture/04-topic-shift.md) の流れのとおり。**拡張の `core.js` が、同じ手順を持つ**。

- 入口: `TopicShiftDetector.detect` → `similarity_curve` → `select_boundaries`(平滑化・深さ・選択・snap・置き直し)。
- 途中の値を見たいとき: [第 4 回](../lecture/04-topic-shift.md) のように、各関数を直接呼ぶ(`similarity_curve`・`_depth_scores`)。
- 数値の決め方: `V2_PARAMS` のコメントと、`engine/tools/tune*.py`、評価の結果(`engine/README.md`)。

## 3.3 ダイジェストの内部

```mermaid
%%{init: {"theme":"base","fontFamily":"Noto Sans JP, Hiragino Sans, Meiryo, sans-serif","themeVariables":{"fontFamily":"Noto Sans JP, Hiragino Sans, Meiryo, sans-serif","primaryColor":"#ffffff","primaryBorderColor":"#d0d5dd","primaryTextColor":"#101828","lineColor":"#667085","clusterBkg":"#f2f4f7","clusterBorder":"#d0d5dd","edgeLabelBackground":"#ffffff"},"flowchart":{"wrappingWidth":480,"nodeSpacing":40,"rankSpacing":56,"padding":14},"sequence":{"mirrorActors":false,"wrap":false,"width":150,"actorMargin":30,"messageMargin":34}}}%%
flowchart LR
    A["字幕"]:::input --> B["15 秒のかたまり<br/>語の袋"]:::input --> C["TF-IDF ベクトル<br/>情報量 = 重みの合計"]:::proc
    C --> D["章ごとに<br/>代表性 = 他のかたまりとのコサイン"]:::proc --> E["点 = 0.5×情報量 + 0.5×代表性<br/>+ 0.25(章の最初)"]:::proc
    E --> F["各章の最高点を 1 つ<br/>+ 点の高い順に予算(20%)まで"]:::out --> G["すき間(1 つ)を埋めて<br/>連続を 1 区間に"]:::out --> H["始まり・終わりを<br/>発話の頭と終わりに"]:::stop
    classDef input fill:#dae8fc,stroke:#1a73e8,color:#101828
    classDef proc fill:#e6f4f1,stroke:#0f9d8a,color:#101828
    classDef out fill:#fff7ed,stroke:#e8710a,color:#101828
    classDef stop fill:#fef3f2,stroke:#d92d20,color:#101828
```

Python の `digest.py::select_digest` と、JavaScript の `core.js::selectDigest` が、**同じ手順**(実データ 39 本で一致)。
再生中の自動シークは、`core.js::digestNext(spans, t)` が「区間の中 → null / すき間 → 次の頭へ / 最後の後ろ → 終了」を返し、`content.js::digestTick` が `timeupdate` のたびに呼ぶ。

## 3.4 拡張: `content.js` の状態と描画

```mermaid
%%{init: {"theme":"base","fontFamily":"Noto Sans JP, Hiragino Sans, Meiryo, sans-serif","themeVariables":{"fontFamily":"Noto Sans JP, Hiragino Sans, Meiryo, sans-serif","primaryColor":"#ffffff","primaryBorderColor":"#d0d5dd","primaryTextColor":"#101828","lineColor":"#667085","clusterBkg":"#f2f4f7","clusterBorder":"#d0d5dd","edgeLabelBackground":"#ffffff"},"flowchart":{"wrappingWidth":480,"nodeSpacing":40,"rankSpacing":56,"padding":14},"sequence":{"mirrorActors":false,"wrap":false,"width":150,"actorMargin":30,"messageMargin":34}}}%%
flowchart TD
    subgraph S["state(1 本の動画)"]
        direction LR
        CU["cues<br/>字幕"]:::input --- AU["auto<br/>検出した境界"]:::input --- MA["manual<br/>利用者が直した境界<br/>(あれば優先)"]:::proc --- CH["chapters<br/>effective() から作る"]:::proc
        DG["digest<br/>auto / custom / enabled"]:::out --- SH["share<br/>info / list / overlay"]:::out --- LV["live<br/>session / queue / markers"]:::stop
    end
    S --> RN["render()<br/>ui.setChapters・setDigest・目印"]:::out
    classDef input fill:#dae8fc,stroke:#1a73e8,color:#101828
    classDef proc fill:#e6f4f1,stroke:#0f9d8a,color:#101828
    classDef out fill:#fff7ed,stroke:#e8710a,color:#101828
    classDef stop fill:#fef3f2,stroke:#d92d20,color:#101828
```

- **`effective()` = `manual ?? auto`**。利用者が直した境界があれば、それを優先する。
- 調整(`applyEdit`)→ `manual` を更新 → `store.saveManual` → `rebuild()`。粒度を変えると `auto` が変わるが、`manual` があるうちは**粒度を変えさせない**(黙って捨てない)。
- 取り込み中(`state.capture`)・ライブ中(`state.live`)は、**調整・ダイジェスト・共有を使えない**(`canEdit()`)。
- 動画が変わると `reset()` で、前の動画の状態を全部捨てる(取り込み・ライブも止める)。

### ブラウザに保存されるもの(`chrome.storage.local`)

| キー | 中身 |
|---|---|
| `chapterlens.engine` | エンジンの URL・token・言語(popup が保存) |
| `chapterlens.granularity` | 粒度 |
| `chapterlens.v.<動画 ID>` | その動画の調整(`manual` / `digest`)。**時刻だけ**(字幕・題名は保存しない) |
| `chapterlens.index` | 動画 ID の新しい順(100 本を超えると古いものを消す) |

## 3.5 ライブ

[第 11 回](../lecture/11-digest-and-live.md) の状態機械。拡張側は、`livePump` が字幕の待ち行列をエンジンへ 400 個ずつ送り、返ってきた `markers` を `applyLiveMarkers` で章にします。

- セッションが期限切れ(`404`)なら、**新しく始めて、いまある字幕を全部送り直す**(2 回まで)。
- 応答の形が想定と違っても、**例外にせず**、画面にエラーを出して、字幕の取り込みは続ける。

## 3.6 守りの層(まとめ)

| 層 | どこ | 何を防ぐ |
|---|---|---|
| ネットワーク | `127.0.0.1` だけで待ち受け | 外のネットワークからの接続 |
| ブラウザ | Host・Origin の検査 | DNS リバインディング・他サイトからの呼び出し |
| 認証 | token のハッシュ・定数時間の比較 | token の漏れ・タイミング攻撃 |
| 認可 | 役割はサーバーで引く | 画面の改ざん・名乗り |
| 制限 | 利用者ごと・経路の種類ごと | 連打・暴走 |
| 入力 | 検証(許可した項目だけ・上限) | 字幕の紛れ込み・巨大な入力 |
| 記録 | 監査ログ(内容を残さない) | 後から追えること・記録の漏れ |
| 拡張 | 権限最小・通信の許可リスト・`textContent` | 権限の乱用・XSS |
| 書き出し | `--own`・URL 拒否・CLI だけ | 他人の動画の切り出し |

次は [4. 拡張のしかた](04-extend.md)。
