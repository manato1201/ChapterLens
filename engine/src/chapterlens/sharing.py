"""区間データの共有(CH3。設計書 §0「共有は利用者の許可つき」・§10 S-F)。

共有するのは **区間データだけ**(境界の秒・長さ・利用者が付けた短い題名)。動画・音声・字幕の全文は共有しない。
- 管理者が共有範囲(share_mode)を決める。既定 off(誰も共有できない)
- 共有は、利用者が動画ごとに **明示して** 公開する(相手は「全員(team)」か、指定した利用者)。いつでも取り下げられる
- 見えるのは、自分のものと、自分に向けて公開されたものだけ。停止された利用者のものは見えない
"""

from __future__ import annotations

import json
import math
import sqlite3
import threading
import time
from pathlib import Path

MAX_BOUNDARIES = 500
MAX_TITLE_CHARS = 60
MAX_AUDIENCE = 50
MAX_DURATION_S = 24 * 3600
MAX_VIDEO_KEY = 200


class ShareError(ValueError):
    pass


def validate_share(body: dict, *, mode: str, owner_id: str, active_ids: set[str]) -> dict:
    """公開の依頼を検証して、保存できる形にする。余計な項目(字幕など)は、受け付けない。"""
    if mode == "off":
        raise ShareError("共有は、管理者が無効にしています")
    allowed = {"video", "boundaries", "titles", "duration", "audience"}
    extra = set(body) - allowed
    if extra:
        raise ShareError(f"共有できるのは区間データだけです(不要な項目: {', '.join(sorted(extra))})")
    video = body.get("video")
    if not isinstance(video, str) or not (1 <= len(video) <= MAX_VIDEO_KEY) or any(ord(c) < 32 for c in video):
        raise ShareError("video が不正です")
    b = body.get("boundaries")
    if not isinstance(b, list) or len(b) > MAX_BOUNDARIES:
        raise ShareError(f"boundaries は {MAX_BOUNDARIES} 個までの配列です")
    for x in b:
        if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or not (0 < x < MAX_DURATION_S):
            raise ShareError("boundaries の値が不正です(0 より大きい秒)")
    boundaries = sorted({round(float(x), 3) for x in b})
    duration = body.get("duration")
    if duration is not None:
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not (0 < duration <= MAX_DURATION_S):
            raise ShareError("duration が不正です")
        duration = float(duration)
        if boundaries and boundaries[-1] >= duration:
            raise ShareError("boundaries が duration を超えています")
    titles = body.get("titles")
    if titles is not None:
        if not isinstance(titles, list) or len(titles) != len(boundaries) + 1:
            raise ShareError("titles は「章の数(境界の数 + 1)」個の配列です")
        for t in titles:
            if not isinstance(t, str) or len(t) > MAX_TITLE_CHARS or any(ord(c) < 32 for c in t):
                raise ShareError(f"題名は {MAX_TITLE_CHARS} 文字までです")
    audience = body.get("audience", "team")
    if audience == "team":
        if mode == "named":
            raise ShareError("共有範囲が「指定した人だけ」です。audience に利用者 ID を並べてください")
    elif isinstance(audience, list):
        if not (1 <= len(audience) <= MAX_AUDIENCE) or not all(isinstance(a, str) for a in audience):
            raise ShareError("audience は利用者 ID の配列(1〜50 個)です")
        audience = sorted(set(audience))
        if owner_id in audience:
            raise ShareError("自分自身は指定できません")
        unknown = [a for a in audience if a not in active_ids]
        if unknown:
            raise ShareError("存在しない(または停止中の)利用者が含まれています")
    else:
        raise ShareError('audience は "team" か、利用者 ID の配列です')
    return {"video": video, "boundaries": boundaries, "titles": titles, "duration": duration, "audience": audience}


class ShareStore:
    def __init__(self, path: str | Path = ":memory:") -> None:
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self._lock = threading.RLock()
        with self._lock:
            self.db.execute(
                """CREATE TABLE IF NOT EXISTS shares (
                     owner TEXT NOT NULL, video_key TEXT NOT NULL, boundaries TEXT NOT NULL, titles TEXT,
                     duration REAL, audience TEXT NOT NULL, shared_at REAL NOT NULL,
                     PRIMARY KEY (owner, video_key))"""
            )
            self.db.commit()
        if str(path) != ":memory:":
            try:
                Path(path).chmod(0o600)
            except OSError:
                pass

    def publish(self, owner: str, v: dict) -> None:
        with self._lock:
            self.db.execute(
                "INSERT INTO shares (owner, video_key, boundaries, titles, duration, audience, shared_at) VALUES (?,?,?,?,?,?,?) "
                "ON CONFLICT(owner, video_key) DO UPDATE SET boundaries=excluded.boundaries, titles=excluded.titles, "
                "duration=excluded.duration, audience=excluded.audience, shared_at=excluded.shared_at",
                (owner, v["video"], json.dumps(v["boundaries"]), json.dumps(v["titles"], ensure_ascii=False) if v["titles"] is not None else None,
                 v["duration"], json.dumps(v["audience"]), time.time()),
            )
            self.db.commit()

    def revoke(self, owner: str, video: str) -> bool:
        with self._lock:
            cur = self.db.execute("DELETE FROM shares WHERE owner=? AND video_key=?", (owner, video))
            self.db.commit()
            return cur.rowcount > 0

    def visible(self, viewer: str, video: str, active_names: dict[str, str]) -> list[dict]:
        """viewer に見える共有(自分の・自分に向けて公開された・停止されていない人の)。"""
        with self._lock:
            rows = self.db.execute(
                "SELECT owner, boundaries, titles, duration, audience, shared_at FROM shares WHERE video_key=? ORDER BY shared_at DESC", (video,)
            ).fetchall()
        out = []
        for owner, b, t, dur, aud, at in rows:
            if owner not in active_names:
                continue
            audience = json.loads(aud)
            mine = owner == viewer
            if not (mine or audience == "team" or viewer in audience):
                continue
            out.append({"from": active_names[owner], "mine": mine, "boundaries": json.loads(b),
                        "titles": json.loads(t) if t else None, "duration": dur, "shared_at": at,
                        **({"audience": audience} if mine else {})})
        return out

    def mine(self, owner: str) -> list[dict]:
        with self._lock:
            rows = self.db.execute("SELECT video_key, audience, shared_at FROM shares WHERE owner=? ORDER BY shared_at DESC", (owner,)).fetchall()
        return [{"video": v, "audience": json.loads(a), "shared_at": at} for v, a, at in rows]

    def delete_owner(self, owner: str) -> int:
        with self._lock:
            cur = self.db.execute("DELETE FROM shares WHERE owner=?", (owner,))
            self.db.commit()
            return cur.rowcount

    def close(self) -> None:
        with self._lock:
            self.db.close()
