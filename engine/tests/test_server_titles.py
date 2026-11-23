"""題名・大見出しの API(/v1/title・/v1/sections)と、LLM を有効にする設定を、実際の HTTP で確かめる。"""

import json

from conftest import add_user, env  # noqa: F401  (env はフィクスチャ)

from chapterlens.cli import main
from chapterlens.llm import LlmConfig, LlmError

CFG = LlmConfig(url="http://127.0.0.1:8800/v1", model="llh-main", token_env="LLH_TOKEN", timeout_s=5)
TEXT = "それでは魚を売りにいきます。まめきちのお店で、魚を売って 6,220 ベルになりました。やったー。"
SECRET_TEXT = "ひみつの字幕の本文ですよ。" + TEXT
GOOD_SECTIONS = '[{"heading": "朝のあいさつ", "from": 0, "to": 2}, {"heading": "釣りでお金かせぎ", "from": 3, "to": 4}]'
TITLES = ["配信開始・あいさつ", "島内放送を聞く", "ママからの手紙", "釣り開始", "魚を売る(6220ベル)"]


class FakeChat:
    def __init__(self, *replies):
        self.replies, self.calls = list(replies), []

    def __call__(self, cfg, system, user, *, max_tokens=200, **kw):
        self.calls.append(user)
        r = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        if isinstance(r, Exception):
            raise r
        return r


def setup_llm(cfg, fake, enabled=True):
    cfg.llm_config, cfg.llm_chat = CFG, fake
    if enabled:
        cfg.accounts.set_llm_enabled(True)


def test_disabled_by_default_returns_403_and_does_not_call_llm(env):
    call, cfg = env
    fake = FakeChat("魚を売って稼ぐ(6220ベル)")
    setup_llm(cfg, fake, enabled=False)
    st, out, _ = call("POST", "/v1/title", {"text": TEXT})
    assert st == 403 and "無効" in out["error"] and fake.calls == []
    assert call("POST", "/v1/sections", {"titles": TITLES})[0] == 403


def test_admin_enables_and_user_can_then_use_it_but_not_change_it(env):
    call, cfg = env
    fake = FakeChat("魚を売って稼ぐ(6220ベル)")
    setup_llm(cfg, fake, enabled=False)
    _, tok = add_user(call, "alice")
    assert call("POST", "/v1/admin/settings", {"llm_enabled": True}, token=tok)[0] == 403
    st, out, _ = call("GET", "/v1/admin/settings")
    assert st == 200 and out["llm_enabled"] is False
    st, out, _ = call("POST", "/v1/admin/settings", {"llm_enabled": True})
    assert st == 200 and out["llm_enabled"] is True
    st, out, _ = call("POST", "/v1/title", {"text": TEXT}, token=tok)
    assert st == 200 and out == {"title": "魚を売って稼ぐ(6220ベル)", "title_by": "llm", "rejected": 0}
    assert call("POST", "/v1/admin/settings", {"llm_enabled": False})[1]["llm_enabled"] is False
    assert call("POST", "/v1/title", {"text": TEXT}, token=tok)[0] == 403


def test_settings_validation_and_share_mode_still_works(env):
    call, _ = env
    assert call("POST", "/v1/admin/settings", {"llm_enabled": "yes"})[0] == 400
    st, out, _ = call("POST", "/v1/admin/settings", {"share_mode": "team"})
    assert st == 200 and out["share_mode"] == "team" and out["llm_enabled"] is False


def test_rejected_title_comes_back_empty_as_rule(env):
    call, cfg = env
    setup_llm(cfg, FakeChat("魚を売る(9999ベル)"))
    st, out, _ = call("POST", "/v1/title", {"text": TEXT})
    assert st == 200 and out == {"title": "", "title_by": "rule", "rejected": 2}


def test_sections_ok(env):
    call, cfg = env
    setup_llm(cfg, FakeChat(GOOD_SECTIONS))
    st, out, _ = call("POST", "/v1/sections", {"titles": TITLES})
    assert st == 200 and out["rejected"] == 0 and [s["from"] for s in out["sections"]] == [0, 3]


