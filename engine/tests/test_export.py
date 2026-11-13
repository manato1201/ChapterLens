import json
import shutil
import subprocess

import pytest
from synth import make_video

from chapterlens import cli
from chapterlens.captions import Cue
from chapterlens.export import (ExportError, build_filter, chapters_to_marker_edl, check_input, ffmpeg_args, fit_spans, probe,
                                render, retime_cues, spans_to_edl, timecode, to_srt, to_vtt)

HAS_FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")
S = lambda a, b, score=0.5: {"start_s": a, "end_s": b, "score": score}  # noqa: E731


# ---- 時刻の計算 ----
def test_fit_spans_prefers_high_scores_trims_the_last_and_keeps_time_order():
    spans = [S(0, 20, 0.2), S(100, 130, 0.9), S(200, 230, 0.8), S(300, 320, 0.1)]
    out = fit_spans(spans, 50)
    assert [s["start_s"] for s in out] == sorted(s["start_s"] for s in out)
    assert sum(s["end_s"] - s["start_s"] for s in out) <= 50 + 1e-9
    assert out[0]["start_s"] == 100 and out[1]["start_s"] == 200 and out[1]["end_s"] == 220  # 800 点の区間は 20 秒に切る
    assert fit_spans(spans, 2) == []                                                           # 3 秒に満たない残りは使わない
    assert fit_spans([], 59) == []


def test_retime_cues_packs_into_the_cut_timeline_and_clips_boundaries():
    cues = [Cue(0, 10, "a"), Cue(8, 14, "b"), Cue(20, 25, "c"), Cue(40, 45, "d")]
    out = retime_cues(cues, [S(5, 12), S(40, 50)])
    assert [(c.start_s, c.end_s, c.text) for c in out] == [(0.0, 5.0, "a"), (3.0, 7.0, "b"), (7.0, 12.0, "d")]
    assert retime_cues(cues, []) == []
    assert retime_cues([Cue(0, 5, "   ")], [S(0, 5)]) == []  # 空の字幕は捨てる


# ---- 書式 ----
def test_srt_and_vtt_formats():
    cues = [Cue(0.0, 1.5, "こんにちは"), Cue(3661.25, 3662.0, "second")]
    srt = to_srt(cues)
    assert srt.startswith("1\n00:00:00,000 --> 00:00:01,500\nこんにちは\n")
    assert "2\n01:01:01,250 --> 01:01:02,000\nsecond" in srt
    vtt = to_vtt(cues)
    assert vtt.startswith("WEBVTT\n\n00:00:00.000 --> 00:00:01.500")


def test_timecode_non_drop():
    assert timecode(0, 30) == "00:00:00:00"
    assert timecode(61.5, 30) == "00:01:01:15"
    assert timecode(3600, 24) == "01:00:00:00"
    assert timecode(-3, 30) == "00:00:00:00"


def test_spans_to_edl_is_contiguous_on_the_record_side():
    edl = spans_to_edl([S(10, 20), S(100, 105.5)], fps=30, clip_name="talk.mp4")
    lines = edl.splitlines()
    assert lines[0] == "TITLE: ChapterLens digest" and lines[1] == "FCM: NON-DROP FRAME"
    ev = [ln for ln in lines if ln.startswith(("001", "002"))]
    assert ev[0].split()[-4:] == ["00:00:10:00", "00:00:20:00", "00:00:00:00", "00:00:10:00"]
    assert ev[1].split()[-4:] == ["00:01:40:00", "00:01:45:15", "00:00:10:00", "00:00:15:15"]
    assert "* FROM CLIP NAME: talk.mp4" in lines
    with pytest.raises(ExportError):
        spans_to_edl([S(0, 5)], fps=0)
    with pytest.raises(ExportError):
        spans_to_edl([S(0, 5)], fps=29.97)


def test_marker_edl_names_are_single_line_and_include_the_first_chapter():
    edl = chapters_to_marker_edl([120.0, 300.0], ["導入\n改行|縦棒", "", "終わり"], fps=30)
    markers = [ln for ln in edl.splitlines() if ln.startswith(" |C:")]
    assert len(markers) == 3
    assert "|M:導入 改行 縦棒 |" in markers[0] and "|M:Chapter 2 |" in markers[1] and "|M:終わり |" in markers[2]
    assert "01:00:00:00" in edl and "01:02:00:00" in edl


