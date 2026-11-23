# ChapterLens

動画・音声(主に YouTube)から、**話題の切り替えを自動で検出して、タイムスタンプ(チャプター)を付ける** Chrome 拡張と、この PC の中で動くローカルエンジン。

![全体の構成図](docs/diagrams/architecture.svg)

- **字幕から作る**: 動画ページの文字起こしから、話題の切り替えを検出して目次を重ねる。処理は**拡張の中だけ**で、何も送信しない。
- **音声から作る**: 字幕が無い動画は、再生中のタブの音を、**この PC のエンジン**(127.0.0.1)で文字にして、同じように目次にする。
- **題名・大見出し**: ローカル LLM(LocalLLMHarness)が、章の題名を「何をしている場面か」の 1 行にし、章を大見出しで束ねる(**既定は無効**・字幕はこの PC の外へ出ない・字幕にない数字や固有名詞は使わない)。
- **テロップ**: 再生中、今の章の題名(と大見出し)を、動画の上に文字で重ねて表示する(**自分の画面だけ**。動画は加工しない)。
- **ライブ**: 配信中に、暫定の印(「仮」)を出し、後ろの話を聞いてから確定する。
- **ダイジェスト**: 重要そうな区間だけを、再生中に自動で飛ばして見る(動画は切り出さない)。
- **少人数での共有**: 章立てを、許可した範囲で共有する(区間の時刻だけ。字幕・音声・動画は共有しない)。
- **書き出し**: **自分の動画だけ**を、EDL・字幕・縦の短い動画にする(`--own` が要る)。

**方針**: 他人の動画・音声は、取得・保存・切り出し・再配布しない。残すのは区間データだけ(設計書 §2)。

## 状態

| 段階 | 内容 | 状態 |
|---|---|---|
| CH0 | 測る土台(評価ハーネス・検出器) | 実装済み・実データ 39 本で評価 |
| CH1 | 字幕から作る目次(拡張) | 実装済み |
| CH2 | ローカルエンジン・音声から作る | 実装済み |
| CH3 | 利用者・共有・監査ログ・共有の画面 | 実装済み |
| CH4 | ダイジェスト | 実装済み(人の判断との一致は未測定) |
| CH5 | ライブ(暫定 → 確定) | 実装済み(暫定 9 秒・確定 27 秒。本物のライブは未確認) |
| CH6 | 書き出し(自分の動画だけ) | 実装済み |

**まだ確認できていないこと**: 拡張を実際の Chrome に読み込んでの動作・本物のライブ配信・人の「重要」との一致・本物の動画での書き出しの見栄え。詳しくは [拡張の README](extension/README.md) の「確認の範囲」。

## クイックスタート

**字幕から作る(エンジン不要)**: Chrome の `chrome://extensions` →「デベロッパー モード」→「パッケージ化されていない拡張機能を読み込む」→ `extension/` を選ぶ。YouTube の動画を開き、右下の「目次」→「目次を作る」。

**音声から作る・ライブ(エンジンが要る)**:

```bash
cd engine
uv sync --extra asr
uv run python -m chapterlens serve --allow-origin chrome-extension://egcgicajchobpecnggcblcbnoadlnfai
```

拡張のアイコン → URL(`http://127.0.0.1:8787`)と token(`~/.chapterlens/token` の中身。**他人に見せない**)→「この動画の音声から作る」。

**テスト**:

```bash
cd engine && uv run pytest -q        # 439 件が通り、3 件は環境によりスキップ(うち 148 件は文書の検査)
cd extension && npm test             # 212 件
```

## ドキュメント

| 読むもの | 内容 |
|---|---|
| [engine/README.md](engine/README.md) | エンジンの使い方(CLI・API・設定) |
| [extension/README.md](extension/README.md) | 拡張の使い方・権限・確認の範囲 |
| [設計書](ChapterLens_DESIGN.md) | なぜこの形か(段階・基準・方針・安全) |
| [**講義資料**](docs/lecture/index.md) | **基礎から**(Python・TF-IDF・検出・拡張・音声・安全・テスト)。全 15 回・実行できる例と演習つき |
| [**学習資料**](docs/learn/index.md) | **保守・拡張の実務編**(コードの読み方・レシピ・テスト・トラブルシュート・メンテナンス) |
| [docs/reference/](docs/reference/) | 段階ごとの詳細な実測・評価の記録 |

## 構成

```text
engine/      Python のエンジン(検出器・サーバー・ASR・ライブ・ダイジェスト・書き出し)
extension/   Chrome 拡張(Manifest V3)
docs/        講義資料・学習資料・構成図・参照
tools/       図の生成・文書の引用の検査
```

## ライセンス

[PolyForm Noncommercial License 1.0.0](LICENSE) です。**個人・研究・教育・非営利の利用は無料**で、自由に使えます。**営利目的の利用(会社の業務での利用、有償の製品・サービスへの組み込みなど)は許可されていません**。

- 商用利用をご希望の場合は、[Issue](https://github.com/manato1201/ChapterLens/issues)(ラベル `commercial`)でご相談ください。別途の許諾をお出しします。
- 著作権者: 松浦真聖 (Matsuura Manato)。表示事項は [NOTICE](NOTICE) にあります。再配布するときは、`LICENSE` と `NOTICE` を一緒に渡してください。
- 第三者の著作物(依存パッケージ・同梱の素材・外部サービスのデータなど)は、それぞれのライセンスに従います。
- この節は条文の要約です。**条文(LICENSE)が優先します**。

English: licensed under the PolyForm Noncommercial License 1.0.0. Noncommercial use is free; commercial use requires a separate license (open an issue labeled `commercial`).
