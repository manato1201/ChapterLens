"""監査ログ(CH3。設計書 §10 S-C)と、利用者ごとのレート制限(S-D)。

監査ログは 1 行 1 件の JSON。残すのは、時刻・誰が(利用者 ID・役割)・何を(経路 / 操作名)・結果・所要時間・対象の ID だけ。
**字幕の本文・音声・token・共有した区間データの中身は残さない**。大きくなったら 1 世代だけ回す。
"""

from __future__ import annotations

import json
import threading
import time
from collections import deque
from pathlib import Path

MAX_LOG_BYTES = 5 * 1024 * 1024
SAFE_FIELD_CHARS = 120


class AuditLog:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    def _write(self, rec: dict) -> None:
        line = json.dumps(rec, ensure_ascii=False) + "\n"
        with self._lock:
            try:
                if self.path.exists() and self.path.stat().st_size > MAX_LOG_BYTES:
                    self.path.replace(self.path.with_suffix(self.path.suffix + ".1"))
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(line)
            except OSError:
                pass

    def route(self, *, route: str, status: int, started: float, user: dict | None) -> None:
        self._write({"t": round(time.time(), 3), "route": route, "status": status, "ms": round((time.time() - started) * 1000),
                     "owner": user["id"] if user else None, "role": user["role"] if user else None})

    def event(self, actor: str, name: str, **fields) -> None:
        """管理操作・共有・設定変更。fields は ID・名前・モードなど、短い値だけ。"""
        clean = {k: (v if isinstance(v, (int, float, bool)) or v is None else str(v)[:SAFE_FIELD_CHARS]) for k, v in fields.items()}
        self._write({"t": round(time.time(), 3), "event": name, "actor": actor, **clean})

    def tail(self, n: int = 100) -> list[dict]:
        n = max(1, min(int(n), 1000))
        if not self.path.exists():
            return []
        lines: deque[str] = deque(maxlen=n)
        with open(self.path, encoding="utf-8", errors="replace") as f:
            for line in f:
                lines.append(line)
        out = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out


class RateLimiter:
    """利用者ごと・経路の種類ごとの、スライディング窓。limits = {group: (回数, 秒)}。超えたら、待つ秒数を返す。"""

    def __init__(self, limits: dict[str, tuple[int, float]], clock=time.monotonic) -> None:
        self.limits = limits
        self.clock = clock
        self._hits: dict[tuple[str, str], deque[float]] = {}
        self._lock = threading.Lock()

    def check(self, user_id: str, group: str) -> float | None:
        limit = self.limits.get(group)
        if limit is None:
            return None
        count, window = limit
        now = self.clock()
        with self._lock:
            q = self._hits.setdefault((user_id, group), deque())
            while q and now - q[0] >= window:
                q.popleft()
            if len(q) >= count:
                return max(0.1, window - (now - q[0]))
            q.append(now)
        return None
