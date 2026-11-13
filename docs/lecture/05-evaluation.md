# 第 5 回 精度を測る(F1・許容・基準・過学習)

> 所要時間の目安: 3 時間 / 前提: 第 4 回

## この回のゴール

- 検出した境界と正解の境界を、**1 対 1 に対応づける**考え方(許容つきの貪欲法)を説明できる。
- **適合率・再現率・F1** の意味と、境界の検出での読み方が分かる。
- 「**基準**(何もしない方法)を上回るか」で判断する理由を説明できる。
- **過学習**を避ける手順(調整用と確認用を分ける・交差検証)を説明できる。
- 数字を出す前に「何を正解とするか」を決める大切さが分かる。

## 1. なぜ測るのか

精度を測れないまま作ると、**良くなったのか悪くなったのかが分かりません**。ChapterLens は、検出器を作る前に、先に測る道具(評価ハーネス)を作りました(CH0)。
設計書の約束は 3 つです。

- 検出器を変えるたびに評価を回し、**F1 が下がったら採用しない**。
- 「**何もしない方法(基準)を確実に上回る**」ことが最低線。上回らなければ、方針を見直し、見直しても上回らなければ**中止**。
- 数字は**仮の目標**で、実測で決める。

## 2. 正解はどこから来るか

投稿者が自分で付けたチャプター(概要欄の `0:00 導入` の行)を**正解**にします。人が付けた正解が、無料で得られます。

```python
# 引用: engine/src/chapterlens/chapters.py::parse_description_chapters
def parse_description_chapters(text: str) -> list[tuple[float, str]]:
    """[(開始秒, 題名), ...]。チャプター付きと認められなければ空。"""
    found: list[tuple[float, str]] = []
    for line in text.replace("\r\n", "\n").split("\n"):
        m = _LINE.match(line)
        if not m:
            continue
        h, mnt, sec, title = m.groups()
        if int(sec) >= 60:
            continue
        start = int(h or 0) * 3600 + int(mnt) * 60 + int(sec)
        found.append((float(start), (title or "").strip()))
    if len(found) < 3 or found[0][0] != 0.0:
        return []
    if any(b[0] <= a[0] for a, b in zip(found, found[1:])):
        return []
    return found
```

- 先頭が `0:00`・3 つ以上・昇順、という YouTube の規則を満たすものだけを、チャプターと認めます。
- **正解の偏り**に注意が要ります。投稿者のチャプターは「大きな章立て」で、細かい切り替えは含みません。だから、検出した境界が正解に無くても、**間違いとは限らない**(適合率は低めに出る)。

## 3. 境界を対応づける

検出した境界の列 `pred` と、正解の列 `ref`。同じ境界を指しているかは、**許容(±tol 秒)**以内かで決めます。1 つの正解に 2 つの予測を対応させない(**1 対 1**)。

```python
# 引用: engine/src/chapterlens/metrics.py::match_boundaries
def match_boundaries(pred: list[float], ref: list[float], tol: float) -> list[tuple[float, float]]:
    """予測と正解を 1 対 1 で対応づける。

    両方を昇順に並べ、許容 tol 以内の組を先頭から取る(直線上の点の対応づけでは、
    この貪欲法が対応数の最大を与える)。
    """
    p = sorted(pred)
    r = sorted(ref)
    i = j = 0
    pairs: list[tuple[float, float]] = []
    while i < len(p) and j < len(r):
        d = p[i] - r[j]
        if abs(d) <= tol + 1e-9:
            pairs.append((p[i], r[j]))
            i += 1
            j += 1
        elif d < 0:
            i += 1
        else:
            j += 1
    return pairs
```

- 両方を昇順に並べ、**先頭から順に**、許容以内の組を取ります。直線上の点の対応づけでは、この貪欲法が**対応数の最大**を与えます(交差しないので)。
- `i` と `j` を進める 3 通り: 許容以内なら両方進める。予測が小さければ予測を、そうでなければ正解を進める。

```python
# 実行できる
from chapterlens.metrics import match_boundaries, score_boundaries

pred = [100.0, 205.0, 400.0]
ref = [98.0, 210.0, 600.0]
print(match_boundaries(pred, ref, tol=3.0))
print(match_boundaries(pred, ref, tol=10.0))
s = score_boundaries(pred, ref, 10.0)
print("TP =", s.tp, " 適合率 =", round(s.precision, 3), " 再現率 =", round(s.recall, 3), " F1 =", round(s.f1, 3))
print("ずれ(予測 - 正解):", s.errors_s)
```

```text
# 出力
[(100.0, 98.0)]
[(100.0, 98.0), (205.0, 210.0)]
TP = 2  適合率 = 0.667  再現率 = 0.667  F1 = 0.667
ずれ(予測 - 正解): [2.0, -5.0]
```

## 4. 適合率・再現率・F1

| 指標 | 式 | 意味 |
|---|---|---|
| **適合率**(precision) | 当たった数 ÷ 検出した数 | 検出したもののうち、本物はどれだけか(**空振りの少なさ**) |
| **再現率**(recall) | 当たった数 ÷ 正解の数 | 本物のうち、見つけられたのはどれだけか(**取りこぼしの少なさ**) |
| **F1** | 2 × 適合率 × 再現率 ÷ (適合率 + 再現率) | 2 つの調和平均。**どちらかが低いと、F1 も低い** |

- 境界を**たくさん**出せば再現率は上がるが、適合率は下がる(逆も)。だから、片方だけで判断しない。
- 許容は 2 つ見ます。**±3 秒**(打刻の精密さ)と、**±10 秒**(話題の切り替えとして一致するか)。
- ほかに「**打刻のずれ**(中央値・90 パーセンタイル)」と「**区間数の比**(検出 ÷ 正解。0.5〜2 倍なら妥当)」を見ます。

