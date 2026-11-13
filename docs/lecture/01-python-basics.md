# 第 1 回 Python の基礎(この道具で使う範囲)

> 所要時間の目安: 3 時間 / 前提: 第 0 回

## この回のゴール

- `dataclass`・型ヒント・内包表記・`Counter`・`bisect` を読んで、書ける。
- 「**不変(frozen)** なデータ」と「**純粋な関数**」が、なぜ保守しやすいかを説明できる。
- `snap` のような、実際の 20 行の関数を、1 行ずつ説明できる。
- 例外(`raise`・`try`)の使い分けが分かる。

## 1. データを持つ入れ物: `dataclass`

字幕 1 行は「開始・終了・文」の 3 つ組です。ChapterLens ではこれを `Cue` という名前の型にしています。

```python
# 引用: engine/src/chapterlens/captions.py::Cue
@dataclass(frozen=True)
class Cue:
    start_s: float
    end_s: float
    text: str
```

- `@dataclass(frozen=True)` は、**作った後に変更できない**(不変の)データ型を作ります。
  `__init__`・`__repr__`・`==` が自動で付きます。
- `start_s: float` は **型ヒント**です。実行時に強制はされませんが、読む人・エディタ・型検査が助かります。
- なぜ不変にするか: 字幕のリストを複数の関数が受け渡すとき、**誰かが途中で書き換えて、別の関数の結果が変わる**事故を、型の段階で防ぐためです。

```python
# 実行できる
from dataclasses import FrozenInstanceError
from chapterlens.captions import Cue

c = Cue(10.0, 14.5, "こんにちは")
print(c)
print(c == Cue(10.0, 14.5, "こんにちは"))
try:
    c.start_s = 99.0
except FrozenInstanceError as e:
    print("書き換えは拒否される:", type(e).__name__)
```

```text
# 出力
Cue(start_s=10.0, end_s=14.5, text='こんにちは')
True
書き換えは拒否される: FrozenInstanceError
```

## 2. 数える: `collections.Counter`

「語が何回出たか」を数えるのは、この道具の基本動作です。`Counter` は辞書の仲間で、**数えるための専用の型**です。

```python
# 実行できる
from collections import Counter

words = ["guitar", "chord", "guitar", "melody", "guitar"]
c = Counter(words)
print(c)
print(c["guitar"], c["unknown"])        # 無い語は 0(エラーにならない)
c.update(["chord", "chord"])             # 足し込む
print(c.most_common(2))
print(sum(c.values()))
```

```text
# 出力
Counter({'guitar': 3, 'chord': 1, 'melody': 1})
3 0
[('guitar', 3), ('chord', 3)]
7
```

`c["unknown"]` が `0` を返す点が大切です。ライブ検出(`live.py`)は、`self._df[t]` のように、
**存在しない語でも 0 として扱える**ことに頼っています。

## 3. 並んだ数の中を速く探す: `bisect`

字幕は開始時刻の昇順に並んでいます。「ある時刻より後ろの最初の字幕」を、先頭から全部調べず、
**二分探索**(真ん中を見て、探す範囲を半分にしていく)で探せます。それが `bisect` です。

```python
# 実行できる
import bisect

starts = [0.0, 6.0, 12.0, 18.0, 24.0, 30.0]
print(bisect.bisect_left(starts, 12.0))    # 12.0 を入れる左端の位置 → 2
print(bisect.bisect_right(starts, 12.0))   # 右端 → 3
print(bisect.bisect_left(starts, 13.0))    # 間に入る → 3
print(bisect.bisect_left(starts, 99.0))    # 末尾 → 6
```

```text
# 出力
2
3
3
6
```

- `bisect_left(a, x)`: `x` 以上の最初の位置。`bisect_right(a, x)`: `x` より大きい最初の位置。
- 計算量は `O(log n)`。1 時間の動画(字幕 1000 行)でも、約 10 回の比較で済みます。
- 拡張(JavaScript)にはこの関数が無いので、`core.js` に**同じ意味で自作**しています(第 6 回)。

## 4. 実際の関数を読む: `snap`

話題の切り替えは、たいてい「発話の頭」で起きます。計算で出した境界の時刻を、近くの字幕の開始時刻に寄せる関数です。

```python
# 引用: engine/src/chapterlens/detectors/topic_shift.py::snap
def snap(t: float, starts: list[float], step_s: float) -> float:
    """境界を、近くの字幕の開始時刻に寄せる(話題の変わり目は、たいてい発話の頭)。"""
    i = bisect.bisect_left(starts, t)
    best = None
    for j in (i - 1, i):
        if 0 <= j < len(starts) and abs(starts[j] - t) <= step_s / 2:
            if best is None or abs(starts[j] - t) < abs(best - t):
                best = starts[j]
    return best if best is not None else t
```

1 行ずつ読みます。

