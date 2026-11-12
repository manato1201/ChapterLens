import json

import pytest

from chapterlens import evaluation
from chapterlens.cli import main
from chapterlens.schema import (
    SCHEMA,
    Segment,
    from_document,
    segments_from_boundaries,
    to_document,
)

from synth import make_video


def _vtt(cues):
    def ts(x):
        return f"{int(x // 3600):02d}:{int(x % 3600 // 60):02d}:{x % 60:06.3f}"

    out = ["WEBVTT", ""]
    for c in cues:
        out += [f"{ts(c.start_s)} --> {ts(c.end_s)}", c.text, ""]
    return "\n".join(out)


def _write_video(root, name, lengths, lang, seed, with_chapters=True):
    cues, ref, duration = make_video(lengths, lang=lang, seed=seed)
    d = root / name
    d.mkdir()
    (d / "meta.json").write_text(json.dumps({"id": name, "language": lang, "duration_s": duration}), encoding="utf-8")
    (d / "captions.vtt").write_text(_vtt(cues), encoding="utf-8")
    if with_chapters:
        chapters = [{"start_s": 0.0, "title": "t0"}] + [
            {"start_s": b, "title": f"t{i + 1}"} for i, b in enumerate(ref)
        ]
        (d / "chapters.json").write_text(json.dumps({"chapters": chapters}), encoding="utf-8")
    return ref


@pytest.fixture
def dataset(tmp_path):
    root = tmp_path / "dataset"
    root.mkdir()
    _write_video(root, "en1", [210, 380, 150, 520, 270, 330], "en", 0)
    _write_video(root, "ja1", [300, 140, 460, 200, 380], "ja", 1)
    _write_video(root, "nochap", [300, 300, 300], "en", 2, with_chapters=False)
    (root / "nocap").mkdir()
    (root / "nocap" / "chapters.json").write_text('{"chapters": []}', encoding="utf-8")
    return root


def test_load_dataset_skips_unusable_with_reason(dataset):
    videos, skipped = evaluation.load_dataset(dataset)
    assert sorted(v["id"] for v in videos) == ["en1", "ja1"]
    assert len(skipped) == 2
    assert any("nochap" in s and "正解" in s for s in skipped)
    assert any("nocap" in s and "字幕" in s for s in skipped)


def test_description_txt_is_accepted_as_reference(tmp_path):
    root = tmp_path / "ds"
    root.mkdir()
    ref = _write_video(root, "d", [200, 300, 250], "en", 0, with_chapters=False)
    desc = "0:00 a\n" + "\n".join(f"{int(b // 60)}:{int(b % 60):02d} t" for b in ref)
    (root / "d" / "description.txt").write_text(desc, encoding="utf-8")
    videos, skipped = evaluation.load_dataset(root)
    assert not skipped and len(videos[0]["ref"]) == 2


def test_evaluate_beats_baselines_on_synthetic_data(dataset):
    videos, _ = evaluation.load_dataset(dataset)
    result = evaluation.evaluate(videos, ["topic-shift@1"])
    assert result["videos"] == 2
    assert set(result["summary"]) >= {"fixed-300", "uniform-k", "topic-shift@1", "topic-shift@1+k"}
    check = result["verdict"]["checks"][0]
    assert check["matched_count"]["passes"] and check["default"]["passes"]
    md = evaluation.render_markdown(result, ["x: 理由"])
    assert "基準を上回る" in md and "評価に使えなかった動画" in md
    assert set(result["by_language"]) == {"en", "ja"}


def test_cli_eval_writes_report(dataset, tmp_path, capsys):
    out = tmp_path / "out"
    assert main(["eval", str(dataset), "--out", str(out)]) == 0
    assert (out / "result.json").exists() and (out / "report.md").exists()
    assert "ChapterLens 評価結果" in capsys.readouterr().out


def test_cli_eval_empty_dataset(tmp_path, capsys):
    empty = tmp_path / "empty"
    empty.mkdir()
    assert main(["eval", str(empty)]) == 1


def test_cli_detect_outputs_valid_document(dataset, tmp_path):
    out = tmp_path / "seg.json"
    assert main(["detect", str(dataset / "en1" / "captions.vtt"), "--target-count", "5", "--out", str(out)]) == 0
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["schema"] == SCHEMA
    segs = from_document(doc)
    assert segs[0].start_s == 0.0 and len(segs) == 6
    assert all(a.end_s == b.start_s for a, b in zip(segs, segs[1:]))


def test_cli_chapters(tmp_path):
    desc = tmp_path / "d.txt"
    desc.write_text("0:00 a\n1:00 b\n2:00 c\n", encoding="utf-8")
    out = tmp_path / "c.json"
    assert main(["chapters", str(desc), "--out", str(out)]) == 0
    assert len(json.loads(out.read_text(encoding="utf-8"))["chapters"]) == 3
    desc.write_text("hello", encoding="utf-8")
    assert main(["chapters", str(desc)]) == 1


def test_schema_roundtrip_and_validation():
    segs = segments_from_boundaries([100.0, 250.0], 400.0, detector="x", scores=[0.9, 0.4])
    assert [(s.start_s, s.end_s) for s in segs] == [(0, 100), (100, 250), (250, 400)]
    assert [s.confidence for s in segs] == [None, 0.9, 0.4]
    doc = to_document({"kind": "t"}, segs, engine="0")
    assert [s.confidence for s in from_document(doc)] == [None, 0.9, 0.4]
    with pytest.raises(ValueError):
        from_document({"schema": "chapterlens/segments@2", "segments": []})
    with pytest.raises(ValueError):
        Segment(10, 5).validate()
    with pytest.raises(ValueError):
        Segment(0, 5, status="maybe").validate()
    # 範囲外・重複の境界は無視される
    assert len(segments_from_boundaries([0.0, 500.0, 100.0], 400.0, detector="x")) == 2
