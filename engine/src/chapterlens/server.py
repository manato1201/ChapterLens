"""ローカルエンジンの HTTP サーバー(CH2)。拡張・ブラウザ・ツールが呼ぶ入口。標準ライブラリだけ。

守り(設計書 §10。S-A〜S-F の、ローカルサーバーでの形):
  ・127.0.0.1 だけで待ち受ける(外のネットワークからは届かない)
  ・全ての呼び出しに token(Authorization: Bearer)が要る。token はローカルのファイルに 1 度だけ作る
  ・Host ヘッダは 127.0.0.1 / localhost だけ(DNS リバインディングで、悪いサイトに呼ばれないように)
  ・Origin が付く呼び出し(= ブラウザ)は、許可した Origin(例 chrome-extension://<id>)だけ。何も許可しなければ、ブラウザからは呼べない
  ・本文のサイズに上限(JSON と音声を別々に)。入力は検証する(字幕の数・文字数・時刻)
  ・監査ログ: 時刻・経路・結果・所要時間だけ(字幕の本文・音声・token は残さない)
  ・修正は owner ごとに分ける(いまは token 1 つ = owner "local")

エンドポイント(すべて /v1):
  GET  /health
  POST /detect       {cues:[{start,end,text}], duration, target_count?, detector?, words?:[...], video?} → 区間データ
  POST /transcribe   本文 = 音声(wav/webm/mp3 など)。?language=ja&model=small&words=1  → {language, duration, cues, words?}
  POST /corrections  {video, action, from_s?, to_s?}   GET /corrections?video=...   POST /corrections/undo {video}
"""

from __future__ import annotations

import hmac
import json
import os
import secrets
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import __version__
from .asr import AsrUnavailable, Word, snap_to_utterances, transcribe
from .captions import Cue
from .corrections import CorrectionError, CorrectionStore
from .detectors import available, get_detector
from .schema import segments_from_boundaries, to_document

MAX_JSON_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_AUDIO_MB = 300
MAX_CUES = 50000
MAX_CUE_CHARS = 2000
OWNER = "local"


def default_home() -> Path:
    return Path(os.environ.get("CHAPTERLENS_HOME") or Path.home() / ".chapterlens")


