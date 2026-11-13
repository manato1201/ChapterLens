# 第 2 回 文字・正規表現・分かち書き

> 所要時間の目安: 3 時間 / 前提: 第 1 回

## この回のゴール

- 文字(`str`)とバイト(`bytes`)、UTF-8 の関係を説明できる。
- 正規表現の基本(文字クラス・量指定子)を使い、`text.py` の 2 つの正規表現を読める。
- 日本語を**形態素解析器なしで**語に分ける方法(文字の 2 つ組 = bigram)と、その長所・短所を説明できる。
- `tokens` を使って、字幕の 1 行を「語の袋(bag of words)」にできる。

## 1. 文字とバイト

コンピュータが保存・送受信するのは**バイト**(0〜255 の数の並び)です。人が読む**文字**との対応が**文字コード**で、現在は **UTF-8** が標準です。

```python
# 実行できる
text = "日本語 abc"
data = text.encode("utf-8")
print(len(text), "文字 /", len(data), "バイト")
print(data[:6])
print(data.decode("utf-8"))
```

```text
# 出力
7 文字 / 13 バイト
b'\xe6\x97\xa5\xe6\x9c\xac'
日本語 abc
```

- 日本語 1 文字は UTF-8 で **3 バイト**、英数字は 1 バイト。
- 文字(`len(text)`)の数と、バイト(`len(data)`)の数は一致しません。**WAV の長さ**(第 8 回)や、**HTTP の本文の長さ**(第 9 回 `Content-Length`)を数えるときは、バイトで考えます。

## 2. 日本語を「語」に分ける問題

英語は空白で単語に分けられます。日本語は空白が無いので、「どこまでが 1 語か」が自明ではありません。
本格的には**形態素解析器**(MeCab・Sudachi など)を使いますが、これは辞書が要り、インストールが重く、**ブラウザ拡張の中では動かしにくい**。

ChapterLens は、**文字の 2 つ組(bigram)**で近似します。

| 入力 | 分け方 | 結果 |
|---|---|---|
| 機械学習 | 2 文字ずつずらす | 機械, 械学, 学習 |
| machine learning | 空白で分け、短い語・ありふれた語を除く | machine, learning |

- 長所: 辞書が要らない。拡張(JavaScript)にも数行で移せる。未知語(固有名詞・新語)に強い。
- 短所: 「機械」「械学」のように、意味のない組が混じる。語の境界が正しくない。

「話題が変わると、使う語の分布が変わる」ことを見るだけなので、この近似で足ります(精度は第 5 回で測ります)。

## 3. 正規表現

`text.py` の正規表現は 2 つです。

```python
# 引用: engine/src/chapterlens/text.py::tokens
def tokens(text: str) -> list[str]:
    out: list[str] = []
    lowered = text.lower()
    for run in _CJK_RUN.findall(lowered):
        if len(run) == 1:
            continue
        out.extend(run[i : i + 2] for i in range(len(run) - 1))
    for word in _LATIN_WORD.findall(_CJK_RUN.sub(" ", lowered)):
        if len(word) >= 3 and word not in _STOP:
            out.append(word)
    return out
```

- `_CJK_RUN` は、かな・漢字・半角カナの**連なり**(`+` は 1 回以上の繰り返し)に一致します。
  `[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]` の `-` は「ここからここまでの文字コード範囲」です。
- `_LATIN_WORD` は `[a-z][a-z0-9']+`(英小文字で始まる、2 文字以上)です。

```python
# 実行できる
import re

CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]+")
print(CJK.findall("今日は machine learning と機械学習の話"))
print(re.findall(r"[a-z][a-z0-9']+", "it's a test of 3d models"))
```

```text
# 出力
['今日は', 'と機械学習の話']
["it's", 'test', 'of', 'models']
```

## 4. `tokens` の動きを確かめる

```python
# 実行できる
from chapterlens.text import tokens, term_counts

print(tokens("機械学習"))
print(tokens("The quick brown fox is Running"))   # 大文字は小文字に・短い語/ストップワードは除く
print(tokens("日"))                                  # 1 文字の連なりは捨てる
print(term_counts("機械学習と機械学習"))
```

```text
# 出力
['機械', '械学', '学習']
['quick', 'brown', 'fox', 'running']
[]
Counter({'機械': 2, '械学': 2, '学習': 2, '習と': 1, 'と機': 1})
```

- **ストップワード**(`the`・`and`・`that` など、どの話題にも出る語)は除きます。除かないと、全部の区間が似て見えます。
- 1 文字の連なり(「日」「は」だけ)は、2 つ組が作れないので捨てます。
- 全部小文字にしてから数えます(`Running` と `running` を同じ語にする)。

## 5. 同じ結果になる JavaScript 版

拡張の `core.js` にも、同じ分かち書きがあります。正規表現の書き方と、2 つ組を作る手順が、Python と**同じ結果**になるよう書いてあります。

```javascript
// 抜粋ファイル: extension/src/core.js
  const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]+/g;
  const LATIN_WORD = /[a-z][a-z0-9']+/g;
  function tokens(text) {
    const out = [];
    const lowered = text.toLowerCase();
    for (const run of lowered.match(CJK_RUN) || []) {
      if (run.length === 1) continue;
      for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    }
```

JavaScript の `g` フラグつきの正規表現は、`match` が全部の一致を配列で返します。一致が無いと `null` なので `|| []` が必要です(Python の `findall` は空リスト)。
**言語の細かな違いを吸収する**のが、移植の仕事です。

## 確認問題

1. 「自然言語処理」を `tokens` に通すと、何個の語になりますか(予想してから実行)。
2. なぜ「the」「and」を除くのですか。
3. 「ABC」(大文字 3 字)は `tokens` で何になりますか。
4. 日本語の分かち書きに形態素解析器を使わなかった理由を 2 つ挙げてください。

## 解答

1. 6 文字の連なりなので、5 個(自然, 然言, 言語, 語処, 処理)。
2. どの話題にも出る語が、区間どうしの類似度を一律に押し上げ、話題の違いを見えにくくするため。
3. `abc` の 1 語。小文字にしてから、英語の語として数えます(3 文字以上・ストップワードでない)。
4. 辞書が要り、インストールが重いこと。ブラウザ拡張の中で動かしにくく、JavaScript と同じ結果を保証しにくいこと。

## まとめ

- 文字とバイトは別物。長さの数え方を、場面で使い分ける。
- 日本語は、文字の 2 つ組(bigram)で語の代わりにする。辞書が要らず、拡張にも移せる。
- 英語は、空白で分け、短い語・ストップワードを除く。
- 次の回は、語を「重み」づけして、2 つの区間がどれだけ似ているかを数にする。
