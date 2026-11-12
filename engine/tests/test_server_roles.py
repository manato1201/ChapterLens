"""CH3: 役割・共有・監査ログ・レート制限を、実際の HTTP で確かめる。"""

import http.client
import json
import threading

import pytest

from chapterlens.server import Config, create_server

ADMIN = "admin-token-for-tests"


@pytest.fixture
def env(tmp_path):
    cfg = Config(home=tmp_path, token=ADMIN, asr_fn=lambda *a, **k: None)
    httpd = create_server(cfg, port=0)
    t = threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.02), daemon=True)
    t.start()
    port = httpd.server_address[1]

    def call(method, path, body=None, token=ADMIN, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        h = dict(headers or {})
        if token is not None:
            h["Authorization"] = f"Bearer {token}"
        payload = json.dumps(body).encode() if body is not None else None
        if payload:
            h["Content-Type"] = "application/json"
        conn.request(method, path, body=payload, headers=h)
        r = conn.getresponse()
        data = r.read()
        return r.status, (json.loads(data) if data else None), dict(r.getheaders())

    yield call, cfg
    httpd.shutdown()
    httpd.server_close()
    cfg.close()


def add_user(call, name, role="user"):
    st, out, _ = call("POST", "/v1/admin/users", {"name": name, "role": role})
    assert st == 200, out
    return out["user"], out["token"]


# ---- 役割(S-A) ----
def test_existing_token_is_admin_local(env):
    call, _ = env
    st, out, _ = call("GET", "/v1/me")
    assert st == 200 and out["user"]["id"] == "local" and out["user"]["role"] == "admin" and out["share_mode"] == "off"


def test_user_cannot_use_admin_routes_even_with_claims(env):
    call, _ = env
    _, tok = add_user(call, "alice")
    for method, path in [("GET", "/v1/admin/users"), ("POST", "/v1/admin/users"), ("GET", "/v1/admin/settings"),
                         ("GET", "/v1/admin/audit"), ("POST", "/v1/admin/users/local/disable")]:
        st, _, _ = call(method, path, {"name": "x"} if method == "POST" else None, token=tok)
        assert st == 403, (method, path)
    # 自分は admin だと名乗るヘッダ・本文・クエリは無視される
    st, _, _ = call("GET", "/v1/admin/users?role=admin", token=tok, headers={"X-Role": "admin", "X-User": "local"})
    assert st == 403
    st, _, _ = call("POST", "/v1/admin/users", {"name": "evil", "role": "admin", "user": {"role": "admin"}}, token=tok)
    assert st == 403


def test_admin_create_list_and_token_shown_once(env):
    call, _ = env
    user, tok = add_user(call, "alice")
    st, out, _ = call("GET", "/v1/admin/users")
    assert {u["name"] for u in out["users"]} == {"local", "alice"}
    assert tok not in json.dumps(out) and "token_hash" not in json.dumps(out)
    st, me, _ = call("GET", "/v1/me", token=tok)
    assert me["user"]["id"] == user["id"] and me["user"]["role"] == "user"


def test_admin_can_create_another_admin_and_change_role(env):
    call, _ = env
    user, tok = add_user(call, "boss", role="admin")
    assert call("GET", "/v1/admin/users", token=tok)[0] == 200
    assert call("POST", f"/v1/admin/users/{user['id']}/role", {"role": "user"})[0] == 200
    assert call("GET", "/v1/admin/users", token=tok)[0] == 403  # 降格したら、すぐ使えなくなる
    assert call("POST", f"/v1/admin/users/{user['id']}/role", {"role": "root"})[0] == 400


def test_disable_enable_rotate_flow(env):
    call, _ = env
    user, tok = add_user(call, "alice")
    assert call("POST", f"/v1/admin/users/{user['id']}/disable")[0] == 200
    assert call("GET", "/v1/me", token=tok)[0] == 401
    assert call("POST", f"/v1/admin/users/{user['id']}/enable")[0] == 200
    assert call("GET", "/v1/me", token=tok)[0] == 200
    st, out, _ = call("POST", f"/v1/admin/users/{user['id']}/rotate")
    assert st == 200 and out["token"] != tok
    assert call("GET", "/v1/me", token=tok)[0] == 401 and call("GET", "/v1/me", token=out["token"])[0] == 200


def test_local_admin_is_protected_and_bad_ids_rejected(env):
    call, _ = env
    for action in ("disable", "rotate", "purge"):
        assert call("POST", f"/v1/admin/users/local/{action}")[0] == 400
    assert call("POST", "/v1/admin/users/..%2Fx/disable")[0] == 400
    assert call("POST", "/v1/admin/users/u_00000000/disable")[0] == 404
    assert call("POST", "/v1/admin/users/local/explode")[0] in (400, 404)
    assert call("GET", "/v1/me")[0] == 200  # 管理者 local は健在


def test_wrong_and_missing_tokens_are_401_without_detail(env):
    call, _ = env
    assert call("GET", "/v1/me", token="nope")[0] == 401
    assert call("GET", "/v1/me", token=None)[0] == 401
    user, tok = add_user(call, "alice")
    call("POST", f"/v1/admin/users/{user['id']}/disable")
    st, out, _ = call("GET", "/v1/me", token=tok)
    assert st == 401 and out == {"error": "token が違います"}  # 停止中と不明を区別しない


# ---- 利用者ごとの分離(S-F) ----
def test_corrections_are_separated_per_user(env):
    call, _ = env
    _, a = add_user(call, "alice")
    _, b = add_user(call, "bob")
    assert call("POST", "/v1/corrections", {"video": "v", "action": "add", "to_s": 10}, token=a)[0] == 200
    assert call("GET", "/v1/corrections?video=v", token=a)[1]["corrections"][0]["to_s"] == 10
    assert call("GET", "/v1/corrections?video=v", token=b)[1]["corrections"] == []
    assert call("GET", "/v1/corrections?video=v")[1]["corrections"] == []  # 管理者でも、他人の修正は(この経路では)見えない


def test_forget_deletes_only_my_data(env):
    call, _ = env
    _, a = add_user(call, "alice")
    _, b = add_user(call, "bob")
    call("POST", "/v1/admin/settings", {"share_mode": "team"})
    for tok in (a, b):
        call("POST", "/v1/corrections", {"video": "v", "action": "add", "to_s": 5}, token=tok)
        call("POST", "/v1/shares", {"video": "v", "boundaries": [60], "audience": "team"}, token=tok)
    st, out, _ = call("POST", "/v1/me/forget", token=a)
    assert st == 200 and out["deleted"] == {"corrections": 1, "shares": 1}
    assert call("GET", "/v1/corrections?video=v", token=a)[1]["corrections"] == []
    assert len(call("GET", "/v1/corrections?video=v", token=b)[1]["corrections"]) == 1
    assert [s["from"] for s in call("GET", "/v1/shares?video=v", token=b)[1]["shares"]] == ["bob"]


def test_purge_removes_user_and_data(env):
    call, _ = env
    user, tok = add_user(call, "alice")
    call("POST", "/v1/admin/settings", {"share_mode": "team"})
    call("POST", "/v1/corrections", {"video": "v", "action": "add", "to_s": 5}, token=tok)
    call("POST", "/v1/shares", {"video": "v", "boundaries": [60]}, token=tok)
    st, out, _ = call("POST", f"/v1/admin/users/{user['id']}/purge")
    assert st == 200 and out["deleted"] == {"corrections": 1, "shares": 1}
    assert call("GET", "/v1/me", token=tok)[0] == 401
    assert call("GET", "/v1/shares?video=v")[1]["shares"] == []


# ---- 共有(許可つき) ----
def test_sharing_is_off_by_default(env):
    call, _ = env
    _, a = add_user(call, "alice")
    st, out, _ = call("POST", "/v1/shares", {"video": "v", "boundaries": [60], "audience": "team"}, token=a)
    assert st == 403 and "無効" in out["error"]
    assert call("GET", "/v1/shares?video=v", token=a)[0] == 403


def test_share_publish_and_read_by_audience(env):
    call, _ = env
    _, a = add_user(call, "alice")
    b_user, b = add_user(call, "bob")
    _, c = add_user(call, "carol")
    assert call("POST", "/v1/admin/settings", {"share_mode": "team"})[1]["share_mode"] == "team"
    assert call("POST", "/v1/shares", {"video": "v", "boundaries": [100, 300], "titles": ["i", "j", "k"], "duration": 500, "audience": "team"}, token=a)[0] == 200
    assert call("POST", "/v1/shares", {"video": "v", "boundaries": [90], "audience": [b_user["id"]]}, token=c)[0] == 200
    seen = lambda tok: sorted(s["from"] for s in call("GET", "/v1/shares?video=v", token=tok)[1]["shares"])
    assert seen(a) == ["alice"]            # carol の共有は bob だけに向けたもの
    assert seen(b) == ["alice", "carol"]
    assert seen(c) == ["alice", "carol"]
    shared = [s for s in call("GET", "/v1/shares?video=v", token=b)[1]["shares"] if s["from"] == "alice"][0]
    assert shared["boundaries"] == [100.0, 300.0] and shared["titles"] == ["i", "j", "k"] and "audience" not in shared


def test_share_rejects_extra_content_and_bad_input(env):
    call, _ = env
    _, a = add_user(call, "alice")
    call("POST", "/v1/admin/settings", {"share_mode": "team"})
    st, out, _ = call("POST", "/v1/shares", {"video": "v", "boundaries": [60], "cues": [{"start": 0, "end": 1, "text": "字幕の全文"}]}, token=a)
    assert st == 400 and "区間データだけ" in out["error"]
    assert call("POST", "/v1/shares", {"video": "v", "boundaries": [60], "audience": "u_00000000"}, token=a)[0] == 400
    assert call("POST", "/v1/shares", {"video": "v", "boundaries": "x"}, token=a)[0] == 400


def test_named_mode_and_revoke_even_when_off(env):
    call, _ = env
    _, a = add_user(call, "alice")
    b_user, b = add_user(call, "bob")
    call("POST", "/v1/admin/settings", {"share_mode": "named"})
    assert call("POST", "/v1/shares", {"video": "v", "boundaries": [60], "audience": "team"}, token=a)[0] == 400
    assert call("POST", "/v1/shares", {"video": "v", "boundaries": [60], "audience": [b_user["id"]]}, token=a)[0] == 200
    call("POST", "/v1/admin/settings", {"share_mode": "off"})
    assert call("GET", "/v1/shares?video=v", token=b)[0] == 403         # 管理者が止めたら、読めない
    assert call("GET", "/v1/shares", token=a)[1]["mine"][0]["audience"] == [b_user["id"]]
    assert call("POST", "/v1/shares/revoke", {"video": "v"}, token=a)[1] == {"revoked": True}  # 取り下げは、いつでもできる
    assert call("POST", "/v1/shares/revoke", {"video": "v"}, token=a)[1] == {"revoked": False}


def test_disabled_users_shares_are_hidden(env):
    call, _ = env
    a_user, a = add_user(call, "alice")
    _, b = add_user(call, "bob")
    call("POST", "/v1/admin/settings", {"share_mode": "team"})
    call("POST", "/v1/shares", {"video": "v", "boundaries": [60]}, token=a)
    assert len(call("GET", "/v1/shares?video=v", token=b)[1]["shares"]) == 1
    call("POST", f"/v1/admin/users/{a_user['id']}/disable")
    assert call("GET", "/v1/shares?video=v", token=b)[1]["shares"] == []


def test_share_settings_validation(env):
    call, _ = env
    assert call("POST", "/v1/admin/settings", {"share_mode": "everyone"})[0] == 400
    assert call("POST", "/v1/admin/settings", {})[0] == 400
    assert call("GET", "/v1/admin/settings")[1]["share_mode"] == "off"


# ---- 監査ログ(S-C) ----
def test_audit_records_admin_actions_without_secrets_or_content(env):
    call, cfg = env
    user, tok = add_user(call, "alice")
    call("POST", "/v1/admin/settings", {"share_mode": "team"})
    call("POST", "/v1/shares", {"video": "SECRETVIDEOID", "boundaries": [60], "titles": ["ひみつの題名", "b"], "audience": "team"}, token=tok)
    call("POST", f"/v1/admin/users/{user['id']}/disable")
    new = call("POST", f"/v1/admin/users/{user['id']}/rotate")[1]["token"]
    raw = cfg.audit_path.read_text(encoding="utf-8")
    events = [json.loads(line) for line in raw.splitlines() if '"event"' in line]
    names = [e["event"] for e in events]
    assert names == ["admin.user.create", "admin.settings.share_mode", "share.publish", "admin.user.disable", "admin.user.rotate"]
    assert events[0]["actor"] == "local" and events[2]["actor"] == user["id"]
    for secret in (tok, new, ADMIN, "SECRETVIDEOID", "ひみつ"):
        assert secret not in raw
    # 管理者は API からも読める。利用者は読めない
    st, out, _ = call("GET", "/v1/admin/audit?n=3")
    assert st == 200 and len(out["events"]) == 3
    assert call("GET", "/v1/admin/audit", token=tok)[0] in (401, 403)  # 停止中なので 401(有効なら 403)


def test_route_audit_records_user_and_role(env):
    call, cfg = env
    user, tok = add_user(call, "alice")
    call("GET", "/v1/me", token=tok)
    recs = [json.loads(line) for line in cfg.audit_path.read_text(encoding="utf-8").splitlines()]
    me = [r for r in recs if r.get("route") == "/v1/me"][-1]
    assert me["owner"] == user["id"] and me["role"] == "user" and me["status"] == 200


# ---- レート制限(S-D) ----
def test_rate_limit_per_user_with_retry_after(tmp_path):
    cfg = Config(home=tmp_path, token=ADMIN, rate_limits={"default": (3, 60.0), "transcribe": (1, 60.0), "admin": (50, 60.0)})
    httpd = create_server(cfg, port=0)
    threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.02), daemon=True).start()
    port = httpd.server_address[1]

    def get(path, token):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request("GET", path, headers={"Authorization": f"Bearer {token}"})
        r = conn.getresponse()
        r.read()
        return r.status, dict(r.getheaders())

    try:
        u, tok = cfg.accounts.create_user("alice")[0], cfg.accounts.create_user("bob")[1]
        statuses = [get("/v1/me", ADMIN)[0] for _ in range(5)]
        assert statuses == [200, 200, 200, 429, 429]
        st, headers = get("/v1/me", ADMIN)
        assert st == 429 and int(headers["Retry-After"]) >= 1
        assert get("/v1/me", tok)[0] == 200  # 他の利用者は影響を受けない
    finally:
        httpd.shutdown()
        httpd.server_close()
        cfg.close()


