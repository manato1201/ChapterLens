# ChapterLens

動画・音声(主に YouTube)から、**話題の切り替えを検出してタイムスタンプ・チャプターを付ける** Chrome 拡張とローカルエンジン。

- 設計: [ChapterLens_DESIGN.md](ChapterLens_DESIGN.md)(Phase は CH0〜CH6。**CH0〜CH6 を実装済み**。実機での確認の範囲は各 README の「確認の範囲」)
- 実装: [engine/](engine/README.md)(評価ハーネス・字幕だけの検出器 topic-shift@2・ローカル ASR・サーバー・利用者と共有・ダイジェスト・ライブ・書き出し。テスト 197 件。実データ 39 本で評価済み)/ [extension/](extension/README.md)(Chrome 拡張: 目次・音声から作る・章の調整・ダイジェスト・共有・ライブ。テスト 140 件。**実際の Chrome に拡張として読み込んでの確認は未**)
- 方針: 動画・音声は取得・保存・再配布しない。残すのは区間データだけ(設計書 §2)
