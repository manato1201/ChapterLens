"""正解データ: 投稿者が概要欄に書いたチャプター(「0:00 導入」の形)を読む。

YouTube の規則に合わせ、**先頭が 0:00・3 つ以上・昇順**のときだけ「チャプター付き」と扱う。
"""

from __future__ import annotations

import re

_LINE = re.compile(
    r"""^\s*(?:[-•*▶►▸>]+\s*)?                       # 行頭の記号
        [\(\[]?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[\)\]]?  # 時刻 (h:)mm:ss
        \s*(?:[-–—―:|・)\]]\s*)?                       # 区切り
        (.*\S)?\s*$""",
    re.VERBOSE,
)


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


def boundaries_from_chapters(chapters: list[tuple[float, str]]) -> list[float]:
    """区間の切れ目(先頭の 0 秒は除く)。"""
    return [start for start, _ in chapters[1:]]
