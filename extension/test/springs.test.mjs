// 状態変化の動き(ばね。src/motion.js)の決まり: 値は元の部品と同じ・計算の性質・動きを減らす設定では即時に切り替わる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const M = require("../src/motion.js");

test("springs: 値は designbookmark の部品と同じ(強さ・減衰)", () => {
  assert.deepEqual(M.SPRINGS.seg, { k: 300, c: 20 });
  assert.deepEqual(M.SPRINGS.busyWidth, { k: 300, c: 22 });
  assert.deepEqual(M.SPRINGS.busyLabel, { k: 400, c: 30 });
  assert.deepEqual(M.SPRINGS.busySpin, { k: 300, c: 28 });
  assert.deepEqual(M.SPRINGS.busyDone, { k: 220, c: 20 });
  assert.deepEqual(M.SPRINGS.busyFill, { k: 200, c: 30 });
  assert.deepEqual(M.SPRINGS.busyCheck, { k: 120, c: 20 });
  assert.deepEqual(M.SPRINGS.copyRoll, { k: 260, c: 20 });
  assert.deepEqual(M.SPRINGS.copyIcon, { k: 420, c: 18 });
  assert.deepEqual(M.SPRINGS.copyWidth, { k: 300, c: 24 });
  assert.equal(M.COPY_REVERT_MS, 1800);
});

test("springs: セグメントのばね(300/20)は、少し行き過ぎてから目標に止まる", () => {
  const s = { x: 0, v: 0, target: 100, ...M.SPRINGS.seg };
  let max = 0, frames = 0;
  while (M.step(s, 1 / 60) && frames < 600) { max = Math.max(max, s.x); frames++; }
  assert.ok(max > 100 && max < 120, `行き過ぎ ${max}`);
  assert.equal(s.x, 100);
  assert.ok(frames < 120, `2 秒以内に止まる (${frames} フレーム)`);
});

test("springs: 1 フレームが長くても(タブが裏に回った後)、1/30 秒ぶんしか進まない", () => {
  const a = { x: 0, v: 0, target: 100, ...M.SPRINGS.seg };
  const b = { x: 0, v: 0, target: 100, ...M.SPRINGS.seg };
  M.step(a, 5);
  M.step(b, 1 / 30);
  assert.equal(a.x, b.x);
});

function fakeWin(reduce) {
  const queue = [];
  let t = 0;
  return {
    queue,
    matchMedia: () => ({ matches: reduce }),
    requestAnimationFrame: (fn) => queue.push(fn),
    performance: { now: () => t },
    flush(n) { for (let i = 0; i < n && queue.length; i++) { t += 16; const fns = queue.splice(0); for (const f of fns) f(t); } },
  };
}

test("springs: 動きを減らす設定では、ばねを使わず、すぐ目標の値になる(フレームを待たない)", () => {
  const win = fakeWin(true);
  const seen = [];
  const sp = M.create(win).spring({ value: 0, k: 300, c: 20, onUpdate: (x) => seen.push(x) });
  sp.to(50);
  assert.equal(sp.x, 50);
  assert.deepEqual(seen, [50]);
  assert.equal(win.queue.length, 0);
  sp.kick(999); // 揺れも無し
  assert.equal(win.queue.length, 0);
});

test("springs: ふだんは、フレームごとに進んで目標に止まり、止まったらフレームを頼まない", () => {
  const win = fakeWin(false);
  const sp = M.create(win).spring({ value: 0, k: 300, c: 20 });
  sp.to(10);
  win.flush(1);
  assert.ok(sp.x > 0 && sp.x < 10);
  win.flush(400);
  assert.equal(sp.x, 10);
  assert.equal(win.queue.length, 0);
});

test("springs: manifest は ui.js の前に motion.js を読む(ui.js は、無ければ動かさない)", () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8"));
  const js = manifest.content_scripts[0].js;
  assert.ok(js.indexOf("src/motion.js") >= 0 && js.indexOf("src/motion.js") < js.indexOf("src/ui.js"));
  const ui = readFileSync(fileURLToPath(new URL("../src/ui.js", import.meta.url)), "utf8");
  assert.match(ui, /return M && win \? M\.create\(win\) : null;/);
  const motion = readFileSync(fileURLToPath(new URL("../src/motion.js", import.meta.url)), "utf8");
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(motion), "文字は textContent だけ");
  assert.ok(!/@keyframes|infinite/.test(motion));
});