# ---- ffmpeg の引数 ----
def test_build_filter_concat_and_vertical_and_subtitles():
    flt, labels = build_filter([S(1, 3), S(10, 12)], has_audio=True, vertical=True, subtitles="subs.srt", font="Yu Gothic")
    assert labels == ["[vout]", "[aout]"]
    assert "[0:v]trim=start=1.000:end=3.000,setpts=PTS-STARTPTS[v0]" in flt
    assert "[0:a]atrim=start=10.000:end=12.000,asetpts=PTS-STARTPTS[a1]" in flt
    assert "concat=n=2:v=1:a=1[vcat][aout]" in flt
    assert "crop='min(iw,ih*9/16)'" in flt and "scale=1080:1920" in flt
    assert "subtitles=subs.srt:force_style='FontName=Yu Gothic," in flt
    flt2, labels2 = build_filter([S(0, 2)], has_audio=False)
    assert labels2 == ["[vout]"] and "a=0[vcat]" in flt2 and "[vcat]null[vout]" in flt2 and "atrim" not in flt2


def test_build_filter_rejects_unsafe_subtitle_names_and_empty_spans():
    for bad in ["a b.srt", "x';rm", "../x.srt", "C:/x.srt", "a,b.srt"]:
        with pytest.raises(ExportError):
            build_filter([S(0, 2)], has_audio=True, subtitles=bad)
    with pytest.raises(ExportError):
        build_filter([], has_audio=True)


def test_ffmpeg_args_never_go_through_a_shell():
    args = ffmpeg_args("in file.mp4", "out.mp4", "FLT", ["[vout]", "[aout]"])
    assert isinstance(args, list) and args[args.index("-i") + 1] == "in file.mp4"
    assert args[-1] == "out.mp4" and "libx264" in args and "aac" in args


# ---- 権利の関門(S-A のように、ここでも「明示」を要求する) ----
def test_check_input_requires_own_and_a_local_video_file(tmp_path):
    f = tmp_path / "mine.mp4"
    f.write_bytes(b"x")
    with pytest.raises(ExportError, match="--own"):
        check_input(str(f), own=False)
    for url in ["https://www.youtube.com/watch?v=abc", "http://example.com/a.mp4", "ftp://h/a.mp4", "youtu.be/abc", "www.youtube.com/x.mp4"]:
        with pytest.raises(ExportError):
            check_input(url, own=True)
    with pytest.raises(ExportError):
        check_input(str(tmp_path / "missing.mp4"), own=True)
    txt = tmp_path / "a.txt"
    txt.write_text("x")
    with pytest.raises(ExportError):
        check_input(str(txt), own=True)
    assert check_input(str(f), own=True) == f


