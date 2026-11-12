# ChapterLens

動画・音声(主に YouTube)から、**話題の切り替えを検出してタイムスタンプ・チャプターを付ける** Chrome 拡張とローカルエンジン。

- 設計: [ChapterLens_DESIGN.md](ChapterLens_DESIGN.md)(提案。Phase は CH0〜CH6)
- 実装: [engine/](engine/README.md)(CH0 の評価ハーネスと、字幕だけの検出器 v1。テスト 44 件。**実データの評価は未実施**)
- 方針: 動画・音声は取得・保存・再配布しない。残すのは区間データだけ(設計書 §2)
