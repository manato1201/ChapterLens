import http.client
import json
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from chapterlens.server import Config, create_server  # noqa: E402

ADMIN = "admin-token-for-tests"


@pytest.fixture
def env(tmp_path):
    """実際に 127.0.0.1 で待ち受けるサーバー。call(method, path, body, token=…, headers=…) → (status, json, headers)。"""
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
