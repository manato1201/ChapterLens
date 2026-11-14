/*
 * 全体の制御(content script)。YouTube の動画ページで、文字起こし → 検出 → 目次の表示・シーク・コピーをつなぐ。
 * 検出は拡張の中(core.js)で完結する。字幕から作る限り、ネットワークには何も送らない。
 * エンジンを呼ぶのは「利用者が操作したとき」だけ(音声から作る・ライブ・共有)で、通信は background.js を通す(127.0.0.1 だけ)。
 *
 * 状態の持ち方(1 本の動画につき):
 *   cues      字幕(文字起こし or 音声の認識結果)
 *   auto      検出した境界(粒度で変わる)
 *   manual    利用者が直した境界(あれば、こちらを使う。この PC のブラウザに保存)
 *   chapters  いま表示している章 = effective() から作る
 */
(function () {
  "use strict";
  if (window.__chapterlensLoaded) return;
  window.__chapterlensLoaded = true;

  const Core = window.ChapterLensCore;
  const Transcript = window.ChapterLensTranscript;
  const UI = window.ChapterLensUI;
  const Capture = window.ChapterLensCapture;
  const Store = window.ChapterLensStore;
  const Engine = window.ChapterLensEngine;

  const PREF_KEY = "chapterlens.granularity";
  const DIGEST_MIN_S = 60; // ダイジェストを作れる最小の長さ
  const DIGEST_RATIO = 0.2; // ダイジェストの長さの既定の割合
  const NEW_SPAN_S = 15; // 「いまの位置から足す」区間の長さ
  const state = {
    videoId: null, cues: null, duration: 0, granularity: "standard", busy: false, ui: null, boundAt: null, capture: null,
    auto: [], manual: null, chapters: [], tentative: [],
    digest: { ratio: 0.2, auto: [], custom: null, enabled: false, onTime: null },
    share: { info: null, list: [], overlay: new Set(), mineOff: false },
    live: null,
    titles: [], // 利用者が付けた題名 [{start, title}]
    query: "",
  };

  const area = (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) || null;
  const store = Store.create(area || { get: async () => ({}), set: async () => { throw new Error("no storage"); }, remove: async () => {} });
  const engine = Engine.createClient((m) => (typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.sendMessage(m) : Promise.reject(new Error("拡張の外では使えません"))));

  const isWatch = () => location.pathname === "/watch";
  const currentVideoId = () => new URL(location.href).searchParams.get("v");
  const videoEl = () => document.querySelector("video.html5-main-video") || document.querySelector("video");
  const isLiveVideo = () => { const v = videoEl(); return !!(v && !Number.isFinite(v.duration)) || !!document.querySelector(".ytp-live"); };
  const fmt = (sec) => Core.formatTimestamp(Math.max(0, Math.floor(sec)));
  const effective = () => state.manual || state.auto;
  const canEdit = () => !state.capture && !state.live && !!state.cues && state.cues.length > 0 && state.duration > 0;
  const say = (text, kind) => state.ui.setStatus(text, kind);
  // Math.max(...配列) は、長い配列(数万)で引数の上限に当たるので、reduce で
  const maxEnd = (cues) => cues.reduce((m, c) => (c.end > m ? c.end : m), 0);
  const minStart = (cues) => cues.reduce((m, c) => (c.start < m ? c.start : m), Infinity);

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
  function tick(percent, color, title) {
    const t = document.createElement("div");
    t.style.cssText = `position:absolute;top:-2px;bottom:-2px;width:3px;margin-left:-1px;left:${percent.toFixed(3)}%;background:${color};`;
    if (title) t.title = title;
    return t;
  }
  function drawMarkers() {
    clearMarkers();
    const bar = document.querySelector(".ytp-progress-bar");
    if (!bar || !state.duration) return;
    const wrap = document.createElement("div");
    wrap.className = "chapterlens-ticks";
    wrap.style.cssText = "position:absolute;left:0;right:0;top:0;height:100%;pointer-events:none;z-index:40;";
    state.chapters.slice(1).forEach((c) => wrap.append(tick((c.start / state.duration) * 100, "#ffd24a")));
    for (const i of state.share.overlay) { // 他の人の章立て(共有)。紫。
      const s = state.share.list[i];
      if (s) s.boundaries.forEach((b) => wrap.append(tick((b / state.duration) * 100, "#b46bff", s.from)));
    }
    if (wrap.childNodes && wrap.childNodes.length === 0) return;
    bar.append(wrap);
  }

  // ---- 描画 ----
  function render() {
    const ui = state.ui;
    ui.setGranularity(state.granularity);
    ui.setChapters(state.chapters, Core.formatTimestamp, { editable: canEdit(), tentative: state.tentative });
    ui.setManual(!!state.manual);
    ui.setCanCopy(Core.descriptionText(state.chapters) !== null);
    updateCurrent();
    drawMarkers();
    renderDigest();
    ui.setAudioState({ capturing: !!state.capture });
    if (state.query) onSearch(state.query);
    saveAutoCache();
  }

  // 音声から作っている間は、聞き終えた所までが対象(まだ聞いていない後ろを、空の章にしない)
  function analysisDuration() {
    if (!state.capture || state.cues.length === 0) return state.duration;
    const covered = maxEnd(state.cues);
    return state.duration > 0 && covered >= state.duration - 5 ? state.duration : covered;
  }

  function rebuild() {
    state.chapters = Core.applyTitleOverrides(Core.buildChapters(effective(), state.cues, analysisDuration()), state.titles);
    state.tentative = [];
    recomputeDigest();
    render();
  }

  function analyze() {
    if (!state.cues || state.cues.length === 0) return;
    const t0 = performance.now();
    const dur = analysisDuration();
    const heard = state.capture ? dur - minStart(state.cues) : dur; // 聞いた長さ(途中から取り込んだときも、動画上の位置ではなく聞いた分で数える)
    if (state.capture && heard < 90) { render(); say("音声を聞いています。もう少し再生すると、章に分けられます。"); return; }
    const target = Core.targetCountFor(state.granularity, heard); // 粒度は「聞いた長さ」に対して数える
    state.auto = Core.detectPartial(state.cues, dur, { targetCount: target === null ? undefined : target }).boundaries;
    rebuild();
    const ms = Math.round(performance.now() - t0);
    const n = state.chapters.length;
    if (state.manual) say(`${n} 章(あなたが直した章立て)。「自動に戻す」で、自動の章立てに戻せます。`);
    else if (n <= 1) say("この長さでは章を分ける必要がなさそうです。粒度を「細かい」にすると分けられます。");
    else say(`${n} 章を作りました(字幕 ${state.cues.length} 行・${ms}ms)。位置は数秒ずれることがあります。`);
  }

  const ERRORS = {
    "no-button": "この動画には文字起こしがないようです。下の「音声から作る」ボタンで、音声から作れます(この PC のエンジンが要ります)。",
    timeout: "文字起こしを開けませんでした。ページを読み込み直して、もう一度お試しください。",
    empty: "文字起こしが空でした。",
  };

  async function run() {
    if (state.busy) return;
    if (state.capture) { say("いま音声から作っています。止めるには、「取り込みを止める」を押してください。"); return; }
    const ui = state.ui;
    state.busy = true;
    ui.setBusy(true);
    say("文字起こしを読み込み中…");
    try {
      const video = videoEl();
      const rows = await Transcript.loadTranscript(document);
      state.duration = (video && isFinite(video.duration) && video.duration > 0) ? video.duration : rows[rows.length - 1].start + 5;
      state.cues = Core.cuesFromRows(rows, state.duration);
      state.videoId = currentVideoId();
      await restoreSaved();
      analyze();
      ui.setRunLabel("作り直す");
    } catch (e) {
      say(ERRORS[e && e.code] || "目次を作れませんでした。", "error");
    } finally {
      state.busy = false;
      ui.setBusy(false);
    }
  }

  function setGranularity(key) {
    if (!Core.GRANULARITY[key]) return;
    if (state.manual) { say("直した章があります。粒度を変えるには、先に「自動に戻す」を押してください。"); return; }
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
    if (!text) { say("概要欄に使える形(3 章以上・各 10 秒以上)になっていません。", "error"); return; }
    try {
      // ページにフォーカスが無いと、writeText は解決も拒否もしないまま止まることがある。待ちすぎずに次の方法へ
      await Promise.race([navigator.clipboard.writeText(text), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500))]);
      say("概要欄用のテキストをコピーしました。");
    } catch (_) {
      // クリップボードが使えない環境: 選択してコピーする
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.cssText = "position:fixed;left:-9999px;";
      document.body.append(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (_) { /* 失敗 */ }
      ta.remove();
      say(ok ? "概要欄用のテキストをコピーしました。" : "コピーできませんでした。", ok ? undefined : "error");
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

  // ================= 章の調整(CH3b) =================
  async function restoreSaved() {
    const id = state.videoId;
    const saved = await store.load(id);
    if (state.videoId !== id) return; // 読み込み中に別の動画へ移った
    state.manual = saved.manual ? saved.manual.boundaries : null;
    state.titles = saved.titles || [];
    if (saved.digest) { state.digest.custom = saved.digest.spans; state.digest.ratio = saved.digest.ratio || state.digest.ratio; }
  }

  function applyEdit(next, okMessage) {
    if (!canEdit()) { say(state.capture || state.live ? "音声の取り込み中・ライブ中は、章を直せません。" : "先に「目次を作る」を押してください。", "error"); return; }
    if (!next) { say("その直し方はできません(他の境界・動画の先頭と末尾から 5 秒以上あけてください)。", "error"); return; }
    const clean = Core.normalizeBoundaries(next, state.duration);
    state.manual = clean;
    store.saveManual(state.videoId, clean, state.auto);
    rebuild();
    say(okMessage);
  }
  const chapterRemove = (i) => applyEdit(Core.removeBoundary(effective(), i - 1), "境界を消しました。");
  const chapterNudge = (i, d) => applyEdit(Core.moveBoundary(effective(), i - 1, d, state.duration), `境界を ${d > 0 ? "遅く" : "早く"}しました(${Math.abs(d)} 秒)。`);
  function chapterAdd() {
    const video = videoEl();
    applyEdit(video ? Core.addBoundary(effective(), video.currentTime, state.duration) : null, `${video ? fmt(video.currentTime) : ""} に章を足しました。`);
  }
  function manualReset() {
    state.manual = null;
    store.clearManual(state.videoId);
    if (state.cues) analyze();
  }

  // ================= ダイジェスト(CH4) =================
  const overlapsHalf = (a, b) => Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0.5 * Math.min(a.end - a.start, b.end - b.start);

  /** 表示する区間 = 利用者が決めた(なければ自動の)区間(on)+ 自動案のうち外されたもの(off)。 */
  function digestItems() {
    const d = state.digest;
    if (!d.custom) return d.auto.map((s) => ({ start: s.start, end: s.end, on: true }));
    const items = d.custom.map((s) => ({ start: s.start, end: s.end, on: true }));
    for (const a of d.auto) if (!d.custom.some((c) => overlapsHalf(a, c))) items.push({ start: a.start, end: a.end, on: false });
    return items.sort((a, b) => a.start - b.start);
  }
  const finalSpans = () => (state.digest.custom || state.digest.auto);

  function mergeSpans(spans) {
    const out = [];
    for (const s of spans.slice().sort((a, b) => a.start - b.start)) {
      if (out.length && s.start <= out[out.length - 1].end) out[out.length - 1].end = Math.max(out[out.length - 1].end, s.end);
      else out.push({ start: s.start, end: s.end });
    }
    return out;
  }

  function recomputeDigest() {
    const d = state.digest;
    d.auto = [];
    if (!state.cues || state.cues.length === 0 || state.capture || state.live || state.duration < DIGEST_MIN_S) return;
    d.auto = Core.selectDigest(state.cues, effective(), state.duration, { ratio: d.ratio }).map((s) => ({ start: s.start, end: s.end, score: s.score }));
  }

  function digestReason() {
    if (state.live) return "ライブでは使えません。";
    if (state.capture) return "音声の取り込み中は使えません。止めてから、もう一度開いてください。";
    if (!state.cues || state.cues.length === 0) return "先に「目次」タブで目次を作ってください。";
    if (state.duration < DIGEST_MIN_S) return "動画が短いため、ダイジェストは作りません。";
    if (state.digest.auto.length === 0) return "区間を選べませんでした(字幕の語が少ないようです)。";
    return null;
  }

  function renderDigest() {
    const d = state.digest;
    const reason = digestReason();
    if (reason) { state.ui.setDigest({ supported: false, reason }); return; }
    const items = digestItems().map((s) => ({
      start: s.start, end: s.end, on: s.on, timeLabel: `${fmt(s.start)}–${fmt(s.end)}`,
      label: excerptAt(s.start),
    }));
    const finalList = finalSpans();
    const total = finalList.reduce((sum, s) => sum + (s.end - s.start), 0);
    const agree = Core.digestAgreement(d.auto, finalList);
    const summary = `${finalList.length} 区間・合計 ${fmt(total)}(動画の ${Math.round((total / state.duration) * 100)}%)` +
      (d.custom ? `・自動案との一致 ${Math.round(agree.f1 * 100)}%` : "");
    state.ui.setDigest({ supported: true, enabled: d.enabled, ratio: d.ratio, spans: items, summary, adjusted: !!d.custom });
  }

  function excerptAt(t) {
    const cue = state.cues.find((c) => c.start >= t - 1e-6);
    return cue ? Core.excerpt(cue.text, 28) : "";
  }

  function saveDigest() {
    const d = state.digest;
    if (d.custom) store.saveDigest(state.videoId, d.custom, d.auto, d.ratio);
    else store.clearDigest(state.videoId);
  }

  function digestTick() {
    const video = videoEl();
    if (!video || !state.digest.enabled) return;
    const act = Core.digestNext(finalSpans(), video.currentTime);
    if (!act) return;
    if (act.done) { setDigestEnabled(false); say("ダイジェストが終わりました。通常の再生に戻ります。"); return; }
    if (act.seekTo > video.currentTime + 0.05) video.currentTime = act.seekTo;
  }

  function setDigestEnabled(on) {
    const d = state.digest;
    const video = videoEl();
    if (d.onTime && video) { video.removeEventListener("timeupdate", d.onTime); d.onTime = null; }
    d.enabled = false;
    if (on) {
      if (!video || finalSpans().length === 0) { say("ダイジェストの区間がありません。", "error"); renderDigest(); return; }
      d.enabled = true;
      d.onTime = digestTick;
      video.addEventListener("timeupdate", d.onTime);
      digestTick();
    }
    renderDigest();
  }

  function digestRatio(r) {
    if (!(r > 0 && r <= 0.5)) return;
    state.digest.ratio = r;
    state.digest.custom = null; // 割合を変えたら、自動案を作り直す(それまでの調整は破棄)
    store.clearDigest(state.videoId);
    recomputeDigest();
    renderDigest();
  }

  function spanToggle(i) {
    const items = digestItems();
    if (!items[i]) return;
    items[i].on = !items[i].on;
    state.digest.custom = mergeSpans(items.filter((s) => s.on));
    saveDigest();
    renderDigest();
  }

  function spanAdd() {
    const video = videoEl();
    if (!video || !state.duration) return;
    const start = Math.min(video.currentTime, Math.max(0, state.duration - 5));
    const end = Math.min(state.duration, start + NEW_SPAN_S);
    state.digest.custom = mergeSpans(finalSpans().concat([{ start, end }]));
    saveDigest();
    renderDigest();
  }

  function digestReset() {
    state.digest.custom = null;
    saveDigest();
    renderDigest();
  }

  // ================= 共有(CH3b) =================
  const MODE_LABEL = { off: "共有しない(管理者が無効にしています)", team: "全員か、指定した人と共有できます", named: "指定した人だけと共有できます" };

  /** 共有タブを、いまの状態(state.share)から描く。note を渡すと、先頭の説明をそれにする。 */
  function showShare(note, error) {
    const sh = state.share;
    const info = sh.info;
    const mode = info ? info.mode : null;
    const canPublish = !!info && mode !== "off" && !!state.cues && state.cues.length > 0 && state.chapters.length >= 2 && !state.live;
    let text = note;
    if (text === undefined) {
      text = info ? `${info.who}\n共有範囲: ${MODE_LABEL[mode] || mode}` : "";
      if (info && mode !== "off" && !canPublish) text += "\n共有するには、先に「目次」タブで章を作ってください。";
    }
    state.ui.setShare({
      note: text, error: !!error, canPublish, mode, mine: sh.list.some((x) => x.mine) || sh.mineOff,
      shares: sh.list.map((x, i) => ({ from: x.from, count: x.boundaries.length + 1, mine: x.mine, overlay: sh.overlay.has(i) })),
    });
  }

  async function refreshShare() {
    const id = state.videoId || currentVideoId();
    const sh = state.share;
    if (state.live) { sh.info = null; sh.list = []; showShare("ライブでは共有できません。"); return; }
    if (!Store.VIDEO_ID.test(id || "")) { sh.info = null; sh.list = []; showShare("この動画の ID を読めません。", true); return; }
    showShare("エンジンに問い合わせています…");
    const me = await engine.me();
    if (state.videoId !== id) return;
    if (!me.ok) { sh.info = null; sh.list = []; showShare(Engine.describeError(me), true); return; }
    const mode = me.data.share_mode;
    const who = `${me.data.user.name || me.data.user.id}(${me.data.user.id}・${me.data.user.role === "admin" ? "管理者" : "利用者"})`;
    let list = [];
    let mineOff = false;
    if (mode === "off") { // 共有が無効でも、自分の共有の取り下げはできる
      const mineRes = await engine.mine();
      mineOff = mineRes.ok && ((mineRes.data && mineRes.data.mine) || []).some((m) => m.video === id);
    } else {
      const res = await engine.shares(id);
      if (!res.ok) { sh.info = null; sh.list = []; showShare(Engine.describeError(res), true); return; }
      list = (res.data && res.data.shares) || [];
    }
    if (state.videoId !== id) return;
    sh.info = { mode, who };
    sh.list = list;
    sh.mineOff = mineOff;
    sh.overlay = new Set([...sh.overlay].filter((i) => list[i] && !list[i].mine));
    showShare();
    drawMarkers();
  }

  // エンジンの応答が想定と違っても(data が無い等)、画面が「問い合わせています…」のまま止まらないようにする
  const guardShare = (fn) => async (...args) => {
    try { await fn(...args); } catch (_) { showShare("共有の処理でエラーが起きました(エンジンの応答が想定と違います)。", true); }
  };

  async function sharePublish(opts) {
    if (!state.cues || state.chapters.length < 2) { say("共有できる章がありません。", "error"); return; }
    const ids = String(opts.audience || "").split(/[\s,、]+/).filter(Boolean);
    if (ids.some((x) => !Engine.USER_ID.test(x))) { showShare("共有先は、利用者 ID(u_ と 8 桁の英数字)をカンマで区切って書いてください。", true); return; }
    const body = { video: state.videoId, boundaries: effective(), duration: state.duration, audience: ids.length ? ids : "team" };
    if (opts.withTitles) body.titles = state.chapters.map((c) => String(c.title || "").slice(0, 60));
    const res = await engine.publish(body);
    if (!res.ok) { showShare(Engine.describeError(res), true); return; }
    await refreshShare();
  }

  async function shareRevoke() {
    const res = await engine.revoke(state.videoId);
    if (!res.ok) { showShare(Engine.describeError(res), true); return; }
    await refreshShare();
  }

  function shareOverlay(i, on) {
    if (on) state.share.overlay.add(i); else state.share.overlay.delete(i);
    showShare();
    drawMarkers();
  }

  function shareAdopt(i) {
    const s = state.share.list[i];
    if (!s) return;
    if (!canEdit()) { say("先に「目次」タブで目次を作ってください(字幕を読み込む必要があります)。", "error"); state.ui.setTab("chapters"); return; }
    const clean = Core.normalizeBoundaries(s.boundaries, state.duration);
    state.manual = clean;
    store.saveManual(state.videoId, clean, state.auto);
    rebuild();
    say(`${s.from} さんの章立て(${clean.length + 1} 章)を使っています。「自動に戻す」で戻せます。`);
    state.ui.setTab("chapters");
  }

  // ================= 音声から作る(CH2b)・ライブ(CH5) =================
  // 取り込みは offscreen が行い、結果(チャンク内の相対時刻の字幕)がここへ届く

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
    setDigestEnabled(false);
    state.capture = cap;
    state.live = isLiveVideo() ? { session: null, queue: [], busy: false, resets: 0, markers: [], nowS: 0 } : null;
    state.cues = [];
    state.auto = []; state.manual = null; state.chapters = []; state.tentative = [];
    state.duration = video && isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    state.videoId = currentVideoId();
    clearMarkers();
    state.ui.setChapters([], Core.formatTimestamp, { editable: false });
    state.ui.setManual(false);
    state.ui.setCanCopy(false);
    renderDigest();
    state.ui.open();
    state.ui.setTab("chapters");
    say(state.live
      ? "ライブの取り込みを始めました。数十秒ごとに、章の印(暫定は「仮」)が増えます。"
      : `音声の取り込みを始めました(${video ? fmt(video.currentTime) : "0:00"} から)。再生すると、30 秒ごとに結果が増えます。`);
  }

  // ---- <video> の音を取り出して、エンジンへ送る係(offscreen)へ渡す。音は再生にそのまま流れ、ファイルには保存しない ----
  let pcm = null;
  function toBase64(int16) {
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function startPcm() {
    stopPcm();
    const video = videoEl();
    if (!video || typeof video.captureStream !== "function") throw new Error("この動画ページからは、音を取り出せません。YouTube の動画ページを開き直してください。");
    const tracks = video.captureStream().getAudioTracks();
    if (tracks.length === 0) throw new Error("この動画には、取り出せる音がありません(再生を始めてから、もう一度押してください)。");
    const ctx = new AudioContext();
    try { await ctx.resume(); } catch (_) { /* 再生の操作の後なら通る */ }
    const src = ctx.createMediaStreamSource(new MediaStream(tracks));
    const down = new Capture.Downsampler(ctx.sampleRate, Capture.TARGET_RATE);
    const node = ctx.createScriptProcessor(4096, 1, 1); // 出力は書かない(無音)。再生の音は、元の <video> がそのまま出す
    const wallAtZero = Date.now() - ctx.currentTime * 1000;
    let parts = [], startT = null, count = 0;
    const flush = () => {
      if (!parts.length) return;
      const all = new Int16Array(count);
      let off = 0;
      for (const p of parts) { all.set(p, off); off += p.length; }
      try { chrome.runtime.sendMessage({ target: "offscreen", type: "pcm", t: startT, wallAtZero, b64: toBase64(all) }); } catch (_) { /* 拡張が再読み込みされた */ }
      parts = []; startT = null; count = 0;
    };
    node.onaudioprocess = (e) => {
      const f = down.process(e.inputBuffer.getChannelData(0));
      const i16 = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) i16[i] = Math.max(-1, Math.min(1, f[i])) * 32767;
      if (startT === null) startT = e.playbackTime;
      parts.push(i16); count += i16.length;
      if (count >= Capture.TARGET_RATE) flush(); // 約 1 秒ごと
    };
    src.connect(node);
    node.connect(ctx.destination);
    pcm = { ctx, node, src, flush };
  }
  function stopPcm() {
    if (!pcm) return;
    const p = pcm; pcm = null;
    try { p.flush(); p.node.onaudioprocess = null; p.src.disconnect(); p.node.disconnect(); p.ctx.close(); } catch (_) { /* 既に閉じている */ }
    try { chrome.runtime.sendMessage({ target: "offscreen", type: "pcm-end" }); } catch (_) { /* 送れなくても続ける */ }
  }

  function stopCapture(notify) {
    stopPcm();
    const cap = state.capture;
    if (!cap) return;
    clearInterval(cap.timer);
    for (const [type, fn] of cap.listeners) cap.video.removeEventListener(type, fn);
    state.capture = null;
    const live = state.live;
    if (live && live.session) engine.liveClose(live.session);
    state.live = null;
    if (notify) { try { chrome.runtime.sendMessage({ target: "background", type: "stop" }); } catch (_) { /* 送れなくても続ける */ } }
  }

  function addCues(newCues) {
    if (newCues.length === 0) return;
    const lo = minStart(newCues), hi = maxEnd(newCues);
    // 同じ範囲を聞き直したとき(シークして戻ったなど)は、新しい方で置き換える
    state.cues = state.cues.filter((c) => c.end <= lo || c.start >= hi).concat(newCues).sort((a, b) => a.start - b.start);
  }

  // ---- ライブ: 字幕をエンジンのセッションへ足し、返ってきた印(確定・暫定)を章にする ----
  const MAX_PUSH = 400;
  async function livePump() {
    const L = state.live;
    if (!L || L.busy) return;
    L.busy = true;
    try {
      while (state.live === L && L.queue.length > 0) {
        const batch = L.queue.splice(0, MAX_PUSH);
        L.nowS = Math.max(L.nowS, maxEnd(batch));
        const res = await engine.live(L.session, batch.map((c) => ({ start: c.start, end: c.end, text: c.text })), L.nowS);
        if (state.live !== L) return;
        if (!res.ok) {
          if (res.status === 404 && L.session && L.resets < 2) { // 期限切れ: 新しく始めて、いまある字幕を全部送り直す
            L.resets++; L.session = null; L.queue = state.cues.slice();
            continue;
          }
          say(Engine.describeError(res), "error");
          L.queue = [];
          return;
        }
        L.session = res.data.session;
        L.markers = res.data.markers || [];
      }
      applyLiveMarkers();
    } catch (_) { // 応答の形が想定と違うなど。字幕の取り込みは続ける
      if (state.live === L) { say("ライブの処理でエラーが起きました(エンジンの応答が想定と違います)。", "error"); L.queue = []; }
    } finally { L.busy = false; }
  }

  function applyLiveMarkers() {
    const L = state.live;
    if (!L || state.cues.length === 0) return;
    const dur = maxEnd(state.cues);
    // 範囲外の印(章にならないもの)を先に除く。「仮」の番号が、章の番号とずれないように
    const marks = L.markers.filter((m) => m.t > 0 && m.t < dur).sort((a, b) => a.t - b.t);
    state.auto = marks.map((m) => m.t);
    state.chapters = Core.buildChapters(state.auto, state.cues, dur);
    state.tentative = marks.map((m, i) => (m.status === "tentative" ? i + 1 : -1)).filter((i) => i > 0);
    render();
    const committed = marks.length - state.tentative.length;
    say(`ライブ: 確定 ${committed} 件・暫定 ${state.tentative.length} 件(${fmt(dur)} まで)。暫定の「仮」は、後ろの話を聞いてから確定します。`);
  }

  const CAPTURE_ERRORS_STOP = new Set(["auth", "origin"]);
  function onTabMessage(msg) {
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("cl-")) return;
    if (msg.type === "cl-started") {
      if (isWatch()) {
        startCapture();
        if (msg.relay) startPcm().catch((e) => { say(String((e && e.message) || e), "error"); stopCapture(true); });
      }
      return;
    }
    const cap = state.capture;
    if (!cap) return;
    if (msg.type === "cl-cues") {
      const shifted = Capture.shiftCues(msg.cues || [], msg.chunkWallMs, cap.map);
      addCues(shifted);
      cap.language = (msg.info && msg.info.language) || cap.language;
      if (state.live) {
        state.live.queue.push(...shifted);
        livePump();
      } else if (state.cues.length > 0) {
        analyze();
        const covered = maxEnd(state.cues);
        if (state.chapters.length > 1) say(`${state.chapters.length} 章(${fmt(covered)} まで・字幕 ${state.cues.length} 行・言語 ${cap.language || "?"})。再生を続けると増えます。位置は数秒ずれることがあります。`);
      }
    } else if (msg.type === "cl-status") {
      if (state.cues.length === 0 && msg.info) say(`音声を聞いています…(処理済み ${fmt(msg.info.coveredS || 0)})。無音の間は飛ばします。`);
    } else if (msg.type === "cl-error") {
      say(msg.message || "音声の取り込みでエラーが起きました。", "error");
      if (CAPTURE_ERRORS_STOP.has(msg.code)) stopCapture(true);
    } else if (msg.type === "cl-ended") {
      const wasLive = !!state.live;
      stopCapture(false);
      if (state.cues.length > 0) {
        if (!wasLive) analyze();
        else render();
        state.ui.setRunLabel("目次を作る");
      }
      say(state.chapters.length > 1 ? `取り込みを止めました。${state.chapters.length} 章を作りました。` : "取り込みを止めました。");
    }
  }

  // ================= パネルからの操作(音声・状態・題名・検索・書き出し・キー・前回の結果) =================
  // --- 音声から作る(パネルのボタン。接続設定は、保存済みのものを background が使う) ---
  async function onAudio() {
    if (state.capture) { stopCapture(true); say("取り込みを止めました。"); state.ui.setAudioState({ capturing: false }); return; }
    say("音の取り込みを始めています…");
    let res;
    try { res = await chrome.runtime.sendMessage({ target: "background", type: "start-from-page" }); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    if (res && res.ok) return; // 始まると、background から cl-started が届く
    if (res && res.code === "unconfigured") {
      say("初回だけ、エンジンの URL と token の設定が要ります。「設定」を押してください(設定したら、もう一度このボタンを押します)。", "error");
      try { chrome.runtime.sendMessage({ target: "background", type: "open-setup" }); } catch (_) { /* 開けなくても続ける */ }
      return;
    }
    say((res && res.error) || "始められませんでした。エンジンを起動しているか、確かめてください。", "error");
  }
  function onOpenSetup() { try { chrome.runtime.sendMessage({ target: "background", type: "open-setup" }); } catch (_) { /* 開けない */ } }

  // --- エンジンの状態(接続・音声認識の用意)。パネルが開いている間だけ、20 秒ごとに確かめる ---
  let engineTimer = null;
  async function refreshEngine() {
    const ui = state.ui;
    if (!ui) return;
    const r = await engine.call("GET", "/v1/health");
    if (r.ok) {
      const d = r.data || {};
      const asr = d.asr === false || d.asr_ready === false || d.faster_whisper === false;
      ui.setEngine("ok", asr ? "エンジン: 接続中(音声認識は未インストール)" : "エンジン: 接続中");
    } else if (r.code === "unconfigured") ui.setEngine("bad", "エンジン: 未設定(音声から作るときだけ必要)");
    else ui.setEngine("bad", "エンジン: 未接続(音声・共有を使うときだけ必要。字幕からの目次は、エンジンなしで作れます)");
  }
  function watchEngine() {
    if (engineTimer) return;
    refreshEngine();
    engineTimer = setInterval(() => { if (document.hidden || !isWatch()) return; refreshEngine(); }, 20000); // 動画ページを見ている間だけ
  }

  // --- 題名の直接編集 ---
  function onTitleEdit(i, text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const c = state.chapters[i];
    if (!c) { render(); return; }
    state.titles = state.titles.filter((t) => Math.abs(t.start - c.start) > 1);
    if (clean) state.titles.push({ start: c.start, title: clean });
    store.saveTitles(state.videoId, state.titles);
    // 空にしたら、自動の題名に戻す(字幕があれば作り直す。前回の結果だけのときは、上書きだけを外して表示する)
    if (state.cues && state.cues.length) rebuild();
    else { state.chapters = Core.applyTitleOverrides(state.chapters.map((x) => (x.custom && Math.abs(x.start - c.start) <= 1 && !clean ? Object.assign({}, x, { custom: false }) : x)), state.titles); render(); }
    say(clean ? "題名を直しました(この PC のブラウザにだけ保存)。" : "題名を自動に戻しました。");
  }

  // --- 検索(目次の題名と字幕) ---
  function onSearch(q) {
    state.query = String(q || "");
    const ui = state.ui;
    if (!state.query.trim()) { ui.setSearchResults(null, fmt, ""); return; }
    const hits = [];
    const needle = state.query.normalize("NFKC").toLowerCase().trim();
    for (const c of state.chapters) if ((c.title || "").normalize("NFKC").toLowerCase().includes(needle)) hits.push({ start: c.start, text: `【章】${c.title}` });
    hits.push(...Core.searchCues(state.cues || [], state.query, 60));
    ui.setSearchResults(hits.slice(0, 60), fmt, state.query.trim());
  }

  // --- 書き出し ---
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.style.display = "none";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  async function copyText(text, okMessage) {
    try { await Promise.race([navigator.clipboard.writeText(text), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500))]); say(okMessage); return; } catch (_) { /* 下の方法へ */ }
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.cssText = "position:fixed;left:-9999px;";
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { /* 失敗 */ }
    ta.remove();
    say(ok ? okMessage : "コピーできませんでした。", ok ? undefined : "error");
  }
  function onExport(kind) {
    const id = state.videoId || "video";
    if (kind === "md") {
      if (state.chapters.length === 0) { say("先に目次を作ってください。", "error"); return; }
      const url = state.videoId ? `https://www.youtube.com/watch?v=${state.videoId}` : "";
      const heading = (document.title || "").replace(/ - YouTube$/, "");
      const text = Core.markdownText(state.chapters, { videoUrl: url, heading });
      download(`chapters-${id}.md`, text, "text/markdown");
      copyText(text, "Markdown をダウンロードし、クリップボードにもコピーしました。");
      return;
    }
    if (!state.cues || state.cues.length === 0) { say("字幕がまだありません。先に目次を作ってください。", "error"); return; }
    if (kind === "srt") download(`subtitles-${id}.srt`, Core.srtText(state.cues), "application/x-subrip");
    else download(`subtitles-${id}.vtt`, Core.vttText(state.cues), "text/vtt");
    say("字幕をダウンロードしました。");
  }

  // --- キー: [ で前の章・] で次の章(入力欄にいるときは動かさない) ---
  function onKey(e) {
    if (e.ctrlKey || e.altKey || e.metaKey || (e.key !== "[" && e.key !== "]")) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
    const video = videoEl();
    if (!video || state.chapters.length === 0 || !isWatch()) return;
    const cur = Core.chapterIndexAt(state.chapters, video.currentTime);
    let target = cur;
    if (e.key === "]") target = Math.min(state.chapters.length - 1, cur + 1);
    else target = video.currentTime - state.chapters[cur].start > 3 ? cur : Math.max(0, cur - 1); // 章の頭から 3 秒以上たっていれば、まず頭へ
    seek(state.chapters[target].start);
    say(`${fmt(state.chapters[target].start)} ${state.chapters[target].title || "チャプター"}`);
    e.preventDefault();
  }

  // --- 前回の結果: 境界と題名(特徴語)だけを覚えておき、字幕を読む前でも、すぐ目次を出す。字幕そのものは保存しない ---
  let cacheTimer = null;
  function saveAutoCache() {
    if (state.capture || state.live || !state.cues || state.cues.length === 0 || state.manual || !state.videoId) return;
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      const titles = state.chapters.filter((c) => c.title && !c.custom).map((c) => ({ start: c.start, title: c.title }));
      store.saveAuto(state.videoId, state.auto, titles);
    }, 1500);
  }
  async function restoreCache() {
    const id = state.videoId;
    if (!id) return;
    const saved = await store.load(id);
    if (state.videoId !== id || state.cues) return; // 別の動画へ移った・もう字幕を読んだ
    state.titles = saved.titles || [];
    const bounds = saved.manual ? saved.manual.boundaries : saved.auto ? saved.auto.boundaries : null;
    if (!bounds || bounds.length === 0) return;
    const video = videoEl();
    const dur = video && isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (!dur) return;
    state.duration = dur;
    const names = saved.auto ? saved.auto.titles : [];
    const chapters = [0, ...bounds.filter((b) => b > 0 && b < dur)].map((start, i, arr) => ({
      start, end: i + 1 < arr.length ? arr[i + 1] : dur, snippet: "",
      title: (names.find((t) => Math.abs(t.start - start) <= 1) || {}).title || "",
    }));
    state.chapters = Core.applyTitleOverrides(chapters, state.titles);
    render();
    say(`前回の目次を表示しています(${state.chapters.length} 章)。「目次を作る」で、字幕を読み込み直せます。`);
  }

  // ---- 動画が変わったら、前の動画の結果を捨てる ----
  function reset() {
    if (state.capture) stopCapture(true);
    setDigestEnabled(false);
    state.cues = null; state.auto = []; state.manual = null; state.chapters = []; state.tentative = []; state.duration = 0;
    state.videoId = currentVideoId();
    if (state.ui && state.ui.setVideoId) state.ui.setVideoId(state.videoId); // 章の一覧に、動画のサムネイルを出す
    state.digest.auto = []; state.digest.custom = null; state.digest.ratio = DIGEST_RATIO;
    state.share = { info: null, list: [], overlay: new Set(), mineOff: false };
    state.titles = []; state.query = "";
    clearMarkers();
    if (!state.ui) return;
    state.ui.setChapters([], Core.formatTimestamp, { editable: false });
    state.ui.setManual(false);
    state.ui.setCanCopy(false);
    state.ui.setRunLabel("目次を作る");
    renderDigest();
    state.ui.setSearch("");
    state.ui.setSearchResults(null, fmt, "");
    say("この動画の文字起こしから、話題の切り替えを探します。");
    restoreCache();
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
    state.ui = UI.createPanel(document, granularities, {
      onRun: run, onGranularity: setGranularity, onSeek: seek, onCopy: copy,
      onChapterRemove: chapterRemove, onChapterNudge: chapterNudge, onChapterAdd: chapterAdd, onManualReset: manualReset,
      onDigestToggle: setDigestEnabled, onDigestRatio: digestRatio, onSpanToggle: spanToggle, onSpanAdd: spanAdd, onDigestReset: digestReset,
      onShareRefresh: guardShare(refreshShare), onSharePublish: guardShare(sharePublish), onShareRevoke: guardShare(shareRevoke),
      onShareOverlay: shareOverlay, onShareAdopt: shareAdopt,
      onAudio, onOpenSetup, onTitleEdit, onTitleCancel: () => render(), onSearch, onExport,
      onTab: (name) => { if (name === "share") guardShare(refreshShare)(); else if (name === "digest") renderDigest(); },
    });
    state.ui.setGranularity(state.granularity);
    reset();
    document.addEventListener("yt-navigate-finish", onNavigate);
    document.addEventListener("keydown", onKey);
    if (chrome.runtime && typeof chrome.runtime.getManifest === "function") watchEngine(); // 本物の拡張の中だけ(状態の表示のための確認)
    try { chrome.runtime.onMessage.addListener(onTabMessage); } catch (_) { /* 拡張の外では使わない */ }
    if (isWatch()) { state.ui.mount(); bindVideo(); }
  }

  init();
})();
