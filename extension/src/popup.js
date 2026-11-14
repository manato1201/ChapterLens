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

  // 失敗の理由を、次にすることつきで言い直す
  function explain(raw) {
    const m = String(raw || "");
    if (/constraint/i.test(m)) return "このタブの音を受け取れませんでした(Chrome が取り込みの指定を拒みました)。動画のタブを開いたまま、もう一度押してください。それでも出るときは、拡張を再読み込みし、Chrome を最新にしてください。";
    if (/Extension has not been invoked|activeTab/i.test(m)) return "この動画のタブで、拡張のアイコンを押してから始めてください(別のタブから押すと、音を受け取れません)。";
    if (/Cannot capture a tab with an active stream|already/i.test(m)) return "このタブの音は、すでに取り込み中です。「停止」を押してから、もう一度始めてください。";
    if (/NotAllowed|Permission/i.test(m)) return "Chrome が音の取り込みを許可しませんでした。拡張のアイコンを、動画のタブで押し直してください。";
    return m || "始められませんでした。";
  }

  // 取り込みの前に、エンジンへつながるか・token が合うかを確かめる(つながらないのに「始めた」と言わない)。
  // 通信は background の中継を通す(拡張の通信は background と offscreen だけ。保存済みの URL・token が使われる)。
  async function preflight(serverUrl) {
    let r;
    try { r = await chrome.runtime.sendMessage({ target: "background", type: "engine", method: "GET", path: "/v1/me" }); } catch (_) { r = null; }
    if (r && r.ok) return null;
    if (r && (r.status === 401 || r.status === 403)) return "token が合っていません。エンジンの起動画面か、~/.chapterlens/token の中身を、もう一度貼ってください。";
    if (r && r.status) return "エンジンが「" + r.status + "」を返しました。エンジンのログを見てください。";
    return "エンジン(" + serverUrl + ")につながりません。エンジンを起動しているか(uv run python -m chapterlens serve)、URL とポートを確かめてください。";
  }

  function show(active) { $("go").hidden = active; $("stop").hidden = !active; for (const id of ["url", "token", "lang"]) $(id).disabled = active; }

  // 「設定」から開いたとき(?setup=1・別のタブ): 動画のタブではないので、始めるボタンは出さず、保存と接続の確認だけを行う
  const SETUP = new URLSearchParams(location.search).get("setup") === "1";

  async function saveSettings() {
    const serverUrl = C.validateServerUrl($("url").value.trim());
    const token = $("token").value.trim();
    if (!token) throw new Error("token を入力してください。");
    await chrome.storage.local.set({ [KEY]: { url: serverUrl, token, language: $("lang").value } });
    return serverUrl;
  }

  async function init() {
    if (SETUP) {
      $("go").hidden = true; $("stop").hidden = true; $("admin").hidden = true; $("save").hidden = false;
      $("steps").replaceChildren();
      for (const t of ["この PC でエンジンを起動する(uv run python -m chapterlens serve)", "下に URL と token を入れて、保存する(初回だけ)", "YouTube の動画のタブへ戻り、パネルの「音声から作る」を押す"]) { const li = document.createElement("li"); li.textContent = t; $("steps").append(li); }
    }
    try {
      const got = await chrome.storage.local.get(KEY);
      const v = got && got[KEY];
      if (v) { $("url").value = v.url || $("url").value; $("token").value = v.token || ""; $("lang").value = v.language || "auto"; }
    } catch (_) { /* 保存が無くても動く */ }
    const st = await offscreenStatus();
    show(st.active);
    if (st.active) say("取り込み中です。動画ページの「目次」パネルに、認識した結果が順に出ます。");
  }

  $("save").addEventListener("click", async () => {
    try {
      const serverUrl = await saveSettings();
      say("保存しました。エンジンを確かめています…");
      const problem = await preflight(serverUrl);
      if (problem) { say("保存はしましたが、つながりません。" + problem, true); return; }
      say("つながりました。このタブを閉じて、YouTube の動画のタブへ戻り、パネルの「音声から作る」を押してください。");
      setTimeout(async () => { try { const t = await chrome.tabs.getCurrent(); if (t) await chrome.tabs.remove(t.id); } catch (_) { /* 閉じられなくてもよい */ } }, 2500);
    } catch (e) { say(String((e && e.message) || e), true); }
  });

  $("go").addEventListener("click", async () => {
    try {
      const serverUrl = await saveSettings(); // 動画のタブでなくても、先に保存する(設定だけ済ませられる)
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let isWatch = false;
      try { const u = new URL((tab && tab.url) || ""); isWatch = u.hostname === "www.youtube.com" && u.pathname === "/watch"; } catch (_) { /* 読めない */ }
      if (!isWatch) { say("設定は保存しました。YouTube の動画ページ(/watch)のタブで、もう一度押してください(または、動画のページのパネルの「音声から作る」)。", true); return; }
      say("エンジンを確かめています…");
      const problem = await preflight(serverUrl);
      if (problem) { say(problem, true); return; }
      say("音の取り込みを始めています…");
      // 音は、動画ページの content script が <video> から取り出す(tabCapture は使わない)。ここでは、始める合図だけ送る。
      const res = await chrome.runtime.sendMessage({ target: "background", type: "start", relay: true, tabId: tab.id, serverUrl, token: $("token").value.trim(), language: $("lang").value });
      if (!res || !res.ok) { say(explain((res && res.error) || ""), true); return; }
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

  $("admin").addEventListener("click", () => { chrome.tabs.create({ url: chrome.runtime.getURL("src/admin.html") }); window.close(); });

  init();
})();
