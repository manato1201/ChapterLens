import { test } from "node:test";
import assert from "node:assert/strict";
import { StoreMod, EngineMod, memoryArea } from "./helpers.mjs";

const Store = StoreMod;

test("store: 章の調整を保存して読み戻せる(境界は昇順に整う)", async () => {
  const area = memoryArea();
  const s = Store.create(area, { now: () => 123 });
  assert.deepEqual(await s.load("abc"), {});
  assert.equal(await s.saveManual("abc", [300, 100.5], [120, 310]), true);
  assert.deepEqual(await s.load("abc"), { manual: { boundaries: [100.5, 300], auto: [120, 310], at: 123 } });
  assert.equal(await s.clearManual("abc"), true);
  assert.deepEqual(await s.load("abc"), {});
});

test("store: ダイジェストの調整と章の調整は、互いを消さない", async () => {
  const s = Store.create(memoryArea());
  await s.saveManual("v1", [100], [90]);
  await s.saveDigest("v1", [{ start: 10, end: 30 }], [{ start: 10, end: 30 }, { start: 50, end: 70 }], 0.3);
  const got = await s.load("v1");
  assert.deepEqual(got.manual.boundaries, [100]);
  assert.deepEqual(got.digest.spans, [{ start: 10, end: 30 }]);
  assert.equal(got.digest.ratio, 0.3);
  await s.clearDigest("v1");
  assert.ok((await s.load("v1")).manual && !(await s.load("v1")).digest);
});

test("store: 不正な入力(動画 ID・時刻・区間)は保存しない", async () => {
  const area = memoryArea();
  const s = Store.create(area);
  for (const id of ["", "a b", "../x", "x".repeat(65), null, undefined]) assert.equal(await s.saveManual(id, [1], [1]), false, String(id));
  for (const bad of [[NaN], [-1], ["5"], [1e9], "x", [Infinity]]) assert.equal(await s.saveManual("ok", bad, []), false, JSON.stringify(bad));
  assert.equal(await s.saveManual("ok", Array.from({ length: 501 }, (_, i) => i + 1), []), false);
  assert.equal(await s.saveDigest("ok", [{ start: 5, end: 5 }], [], 0.2), false);   // 長さ 0
  assert.equal(await s.saveDigest("ok", [{ start: 9, end: 3 }], [], 0.2), false);   // 逆順
  assert.equal(await s.saveDigest("ok", [{ start: 1, end: "9" }], [], 0.2), false);
  assert.deepEqual(Object.keys(area.data), []);                                    // 何も書かれていない
});

test("store: 壊れた保存データ・保存先の失敗は、空として扱う(例外を出さない)", async () => {
  const area = memoryArea({ "chapterlens.v.bad": { manual: { boundaries: "x", auto: [1] }, digest: { spans: [{ start: 3 }], auto: [] } }, "chapterlens.v.str": "oops" });
  const s = Store.create(area);
  assert.deepEqual(await s.load("bad"), {});
  assert.deepEqual(await s.load("str"), {});
  const broken = Store.create({ get: async () => { throw new Error("x"); }, set: async () => { throw new Error("x"); }, remove: async () => { throw new Error("x"); } });
  assert.deepEqual(await broken.load("abc"), {});
  assert.equal(await broken.saveManual("abc", [1], [1]), false);
  assert.equal(await broken.forgetAll(), false);
});

test("store: 動画が maxVideos を超えたら、古いものから消える。読み書きすると新しくなる", async () => {
  const area = memoryArea();
  const s = Store.create(area, { maxVideos: 3 });
  for (const id of ["a", "b", "c"]) await s.saveManual(id, [10], [10]);
  await s.saveManual("a", [20], [10]); // a が最新に
  await s.saveManual("d", [10], [10]); // 4 本目 → 一番古い b が消える
  assert.deepEqual(await s.load("b"), {});
  for (const id of ["a", "c", "d"]) assert.ok((await s.load(id)).manual, id);
  assert.deepEqual(area.data["chapterlens.index"], ["d", "a", "c"]);
});

test("store: forgetAll は、索引にある動画をすべて消す", async () => {
  const area = memoryArea();
  const s = Store.create(area);
  await s.saveManual("a", [10], [10]);
  await s.saveDigest("b", [{ start: 1, end: 9 }], [], 0.2);
  assert.equal(await s.forgetAll(), true);
  assert.deepEqual(Object.keys(area.data), []);
});

// ---- エンジンの呼び出し口 ----
const { createClient, describeError } = EngineMod;

