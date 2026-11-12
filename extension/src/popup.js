/* popup: 取り込みの開始・停止と、エンジンの接続設定(URL・token)。tabCapture は、この操作(アイコンのクリック)が要る。 */
(function () {
  "use strict";
  const C = self.ChapterLensCapture;
  const $ = (id) => document.getElementById(id);
  const KEY = "chapterlens.engine";
  const say = (t, err) => { $("msg").textContent = t; $("msg").className = err ? "err" : ""; };

  async function offscreenStatus() {
    try {
      const r = await Promise.race([chrome.runtime.sendMessage({ target: "offscreen", type: "status" }), new Promise((res) => setTimeout(() => res(null), 600))]);
      return r && r.active ? r : { active: false };
    } catch (_) { return { active: false }; }
  }

  function show(active) { $("go").hidden = active; $("stop").hidden = !active; for (const id of ["url", "token", "lang"]) $(id).disabled = active; }

  async function init() {
    try {
      const got = await chrome.storage.local.get(KEY);
      const v = got && got[KEY];
      if (v) { $("url").value = v.url || $("url").value; $("token").value = v.token || ""; $("lang").value = v.language || "auto"; }
    } catch (_) { /* 保存が無くても動く */ }
    const st = await offscreenStatus();
    show(st.active);
    if (st.active) say("取り込み中です。動画ページの「目次」パネルに、認識した結果が順に出ます。");
  }

  $("go").addEventListener("click", async () => {
    try {
      const serverUrl = C.validateServerUrl($("url").value.trim());
      const token = $("token").value.trim();
      if (!token) { say("token を入力してください。", true); return; }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let isWatch = false;
      try { const u = new URL((tab && tab.url) || ""); isWatch = u.hostname === "www.youtube.com" && u.pathname === "/watch"; } catch (_) { /* 読めない */ }
      if (!isWatch) { say("YouTube の動画ページ(/watch)を開いてから押してください。", true); return; }
      try { await chrome.storage.local.set({ [KEY]: { url: serverUrl, token, language: $("lang").value } }); } catch (_) { /* 保存できなくても続ける */ }
      say("接続しています…");
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const res = await chrome.runtime.sendMessage({ target: "background", type: "start", streamId, tabId: tab.id, serverUrl, token, language: $("lang").value });
      if (!res || !res.ok) { say((res && res.error) || "始められませんでした。", true); return; }
      show(true);
      say("取り込みを始めました。動画を再生すると、30 秒ごとに結果が「目次」パネルへ出ます(再生の速さでしか進みません)。");
    } catch (e) { say(String((e && e.message) || e), true); }
  });

  $("stop").addEventListener("click", async () => {
    say("止めています…");
    try { await chrome.runtime.sendMessage({ target: "background", type: "stop" }); } catch (_) { /* 既に止まっている */ }
    show(false);
    say("停止しました。");
  });

  init();
})();
