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

  const PREF_KEY = "chapterlens.granularity";
  const state = { videoId: null, cues: null, duration: 0, granularity: "standard", chapters: [], busy: false, ui: null, boundAt: null };

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

  function analyze() {
    const t0 = performance.now();
    const target = Core.targetCountFor(state.granularity, state.duration);
    const det = Core.detect(state.cues, state.duration, { targetCount: target === null ? undefined : target });
    state.chapters = Core.buildChapters(det.boundaries, state.cues, state.duration);
    const ms = Math.round(performance.now() - t0);
    render();
    const n = state.chapters.length;
    if (n <= 1) state.ui.setStatus("この長さでは章を分ける必要がなさそうです。粒度を「細かい」にすると分けられます。");
    else state.ui.setStatus(`${n} 章を作りました(字幕 ${state.cues.length} 行・${ms}ms)。位置は数秒ずれることがあります。`);
  }

  const ERRORS = {
    "no-button": "この動画には文字起こしがないようです(字幕のない動画には、まだ対応していません)。",
    timeout: "文字起こしを開けませんでした。ページを読み込み直して、もう一度お試しください。",
    empty: "文字起こしが空でした。",
  };

  async function run() {
    if (state.busy) return;
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

  // ---- 動画が変わったら、前の動画の結果を捨てる ----
  function reset() {
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
    if (isWatch()) { state.ui.mount(); bindVideo(); }
  }

  init();
})();
