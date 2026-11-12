import pytest
from synth import make_video

from chapterlens.captions import Cue
from chapterlens.digest import agreement, select_digest, total_seconds


def _video():
    cues, ref, duration = make_video([300, 420, 240, 360], lang="en", seed=3)
    return cues, ref, duration


def test_spans_are_sorted_disjoint_within_duration_and_near_the_budget():
    cues, ref, duration = _video()
    spans = select_digest(cues, ref, duration, ratio=0.2)
    assert spans
    for a, b in zip(spans, spans[1:]):
        assert a["end_s"] <= b["start_s"]
    assert all(0 <= s["start_s"] < s["end_s"] <= duration for s in spans)
    assert all(0 < s["score"] <= 1 for s in spans)
    share = total_seconds(spans) / duration
    assert 0.1 <= share <= 0.35, share  # 予算 20%(すき間埋めと発話の端で、少し増減する)


def test_every_chapter_is_represented():
    cues, ref, duration = _video()
    spans = select_digest(cues, ref, duration, ratio=0.2)
    edges = [0.0, *ref, duration]
    for lo, hi in zip(edges, edges[1:]):
        assert any(lo <= s["start_s"] < hi for s in spans), f"章 {lo}-{hi} から 1 つも選ばれていない"


def test_larger_ratio_selects_more():
    cues, ref, duration = _video()
    small = total_seconds(select_digest(cues, ref, duration, ratio=0.1))
    big = total_seconds(select_digest(cues, ref, duration, ratio=0.4))
    assert big > small


def test_filler_only_stretches_are_not_selected():
    # 0〜600 秒: 内容のある話(語彙が毎回違う)と、相づちだけの時間を交互に
    cues = []
    t = 0.0
    for k in range(40):
        if k % 2 == 0:
            cues.append(Cue(t, t + 14, f"alpha{k}word beta{k}term gamma{k}idea delta{k}plan"))
        else:
            cues.append(Cue(t, t + 14, "yeah okay right well"))
        t += 15
    spans = select_digest(cues, [], 600.0, ratio=0.3)
    assert spans
    for s in spans:  # 選ばれた区間は、内容のある(偶数番の)かたまりを含む
        first_unit = int(s["start_s"] // 15)
        assert first_unit % 2 == 0, s


def test_degenerate_inputs_return_empty_without_error():
    cues, ref, duration = _video()
    assert select_digest([], ref, duration) == []
    assert select_digest(cues, ref, 0) == []
    assert select_digest(cues, ref, 10) == []  # 1 かたまりしかない
    assert select_digest(cues, ref, duration, ratio=0) == []
    assert select_digest(cues, ref, duration, ratio=1.5) == []
    assert select_digest([Cue(0, 5, "yeah okay")], [], 300) == []  # 語が 1 つも無い


def test_deterministic_and_boundary_input_order_does_not_matter():
    cues, ref, duration = _video()
    a = select_digest(cues, ref, duration)
    b = select_digest(cues, list(reversed(ref)), duration)
    assert a == b == select_digest(cues, ref, duration)


def test_long_final_cue_does_not_inflate_the_span():
    cues = [Cue(float(i * 15), float(i * 15 + 10), f"topic{i}alpha topic{i}beta topic{i}gamma") for i in range(19)]
    cues.append(Cue(285.0, 900.0, "finalword lastthing endpart"))  # 長すぎる最後の字幕
    spans = select_digest(cues, [], 300.0, ratio=1.0)
    assert spans[-1]["end_s"] <= 300.0


def S(a, b):
    return {"start_s": a, "end_s": b}


def test_agreement_overlap_math():
    assert agreement([S(0, 10)], [S(0, 10)])["f1"] == 1.0
    r = agreement([S(0, 10)], [S(5, 15)])
    assert r["precision"] == 0.5 and r["recall"] == 0.5 and r["f1"] == 0.5
    r = agreement([S(0, 10), S(20, 30)], [S(0, 30)])
    assert r["precision"] == 1.0 and r["recall"] == pytest.approx(20 / 30, abs=1e-4)
    assert agreement([S(0, 10)], [S(50, 60)])["f1"] == 0.0
    assert agreement([], [])["f1"] == 1.0
    assert agreement([S(0, 10)], [])["f1"] == 0.0
    assert agreement([], [S(0, 10)])["recall"] == 0.0
    # 重なった区間は 1 つにまとめて数える(二重に数えない)
    assert agreement([S(0, 10), S(5, 10)], [S(0, 10)])["precision"] == 1.0


def test_long_single_chapter_video_is_fast():
    # 3 時間・章の境界なし(1 つの章が 720 かたまり)。章の「自分以外」を毎回作り直すと二乗で遅くなる
    import time

    cues = [Cue(float(t), float(t + 4), f"topic{t % 97}alpha topic{t % 89}beta word{t}gamma") for t in range(0, 10800, 4)]
    t0 = time.time()
    spans = select_digest(cues, [], 10800.0)
    assert spans and time.time() - t0 < 5.0
