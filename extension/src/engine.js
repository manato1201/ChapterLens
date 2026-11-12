/*
 * ローカルエンジン(127.0.0.1)の API を呼ぶ口(共有・ライブ・管理)。
 * 実際の通信(fetch)は background.js だけが行う(送り先の検査と token の取り扱いを 1 か所に閉じるため)。
 * ここは「どの経路を、どの形で頼むか」と「失敗の説明」だけで、ネットワークには触れない。
 *
 * 守りはエンジンの側にある(S-A)。この口は、画面の出し分け(管理者でなければ管理画面を出さない)のための便利に過ぎない。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChapterLensEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const USER_ID = /^(local|u_[0-9a-f]{8})$/;
  const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;

  /** 失敗の説明(利用者に見せる日本語)。res = { ok:false, status?, code?, error? } */
  function describeError(res) {
    if (!res || res.ok) return "";
    if (res.code === "unconfigured") return "エンジンの接続設定(URL・token)がありません。ツールバーの ChapterLens のアイコンから設定してください。";
    if (res.code === "unreachable") return "エンジンに接続できません。エンジン(engine/ で uv run python -m chapterlens serve)を起動しているか確認してください。";
    if (res.code === "origin") return "エンジンがこの拡張を許可していません。エンジンを --allow-origin chrome-extension://<この拡張の ID> で起動してください。";
    if (res.status === 401) return "token が違います(停止された利用者の token かもしれません)。";
    if (res.status === 429) return "リクエストが多すぎます。少し待ってからお試しください。";
    return res.error || "エンジンがエラーを返しました。";
  }

  function createClient(send) {
    async function call(method, path, body) {
      try {
        const res = await send({ target: "background", type: "engine", method, path, body });
        return res || { ok: false, code: "relay", error: "拡張の内部で応答がありませんでした。" };
      } catch (e) {
        return { ok: false, code: "relay", error: String((e && e.message) || e) };
      }
    }
    const need = (cond, msg) => { if (!cond) throw new TypeError(msg); };

    return {
      call,
      me: () => call("GET", "/v1/me"),
      forget: () => call("POST", "/v1/me/forget", {}),
      // 共有(CH3)
      shares(video) { need(VIDEO_ID.test(video || ""), "video が不正です"); return call("GET", "/v1/shares?video=" + encodeURIComponent(video)); },
      mine: () => call("GET", "/v1/shares"),
      publish(share) { need(share && VIDEO_ID.test(share.video || ""), "video が不正です"); return call("POST", "/v1/shares", share); },
      revoke(video) { need(VIDEO_ID.test(video || ""), "video が不正です"); return call("POST", "/v1/shares/revoke", { video }); },
      // ライブ(CH5)
      live(session, cues, nowS) {
        const body = { cues, now_s: nowS };
        if (session) body.session = session;
        return call("POST", "/v1/live", body);
      },
      liveClose: (session) => call("POST", "/v1/live/close", { session }),
      // 管理(管理者だけ。エンジンが役割を確かめる)
      users: () => call("GET", "/v1/admin/users"),
      addUser: (name, role) => call("POST", "/v1/admin/users", { name, role: role || "user" }),
      userAction(id, action, body) {
        need(USER_ID.test(id || ""), "利用者 ID が不正です");
        need(["disable", "enable", "rotate", "purge", "role"].includes(action), "操作が不正です");
        return call("POST", `/v1/admin/users/${id}/${action}`, body || {});
      },
      settings: () => call("GET", "/v1/admin/settings"),
      setShareMode: (mode) => call("POST", "/v1/admin/settings", { share_mode: mode }),
      audit: (n) => call("GET", "/v1/admin/audit?n=" + Math.max(1, Math.min(500, Number(n) || 100))),
    };
  }

  return { createClient, describeError, USER_ID, VIDEO_ID };
});
