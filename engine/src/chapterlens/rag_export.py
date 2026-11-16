"""区間データ → DevelopmentRAGEnvironment(DevRAG)の任意の namespace へ(G4)。設計書 §2・SYSTEM_MAP G4。

**送るのは、派生データだけ**: 題名・開始時刻(と、あれば題名の出どころ)。字幕の本文・音声・動画の URL は送らない。
**既定は送らない**(プレビューだけ)。送るには `--send` が要る。送り先の namespace・URL は、利用者が毎回指定する。
鍵は環境変数から読む(コマンドラインに書かない・`.env` は読まない)。http は 127.0.0.1 / localhost だけ許す。
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from urllib.parse import urlparse

from .schema import Segment, from_document

MAX_LINES_PER_CHUNK = 40   # 1 つの塊に入れる行数(長い動画は、見出しを繰り返して分ける)
MAX_TITLE_CHARS = 120
MAX_CHUNKS = 50            # 1 回に送る塊の上限(誤って巨大なデータを送らない)
KEY_ENV_DEFAULT = "CHAPTERLENS_RAG_KEY"
_SAFE_LABEL = re.compile(r"[^0-9A-Za-z_\-぀-ヿ㐀-鿿]+")


class RagExportError(Exception):
    pass


def timestamp(seconds: float) -> str:
    s = int(seconds)
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


def safe_label(label: str) -> str:
    """ファイル名に使う動画の呼び名。URL や記号は落とす。"""
    cleaned = _SAFE_LABEL.sub("-", label.strip()).strip("-")
    if not cleaned:
        raise RagExportError("動画の呼び名(--label)が空です")
    return cleaned[:60]


def build_chunks(doc: dict, namespace: str, label: str | None = None, *, include_untitled: bool = False) -> list[dict]:
    """区間データ(chapterlens/segments@1)から、DevRAG の /ingest に送る塊を作る。題名のある区間だけを使う。"""
    segments = from_document(doc)
    name = safe_label(label or str(doc.get("source", {}).get("id", "")) or "video")
    rows: list[tuple[Segment, str]] = []
    for seg in segments:
        title = " ".join(seg.title.split())[:MAX_TITLE_CHARS]
        if title or include_untitled:
            rows.append((seg, title or "(題名なし)"))
    if not rows:
        raise RagExportError("題名のある区間がありません(題名なしの区間だけでは、検索の手がかりになりません)。題名を付けるか、--include-untitled を付けてください")
    header = (
        f"動画「{name}」の話題の切り替え(ChapterLens で作った目次)。"
        "字幕・音声の本文は含みません。時刻は動画の先頭からです。"
    )
    chunks: list[dict] = []
    for start in range(0, len(rows), MAX_LINES_PER_CHUNK):
        part = rows[start:start + MAX_LINES_PER_CHUNK]
        lines = [f"{timestamp(seg.start_s)} {title}" for seg, title in part]
        suffix = "" if len(rows) <= MAX_LINES_PER_CHUNK else f"-{start // MAX_LINES_PER_CHUNK + 1}"
        chunks.append({
            "text": header + "\n" + "\n".join(lines),
            "file": f"chapterlens/{name}{suffix}.md",
            "namespace": namespace,
        })
    if len(chunks) > MAX_CHUNKS:
        raise RagExportError(f"塊が多すぎます({len(chunks)} 件。上限 {MAX_CHUNKS})")
    return chunks


def check_url(url: str) -> str:
    """送り先の URL を検査する。https か、この PC(127.0.0.1 / localhost)の http だけ。"""
    parsed = urlparse(url)
    local = parsed.hostname in ("127.0.0.1", "localhost", "::1")
    if parsed.scheme == "https" or (parsed.scheme == "http" and local):
        if parsed.username or parsed.password:
            raise RagExportError("URL に鍵や名前を含めないでください(鍵は環境変数で渡します)")
        return url.rstrip("/")
    raise RagExportError("送り先は https の URL か、この PC の http://127.0.0.1 だけです")


def read_key(env_name: str) -> str:
    key = os.environ.get(env_name, "").strip()
    if not key:
        raise RagExportError(f"環境変数 {env_name} に DevRAG の API キーを入れてください(コマンドラインには書きません)")
    return key


def send(chunks: list[dict], url: str, key: str, timeout: int = 60) -> dict:
    """DevRAG の POST /ingest へ送る。失敗の理由は、鍵を含まない短い文にする。"""
    body = json.dumps({"chunks": chunks}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        check_url(url) + "/ingest", data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 -- check_url で https / localhost に限定済み
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        hint = {401: "API キーが違います", 403: "その namespace へ書く権限がありません"}.get(e.code, f"HTTP {e.code}")
        raise RagExportError(f"DevRAG が受け付けませんでした({hint})") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise RagExportError(f"DevRAG に届きませんでした({type(e).__name__})") from None
