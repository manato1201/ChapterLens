# ChapterLens のドキュメント

どれから読むか迷ったら、この表から。

| あなたは | 読むもの |
|---|---|
| **使ってみたい** | [README](../README.md) → [拡張の README](../extension/README.md) |
| **エンジンを動かしたい・API を知りたい** | [エンジンの README](../engine/README.md) |
| **なぜこの形か知りたい** | [設計書](../ChapterLens_DESIGN.md) |
| **基礎から学びたい**(Python・TF-IDF・検出・拡張・音声・安全・テスト) | [講義資料](lecture/index.md)(全 15 回。実行できる例・確認問題・解答つき) |
| **保守・拡張したい** | [学習資料](learn/index.md)(コードの読み方・レシピ・テスト・トラブルシュート・メンテナンス) |
| **分からない言葉がある** | [用語集](learn/glossary.md) |
| **実測の詳細を見たい** | [エンジンの機能と実測](reference/engine-features.md)・[評価](reference/evaluation.md) |

## 図

| 図 | 内容 |
|---|---|
| [全体の構成](diagrams/architecture.svg) | ブラウザ・拡張・ローカルエンジン・CLI |
| [段階の地図](diagrams/phases.svg) | CH0〜CH6 で足した機能 |
| [エンジンのモジュールの層](diagrams/engine-modules.svg) | CLI → 評価・サーバー → 核 |
| [拡張のメッセージの経路](diagrams/extension-messages.svg) | popup・content script・background・offscreen・エンジン |

フロー・シーケンス・状態の図は、各ページの Mermaid です(GitHub でそのまま描かれます)。

## この文書を古くしない仕組み

- 講義の**コードの引用は、ソースから自動で作る**(`python tools/quote_code.py docs`)。コードが変わると、テストが失敗する。
- `# 実行できる` の例は、テストが**実際に 2 回実行**して、`# 出力` と一致するか確かめる。
- 構成図(SVG)は、`tools/make_diagrams.py` から作る(座標を手で決めた、コードで再現できる図)。
- 検査: `cd engine && uv run pytest tests/test_docs.py`(引用のずれ・実行例・リンク・図の形式)。