def test_unreachable_llm_is_502_with_guidance_and_no_text(env):
    call, cfg = env
    setup_llm(cfg, FakeChat(LlmError("unreachable", "窓口に接続できません")))
    st, out, _ = call("POST", "/v1/title", {"text": SECRET_TEXT})
    assert st == 502 and "llh serve" in out["error"]
    assert "ひみつ" not in json.dumps(out, ensure_ascii=False)


def test_timeout_and_bad_response_are_502(env):
    call, cfg = env
    setup_llm(cfg, FakeChat(LlmError("timeout", "x")))
    assert call("POST", "/v1/title", {"text": TEXT})[0] == 502
    setup_llm(cfg, FakeChat(LlmError("bad_response", "x")))
    assert call("POST", "/v1/title", {"text": TEXT})[0] == 502


def test_validation_errors(env):
    call, cfg = env
    setup_llm(cfg, FakeChat("魚を売って稼ぐ(6220ベル)"))
    assert call("POST", "/v1/title", {"text": "あ" * 12001})[0] == 400
    assert call("POST", "/v1/title", {"text": 123})[0] == 400
    assert call("POST", "/v1/title", {})[0] == 400
    assert call("POST", "/v1/title", {"text": TEXT, "prev_title": "あ" * 61})[0] == 400
    assert call("POST", "/v1/sections", {"titles": ["題名です"] * 201})[0] == 400
    assert call("POST", "/v1/sections", {"titles": ["題名です", 5, "x", "y"]})[0] == 400
    assert call("POST", "/v1/sections", {"titles": ["あ" * 61, "b", "c", "d"]})[0] == 400
    assert call("POST", "/v1/sections", {"titles": "not a list"})[0] == 400


def test_audit_log_never_contains_captions_or_titles(env):
    call, cfg = env
    setup_llm(cfg, FakeChat("魚を売って稼ぐ(6220ベル)"))
    call("POST", "/v1/title", {"text": SECRET_TEXT, "prev_title": "前の題名ひみつ"})
    setup_llm(cfg, FakeChat(GOOD_SECTIONS))
    call("POST", "/v1/sections", {"titles": TITLES})
    log = cfg.audit_path.read_text(encoding="utf-8")
    for leaked in ("ひみつ", "魚を売って稼ぐ", "配信開始", "釣りでお金"):
        assert leaked not in log
    events = [json.loads(line) for line in log.splitlines() if '"event"' in line]
    kinds = {e["event"]: e for e in events}
    assert kinds["llm.title"]["model"] == "llh-main" and kinds["llm.title"]["rejected"] == 0
    assert kinds["llm.sections"]["chapters"] == 5


def test_two_hundred_chapters_are_not_rate_limited(env):
    call, cfg = env
    setup_llm(cfg, FakeChat("魚を売って稼ぐ(6220ベル)"))
    codes = {call("POST", "/v1/title", {"text": TEXT})[0] for _ in range(200)}
    assert codes == {200}


def test_cli_admin_llm_toggle(capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("CHAPTERLENS_HOME", str(tmp_path))

    def run(*a):
        code = main(["admin", *a])
        return code, capsys.readouterr().out

    assert "無効" in run("llm")[1]
    assert run("llm", "on")[0] == 0 and "有効" in run("llm")[1]
    assert "無効" in run("llm", "off")[1]
    log = (tmp_path / "audit.log").read_text(encoding="utf-8")
    assert "admin.settings.llm_enabled" in log


# ---- 最終レビューの指摘(I3・I7) ----
def test_busy_lock_returns_503_instead_of_waiting_forever(env):
    call, cfg = env
    setup_llm(cfg, FakeChat("魚を売って稼ぐ(6220ベル)"))
    cfg.llm_lock_wait_s = 0.2
    cfg.llm_lock.acquire()
    try:
        st, out, _ = call("POST", "/v1/title", {"text": TEXT})
    finally:
        cfg.llm_lock.release()
    assert st == 503 and "混" in out["error"]


def test_llm_http_status_gives_specific_guidance(env):
    call, cfg = env
    for status, word in ((401, "LLH_TOKEN"), (403, "LLH_TOKEN"), (503, "混"), (400, "モデル"), (404, "モデル")):
        setup_llm(cfg, FakeChat(LlmError("bad_response", "x", status=status)))
        st, out, _ = call("POST", "/v1/title", {"text": TEXT})
        assert st == 502 and word in out["error"], (status, out)
        assert "ひみつ" not in out["error"]
