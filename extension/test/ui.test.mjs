import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { makeDoc, buttons, buttonByText } from "./fakedom.mjs";

const require = createRequire(import.meta.url);
const UI = require("../src/ui.js");
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function panel() {
  const doc = makeDoc();
  const calls = [];
  const handlers = new Proxy({}, { get: (_, name) => (...a) => calls.push([name, ...a]) });
  const api = UI.createPanel(doc, [{ key: "coarse", label: "粗い" }, { key: "fine", label: "細かい" }], handlers);
  const shadow = api.host.shadow;
  const views = shadow.all((n) => n.getAttribute("role") === "tabpanel");
  return { doc, api, calls, shadow, views, [Symbol.for("x")]: 1 };
}
const view = (p, label) => p.views.find((v) => v.getAttribute("aria-label") === label);

test("ui: 初期状態は 3 つのタブ(目次が選択)・パネルは閉じている・ダイジェストと共有は案内を出す", () => {
  const p = panel();
  const tabs = p.shadow.all((n) => n.getAttribute("role") === "tab");
  assert.deepEqual(tabs.map((t) => t.textContent), ["目次", "ダイジェスト", "共有"]);
  assert.deepEqual(tabs.map((t) => t.getAttribute("aria-selected")), ["true", "false", "false"]);
  assert.deepEqual(p.views.map((v) => v.hidden), [false, true, true]);
  assert.equal(p.api.isOpen(), false);
  assert.match(view(p, "ダイジェスト").textContent, /章ができてから/);
});

test("ui: タブを切り替えると、表示・aria-selected・onTab が変わる", () => {
  const p = panel();
  buttonByText(p.shadow, "ダイジェスト").click();
  assert.deepEqual(p.views.map((v) => v.hidden), [true, false, true]);
  assert.equal(buttonByText(p.shadow, "ダイジェスト").getAttribute("aria-selected"), "true");
  assert.deepEqual(p.calls.at(-1), ["onTab", "digest"]);
  p.api.setTab("nonexistent"); // 知らないタブは無視
  assert.deepEqual(p.views.map((v) => v.hidden), [true, false, true]);
});

test("ui: 章の一覧 — クリックで onSeek、調整ボタンは 2 番目以降にだけ・押すと番号つきで通知、暫定は「仮」", () => {
  const p = panel();
  const chapters = [{ start: 0, title: "導入" }, { start: 125, title: "第二" }, { start: 300, title: "" }];
  p.api.setChapters(chapters, fmt, { editable: true, tentative: [2] });
  const rows = view(p, "目次").all((n) => n.tagName === "LI");
  assert.equal(rows.length, 3);
  assert.equal(buttons(rows[0]).length, 1);                    // 先頭の章には調整ボタンがない
  assert.equal(buttons(rows[1]).length, 4);                    // 章ボタン + −5 + +5 + ×
  buttons(rows[1])[0].click();
  assert.deepEqual(p.calls.at(-1), ["onSeek", 125]);
  buttons(rows[1])[1].click(); assert.deepEqual(p.calls.at(-1), ["onChapterNudge", 1, -5]);
  buttons(rows[1])[2].click(); assert.deepEqual(p.calls.at(-1), ["onChapterNudge", 1, 5]);
  buttons(rows[1])[3].click(); assert.deepEqual(p.calls.at(-1), ["onChapterRemove", 1]);
  assert.ok(rows[2].textContent.includes("仮"));               // 暫定
  assert.ok(!rows[1].textContent.includes("仮"));
  assert.ok(rows[2].textContent.includes("チャプター"));        // 題名が空のときの代わり
});

test("ui: 調整できない(editable:false)ときは、調整ボタンも「章を足す」も使えない", () => {
  const p = panel();
  p.api.setChapters([{ start: 0, title: "a" }, { start: 60, title: "b" }], fmt, { editable: false });
  const rows = view(p, "目次").all((n) => n.tagName === "LI");
  assert.equal(buttons(rows[1]).length, 1);
  const add = buttonByText(p.shadow, "いまの位置に章を足す");
  assert.equal(add.disabled, true);
  add.click();
  assert.ok(!p.calls.some((c) => c[0] === "onChapterAdd"));
  p.api.setChapters([{ start: 0, title: "a" }], fmt, { editable: true });
  assert.equal(add.disabled, false);
  add.click();
  assert.deepEqual(p.calls.at(-1), ["onChapterAdd"]);
});

