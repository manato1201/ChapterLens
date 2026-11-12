/* 共有と管理の画面。エンジンへの呼び出しは background.js の中継を通る(送り先は 127.0.0.1 だけ)。文字は textContent だけで入れる。 */
(function () {
  "use strict";
  const E = self.ChapterLensEngine;
  const Store = self.ChapterLensStore;
  const engine = E.createClient((m) => chrome.runtime.sendMessage(m));
  const $ = (id) => document.getElementById(id);
  const say = (text, kind) => { $("msg").textContent = text; $("msg").className = kind || ""; };
  const armed = new Map(); // 2 度押しで実行する操作(確認のダイアログは使えないため)

  function el(tag, props, children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "text") n.textContent = v;
      else if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children || []) n.append(c);
    return n;
  }

  /** 2 度押しで実行する(1 度目はボタンの表示を変え、4 秒以内にもう一度押すと実行)。 */
  function confirmable(label, confirmLabel, action, extra) {
    const b = el("button", Object.assign({ type: "button", text: label }, extra || {}));
    b.addEventListener("click", () => {
      if (armed.get(b)) { clearTimeout(armed.get(b)); armed.delete(b); b.textContent = label; action(); return; }
      b.textContent = confirmLabel;
      armed.set(b, setTimeout(() => { armed.delete(b); b.textContent = label; }, 4000));
    });
    return b;
  }

  function showSecret(label, token) {
    $("secret").hidden = false;
    $("secret-label").textContent = label;
    $("secret-token").textContent = token;
  }

  async function loadMe() {
    const res = await engine.me();
    if (!res.ok) { $("me").textContent = E.describeError(res); say(E.describeError(res), "err"); return null; }
    const u = res.data.user;
    $("me").textContent = `${u.name || u.id}(${u.id}・${u.role === "admin" ? "管理者" : "利用者"})/ 共有範囲: ${res.data.share_mode}`;
    return res.data;
  }

  async function loadUsers() {
    const res = await engine.users();
    if (!res.ok) { say(E.describeError(res), "err"); return; }
    const body = $("users");
    body.replaceChildren();
    for (const u of res.data.users) {
      const isLocal = u.id === "local"; // 最初の管理者は、止めない・消さない(エンジンも拒否する)
      const actions = el("td", { class: "actions" });
      if (!isLocal) {
        actions.append(
          el("button", { type: "button", text: u.disabled ? "再開" : "停止", onclick: async () => { const r = await engine.userAction(u.id, u.disabled ? "enable" : "disable"); r.ok ? (say("更新しました。", "ok"), loadUsers()) : say(E.describeError(r), "err"); } }),
          document.createTextNode(" "),
          confirmable("token 再発行", "もう一度押すと再発行", async () => { const r = await engine.userAction(u.id, "rotate"); if (r.ok) { showSecret(`${u.name} の新しい token`, r.data.token); say("token を再発行しました(古い token は使えません)。", "ok"); } else say(E.describeError(r), "err"); }),
          document.createTextNode(" "),
          confirmable("削除", "もう一度押すと完全に削除", async () => { const r = await engine.userAction(u.id, "purge"); r.ok ? (say(`${u.name} と、その修正・共有を削除しました。`, "ok"), loadUsers()) : say(E.describeError(r), "err"); }, { class: "danger" }),
        );
      } else actions.textContent = "(保護)";
      body.append(el("tr", {}, [el("td", { text: u.id }), el("td", { text: u.name }), el("td", { text: u.role === "admin" ? "管理者" : "利用者" }), el("td", { text: u.disabled ? "停止中" : "有効" }), actions]));
    }
  }

  async function loadAudit() {
    const res = await engine.audit(50);
    if (!res.ok) { say(E.describeError(res), "err"); return; }
    const lines = (res.data.events || []).slice().reverse().map((e) => {
      const when = e.t ? new Date(e.t * 1000).toLocaleString() : "";
      const what = e.event || `${e.route} → ${e.status}`;
      const rest = Object.entries(e).filter(([k]) => !["t", "event", "route", "status", "actor", "owner", "role", "ms"].includes(k)).map(([k, v]) => `${k}=${v}`).join(" ");
      return `${when}  ${e.actor || e.owner || ""}  ${what}  ${rest}`.trim();
    });
    $("audit").textContent = lines.join("\n") || "(まだ記録がありません)";
  }

  async function init() {
    const me = await loadMe();
    if (!me) return;
    $("mode").value = me.share_mode;
    if (me.user.role !== "admin") { say("管理者ではないため、利用者と共有範囲の管理は出ません(自分のデータの削除だけ使えます)。"); return; }
    $("admin-section").hidden = false;
    await Promise.all([loadUsers(), loadAudit()]);
  }

  $("save-mode").addEventListener("click", async () => {
    const r = await engine.setShareMode($("mode").value);
    r.ok ? say(`共有範囲を ${r.data.share_mode} にしました。`, "ok") : say(E.describeError(r), "err");
    loadAudit();
  });
  $("add-user").addEventListener("click", async () => {
    const name = $("new-name").value.trim();
    if (!name) { say("名前を入力してください。", "err"); return; }
    const r = await engine.addUser(name, $("new-role").value);
    if (!r.ok) { say(E.describeError(r), "err"); return; }
    $("new-name").value = "";
    showSecret(`${r.data.user.name}(${r.data.user.id})の token`, r.data.token);
    say("利用者を追加しました。", "ok");
    loadUsers(); loadAudit();
  });
  $("copy-token").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("secret-token").textContent); say("token をコピーしました。", "ok"); } catch (_) { say("コピーできませんでした。選択してコピーしてください。", "err"); }
  });
  $("reload-audit").addEventListener("click", loadAudit);
  $("forget").replaceWith(confirmable("自分のデータをすべて忘れる", "もう一度押すと完全に削除", async () => {
    const r = await engine.forget();
    let local = false;
    try { local = await Store.create(chrome.storage.local).forgetAll(); } catch (_) { /* 保存先が無い */ }
    r.ok ? say(`削除しました(エンジン: 修正 ${r.data.deleted.corrections} 件・共有 ${r.data.deleted.shares} 件${local ? "・このブラウザの調整" : ""})。`, "ok") : say(E.describeError(r), "err");
    loadAudit();
  }, { id: "forget", class: "danger" }));

  init();
})();
