"""利用者・役割・設定(CH3。設計書 §10)。標準ライブラリの SQLite だけ。

- 役割は 2 つ: user(自分のデータだけ)/ admin(利用者・設定・共有範囲・監査ログ)。**認可は、呼ばれたエンジンの側で行う**(S-A)
- token は **ハッシュ(SHA-256)だけを保存**する(S-B)。作った時に 1 度だけ表示し、あとから見ることはできない。
  token は 256 ビットの乱数なので、ソルト・遅いハッシュは要らない(推測できないものの保管)
- 既存の token ファイル(CH2)の token は、管理者 `local` として扱う(後方互換)。`local` は、停止・削除・役割変更ができない
  (token ファイルを消せば、新しい token を作り直せる=復旧の入口。管理者が全員いなくなる事故を防ぐ)
- 設定: share_mode = off(既定。共有しない)/ team(利用者が全員か、指定した人へ)/ named(指定した人だけ)
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

ROLES = ("user", "admin")
SHARE_MODES = ("off", "team", "named")
BOOTSTRAP_ID = "local"
USER_ID_RE = re.compile(r"^(local|u_[0-9a-f]{8})$")


class AccountError(ValueError):
    pass


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def clean_name(name: object) -> str:
    if not isinstance(name, str):
        raise AccountError("名前は文字列です")
    name = name.strip()
    if not (1 <= len(name) <= 40) or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise AccountError("名前は 1〜40 文字(制御文字なし)で指定してください")
    return name


def _public(row: tuple) -> dict:
    return {"id": row[0], "name": row[1], "role": row[2], "disabled": bool(row[3]), "created_at": row[4]}


class AccountStore:
    def __init__(self, path: str | Path = ":memory:") -> None:
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self._lock = threading.RLock()
        with self._lock:
            self.db.execute(
                """CREATE TABLE IF NOT EXISTS users (
                     id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
                     token_hash TEXT NOT NULL UNIQUE, disabled INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL)"""
            )
            self.db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            self.db.commit()
        if str(path) != ":memory:":
            try:
                Path(path).chmod(0o600)
            except OSError:
                pass

    # ---- 起動時: 既存の token ファイルの token を、管理者 local にする ----
    def ensure_bootstrap_admin(self, token: str) -> None:
        h = hash_token(token)
        with self._lock:
            row = self.db.execute("SELECT 1 FROM users WHERE id=?", (BOOTSTRAP_ID,)).fetchone()
            if row:
                self.db.execute("UPDATE users SET token_hash=?, role='admin', disabled=0 WHERE id=?", (h, BOOTSTRAP_ID))
            else:
                self.db.execute(
                    "INSERT INTO users (id, name, role, token_hash, disabled, created_at) VALUES (?,?,?,?,0,?)",
                    (BOOTSTRAP_ID, "local", "admin", h, time.time()),
                )
            self.db.commit()

    # ---- 認証 ----
    def authenticate(self, token: str) -> dict | None:
        """token から利用者を引く。無効化された利用者・不明な token は None(区別して返さない)。全員と比べて、早く終わらない。"""
        if not token:
            return None
        h = hash_token(token)
        found = None
        with self._lock:
            rows = self.db.execute("SELECT id, name, role, disabled, created_at, token_hash FROM users").fetchall()
        for r in rows:
            if hmac.compare_digest(h, r[5]) and found is None:
                found = r
        if found is None or found[3]:
            return None
        return _public(found[:5])

    # ---- 管理 ----
    def create_user(self, name: object, role: str = "user") -> tuple[dict, str]:
        name = clean_name(name)
        if role not in ROLES:
            raise AccountError(f"role が不正です: {role!r}({'/'.join(ROLES)})")
        token = secrets.token_urlsafe(32)
        uid = "u_" + secrets.token_hex(4)
        with self._lock:
            if self.db.execute("SELECT 1 FROM users WHERE lower(name)=lower(?)", (name,)).fetchone():
                raise AccountError("その名前はすでに使われています")
            self.db.execute(
                "INSERT INTO users (id, name, role, token_hash, disabled, created_at) VALUES (?,?,?,?,0,?)",
                (uid, name, role, hash_token(token), time.time()),
            )
            self.db.commit()
        return self.get(uid), token

    def get(self, user_id: str) -> dict | None:
        with self._lock:
            r = self.db.execute("SELECT id, name, role, disabled, created_at FROM users WHERE id=?", (user_id,)).fetchone()
        return _public(r) if r else None

    def list_users(self) -> list[dict]:
        with self._lock:
            rows = self.db.execute("SELECT id, name, role, disabled, created_at FROM users ORDER BY created_at, id").fetchall()
        return [_public(r) for r in rows]

    def active_names(self) -> dict[str, str]:
        with self._lock:
            rows = self.db.execute("SELECT id, name FROM users WHERE disabled=0").fetchall()
        return dict(rows)

    def check_manageable(self, user_id: str, what: str) -> dict:
        if not USER_ID_RE.match(user_id or ""):
            raise AccountError("利用者 ID が不正です")
        u = self.get(user_id)
        if not u:
            raise AccountError("その利用者はいません")
        if user_id == BOOTSTRAP_ID:
            raise AccountError(f"local は{what}できません(token ファイルで管理する管理者です)")
        return u

    def set_disabled(self, user_id: str, disabled: bool) -> dict:
        self.check_manageable(user_id, "停止")
        with self._lock:
            self.db.execute("UPDATE users SET disabled=? WHERE id=?", (1 if disabled else 0, user_id))
            self.db.commit()
        return self.get(user_id)

    def set_role(self, user_id: str, role: str) -> dict:
        if role not in ROLES:
            raise AccountError(f"role が不正です: {role!r}")
        self.check_manageable(user_id, "役割を変更")
        with self._lock:
            self.db.execute("UPDATE users SET role=? WHERE id=?", (role, user_id))
            self.db.commit()
        return self.get(user_id)

    def rotate_token(self, user_id: str) -> str:
        self.check_manageable(user_id, "token を再発行")
        token = secrets.token_urlsafe(32)
        with self._lock:
            self.db.execute("UPDATE users SET token_hash=? WHERE id=?", (hash_token(token), user_id))
            self.db.commit()
        return token

    def delete_user(self, user_id: str) -> None:
        self.check_manageable(user_id, "削除")
        with self._lock:
            self.db.execute("DELETE FROM users WHERE id=?", (user_id,))
            self.db.commit()

    # ---- 設定 ----
    def get_setting(self, key: str, default: str) -> str:
        with self._lock:
            r = self.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return r[0] if r else default

    def set_setting(self, key: str, value: str) -> None:
        with self._lock:
            self.db.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
            self.db.commit()

    @property
    def share_mode(self) -> str:
        v = self.get_setting("share_mode", "off")
        return v if v in SHARE_MODES else "off"

    def set_share_mode(self, mode: str) -> None:
        if mode not in SHARE_MODES:
            raise AccountError(f"share_mode が不正です: {mode!r}({'/'.join(SHARE_MODES)})")
        self.set_setting("share_mode", mode)

    def close(self) -> None:
        with self._lock:
            self.db.close()
