import pytest

from chapterlens.corrections import (
    CorrectionError,
    CorrectionStore,
    apply_corrections,
    to_reference,
)


def C(action, from_s=None, to_s=None, i=0):
    return {"id": i, "action": action, "from_s": from_s, "to_s": to_s, "created_at": i}


def test_move_add_delete():
    base = [100.0, 300.0, 500.0]
    assert apply_corrections(base, [C("move", 302, 310)]) == [
        100.0,
        310,
        500.0,
    ]  # 近く(±3 秒)の境界を動かす
    assert apply_corrections(base, [C("add", to_s=400)]) == [100.0, 300.0, 400, 500.0]
    assert apply_corrections(base, [C("delete", 299)]) == [100.0, 500.0]


def test_far_move_adds_and_missing_delete_is_ignored():
    base = [100.0]
    assert apply_corrections(base, [C("move", 200, 250)]) == [
        100.0,
        250,
    ]  # 近くに無ければ、足す
    assert apply_corrections(base, [C("delete", 900)]) == [100.0]
    assert apply_corrections(base, [C("add", to_s=100.5)]) == [
        100.0
    ]  # 1 秒以内の重複は足さない


def test_corrections_apply_in_order_and_do_not_mutate_input():
    base = [100.0, 300.0]
    corr = [C("delete", 100, i=1), C("add", to_s=100, i=2)]  # 消してから、同じ所に足す
    assert apply_corrections(base, corr) == [100, 300.0]
    assert base == [100.0, 300.0]


def test_to_reference_shape():
    ref = to_reference([300.0, 100.0], ["a", "b", "c"])
    assert ref == {
        "chapters": [
            {"start_s": 0.0, "title": "a"},
            {"start_s": 100.0, "title": "b"},
            {"start_s": 300.0, "title": "c"},
        ]
    }


def test_store_roundtrip_and_apply():
    s = CorrectionStore()
    s.record("me", "vid1", "move", from_s=300, to_s=310)
    s.record("me", "vid1", "add", to_s=500)
    assert [c["action"] for c in s.list("me", "vid1")] == ["move", "add"]
    assert s.corrected("me", "vid1", [100.0, 300.0]) == [100.0, 310, 500]
    assert s.stats("me") == {"by_action": {"move": 1, "add": 1}, "videos": 1}


def test_store_separates_owners_and_videos():
    s = CorrectionStore()
    s.record("alice", "vid1", "add", to_s=500)
    assert s.list("bob", "vid1") == []  # 他の人の修正は見えない(S-F)
    assert s.list("alice", "vid2") == []
    assert s.corrected("bob", "vid1", [100.0]) == [100.0]


def test_undo_last():
    s = CorrectionStore()
    s.record("me", "v", "add", to_s=1)
    s.record("me", "v", "add", to_s=2)
    assert s.undo_last("me", "v") is True
    assert [c["to_s"] for c in s.list("me", "v")] == [1]
    assert s.undo_last("me", "nope") is False


@pytest.mark.parametrize(
    "kwargs",
    [
        dict(video="v", action="explode", to_s=1),
        dict(video="", action="add", to_s=1),
        dict(video="v", action="add"),  # to_s が無い
        dict(video="v", action="move", to_s=1),  # from_s が無い
        dict(video="v", action="delete"),
        dict(video="v", action="add", to_s=-5),
        dict(video="v", action="add", to_s="x"),
        dict(video="v" * 300, action="add", to_s=1),
    ],
)
def test_store_rejects_invalid(kwargs):
    s = CorrectionStore()
    video = kwargs.pop("video")
    action = kwargs.pop("action")
    with pytest.raises(CorrectionError):
        s.record("me", video, action, **kwargs)


def test_store_persists_to_file(tmp_path):
    path = tmp_path / "c.db"
    s = CorrectionStore(path)
    s.record("me", "v", "add", to_s=42)
    s.close()
    assert CorrectionStore(path).list("me", "v")[0]["to_s"] == 42
