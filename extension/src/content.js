/*
 * 全体の制御(content script)。YouTube の動画ページで、文字起こし → 検出 → 目次の表示・シーク・コピーをつなぐ。
 * 検出は拡張の中(core.js)で完結する。ネットワークには何も送らない。
 */
(function () {
  "use strict";
  if (window.__chapterlensLoaded) return;
  window.__chapterlensLoaded = true;

  const Core = window.ChapterLensCore;
  const Transcript = window.ChapterLensTranscript;
  const UI = window.ChapterLensUI;
  const Capture = window.ChapterLensCapture;

  const PREF_KEY = "chapterlens.granularity";
  const state = { videoId: null, cues: null, duration: 0, granularity: "standard", chapters: [], busy: false, ui: null, boundAt: null, capture: null };

  const isWatch = () => location.pathname === "/watch";
  const currentVideoId = () => new URL(location.href).searchParams.get("v");
  const videoEl = () => document.querySelector("video.html5-main-video") || document.querySelector("video");

  // ---- 設定(粒度)。storage が使えない環境でも動く ----
  async function loadPref() {
    try {
      const got = await chrome.storage.local.get(PREF_KEY);
      if (got && Core.GRANULARITY[got[PREF_KEY]]) state.granularity = got[PREF_KEY];
    } catch (_) { /* 既定のまま */ }
  }
  function savePref() {
    try { chrome.storage.local.set({ [PREF_KEY]: state.granularity }); } catch (_) { /* 保存できなくても動く */ }
  }

  // ---- プログレスバーの目印(失敗しても目次は使える) ----
  function clearMarkers() { document.querySelectorAll(".chapterlens-ticks").forEach((n) => n.remove()); }
  function drawMarkers() {
    clearMarkers();
    const bar = document.querySelector(".ytp-progress-bar");
    if (!bar || !state.duration || state.chapters.length < 2) return;
    const wrap = document.createElement("div");
    wrap.className = "chapterlens-ticks";
    wrap.style.cssText = "position:absolute;left:0;right:0;top:0;height:100%;pointer-events:none;z-index:40;";
    for (const c of state.chapters.slice(1)) {
      const tick = document.createElement("div");
      tick.style.cssText = `position:absolute;top:-2px;bottom:-2px;width:3px;margin-left:-1px;background:#ffd24a;left:${((c.start / state.duration) * 100).toFixed(3)}%;`;
      wrap.append(tick);
    }
    bar.append(wrap);
  }

  // ---- 検出と描画 ----
  function render() {
    const ui = state.ui;
    ui.setGranularity(state.granularity);
    ui.setChapters(state.chapters, Core.formatTimestamp);
    ui.setCanCopy(Core.descriptionText(state.chapters) !== null);
    updateCurrent();
    drawMarkers();
  }

  // 音声から作っている間は、聞き終えた所までが対象(まだ聞いていない後ろを、空の章にしない)
  function analysisDuration() {
    if (!state.capture || state.cues.length === 0) return state.duration;
    const covered = Math.max(...state.cues.map((c) => c.end));
    return state.duration > 0 && covered >= state.duration - 5 ? state.duration : covered;
  }

  function analyze() {
    if (!state.cues || state.cues.length === 0) return;
    const t0 = performance.now();
    const dur = analysisDuration();
    const heard = state.capture ? dur - Math.min(...state.cues.map((c) => c.start)) : dur; // 聞いた長さ(途中から取り込んだときも、動画上の位置ではなく聞いた分で数える)
    if (state.capture && heard < 90) { render(); state.ui.setStatus("音声を聞いています。もう少し再生すると、章に分けられます。"); return; }
    const target = Core.targetCountFor(state.granularity, heard); // 粒度は「聞いた長さ」に対して数える
    const det = Core.detectPartial(state.cues, dur, { targetCount: target === null ? undefined : target });
    state.chapters = Core.buildChapters(det.boundaries, state.cues, dur);
    const ms = Math.round(performance.now() - t0);
    render();
    const n = state.chapters.length;
    if (n <= 1) state.ui.setStatus("この長さでは章を分ける必要がなさそうです。粒度を「細かい」にすると分けられます。");
    else state.ui.setStatus(`${n} 章を作りました(字幕 ${state.cues.length} 行・${ms}ms)。位置は数秒ずれることがあります。`);
  }

  const ERRORS = {
    "no-button": "この動画には文字起こしがないようです。ツールバーの ChapterLens のアイコン →「音声から作る」で、音声から作れます(この PC のエンジンが要ります)。",
    timeout: "文字起こしを開けませんでした。ページを読み込み直して、もう一度お試しください。",
    empty: "文字起こしが空でした。",
  };

  async function run() {
    if (state.busy) return;
    if (state.capture) { state.ui.setStatus("いま音声から作っています。止めるには、ツールバーのアイコンから「停止」を押してください。"); return; }
    const ui = state.ui;
    state.busy = true;
    ui.setBusy(true);
    ui.setStatus("文字起こしを読み込み中…");
    try {
      const video = videoEl();
      const rows = await Transcript.loadTranscript(document);
      state.duration = (video && isFinite(video.duration) && video.duration > 0) ? video.duration : rows[rows.length - 1].start + 5;
      state.cues = Core.cuesFromRows(rows, state.duration);
      state.videoId = currentVideoId();
      analyze();
      ui.setRunLabel("作り直す");
    } catch (e) {
      ui.setStatus(ERRORS[e && e.code] || "目次を作れませんでした。", "error");
    } finally {
      state.busy = false;
      ui.setBusy(false);
    }
  }

  function setGranularity(key) {
    if (!Core.GRANULARITY[key]) return;
    state.granularity = key;
    savePref();
    state.ui.setGranularity(key);
    if (state.cues && !state.busy) analyze(); // 字幕は読み込み済み。すぐ作り直せる
  }

  function seek(sec) {
    const video = videoEl();
    if (video) video.currentTime = sec;
  }

  async function copy() {
    const text = Core.descriptionText(state.chapters);
    if (!text) { state.ui.setStatus("概要欄に使える形(3 章以上・各 10 秒以上)になっていません。", "error"); return; }
    try {
      // ページにフォーカスが無いと、writeText は解決も拒否もしないまま止まることがある。待ちすぎずに次の方法へ
      await Promise.race([navigator.clipboard.writeText(text), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500))]);
      state.ui.setStatus("概要欄用のテキストをコピーしました。");
    } catch (_) {
      // クリップボードが使えない環境: 選択してコピーする
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.cssText = "position:fixed;left:-9999px;";
      document.body.append(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (_) { /* 失敗 */ }
      ta.remove();
      state.ui.setStatus(ok ? "概要欄用のテキストをコピーしました。" : "コピーできませんでした。", ok ? undefined : "error");
    }
  }

  // ---- 再生位置に合わせて、いまの章を強調 ----
  function updateCurrent() {
    const video = videoEl();
    if (!video || state.chapters.length === 0) return;
    state.ui.setCurrent(Core.chapterIndexAt(state.chapters, video.currentTime));
  }
  function bindVideo() {
    const video = videoEl();
    if (!video || state.boundAt === video) return;
    state.boundAt = video;
    video.addEventListener("timeupdate", updateCurrent);
  }

  // ---- 音声から作る(CH2b)。取り込みは offscreen が行い、結果(チャンク内の相対時刻の字幕)がここへ届く ----
  const fmt = (sec) => Core.formatTimestamp(Math.max(0, Math.floor(sec)));

  function startCapture() {
    const video = videoEl();
    const map = new Capture.TimeMap();
    const sample = (jump) => { const v = videoEl(); if (v) map.add(Date.now(), v.currentTime, { jump: !!jump }); };
    const cap = { map, timer: null, listeners: [], video, language: null };
    const on = (type, fn) => { if (video) { video.addEventListener(type, fn); cap.listeners.push([type, fn]); } };
    on("timeupdate", () => sample(false));
    for (const t of ["play", "playing", "pause", "ratechange"]) on(t, () => sample(false));
    on("seeking", () => sample(true));
    cap.timer = setInterval(() => sample(false), 1000);
    sample(false);
    state.capture = cap;
    state.cues = [];
    state.chapters = [];
    state.duration = video && isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    state.videoId = currentVideoId();
    clearMarkers();
    state.ui.setChapters([], Core.formatTimestamp);
    state.ui.setCanCopy(false);
    state.ui.open();
    state.ui.setStatus(`音声の取り込みを始めました(${video ? fmt(video.currentTime) : "0:00"} から)。再生すると、30 秒ごとに結果が増えます。`);
  }

  function stopCapture(notify) {
    const cap = state.capture;
    if (!cap) return;
    clearInterval(cap.timer);
    for (const [type, fn] of cap.listeners) cap.video.removeEventListener(type, fn);
    state.capture = null;
    if (notify) { try { chrome.runtime.sendMessage({ target: "background", type: "stop" }); } catch (_) { /* 送れなくても続ける */ } }
  }

  function addCues(newCues) {
    if (newCues.length === 0) return;
    const lo = Math.min(...newCues.map((c) => c.start)), hi = Math.max(...newCues.map((c) => c.end));
    // 同じ範囲を聞き直したとき(シークして戻ったなど)は、新しい方で置き換える
    state.cues = state.cues.filter((c) => c.end <= lo || c.start >= hi).concat(newCues).sort((a, b) => a.start - b.start);
  }

  const CAPTURE_ERRORS_STOP = new Set(["auth", "origin"]);
  function onTabMessage(msg) {
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("cl-")) return;
    if (msg.type === "cl-started") { if (isWatch()) startCapture(); return; }
    const cap = state.capture;
    if (!cap) return;
    if (msg.type === "cl-cues") {
      const shifted = Capture.shiftCues(msg.cues || [], msg.chunkWallMs, cap.map);
      addCues(shifted);
      cap.language = (msg.info && msg.info.language) || cap.language;
      if (state.cues.length > 0) {
        analyze();
        const covered = Math.max(...state.cues.map((c) => c.end));
        if (state.chapters.length > 1) state.ui.setStatus(`${state.chapters.length} 章(${fmt(covered)} まで・字幕 ${state.cues.length} 行・言語 ${cap.language || "?"})。再生を続けると増えます。位置は数秒ずれることがあります。`);
      }
    } else if (msg.type === "cl-status") {
      if (state.cues.length === 0 && msg.info) state.ui.setStatus(`音声を聞いています…(処理済み ${fmt(msg.info.coveredS || 0)})。無音の間は飛ばします。`);
    } else if (msg.type === "cl-error") {
      state.ui.setStatus(msg.message || "音声の取り込みでエラーが起きました。", "error");
      if (CAPTURE_ERRORS_STOP.has(msg.code)) stopCapture(true);
    } else if (msg.type === "cl-ended") {
      stopCapture(false);
      if (state.cues.length > 0) { analyze(); state.ui.setRunLabel("目次を作る"); }
      state.ui.setStatus(state.chapters.length > 1 ? `取り込みを止めました。${state.chapters.length} 章を作りました。` : "取り込みを止めました。");
    }
  }

  // ---- 動画が変わったら、前の動画の結果を捨てる ----
  function reset() {
    if (state.capture) stopCapture(true);
    state.cues = null; state.chapters = []; state.duration = 0; state.videoId = currentVideoId();
    clearMarkers();
    if (!state.ui) return;
    state.ui.setChapters([], Core.formatTimestamp);
    state.ui.setCanCopy(false);
    state.ui.setRunLabel("目次を作る");
    state.ui.setStatus("この動画の文字起こしから、話題の切り替えを探します。");
  }

  function onNavigate() {
    if (!isWatch()) { if (state.ui) state.ui.unmount(); clearMarkers(); return; }
    if (state.ui) state.ui.mount();
    if (currentVideoId() !== state.videoId) reset();
    bindVideo();
  }

  async function init() {
    await loadPref();
    const granularities = Object.entries(Core.GRANULARITY).map(([key, g]) => ({ key, label: g.label }));
    state.ui = UI.createPanel(document, granularities, { onRun: run, onGranularity: setGranularity, onSeek: seek, onCopy: copy });
    state.ui.setGranularity(state.granularity);
    reset();
    document.addEventListener("yt-navigate-finish", onNavigate);
    try { chrome.runtime.onMessage.addListener(onTabMessage); } catch (_) { /* 拡張の外では使わない */ }
    if (isWatch()) { state.ui.mount(); bindVideo(); }
  }

  init();
})();
