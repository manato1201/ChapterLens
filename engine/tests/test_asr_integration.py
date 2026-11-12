"""実機の ASR を使う統合テスト(任意)。

ふつうの `pytest` では飛ばす。実行するには、テスト音声(tools/make_tts_fixture.py。Windows)を作り、
  CHAPTERLENS_ASR_TESTS=1 uv run --extra asr pytest tests/test_asr_integration.py
GPU が無いと遅い(CPU では実時間より遅い)ので、既定では実行しない。
"""

import json
import os
import statistics
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "results" / "tts"

pytestmark = pytest.mark.skipif(
    os.environ.get("CHAPTERLENS_ASR_TESTS") != "1" or not (FIXTURE / "en.wav").exists(),
    reason="CHAPTERLENS_ASR_TESTS=1 とテスト音声(tools/make_tts_fixture.py)が要る",
)


@pytest.mark.parametrize("lang", ["en", "ja"])
def test_word_timestamps_are_accurate_on_synthetic_speech(lang):
    from chapterlens.asr import transcribe

    truth = json.loads((FIXTURE / f"{lang}.json").read_text(encoding="utf-8"))
    res = transcribe(FIXTURE / f"{lang}.wav", language=lang)
    assert res.language == lang and len(res.words) > 100
    errs = []
    for start in [0.0, *truth["boundaries_s"]]:
        near = [w.start_s for w in res.words if start - 1.0 <= w.start_s <= start + 6.0]
        assert near, f"{start} 秒の近くに単語がない"
        errs.append(min(near, key=lambda s: abs(s - start)) - start)
    # 設計 CH2 の基準: 発話の始まりの時刻のずれが、中央値 1.0 秒以内(実測は 0.04〜0.12 秒)
    assert statistics.median(abs(e) for e in errs) <= 1.0
    assert max(abs(e) for e in errs) <= 2.0