def test_failed_auth_does_not_consume_a_users_quota(tmp_path):
    cfg = Config(home=tmp_path, token=ADMIN, rate_limits={"default": (2, 60.0)})
    httpd = create_server(cfg, port=0)
    threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.02), daemon=True).start()
    port = httpd.server_address[1]

    def get(token):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request("GET", "/v1/me", headers={"Authorization": f"Bearer {token}"})
        r = conn.getresponse()
        r.read()
        return r.status

    try:
        assert [get("wrong") for _ in range(5)] == [401] * 5  # 他人の token の試行で、管理者の枠が減らない
        assert get(ADMIN) == 200
    finally:
        httpd.shutdown()
        httpd.server_close()
        cfg.close()


# ---- 並行アクセス(サーバーは複数のスレッドで動く) ----
def test_concurrent_writes_from_several_users_do_not_corrupt(env):
    call, _ = env
    toks = [add_user(call, f"user{i}")[1] for i in range(4)]
    errors = []

    def work(tok):
        try:
            for i in range(25):
                st, _, _ = call("POST", "/v1/corrections", {"video": "v", "action": "add", "to_s": 10 + i}, token=tok)
                if st != 200:
                    errors.append(st)
        except Exception as e:  # noqa: BLE001
            errors.append(repr(e))

    threads = [threading.Thread(target=work, args=(t,)) for t in toks]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == []
    for tok in toks:
        assert len(call("GET", "/v1/corrections?video=v", token=tok)[1]["corrections"]) == 25
