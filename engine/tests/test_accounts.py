import json

import pytest

from chapterlens.accounts import AccountError, AccountStore, hash_token
from chapterlens.audit import AuditLog, RateLimiter
from chapterlens.sharing import ShareError, ShareStore, validate_share


# ---- 利用者・token ----
def test_bootstrap_admin_from_token_file():
    a = AccountStore()
    a.ensure_bootstrap_admin("root-token")
    u = a.authenticate("root-token")
    assert u["id"] == "local" and u["role"] == "admin"
    a.ensure_bootstrap_admin("root-token-2")  # token ファイルを作り直したとき
    assert a.authenticate("root-token") is None and a.authenticate("root-token-2")["id"] == "local"


def test_create_user_returns_token_once_and_stores_only_the_hash():
    a = AccountStore()
    user, token = a.create_user("Alice")
    assert user["role"] == "user" and user["id"].startswith("u_") and not user["disabled"]
    assert a.authenticate(token)["id"] == user["id"]
    row = a.db.execute("SELECT token_hash FROM users WHERE id=?", (user["id"],)).fetchone()
    assert row[0] == hash_token(token) and token not in row[0]
    assert token not in json.dumps(a.list_users())  # 一覧に token は出ない


def test_unknown_empty_and_disabled_tokens_are_rejected():
    a = AccountStore()
    user, token = a.create_user("Bob")
    assert a.authenticate("") is None and a.authenticate("nope") is None
    a.set_disabled(user["id"], True)
    assert a.authenticate(token) is None
    a.set_disabled(user["id"], False)
    assert a.authenticate(token)["id"] == user["id"]


def test_rotate_invalidates_old_token():
    a = AccountStore()
    user, old = a.create_user("Carol")
    new = a.rotate_token(user["id"])
    assert a.authenticate(old) is None and a.authenticate(new)["id"] == user["id"]


def test_name_rules_and_uniqueness():
    a = AccountStore()
    a.create_user("Dave")
    for bad in ["", "   ", "x" * 41, "a\nb", 5, None]:
        with pytest.raises(AccountError):
            a.create_user(bad)
    with pytest.raises(AccountError):
        a.create_user("dave")  # 大文字小文字だけ違う名前
    with pytest.raises(AccountError):
        a.create_user("Eve", role="root")


def test_bootstrap_local_cannot_be_disabled_deleted_or_demoted():
    a = AccountStore()
    a.ensure_bootstrap_admin("t")
    for fn in (lambda: a.set_disabled("local", True), lambda: a.set_role("local", "user"),
               lambda: a.rotate_token("local"), lambda: a.delete_user("local")):
        with pytest.raises(AccountError):
            fn()
    assert a.authenticate("t")["role"] == "admin"


def test_user_id_must_be_well_formed():
    a = AccountStore()
    for bad in ["", "u_zzzz", "../x", "u_1234567", "U_12345678"]:
        with pytest.raises(AccountError):
            a.set_disabled(bad, True)
    with pytest.raises(AccountError):
        a.set_disabled("u_00000000", True)  # 形は正しいが、いない


def test_share_mode_default_off_and_validation(tmp_path):
    a = AccountStore(tmp_path / "a.db")
    assert a.share_mode == "off"
    a.set_share_mode("team")
    assert AccountStore(tmp_path / "a.db").share_mode == "team"  # 保存される
    with pytest.raises(AccountError):
        a.set_share_mode("everyone")


# ---- 共有 ----
def V(**over):
    body = {"video": "vidA", "boundaries": [100, 300.5], "duration": 600, "audience": "team"}
    body.update(over)
    return body


def test_validate_share_basic_and_off_mode():
    ok = validate_share(V(titles=["a", "b", "c"]), mode="team", owner_id="u_1", active_ids={"u_1", "u_2"})
    assert ok["boundaries"] == [100.0, 300.5] and ok["audience"] == "team" and ok["titles"] == ["a", "b", "c"]
    with pytest.raises(ShareError, match="無効"):
        validate_share(V(), mode="off", owner_id="u_1", active_ids=set())


@pytest.mark.parametrize(
    "over",
    [
        {"video": ""}, {"video": "x" * 201}, {"video": 5},
        {"boundaries": "x"}, {"boundaries": [0]}, {"boundaries": [-3]}, {"boundaries": [True]}, {"boundaries": [float("nan")]},
        {"boundaries": list(range(1, 502))}, {"boundaries": [700]},
        {"duration": -1}, {"duration": "long"},
        {"titles": ["only one"]}, {"titles": ["a", "b", 3]}, {"titles": ["x" * 61, "b", "c"]},
        {"audience": "everyone"}, {"audience": []}, {"audience": [5]}, {"audience": ["u_zzzzzzzz"]},
        {"transcript": "字幕の全文は共有できない"}, {"cues": []},
    ],
)
def test_validate_share_rejects(over):
    with pytest.raises(ShareError):
        validate_share(V(**over), mode="team", owner_id="u_1", active_ids={"u_1", "u_2"})


