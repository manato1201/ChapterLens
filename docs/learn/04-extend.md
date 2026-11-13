# 4. 拡張のしかた(レシピ)

どのレシピも、**テストを先に(または同時に)**書きます。足したら、**測る**(検出器)・**README と図を直す**(利用者に見える変更)まで終えて、完成です。

## レシピ A: 検出器を足す

[第 14 回](../lecture/14-capstone.md) の実践版。

1. **仮説を 1 行で書く**(何が、なぜ、話題の切り替えを表すか)。
2. `engine/src/chapterlens/detectors/<名前>.py` に、`detect(cues, duration_s, *, target_count=None) -> Detection` を持つクラスを書く。
   - `Detection(boundaries, scores, detector)`。`boundaries` は昇順・先頭の 0 秒を含めない。`scores` は同じ長さ。
3. ファイルの末尾で `register("<名前>@1", クラス)`。
4. `detectors/__init__.py` に `from . import <名前>  # noqa: F401` を足す(import すると登録される)。
5. `engine/tests/test_detector.py` に、合成データのテスト(境界が出る・空の字幕・短すぎる動画)。
6. **測る**: `uv run python -m chapterlens eval dataset/ --detector <名前>@1 --detector topic-shift@2`。
7. **基準を確実に上回らなければ外す**(README に 1 行「効かなかった」と残す)。
8. 拡張でも使うなら、`core.js` に移植し、**golden を作り直す**(`export_golden.py`)。移植しないなら、拡張からは選べない旨を書く。

## レシピ B: エンドポイントを足す

1. `server.py` の `_route` に分岐を足す。ハンドラは `Handler` の `_xxx` メソッドにする(`_live_push` が見本)。
2. **入力を検証する**(型・長さ・範囲)。失敗は `HttpError(400, "…")`。上限を決める(巨大な入力を止める)。
3. **経路の種類**(`_group`)を決める: 重い処理は専用の群にして、レート制限を別にする。
4. 管理者だけなら `/v1/admin/` の下に置く(`_admin` が役割を確かめる)。**画面で隠すだけにしない**。
5. 状態を変える操作は、`self._event("名前", ...)` で**監査ログ**に残す。**内容(字幕・題名・動画 ID)は渡さない**(動画は `_video_ref`)。
6. 利用者のデータなら、`self.user["id"]` を `owner` にして**分離**する。`/v1/me/forget` と `admin purge` に、削除を足す。
7. テスト(`test_server*.py`): 正常・不正入力・**他の利用者から見えない**・**利用者が管理者の経路を呼ぶと 403**・停止中の利用者。`conftest.py` の `env` を使う。
8. `server.py` の先頭の docstring(エンドポイントの一覧)と `engine/README.md` を直す。
9. 拡張から呼ぶなら → レシピ C。

## レシピ C: 拡張からエンジンの API を呼ぶ

通信は `background.js` の中継を**必ず通す**(content script・画面は `fetch` しない)。

1. `background.js` の `ENGINE_ROUTES` に `[メソッド, 正規表現]` を足す(**ID の形まで縛る**)。
2. `engine.js` の `createClient` に、メソッドを足す(引数の検査を、送る前に)。
3. `extension/test/extension.test.mjs` の「許可リストの 13 経路」の**件数**を直す(増やしたことを、意図して認める)。
4. `features.test.mjs` に、中継のテスト(許可された経路は通る・形が違えば `forbidden`)。
5. 画面から使う → レシピ D。

## レシピ D: 画面にタブ・ボタンを足す

`ui.js` は**状態を持たず**、渡された内容を描くだけ。状態は `content.js`。

1. `content.js`: `state` に項目を足す。`render` が使う値は、`state` から**毎回作る**(画面を直接いじらない)。
2. `ui.js`: 表示を作る関数(`renderXxx(view)`)と、押されたときの `handlers.onXxx` を足す。**文字は `textContent` だけ**(`innerHTML` は禁止。テストが見張る)。
3. `content.js` の `init` で、`handlers` に処理をつなぐ。エンジンを呼ぶ処理は、**応答の形が想定と違っても落ちない**ように守る(`guardShare` が見本)。
4. `ui.test.mjs`(偽 DOM): 表示・押したときの通知・XSS(`<img onerror>` が文字になる)。
5. `features.test.mjs`: 偽のエンジンを渡して、流れを確かめる。
6. 実ブラウザで見る: `node tools/mock_server.mjs` → `http://localhost:8765/watch?v=mock&variant=shim`(擬似の `chrome` つき)。

