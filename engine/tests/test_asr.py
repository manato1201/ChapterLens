import struct
import wave

import pytest

from chapterlens.asr import (
    AsrUnavailable,
    Word,
    cues_from_words,
    decode_audio,
    snap_to_utterances,
    utterance_starts,
)

np = pytest.importorskip(
    "numpy"
)  # numpy は asr の任意の依存に入る(無ければ、音声のデコードのテストを飛ばす)


def W(start, end, text="x"):
    return Word(start, end, text)


def test_utterance_starts_uses_pauses():
    words = [W(0.0, 0.4), W(0.45, 0.9), W(2.0, 2.4), W(2.45, 2.8), W(5.0, 5.3)]
    assert utterance_starts(words, min_pause_s=0.35) == [
        0.0,
        2.0,
        5.0,
    ]  # 間の後の単語だけ
    assert utterance_starts([], min_pause_s=0.35) == []


def test_snap_moves_to_the_nearest_utterance_head():
    words = [
        W(10.0, 10.4),
        W(10.45, 10.9),
        W(12.0, 12.4),
        W(12.45, 12.9),
        W(20.0, 20.4),
    ]
    # 11.6 → 近い「発話の頭」は 12.0
    assert snap_to_utterances([11.6], words, radius_s=5.0) == [12.0]
    # 発話の頭が遠ければ、近い単語の開始へ
    assert snap_to_utterances([10.8], words, radius_s=0.5) == [10.45]
    # 半径の外なら動かさない
    assert snap_to_utterances([15.0], words, radius_s=1.0) == [15.0]
    assert snap_to_utterances([1.0], [], radius_s=5.0) == [1.0]


def test_cues_from_words_splits_on_pauses_and_length_and_joins_languages():
    en = [W(0, 0.5, "hello"), W(0.55, 1.0, "world"), W(3.0, 3.4, "again")]
    cues = cues_from_words(en, max_cue_s=6.0, pause_s=0.5)
    assert [c.text for c in cues] == ["hello world", "again"]
    assert [(c.start_s, c.end_s) for c in cues] == [(0, 1.0), (3.0, 3.4)]
    ja = [W(0, 0.3, "こんにちは"), W(0.3, 0.6, "世界")]
    assert cues_from_words(ja)[0].text == "こんにちは世界"  # かな・漢字は詰める
    long = [
        W(i * 0.5, i * 0.5 + 0.4, "w") for i in range(30)
    ]  # 15 秒ぶん → 6 秒ごとに分かれる
    assert len(cues_from_words(long, max_cue_s=6.0)) >= 2


def _write_wav(path, seconds=1.0, rate=16000, channels=1):
    n = int(seconds * rate)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels), w.setsampwidth(2), w.setframerate(rate)
        w.writeframes(
            b"".join(
                struct.pack("<h", 1000 if i % 2 else -1000) for i in range(n * channels)
            )
        )


def test_decode_audio_reads_16k_mono_wav_without_ffmpeg(tmp_path):
    p = tmp_path / "a.wav"
    _write_wav(p, 0.5)
    audio = decode_audio(p)
    assert audio.dtype == np.float32 and len(audio) == 8000
    assert abs(float(audio[1]) - 1000 / 32768) < 1e-6


def test_decode_audio_reports_unreadable_input(tmp_path):
    p = tmp_path / "broken.webm"
    p.write_bytes(b"not audio")
    with pytest.raises(AsrUnavailable):
        decode_audio(p)
