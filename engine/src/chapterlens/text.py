"""言語に依存しすぎない軽い分かち書き(CH0 用)。

- 日本語・中国語(かな・漢字): 文字の 2 つ組(bigram)。形態素解析器を入れずに済む
- 英語など: 単語。短い・よく出る語は除く
形態素解析・文の埋め込みへの差し替えは、評価ハーネスで効果を測ってから(設計書 §5 の「足すときは外す」)。
"""

from __future__ import annotations

import re
from collections import Counter

_CJK_RUN = re.compile(r"[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]+")
_LATIN_WORD = re.compile(r"[a-z][a-z0-9']+")

_STOP = frozenset(
    """the and that this with for you are was have not but what all can will from they there about
    would which their just like going gonna here then when your into some them one out has had were been
    its it's i'm you're that's don't can't let's also very really right okay yeah well now get got""".split()
)


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


def term_counts(text: str) -> Counter:
    return Counter(tokens(text))
