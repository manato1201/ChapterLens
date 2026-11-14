/*
 * 画面(Shadow DOM): 右下の「目次」ボタン → パネル(3 つのタブ: 目次 / ダイジェスト / 共有)。
 * ページの CSS と互いに影響しないよう Shadow DOM に閉じる。文字は textContent だけで入れる(HTML として解釈しない)。
 * 状態は持たない: content.js が setXxx(view) で渡した内容を描くだけ(押された操作は handlers で返す)。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChapterLensUI = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { --bg:#ffffff; --fg:#1d1d20; --muted:#62626b; --line:#dcdce2; --accent:#0b57d0; --accent-fg:#fff; --hl:#e8f0fe; --err:#b3261e; --warn:#8a5a00;
      font: 13px/1.5 system-ui, "Yu Gothic UI", "Hiragino Sans", sans-serif; color: var(--fg); }
    .wrap.dark { --bg:#212125; --fg:#ececf1; --muted:#a6a6b0; --line:#3a3a42; --accent:#8ab4f8; --accent-fg:#101014; --hl:#2b3a55; --err:#f2b8b5; --warn:#f0c674; }
    .launcher { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; padding: 8px 14px; border-radius: 18px;
      border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; font: inherit; box-shadow: 0 2px 10px rgba(0,0,0,.25); }
    .launcher:hover { border-color: var(--accent); }
    .panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; width: min(380px, calc(100vw - 32px)); max-height: min(75vh, 600px);
      display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.3); overflow: hidden; }
    .panel[hidden], .launcher[hidden], [role="tabpanel"][hidden], [hidden] { display: none !important; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px 6px; }
    header strong { font-size: 14px; }
    button { font: inherit; color: inherit; cursor: pointer; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button[disabled] { opacity: .5; cursor: default; }
    .close { border: 0; background: none; font-size: 18px; line-height: 1; padding: 2px 6px; color: var(--muted); }
    .tabs { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--line); }
    .tab { border: 0; border-bottom: 2px solid transparent; background: none; padding: 5px 10px; color: var(--muted); }
    .tab[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
    .view { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; overflow-y: auto; }
    .gran { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--line); align-items: center; flex-wrap: wrap; }
    .gran span { color: var(--muted); margin-right: 2px; }
    .seg { border: 1px solid var(--line); background: none; border-radius: 14px; padding: 2px 10px; }
    .seg[aria-pressed="true"] { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
    .status { padding: 8px 12px; color: var(--muted); min-height: 2.6em; overflow-wrap: anywhere; white-space: pre-line; }
    .status.error { color: var(--err); }
    .primary { margin: 0 12px 10px; padding: 7px 12px; border-radius: 8px; border: 0; background: var(--accent); color: var(--accent-fg); font-weight: 600; }
    ol, ul { list-style: none; margin: 0; padding: 0 0 4px; }
    .chapters { overflow-y: auto; flex: 1 1 auto; }
    li.row { display: flex; align-items: stretch; }
    li.row > button.chap, li.row > button.go { flex: 1 1 auto; min-width: 0; display: grid; grid-template-columns: 5.2em 1fr; gap: 8px; text-align: left; border: 0; background: none; padding: 6px 12px; }
    li.row > button.chap:hover, li.row > button.go:hover { background: var(--hl); }
    li.current > button.chap { background: var(--hl); font-weight: 600; }
    .snip { color: var(--muted); font-size: 12px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
    .time { font-variant-numeric: tabular-nums; color: var(--accent); }
    .title { overflow-wrap: anywhere; }
    .tent { color: var(--warn); font-size: 11px; border: 1px dashed var(--warn); border-radius: 8px; padding: 0 5px; margin-left: 6px; white-space: nowrap; }
    .edit { display: flex; gap: 2px; align-items: center; padding-right: 8px; }
    .mini { border: 1px solid var(--line); background: none; border-radius: 6px; padding: 0 6px; font-size: 11px; line-height: 20px; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 12px; border-top: 1px solid var(--line); }
    .actions button, footer button, .field button { flex: 1 1 auto; border: 1px solid var(--line); background: none; border-radius: 8px; padding: 5px 8px; }
    footer { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--line); }
    footer button { flex: 1; }
    .note { padding: 0 12px 8px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .section { padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
    .row2 { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .toggle { border: 1px solid var(--line); background: none; border-radius: 14px; padding: 3px 12px; }
    .toggle[aria-pressed="true"] { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
    .summary { padding: 0 12px 6px; color: var(--muted); }
    .spans, .shares { overflow-y: auto; }
    li.span { display: flex; align-items: center; gap: 4px; padding-left: 10px; }
    li.span input { margin: 0; }
    li.span.off .title { text-decoration: line-through; opacity: .55; }
    li.shr { display: flex; align-items: center; gap: 6px; padding: 4px 12px; flex-wrap: wrap; }
    li.shr .who { flex: 1 1 8em; overflow-wrap: anywhere; }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .field input[type="text"] { width: 100%; padding: 4px 6px; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; }
    .check { display: flex; gap: 6px; align-items: flex-start; color: var(--muted); font-size: 12px; }
    .check input { margin: 3px 0 0; }
    /* ---- YouTube の「動画の関連情報」に近い見た目(右の列に組み込む / 無理なら右下に浮かべる) ---- */
    .wrap.docked .panel { position: static; width: auto; max-height: none; margin: 0 0 12px; box-shadow: none; border-radius: 12px; }
    .wrap.docked .launcher { display: none !important; }
    .wrap.docked .view { max-height: 62vh; }
    header { padding: 12px 14px 8px; }
    header strong { font-size: 16px; font-weight: 600; }
    .headbtns { display: flex; gap: 2px; align-items: center; }
    .tabs { gap: 8px; padding: 0 14px 10px; border-bottom: 0; flex-wrap: wrap; }
    .tab { border: 0; border-radius: 8px; padding: 6px 12px; background: var(--chip); color: var(--fg); font-weight: 500; }
    .tab[aria-selected="true"] { background: var(--chipOn); color: var(--chipOnFg); border-bottom-color: transparent; font-weight: 600; }
    .wrap { --chip:#f2f2f2; --chipOn:#0f0f0f; --chipOnFg:#fff; }
    .wrap.dark { --chip:#ffffff1a; --chipOn:#f1f1f1; --chipOnFg:#0f0f0f; }
    .collapsed .tabs, .collapsed .view { display: none !important; }
    .seg { padding: 4px 12px; background: var(--chip); border: 0; }
    .gran { padding: 4px 14px 10px; border-bottom: 0; }
    .gran span { font-size: 12px; }
    .status { padding: 6px 14px; min-height: 0; }
    .primary { margin: 2px 14px 12px; padding: 9px 14px; border-radius: 18px; font-size: 14px; }
    .primary[disabled] { opacity: .6; }
    li.row > button.chap { grid-template-columns: auto minmax(0, 1fr); gap: 12px; padding: 6px 14px; align-items: center; }
    .thumb { width: 100px; height: 56px; object-fit: cover; border-radius: 8px; background: var(--line); display: block; }
    .txt { display: flex; flex-direction: column; gap: 4px; min-width: 0; align-items: flex-start; }
    .txt .title { font-weight: 600; font-size: 13.5px; line-height: 1.35; }
    .time { font-variant-numeric: tabular-nums; background: var(--hl); color: var(--accent); border-radius: 6px; padding: 1px 7px; font-size: 12px; font-weight: 600; }
    li.current { background: var(--chip); }
    li.current > button.chap, li.row > button.chap:hover { background: transparent; font-weight: inherit; }
    li.row:hover { background: var(--chip); }
    .view > * { flex-shrink: 0; }
    .bar { position: sticky; bottom: 0; display: flex; gap: 6px; padding: 8px 14px; background: var(--bg); border-top: 1px solid var(--line); z-index: 1; }
    .bar button { flex: 1 1 auto; border: 1px solid var(--line); background: none; border-radius: 18px; padding: 6px 10px; white-space: nowrap; }
    .bar button:hover:not([disabled]) { border-color: var(--accent); }
    li.current .time { background: var(--accent); color: var(--accent-fg); }
    .edit { padding-right: 12px; }
    .actions, footer { border-top: 0; padding: 6px 14px; }
    .note { padding: 0 14px 10px; }
    .engine { display: flex; align-items: center; gap: 6px; padding: 0 14px 6px; font-size: 12px; color: var(--muted); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; }
    .dot.ok { background: #2ba640; } .dot.bad { background: var(--err); }
    .engine .link { margin-left: auto; border: 0; background: none; color: var(--accent); padding: 0; font-size: 12px; text-decoration: underline; }
    .secondary { margin: 0 14px 10px; padding: 7px 14px; border-radius: 18px; border: 1px solid var(--line); background: none; }
    .secondary:hover:not([disabled]) { border-color: var(--accent); }
    .search { margin: 0 14px 8px; display: flex; gap: 6px; }
    .search input { flex: 1; min-width: 0; padding: 6px 10px; border-radius: 18px; border: 1px solid var(--line); background: var(--chip); color: var(--fg); font: inherit; }
    .results { padding: 0 0 6px; }
    li.hit > button { display: grid; grid-template-columns: auto 1fr; gap: 10px; width: 100%; text-align: left; border: 0; background: none; padding: 5px 14px; }
    li.hit > button:hover { background: var(--chip); }
    .titleedit { width: 100%; padding: 3px 6px; border-radius: 6px; border: 1px solid var(--accent); background: var(--bg); color: var(--fg); font: inherit; }
    .export { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 0 14px 10px; color: var(--muted); font-size: 12px; }
    .export button { border: 1px solid var(--line); background: none; border-radius: 14px; padding: 3px 10px; font-size: 12px; }
    .wrap.docked .chapters { overflow: visible; flex: none; }
    .wrap.docked .view { max-height: 70vh; }
    .edit { opacity: 0; transition: opacity .12s; }
    li.row:hover .edit, li.row:focus-within .edit, li.current .edit { opacity: 1; }
    /* ---- ちいさな遊び: 触れたとき・現れたときの「1 回きり」の動きだけ(無限には動かさない)。動かすのは transform と opacity ---- */
    @media (prefers-reduced-motion: no-preference) {
      /* 章が見つかると、上から順に、ふわっと現れる(最初の 8 つまで。残りは待たせない) */
      .chapters.enter li.row { animation: cl-rise .28s cubic-bezier(.16,1,.3,1) both; }
      .chapters.enter li.row:nth-child(2) { animation-delay: 40ms; } .chapters.enter li.row:nth-child(3) { animation-delay: 80ms; } .chapters.enter li.row:nth-child(4) { animation-delay: 120ms; }
      .chapters.enter li.row:nth-child(5) { animation-delay: 160ms; } .chapters.enter li.row:nth-child(6) { animation-delay: 200ms; } .chapters.enter li.row:nth-child(7) { animation-delay: 240ms; }
      .chapters.enter li.row:nth-child(n+8) { animation-delay: 280ms; }
      /* 押せるものは、触れると少し浮き、押すと沈む */
      .primary, .secondary, .launcher, .tab, .seg, .toggle, .bar button, .export button { transition: transform .12s cubic-bezier(.4,0,.2,1); }
      .primary:hover:not([disabled]), .secondary:hover:not([disabled]), .launcher:hover, .bar button:hover:not([disabled]) { transform: translateY(-1px); }
      .primary:active:not([disabled]), .secondary:active:not([disabled]), .launcher:active, .tab:active, .seg:active, .toggle:active, .bar button:active { transform: scale(.97); }
      /* 時刻の札は、触れると、ぴょんと跳ねる */
      li.row:hover .time { animation: cl-hop .24s cubic-bezier(.16,1,.3,1); }
      /* エンジンにつながったら、緑の点が 1 回だけ広がる */
      .dot.ok { animation: cl-ping .6s cubic-bezier(.16,1,.3,1); }
    }
    @keyframes cl-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @keyframes cl-hop { 0% { transform: none; } 40% { transform: translateY(-2px) scale(1.06); } 100% { transform: none; } }
    @keyframes cl-ping { 0% { transform: scale(.4); opacity: .4; } 60% { transform: scale(1.35); opacity: 1; } 100% { transform: scale(1); } }
  `;

  function h(doc, tag, props, children) {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k.startsWith(".")) el[k.slice(1)] = v; // プロパティ(value / checked / disabled / hidden)
      else el.setAttribute(k, v);
    }
    for (const c of children || []) el.append(c);
    return el;
  }

  const TABS = [["chapters", "目次"], ["digest", "ダイジェスト"], ["share", "共有"]];
  const RATIOS = [[0.1, "10%"], [0.2, "20%"], [0.3, "30%"]];

  /**
   * handlers: onRun / onGranularity(key) / onSeek(sec) / onCopy
   *           onChapterRemove(i) / onChapterNudge(i, deltaS) / onChapterAdd() / onManualReset()
   *           onDigestToggle(on) / onDigestRatio(r) / onSpanToggle(i) / onSpanAdd() / onDigestReset()
   *           onShareRefresh() / onSharePublish({audience, withTitles}) / onShareRevoke() / onShareOverlay(i, on) / onShareAdopt(i) / onTab(name)
   * granularities: [{key, label}]
   */
  function createPanel(doc, granularities, handlers) {
    const call = (name, ...args) => { if (handlers[name]) handlers[name](...args); };
    const host = h(doc, "div", { id: "chapterlens-root" });
    const shadow = host.attachShadow({ mode: "open" });
    shadow.append(h(doc, "style", { text: CSS }));
    const wrap = h(doc, "div", { class: "wrap" });
    const launcher = h(doc, "button", { class: "launcher", type: "button", text: "目次", "aria-label": "ChapterLens の目次を開く", onclick: () => api.open() });

    // ---- タブ 1: 目次 ----
    const status = h(doc, "div", { class: "status", role: "status", "aria-live": "polite" });
    const runBtn = h(doc, "button", { class: "primary", type: "button", text: "目次を作る", onclick: () => call("onRun") });
    const list = h(doc, "ol", { class: "chapters", "aria-label": "章の一覧" });
    let listHadRows = false;
    const engineDot = h(doc, "span", { class: "dot" });
    const engineText = h(doc, "span", { text: "エンジン: 確認中…" });
    const setupLink = h(doc, "button", { class: "link", type: "button", text: "設定", onclick: () => call("onOpenSetup") });
    const engineRow = h(doc, "div", { class: "engine" }, [engineDot, engineText, setupLink]);
    const audioBtn = h(doc, "button", { class: "secondary", type: "button", text: "音声から作る(字幕が無い動画・ライブ)", onclick: () => call("onAudio") });
    const searchInput = h(doc, "input", { type: "search", placeholder: "目次と字幕から探す", "aria-label": "目次と字幕から探す" });
    searchInput.addEventListener("input", () => call("onSearch", searchInput.value));
    searchInput.addEventListener("keydown", (e) => { if (e.key === "Escape") { searchInput.value = ""; call("onSearch", ""); } e.stopPropagation(); });
    const searchRow = h(doc, "div", { class: "search" }, [searchInput]);
    const results = h(doc, "ul", { class: "results", "aria-label": "検索の結果", ".hidden": true });
    const exportRow = h(doc, "div", { class: "export" }, [
      h(doc, "span", { text: "書き出し" }),
      h(doc, "button", { type: "button", text: "Markdown", onclick: () => call("onExport", "md") }),
      h(doc, "button", { type: "button", text: "字幕 SRT", onclick: () => call("onExport", "srt") }),
      h(doc, "button", { type: "button", text: "字幕 VTT", onclick: () => call("onExport", "vtt") }),
    ]);
    const copyBtn = h(doc, "button", { type: "button", text: "概要欄用にコピー", onclick: () => call("onCopy") });
    const addBtn = h(doc, "button", { type: "button", text: "いまの位置に章を足す", onclick: () => call("onChapterAdd") });
    const resetBtn = h(doc, "button", { type: "button", text: "自動に戻す", ".hidden": true, onclick: () => call("onManualReset") });
    const segButtons = new Map();
    const gran = h(doc, "div", { class: "gran", role: "group", "aria-label": "粒度" }, [h(doc, "span", { text: "粒度" })]);
    for (const g of granularities) {
      const b = h(doc, "button", { class: "seg", type: "button", text: g.label, "aria-pressed": "false", onclick: () => call("onGranularity", g.key) });
      segButtons.set(g.key, b);
      gran.append(b);
    }
    const note = h(doc, "div", { class: "note", text: "字幕の言葉の変化から自動で作ります。位置は数秒ずれることがあります。−5 / +5 / × で直せます(この PC のブラウザにだけ保存)。" });
    const chaptersView = h(doc, "section", { class: "view", role: "tabpanel", "aria-label": "目次" }, [
      engineRow, gran, status, runBtn, audioBtn, searchRow, results, list, exportRow, note, h(doc, "div", { class: "bar" }, [addBtn, resetBtn, copyBtn]), // 操作は、いつも下に見えている(スクロールしなくてよい)
    ]);

    // ---- タブ 2: ダイジェスト ----
    const digestView = h(doc, "section", { class: "view", role: "tabpanel", "aria-label": "ダイジェスト", ".hidden": true });
    // ---- タブ 3: 共有 ----
    const shareView = h(doc, "section", { class: "view", role: "tabpanel", "aria-label": "共有", ".hidden": true });

    const views = { chapters: chaptersView, digest: digestView, share: shareView };
    const tabButtons = new Map();
    const tabs = h(doc, "div", { class: "tabs", role: "tablist" });
    for (const [key, label] of TABS) {
      const b = h(doc, "button", { class: "tab", type: "button", role: "tab", text: label, "aria-selected": String(key === "chapters"), onclick: () => api.setTab(key) });
      tabButtons.set(key, b);
      tabs.append(b);
    }

    const collapseBtn = h(doc, "button", { class: "close", type: "button", "aria-label": "たたむ / 開く", title: "たたむ / 開く", text: "▾", onclick: () => api.toggleCollapse() });
    const panel = h(doc, "section", { class: "panel", "aria-label": "ChapterLens", ".hidden": true }, [
      h(doc, "header", {}, [h(doc, "strong", { text: "目次(ChapterLens)" }), h(doc, "span", { class: "headbtns" }, [collapseBtn, h(doc, "button", { class: "close", type: "button", "aria-label": "閉じる", text: "×", onclick: () => api.close() })])]),
      tabs, chaptersView, digestView, shareView,
    ]);
    wrap.append(launcher, panel);
    shadow.append(wrap);

    let videoId = "";
    let collapsed = false;
    let lastCurrent = -1;
    let hovering = false;
    list.addEventListener("mouseenter", () => { hovering = true; });
    list.addEventListener("mouseleave", () => { hovering = false; });
    function thumbEl() {
      if (!videoId) return h(doc, "span", { class: "thumb-empty" });
      return h(doc, "img", { class: "thumb", alt: "", loading: "lazy", src: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` });
    }
    function applyTheme() { wrap.classList.toggle("dark", doc.documentElement.hasAttribute("dark")); }

    // YouTube の右の列(#secondary-inner)を探す。まだ無ければ、できるまで見張る(SPA の遷移で作り直されることもある)
    let observer = null;
    function findDock() {
      try { return doc.querySelector ? (doc.querySelector("#secondary-inner") || doc.querySelector("#secondary")) : null; } catch (_) { return null; }
    }
    function watchForDock() {
      if (observer || typeof MutationObserver === "undefined" || !doc.documentElement) return;
      let timer = null;
      observer = new MutationObserver(() => {
        if (timer) return;
        timer = setTimeout(() => { timer = null; if (findDock()) api.mount(); }, 200);
      });
      observer.observe(doc.documentElement, { childList: true, subtree: true });
    }
    function stopWatching() { if (observer) { observer.disconnect(); observer = null; } }

    function btn(text, onclick, extra) { return h(doc, "button", Object.assign({ type: "button", text, onclick }, extra || {})); }

    // ---- ダイジェストの描画 ----
    function renderDigest(v) {
      digestView.replaceChildren();
      if (!v.supported) {
        digestView.append(h(doc, "div", { class: "status", text: v.reason || "章ができてから使えます。" }));
        return;
      }
      const toggle = btn(v.enabled ? "ダイジェスト再生: オン" : "ダイジェスト再生: オフ", () => call("onDigestToggle", !v.enabled), { class: "toggle", "aria-pressed": String(!!v.enabled) });
      const ratio = h(doc, "div", { class: "row2", role: "group", "aria-label": "長さの割合" }, [h(doc, "span", { class: "note", text: "長さ" })]);
      for (const [r, label] of RATIOS) ratio.append(btn(label, () => call("onDigestRatio", r), { class: "seg", "aria-pressed": String(Math.abs(r - v.ratio) < 1e-9) }));
      digestView.append(h(doc, "div", { class: "section" }, [toggle, ratio]));
      digestView.append(h(doc, "div", { class: "summary", text: v.summary || "" }));
      const spans = h(doc, "ul", { class: "spans", "aria-label": "ダイジェストの区間" });
      v.spans.forEach((s, i) => {
        spans.append(h(doc, "li", { class: "span row" + (s.on ? "" : " off") }, [
          h(doc, "input", { type: "checkbox", ".checked": !!s.on, "aria-label": `${s.timeLabel} を含める`, onchange: () => call("onSpanToggle", i) }),
          h(doc, "button", { class: "go", type: "button", onclick: () => call("onSeek", s.start) }, [
            h(doc, "span", { class: "time", text: s.timeLabel }), h(doc, "span", { class: "title", text: s.label || "" }),
          ]),
        ]));
      });
      digestView.append(spans);
      digestView.append(h(doc, "div", { class: "actions" }, [
        btn("いまの位置から 15 秒を足す", () => call("onSpanAdd")),
        v.adjusted ? btn("自動案に戻す", () => call("onDigestReset")) : h(doc, "span"),
      ]));
      digestView.append(h(doc, "div", { class: "note", text: "動画は切り出しません。オンにすると、区間の外を自動で飛ばして再生するだけです。区間は字幕の言葉から決めた目安で、チェックや追加で直せます。" }));
    }

    // ---- 共有の描画 ----
    const shareForm = { audience: "", titles: false }; // 「重ねる」などで再描画しても、入力中の内容を失わない
    function renderShare(v) {
      shareView.replaceChildren();
      shareView.append(h(doc, "div", { class: "status" + (v.error ? " error" : ""), text: v.note || "" }));
      if (v.canPublish) {
        const audience = h(doc, "input", { type: "text", "aria-label": "共有先の利用者 ID", placeholder: v.mode === "named" ? "共有先の ID(例 u_1a2b3c4d,u_5e6f7a8b)" : "空 = 全員 / ID をカンマ区切り", ".value": shareForm.audience });
        const titles = h(doc, "input", { type: "checkbox", "aria-label": "題名も共有する", ".checked": shareForm.titles });
        audience.addEventListener("input", () => { shareForm.audience = audience.value; });
        titles.addEventListener("change", () => { shareForm.titles = !!titles.checked; });
        shareView.append(h(doc, "div", { class: "section" }, [
          h(doc, "div", { class: "field" }, [audience]),
          h(doc, "label", { class: "check" }, [titles, h(doc, "span", { text: "題名(字幕の冒頭 24 文字)も共有する。既定は区間の時刻だけ" })]),
          h(doc, "div", { class: "row2" }, [
            btn("この動画の章を共有する", () => call("onSharePublish", { audience: audience.value, withTitles: !!titles.checked })),
            v.mine ? btn("取り下げる", () => call("onShareRevoke")) : h(doc, "span"),
          ]),
        ]));
      }
      const list2 = h(doc, "ul", { class: "shares", "aria-label": "他の人の章立て" });
      (v.shares || []).forEach((s, i) => {
        list2.append(h(doc, "li", { class: "shr" }, [
          h(doc, "span", { class: "who", text: `${s.from}: ${s.count} 章${s.mine ? "(あなた)" : ""}` }),
          s.mine ? h(doc, "span") : btn("重ねる", () => call("onShareOverlay", i, !s.overlay), { class: "toggle", "aria-pressed": String(!!s.overlay) }),
          s.mine ? h(doc, "span") : btn("この章立てを使う", () => call("onShareAdopt", i), { class: "mini" }),
        ]));
      });
      shareView.append(list2);
      shareView.append(h(doc, "div", { class: "actions" }, [btn("更新", () => call("onShareRefresh"))]));
      shareView.append(h(doc, "div", { class: "note", text: "共有するのは区間の時刻だけ(題名は選んだときだけ)。字幕・音声・動画は共有しません。共有はエンジンの管理者が許可した範囲で、いつでも取り下げられます。" }));
    }

    const api = {
      host,
      mount() {
        applyTheme();
        const target = findDock();
        if (target) {
          wrap.classList.toggle("docked", true);
          if (host.parentNode !== target) target.insertBefore(host, target.firstChild);
          panel.hidden = false; launcher.hidden = true; // 右の列に組み込んだときは、いつも見える(たたむのは ▾)
          stopWatching();
        } else {
          wrap.classList.toggle("docked", false);
          if (!host.isConnected) (doc.body || doc.documentElement).append(host);
          watchForDock();
        }
      },
      unmount() { stopWatching(); host.remove(); },
      open() { applyTheme(); panel.hidden = false; launcher.hidden = true; if (collapsed) api.toggleCollapse(); },
      close() { if (wrap.classList.contains("docked")) { api.toggleCollapse(true); return; } panel.hidden = true; launcher.hidden = false; },
      toggleCollapse(force) {
        collapsed = force === undefined ? !collapsed : !!force;
        wrap.classList.toggle("collapsed", collapsed);
        collapseBtn.textContent = collapsed ? "▴" : "▾";
      },
      setVideoId(id) { videoId = /^[A-Za-z0-9_-]{6,20}$/.test(String(id || "")) ? String(id) : ""; },
      isOpen() { return !panel.hidden; },
      setTab(name) {
        if (!views[name]) return;
        for (const [k, v] of Object.entries(views)) v.hidden = k !== name;
        for (const [k, b] of tabButtons) b.setAttribute("aria-selected", String(k === name));
        call("onTab", name);
      },
      setStatus(text, kind) { status.textContent = text; status.className = "status" + (kind === "error" ? " error" : ""); },
      setBusy(busy) { runBtn.disabled = busy; for (const b of segButtons.values()) b.disabled = busy; },
      setRunLabel(text) { runBtn.textContent = text; },
      setGranularity(key) { for (const [k, b] of segButtons) b.setAttribute("aria-pressed", String(k === key)); },
      setCanCopy(ok) { copyBtn.disabled = !ok; },
      /** opts: { editable: 章を直せるか, tentative: 暫定の章の番号の配列 } */
      setChapters(chapters, formatTime, opts) {
        const o = opts || {};
        const tent = new Set(o.tentative || []);
        // 章が「無いところから、できた」とき(最初の 1 回)だけ、現れる動きを付ける。30 秒ごとの更新では、動かさない
        list.className = "chapters" + (!listHadRows && chapters.length ? " enter" : "");
        listHadRows = chapters.length > 0;
        list.replaceChildren();
        chapters.forEach((c, i) => {
          const row = h(doc, "li", { class: "row", "data-index": String(i) }, [
            h(doc, "button", { class: "chap", type: "button", onclick: () => call("onSeek", c.start) }, [
              thumbEl(),
              h(doc, "span", { class: "txt" }, [
                h(doc, "span", { class: "title", title: o.editable !== false ? "ダブルクリックで題名を直せます" : "", ondblclick: () => api.editTitle(i) }, [
                  h(doc, "span", { text: c.title || "チャプター" }),
                  ...(tent.has(i) ? [h(doc, "span", { class: "tent", text: "仮", title: "暫定。後ろの話を聞いてから確定します" })] : []),
                ]),
                ...(c.snippet ? [h(doc, "span", { class: "snip", text: c.snippet })] : []),
                h(doc, "span", { class: "time", text: formatTime(c.start) }),
              ]),
            ]),
          ]);
          if (o.editable && i > 0) {
            row.append(h(doc, "span", { class: "edit" }, [
              btn("−5", () => call("onChapterNudge", i, -5), { class: "mini", "aria-label": `${formatTime(c.start)} の章の始まりを 5 秒早める` }),
              btn("+5", () => call("onChapterNudge", i, 5), { class: "mini", "aria-label": `${formatTime(c.start)} の章の始まりを 5 秒遅らせる` }),
              btn("×", () => call("onChapterRemove", i), { class: "mini", "aria-label": `${formatTime(c.start)} の境界を消す(前の章とつなげる)` }),
            ]));
          }
          list.append(row);
        });
        addBtn.disabled = !o.editable;
      },
      setManual(isManual) { resetBtn.hidden = !isManual; },
      setCurrent(index) {
        let cur = null;
        list.querySelectorAll("li").forEach((li) => {
          const on = Number(li.getAttribute("data-index")) === index;
          li.classList.toggle("current", on);
          if (on) cur = li;
        });
        // いまの章が見える位置へ、一覧の中だけをスクロールする(ページ全体は動かさない)。利用者が一覧の上にカーソルを置いている間は動かさない
        if (cur && index !== lastCurrent && !hovering && chaptersView.scrollTo && cur.offsetTop !== undefined) {
          const top = cur.offsetTop - list.offsetTop - 8;
          const view = chaptersView;
          if (cur.offsetTop < view.scrollTop || cur.offsetTop + cur.offsetHeight > view.scrollTop + view.clientHeight - 60) view.scrollTo({ top: Math.max(0, top + list.offsetTop), behavior: "smooth" });
        }
        lastCurrent = index;
      },
      /** 題名の直接編集: その行の題名を入力欄にし、Enter で確定(onTitleEdit)・Esc でやめる。 */
      editTitle(i) {
        const row = list.querySelector(`li[data-index="${i}"]`);
        if (!row) return;
        const t = row.querySelector(".title");
        if (!t || t.querySelector("input")) return;
        const current = t.firstChild && t.firstChild.textContent !== undefined ? t.firstChild.textContent : t.textContent || ""; // 「仮」の印は含めない
        const input = h(doc, "input", { class: "titleedit", type: "text", maxlength: "60", "aria-label": "章の題名", ".value": current });
        let finished = false; // Enter の後に blur も来るので、確定・取り消しは 1 回だけ
        const done = (commit) => { if (finished) return; finished = true; if (commit) call("onTitleEdit", i, input.value); else call("onTitleCancel"); };
        input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") done(true); else if (e.key === "Escape") done(false); });
        input.addEventListener("blur", () => done(true));
        input.addEventListener("click", (e) => e.stopPropagation());
        t.replaceChildren(input);
        if (input.focus) input.focus();
      },
      /** items: [{start, text}] か null(null で、通常の一覧へ戻る) */
      setSearchResults(items, formatTime, query) {
        results.replaceChildren();
        if (!items) { results.hidden = true; list.hidden = false; return; }
        results.hidden = false; list.hidden = true;
        if (items.length === 0) results.append(h(doc, "li", { class: "note", text: `「${query}」は見つかりませんでした。` }));
        for (const it of items) {
          results.append(h(doc, "li", { class: "hit" }, [h(doc, "button", { type: "button", onclick: () => call("onSeek", it.start) }, [
            h(doc, "span", { class: "time", text: formatTime(it.start) }), h(doc, "span", { class: "title", text: it.text }),
          ])]));
        }
      },
      setEngine(kind, text) { // kind: ok / bad / unknown
        engineDot.className = "dot" + (kind === "ok" ? " ok" : kind === "bad" ? " bad" : "");
        engineText.textContent = text;
        setupLink.hidden = kind === "ok";
      },
      setAudioState({ capturing, enabled }) {
        audioBtn.textContent = capturing ? "取り込みを止める" : "音声から作る(字幕が無い動画・ライブ)";
        audioBtn.disabled = enabled === false;
      },
      setSearch(text) { searchInput.value = text || ""; },
      setDigest: renderDigest,
      setShare: renderShare,
    };
    api.setCanCopy(false);
    api.setChapters([], (x) => String(x), { editable: false });
    renderDigest({ supported: false, reason: "章ができてから使えます。" });
    renderShare({ note: "", canPublish: false, shares: [] });
    return api;
  }

  return { createPanel };
});
