/*
 * service worker: offscreen document の作成と、offscreen → 元のタブ(content script)への中継だけ。
 * 取り込みの開始は、利用者が拡張のアイコンを押したときの popup から(tabCapture はその操作が要る)。
 */
"use strict";
const OFFSCREEN_URL = "src/offscreen.html";

async function hasOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return ctxs.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "再生中のタブの音を、この PC のエンジンで文字起こしするために受け取ります",
  });
}

async function startCapture(msg) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: "offscreen", type: "start",
    streamId: msg.streamId, tabId: msg.tabId, serverUrl: msg.serverUrl, token: msg.token, language: msg.language,
  });
  if (!res || !res.ok) {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
    throw new Error((res && res.error) || "取り込みを始められませんでした");
  }
  chrome.tabs.sendMessage(msg.tabId, { type: "cl-started", wallMs: Date.now() }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "background") return;
  if (msg.type === "start") {
    startCapture(msg).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === "relay") { chrome.tabs.sendMessage(msg.tabId, msg.payload).catch(() => {}); return; }
  if (msg.type === "stop") {
    hasOffscreen().then((has) => (has ? chrome.runtime.sendMessage({ target: "offscreen", type: "stop" }) : null))
      .then(() => sendResponse({ ok: true }), () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "ended") { chrome.offscreen.closeDocument().catch(() => {}); return; }
});
