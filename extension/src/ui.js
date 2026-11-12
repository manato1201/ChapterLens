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
      gran, status, runBtn, list, h(doc, "div", { class: "actions" }, [addBtn, resetBtn]), note, h(doc, "footer", {}, [copyBtn]),
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

    const panel = h(doc, "section", { class: "panel", "aria-label": "ChapterLens", ".hidden": true }, [
      h(doc, "header", {}, [h(doc, "strong", { text: "ChapterLens" }), h(doc, "button", { class: "close", type: "button", "aria-label": "閉じる", text: "×", onclick: () => api.close() })]),
      tabs, chaptersView, digestView, shareView,
    ]);
    wrap.append(launcher, panel);
    shadow.append(wrap);

    function applyTheme() { wrap.classList.toggle("dark", doc.documentElement.hasAttribute("dark")); }

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
    function renderShare(v) {
      shareView.replaceChildren();
      shareView.append(h(doc, "div", { class: "status" + (v.error ? " error" : ""), text: v.note || "" }));
      if (v.canPublish) {
        const audience = h(doc, "input", { type: "text", "aria-label": "共有先の利用者 ID", placeholder: v.mode === "named" ? "共有先の ID(例 u_1a2b3c4d,u_5e6f7a8b)" : "空 = 全員 / ID をカンマ区切り", ".value": "" });
        const titles = h(doc, "input", { type: "checkbox", "aria-label": "題名も共有する" });
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
      mount() { if (!host.isConnected) (doc.body || doc.documentElement).append(host); applyTheme(); },
      unmount() { host.remove(); },
      open() { applyTheme(); panel.hidden = false; launcher.hidden = true; },
      close() { panel.hidden = true; launcher.hidden = false; },
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
        list.replaceChildren();
        chapters.forEach((c, i) => {
          const row = h(doc, "li", { class: "row", "data-index": String(i) }, [
            h(doc, "button", { class: "chap", type: "button", onclick: () => call("onSeek", c.start) }, [
              h(doc, "span", { class: "time", text: formatTime(c.start) }),
              h(doc, "span", { class: "title" }, [
                h(doc, "span", { text: c.title || "チャプター" }),
                ...(tent.has(i) ? [h(doc, "span", { class: "tent", text: "仮", title: "暫定。後ろの話を聞いてから確定します" })] : []),
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
        list.querySelectorAll("li").forEach((li) => li.classList.toggle("current", Number(li.getAttribute("data-index")) === index));
      },
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
