import json

import pytest

from chapterlens.captions import parse_json3, parse_srt, parse_vtt, parse_captions
from chapterlens.chapters import boundaries_from_chapters, parse_description_chapters


def test_vtt_basic_and_tags():
    vtt = (
        "WEBVTT\n\n"
        "00:00:01.000 --> 00:00:03.500\nこんにちは<c> みなさん</c>\n\n"
        "00:00:03.500 --> 00:00:05.000 align:start\nHello &amp; welcome\n"
    )
    cues = parse_vtt(vtt)
    assert [(c.start_s, c.end_s) for c in cues] == [(1.0, 3.5), (3.5, 5.0)]
    assert cues[0].text == "こんにちは みなさん"
    assert cues[1].text == "Hello & welcome"


def test_vtt_hours_and_crlf():
    cues = parse_vtt("WEBVTT\r\n\r\n01:02:03.004 --> 01:02:05.000\r\nline\r\n")
    assert cues[0].start_s == pytest.approx(3723.004)


def test_vtt_rolling_auto_captions_are_deduplicated():
    vtt = (
        "WEBVTT\n\n"
        "00:00:00.000 --> 00:00:02.000\nfirst line\n\n"
        "00:00:02.000 --> 00:00:04.000\nfirst line\nsecond line\n\n"
        "00:00:04.000 --> 00:00:06.000\nsecond line\nthird line\n"
    )
    assert [c.text for c in parse_vtt(vtt)] == ["first line", "second line", "third line"]


def test_srt_with_comma_milliseconds():
    srt = "1\n00:00:01,200 --> 00:00:02,800\nabc\n\n2\n00:00:03,000 --> 00:00:04,000\ndef\n"
    cues = parse_srt(srt)
    assert [(c.start_s, c.text) for c in cues] == [(1.2, "abc"), (3.0, "def")]


def test_json3_skips_empty_events():
    data = {
        "events": [
            {"tStartMs": 0, "dDurationMs": 1000},  # segs なし
            {"tStartMs": 1000, "dDurationMs": 2000, "segs": [{"utf8": "hel"}, {"utf8": "lo\n"}]},
            {"tStartMs": 3000, "dDurationMs": 500, "segs": [{"utf8": "\n"}]},
        ]
    }
    cues = parse_json3(json.dumps(data))
    assert len(cues) == 1 and cues[0].text == "hello" and cues[0].end_s == 3.0


def test_parse_captions_by_extension(tmp_path):
    p = tmp_path / "x.vtt"
    p.write_text("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\na\n", encoding="utf-8")
    assert len(parse_captions(p)) == 1
    bad = tmp_path / "x.txt"
    bad.write_text("x", encoding="utf-8")
    with pytest.raises(ValueError):
        parse_captions(bad)


DESC = """この動画について
0:00 導入
1:30 - 基本の説明
12:05 ・応用
1:02:03 まとめ
SNS: https://example.com/x
"""


def test_chapters_valid():
    ch = parse_description_chapters(DESC)
    assert [(s, t) for s, t in ch] == [(0.0, "導入"), (90.0, "基本の説明"), (725.0, "応用"), (3723.0, "まとめ")]
    assert boundaries_from_chapters(ch) == [90.0, 725.0, 3723.0]


@pytest.mark.parametrize(
    "text",
    [
        "0:00 a\n1:00 b",  # 3 つ未満
        "0:10 a\n1:00 b\n2:00 c",  # 先頭が 0:00 でない
        "0:00 a\n2:00 b\n1:00 c",  # 昇順でない
        "",
    ],
)
def test_chapters_invalid_returns_empty(text):
    assert parse_description_chapters(text) == []


def test_chapters_bracket_and_symbols():
    ch = parse_description_chapters("▶ [0:00] イントロ\n- (2:10) 本編\n* 5:00: おわり")
    assert [s for s, _ in ch] == [0.0, 130.0, 300.0]
    assert ch[2][1] == "おわり"