## 5. 基準: 何もしない方法と比べる

F1 の絶対値(0.2 など)だけでは、良いのか悪いのか分かりません。**基準**と比べます。

```python
# 引用: engine/src/chapterlens/baselines.py::fixed_interval
def fixed_interval(duration_s: float, every_s: float = 300.0) -> list[float]:
    if every_s <= 0:
        raise ValueError("every_s は正の数です")
    out: list[float] = []
    t = every_s
    # 末尾の直前(every_s の半分以内)には切れ目を置かない
    while t < duration_s - every_s / 2:
        out.append(t)
        t += every_s
    return out
```
```python
# 引用: engine/src/chapterlens/baselines.py::uniform_k
def uniform_k(duration_s: float, k: int) -> list[float]:
    """k 個の境界を等間隔に置く(区間数は k + 1)。"""
    if k <= 0:
        return []
    return [duration_s * (i + 1) / (k + 1) for i in range(k)]
```

- `fixed-300`: 字幕を見ずに、300 秒ごとに区切る。
- `uniform-k`: 正解と同じ数だけ、**等間隔**に区切る(同じ個数で比べる)。

```python
# 実行できる
from chapterlens.baselines import fixed_interval, uniform_k
from chapterlens.metrics import score_boundaries

ref = [180.0, 420.0, 700.0]          # 正解(話題の切り替えは、等間隔ではない)
print("fixed-300 :", fixed_interval(1000.0, 300.0))
print("uniform-3 :", uniform_k(1000.0, 3))
for name, pred in (("fixed-300", fixed_interval(1000.0, 300.0)), ("uniform-3", uniform_k(1000.0, 3))):
    s = score_boundaries(pred, ref, 10.0)
    print(name, "F1 =", round(s.f1, 3))
```

```text
# 出力
fixed-300 : [300.0, 600.0]
uniform-3 : [250.0, 500.0, 750.0]
fixed-300 F1 = 0.0
uniform-3 F1 = 0.0
```

この例では、どちらの基準も 1 つも当たりません(話題の切り替えは等間隔ではないので)。それでも実データでは、基準も偶然に少し当たります(`uniform-k` の F1 は 0.09〜0.12)。
**検出器が基準を上回って初めて、字幕を使った意味がある**。実データでは、`topic-shift@2` は `uniform-k` の約 1.4〜2.6 倍の F1 でした(`engine/README.md` の評価の節)。

## 6. 過学習: 調整に使ったデータで測らない

パラメータ(窓の幅・しきい値)を**同じデータで調整して、同じデータで測る**と、見かけの精度が上がります(そのデータに合わせ込んだだけ)。これが**過学習**です。

ChapterLens の手順:

1. **調整用**(10 本)でパラメータを選ぶ。
2. **確認用**(別の 10 本)で、効果を見る。
3. データを**追加**(調整に使っていない 19 本)して、もう一度測る。
4. 全部(39 本)で**交差検証**(分割を入れ替えて、使っていないデータで測る)。

結果は、最初の 20 本(プログラミング入門中心)では確認用 0.279 でしたが、**調整に使っていない対談・ポッドキャスト・ニュースなどの 19 本では 0.165**(基準 0.121)でした。
「題材が変わると、精度が落ちる」ことが、**追加のデータで初めて分かった**。だから、現実的な目安は 0.17〜0.24 と書き、会話系は弱い、と README に明記しています。

## 7. 評価ハーネスを使う

```bash
cd engine
uv run python -m chapterlens eval dataset/ --out results/2026-11-14
```

データは `dataset/<動画 ID>/` に、`captions.json3`(字幕)・`chapters.json`(正解)・`meta.json` を置きます。
**動画・音声は置きません**(他人の字幕を含むので、`.gitignore` で git に入れません)。

## 確認問題

1. 予測 `[100, 200]`、正解 `[102, 500]`、許容 3 秒のとき、適合率・再現率・F1 は。
2. 境界を 1 つも出さない検出器の F1 はいくつですか(正解が 3 つあるとき)。
3. 適合率が高く再現率が低いとは、どういう検出器ですか。
4. 調整用データで F1 が 0.28、追加データで 0.165 でした。何が起きたと考えますか。
5. 基準(uniform-k)を、なぜ「正解と同じ個数」にするのですか。

## 解答

1. 当たりは `100↔102` の 1 つ。適合率 1/2 = 0.5、再現率 1/2 = 0.5、F1 = 0.5。
2. 0(適合率は定義上 0、再現率は 0 → F1 は 0)。「正解が 0 個で、予測も 0 個」のときだけ 1 とします。
3. 出した境界はほとんど本物だが、本物の多くを見逃している(**控えめ**な検出器)。
4. 調整用の題材(プログラミング入門)に合わせ込んだ**過学習**と、題材の違い(会話系は話題が連続的)。追加データで、本当の汎化性能が見えた。
5. 個数が違うと、「たくさん出した方が有利」になり、公平に比べられないから。個数を揃えて、**位置の良さだけ**を比べる。

## まとめ

- 先に測る道具を作り、**基準を上回るか**で判断する。
- 境界の対応づけは、許容つきの 1 対 1(貪欲法)。F1 は適合率と再現率の調和平均。
- 調整用と確認用を分け、データを足して、**過学習を見つける**。
- 正解(投稿者のチャプター)は粗い。適合率が低めに出ることを、読み取りに織り込む。
- 次の回は、同じ検出を JavaScript で書き、Python と**同じ結果**にする方法。
