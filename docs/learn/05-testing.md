# 5. テストの書き方・動かし方

講義 [第 13 回](../lecture/13-testing.md) の方針の、実務版です。

## 5.1 動かす

```bash
cd engine
uv run pytest -q                              # 全部(約 30 秒。ffmpeg があれば書き出しも実物で)
uv run pytest tests/test_detector.py -q       # 1 ファイル
uv run pytest -k "live and dense" -q          # 名前で絞る
uv run pytest -x -q                           # 最初の失敗で止める
```

```bash
cd extension
npm test                                      # 全部(Node の標準機能だけ・依存なし)
node --test test/core.test.mjs                # 1 ファイル
node tools/parity_real.mjs                    # 実データで、Python と一致するか(手元だけ)
```

## 5.2 どこに足すか

| 変えたもの | 足す場所 |
|---|---|
| 検出・字幕・指標 | `engine/tests/test_detector.py` `test_parsing.py` `test_metrics.py` |
| サーバーの経路・認証・共有 | `test_server.py` `test_server_roles.py` `test_server_live.py` |
| 利用者・共有・監査の部品 | `test_accounts.py`(部品の単体) |
| 書き出し | `test_export.py` |
| 拡張の核(`core.js`) | `extension/test/core.test.mjs` |
| 拡張の流れ | `flow.test.mjs` `features.test.mjs`(偽の chrome・偽のエンジン) |
| 画面 | `ui.test.mjs` |
| 保存・エンジン呼び出し口 | `store.test.mjs` |

## 5.3 Python のテストの型

### 純粋な関数: 入力を作って、出力を比べる

合成データは `engine/tests/synth.py` の `make_video(lengths_s, lang, seed)`(話題ごとに語彙が違う字幕と、正解の境界を返す)。**他人の字幕は使わない**。

### HTTP: 本物のサーバーを立てる

```python
# 抜粋ファイル: engine/tests/test_server_live.py
def test_sessions_are_private_to_their_owner(env):
    call, _ = env
    _, tok = add_user(call, "alice")
```

`env` フィクスチャ(`conftest.py`)が、`port=0` でサーバーを立て、`call(method, path, body, token=…)` を渡します。`add_user` で利用者を作り、**その token で呼ぶ**。

### 守りのテスト: 拒否されることを確かめる

機能が動くテストより、**通ってはいけないものが通らない**テストを、先に足します。

- 別の利用者の token で呼ぶ → 見えない・`404`。
- 利用者が管理者の経路 → `403`。
- 余計な項目・上限超え → `400` / `413`。
- 停止中 / 不明な token → **同じ `401`**。

### 時間が絡む: 時計を差し替える

`RateLimiter(limits, clock=…)`・`LiveSessions(clock=…)` のように、**時計を引数で受ける**。本当には待たない。時計が**進まない**場合(分解能が粗い)も試す。

## 5.4 JavaScript のテストの型

### 核: そのまま呼ぶ

`core.js` は DOM に触れないので、`require` して呼ぶ。

### 流れ: 偽の chrome / DOM / エンジン

`extension/test/helpers.mjs` の `loadContent({ rows, engine, storage, live })` が、`content.js` を `vm` の中で動かします。

- `page.handlers.onChapterRemove(1)` のように、**画面が呼ぶ操作を直接呼ぶ**(画面を作らずに、流れだけ確かめる)。
- `page.ui.chapters.at(-1)` などで、**画面に渡された内容**を読む。
- `engine: (method, path, body) => ({ok, status, data})` で、**偽のエンジン**を渡す。呼ばれた記録は `page.engineCalls`。
- `await flush()` で、非同期の処理(保存・通信)を終わらせてから確かめる。
- `vm` の中で作った値は、外と**別の世界**なので、`clone`(JSON の往復)してから `deepEqual` で比べる。

### 画面: 最小の偽 DOM

`fakedom.mjs` は、`ui.js` が使う範囲だけの偽の DOM。`panel()` で作り、`buttonByText(root, "共有する").click()` のように操作する。
**XSS の確認**(`<img onerror>` が文字として入る)を、画面を足したら毎回足す。

## 5.5 golden を作り直す

検出の核(`topic_shift.py`・`digest.py`)を変えたとき。

```bash
cd engine
uv run python tools/export_golden.py all       # extension/test/golden/golden.json(合成)と、手元の実データの期待値
cd ../extension
npm test                                       # 落ちたら、core.js を Python に合わせて直す
node tools/parity_real.mjs                     # 実データでも一致するか
```

**順序**: Python を直す → golden → JavaScript。

## 5.6 文書のテスト

```bash
cd engine
uv run pytest tests/test_docs.py -q
```

- 引用のずれ(`# 引用:`)・抜粋の行の消失・実行できる例の出力・必須の節・リンク切れ・Mermaid の標準の行を確かめる。
- ずれたら: `python tools/quote_code.py docs`(引用を更新)・`--outputs`(実行例の出力を、実行結果から作り直す)。
- **実行例に、毎回変わる出力(ランダム・パス・時刻)を出さない**。2 回実行して比べるので、必ず落ちる。

## 5.7 落ちたとき

| 症状 | まず疑うこと |
|---|---|
| たまに落ちる | 時計の分解能・辞書や集合の順序・乱数・スレッド。**8 回回して再現**し、決定的にする |
| JS だけ落ちる(golden) | 丸め・並べ替えの同点・足し算の順序([第 6 回](../lecture/06-python-js-parity.md)) |
| `deepEqual` が「同じ構造だが同一でない」 | `vm` の別の世界。`clone` してから比べる |
| 文書のテストだけ落ちる | コードを変えたのに、引用を更新していない(`quote_code.py`) |
| ffmpeg のテストが飛ばされる | ffmpeg / ffprobe が PATH に無い(意図どおり) |

次は [6. 演習](06-exercises.md)。
