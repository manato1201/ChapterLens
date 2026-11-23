"""窓口(LocalLLMHarness)のクライアント。偽の窓口を、別スレッドで立てて確かめる。"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from chapterlens.llm import LlmConfig, LlmError, chat, llm_config_from_env


class FakeLlm:
    """受け取ったリクエストを記録し、決めた応答を返す窓口。"""

    def __init__(self, status=200, body=None, delay=0.0, location=None):
        self.requests: list[dict] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n)
                outer.requests.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": json.loads(raw or b"{}")})
                if delay:
                    time.sleep(delay)
                self.send_response(status)
                if location:
                    self.send_header("Location", location)
                payload = body if body is not None else json.dumps({"choices": [{"message": {"content": "釣りを始める"}}]})
                data = payload.encode("utf-8")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/v1"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def fake():
    servers = []

    def make(**kw):
        s = FakeLlm(**kw)
        servers.append(s)
        return s

    yield make
    for s in servers:
        s.close()


def cfg_for(url, timeout=5.0, token_env="LLH_TOKEN"):
    return LlmConfig(url=url, model="llh-main", token_env=token_env, timeout_s=timeout)


def test_chat_returns_message_content_and_sends_model(fake):
    s = fake()
    assert chat(cfg_for(s.url), "system です", "user です", environ={}) == "釣りを始める"
    req = s.requests[0]
    assert req["path"] == "/v1/chat/completions"
    assert req["body"]["model"] == "llh-main"
    assert [m["role"] for m in req["body"]["messages"]] == ["system", "user"]
    assert req["body"]["temperature"] == 0.2
    assert req["body"]["max_tokens"] == 200


def test_authorization_only_when_env_is_set(fake):
    s = fake()
    chat(cfg_for(s.url), "s", "u", environ={})
    chat(cfg_for(s.url), "s", "u", environ={"LLH_TOKEN": "tok-abc"})
    assert s.requests[0]["auth"] is None
    assert s.requests[1]["auth"] == "Bearer tok-abc"


def test_custom_token_env_name(fake):
    s = fake()
    chat(cfg_for(s.url, token_env="MY_TOKEN"), "s", "u", environ={"MY_TOKEN": "zzz", "LLH_TOKEN": "other"})
    assert s.requests[0]["auth"] == "Bearer zzz"


@pytest.mark.parametrize("url", ["https://example.com/v1", "http://example.com/v1", "http://192.168.0.5:8800/v1", "ftp://127.0.0.1/v1", "not a url"])
def test_config_rejects_non_loopback(url):
    with pytest.raises(ValueError):
        llm_config_from_env({"CHAPTERLENS_LLM_URL": url})


def test_config_defaults_and_overrides():
    c = llm_config_from_env({})
    assert (c.url, c.model, c.token_env, c.timeout_s) == ("http://127.0.0.1:8800/v1", "llh-main", "LLH_TOKEN", 120.0)
    c = llm_config_from_env({"CHAPTERLENS_LLM_URL": "http://localhost:9000/v1/", "CHAPTERLENS_LLM_MODEL": "m", "CHAPTERLENS_LLM_TOKEN_ENV": "T", "CHAPTERLENS_LLM_TIMEOUT_S": "30"})
    assert (c.url, c.model, c.token_env, c.timeout_s) == ("http://localhost:9000/v1", "m", "T", 30.0)


def test_unreachable_when_port_is_closed():
    s = FakeLlm()
    url = s.url
    s.close()
    with pytest.raises(LlmError) as e:
        chat(cfg_for(url), "s", "u", environ={})
    assert e.value.code == "unreachable"


def test_bad_response_when_not_json(fake):
    s = fake(body="これは JSON ではありません")
    with pytest.raises(LlmError) as e:
        chat(cfg_for(s.url), "s", "u", environ={})
    assert e.value.code == "bad_response"


def test_bad_response_when_shape_is_wrong(fake):
    s = fake(body=json.dumps({"choices": []}))
    with pytest.raises(LlmError) as e:
        chat(cfg_for(s.url), "s", "u", environ={})
    assert e.value.code == "bad_response"


def test_http_error_status_is_bad_response(fake):
    s = fake(status=500, body=json.dumps({"error": {"message": "boom"}}))
    with pytest.raises(LlmError) as e:
        chat(cfg_for(s.url), "s", "u", environ={})
    assert e.value.code == "bad_response"


def test_timeout(fake):
    s = fake(delay=1.0)
    with pytest.raises(LlmError) as e:
        chat(cfg_for(s.url, timeout=0.2), "s", "u", environ={})
    assert e.value.code == "timeout"


def test_redirect_is_refused(fake):
    s = fake(status=302, location="http://example.com/steal", body="{}")
    with pytest.raises(LlmError) as e:
        chat(cfg_for(s.url), "s", "u", environ={"LLH_TOKEN": "secret-token-xyz"})
    assert e.value.code == "refused"
    assert "secret-token-xyz" not in str(e.value)


def test_error_messages_never_contain_token_or_prompt(fake):
    s = fake(status=500, body="{}")
    with pytest.raises(LlmError) as e:
        chat(cfg_for(s.url), "システム", "字幕の本文ひみつ", environ={"LLH_TOKEN": "secret-token-xyz"})
    msg = str(e.value)
    assert "secret-token-xyz" not in msg and "字幕の本文ひみつ" not in msg


# ---- 最終レビューの指摘(C1・I1・I7) ----
def test_proxy_environment_is_ignored_so_captions_never_leave_loopback(fake):
    """HTTP_PROXY があっても、プロキシを通さず、窓口へ直接つなぐ(字幕と token を loopback の外へ出さない)。

    環境変数は、開く道具を作るとき(import 時)に読まれるので、別のプロセスで確かめる。
    """
    import os
    import subprocess
    import sys
    from pathlib import Path

    import chapterlens

    proxy = FakeLlm()
    try:
        s = fake()
        env = dict(os.environ)
        proxy_url = proxy.url.replace("/v1", "")
        env.update({"HTTP_PROXY": proxy_url, "http_proxy": proxy_url, "LLH_TOKEN": "tok-for-proxy-test", "PYTHONPATH": str(Path(chapterlens.__file__).parent.parent), "PYTHONIOENCODING": "utf-8"})
        env.pop("NO_PROXY", None)
        env.pop("no_proxy", None)
        code = (
            "from chapterlens.llm import LlmConfig, chat; "
            f"print(chat(LlmConfig(url={s.url!r}, model='llh-main', token_env='LLH_TOKEN', timeout_s=5), 's', 'u'))"
        )
        out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, encoding="utf-8", timeout=30)
        assert out.returncode == 0, out.stderr
        assert out.stdout.strip() == "釣りを始める"
        assert len(s.requests) == 1 and proxy.requests == []
    finally:
        proxy.close()


def test_request_turns_thinking_off(fake):
    s = fake()
    chat(cfg_for(s.url), "s", "u", environ={})
    assert s.requests[0]["body"]["enable_thinking"] is False


@pytest.mark.parametrize("status", [400, 401, 403, 404, 503])
def test_http_error_keeps_the_status_code(fake, status):
    s = fake(status=status, body="{}")
    with pytest.raises(LlmError) as e:
        chat(cfg_for(s.url), "s", "u", environ={})
    assert e.value.code == "bad_response" and e.value.status == status
