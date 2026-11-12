"""CH5: ライブ(/v1/live)を、実際の HTTP で確かめる。"""

from conftest import ADMIN, add_user, env  # noqa: F401
from synth import make_video

LENGTHS = [200, 220]


def stream(seed=5):
    cues, ref, _ = make_video(LENGTHS, lang="en", seed=seed)
    return [{"start": c.start_s, "end": c.end_s, "text": c.text} for c in cues], ref


def chunks(cues, size_s=30):
    out, cur, edge = [], [], size_s
    for c in cues:
        while c["end"] > edge:
            out.append((cur, edge))
            cur, edge = [], edge + size_s
        cur.append(c)
    out.append((cur, edge))
    return out


def test_live_session_returns_tentative_then_committed(env):
    call, _ = env
    cues, ref = stream()
    sid = None
    seen = []
    for part, edge in chunks(cues):
        st, out, _ = call("POST", "/v1/live", {"session": sid, "cues": part, "now_s": edge})
        assert st == 200, out
        sid = out["session"]
        seen.append([(m["status"], m["t"]) for m in out["markers"]])
    assert any(m[0] == "tentative" for step in seen for m in step)   # 暫定が先に見える
    last = seen[-1]
    assert [s for s, _ in last] == ["committed"] and abs(last[0][1] - ref[0]) <= 4.0
    assert call("POST", "/v1/live/close", {"session": sid})[1] == {"closed": True}
    assert call("POST", "/v1/live/close", {"session": sid})[1] == {"closed": False}


def test_sessions_are_private_to_their_owner(env):
    call, _ = env
    _, tok = add_user(call, "alice")
    cues, _ = stream()
    _, out, _ = call("POST", "/v1/live", {"cues": cues[:10]})
    sid = out["session"]
    st, out, _ = call("POST", "/v1/live", {"session": sid, "cues": cues[10:12]}, token=tok)  # 他人の ID
    assert st == 404
    assert call("POST", "/v1/live/close", {"session": sid}, token=tok)[1] == {"closed": False}
    assert call("POST", "/v1/live", {"session": sid, "cues": cues[10:12]})[0] == 200          # 本人は続けられる


def test_live_input_validation(env):
    call, _ = env
    good = [{"start": 0, "end": 4, "text": "alpha beta gamma"}]
    for body in [{"cues": "x"}, {"cues": [{"start": "a"}]}, {"cues": good, "now_s": -1}, {"cues": good, "now_s": "9"},
                 {"cues": good, "now_s": True}, {"cues": good, "session": 5}, {"cues": good, "session": "x" * 65},
                 {"cues": [{"start": 5, "end": 1, "text": "x"}]}]:
        assert call("POST", "/v1/live", body)[0] == 400, body
    too_many = [{"start": i, "end": i + 1, "text": "alpha beta"} for i in range(501)]
    assert call("POST", "/v1/live", {"cues": too_many})[0] == 413
    assert call("POST", "/v1/live", {"cues": [], "now_s": 30})[0] == 200  # 無音の間も、時刻だけ進められる
    assert call("POST", "/v1/live", {"session": "0" * 16, "cues": good})[0] == 404


def test_session_count_per_user_is_capped(env):
    call, cfg = env
    ids = [call("POST", "/v1/live", {"cues": []})[1]["session"] for _ in range(6)]
    assert cfg.live.count("local") == 4
    assert call("POST", "/v1/live", {"session": ids[0], "cues": []})[0] == 404  # 古いものから捨てられた
    assert call("POST", "/v1/live", {"session": ids[-1], "cues": []})[0] == 200


def test_forget_and_purge_drop_live_sessions(env):
    call, cfg = env
    user, tok = add_user(call, "bob")
    call("POST", "/v1/live", {"cues": []}, token=tok)
    assert cfg.live.count(user["id"]) == 1
    call("POST", "/v1/me/forget", {}, token=tok)
    assert cfg.live.count(user["id"]) == 0
    call("POST", "/v1/live", {"cues": []}, token=tok)
    assert call("POST", f"/v1/admin/users/{user['id']}/purge")[0] == 200
    assert cfg.live.count(user["id"]) == 0


def test_idle_sessions_expire_and_audit_has_no_text(env):
    import json
    from chapterlens import live_sessions

    call, cfg = env
    now = [0.0]
    cfg.live = live_sessions.LiveSessions(clock=lambda: now[0])
    sid = call("POST", "/v1/live", {"cues": [{"start": 0, "end": 4, "text": "secretword alpha beta"}]})[1]["session"]
    now[0] = live_sessions.IDLE_TTL_S + 1
    assert call("POST", "/v1/live", {"session": sid, "cues": []})[0] == 404
    log = cfg.audit_path.read_text(encoding="utf-8")
    assert "secretword" not in log and "live.start" in log
    assert all(json.loads(line) for line in log.splitlines())


def test_concurrent_pushes_to_different_sessions_do_not_mix(env):
    import threading

    call, _ = env
    cues, ref = stream(seed=7)
    results = {}

    def work(name, token):
        sid = None
        for part, edge in chunks(cues):
            st, out, _ = call("POST", "/v1/live", {"session": sid, "cues": part, "now_s": edge}, token=token)
            assert st == 200, out
            sid = out["session"]
        results[name] = [(m["status"], round(m["t"])) for m in out["markers"]]

    _, tok_a = add_user(call, "alice")
    _, tok_b = add_user(call, "bob")
    threads = [threading.Thread(target=work, args=(n, t)) for n, t in (("a", tok_a), ("b", tok_b))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results["a"] == results["b"] and len(results["a"]) == 1 and abs(results["a"][0][1] - ref[0]) <= 4
