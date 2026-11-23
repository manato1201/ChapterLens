/*
 * テロップ(再生中の動画の上に、今の章の題名と大見出しを文字で重ねる。自分の画面だけ)。
 * 判断(いつ出すか)は純粋な関数、描画は偽の DOM、まとめ(0.5 秒)は偽のタイマーで確かめる。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadContent, threeTopicRows, flush } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const Telop = require("../src/telop.js");

const CH = [
  { start: 0, end: 60, title: "配信開始", section: 0 },
  { start: 60, end: 120, title: "島内放送", section: 0 },
  { start: 120, end: 180, title: "釣り開始", section: 1 },
  { start: 180, end: 240, title: "", section: 1 },
];
const SEC = [{ heading: "朝", from: 0, to: 1 }, { heading: "釣り", from: 2, to: 3 }];

// ---- contentAt ----
test("contentAt: 見出しの最初の章(別の見出しから来た章・最初の表示)には heading が付き、同じ見出しの続きには付かない", () => {
  assert.deepEqual(Telop.contentAt(CH, SEC, 0, -1), { heading: "朝", title: "配信開始" });
  assert.deepEqual(Telop.contentAt(CH, SEC, 1, 0), { heading: null, title: "島内放送" });
  assert.deepEqual(Telop.contentAt(CH, SEC, 2, 1), { heading: "釣り", title: "釣り開始" });
  assert.deepEqual(Telop.contentAt(CH, SEC, 1, 2), { heading: "朝", title: "島内放送" }); // 戻って別の見出しへ
  assert.deepEqual(Telop.contentAt(CH, SEC, 1, undefined), { heading: "朝", title: "島内放送" });
});

test("contentAt: 題名が空・章が無いときは null。sections が無ければ heading は常に null", () => {
  assert.equal(Telop.contentAt(CH, SEC, 3, 2), null);
  assert.equal(Telop.contentAt(CH, SEC, 9, 0), null);
  assert.equal(Telop.contentAt([], SEC, 0, -1), null);
  assert.deepEqual(Telop.contentAt(CH, [], 0, -1), { heading: null, title: "配信開始" });
  assert.deepEqual(Telop.contentAt(CH, undefined, 2, 1), { heading: null, title: "釣り開始" });
});

// ---- decide ----
const st = (o) => ({ mode: "change", lastIdx: 1, adShowing: false, reducedMotion: false, ...o });
test("decide: change は、章が変わったときだけ 4 秒。同じ章では出さない", () => {
  assert.deepEqual(Telop.decide(st(), { idx: 2 }), { show: true, hideAfterMs: 4000 });
  assert.deepEqual(Telop.decide(st(), { idx: 1 }), { show: false, hideAfterMs: null });
});

test("decide: always は消えない。off と広告中は出さない", () => {
  assert.deepEqual(Telop.decide(st({ mode: "always" }), { idx: 1 }), { show: true, hideAfterMs: null });
  assert.equal(Telop.decide(st({ mode: "off" }), { idx: 2 }).show, false);
  assert.equal(Telop.decide(st({ adShowing: true }), { idx: 2 }).show, false);
  assert.equal(Telop.decide(st({ mode: "always", adShowing: true }), { idx: 2 }).show, false);
});

// ---- create(描画) ----
function fakeEl(tag) {
  return { tag, style: {}, children: [], className: "", textContent: "", parent: null, append(...n) { for (const x of n) { x.parent = this; this.children.push(x); } }, remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; } };
}
function fakeEnv() {
  const doc = { createElement: fakeEl };
  const player = fakeEl("div"); player.clientWidth = 1280;
  const timers = [];
  const setT = (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; };
  const clearT = (id) => { if (timers[id - 1]) timers[id - 1].live = false; };
  const fire = (ms) => { for (const t of timers) if (t.live && t.ms === ms) { t.live = false; t.fn(); } };
  return { doc, player, timers, setT, clearT, fire };
}

test("create: 要素は 1 つだけ(何度 show しても増えない)・クリックを通す・右上・白地黒の太字", () => {
  const e = fakeEnv();
  const v = Telop.create(e.doc, e.player, { setTimeout: e.setT, clearTimeout: e.clearT, raf: (f) => f() });
  v.show({ heading: "朝", title: "配信開始" }, { hideAfterMs: 4000 });
  v.show({ heading: null, title: "島内放送" }, { hideAfterMs: 4000 });
  assert.equal(e.player.children.length, 1);
  const el = e.player.children[0];
  assert.match(el.style.cssText, /pointer-events:\s*none/);
  assert.match(el.style.cssText, /right:/);
  const box = el.children.map((c) => c.style.cssText).join("");
  assert.match(box, /background:\s*#fff/);
  assert.match(box, /color:\s*#000/);
  assert.match(box, /font-weight:\s*900/);
});

test("create: テキストは textContent で入れる(題名に HTML が入っても、要素は増えない)", () => {
  const e = fakeEnv();
  const v = Telop.create(e.doc, e.player, { setTimeout: e.setT, clearTimeout: e.clearT, raf: (f) => f() });
  v.show({ heading: "<b>見出し</b>", title: "<img src=x onerror=alert(1)>" }, { hideAfterMs: 4000 });
  const el = e.player.children[0];
  assert.equal(el.children.length, 2);
  assert.equal(el.children[1].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(el.children[0].textContent, "<b>見出し</b>");
  assert.ok(el.children.every((c) => c.children.length === 0));
});

test("create: heading が無いときは見出しの行を隠す。hideAfterMs 後に消える。destroy で取り除く", () => {
  const e = fakeEnv();
  const v = Telop.create(e.doc, e.player, { setTimeout: e.setT, clearTimeout: e.clearT, raf: (f) => f() });
  v.show({ heading: null, title: "島内放送" }, { hideAfterMs: 4000 });
  const el = e.player.children[0];
  assert.equal(el.children[0].style.display, "none");
  assert.equal(el.style.opacity, "1");
  e.fire(4000);
  assert.equal(el.style.opacity, "0");
  v.show({ heading: "朝", title: "配信開始" }, { hideAfterMs: 4000 });
  assert.equal(el.children[0].style.display, "block");
  v.destroy();
  assert.equal(e.player.children.length, 0);
});

test("create: 2 回目の show で、前の「消える」予約を取り消す(古い予約で新しい題名が消えない)", () => {
  const e = fakeEnv();
  const v = Telop.create(e.doc, e.player, { setTimeout: e.setT, clearTimeout: e.clearT, raf: (f) => f() });
  v.show({ heading: null, title: "一つめの題名" }, { hideAfterMs: 4000 });
  v.show({ heading: null, title: "二つめの題名" }, { hideAfterMs: 4000 });
  assert.equal(e.timers.filter((t) => t.live && t.ms === 4000).length, 1);
});

test("create: reducedMotion では、移動の動きを付けない(透明度だけ)", () => {
  const e = fakeEnv();
  const v = Telop.create(e.doc, e.player, { setTimeout: e.setT, clearTimeout: e.clearT, raf: (f) => f() });
  const transforms = [];
  v.show({ heading: null, title: "動かない題名です" }, { hideAfterMs: 4000, reducedMotion: true });
  const el = e.player.children[0];
  transforms.push(el.style.transform);
  assert.ok(transforms.every((t) => !t || t === "none"), String(transforms));
  assert.match(el.style.transition || "", /opacity/);
  assert.doesNotMatch(el.style.transition || "", /transform/);
});

test("create: 常に出すモード(persistent)は、消える予約をしない", () => {
  const e = fakeEnv();
  const v = Telop.create(e.doc, e.player, { setTimeout: e.setT, clearTimeout: e.clearT, raf: (f) => f() });
  v.show({ heading: null, title: "ずっと出る題名" }, { hideAfterMs: null, persistent: true });
  assert.equal(e.timers.filter((t) => t.live).length, 0);
});

// ---- createTracker(まとめ・広告・モード) ----
function trackerEnv(over = {}) {
  const e = fakeEnv();
  const shows = [], hides = [];
  const view = { show: (c, o) => shows.push([c, o]), hide: () => hides.push(1), destroy() {} };
  const s = { idx: 0, mode: "change", ad: false, ...over };
  const tr = Telop.createTracker({
    view, getIdx: () => s.idx, getChapters: () => CH, getSections: () => SEC, getMode: () => s.mode,
    isAdShowing: () => s.ad, isReducedMotion: () => false, setTimeout: e.setT, clearTimeout: e.clearT,
  });
  return { e, s, tr, shows, hides };
}

test("tracker: 章が変わると、0.5 秒待って 1 回だけ出す。同じ章の timeupdate では、タイマーを作り直さない", () => {
  const { e, s, tr, shows } = trackerEnv();
  s.idx = 1;
  for (let i = 0; i < 10; i++) tr.onTime(); // 再生中の timeupdate(約 4 回/秒)
  assert.equal(e.timers.length, 1, "待ちのタイマーは 1 つだけ");
  assert.equal(shows.length, 0);
  e.fire(500);
  assert.equal(shows.length, 1);
  assert.deepEqual(shows[0][0], { heading: "朝", title: "島内放送" }); // 最初の表示なので、見出しも付く
  assert.equal(shows[0][1].hideAfterMs, 4000);
  for (let i = 0; i < 10; i++) tr.onTime();
  e.fire(500);
  assert.equal(shows.length, 1, "同じ章では、再表示しない");
});

test("tracker: 章の境界で行き来するシーク(0.1 秒おき)は、最後に落ち着いた章を 1 回だけ出す", () => {
  const { e, s, tr, shows } = trackerEnv();
  s.idx = 1; tr.onTime(); e.fire(500); // 章 1 を表示済み
  shows.length = 0;
  for (const i of [2, 1, 2, 1, 2, 1, 2]) { s.idx = i; tr.onTime(); }
  e.fire(500);
  assert.equal(shows.length, 1);
  assert.equal(shows[0][0].title, "釣り開始");
});

test("tracker: 落ち着く前に元の章へ戻ったら、何も出さない", () => {
  const { e, s, tr, shows } = trackerEnv();
  s.idx = 1; tr.onTime(); e.fire(500);
  shows.length = 0;
  s.idx = 2; tr.onTime();
  s.idx = 1; tr.onTime();
  e.fire(500);
  assert.equal(shows.length, 0);
});

test("tracker: 広告中・off では出さない。off から戻したら、次の変化で出る", () => {
  const { e, s, tr, shows } = trackerEnv();
  s.idx = 1; s.ad = true; tr.onTime(); e.fire(500);
  assert.equal(shows.length, 0);
  s.ad = false; s.mode = "off"; tr.onTime(); e.fire(500);
  assert.equal(shows.length, 0);
  s.mode = "change"; tr.onTime(); e.fire(500);
  assert.equal(shows.length, 1);
});

test("tracker: 題名の無い章(null)は出さず、表示中のものを消す。reset で状態を戻し、hide する", () => {
  const { e, s, tr, shows, hides } = trackerEnv();
  s.idx = 3; tr.onTime(); e.fire(500);
  assert.equal(shows.length, 0);
  assert.ok(hides.length >= 1);
  s.idx = 1; tr.onTime(); e.fire(500);
  assert.equal(shows.length, 1);
  tr.reset();
  s.idx = 1; tr.onTime(); e.fire(500);
  assert.equal(shows.length, 2, "reset の後は、同じ章でも、もう一度出る");
});

test("tracker: always は、章が変わるたびに内容を更新し、消えない", () => {
  const { e, s, tr, shows } = trackerEnv({ mode: "always" });
  s.idx = 1; tr.onTime(); e.fire(500);
  s.idx = 2; tr.onTime(); e.fire(500);
  assert.equal(shows.length, 2);
  assert.ok(shows.every(([, o]) => o.hideAfterMs === null && o.persistent === true));
});

// ---- content.js との結び付き ----
test("content: 章が変わると、題名のテロップを出す。動画が変わると消す。モードは保存される", async () => {
  const shows = [], hides = [];
  const view = { show: (c, o) => shows.push([JSON.parse(JSON.stringify(c)), o]), hide: () => hides.push(1), destroy() {} };
  const page = loadContent({ rows: threeTopicRows(), duration: 600, granularity: "fine", telop: { ...Telop, create: () => view }, player: { classList: { contains: () => false } } });
  await page.ready();
  await page.handlers.onRun();
  await flush();
  page.video.currentTime = 250; // 2 つ目の話題の中
  page.video.dispatchEvent(new Event("timeupdate"));
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(shows.length, 1);
  assert.ok(typeof shows[0][0].title === "string" && shows[0][0].title.length > 0);
  page.handlers.onTelopMode("off");
  await flush();
  assert.equal((await page.area.get("chapterlens.telop"))["chapterlens.telop"], "off");
  page.navigate("vid2");
  await flush();
  assert.ok(hides.length >= 1);
});

// ---- 最終レビューの指摘(I4: 広告中は消す) ----
test("tracker: 表示中に広告が始まったら、すぐ消す。広告が明けたら、いまの章をあらためて出す", () => {
  const { e, s, tr, shows, hides } = trackerEnv({ mode: "always" });
  s.idx = 1; tr.onTime(); e.fire(500);
  assert.equal(shows.length, 1);
  const hidesBefore = hides.length;
  s.ad = true; tr.onTime(); // 同じ章のまま、広告が始まった
  assert.equal(hides.length, hidesBefore + 1, "広告が始まったら消す");
  tr.onTime(); tr.onTime();
  assert.equal(shows.length, 1, "広告中は出さない");
  s.ad = false; tr.onTime(); e.fire(500);
  assert.equal(shows.length, 2, "広告が明けたら、いまの章を出し直す");
});

test("tracker: 「章の切り替え」でも、表示中の広告開始で消える(4 秒の残りが広告に重ならない)", () => {
  const { e, s, tr, shows, hides } = trackerEnv();
  s.idx = 1; tr.onTime(); e.fire(500);
  assert.equal(shows.length, 1);
  const hidesBefore = hides.length;
  s.ad = true; tr.onTime();
  assert.equal(hides.length, hidesBefore + 1);
});
