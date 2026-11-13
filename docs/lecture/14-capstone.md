# 第 14 回 総合演習 — 検出器を 1 つ足して、測って、判断する

> 所要時間の目安: 半日 / 前提: 第 1〜13 回

## この回のゴール

- ここまでの知識を使って、**新しい検出器を自分で足し**、評価ハーネスで**測って、採用するか判断**できる。
- 「足すときは、効果を測り、効かなければ外す」という設計書の約束(R3)を、実際にやってみる。
- 次に自力で取り組む課題の、見通しを持てる。

## 1. 課題: 「無音の間」を使う検出器

字幕には、**行と行の間の空き**(話していない時間)があります。話題が切り替わる所では、**少し長めの間**が空くことが多い、という仮説を立てます。
「間が長い所を、境界の候補にする」検出器 `pause-gap@1` を作ります。

### 手順

1. **仮説を言葉にする**(間が長い所 = 話題の切り替え)。
2. 検出器を書く(`detect(cues, duration_s, *, target_count)` を持つクラス)。
3. `register` で名前をつける。
4. **合成データ**で動くことを確かめる。
5. **評価ハーネス**で、基準(`uniform-k`)と、既存の検出器(`topic-shift@2`)と比べる。
6. **効かなければ外す**。

## 2. 解答(実行できる)

```python
# 実行できる
from chapterlens.captions import Cue
from chapterlens.detectors import available, get_detector, register
from chapterlens.detectors.base import Detection


class PauseGap:
    """字幕と字幕の間の空きが大きい所を、境界の候補にする(仮説: 話題が変わる所では、間が空く)。"""

    name = "pause-gap@1"

    def detect(self, cues, duration_s, *, target_count=None):
        gaps = []                                           # (空きの長さ, 次の字幕の開始)
        for a, b in zip(cues, cues[1:]):
            gaps.append((b.start_s - a.end_s, b.start_s))
        gaps = [g for g in gaps if g[1] >= 60 and g[1] <= duration_s - 60]      # 端から 60 秒以内は除く
        gaps.sort(key=lambda g: -g[0])                      # 空きの大きい順
        k = target_count if target_count is not None else 0
        chosen = sorted(t for _, t in gaps[:k])
        scores = [1.0] * len(chosen)
        return Detection(chosen, scores, self.name)


register("pause-gap@1", PauseGap)
print("登録された検出器:", available())

# 合成: 300 秒で話題が変わり、そこに 3 秒の間が空いている
cues = [Cue(float(t), float(t + 4), "alpha beta") for t in range(0, 300, 4)]
cues += [Cue(float(t), float(t + 4), "gamma delta") for t in range(303, 600, 4)]
print("pause-gap:", get_detector("pause-gap@1").detect(cues, 600.0, target_count=1).boundaries)
print("topic-shift@2:", get_detector("topic-shift@2").detect(cues, 600.0, target_count=1).boundaries)
```

```text
# 出力
登録された検出器: ['pause-gap@1', 'topic-shift@1', 'topic-shift@2']
pause-gap: [303.0]
topic-shift@2: [303.0]
```

この合成データでは、**間が空いているので** `pause-gap` も当たります。しかし、これは**仮説どおりに作ったデータ**だからです。

## 3. 本当の判断は、実データで

評価ハーネスは、検出器の名前を渡せば、**基準との比較**を出します。
ただし、上のようにスクリプトの中で `register` しただけでは、**CLI は知りません**(`--detector` の選択肢は、起動時に登録済みのものから作られる)。
CLI から使うには、**パッケージの一部**にします。

1. クラスを `engine/src/chapterlens/detectors/pause_gap.py` に置き、末尾で `register("pause-gap@1", PauseGap)`。
2. `engine/src/chapterlens/detectors/__init__.py` に `from . import pause_gap  # noqa: F401` を 1 行足す(import すると登録される)。
3. 個数を指定しない(`target_count=None`)ときに**何を返すか**も決める(上の解答は 0 個。`+k`・`+prior` の比較は、個数を渡す)。


```bash
cd engine
uv run python -m chapterlens eval dataset/ --detector pause-gap@1 --detector topic-shift@2
```

読むのは、設計書 R2 ④ の判定です。

- `+k`(同じ区間数)の F1 が、`uniform-k` を**確実に上回る**か。
- 既存の `topic-shift@2` を**上回る、または補う**か(組み合わせる意味があるか)。

**実データでは、自動字幕の行の間隔は、話し手の癖や字幕の作り方で決まる**ので、仮説が当たらないことが多いです。
上回らなければ、**外す**。外すことも、成果です(「この仮説は効かなかった」と、README に 1 行書く)。

## 4. 次の課題(自力で)

| 課題 | 触る場所 | 確認の方法 | ヒント |
|---|---|---|---|
| 区間の題名を、先頭の字幕でなく**頻出語**にする | `core.js` の `buildChapters`・Python 側 | 題名の質を、人が見て評価 | 第 3 回の重みで、その区間に特徴的な語を選ぶ |
| ダイジェストの重みを**調整できる**ようにする | `digest.py`・`core.js`・golden | Python と JS の一致 | 第 6 回の手順(Python → golden → JS) |
| 書き出しに **WebVTT のチャプター**(`NOTE`・`CHAPTER`)を足す | `export.py`・`cli_tools.py` | 純粋な関数に、単体テスト | 第 12 回 |
| `/v1/me` に、自分の**使用状況**(修正の件数)を足す | `server.py`・テスト | 他人のデータが混ざらない | 第 10 回(`owner` で絞る) |
| 新しい**画面のタブ**(例: 履歴)を足す | `ui.js`・`content.js`・`ui.test.mjs` | 偽の DOM のテスト | [拡張のしかた](../learn/04-extend.md) |

どの課題でも、**先にテストを書き、仕様(契約)を決めてから**実装します。

## 確認問題

1. 合成データで `pause-gap` が当たったことは、実データでも当たる証拠になりますか。
2. 評価で「基準を上回らない」と分かったとき、検出器をどうしますか。
3. 検出器を足すとき、サーバー・CLI のコードを直す必要はありますか(`register` の役割から)。
4. 実装より先にテストを書く利点は。

## 解答

1. なりません。**自分の仮説どおりに作ったデータ**で当たるのは当然で、実データで確かめるまで分かりません。
2. **外す**(採用しない)。設計書の約束。原因が分かれば、改良して、もう一度測る。
3. 不要です。サーバー・CLI・評価は、検出器を**名前で呼ぶ**(`get_detector(name)`)ので、`register` するだけで使えます。
4. 「何ができれば完成か」が先に決まり、実装が**仕様から外れにくい**。直した後の退行(壊れた)にも、すぐ気づける。

## まとめ

- 検出器は、`detect` を持つクラスを `register` するだけで足せる(差し替えの口)。
- 足したら**測る**。基準を上回らなければ**外す**。
- 合成データでの成功は、仮説の確認にすぎない。判断は実データで。
- ここから先は、[学習資料](../learn/index.md)(保守・拡張の実務編)へ。
