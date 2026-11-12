"""ライブ検出のセッション(CH5)。利用者ごとに、字幕を足していく検出器をメモリに持つ(保存しない。再起動・期限で消える)。

守り(設計書 §10):
  ・セッションは利用者のものだけ(他の人の ID を知っていても、見えない・足せない)(S-F)
  ・利用者ごとの同時数・1 回に送れる字幕数・1 セッションの字幕数に上限(S-D)。古いものから捨てる・一定時間使われなければ消す
  ・字幕の本文は、メモリの外に出さない(監査ログにも書かない)
"""

from __future__ import annotations

import secrets
import threading
import time

from .captions import Cue
from .live import LiveDetector, LiveParams

MAX_SESSIONS_PER_USER = 4
IDLE_TTL_S = 2 * 3600
MAX_PUSH_CUES = 500


class LiveSessionError(KeyError):
    pass


class LiveSessions:
    def __init__(self, clock=time.monotonic, params: LiveParams | None = None) -> None:
        self._clock = clock
        self._params = params
        self._lock = threading.Lock()  # 一覧の出し入れだけ。重い検出はセッションごとのロックで(他の人を待たせない)
        self._items: dict[tuple[str, str], dict] = {}  # (owner, id) → {det, used, lock}

    def _sweep(self) -> None:
        now = self._clock()
        for key in [k for k, v in self._items.items() if now - v["used"] > IDLE_TTL_S]:
            del self._items[key]

    def push(self, owner: str, session_id: str | None, cues: list[Cue], now_s: float | None) -> tuple[str, dict]:
        """字幕を足して、いまの印を返す。session_id が None なら新しく始める。無い ID は LiveSessionError。"""
        with self._lock:
            self._sweep()
            created = False
            if session_id is None:
                mine = sorted((v["used"], k) for k, v in self._items.items() if k[0] == owner)
                while len(mine) >= MAX_SESSIONS_PER_USER:  # 一番古いものを捨てる
                    del self._items[mine.pop(0)[1]]
                session_id = secrets.token_hex(8)
                self._items[(owner, session_id)] = {"det": LiveDetector(self._params), "used": self._clock(), "lock": threading.Lock()}
                created = True
            item = self._items.get((owner, session_id))
            if item is None:
                raise LiveSessionError("セッションがありません(期限切れか、他の利用者のものです)")
            item["used"] = self._clock()
        det: LiveDetector = item["det"]
        with item["lock"]:  # 同じセッションへの同時の push だけを順番にする
            det.push(cues, now_s=now_s)
            return session_id, {"now_s": round(det.now_s, 3), "markers": det.markers(), "dropped": det.dropped, "created": created}

    def close(self, owner: str, session_id: str) -> bool:
        with self._lock:
            return self._items.pop((owner, session_id), None) is not None

    def delete_owner(self, owner: str) -> int:
        with self._lock:
            keys = [k for k in self._items if k[0] == owner]
            for k in keys:
                del self._items[k]
            return len(keys)

    def count(self, owner: str | None = None) -> int:
        with self._lock:
            return sum(1 for k in self._items if owner is None or k[0] == owner)
