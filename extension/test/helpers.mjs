/*
 * テスト用の読み込み処理: background.js / content.js を、偽の chrome・偽の DOM の上で動かす(Chrome の本物の API は使えないので、
 * メッセージのやりとり・保存・時刻の変換・結果の積み上げ・エラー処理までを確かめる)。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
export const src = (f) => readFileSync(join(here, "..", "src", f), "utf-8");
export const tick = () => new Promise((r) => setImmediate(r));
/** vm の中で作られたオブジェクトは、別の realm なので deepEqual できない。JSON で複製して比べる(chrome のメッセージも同じく複製される)。 */
export const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
export const flush = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

export const Core = require("../src/core.js");
export const Cap = require("../src/capture.js");
export const Tr = require("../src/transcript.js");
export const StoreMod = require("../src/store.js");
export const EngineMod = require("../src/engine.js");

/** chrome.storage.local と同じ形のメモリ上の保存先。 */
export function memoryArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (keys) => {
      const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(data);
      return Object.fromEntries(ks.filter((k) => k in data).map((k) => [k, JSON.parse(JSON.stringify(data[k]))]));
    },
    set: async (o) => { for (const [k, v] of Object.entries(o)) data[k] = JSON.parse(JSON.stringify(v)); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
  };
}

// ================= background.js =================
export function loadBackground({ offscreenReply, storage = {}, fetchImpl, extensionId = "ext-id" } = {}) {
  const st = { offscreen: false, created: [], closed: 0, sent: [], tabMsgs: [], listener: null, fetches: [] };
  const area = memoryArea(storage);
  const chrome = {
    runtime: {
      id: extensionId,
      getContexts: async () => (st.offscreen ? [{}] : []),
      onMessage: { addListener: (fn) => { st.listener = fn; } },
      sendMessage: async (m) => { st.sent.push(m); if (m.target === "offscreen") return offscreenReply ? offscreenReply(m) : { ok: true }; },
    },
    offscreen: {
      createDocument: async (o) => { st.offscreen = true; st.created.push(o); },
      closeDocument: async () => { st.offscreen = false; st.closed++; },
    },
    tabs: { sendMessage: async (id, m) => { st.tabMsgs.push([id, m]); } },
    storage: { local: area },
  };
  const selfObj = { ChapterLensCapture: Cap };
  const fetch = async (url, opts) => { st.fetches.push({ url, opts }); return fetchImpl ? fetchImpl(url, opts) : { ok: true, status: 200, json: async () => ({}), headers: { get: () => null } }; };
  vm.runInNewContext(src("background.js"), { chrome, console, self: selfObj, importScripts: () => {}, fetch, AbortController, setTimeout, clearTimeout });
  return {
    st, area,
    send: (msg, sender = { id: extensionId }) => new Promise((resolve) => { const r = st.listener(msg, sender, (v) => resolve(clone(v))); if (r !== true) resolve(undefined); }),
  };
}

// ================= content.js =================
/**
 * engine: (method, path, body) => 応答({ok, status, data, ...})。background の中継の代わり。
 * 返り値: page.ui … 偽の UI(呼ばれた内容を記録)/ page.handlers … content.js が UI に渡した操作 / page.engineCalls …エンジン呼び出しの記録
 */