test("ui: 「自動に戻す」は、調整があるときだけ出る", () => {
  const p = panel();
  const reset = buttonByText(p.shadow, "自動に戻す");
  assert.equal(reset.hidden, true);
  p.api.setManual(true);
  assert.equal(reset.hidden, false);
  reset.click();
  assert.deepEqual(p.calls.at(-1), ["onManualReset"]);
});

test("ui: ダイジェスト — オン/オフ・割合・区間のチェック・足す・戻す", () => {
  const p = panel();
  const spans = [{ start: 10, end: 40, on: true, timeLabel: "0:10–0:40", label: "はじめに" }, { start: 100, end: 130, on: false, timeLabel: "1:40–2:10", label: "外した" }];
  p.api.setDigest({ supported: true, enabled: false, ratio: 0.2, spans, summary: "1 区間・合計 0:30(動画の 5%)", adjusted: true });
  const v = view(p, "ダイジェスト");
  const toggle = buttonByText(v, "ダイジェスト再生: オフ");
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  toggle.click();
  assert.deepEqual(p.calls.at(-1), ["onDigestToggle", true]);
  const ratios = ["10%", "20%", "30%"].map((t) => buttonByText(v, t));
  assert.deepEqual(ratios.map((b) => b.getAttribute("aria-pressed")), ["false", "true", "false"]);
  ratios[2].click();
  assert.deepEqual(p.calls.at(-1), ["onDigestRatio", 0.3]);
  const boxes = v.all((n) => n.tagName === "INPUT");
  assert.deepEqual(boxes.map((b) => b.checked), [true, false]);
  boxes[1].dispatch("change");
  assert.deepEqual(p.calls.at(-1), ["onSpanToggle", 1]);
  const rows = v.all((n) => n.tagName === "LI");
  assert.ok(rows[1].className.includes("off"));
  buttons(rows[0]).find((b) => b.textContent.includes("0:10")).click();
  assert.deepEqual(p.calls.at(-1), ["onSeek", 10]);
  buttonByText(v, "いまの位置から 15 秒を足す").click();
  assert.deepEqual(p.calls.at(-1), ["onSpanAdd"]);
  buttonByText(v, "自動案に戻す").click();
  assert.deepEqual(p.calls.at(-1), ["onDigestReset"]);
  assert.ok(v.textContent.includes("動画は切り出しません"));
  p.api.setDigest({ supported: true, enabled: true, ratio: 0.2, spans, summary: "", adjusted: false });
  assert.equal(buttonByText(view(p, "ダイジェスト"), "自動案に戻す"), undefined);          // 調整がなければ戻すボタンは出ない
  assert.ok(buttonByText(view(p, "ダイジェスト"), "ダイジェスト再生: オン"));
});

test("ui: 共有 — 公開(共有先・題名の選択を渡す)・取り下げ・他の人の章立て(重ねる・使う)", () => {
  const p = panel();
  p.api.setShare({
    note: "alice(u_aaaaaaaa・利用者)\n共有範囲: 全員", canPublish: true, mode: "team", mine: true,
    shares: [{ from: "bob", count: 3, mine: false, overlay: false }, { from: "alice", count: 4, mine: true, overlay: false }],
  });
  const v = view(p, "共有");
  assert.ok(v.textContent.includes("alice"));
  const inputs = v.all((n) => n.tagName === "INPUT");
  const [audience, titles] = inputs;
  audience.value = "u_bbbbbbbb";
  titles.checked = true;
  buttonByText(v, "この動画の章を共有する").click();
  assert.deepEqual(p.calls.at(-1), ["onSharePublish", { audience: "u_bbbbbbbb", withTitles: true }]);
  buttonByText(v, "取り下げる").click();
  assert.deepEqual(p.calls.at(-1), ["onShareRevoke"]);
  const rows = v.all((n) => n.tagName === "LI");
  assert.equal(rows.length, 2);
  assert.ok(rows[0].textContent.includes("bob: 3 章") && rows[1].textContent.includes("alice: 4 章(あなた)"));
  assert.equal(buttons(rows[1]).length, 0);                                // 自分の共有には、重ねる・使うは出ない
  buttons(rows[0])[0].click(); assert.deepEqual(p.calls.at(-1), ["onShareOverlay", 0, true]);
  buttons(rows[0])[1].click(); assert.deepEqual(p.calls.at(-1), ["onShareAdopt", 0]);
  buttonByText(v, "更新").click();
  assert.deepEqual(p.calls.at(-1), ["onShareRefresh"]);
});

