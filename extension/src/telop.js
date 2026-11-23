/*
 * ChapterLens telop: 再生中の動画の上に、今の章の題名(と大見出し)を、文字で重ねて表示する。
 *
 * **自分の画面にだけ**出す(動画の保存・加工・書き出しはしない)。プレイヤーの中に 1 要素を置くので、全画面でも見える。
 * 判断(いつ出すか: contentAt / decide)と、描画(create)と、まとめ(createTracker)を分けてある。
 * 文字は textContent だけで入れる(題名に HTML が入っても、要素は増えない)。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChapterLensTelop = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SHOW_MS = 4000; // 章が変わってから消えるまで
  const SETTLE_MS = 500; // 章の変化を、これだけ待って 1 回にまとめる(シークの行き来・境界付近のゆれ)
  const FADE_MS = 200; // 出現・消える動き(1 回きり)
  const MODES = ["change", "always", "off"];

  /**
   * いまの章の、テロップの中身。題名が空なら null。
   * heading は、大見出しが「変わった」ときだけ(prevIdx の章と見出しが違う・最初の表示)。sections が無ければ常に null。
   */
  function contentAt(chapters, sections, idx, prevIdx) {
    const c = (chapters || [])[idx];
    if (!c || !c.title) return null;
    let heading = null;
    const sec =
      Array.isArray(sections) && Number.isInteger(c.section)
        ? sections[c.section]
        : null;
    if (sec) {
      const prev =
        Number.isInteger(prevIdx) && prevIdx >= 0 ? chapters[prevIdx] : null;
      if (!prev || prev.section !== c.section) heading = sec.heading;
    }
    return { heading, title: c.title };
  }

  /** state = { mode, lastIdx, adShowing, reducedMotion }・event = { idx } → { show, hideAfterMs }。 */
  function decide(state, event) {
    if (state.mode === "off" || state.adShowing)
      return { show: false, hideAfterMs: null };
    if (state.mode === "always") return { show: true, hideAfterMs: null };
    if (event.idx !== state.lastIdx)
      return { show: true, hideAfterMs: SHOW_MS };
    return { show: false, hideAfterMs: null };
  }

  const BOX =
    "display:block;width:fit-content;margin-left:auto;background:#fff;color:#000;font-weight:900;line-height:1.25;padding:.1em .45em;overflow-wrap:anywhere;";

  /** playerEl の中に、テロップの要素を 1 つ作る。戻り: { show(content, opts), hide(), destroy() }。 */
  function create(doc, playerEl, options) {
    const o = options || {};
    const setT = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearT = o.clearTimeout || ((id) => clearTimeout(id));
    const raf =
      o.raf ||
      (typeof requestAnimationFrame === "function"
        ? (f) => requestAnimationFrame(f)
        : (f) => setT(f, 16));
    let el = null,
      headEl = null,
      titleEl = null,
      timer = null;

    function ensure() {
      if (el) return;
      el = doc.createElement("div");
      el.className = "chapterlens-telop";
      el.style.cssText =
        "position:absolute;top:7%;right:3%;max-width:46%;z-index:60;pointer-events:none;text-align:right;opacity:0;" +
        "font-family:'Hiragino Sans','Yu Gothic UI','Meiryo',sans-serif;";
      headEl = doc.createElement("div");
      titleEl = doc.createElement("div");
      headEl.style.cssText = BOX;
      titleEl.style.cssText = BOX;
      el.append(headEl, titleEl);
      playerEl.append(el);
    }

    function hide() {
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      if (el) el.style.opacity = "0";
    }

    function show(content, so) {
      const opt = so || {};
      ensure();
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      const width = Number(playerEl.clientWidth) || 640;
      const base = Math.max(14, Math.min(36, width * 0.03)); // プレイヤーの幅に合わせる
      const size = opt.persistent ? base * 0.7 : base;
      headEl.textContent = content.heading || "";
      headEl.style.display = content.heading ? "block" : "none";
      headEl.style.fontSize = (size * 0.62).toFixed(1) + "px";
      headEl.style.marginBottom = "2px";
      titleEl.textContent = content.title;
      titleEl.style.fontSize = size.toFixed(1) + "px";
      const move = !opt.reducedMotion; // 動きを減らす設定では、透明度だけ
      el.style.transition = move
        ? `opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease`
        : `opacity ${FADE_MS}ms ease`;
      el.style.transform = move ? "translateY(-6px)" : "none";
      el.style.opacity = "0";
      raf(() => {
        if (!el) return;
        el.style.opacity = "1";
        el.style.transform = "none";
      });
      if (opt.hideAfterMs)
        timer = setT(() => {
          timer = null;
          hide();
        }, opt.hideAfterMs);
    }

    function destroy() {
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      if (el) el.remove();
      el = headEl = titleEl = null;
    }

    return { show, hide, destroy };
  }

  /**
   * timeupdate ごとに onTime() を呼ぶ。章が変わっても、SETTLE_MS の間に落ち着いた最後の章を、1 回だけ出す。
   * 同じ章のあいだはタイマーを作り直さない(再生中は timeupdate が約 4 回/秒来るので)。
   * o = { view, getIdx, getChapters, getSections, getMode, isAdShowing, isReducedMotion, setTimeout?, clearTimeout? }
   */
  function createTracker(o) {
    const setT = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearT = o.clearTimeout || ((id) => clearTimeout(id));
    let lastIdx = -1,
      pendingIdx = null,
      timer = null;

    function cancel() {
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      pendingIdx = null;
    }

    function fire() {
      timer = null;
      pendingIdx = null;
      const idx = o.getIdx();
      const mode = o.getMode();
      const adShowing = !!o.isAdShowing();
      const d = decide(
        { mode, lastIdx, adShowing, reducedMotion: !!o.isReducedMotion() },
        { idx },
      );
      if (!d.show) return;
      const content = contentAt(o.getChapters(), o.getSections(), idx, lastIdx);
      lastIdx = idx;
      if (!content) {
        o.view.hide();
        return;
      }
      o.view.show(content, {
        hideAfterMs: d.hideAfterMs,
        persistent: mode === "always",
        reducedMotion: !!o.isReducedMotion(),
      });
    }

    return {
      onTime() {
        if (o.getMode() === "off") {
          cancel();
          return;
        }
        if (o.isAdShowing()) {
          // 広告中は出さない。表示中なら消し、明けたら、いまの章をあらためて出す
          cancel();
          if (lastIdx !== -1) {
            lastIdx = -1;
            o.view.hide();
          }
          return;
        }
        const idx = o.getIdx();
        if (idx === lastIdx) {
          cancel();
          return;
        }
        if (timer !== null && pendingIdx === idx) return;
        cancel();
        pendingIdx = idx;
        timer = setT(fire, SETTLE_MS);
      },
      /** 動画が変わった・モードを変えた: 状態を戻し、表示を消す(次の onTime で、あらためて出る)。 */
      reset() {
        cancel();
        lastIdx = -1;
        o.view.hide();
      },
      destroy() {
        cancel();
        lastIdx = -1;
        o.view.destroy();
      },
    };
  }

  return {
    contentAt,
    decide,
    create,
    createTracker,
    MODES,
    SHOW_MS,
    SETTLE_MS,
  };
});
