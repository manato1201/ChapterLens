import http.client
import json
import threading

import pytest

from chapterlens.asr import AsrResult, Word
from chapterlens.captions import Cue
from chapterlens.server import Config, create_server, load_or_create_token

from synth import make_video

TOKEN = "test-token-123"
EXT = "chrome-extension://abcdefghijklmnop"


def fake_asr(path, *, language=None, model_size="small"):
    cues = [Cue(0.0, 5.0, "hello world"), Cue(5.0, 9.0, "second line")]
    words = [Word(0.0, 0.5, "hello"), Word(0.6, 1.0, "world"), Word(5.0, 5.4, "second"), Word(5.5, 6.0, "line")]
    return AsrResult(language or "en", 9.0, cues, words, "fake", "cpu")


@pytest.fixture
def server(tmp_path):
    cfg = Config(home=tmp_path, token=TOKEN, allow_origins=[EXT], max_audio_mb=1, asr_fn=fake_asr)
    httpd = create_server(cfg, port=0)
    t = threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.02), daemon=True)
    t.start()
    yield httpd.server_address[1], cfg
    httpd.shutdown()
    httpd.server_close()
    cfg.store.close()


def call(port, method, path, body=None, headers=None, raw=None, host=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    h = {"Authorization": f"Bearer {TOKEN}"}
    h.update(headers or {})
    if host is not None:
        h["Host"] = host
    payload = raw if raw is not None else (json.dumps(body).encode("utf-8") if body is not None else None)
    if payload is not None:
        h.setdefault("Content-Type", "application/json")
    conn.request(method, path, body=payload, headers=h)
    r = conn.getresponse()
    data = r.read()
    out = json.loads(data) if data else None
    return r.status, out, dict(r.getheaders())


# ---- 認証・Host・Origin ----
def test_health_needs_token(server):
    port, _ = server
    st, body, _ = call(port, "GET", "/v1/health")
    assert st == 200 and body["ok"] is True and "topic-shift@2" in body["detectors"]
    st, body, _ = call(port, "GET", "/v1/health", headers={"Authorization": "Bearer wrong"})
    assert st == 401
    st, _, _ = call(port, "GET", "/v1/health", headers={"Authorization": ""})
    assert st == 401


def test_host_header_must_be_local(server):
    port, _ = server
    assert call(port, "GET", "/v1/health", host="evil.example.com")[0] == 403  # DNS リバインディング対策
    assert call(port, "GET", "/v1/health", host=f"localhost:{port}")[0] == 200


def test_browser_origin_only_if_allowed(server):
    port, _ = server
    assert call(port, "GET", "/v1/health", headers={"Origin": "https://evil.example.com"})[0] == 403
    st, _, h = call(port, "GET", "/v1/health", headers={"Origin": EXT})
    assert st == 200 and h["Access-Control-Allow-Origin"] == EXT
    # プリフライト: 許可した Origin だけ。token は要らない
    st, _, h = call(port, "OPTIONS", "/v1/detect", headers={"Origin": EXT, "Authorization": ""})
    assert st == 204 and h["Access-Control-Allow-Private-Network"] == "true"
    assert call(port, "OPTIONS", "/v1/detect", headers={"Origin": "https://evil.example.com", "Authorization": ""})[0] == 403


def test_unknown_route_404(server):
    port, _ = server
    assert call(port, "GET", "/v1/nope")[0] == 404


# ---- /detect ----
def test_detect_returns_segments_document(server):
    port, _ = server
    cues, ref, duration = make_video([210, 380, 150, 520, 270, 330], lang="en", seed=21)
    body = {"cues": [{"start": c.start_s, "end": c.end_s, "text": c.text} for c in cues], "duration": duration, "target_count": 5}
    st, doc, _ = call(port, "POST", "/v1/detect", body)
    assert st == 200 and doc["schema"] == "chapterlens/segments@1"
    assert len(doc["segments"]) == 6 and len(doc["boundaries"]) == 5
    assert doc["segments"][0]["start_s"] == 0.0 and doc["segments"][-1]["end_s"] == duration


def test_detect_snaps_with_words_and_applies_corrections(server):
    port, _ = server
    cues, _, duration = make_video([210, 380, 150, 520], lang="en", seed=22)
    body = {"cues": [{"start": c.start_s, "end": c.end_s, "text": c.text} for c in cues], "duration": duration,
            "target_count": 3, "video": "vidA"}
    _, plain, _ = call(port, "POST", "/v1/detect", body)
    first = plain["boundaries"][0]
    # 修正: 最初の境界を 12 秒うしろへ動かし、末尾に 1 つ足す
    assert call(port, "POST", "/v1/corrections", {"video": "vidA", "action": "move", "from_s": first, "to_s": first + 12})[0] == 200
    assert call(port, "POST", "/v1/corrections", {"video": "vidA", "action": "add", "to_s": duration - 20})[0] == 200
    _, fixed, _ = call(port, "POST", "/v1/detect", body)
    assert fixed["boundaries"][0] == first + 12 and fixed["boundaries"][-1] == duration - 20
    assert len(fixed["boundaries"]) == len(plain["boundaries"]) + 1
    # 別の動画には影響しない
    _, other, _ = call(port, "POST", "/v1/detect", {**body, "video": "vidB"})
    assert other["boundaries"] == plain["boundaries"]


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"cues": []},
        {"cues": "x"},
        {"cues": [{"start": 0, "end": 1}]},
        {"cues": [{"start": -1, "end": 1, "text": "a"}]},
        {"cues": [{"start": 5, "end": 1, "text": "a"}]},
        {"cues": [{"start": 0, "end": 1, "text": "a" * 3000}]},
        {"cues": [{"start": 0, "end": 1, "text": "a"}], "detector": "nope"},
        {"cues": [{"start": 0, "end": 1, "text": "a"}], "target_count": -3},
        {"cues": [{"start": 0, "end": 1, "text": "a"}], "target_count": "many"},
        {"cues": [{"start": 0, "end": 1, "text": "a"}], "duration": "long"},
    ],
)
def test_detect_validates_input(server, body):
    port, _ = server
    assert call(port, "POST", "/v1/detect", body)[0] == 400


