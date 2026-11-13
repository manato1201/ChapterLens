# 第 3 回 語の重み(TF-IDF)とコサイン類似度

> 所要時間の目安: 3 時間 / 前提: 第 2 回

## この回のゴール

- **TF**(語の出現回数)・**IDF**(珍しさ)・**TF-IDF**(重み)を、意味と式の両方で説明できる。
- 文章を「語 → 重み」の**ベクトル**として扱い、**コサイン類似度**で 2 つの文章の似方を数にできる。
- 小さな例を**手で計算**して、コードの結果と一致することを確かめられる。
- ChapterLens が使う式が、教科書の式と少し違う点(平滑化)を説明できる。

## 1. 発想: 話題が変わると、使う語が変わる

「ギター」の話の区間には `guitar`・`chord`・`fret` が多く、「料理」の話の区間には `recipe`・`knife`・`miso` が多い。
**2 つの区間の語の分布を比べて、似ていなければ、そこで話題が変わった**と見なします(TextTiling という古典的な考え方、第 4 回)。

そのために、区間を数のベクトルに直し、2 つのベクトルの「向き」の近さを測ります。

## 2. TF: 出現回数

**TF**(Term Frequency)は、その語が区間に何回出たか。ただし 100 回出た語が 1 回の語の 100 倍「重要」とは限らないので、**対数**で丸めます。

- 本書の重み: `1 + log(c)`(`c` は回数)。1 回なら 1、2 回なら 1.69、10 回で 3.30。

## 3. IDF: 珍しさ

**IDF**(Inverse Document Frequency)は、その語が**多くの区間に出るか**を見ます。ほとんどの区間に出る語(`really`・`thing`)は区別の役に立たず、**一部の区間にだけ出る語**が、話題を表します。

- `df` = その語が出る区間の数、`n` = 区間の総数。
- 本書の式: `idf = log((n + 1) / (df + 1)) + 1`

教科書の `log(n / df)` と違い、**`+1` を足して平滑化**しています。理由は 2 つです。
(1) 全部の区間に出る語でも、重みが `0` にならない(`0` だと、そのベクトルが空に見える)。
(2) 1 区間にしか無い語でも、`df = 0` の割り算が起きない。

## 4. TF-IDF: 重み = TF × IDF

その語が**この区間で多く、他の区間では少ない**ほど、重みが大きい。

```python
# 実行できる
import math

n = 4                       # 区間(ビン)の数
df = {"guitar": 1, "really": 4}   # その語が出る区間の数
idf = {t: math.log((n + 1) / (k + 1)) + 1.0 for t, k in df.items()}
print({t: round(v, 3) for t, v in idf.items()})

c = 3                        # この区間での回数
for term in df:
    print(term, "重み =", round((1.0 + math.log(c)) * idf[term], 3))
```

```text
# 出力
{'guitar': 1.916, 'really': 1.0}
guitar 重み = 4.022
really 重み = 2.099
```

同じ 3 回でも、`guitar`(1 区間にしか出ない)は `really`(全部の区間に出る)より、重みが大きくなります。

## 5. コサイン類似度

2 つの区間を、語ごとの重みのベクトルとして並べ、**なす角のコサイン**を類似度にします。

```text
cos(a, b) = (a · b) / (|a| × |b|)
```

- `a · b`(内積)= 共通する語の `重み_a × 重み_b` の合計。
- `|a|` = ベクトルの長さ(各重みの 2 乗の合計の平方根)。
- 結果は 0(共通する語が全く無い)〜 1(向きが同じ)。**長さ(文章の量)に影響されない**のが利点です。

実際の関数を読みます。

```python
# 引用: engine/src/chapterlens/detectors/topic_shift.py::_cosine
def _cosine(a: dict[str, float], b: dict[str, float]) -> float:
    if not a or not b:
        return 1.0  # 片側が空なら、切り替えの根拠が無い
    if len(a) > len(b):
        a, b = b, a
    dot = sum(v * b.get(t, 0.0) for t, v in a.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 1.0
```