def test_cli_refuses_without_own_and_never_touches_ffmpeg(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("CHAPTERLENS_HOME", str(tmp_path / "home"))
    cues, _, _ = make_video([200, 200], lang="en", seed=1)
    srt = tmp_path / "c.srt"
    srt.write_text(to_srt(cues), encoding="utf-8")
    vid = tmp_path / "v.mp4"
    vid.write_bytes(b"not a video")
    code = cli.main(["export", "short", str(vid), str(srt), "--out", str(tmp_path / "o.mp4")])
    assert code == 1 and "--own" in capsys.readouterr().err
    assert not (tmp_path / "o.mp4").exists()


# ---- CLI(テキストの出力。ffmpeg は使わない) ----
@pytest.fixture
def captions_file(tmp_path):
    cues, ref, _ = make_video([300, 420, 240, 360], lang="en", seed=3)
    p = tmp_path / "talk.srt"
    p.write_text(to_srt(cues), encoding="utf-8")
    return p, cues, ref


def test_cli_digest_edl_subtitles_and_chapters_edl(captions_file, tmp_path, capsys):
    p, cues, _ = captions_file
    assert cli.main(["digest", str(p), "--out", str(tmp_path / "d.json")]) == 0
    doc = json.loads((tmp_path / "d.json").read_text(encoding="utf-8"))
    assert doc["schema"] == "chapterlens/digest@1" and doc["spans"] and doc["boundaries"]
    assert cli.main(["export", "edl", str(p), "--out", str(tmp_path / "d.edl"), "--clip-name", "talk.mp4"]) == 0
    assert "AA/V" in (tmp_path / "d.edl").read_text(encoding="utf-8")
    assert cli.main(["export", "subtitles", str(p), "--digest", "--format", "vtt", "--out", str(tmp_path / "d.vtt")]) == 0
    vtt = (tmp_path / "d.vtt").read_text(encoding="utf-8")
    assert vtt.startswith("WEBVTT") and vtt.count("-->") < len(cues)  # 詰め直しで、字幕が減る
    assert cli.main(["export", "chapters-edl", str(p), "--out", str(tmp_path / "m.edl")]) == 0
    assert "|M:" in (tmp_path / "m.edl").read_text(encoding="utf-8")


def test_cli_reports_errors_in_japanese_without_traceback(tmp_path, capsys):
    empty = tmp_path / "e.srt"
    empty.write_text("", encoding="utf-8")
    assert cli.main(["digest", str(empty)]) == 1
    assert "エラー" in capsys.readouterr().err


# ---- 本物の ffmpeg(合成の動画。他人の動画は使わない) ----
@pytest.fixture(scope="module")
def sample_video(tmp_path_factory):
    d = tmp_path_factory.mktemp("media")
    out = d / "sample.mp4"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=120",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=120", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(out)],
        check=True, timeout=120,
    )
    return out


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg が無い")
def test_render_vertical_short_with_burned_subtitles(sample_video, tmp_path):
    cues = [Cue(float(t), float(t + 4), f"subtitle line {t}") for t in range(0, 120, 4)]
    spans = [S(10, 20), S(60, 70)]
    out = tmp_path / "short.mp4"
    info = render(sample_video, out, spans, cues, vertical=True, burn_subtitles=True)
    assert info["spans"] == 2 and info["subtitles"] is True and info["seconds"] == 20.0
    p = probe(out)
    assert (p["width"], p["height"]) == (1080, 1920) and p["has_audio"]
    assert abs(p["duration_s"] - 20.0) < 0.6


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg が無い")
def test_render_highlights_keeps_aspect_and_clamps_to_the_video_length(sample_video, tmp_path):
    out = tmp_path / "hl.mp4"
    info = render(sample_video, out, [S(5, 15), S(110, 400)], [], vertical=False, burn_subtitles=False)
    p = probe(out)
    assert (p["width"], p["height"]) == (1280, 720) and info["subtitles"] is False
    assert abs(p["duration_s"] - 20.0) < 0.6  # 2 つ目は動画の終わり(120 秒)で切る


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg が無い")
def test_render_errors_are_explained(sample_video, tmp_path):
    with pytest.raises(ExportError, match="区間がありません"):
        render(sample_video, tmp_path / "x.mp4", [S(500, 600)], [])
    with pytest.raises(ExportError, match="同じ"):
        render(sample_video, sample_video, [S(0, 5)], [])
    bad = tmp_path / "broken.mp4"
    bad.write_bytes(b"not a video")
    with pytest.raises(ExportError, match="読めません"):
        render(bad, tmp_path / "y.mp4", [S(0, 5)], [])


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg が無い")
def test_cli_short_end_to_end_and_audit_has_no_paths(sample_video, tmp_path, monkeypatch, capsys):
    home = tmp_path / "home"
    monkeypatch.setenv("CHAPTERLENS_HOME", str(home))
    cues, _, _ = make_video([30, 30, 30, 30], lang="en", seed=2)
    srt = tmp_path / "c.srt"
    srt.write_text(to_srt(cues), encoding="utf-8")
    out = tmp_path / "short.mp4"
    code = cli.main(["export", "short", str(sample_video), str(srt), "--own", "--max-s", "30", "--out", str(out), "--duration", "120"])
    assert code == 0, capsys.readouterr().err
    p = probe(out)
    assert (p["width"], p["height"]) == (1080, 1920) and p["duration_s"] <= 31
    log = (home / "audit.log").read_text(encoding="utf-8")
    assert "export.short" in log and "sample.mp4" not in log and str(tmp_path) not in log


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg が無い")
def test_render_refuses_to_overwrite_unless_asked(sample_video, tmp_path):
    out = tmp_path / "keep.mp4"
    out.write_bytes(b"precious")
    with pytest.raises(ExportError, match="同じ名前"):
        render(sample_video, out, [S(0, 5)], [], burn_subtitles=False)
    assert out.read_bytes() == b"precious"
    render(sample_video, out, [S(0, 5)], [], burn_subtitles=False, overwrite=True)
    assert out.stat().st_size > 1000


def test_ffmpeg_timeouts_and_launch_failures_become_explained_errors(monkeypatch):
    from chapterlens import export

    def boom_timeout(*a, **k):
        raise subprocess.TimeoutExpired(cmd="ffmpeg", timeout=1)

    def boom_os(*a, **k):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(export.subprocess, "run", boom_timeout)
    with pytest.raises(ExportError, match="終わりませんでした"):
        export._run(["/x/ffmpeg"], timeout_s=1)
    monkeypatch.setattr(export.subprocess, "run", boom_os)
    with pytest.raises(ExportError, match="起動できません"):
        export._run(["/x/ffmpeg"], timeout_s=1)
