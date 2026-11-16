"""rag-export(区間データの題名・時刻だけを DevRAG へ)の検査。送り先はテスト内の偽サーバー(127.0.0.1)。"""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from chapterlens import cli, rag_export as rx


def doc(titles, source_id="demo-video"):
    segs = [{"start_s": i * 60.0, "end_s": (i + 1) * 60.0, "title": t, "title_by": "user", "confidence": 0.5,
             "status": "committed", "evidence": {"secret_caption": "字幕の本文はここに入っている"}} for i, t in enumerate(titles)]
    return {"schema": "chapterlens/segments@1", "source": {"kind": "captions", "id": source_id, "duration_s": len(titles) * 60.0},
            "segments": segs, "provenance": {"engine": "t", "asr": None, "created": "2026-11-17T00:00:00Z"}}


# ---- 塊の作り方 ----
def test_chunks_carry_only_titles_and_times():
    chunks = rx.build_chunks(doc(["はじめに", "セットアップ", "まとめ"]), "shared:video-notes")
    assert len(chunks) == 1
    c = chunks[0]
    assert c["namespace"] == "shared:video-notes" and c["file"] == "chapterlens/demo-video.md"
    assert "00:00 はじめに" in c["text"] and "01:00 セットアップ" in c["text"] and "02:00 まとめ" in c["text"]
    assert "字幕の本文" not in c["text"] and "secret_caption" not in c["text"]  # evidence(字幕の断片)は送らない


def test_untitled_segments_are_skipped_unless_asked():
    chunks = rx.build_chunks(doc(["", "章 B", ""]), "ns")
    assert "章 B" in chunks[0]["text"] and "題名なし" not in chunks[0]["text"]
    with pytest.raises(rx.RagExportError):
        rx.build_chunks(doc(["", ""]), "ns")
    assert "(題名なし)" in rx.build_chunks(doc(["", ""]), "ns", include_untitled=True)[0]["text"]


def test_long_videos_split_into_chunks_with_the_header_repeated():
    chunks = rx.build_chunks(doc([f"章{i}" for i in range(95)]), "ns")
    assert len(chunks) == 3
    assert all(c["text"].startswith("動画「demo-video」") for c in chunks)
    assert [c["file"] for c in chunks] == ["chapterlens/demo-video-1.md", "chapterlens/demo-video-2.md", "chapterlens/demo-video-3.md"]


def test_label_is_sanitised_so_urls_do_not_leak_into_file_names():
    chunk = rx.build_chunks(doc(["a"]), "ns", label="https://www.youtube.com/watch?v=abc123")[0]
    assert "/" not in chunk["file"].split("chapterlens/")[1] and "?" not in chunk["file"]
    with pytest.raises(rx.RagExportError):
        rx.build_chunks(doc(["a"]), "ns", label="///")


def test_hours_use_h_mm_ss():
    assert rx.timestamp(59) == "00:59" and rx.timestamp(3661) == "1:01:01"


def test_unsupported_schema_is_rejected():
    bad = doc(["a"])
    bad["schema"] = "chapterlens/segments@9"
    with pytest.raises(ValueError):
        rx.build_chunks(bad, "ns")


# ---- 送り先の検査 ----
@pytest.mark.parametrize("url", ["http://example.com", "ftp://x", "https://user:pw@example.com", "javascript:alert(1)"])
def test_unsafe_urls_are_refused(url):
    with pytest.raises(rx.RagExportError):
        rx.check_url(url)


@pytest.mark.parametrize("url", ["https://rag.example.workers.dev/", "http://127.0.0.1:8787", "http://localhost:8787"])
def test_https_and_localhost_are_allowed(url):
    assert not rx.check_url(url).endswith("/")


def test_key_is_read_from_the_environment_only(monkeypatch):
    monkeypatch.delenv("X_KEY", raising=False)
    with pytest.raises(rx.RagExportError):
        rx.read_key("X_KEY")
    monkeypatch.setenv("X_KEY", " k-123 ")
    assert rx.read_key("X_KEY") == "k-123"


# ---- 実際の送信(偽サーバー) ----
class _Fake(BaseHTTPRequestHandler):
    seen: list = []
    status = 200

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers["Content-Length"]))
        _Fake.seen.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": json.loads(body)})
        self.send_response(_Fake.status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"status": "ok"} if _Fake.status == 200 else {"error": "x"}).encode())

    def log_message(self, *a):
        pass


@pytest.fixture
def server():
    _Fake.seen, _Fake.status = [], 200
    srv = HTTPServer(("127.0.0.1", 0), _Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def test_send_posts_chunks_with_a_bearer_key(server):
    chunks = rx.build_chunks(doc(["はじめに"]), "shared:video-notes")
    rx.send(chunks, server, "k-123")
    seen = _Fake.seen[0]
    assert seen["path"] == "/ingest" and seen["auth"] == "Bearer k-123"
    assert seen["body"]["chunks"][0]["namespace"] == "shared:video-notes"


@pytest.mark.parametrize("status,word", [(401, "キー"), (403, "権限")])
def test_errors_are_explained_without_leaking_the_key(server, status, word):
    _Fake.status = status
    with pytest.raises(rx.RagExportError) as e:
        rx.send(rx.build_chunks(doc(["a"]), "ns"), server, "SECRET-KEY-VALUE")
    assert word in str(e.value) and "SECRET-KEY-VALUE" not in str(e.value)


# ---- CLI ----
def test_cli_previews_by_default_and_sends_nothing(tmp_path, capsys, server):
    p = tmp_path / "seg.json"
    p.write_text(json.dumps(doc(["はじめに", "まとめ"])), encoding="utf-8")
    assert cli.main(["rag-export", str(p), "--namespace", "ns"]) == 0
    out = capsys.readouterr()
    assert "00:00 はじめに" in out.out and "--send" in out.err
    assert _Fake.seen == []


def test_cli_send_needs_url_and_key(tmp_path, capsys, monkeypatch):
    p = tmp_path / "seg.json"
    p.write_text(json.dumps(doc(["a"])), encoding="utf-8")
    monkeypatch.delenv("CHAPTERLENS_RAG_KEY", raising=False)
    assert cli.main(["rag-export", str(p), "--namespace", "ns", "--send"]) == 1
    assert "--url" in capsys.readouterr().err
    assert cli.main(["rag-export", str(p), "--namespace", "ns", "--send", "--url", "http://127.0.0.1:1"]) == 1
    assert "CHAPTERLENS_RAG_KEY" in capsys.readouterr().err


def test_cli_send_end_to_end_and_audit_log_has_no_titles(tmp_path, capsys, monkeypatch, server):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("CHAPTERLENS_HOME", str(home))
    monkeypatch.setenv("CHAPTERLENS_RAG_KEY", "k-123")
    p = tmp_path / "seg.json"
    p.write_text(json.dumps(doc(["秘密っぽい題名"])), encoding="utf-8")
    assert cli.main(["rag-export", str(p), "--namespace", "personal:me", "--send", "--url", server]) == 0
    assert _Fake.seen[0]["body"]["chunks"][0]["namespace"] == "personal:me"
    log = next(home.glob("audit.log")).read_text(encoding="utf-8")
    assert "rag_export" in log and "秘密っぽい題名" not in log and "k-123" not in log and server not in log
