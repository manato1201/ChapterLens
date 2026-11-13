import pytest
from synth import make_video

from chapterlens.captions import Cue
from chapterlens.live import LiveDetector, LiveParams, replay
from chapterlens.live_eval import evaluate_synthetic

LENGTHS = [210, 380, 150, 520, 270, 330]


@pytest.mark.parametrize("lang", ["en", "ja"])
def test_synthetic_stream_boundaries_are_found_with_bounded_latency(lang):
    cues, ref, _ = make_video(LENGTHS, lang=lang, seed=11)
    det = replay(cues)
    assert len(det.committed) == len(ref)
    for m, r in zip(det.committed, ref):
        assert abs(m["t"] - r) <= 4.0, (m["t"], r)               # 時刻は、変化の始まりに戻して付く
        assert m["tentative_at"] - r <= 20.0                      # 暫定は、変化から約 10 秒
        assert m["tentative_at"] <= m["committed_at"]
        assert m["committed_at"] - r <= 35.0                      # 確定は、変化から約 24 秒+字幕の遅れ
    assert det.pending is None


def test_marker_time_does_not_depend_on_when_it_is_committed():
    cues, ref, _ = make_video(LENGTHS, lang="en", seed=11)
    quick = replay(cues)  # 字幕が 1 つずつ届く
    chunky = LiveDetector()  # 30 秒ぶんずつまとめて届く
    batch: list[Cue] = []
    for c in sorted(cues, key=lambda c: c.end_s):
        batch.append(c)
        if c.end_s >= (len(chunky.committed) + 1) * 0 + (batch[0].start_s + 30):
            chunky.push(batch, now_s=c.end_s)
            batch = []
    chunky.push(batch)
    assert len(chunky.committed) == len(ref)
    for a, b in zip(quick.committed, chunky.committed):
        assert abs(a["t"] - b["t"]) <= 4.0


def test_pending_marker_is_visible_before_it_is_committed_and_is_unique():
    cues, ref, _ = make_video([300, 300], lang="en", seed=5)
    det = LiveDetector()
    seen_pending = False
    for c in sorted(cues, key=lambda c: c.end_s):
        det.push([c], now_s=c.end_s)
        pend = [m for m in det.markers() if m["status"] == "tentative"]
        assert len(pend) <= 1
        if pend:
            seen_pending = True
            assert abs(pend[0]["t"] - ref[0]) <= 6.0
    assert seen_pending
    assert [m["status"] for m in det.markers()] == ["committed"]


def test_brief_aside_isdismissed_not_committed():
    # 同じ話題の中に、10 秒ほど別の語が混ざるだけ → 確定しない
    cues, _, _ = make_video([400], lang="en", seed=2)
    aside = [Cue(200.0, 204.0, "zzaside1 zzaside2 zzaside3 zzaside4 zzaside5 zzaside6"),
             Cue(204.0, 208.0, "zzaside1 zzaside7 zzaside3 zzaside8 zzaside5 zzaside9")]
    kept = [c for c in cues if not (200 <= c.start_s < 208)]
    det = replay(kept + aside)
    assert det.committed == []


def test_silence_or_filler_does_not_create_markers():
    cues = [Cue(float(t), float(t + 4), "yeah okay right well") for t in range(0, 600, 4)]
    det = replay(cues)
    assert det.markers() == []


def test_out_of_order_and_duplicate_pushes_are_handled():
    cues, ref, _ = make_video([200, 200], lang="en", seed=4)
    det = LiveDetector()
    shuffled = sorted(cues, key=lambda c: (c.start_s * 7919) % 101)  # 順不同
    det.push(shuffled, now_s=max(c.end_s for c in cues))
    assert len(det.committed) == 1 and abs(det.committed[0]["t"] - ref[0]) <= 4.0


def test_cue_cap_drops_extra_cues_without_failing():
    det = LiveDetector(LiveParams(max_cues=10))
    det.push([Cue(float(i), float(i + 1), "alpha beta gamma") for i in range(30)])
    assert det.dropped == 20


def test_committed_markers_respect_min_gap_and_order():
    cues, _, _ = make_video([100, 100, 100, 100, 100, 100], lang="en", seed=9)
    det = replay(cues)
    ts = [m["t"] for m in det.committed]
    assert ts == sorted(ts)
    assert all(b - a >= det.p.min_gap_s - 1e-6 for a, b in zip(ts, ts[1:]))


def test_synthetic_evaluation_reports_latencies():
    streams = []
    for seed in (1, 2, 3):
        cues, ref, _ = make_video(LENGTHS, lang="en" if seed % 2 else "ja", seed=seed)
        streams.append((cues, ref))
    r = evaluate_synthetic(streams)
    assert r["missed"] <= 1 and r["extra"] == 0  # 合成 16 本×5 境界の実測では、取りこぼし 2/80
    assert r["tentative_lag_s"]["median"] <= 12 and r["commit_lag_s"]["median"] <= 30
    assert r["offset_s"]["median"] <= 2.0


def test_dense_cues_are_capped_so_one_burst_cannot_blow_up_the_work():
    det = LiveDetector()
    det.push([Cue(100.0 + i * 0.01, 100.5 + i * 0.01, f"alpha{i} beta{i} gamma{i}") for i in range(500)])
    assert len(det._cues) == det.p.max_density and det.dropped == 500 - det.p.max_density
    # 普通の密度(4 秒に 1 つ)は、制限にかからない
    ok = LiveDetector()
    ok.push([Cue(float(t), float(t + 4), f"alpha{t} beta{t}") for t in range(0, 400, 4)])
    assert ok.dropped == 0


def test_old_dismissals_are_forgotten_but_still_counted_and_cues_keep_no_text():
    det = LiveDetector()
    det.dismissed = [10.0, 20.0]
    det.n_dismissed = 2
    det.push([], now_s=1000.0)  # 探す範囲(180 秒)+取り下げの半径より、ずっと先へ進む
    assert det.dismissed == [] and det.n_dismissed == 2
    det.push([Cue(1001.0, 1005.0, "secretword alpha beta")])
    assert not hasattr(det._cues[0], "text") and "secretword" in det._cues[0].counts
