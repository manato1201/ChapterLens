# ChapterLens

動画・音声(主に YouTube)から、**話題の切り替えを検出してタイムスタンプ・チャプターを付ける** Chrome 拡張とローカルエンジン。

- 設計: [ChapterLens_DESIGN.md](ChapterLens_DESIGN.md)(提案。Phase は CH0〜CH6)
- 実装: [engine/](engine/README.md)(CH0: 評価ハーネスと字幕だけの検出器 topic-shift@2。テスト 46 件。実データ 39 本で評価済み)/ [extension/](extension/README.md)(CH1: Chrome 拡張。テスト 29 件。**Chrome への読み込みでの確認は未**)
- 方針: 動画・音声は取得・保存・再配布しない。残すのは区間データだけ(設計書 §2)