- 片方が空なら `1.0` を返します。**「根拠が無いなら、切り替えと見なさない」**という、検出器側の都合の選択です(空と内容の差を、話題の切り替えと誤らないため)。
- `len(a) > len(b)` なら入れ替えるのは、短い方を回して、内積の計算を速くするためです。

## 6. 手で計算して、コードと照らす

3 語だけの 2 つの区間で、手計算とコードが一致することを確かめます。

```python
# 実行できる
import math
from chapterlens.detectors.topic_shift import _cosine

a = {"guitar": 2.0, "chord": 1.0}
b = {"guitar": 1.0, "recipe": 3.0}

dot = a["guitar"] * b["guitar"]                       # 共通する語は guitar だけ: 2 * 1
na = math.sqrt(2.0**2 + 1.0**2)
nb = math.sqrt(1.0**2 + 3.0**2)
print("手計算:", round(dot / (na * nb), 6))
print("コード:", round(_cosine(a, b), 6))
print("同じ向き:", round(_cosine(a, {"guitar": 4.0, "chord": 2.0}), 6))   # 全部 2 倍にしても 1.0
print("共通なし:", _cosine({"x": 1.0}, {"y": 1.0}))
```

```text
# 出力
手計算: 0.282843
コード: 0.282843
同じ向き: 1.0
共通なし: 0.0
```

「全部 2 倍にしても `1.0`」が、コサイン類似度の性質です。**文章が長くても短くても、語の構成比だけを見る**。

## 7. ベクトルを作る関数

区間の語を数えて、TF-IDF のベクトルにするのが `similarity_curve` の内部の `vector` です(第 4 回で全体を読みます)。

```python
# 実行できる
import math
from collections import Counter
from chapterlens.text import term_counts

bins = [term_counts("guitar chord guitar melody"),
        term_counts("guitar rhythm tuning"),
        term_counts("recipe knife miso knife")]
n = len(bins)
df = Counter()
for b in bins:
    df.update(b.keys())
idf = {t: math.log((n + 1) / (k + 1)) + 1.0 for t, k in df.items()}
vec = {t: (1.0 + math.log(c)) * idf[t] for t, c in bins[0].items()}
for t, v in sorted(vec.items(), key=lambda kv: -kv[1]):
    print(f"{t:8s} tf={bins[0][t]} df={df[t]} idf={idf[t]:.3f} 重み={v:.3f}")
```

```text
# 出力
guitar   tf=2 df=2 idf=1.288 重み=2.180
chord    tf=1 df=1 idf=1.693 重み=1.693
melody   tf=1 df=1 idf=1.693 重み=1.693
```

`guitar` は 2 回出ますが、2 つの区間に出るので IDF が低く(1.288)、重みは 1 回だけ・1 区間だけの `chord`・`melody`(1.693)の約 1.3 倍に収まっています。**回数が多くても、どこにでもある語は、重みが伸びにくい**。

## 確認問題

1. `n = 10`、`df = 10` の語の `idf` はいくつですか(教科書の `log(n/df)` との違いも)。
2. 共通する語が無い 2 つの区間の類似度はいくつですか。
3. ベクトルの全成分を 3 倍にすると、コサイン類似度は変わりますか。
4. `_cosine` が、片方が空のときに `1.0` を返すのはなぜですか。

## 解答

1. `log(11/11) + 1 = 1.0`。教科書の式なら `log(1) = 0` で、重みが消えます。ここでは `1` が残ります。
2. `0.0`(内積が 0)。
3. 変わりません(分子・分母の両方が 3 倍になって打ち消し合う)。
4. 片方が空だと、比べる根拠が無いため。空の区間を「全く似ていない」と扱うと、無音と発話の境目を、話題の切り替えと誤るからです。

## まとめ

- 重みは `(1 + log 回数) × (log((n+1)/(df+1)) + 1)`。多く出て、他の区間では珍しい語ほど大きい。
- 区間どうしの似方は、重みのベクトルの**コサイン類似度**。量でなく、語の構成を比べる。
- 平滑化(`+1`)は、重みが 0 になる・0 で割る、を防ぐ工夫。
- 次の回は、この類似度の**曲線の谷**から、話題の切り替えを選ぶ。
