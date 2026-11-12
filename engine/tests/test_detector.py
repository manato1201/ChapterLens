import pytest

from chapterlens.detectors import available, get_detector
from chapterlens.metrics import score_boundaries
from chapterlens.text import tokens

from synth import make_video

LENGTHS = [210, 380, 150, 520, 270, 330]  # 等間隔ではない


def test_registered():
    assert "topic-shift@1" in available()
    with pytest.raises(KeyError):
        get_detector("nope")


def test_tokens_japanese_bigrams_and_english_words():
    assert tokens("機械学習") == ["機械", "械学", "学習"]
    assert tokens("The quick brown fox is Running") == ["quick", "brown", "fox", "running"]
    assert tokens("a") == [] and tokens("") == []


@pytest.mark.parametrize("lang", ["en", "ja"])
@pytest.mark.parametrize("seed", [0, 1, 2])
def test_finds_boundaries_when_count_is_given(lang, seed):
    cues, ref, duration = make_video(LENGTHS, lang=lang, seed=seed)
    det = get_detector("topic-shift@1")
    out = det.detect(cues, duration, target_count=len(ref))
    s = score_boundaries(out.boundaries, ref, 10.0)
    assert s.f1 >= 0.8, (lang, seed, out.boundaries, ref)


@pytest.mark.parametrize("lang", ["en", "ja"])
def test_default_sensitivity_is_reasonable(lang):
    cues, ref, duration = make_video(LENGTHS, lang=lang, seed=3)
    out = get_detector("topic-shift@1").detect(cues, duration)
    s = score_boundaries(out.boundaries, ref, 10.0)
    assert s.recall >= 0.6 and s.precision >= 0.5, (out.boundaries, ref)


def test_boundaries_are_sorted_spaced_and_scored():
    cues, ref, duration = make_video(LENGTHS, lang="en", seed=4)
    out = get_detector("topic-shift@1").detect(cues, duration, target_count=len(ref))
    assert out.boundaries == sorted(out.boundaries)
    assert len(out.boundaries) == len(out.scores)
    assert all(0.0 <= x <= 1.0 for x in out.scores)
    assert all(b - a >= 30.0 for a, b in zip(out.boundaries, out.boundaries[1:]))
    assert all(0 < b < duration for b in out.boundaries)


def test_single_topic_gives_few_or_no_boundaries():
    cues, _, duration = make_video([900], lang="en", seed=5)
    out = get_detector("topic-shift@1").detect(cues, duration)
    assert len(out.boundaries) <= 2


def test_degenerate_inputs():
    det = get_detector("topic-shift@1")
    assert det.detect([], 600.0).boundaries == []
    cues, _, _ = make_video([60], lang="en")
    assert det.detect(cues, 15.0).boundaries == []  # 短すぎる
    assert det.detect(cues, 0.0).boundaries == []


def test_v2_detector_is_registered_and_finds_boundaries():
    assert "topic-shift@2" in available()
    cues, ref, duration = make_video(LENGTHS, lang="en", seed=6)
    det = get_detector("topic-shift@2")
    assert det.name == "topic-shift@2"
    out = det.detect(cues, duration, target_count=len(ref))
    assert score_boundaries(out.boundaries, ref, 10.0).f1 >= 0.8, (out.boundaries, ref)
    assert out.boundaries == sorted(out.boundaries)
    assert all(b - a >= 60.0 for a, b in zip(out.boundaries, out.boundaries[1:]))  # v2 の最小間隔


def test_refine_moves_a_coarse_boundary_to_the_real_topic_change():
    from chapterlens.detectors.topic_shift import PreparedCues, refine_boundaries

    cues, ref, _ = make_video([200, 200], lang="en", seed=7)  # 話題の変わり目は 200 秒
    prepared = PreparedCues(cues)
    # 粗い境界が 20 秒ずれていても、半径内なら本当の変わり目に戻る
    assert refine_boundaries([180.0], prepared, 30.0, 45.0, 30.0) == [200.0]
    # 半径の外には動かない
    assert refine_boundaries([140.0], prepared, 10.0, 45.0, 30.0)[0] != 200.0
    # 近づきすぎた境界は、最小間隔で 1 つになる
    assert len(refine_boundaries([196.0, 204.0], prepared, 10.0, 45.0, 30.0)) == 1
