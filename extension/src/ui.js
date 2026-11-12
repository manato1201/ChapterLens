/*
 * 画面(Shadow DOM): 右下の「目次」ボタン → パネル(粒度の選択・章の一覧・概要欄用にコピー)。
 * ページの CSS と互いに影響しないよう Shadow DOM に閉じる。文字は textContent だけで入れる(HTML として解釈しない)。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChapterLensUI = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { --bg:#ffffff; --fg:#1d1d20; --muted:#62626b; --line:#dcdce2; --accent:#0b57d0; --accent-fg:#fff; --hl:#e8f0fe; --err:#b3261e;
      font: 13px/1.5 system-ui, "Yu Gothic UI", "Hiragino Sans", sans-serif; color: var(--fg); }
    .wrap.dark { --bg:#212125; --fg:#ececf1; --muted:#a6a6b0; --line:#3a3a42; --accent:#8ab4f8; --accent-fg:#101014; --hl:#2b3a55; --err:#f2b8b5; }
    .launcher { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; padding: 8px 14px; border-radius: 18px;
      border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; font: inherit; box-shadow: 0 2px 10px rgba(0,0,0,.25); }
    .launcher:hover { border-color: var(--accent); }
    .panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; width: min(360px, calc(100vw - 32px)); max-height: min(70vh, 560px);
      display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.3); overflow: hidden; }
    .panel[hidden], .launcher[hidden] { display: none; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    header strong { font-size: 14px; }
    button { font: inherit; color: inherit; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .close { border: 0; background: none; font-size: 18px; line-height: 1; padding: 2px 6px; color: var(--muted); }
    .gran { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--line); align-items: center; flex-wrap: wrap; }
    .gran span { color: var(--muted); margin-right: 2px; }
    .seg { border: 1px solid var(--line); background: none; border-radius: 14px; padding: 2px 10px; }
    .seg[aria-pressed="true"] { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
    .status { padding: 8px 12px; color: var(--muted); min-height: 2.6em; }
    .status.error { color: var(--err); }
    .primary { margin: 0 12px 10px; padding: 7px 12px; border-radius: 8px; border: 0; background: var(--accent); color: var(--accent-fg); font-weight: 600; }
    .primary[disabled] { opacity: .5; cursor: default; }
    ol { list-style: none; margin: 0; padding: 0 0 4px; overflow-y: auto; flex: 1 1 auto; }
    li button.chap { display: grid; grid-template-columns: 4.2em 1fr; gap: 8px; width: 100%; text-align: left; border: 0; background: none; padding: 6px 12px; }
    li button.chap:hover { background: var(--hl); }
    li.current button.chap { background: var(--hl); font-weight: 600; }
    .time { font-variant-numeric: tabular-nums; color: var(--accent); }
    .title { overflow-wrap: anywhere; }
    footer { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--line); }
    footer button { flex: 1; border: 1px solid var(--line); background: none; border-radius: 8px; padding: 6px 8px; }
    footer button[disabled] { opacity: .5; cursor: default; }
    .note { padding: 0 12px 8px; color: var(--muted); font-size: 12px; }
  `;

  function h(doc, tag, props, children) {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children || []) el.append(c);
    return el;
  }

  /**
   * handlers: { onRun(), onGranularity(key), onSeek(sec), onCopy() }
   * granularities: [{key, label}]
   */
  function createPanel(doc, granularities, handlers) {
    const host = h(doc, "div", { id: "chapterlens-root" });
    const shadow = host.attachShadow({ mode: "open" });
    shadow.append(h(doc, "style", { text: CSS }));

    const wrap = h(doc, "div", { class: "wrap" });
    const launcher = h(doc, "button", { class: "launcher", type: "button", text: "目次", "aria-label": "ChapterLens の目次を開く", onclick: () => api.open() });
    const status = h(doc, "div", { class: "status", role: "status", "aria-live": "polite" });
    const runBtn = h(doc, "button", { class: "primary", type: "button", text: "目次を作る", onclick: () => handlers.onRun() });
    const list = h(doc, "ol", { "aria-label": "章の一覧" });
    const copyBtn = h(doc, "button", { type: "button", text: "概要欄用にコピー", onclick: () => handlers.onCopy() });
    const segButtons = new Map();
    const gran = h(doc, "div", { class: "gran", role: "group", "aria-label": "粒度" }, [h(doc, "span", { text: "粒度" })]);
    for (const g of granularities) {
      const b = h(doc, "button", { class: "seg", type: "button", text: g.label, "aria-pressed": "false", onclick: () => handlers.onGranularity(g.key) });
      segButtons.set(g.key, b);
      gran.append(b);
    }
    const note = h(doc, "div", { class: "note", text: "字幕の言葉の変化から自動で作ります。位置は数秒ずれることがあります。" });
    const panel = h(doc, "section", { class: "panel", "aria-label": "ChapterLens", hidden: "" }, [
      h(doc, "header", {}, [h(doc, "strong", { text: "ChapterLens" }), h(doc, "button", { class: "close", type: "button", "aria-label": "閉じる", text: "×", onclick: () => api.close() })]),
      gran, status, runBtn, list, note,
      h(doc, "footer", {}, [copyBtn]),
    ]);
    wrap.append(launcher, panel);
    shadow.append(wrap);

    function applyTheme() {
      wrap.classList.toggle("dark", doc.documentElement.hasAttribute("dark"));
    }

    const api = {
      host,
      mount() { if (!host.isConnected) (doc.body || doc.documentElement).append(host); applyTheme(); },
      unmount() { host.remove(); },
      open() { applyTheme(); panel.hidden = false; launcher.hidden = true; },
      close() { panel.hidden = true; launcher.hidden = false; },
      isOpen() { return !panel.hidden; },
      setStatus(text, kind) { status.textContent = text; status.className = "status" + (kind === "error" ? " error" : ""); },
      setBusy(busy) { runBtn.disabled = busy; for (const b of segButtons.values()) b.disabled = busy; },
      setRunLabel(text) { runBtn.textContent = text; },
      setGranularity(key) { for (const [k, b] of segButtons) b.setAttribute("aria-pressed", String(k === key)); },
      setCanCopy(ok) { copyBtn.disabled = !ok; },
      setChapters(chapters, formatTime) {
        list.replaceChildren();
        chapters.forEach((c, i) => {
          list.append(h(doc, "li", { "data-index": String(i) }, [
            h(doc, "button", { class: "chap", type: "button", onclick: () => handlers.onSeek(c.start) }, [
              h(doc, "span", { class: "time", text: formatTime(c.start) }),
              h(doc, "span", { class: "title", text: c.title || "チャプター" }),
            ]),
          ]));
        });
      },
      setCurrent(index) {
        list.querySelectorAll("li").forEach((li) => li.classList.toggle("current", Number(li.getAttribute("data-index")) === index));
      },
    };
    api.setCanCopy(false);
    return api;
  }

  return { createPanel };
});