def load_or_create_token(home: Path) -> str:
    """token を読む。無ければ作る(他のユーザーに読まれないよう、可能なら 0600)。"""
    home.mkdir(parents=True, exist_ok=True)
    path = home / "token"
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    token = secrets.token_urlsafe(32)
    path.write_text(token + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return token


class Config:
    def __init__(self, *, home: Path | None = None, token: str | None = None, allow_origins: list[str] | None = None,
                 max_audio_mb: int = DEFAULT_MAX_AUDIO_MB, asr_fn=None) -> None:
        self.home = home or default_home()
        self.token = token or load_or_create_token(self.home)
        self.allow_origins = set(allow_origins or [])
        self.max_audio_bytes = max_audio_mb * 1024 * 1024
        self.store = CorrectionStore(self.home / "corrections.db")
        self.asr_fn = asr_fn or transcribe  # テストでは差し替える
        self.asr_lock = threading.Lock()  # GPU は 1 度に 1 つだけ
        self.audit_path = self.home / "audit.log"


class HttpError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status, self.message = status, message


def _validate_cues(raw) -> list[Cue]:
    if not isinstance(raw, list) or not raw:
        raise HttpError(400, "cues は空でない配列です")
    if len(raw) > MAX_CUES:
        raise HttpError(413, f"cues が多すぎます(最大 {MAX_CUES})")
    cues: list[Cue] = []
    for c in raw:
        try:
            start, end, text = float(c["start"]), float(c["end"]), str(c["text"])
        except (KeyError, TypeError, ValueError):
            raise HttpError(400, "cue は {start, end, text} です")
        if not (0 <= start < 24 * 3600) or end < start or len(text) > MAX_CUE_CHARS:
            raise HttpError(400, "cue の時刻か長さが不正です")
        cues.append(Cue(start, end, text))
    cues.sort(key=lambda c: c.start_s)
    return cues


def _validate_words(raw) -> list[Word]:
    words = []
    for w in raw or []:
        try:
            words.append(Word(float(w["start_s"]), float(w["end_s"]), str(w["text"])[:100]))
        except (KeyError, TypeError, ValueError):
            raise HttpError(400, "word は {start_s, end_s, text} です")
    return sorted(words, key=lambda w: w.start_s)


def make_handler(cfg: Config):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ChapterLens/" + __version__

        def log_message(self, fmt, *args):  # 標準のログは出さない(監査ログに一本化)
            pass

        # ---- 共通 ----
        def _audit(self, status: int, route: str, started: float) -> None:
            try:
                with open(cfg.audit_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps({"t": round(time.time(), 3), "route": route, "status": status,
                                        "ms": round((time.time() - started) * 1000), "owner": OWNER}) + "\n")
            except OSError:
                pass

        def _cors_headers(self) -> dict:
            origin = self.headers.get("Origin")
            if origin and origin in cfg.allow_origins:
                return {
                    "Access-Control-Allow-Origin": origin,
                    "Vary": "Origin",
                    "Access-Control-Allow-Headers": "authorization, content-type",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Private-Network": "true",
                }
            return {}

        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in self._cors_headers().items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _check_host_origin(self) -> None:
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
            if host not in ("127.0.0.1", "localhost"):
                raise HttpError(403, "Host が許可されていません")
            origin = self.headers.get("Origin")
            if origin and origin not in cfg.allow_origins:
                raise HttpError(403, "この Origin からは呼べません")

        def _check_token(self) -> None:
            got = self.headers.get("Authorization", "")
            want = "Bearer " + cfg.token
            if not hmac.compare_digest(got.encode("utf-8"), want.encode("utf-8")):
                raise HttpError(401, "token が違います")

        def _read_body(self, limit: int) -> bytes:
            try:
                n = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise HttpError(400, "Content-Length が不正です")
            if n < 0:
                raise HttpError(400, "Content-Length が不正です")
            if n > limit:
                raise HttpError(413, f"本文が大きすぎます(上限 {limit // (1024 * 1024)}MB)")
            return self.rfile.read(n)

        def _json(self) -> dict:
            try:
                obj = json.loads(self._read_body(MAX_JSON_BYTES).decode("utf-8") or "{}")
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise HttpError(400, "JSON を読めません")
            if not isinstance(obj, dict):
                raise HttpError(400, "JSON のオブジェクトを送ってください")
            return obj

        def _dispatch(self, method: str) -> None:
            started = time.time()
            url = urlparse(self.path)
            route = url.path
            status = 500
            try:
                self._check_host_origin()
                if method == "OPTIONS":  # プリフライト(Origin 検査は通った)。token は要らない
                    self.send_response(204)
                    for k, v in self._cors_headers().items():
                        self.send_header(k, v)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    status = 204
                    return
                self._check_token()
                status, body = self._route(method, route, parse_qs(url.query))
                self._send(status, body)
            except HttpError as e:
                status = e.status
                self._send(status, {"error": e.message})
            except Exception:  # 想定外。内容は返さない
                status = 500
                self._send(500, {"error": "内部エラー"})
            finally:
                self._audit(status, route, started)

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_OPTIONS(self):
            self._dispatch("OPTIONS")

        # ---- 経路 ----
        def _route(self, method: str, route: str, query: dict) -> tuple[int, dict]:
            if route == "/v1/health" and method == "GET":
                try:
                    import faster_whisper  # noqa: F401
                    asr_ok = True
                except ImportError:
                    asr_ok = False
                return 200, {"ok": True, "version": __version__, "asr": asr_ok, "detectors": available()}
            if route == "/v1/detect" and method == "POST":
                return 200, self._detect(self._json())
            if route == "/v1/transcribe" and method == "POST":
                return 200, self._transcribe(query)
            if route == "/v1/corrections" and method == "POST":
                return 200, self._corrections_post(self._json())
            if route == "/v1/corrections" and method == "GET":
                return 200, self._corrections_get(query)
            if route == "/v1/corrections/undo" and method == "POST":
                body = self._json()
                return 200, {"undone": cfg.store.undo_last(OWNER, str(body.get("video", "")))}
            raise HttpError(404, "そのエンドポイントはありません")

        def _detect(self, body: dict) -> dict:
            cues = _validate_cues(body.get("cues"))
            try:
                duration = float(body.get("duration") or max(c.end_s for c in cues))
            except (TypeError, ValueError):
                raise HttpError(400, "duration が不正です")
            name = body.get("detector", "topic-shift@2")
            if name not in available():
                raise HttpError(400, f"検出器がありません: {name}")
            target = body.get("target_count")
            if target is not None and not (isinstance(target, int) and 0 <= target <= 1000):
                raise HttpError(400, "target_count が不正です")
            det = get_detector(name).detect(cues, duration, target_count=target)
            boundaries, scores = det.boundaries, det.scores
            words = _validate_words(body.get("words"))
            if words:  # 単語の時刻があれば、境界を発話の頭へ寄せる
                boundaries = snap_to_utterances(boundaries, words)
            video = body.get("video")
            if video:  # 利用者の修正があれば反映する(元の検出は残したまま、結果にだけ適用)
                corrected = cfg.store.corrected(OWNER, str(video), boundaries)
                if corrected != boundaries:
                    boundaries, scores = corrected, []
            segments = segments_from_boundaries(boundaries, duration, detector=name, scores=scores or None)
            doc = to_document({"kind": "api", "id": str(video or ""), "duration_s": duration}, segments, engine=__version__)
            doc["boundaries"] = boundaries
            return doc

        def _transcribe(self, query: dict) -> dict:
            data = self._read_body(cfg.max_audio_bytes)
            if not data:
                raise HttpError(400, "音声が空です")
            language = (query.get("language") or [None])[0]
            if language is not None and not (language.isalpha() and len(language) <= 5):
                raise HttpError(400, "language が不正です")
            model = (query.get("model") or ["small"])[0]
            if model not in ("tiny", "base", "small", "medium", "large-v3"):
                raise HttpError(400, "model が不正です")
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "audio.bin"
                path.write_bytes(data)
                try:
                    with cfg.asr_lock:
                        res = cfg.asr_fn(path, language=language, model_size=model)
                except AsrUnavailable as e:
                    raise HttpError(501, str(e))
            out = {"language": res.language, "duration": res.duration_s, "model": res.model, "device": res.device,
                   "cues": [{"start": c.start_s, "end": c.end_s, "text": c.text} for c in res.cues]}
            if (query.get("words") or ["0"])[0] == "1":
                out["words"] = [{"start_s": w.start_s, "end_s": w.end_s, "text": w.text} for w in res.words]
            return out

        def _corrections_post(self, body: dict) -> dict:
            try:
                cid = cfg.store.record(OWNER, str(body.get("video", "")), str(body.get("action", "")),
                                       from_s=body.get("from_s"), to_s=body.get("to_s"), detector=body.get("detector"))
            except CorrectionError as e:
                raise HttpError(400, str(e))
            return {"id": cid}

        def _corrections_get(self, query: dict) -> dict:
            video = (query.get("video") or [""])[0]
            if not video:
                return {"stats": cfg.store.stats(OWNER)}
            return {"corrections": cfg.store.list(OWNER, video)}

    return Handler


def create_server(cfg: Config, port: int = 8787) -> ThreadingHTTPServer:
    """127.0.0.1 だけで待ち受ける。port=0 で空いているポートを使う(テスト用)。"""
    return ThreadingHTTPServer(("127.0.0.1", port), make_handler(cfg))


def serve(port: int = 8787, allow_origins: list[str] | None = None, max_audio_mb: int = DEFAULT_MAX_AUDIO_MB) -> None:
    cfg = Config(allow_origins=allow_origins, max_audio_mb=max_audio_mb)
    httpd = create_server(cfg, port)
    print(f"ChapterLens engine {__version__}: http://127.0.0.1:{httpd.server_address[1]}/v1/health")
    print(f"token の場所: {cfg.home / 'token'}(他人に見せない)")
    print("許可する Origin: " + (", ".join(sorted(cfg.allow_origins)) or "なし(ブラウザからは呼べません。--allow-origin で許可)"))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
