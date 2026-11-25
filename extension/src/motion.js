/*
 * 状態変化の動き(ばね)。2026-11-26。ui.js が、あれば使う(無ければ動かさずに切り替えるだけ)。
 *   1. セグメント(.gran の .seg): 選択中の下地が、ばねで滑って移る。速さに応じて少し伸び縮みする。
 *   2. 読み込み → 完了(「題名を付ける」): 回る輪 + 進み具合 → ✓ と色。失敗は揺れる。
 *   3. コピー(「概要欄用にコピー」): アイコンが ✓ に変わり、文字が「コピーしました」へ転がる。1.8 秒で戻る。
 *
 * 動きの元: designbookmark.com の Motion 部品(Segmented control・Loading to success・Copy button)。
 * 元のコードはライセンスの記載が無いので写さない。**ばねの強さ・減衰の値と、動きの決まりだけ**を合わせて、
 * ここで書き直した(値は下の SPRINGS)。
 *
 * 計算: 質量 1 のばね。a = -k(x - 目標) - c·v を、半陰的オイラー(速度を先に更新)で、1 フレームを 4 分割して積む。
 * 1 フレームの時間は最大 1/30 秒(タブが裏に回った後に飛ばない)。
 * 動きを減らす設定(prefers-reduced-motion): ばねは使わず、すぐ目標の値にする(止める = 消すのでなく、即時の切替)。
 * 文字は textContent だけで入れる(HTML として解釈しない)。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChapterLensMotion = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** ばね(強さ k・減衰 c)。元の部品と同じ値。 */
  const SPRINGS = Object.freeze({
    seg: { k: 300, c: 20 }, // セグメントの下地の横移動
    busyWidth: { k: 300, c: 22 }, // 読み込み → 完了: ボタンの幅
    busyLabel: { k: 400, c: 30 }, //   文字の出入り
    busySpin: { k: 300, c: 28 }, //   回る輪の出入り
    busyDone: { k: 220, c: 20 }, //   ✓ の出入り
    busyFill: { k: 200, c: 30 }, //   完了の色
    busyCheck: { k: 120, c: 20 }, //   ✓ を描く
    shake: { k: 700, c: 9 }, // 失敗の揺れ
    copyRoll: { k: 260, c: 20 }, // コピー: 文字の転がり
    copyIcon: { k: 420, c: 18 }, //   アイコンの入れ替わり
    copyWidth: { k: 300, c: 24 }, //   幅
  });
  const COPY_REVERT_MS = 1800;
  const DONE_HOLD_MS = 1600;
  const SPIN_DEG_PER_S = 504; // 1 秒に 1.4 回転
  const SUBSTEPS = 4;
  const REST_X = 0.001;
  const REST_V = 0.01;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 1 フレーム分、ばねを進める(純粋な計算。テストから直接呼ぶ)。 */
  function step(s, dt) {
    const h = Math.min(dt, 1 / 30) / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) {
      const a = -s.k * (s.x - s.target) - s.c * s.v;
      s.v += a * h;
      s.x += s.v * h;
    }
    if (Math.abs(s.x - s.target) < REST_X && Math.abs(s.v) < REST_V) {
      s.x = s.target;
      s.v = 0;
      return false; // 止まった
    }
    return true;
  }

  /** win(requestAnimationFrame・matchMedia を持つもの)に結びついた、ばねの組み立て一式。 */
  function create(win) {
    const mq =
      win && win.matchMedia
        ? win.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const reduced = () => Boolean(mq && mq.matches);
    const raf = (fn) =>
      win && win.requestAnimationFrame
        ? win.requestAnimationFrame(fn)
        : setTimeout(() => fn(Date.now()), 16);
    const now = () =>
      win && win.performance ? win.performance.now() : Date.now();
    const active = new Set();
    let running = false;
    let last = 0;

    function frame(t) {
      const dt = (t - last) / 1000;
      last = t;
      for (const s of Array.from(active)) {
        if (!step(s, dt)) active.delete(s);
        s.onUpdate(s.x, s.v);
      }
      running = active.size > 0;
      if (running) raf(frame);
    }
    function wake(s) {
      active.add(s);
      if (!running) {
        running = true;
        last = now();
        raf(frame);
      }
    }

    function spring({ value = 0, k = 300, c = 20, onUpdate = () => {} }) {
      const s = { x: value, v: 0, target: value, k, c, onUpdate };
      return {
        get x() {
          return s.x;
        },
        to(target) {
          s.target = target;
          if (reduced()) {
            s.x = target;
            s.v = 0;
            active.delete(s);
            s.onUpdate(s.x, s.v);
            return;
          }
          wake(s);
        },
        set(v) {
          s.x = v;
          s.target = v;
          s.v = 0;
          active.delete(s);
          s.onUpdate(s.x, s.v);
        },
        kick(velocity) {
          if (reduced()) return;
          s.v += velocity;
          wake(s);
        },
      };
    }

    // ---- 1. セグメント --------------------------------------------------------------------
    // group: .gran。buttons: その中の .seg(aria-pressed で選択中が分かる)。下地(.seg-ind)を 1 つ足す。
    function segmented(group, doc) {
      const ind = doc.createElement("span");
      ind.className = "seg-ind";
      ind.setAttribute("aria-hidden", "true");
      group.prepend(ind);
      group.classList.add("has-ind");
      let y = 0;
      let current = null;
      let lastTop = null;
      const sx = spring({
        ...SPRINGS.seg,
        onUpdate: (x, v) => {
          const sp = clamp(Math.abs(v) / 1400, 0, 0.22);
          ind.style.transform = `translate(${x}px, ${y}px) scale(${1 + sp}, ${1 - sp / 2})`;
        },
      });
      const api = {
        update() {
          const on = Array.from(group.querySelectorAll(".seg")).find(
            (b) => b.getAttribute("aria-pressed") === "true",
          );
          if (!on) {
            ind.hidden = true;
            current = null;
            return;
          }
          ind.hidden = false;
          y = on.offsetTop;
          ind.style.width = `${on.offsetWidth}px`;
          ind.style.height = `${on.offsetHeight}px`;
          // 初めて・同じボタン・行が変わった(折り返し)・見えていなかった(幅 0)ときは、動かさずに合わせる
          if (
            current === null ||
            current === on ||
            on.offsetTop !== lastTop ||
            !on.offsetWidth
          )
            sx.set(on.offsetLeft);
          else sx.to(on.offsetLeft);
          lastTop = on.offsetTop;
          current = on;
        },
        reset() {
          current = null;
        },
      };
      // パネルを開いた・タブを切り替えた・幅が変わった(隠れている間は寸法が 0): 動かさずに合わせ直す
      if (win && win.ResizeObserver) {
        new win.ResizeObserver(() => {
          current = null;
          api.update();
        }).observe(group);
      }
      return api;
    }

    // ---- 2. 読み込み → 完了 ------------------------------------------------------------------
    const SVG_NS = "http://www.w3.org/2000/svg";
    function svgIcon(doc, d, size, extra) {
      const svg = doc.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("width", String(size));
      svg.setAttribute("height", String(size));
      svg.setAttribute("aria-hidden", "true");
      for (const p of [].concat(d)) {
        const path = doc.createElementNS(SVG_NS, "path");
        path.setAttribute("d", p);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("stroke-width", (extra && extra.width) || "2");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
      }
      return svg;
    }
    const CHECK = "M5 12.5l4.5 4.5L19 7.5";

    // busy(button, doc) → { loading(text), text(text), success(text), fail(), reset() }
    // reset() で、元の文字(押す前の中身)に戻す。
    function busy(button, doc) {
      const original = Array.from(button.childNodes).map((n) =>
        n.cloneNode(true),
      );
      const spin = doc.createElement("span");
      spin.className = "cl-spin";
      spin.setAttribute("aria-hidden", "true");
      const label = doc.createElement("span");
      const check = svgIcon(doc, CHECK, 16, { width: "2.6" });
      check.classList.add("cl-check");
      const path = check.firstChild;
      path.setAttribute("stroke-dasharray", "22");
      path.setAttribute("stroke-dashoffset", "22");
      let spinning = false;
      let angle = 0;
      let spinLast = 0;
      let doneTimer = 0;

      const w = spring({
        ...SPRINGS.busyWidth,
        value: 0,
        onUpdate: (x) => {
          if (x > 0) button.style.width = `${x}px`;
        },
      });
      const lab = spring({
        ...SPRINGS.busyLabel,
        onUpdate: (x) => {
          const p = clamp(x, 0, 1);
          label.style.opacity = String(p);
          label.style.transform = `translateY(${(1 - p) * 6}px)`;
        },
      });
      const sp = spring({
        ...SPRINGS.busySpin,
        onUpdate: (x) => {
          const p = clamp(x, 0, 1);
          spin.style.opacity = String(p);
          spin.style.setProperty("--cl-spin-scale", String(0.6 + 0.4 * p));
        },
      });
      const dn = spring({
        ...SPRINGS.busyDone,
        onUpdate: (x) => {
          check.style.opacity = String(clamp(x, 0, 1));
        },
      });
      const fill = spring({
        ...SPRINGS.busyFill,
        onUpdate: (x) => {
          button.style.setProperty("--cl-fill", `${clamp(x, 0, 1) * 100}%`);
        },
      });
      const ck = spring({
        ...SPRINGS.busyCheck,
        value: 22,
        onUpdate: (x) => {
          path.setAttribute("stroke-dashoffset", String(Math.max(0, x)));
        },
      });
      const shake = spring({
        ...SPRINGS.shake,
        onUpdate: (x) => {
          button.style.translate = `${x}px 0`;
        },
      });

      function spinLoop(t) {
        if (!spinning) return;
        const dt = Math.min((t - spinLast) / 1000, 1 / 30);
        spinLast = t;
        angle = (angle + SPIN_DEG_PER_S * dt) % 360;
        spin.style.setProperty("--cl-spin-angle", `${angle}deg`);
        raf(spinLoop);
      }
      function naturalWidth() {
        const keep = button.style.width;
        button.style.width = "";
        const n = button.offsetWidth;
        button.style.width = keep;
        return n;
      }
      function morph(nodes) {
        const from = button.offsetWidth;
        button.replaceChildren(...nodes);
        const to = naturalWidth();
        w.set(from);
        w.to(to);
      }
      function clear() {
        spinning = false;
        clearTimeout(doneTimer);
        button.classList.remove("is-busy", "is-done");
        button.style.width = "";
        button.style.removeProperty("--cl-fill");
        button.replaceChildren(...original.map((n) => n.cloneNode(true)));
      }
      return {
        loading(text) {
          clearTimeout(doneTimer);
          button.classList.remove("is-done");
          button.classList.add("is-busy");
          label.textContent = text;
          morph([spin, label]);
          lab.set(0);
          lab.to(1);
          sp.to(1);
          fill.set(0);
          if (!reduced() && !spinning) {
            spinning = true;
            spinLast = now();
            raf(spinLoop);
          }
        },
        text(text) {
          if (label.textContent === text) return;
          label.textContent = text;
          w.to(naturalWidth());
        },
        success(text) {
          spinning = false;
          sp.to(0);
          button.classList.add("is-busy", "is-done");
          label.textContent = text;
          morph([check, label]);
          dn.set(0);
          dn.to(1);
          fill.to(1);
          ck.set(22);
          setTimeout(() => ck.to(0), reduced() ? 0 : 150);
          doneTimer = setTimeout(clear, DONE_HOLD_MS);
        },
        fail() {
          clear();
          shake.set(0);
          shake.kick(-260); // 失敗は揺らす(左へ弾いて、ばねで戻る)
        },
        reset: clear,
      };
    }

    // ---- 3. コピー ---------------------------------------------------------------------------
    // copyRoll(button, doc, idleText, doneText) → { copied() }。ボタンの中身を「アイコン + 2 行の文字(転がる)」にする。
    function copyRoll(button, doc, idleText, doneText) {
      button.classList.add("cl-copy");
      button.setAttribute("aria-label", idleText);
      const icons = doc.createElement("span");
      icons.className = "cl-ic";
      icons.setAttribute("aria-hidden", "true");
      const iCopy = svgIcon(doc, ["M9 9h10v10H9z", "M5 15V5h10"], 16, {
        width: "1.9",
      });
      const iOk = svgIcon(doc, CHECK, 16, { width: "2.4" });
      iOk.classList.add("cl-ok");
      icons.append(iCopy, iOk);
      const roll = doc.createElement("span");
      roll.className = "cl-roll";
      roll.setAttribute("aria-hidden", "true");
      const col = doc.createElement("span");
      col.className = "cl-col";
      const a = doc.createElement("b");
      a.textContent = idleText;
      const b = doc.createElement("b");
      b.className = "cl-done";
      b.textContent = doneText;
      col.append(a, b);
      roll.append(col);
      button.replaceChildren(icons, roll);
      let timer = 0;

      const r = spring({
        ...SPRINGS.copyRoll,
        onUpdate: (x) => {
          col.style.transform = `translateY(${-x * 100}%)`;
        },
      });
      // 2 行の文字(1 行ずつ縦に並ぶ)を、1 行分(50%)だけ上へ転がす
      const rr = { to: (t) => r.to(t / 2), set: (t) => r.set(t / 2) };
      const ic = spring({
        ...SPRINGS.copyIcon,
        onUpdate: (x) => {
          const i = clamp(x, -0.2, 1.2);
          const p = clamp(i, 0, 1);
          iCopy.style.opacity = String(clamp(1 - 1.6 * i, 0, 1));
          iCopy.style.transform = `scale(${1 - 0.5 * p}) rotate(${-40 * p}deg)`;
          iOk.style.opacity = String(clamp(1.6 * i - 0.4, 0, 1));
          iOk.style.transform = `scale(${0.4 + 0.6 * i})`;
        },
      });
      const w = spring({
        ...SPRINGS.copyWidth,
        onUpdate: (x) => {
          if (x > 0) roll.style.width = `${x}px`;
        },
      });
      const widthOf = (el) => el.offsetWidth || 0;
      rr.set(0);
      ic.set(0);
      w.set(widthOf(a));

      function to(on) {
        rr.to(on ? 1 : 0);
        ic.to(on ? 1 : 0);
        w.to(widthOf(on ? b : a));
        button.setAttribute("aria-label", on ? doneText : idleText);
      }
      return {
        copied() {
          clearTimeout(timer);
          if (!roll.style.width) w.set(widthOf(a));
          to(true);
          timer = setTimeout(() => to(false), COPY_REVERT_MS);
        },
      };
    }

    return { spring, segmented, busy, copyRoll, reduced };
  }

  return { SPRINGS, COPY_REVERT_MS, DONE_HOLD_MS, step, create };
});