test("ui: 共有できないとき(canPublish:false)は、公開の入力も出さない。エラー表示は error クラス", () => {
  const p = panel();
  p.api.setShare({ note: "token が違います", error: true, canPublish: false, shares: [] });
  const v = view(p, "共有");
  assert.equal(v.all((n) => n.tagName === "INPUT").length, 0);
  assert.equal(buttonByText(v, "この動画の章を共有する"), undefined);
  assert.ok(v.all((n) => n.className.includes("error")).length >= 1);
});

test("ui: 利用者や字幕に由来する文字は、HTML として解釈されず、文字としてだけ入る", () => {
  const p = panel();
  const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  p.api.setChapters([{ start: 0, title: evil }, { start: 60, title: evil }], fmt, { editable: true });
  p.api.setDigest({ supported: true, enabled: false, ratio: 0.2, spans: [{ start: 1, end: 9, on: true, timeLabel: "0:01–0:09", label: evil }], summary: evil, adjusted: false });
  p.api.setShare({ note: evil, canPublish: false, shares: [{ from: evil, count: 2, mine: false, overlay: false }] });
  p.api.setStatus(evil);
  assert.ok(!p.doc.created.includes("img") && !p.doc.created.includes("script"));
  assert.ok(p.shadow.textContent.includes(evil));
});

test("ui: マウントとテーマ — mount で文書に付き、unmount で外れる。dark 属性でダーク", () => {
  const p = panel();
  p.api.mount();
  assert.equal(p.api.host.parent, p.doc.body);
  p.api.open();
  assert.equal(p.api.isOpen(), true);
  p.api.close();
  assert.equal(p.api.isOpen(), false);
  p.api.unmount();
  assert.equal(p.api.host.parent, null);
  p.doc.dark = true;
  p.api.mount();
  p.api.open();
  assert.ok(p.shadow.all((n) => n.className.split(" ").includes("wrap"))[0].className.includes("dark"));
});

test("ui: 共有の入力(共有先・題名のチェック)は、「重ねる」などの再描画で消えない", () => {
  const p = panel();
  const shares = [{ from: "bob", count: 3, mine: false, overlay: false }];
  p.api.setShare({ note: "x", canPublish: true, mode: "team", mine: false, shares });
  let [audience, titles] = view(p, "共有").all((n) => n.tagName === "INPUT");
  audience.value = "u_bbbbbbbb";
  audience.dispatch("input");
  titles.checked = true;
  titles.dispatch("change");
  p.api.setShare({ note: "y", canPublish: true, mode: "team", mine: false, shares: [{ ...shares[0], overlay: true }] }); // 再描画
  [audience, titles] = view(p, "共有").all((n) => n.tagName === "INPUT");
  assert.equal(audience.value, "u_bbbbbbbb");
  assert.equal(titles.checked, true);
});

test("ui: 動画 ID を渡すと、章の行にサムネイル(i.ytimg.com)が付く。不正な ID は無視する", () => {
  const p = panel();
  p.api.setVideoId("dQw4w9WgXcQ");
  p.api.setChapters([{ start: 0, title: "はじめに" }, { start: 60, title: "つづき" }], fmt, { editable: false });
  const imgs = p.shadow.all((n) => n.tagName === "IMG");
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].getAttribute("src"), "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
  p.api.setVideoId('x"><script>');
  p.api.setChapters([{ start: 0, title: "はじめに" }], fmt, { editable: false });
  assert.equal(p.shadow.all((n) => n.tagName === "IMG").length, 0); // 形の合わない ID では、画像を作らない
});

test("ui: たたむボタンで、タブと中身が隠れ、もう一度で戻る(右の列に組み込んだときの操作)", () => {
  const p = panel();
  p.api.mount();
  const wrap = p.shadow.all((n) => n.className.split(" ").includes("wrap"))[0];
  p.api.toggleCollapse();
  assert.ok(wrap.classList.contains("collapsed"));
  p.api.toggleCollapse();
  assert.ok(!wrap.classList.contains("collapsed"));
});