test("engine: 依頼の形(経路・本文)", async () => {
  const sent = [];
  const c = createClient(async (m) => { sent.push(m); return { ok: true, data: {} }; });
  await c.me(); await c.shares("abc_1"); await c.mine();
  await c.publish({ video: "abc_1", boundaries: [10], audience: "team" });
  await c.revoke("abc_1");
  await c.live(null, [{ start: 0, end: 4, text: "x" }], 4);
  await c.live("sess", [], 30);
  await c.userAction("u_0123abcd", "rotate");
  await c.audit(9999);
  assert.deepEqual(sent.map((m) => [m.method, m.path]), [
    ["GET", "/v1/me"], ["GET", "/v1/shares?video=abc_1"], ["GET", "/v1/shares"], ["POST", "/v1/shares"], ["POST", "/v1/shares/revoke"],
    ["POST", "/v1/live"], ["POST", "/v1/live"], ["POST", "/v1/admin/users/u_0123abcd/rotate"], ["GET", "/v1/admin/audit?n=500"],
  ]);
  assert.ok(sent.every((m) => m.target === "background" && m.type === "engine"));
  assert.equal("session" in sent[5].body, false);       // 新しく始めるときは、session を付けない
  assert.equal(sent[6].body.session, "sess");
});

test("engine: 不正な動画 ID・利用者 ID・操作は、送る前に拒否する", () => {
  const c = createClient(async () => { throw new Error("送ってはいけない"); });
  assert.throws(() => c.shares("../etc"), TypeError);
  assert.throws(() => c.shares(""), TypeError);
  assert.throws(() => c.publish({ video: "a b" }), TypeError);
  assert.throws(() => c.revoke("x".repeat(65)), TypeError);
  for (const id of ["", "u_zz", "U_0123abcd", "local/../x", "u_0123abcd/disable"]) assert.throws(() => c.userAction(id, "disable"), TypeError, id);
  assert.throws(() => c.userAction("local", "explode"), TypeError);
});

test("engine: 中継が失敗・無応答でも、例外にせず {ok:false} を返す", async () => {
  const a = await createClient(async () => { throw new Error("Receiving end does not exist"); }).me();
  assert.deepEqual([a.ok, a.code], [false, "relay"]);
  const b = await createClient(async () => undefined).me();
  assert.deepEqual([b.ok, b.code], [false, "relay"]);
});

test("describeError: 原因ごとに、次にすることが分かる説明", () => {
  assert.match(describeError({ ok: false, code: "unconfigured" }), /アイコン/);
  assert.match(describeError({ ok: false, code: "unreachable" }), /起動/);
  assert.match(describeError({ ok: false, code: "origin" }), /allow-origin/);
  assert.match(describeError({ ok: false, status: 401 }), /token/);
  assert.match(describeError({ ok: false, status: 429 }), /少し待/);
  assert.equal(describeError({ ok: false, status: 403, error: "共有は、管理者が無効にしています" }), "共有は、管理者が無効にしています");
  assert.equal(describeError({ ok: true }), "");
});

test("store: 章の調整とダイジェストの保存が同時に走っても、どちらも失われない", async () => {
  const s = Store.create(memoryArea());
  await Promise.all([
    s.saveManual("v1", [100], [90]),
    s.saveDigest("v1", [{ start: 5, end: 20 }], [], 0.2),
    s.saveManual("v2", [50], [50]),
  ]);
  const got = await s.load("v1");
  assert.deepEqual(got.manual.boundaries, [100]);
  assert.deepEqual(got.digest.spans, [{ start: 5, end: 20 }]);
  assert.ok((await s.load("v2")).manual);
});

test("store: 題名と前回の自動の結果(境界+題名)を保存する。壊れた値は読み飛ばす", async () => {
  const area = memoryArea();
  const store = Store.create(area);
  assert.equal(await store.saveTitles("v1", [{ start: 10, title: "  直した題名  " }, { start: 20, title: "" }]), true);
  assert.equal(await store.saveAuto("v1", [100, 200], [{ start: 0, title: "導入" }]), true);
  const got = await store.load("v1");
  assert.deepEqual(got.titles, [{ start: 10, title: "直した題名" }]);
  assert.deepEqual(got.auto.boundaries, [100, 200]);
  assert.equal(await store.saveTitles("v1", [{ start: -1, title: "x" }]), false);
  assert.equal(await store.saveAuto("v1", "bad", []), false);
});

// ---- 題名・大見出し(ローカル LLM)の保存 ----
test("store: 生成した題名と大見出しを保存し、他の保存物(章の調整・直した題名)を壊さない", async () => {
  const store = Store.create(memoryArea());
  assert.equal(await store.saveTitles("v1", [{ start: 10, title: "直した題名" }]), true);
  assert.equal(
    await store.saveGenerated("v1", [{ start: 0, title: "  釣りを始める  " }, { start: 60, title: "魚を売る(6220ベル)" }], [{ heading: "釣り", from: 0, to: 1 }]),
    true,
  );
  const got = await store.load("v1");
  assert.deepEqual(got.generated, {
    titles: [{ start: 0, title: "釣りを始める" }, { start: 60, title: "魚を売る(6220ベル)" }],
    sections: [{ heading: "釣り", from: 0, to: 1 }],
  });
  assert.deepEqual(got.titles, [{ start: 10, title: "直した題名" }]);
});

