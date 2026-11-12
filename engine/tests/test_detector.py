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