def test_named_mode_requires_named_audience_and_not_self():
    with pytest.raises(ShareError):
        validate_share(V(), mode="named", owner_id="u_1", active_ids={"u_1", "u_2"})
    ok = validate_share(V(audience=["u_2"]), mode="named", owner_id="u_1", active_ids={"u_1", "u_2"})
    assert ok["audience"] == ["u_2"]
    with pytest.raises(ShareError):
        validate_share(V(audience=["u_1"]), mode="named", owner_id="u_1", active_ids={"u_1", "u_2"})


def test_share_visibility_rules():
    s = ShareStore()
    names = {"u_a": "A", "u_b": "B", "u_c": "C"}
    s.publish("u_a", validate_share(V(video="v", audience="team"), mode="team", owner_id="u_a", active_ids=set(names)))
    s.publish("u_b", validate_share(V(video="v", audience=["u_c"]), mode="team", owner_id="u_b", active_ids=set(names)))
    seen_by = lambda uid: sorted((x["from"], x["mine"]) for x in s.visible(uid, "v", names))
    assert seen_by("u_a") == [("A", True)]                    # B の共有は A に向いていない
    assert seen_by("u_b") == [("A", False), ("B", True)]
    assert seen_by("u_c") == [("A", False), ("B", False)]
    # 自分の共有にだけ audience が付く(他人の公開範囲は見せない)
    assert all(("audience" in x) == x["mine"] for x in s.visible("u_b", "v", names))
    # 停止された利用者(active でない)の共有は見えない
    assert seen_by("u_c") and [x["from"] for x in s.visible("u_c", "v", {"u_a": "A", "u_c": "C"})] == ["A"]
    assert s.visible("u_a", "other-video", names) == []


def test_share_upsert_revoke_and_delete_owner():
    s = ShareStore()
    v = validate_share(V(video="v"), mode="team", owner_id="u_a", active_ids={"u_a"})
    s.publish("u_a", v)
    s.publish("u_a", {**v, "boundaries": [50.0]})  # 同じ動画は上書き
    assert [x["boundaries"] for x in s.visible("u_a", "v", {"u_a": "A"})] == [[50.0]]
    assert s.revoke("u_a", "v") is True and s.revoke("u_a", "v") is False
    s.publish("u_a", v)
    assert s.delete_owner("u_a") == 1 and s.mine("u_a") == []


# ---- 監査ログ・レート制限 ----
def test_audit_event_keeps_only_short_values(tmp_path):
    log = AuditLog(tmp_path / "audit.log")
    log.event("local", "admin.user.create", target="u_1", note="x" * 500, nested={"a": 1})
    rec = log.tail(5)[0]
    assert rec["event"] == "admin.user.create" and rec["actor"] == "local" and len(rec["note"]) == 120
    assert isinstance(rec["nested"], str)  # 構造のまま入れない


def test_audit_tail_skips_broken_lines_and_limits(tmp_path):
    p = tmp_path / "audit.log"
    p.write_text('{"a":1}\nnot json\n{"a":2}\n', encoding="utf-8")
    log = AuditLog(p)
    assert [r["a"] for r in log.tail(10)] == [1, 2]
    assert [r["a"] for r in log.tail(1)] == [2]


def test_audit_rotates_when_large(tmp_path, monkeypatch):
    import chapterlens.audit as audit

    monkeypatch.setattr(audit, "MAX_LOG_BYTES", 200)
    log = AuditLog(tmp_path / "audit.log")
    for i in range(20):
        log.event("x", "e", i=i)
    assert (tmp_path / "audit.log.1").exists()


def test_rate_limiter_sliding_window():
    now = [0.0]
    rl = RateLimiter({"g": (3, 10.0)}, clock=lambda: now[0])
    assert [rl.check("u", "g") for _ in range(3)] == [None, None, None]
    wait = rl.check("u", "g")
    assert wait is not None and 0 < wait <= 10
    assert rl.check("other", "g") is None      # 利用者ごと
    assert rl.check("u", "unlimited") is None  # 制限のない種類
    now[0] = 10.5
    assert rl.check("u", "g") is None          # 窓が過ぎれば使える
