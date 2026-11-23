"""ローカル LLM の窓口(LocalLLMHarness。OpenAI 互換)への、最小のクライアント。

**送り先は loopback の http だけ**(字幕の本文を、この PC の外へ出さない)。リダイレクトは辿らない。
token は環境変数の**名前**で受け取り、値は、エラー文にもログにも出さない。標準ライブラリだけ。
"""

from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Mapping
from urllib.parse import urlsplit

DEFAULT_URL = "http://127.0.0.1:8800/v1"
DEFAULT_MODEL = "llh-main"
DEFAULT_TOKEN_ENV = "LLH_TOKEN"
DEFAULT_TIMEOUT_S = 120.0
_LOOPBACK = {"127.0.0.1", "localhost", "::1"}
MAX_RESPONSE_BYTES = 1024 * 1024


class LlmError(Exception):
    """窓口との通信の失敗。メッセージに、本文・token は含めない。"""

    def __init__(self, code: str, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.code = code  # "unreachable" | "timeout" | "bad_response" | "refused"
        self.status = status  # 窓口が返した HTTP の状態(分かるときだけ)。案内の出し分けに使う


@dataclass(frozen=True)
class LlmConfig:
    url: str
    model: str
    token_env: str
    timeout_s: float


def _check_url(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme != "http" or (parts.hostname or "") not in _LOOPBACK:
        raise ValueError("ローカル LLM の URL は、この PC の http(127.0.0.1 / localhost)だけです")
    return url.rstrip("/")


def llm_config_from_env(environ: Mapping[str, str] = os.environ) -> LlmConfig:
    try:
        timeout = float(environ.get("CHAPTERLENS_LLM_TIMEOUT_S") or DEFAULT_TIMEOUT_S)
    except ValueError:
        raise ValueError("CHAPTERLENS_LLM_TIMEOUT_S は数値です") from None
    return LlmConfig(
        url=_check_url(environ.get("CHAPTERLENS_LLM_URL") or DEFAULT_URL),
        model=environ.get("CHAPTERLENS_LLM_MODEL") or DEFAULT_MODEL,
        token_env=environ.get("CHAPTERLENS_LLM_TOKEN_ENV") or DEFAULT_TOKEN_ENV,
        timeout_s=max(1.0, timeout),
    )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # 3xx は辿らない(HTTPError として上がる)
        return None


# プロキシは使わない: HTTP_PROXY やシステムの設定に従うと、字幕と token が 127.0.0.1 の外(プロキシ)へ出てしまう
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


def chat(cfg: LlmConfig, system: str, user: str, *, max_tokens: int = 200, environ: Mapping[str, str] = os.environ) -> str:
    body = json.dumps(
        {
            "model": cfg.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": 0.2,
            "max_tokens": max_tokens,
            "enable_thinking": False,  # 考える文で、短い出力枠が尽きて本文が空になるのを防ぐ(窓口は、この指定を優先する)
        },
        ensure_ascii=False,
    ).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    token = environ.get(cfg.token_env)
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(_check_url(cfg.url) + "/chat/completions", data=body, headers=headers, method="POST")
    try:
        with _OPENER.open(req, timeout=cfg.timeout_s) as res:
            raw = res.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            raise LlmError("refused", "窓口がリダイレクトを返しました(辿りません)") from None
        raise LlmError("bad_response", f"窓口が HTTP {e.code} を返しました", status=e.code) from None
    except (socket.timeout, TimeoutError):
        raise LlmError("timeout", "窓口の応答が時間内に返りませんでした") from None
    except urllib.error.URLError as e:
        if isinstance(e.reason, (socket.timeout, TimeoutError)):
            raise LlmError("timeout", "窓口の応答が時間内に返りませんでした") from None
        raise LlmError("unreachable", "窓口に接続できません") from None
    except OSError:
        raise LlmError("unreachable", "窓口に接続できません") from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise LlmError("bad_response", "窓口の応答が大きすぎます")
    try:
        content = json.loads(raw.decode("utf-8"))["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError):
        raise LlmError("bad_response", "窓口の応答の形が違います") from None
    if not isinstance(content, str):
        raise LlmError("bad_response", "窓口の応答の形が違います")
    return content
