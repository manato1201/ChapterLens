# ChapterLens engine(CH0)

字幕だけで話題の切り替えを検出し、**投稿者のチャプターを正解にして精度を測る**ための土台。設計は [../ChapterLens_DESIGN.md](../ChapterLens_DESIGN.md)。
**状態**: CH0 のコードとテストは完了(44 件)。**実データでの評価は未実施**(下の「次にやること」)。標準ライブラリだけで動く(依存なし)。

## 使い方
```bash
uv sync
uv run pytest -q                                              # テスト
uv run python -m chapterlens detect captions.vtt --out seg.json   # 字幕 → 区間データ(chapterlens/segments@1)
uv run python -m chapterlens detect captions.vtt --target-count 8  # 境界の数を指定
uv run python -m chapterlens chapters description.txt --out chapters.json   # 概要欄 → 正解
uv run python -m chapterlens eval dataset/ --out results/2026-11-12         # 評価(検出器 vs 基準)
```

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

## 次にやること(CH0 の残り)
1. 投稿者のチャプター付き動画を集め、`dataset/` に置く(20 本)。取得の方法は本人が決める(設計書 §2・§11)。
2. `eval` を回し、基準を上回るかを見る(R2 ④。期限: 着手から 2 週間)。
3. 上回らなければ、検出器を見直す(形態素解析・文の埋め込みなど。**足す前に評価で効果を測る**)。