test("store: 生成の保存の上限と、壊れた値(題名 500・見出し 100・文字列 60 文字)", async () => {
  const store = Store.create(memoryArea());
  const many = Array.from({ length: 501 }, (_, i) => ({ start: i, title: "題名" }));
  assert.equal(await store.saveGenerated("v1", many, []), false);
  const secs = Array.from({ length: 101 }, (_, i) => ({ heading: "見出し", from: i, to: i }));
  assert.equal(await store.saveGenerated("v1", [], secs), false);
  assert.equal(await store.saveGenerated("v1", [{ start: -1, title: "x" }], []), false);
  assert.equal(await store.saveGenerated("v1", [], [{ heading: "見出し", from: 3, to: 1 }]), false);
  assert.equal(await store.saveGenerated("v1", [], [{ heading: "見出し", from: "0", to: 1 }]), false);
  assert.equal(await store.saveGenerated("v1", [], "bad"), false);
  assert.equal(await store.saveGenerated("bad id!", [], []), false);
  assert.equal(await store.saveGenerated("v1", [{ start: 0, title: "あ".repeat(80) }], [{ heading: "い".repeat(80), from: 0, to: 0 }]), true);
  const g = (await store.load("v1")).generated;
  assert.equal(Array.from(g.titles[0].title).length, 60);
  assert.equal(Array.from(g.sections[0].heading).length, 60);
});

test("store: 保存された generated が壊れていたら、読み飛ばす", async () => {
  const area = memoryArea();
  await area.set({ "chapterlens.v.v1": { generated: { titles: "bad", sections: [] } } });
  assert.equal((await Store.create(area).load("v1")).generated, undefined);
});

// ---- エンジンのクライアント(題名・大見出し) ----
test("engine: title / sections は /v1/title・/v1/sections へ POST する。入力の型を検査する", async () => {
  const sent = [];
  const c = createClient(async (m) => { sent.push(m); return { ok: true, data: { title: "x" } }; });
  await c.title("字幕の本文です", "前の題名");
  await c.title("字幕の本文です");
  await c.sections(["a", "b", "c", "d"]);
  assert.deepEqual(sent[0], { target: "background", type: "engine", method: "POST", path: "/v1/title", body: { text: "字幕の本文です", prev_title: "前の題名" } });
  assert.deepEqual(sent[1].body, { text: "字幕の本文です" });
  assert.deepEqual(sent[2], { target: "background", type: "engine", method: "POST", path: "/v1/sections", body: { titles: ["a", "b", "c", "d"] } });
  assert.throws(() => c.title("", ""), TypeError);
  assert.throws(() => c.title(123), TypeError);
  assert.throws(() => c.sections("x"), TypeError);
  assert.throws(() => c.sections([1, 2]), TypeError);
});

test("describeError: 無効(403)・窓口が落ちている(502)は、エンジンの文をそのまま見せる", () => {
  assert.match(describeError({ ok: false, status: 403, error: "題名付け(ローカル LLM)は無効です。管理者が有効にしてください" }), /無効/);
  assert.match(describeError({ ok: false, status: 502, error: "ローカル LLM(窓口)に接続できません。LocalLLMHarness を起動してください(uv run llh serve)" }), /llh serve/);
  assert.match(describeError({ ok: false, status: 502, error: "" }), /エンジン/);
});

// ---- 最終レビューの指摘(I3・I5) ----
test("describeError: 時間切れ(timeout)は、日本語で次にすることを案内する", () => {
  const msg = describeError({ ok: false, code: "timeout", error: "signal is aborted without reason" });
  assert.match(msg, /時間内/);
  assert.doesNotMatch(msg, /aborted/);
});

test("store: 大見出しは、作ったときの章の開始時刻(starts)といっしょに保存・読み出す", async () => {
  const store = Store.create(memoryArea());
  assert.equal(await store.saveGenerated("v1", [{ start: 0, title: "釣りを始める" }], [{ heading: "釣り", from: 0, to: 1 }], [0, 60]), true);
  assert.deepEqual((await store.load("v1")).generated.starts, [0, 60]);
  assert.equal(await store.saveGenerated("v1", [], [], [0, -5]), false); // 壊れた時刻
  assert.equal(await store.saveGenerated("v1", [], [], "bad"), false);
  assert.equal(await store.saveGenerated("v1", [{ start: 0, title: "釣りを始める" }], []), true); // starts は省略できる(見出しが無いとき)
  assert.equal((await store.load("v1")).generated.starts, undefined);
});