## レシピ E: 書き出しの形式を足す

1. `export.py` に、**純粋な関数**(入力 → 文字列)を足す。ffmpeg を呼ぶものだけ、`render` の側に。
2. `cli_tools.py` の `export` に、サブコマンドを足す。**動画を触るなら `check_input(path, own)` を必ず通す**(`--own`・URL 拒否)。
3. 動画を触るなら、`_audit(...)` で記録する(パスは残さない)。
4. `test_export.py`: 純粋な関数は単体で。ffmpeg を使うものは、合成の動画で実際に動かす(`skipif` で、無いときは飛ばす)。
5. 外部プログラムは**引数のリスト**で(`shell=True` にしない)・**時間切れ**を付ける(`_run`)。

## レシピ F: 数値(パラメータ)を変える

数値を変えるときは、**測ってから**。

1. **調整用と確認用を分ける**。同じデータで決めて、同じデータで測らない([第 5 回](../lecture/05-evaluation.md))。
2. `engine/tools/tune*.py` で候補を比べ、**確認用・未見のデータ**で効果を見る。
3. 変えたら、**検出の核なら golden を作り直し、JavaScript を合わせる**: Python → `export_golden.py all` → `core.js` → `npm test` → `parity_real.mjs`。
4. `V2_PARAMS` などのコメントに、**いつ・どのデータで・なぜ**決めたかを書く。README の評価の節も更新する。
5. 既定を変えるときは、**新しい版**を足す(`topic-shift@3`)。古い版は、比較のために残す。

## レシピ G: 字幕の取り方を足す(別のソース)

字幕を「どこから取るか」は、**ソース・アダプタ**に隔離してあります(`transcript.js`)。YouTube の画面の作りは変わりやすいので、**変更に弱い部分を 1 か所に閉じる**ための設計です。

- 出力は `[{start, text}]`(秒と文)。これさえ返せば、検出・画面は変わりません。
- 壊れたときは、**理由つきのエラー**(`no-button`・`timeout`・`empty`)で知らせる。黙って誤った結果を出さない。
- 別のサイトに対応するなら、`manifest.json` の `matches` を**そのサイトだけ**足す(`<all_urls>` にしない)・テストの権限の検査を意図して直す。

## レシピ H: 図と文書を直す

| 直すもの | 手順 |
|---|---|
| 構成図(SVG) | `tools/make_diagrams.py` を直して `python tools/make_diagrams.py`。座標は手で決める(`tools/svgkit.py` の部品) |
| Mermaid の図 | Markdown の中を直す。先頭の標準の行は `docspipeline check-mermaid --fix`(DocsPipeline のコマンド)で入れ、描画できるかを `python tools/check_mermaid.py` で確かめる(mmdc が要る) |
| コードの引用 | `@@引用 パス::名前@@` と書いて `python tools/quote_code.py docs`。出力は `--outputs` で、実際の実行結果から作る |
| 検査 | `cd engine && uv run pytest tests/test_docs.py`(引用のずれ・実行例・リンク・図の形式) |

## 完了のチェックリスト

- [ ] テストを足した(正常・不正・拒否されること)
- [ ] 全テストが通る(`pytest`・`npm test`)。不安定なテストを作っていない
- [ ] 数値を変えたなら、**測った**(調整用と確認用を分けて)
- [ ] 検出の核を変えたなら、golden と JavaScript を合わせた
- [ ] 秘密(token・個人情報・他人の字幕)をコード・ログ・文書・テストの出力に入れていない
- [ ] README・図・講義の記述が、実際の動作と合っている(`test_docs.py` が通る)
- [ ] **確認できていないこと**(本物の Chrome・本物のライブなど)を、正直に書いた

次は [5. テストの書き方](05-testing.md)。
