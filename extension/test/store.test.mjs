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
