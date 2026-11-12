/*
 * service worker:
 *   ① offscreen document の作成と、offscreen → 元のタブ(content script)への中継(音声の取り込み。CH2b)
 *   ② ローカルエンジンの API 呼び出しの中継(共有・ライブ・管理。CH3b・CH5)。content script と管理ページは、ここを通して呼ぶ
 * 取り込みの開始は、利用者が拡張のアイコンを押したときの popup から(tabCapture はその操作が要る)。
 *
 * ②の守り: 送り先は 127.0.0.1 だけ(validateServerUrl)・経路は許可リストの 13 種だけ(音声の /v1/transcribe は offscreen だけ)・
 * 呼べるのはこの拡張自身(sender.id)だけ・リダイレクトは辿らない・token は保存済みの設定から読む(メッセージでは受け取らない)。
 */
"use strict";
importScripts("capture.js"); // 自分のファイルだけ。validateServerUrl を使う(self.ChapterLensCapture)

const OFFSCREEN_URL = "src/offscreen.html";
const ENGINE_KEY = "chapterlens.engine";
const ENGINE_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const ENGINE_ROUTES = [
  ["GET", /^\/v1\/me$/],
  ["POST", /^\/v1\/me\/forget$/],
  ["GET", /^\/v1\/shares(\?video=[A-Za-z0-9_-]{1,64})?$/],
  ["POST", /^\/v1\/shares$/],
  ["POST", /^\/v1\/shares\/revoke$/],
  ["POST", /^\/v1\/live$/],
  ["POST", /^\/v1\/live\/close$/],
  ["GET", /^\/v1\/admin\/users$/],
  ["POST", /^\/v1\/admin\/users$/],
  ["POST", /^\/v1\/admin\/users\/(local|u_[0-9a-f]{8})\/(disable|enable|rotate|purge|role)$/],
  ["GET", /^\/v1\/admin\/settings$/],
  ["POST", /^\/v1\/admin\/settings$/],
  ["GET", /^\/v1\/admin\/audit(\?n=\d{1,3})?$/],
];

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

// ---- ②エンジンの API 中継 ----
async function engineCall(msg, sender) {
  if (!sender || sender.id !== chrome.runtime.id) return { ok: false, code: "forbidden", error: "この拡張の外からは呼べません" };
  const method = String(msg.method || "");
  const path = String(msg.path || "");
  if (!ENGINE_ROUTES.some(([m, re]) => m === method && re.test(path))) return { ok: false, code: "forbidden", error: "許可していない経路です" };

  let cfg;
  try { cfg = (await chrome.storage.local.get(ENGINE_KEY))[ENGINE_KEY]; } catch (_) { cfg = null; }
  if (!cfg || !cfg.url || !cfg.token) return { ok: false, code: "unconfigured" };
  let base;
  try { base = self.ChapterLensCapture.validateServerUrl(cfg.url); } catch (e) { return { ok: false, code: "bad-url", error: e.message }; }

  let body;
  if (method === "POST") {
    body = JSON.stringify(msg.body === undefined ? {} : msg.body);
    if (body.length > MAX_BODY_BYTES) return { ok: false, code: "too-large", error: "送る内容が大きすぎます" };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ENGINE_TIMEOUT_MS);
  try {
    const res = await fetch(base + path, {
      method,
      headers: Object.assign({ Authorization: "Bearer " + cfg.token }, body === undefined ? {} : { "Content-Type": "application/json" }),
      body,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: ctl.signal,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* 本文なし・JSON でない */ }
    if (res.ok) return { ok: true, status: res.status, data };
    return { ok: false, status: res.status, error: (data && data.error) || "", retryAfter: res.headers && res.headers.get ? res.headers.get("Retry-After") : null };
  } catch (e) {
    return { ok: false, code: e && e.name === "AbortError" ? "timeout" : "unreachable", error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "background") return;
  if (msg.type === "engine") {
    engineCall(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, code: "internal", error: String((e && e.message) || e) }));
    return true;
  }
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