def test_bad_json_and_non_object(server):
    port, _ = server
    assert call(port, "POST", "/v1/detect", raw=b"{not json")[0] == 400
    assert call(port, "POST", "/v1/detect", raw=b"[1,2]")[0] == 400


# ---- /transcribe ----
def test_transcribe_returns_cues_and_optional_words(server):
    port, _ = server
    st, out, _ = call(port, "POST", "/v1/transcribe?language=ja", raw=b"RIFF....", headers={"Content-Type": "audio/wav"})
    assert st == 200 and out["language"] == "ja" and out["cues"][0]["text"] == "hello world" and "words" not in out
    st, out, _ = call(port, "POST", "/v1/transcribe?words=1", raw=b"RIFF....", headers={"Content-Type": "audio/wav"})
    assert out["words"][2]["text"] == "second"


def test_transcribe_limits_and_validation(server):
    port, _ = server  # max_audio_mb=1
    assert call(port, "POST", "/v1/transcribe", raw=b"x" * (1024 * 1024 + 1), headers={"Content-Type": "audio/wav"})[0] == 413
    assert call(port, "POST", "/v1/transcribe", raw=b"")[0] == 400
    assert call(port, "POST", "/v1/transcribe?model=../../etc", raw=b"abc")[0] == 400
    assert call(port, "POST", "/v1/transcribe?language=../x", raw=b"abc")[0] == 400


# ---- /corrections ----
def test_corrections_validation_and_listing(server):
    port, _ = server
    assert call(port, "POST", "/v1/corrections", {"video": "v", "action": "explode", "to_s": 1})[0] == 400
    assert call(port, "POST", "/v1/corrections", {"video": "v", "action": "add", "to_s": 10})[0] == 200
    _, out, _ = call(port, "GET", "/v1/corrections?video=v")
    assert [c["action"] for c in out["corrections"]] == ["add"]
    _, out, _ = call(port, "GET", "/v1/corrections")
    assert out["stats"]["videos"] == 1
    assert call(port, "POST", "/v1/corrections/undo", {"video": "v"})[1] == {"undone": True}
    assert call(port, "GET", "/v1/corrections?video=v")[1]["corrections"] == []


# ---- 監査ログ・token ----
def test_audit_log_has_no_secrets_or_content(server):
    port, cfg = server
    call(port, "POST", "/v1/detect", {"cues": [{"start": 0, "end": 1, "text": "ひみつの字幕の本文"}], "duration": 5})
    call(port, "GET", "/v1/health", headers={"Authorization": "Bearer wrong"})
    log = cfg.audit_path.read_text(encoding="utf-8")
    assert "/v1/detect" in log and "401" in log
    assert "ひみつ" not in log and TOKEN not in log and "wrong" not in log


def test_token_is_created_once_and_reused(tmp_path):
    a = load_or_create_token(tmp_path)
    assert len(a) >= 32 and load_or_create_token(tmp_path) == a