1. `i = bisect.bisect_left(starts, t)` — `t` を入れる位置。`starts[i-1]` が `t` の直前、`starts[i]` が直後の字幕。
2. `for j in (i - 1, i)` — 直前と直後の 2 つだけが候補。
3. `0 <= j < len(starts)` — 範囲外(先頭より前・末尾より後)を除く。
4. `abs(starts[j] - t) <= step_s / 2` — 近すぎない(ビンの半分以内)ものだけ。
5. `best` — その中で、`t` に最も近いもの。
6. 近くに無ければ、元の `t` をそのまま返す。

```python
# 実行できる
from chapterlens.detectors.topic_shift import snap

starts = [0.0, 6.0, 12.0, 18.0, 24.0]
print(snap(13.0, starts, 10.0))   # 12.0 に寄る
print(snap(15.0, starts, 10.0))   # 12.0 と 18.0 が同じ距離 → 先に見つかった 12.0
print(snap(40.0, starts, 10.0))   # 近くに字幕が無い → そのまま
```

```text
# 出力
12.0
12.0
40.0
```

## 5. 内包表記と「純粋な関数」

```python
# 実行できる
starts = [0.0, 6.0, 12.0]
doubled = [s * 2 for s in starts]                 # リスト内包表記
far = [s for s in starts if s > 5.0]              # 条件つき
pairs = {s: s * 2 for s in starts}                # 辞書内包表記
print(doubled, far, pairs)
```

```text
# 出力
[0.0, 12.0, 24.0] [6.0, 12.0] {0.0: 0.0, 6.0: 12.0, 12.0: 24.0}
```

`snap` は、引数だけを見て値を返し、**ファイル・ネットワーク・グローバルな状態に触れません**。こういう関数を**純粋な関数**と呼びます。

- 同じ入力なら必ず同じ出力 → **テストが簡単**(入力を作って、出力を比べるだけ)。
- 拡張(JavaScript)に**そのまま移植**しやすい(第 6 回)。
- ChapterLens は、検出・ダイジェスト・ライブの核を純粋に保ち、ファイルや通信に触れる部分を、薄い外側(サーバー・CLI)に置いています。

## 6. 例外: 「続けられない」ことを、黙って握りつぶさない

```python
# 引用: engine/src/chapterlens/accounts.py::clean_name
def clean_name(name: object) -> str:
    if not isinstance(name, str):
        raise AccountError("名前は文字列です")
    name = name.strip()
    if not (1 <= len(name) <= 40) or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise AccountError("名前は 1〜40 文字(制御文字なし)で指定してください")
    return name
```

- 入力が不正なとき、`raise AccountError(...)` で**止めます**。黙って直したり、空の名前で続けたりしません。
- 呼ぶ側(サーバー)は `except AccountError` で受けて、利用者に分かる説明つきで `400` を返します。
- **独自の例外型**(`AccountError`)にするのは、「想定した失敗」と「バグ(想定外)」を区別するためです。想定外は `500`、内容は返しません。

```python
# 実行できる
from chapterlens.accounts import AccountError, clean_name

for name in ["  alice  ", "", "x" * 41, "a\nb", 5]:
    try:
        print(repr(clean_name(name)), "→ OK")
    except AccountError as e:
        print(repr(name)[:12], "→ 拒否:", e)
```

```text
# 出力
'alice' → OK
'' → 拒否: 名前は 1〜40 文字(制御文字なし)で指定してください
'xxxxxxxxxxx → 拒否: 名前は 1〜40 文字(制御文字なし)で指定してください
'a\nb' → 拒否: 名前は 1〜40 文字(制御文字なし)で指定してください
5 → 拒否: 名前は文字列です
```

## 確認問題

1. `Counter(["a", "b", "a"])["zzz"]` はいくつですか。通常の `dict` なら何が起きますか。
2. `bisect.bisect_left([1, 3, 3, 5], 3)` と `bisect_right` は、それぞれいくつですか。
3. `snap(5.0, [0.0, 6.0], 10.0)` は何を返しますか(予想してから実行)。
4. `Cue` を不変にする利点を 1 つ挙げてください。
5. 次の関数は純粋ですか。理由も。`def f(x): print(x); return x * 2`

## 解答

1. `0`。通常の `dict` は `KeyError` になります。
2. `1` と `3`。`3` が 2 つあるので、左端は 1、右端は 3(最後の `3` の次)。
3. `6.0`。`5.0` に最も近い開始時刻は `6.0`(距離 1.0 ≦ 5.0)。
4. 受け渡しの途中で書き換えられて、別の場所の結果が変わる事故を防げる(ほかに、辞書のキーにできる・スレッド間で安全)。
5. 純粋ではありません。`print` という**外の世界への出力**(副作用)があるためです。結果は引数だけで決まりますが、副作用がある関数は、テストで出力を捕まえる手間が増えます。

## まとめ

- `dataclass(frozen=True)` で、不変のデータを軽く作れる。
- 数えるのは `Counter`、並んだ数を速く探すのは `bisect`。
- 副作用の無い**純粋な関数**にすると、テストと移植が楽になる。
- 想定した失敗は、独自の例外で**止める**(黙って直さない)。
- 次の回は、字幕の「文」を、検出に使える「語」に分ける(文字・正規表現・分かち書き)。