export function loadContent({ pathname = "/watch", videoId = "vid1", duration = 600, granularity = "fine", storage = {}, engine, live = false, rows = null } = {}) {
  const clock = { t: 1_000_000 };
  const video = Object.assign(new EventTarget(), { currentTime: 0, duration: live ? Infinity : duration, paused: false });
  const ui = { calls: [], status: [], chapters: [], chapterOpts: [], digest: [], share: [], open: 0, tab: [], manual: [] };
  const captured = { handlers: null };
  const rec = (name) => (...a) => ui.calls.push([name, ...a]);
  const panel = {
    mount: rec("mount"), unmount: rec("unmount"), open: () => { ui.open++; }, close: rec("close"),
    setStatus: (t, kind) => ui.status.push({ t, kind }), setBusy: rec("busy"), setRunLabel: rec("runLabel"),
    setGranularity: rec("gran"), setCanCopy: rec("canCopy"), setCurrent: rec("current"),
    setChapters: (c, _f, o) => { ui.chapters.push(clone(c)); ui.chapterOpts.push(clone(o || {})); },
    setManual: (m) => ui.manual.push(m), setTab: (n) => ui.tab.push(n),
    setDigest: (v) => ui.digest.push(clone(v)), setShare: (v) => ui.share.push(clone(v)),
  };
  const fakeUI = { createPanel: (_doc, _grans, handlers) => { captured.handlers = handlers; return panel; } };
  const ticks = [];
  const docListeners = {};
  const document = {
    querySelector: (sel) => (sel.includes("video") ? video : sel === ".ytp-live" && live ? {} : null),
    querySelectorAll: () => [],
    addEventListener: (t, fn) => { docListeners[t] = fn; },
    documentElement: { hasAttribute: () => false }, body: {}, createElement: () => ({ append() {}, style: {}, remove() {} }),
  };
  const loc = { pathname, href: `https://www.youtube.com/watch?v=${videoId}` };
  const sent = [];
  const engineCalls = [];
  let msgListener = null;
  const area = memoryArea({ "chapterlens.granularity": granularity, ...storage });
  const chrome = {
    storage: { local: area },
    runtime: {
      onMessage: { addListener: (fn) => { msgListener = fn; } },
      sendMessage: (m) => {
        if (m && m.target === "background" && m.type === "engine") {
          engineCalls.push({ method: m.method, path: m.path, body: clone(m.body) });
          return Promise.resolve(engine ? engine(m.method, m.path, clone(m.body)) : { ok: false, code: "unconfigured" });
        }
        sent.push(clone(m));
        return Promise.resolve();
      },
    },
  };
  const win = { ChapterLensCore: Core, ChapterLensCapture: Cap, ChapterLensTranscript: rows ? { loadTranscript: async () => rows } : Tr, ChapterLensUI: fakeUI, ChapterLensStore: StoreMod, ChapterLensEngine: EngineMod };
  const ctx = {
    window: win, document, location: loc, chrome, URL, performance, console, EventTarget,
    Date: { now: () => clock.t }, setInterval: () => 1, clearInterval: () => {}, setTimeout, Promise, navigator: {},
    Math, Number, Set, Array, Object, isFinite, String, JSON, Map,
  };
  vm.runInNewContext(src("content.js"), ctx);
  return {
    clock, video, ui, sent, loc, area, engineCalls, ticks,
    get handlers() { return captured.handlers; },
    msg: (m) => msgListener(m),
    navigate: (id) => { loc.href = `https://www.youtube.com/watch?v=${id}`; docListeners["yt-navigate-finish"](); },
    play: (sec) => { // 1 秒ずつ進めて timeupdate を出す(1 倍速)
      for (let i = 0; i < sec; i++) { clock.t += 1000; video.currentTime += 1; video.dispatchEvent(new Event("timeupdate")); }
    },
    ready: () => tick(),
  };
}

// 前半(0〜120 秒)と後半(120〜240 秒)で語彙の違う、6 秒ごとの字幕
export const TOPIC_A = ["ギター", "弦", "コード", "演奏", "音色", "ピック", "指板", "リズム"];
export const TOPIC_B = ["料理", "野菜", "包丁", "出汁", "味噌", "鍋", "火加減", "調味料"];
export function chunkCues(fromS, toS) {
  const out = [];
  for (let t = fromS; t < toS; t += 6) {
    const words = t < 120 ? TOPIC_A : TOPIC_B;
    out.push({ start: t - fromS, end: t - fromS + 6, text: Array.from({ length: 5 }, (_, i) => words[(t / 6 + i * 3) % words.length]).join("") + "について話します" });
  }
  return out;
}

/** 文字起こし(字幕)から作る流れ: Transcript を差し替えて、行を返す。3 つの話題 × 各 200 秒(合計 600 秒)。 */
export function threeTopicRows() {
  const T = [
    ["ギター", "弦", "コード", "演奏", "音色", "ピック", "指板", "リズム"],
    ["料理", "野菜", "包丁", "出汁", "味噌", "鍋", "火加減", "調味料"],
    ["天気", "気温", "湿度", "台風", "降水", "前線", "高気圧", "予報"],
  ];
  const rows = [];
  for (let t = 0; t < 600; t += 6) {
    const w = T[Math.floor(t / 200)];
    rows.push({ start: t, text: Array.from({ length: 5 }, (_, i) => w[(t / 6 + i * 3) % w.length]).join("") + "について話します" });
  }
  return rows;
}
