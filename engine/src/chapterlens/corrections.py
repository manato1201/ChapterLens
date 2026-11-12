"""利用者の修正の保存と反映(CH2。設計書 §9「成長性」)。

境界を動かす(move)・足す(add)・消す(delete)という修正を、SQLite(標準ライブラリ)に残す。
- **元の検出は書き換えない**(修正は別の行として積む。いつでも「元に戻して」見直せる)
- 修正は owner ごとに分ける(S-F: 他の人の修正を見せない)。いまは 1 人(owner = "local")。複数人は CH3
- 保存するのは、時刻と動画のキー(YouTube の動画 ID など)だけ。字幕の本文・音声は残さない
- apply_corrections: 検出した境界に修正を順に適用する(純粋な関数)
- to_reference: 修正後の境界を、評価データ(chapters.json)の形にする(「修正された動画は評価セットに足せる」)
"""

from __future__ import annotations

import functools
import sqlite3
import threading
import time
from pathlib import Path

ACTIONS = ("move", "add", "delete")
DEFAULT_TOL_S = 3.0  # 「この境界のことだ」と対応づける許容(秒)


class CorrectionError(ValueError):
    pass


def _locked(fn):
    """サーバーは複数のスレッドから呼ぶので、SQLite の操作を 1 つずつにする。"""

    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        with self._lock:
            return fn(self, *args, **kwargs)

    return wrapper


def apply_corrections(boundaries: list[float], corrections: list[dict], *, tol_s: float = DEFAULT_TOL_S) -> list[float]:
    """検出した境界に、修正を古い順に適用する。

    - move   from_s の近く(±tol_s)の境界を to_s へ動かす。近くに無ければ、to_s に足す
    - add    to_s に足す(1 秒以内に既にあれば何もしない)
    - delete from_s の近くの境界を消す(無ければ何もしない)
    """
    cur = sorted(boundaries)

    def nearest(x: float) -> int | None:
        best = None
        for i, b in enumerate(cur):
            if abs(b - x) <= tol_s and (best is None or abs(b - x) < abs(cur[best] - x)):
                best = i
        return best

    for c in sorted(corrections, key=lambda c: (c.get("created_at", 0), c.get("id", 0))):
        action = c["action"]
        if action == "move":
            i = nearest(c["from_s"])
            if i is not None:
                cur[i] = c["to_s"]
            else:
                cur.append(c["to_s"])
        elif action == "add":
            if not any(abs(b - c["to_s"]) <= 1.0 for b in cur):
                cur.append(c["to_s"])
        elif action == "delete":
            i = nearest(c["from_s"])
            if i is not None:
                del cur[i]
        cur.sort()
    # 近すぎる重複は 1 つに(先のものを残す)
    out: list[float] = []
    for b in cur:
        if not out or b - out[-1] > 1.0:
            out.append(b)
    return out


def to_reference(boundaries: list[float], titles: list[str] | None = None) -> dict:
    """評価データの chapters.json の形(先頭は 0 秒)。"""
    starts = [0.0, *sorted(boundaries)]
    titles = titles or []
    return {
        "chapters": [
            {"start_s": s, "title": titles[i] if i < len(titles) else ""} for i, s in enumerate(starts)
        ]
    }


class CorrectionStore:
    def __init__(self, path: str | Path = ":memory:") -> None:
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self._lock = threading.RLock()
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS corrections (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 owner TEXT NOT NULL,
                 video_key TEXT NOT NULL,
                 action TEXT NOT NULL,
                 from_s REAL,
                 to_s REAL,
                 detector TEXT,
                 created_at REAL NOT NULL
               )"""
        )
        self.db.execute("CREATE INDEX IF NOT EXISTS idx_corr_owner_video ON corrections (owner, video_key)")
        self.db.commit()

    @_locked
    def record(self, owner: str, video_key: str, action: str, *, from_s: float | None = None,
               to_s: float | None = None, detector: str | None = None) -> int:
        if action not in ACTIONS:
            raise CorrectionError(f"action が不正です: {action!r}(move / add / delete)")
        if not video_key or len(video_key) > 200:
            raise CorrectionError("video_key が不正です")
        for name, v in (("from_s", from_s), ("to_s", to_s)):
            if v is not None and not (isinstance(v, (int, float)) and 0 <= v < 24 * 3600):
                raise CorrectionError(f"{name} が不正です: {v!r}")
        if action in ("move", "delete") and from_s is None:
            raise CorrectionError(f"{action} には from_s が要ります")
        if action in ("move", "add") and to_s is None:
            raise CorrectionError(f"{action} には to_s が要ります")
        cur = self.db.execute(
            "INSERT INTO corrections (owner, video_key, action, from_s, to_s, detector, created_at) VALUES (?,?,?,?,?,?,?)",
            (owner, video_key, action, from_s, to_s, detector, time.time()),
        )
        self.db.commit()
        return int(cur.lastrowid)

    @_locked
    def list(self, owner: str, video_key: str) -> list[dict]:
        rows = self.db.execute(
            "SELECT id, action, from_s, to_s, detector, created_at FROM corrections WHERE owner=? AND video_key=? ORDER BY created_at, id",
            (owner, video_key),
        ).fetchall()
        return [dict(zip(("id", "action", "from_s", "to_s", "detector", "created_at"), r)) for r in rows]

    @_locked
    def undo_last(self, owner: str, video_key: str) -> bool:
        row = self.db.execute(
            "SELECT id FROM corrections WHERE owner=? AND video_key=? ORDER BY created_at DESC, id DESC LIMIT 1", (owner, video_key)
        ).fetchone()
        if not row:
            return False
        self.db.execute("DELETE FROM corrections WHERE id=?", (row[0],))
        self.db.commit()
        return True

    @_locked
    def stats(self, owner: str) -> dict:
        rows = self.db.execute("SELECT action, COUNT(*) FROM corrections WHERE owner=? GROUP BY action", (owner,)).fetchall()
        videos = self.db.execute("SELECT COUNT(DISTINCT video_key) FROM corrections WHERE owner=?", (owner,)).fetchone()[0]
        return {"by_action": dict(rows), "videos": videos}

    @_locked
    def corrected(self, owner: str, video_key: str, boundaries: list[float], *, tol_s: float = DEFAULT_TOL_S) -> list[float]:
        return apply_corrections(boundaries, self.list(owner, video_key), tol_s=tol_s)

    @_locked
    def delete_owner(self, owner: str) -> int:
        """利用者の修正を全部消す(本人の「忘れる」・管理者の削除)。"""
        cur = self.db.execute("DELETE FROM corrections WHERE owner=?", (owner,))
        self.db.commit()
        return cur.rowcount

    @_locked
    def close(self) -> None:
        self.db.close()
