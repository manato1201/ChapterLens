/*
 * 新機能(CH3b〜CH5)の流れ: エンジンの API 中継(background)・章の調整・ダイジェスト・共有・ライブ。
 * 偽の chrome / DOM / エンジンの上で、content.js と background.js を実際に動かす(helpers.mjs)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBackground, loadContent, threeTopicRows, chunkCues, flush, clone } from "./helpers.mjs";

const CFG = { "chapterlens.engine": { url: "http://127.0.0.1:8787", token: "tok-123", language: "auto" } };
const okRes = (data, status = 200) => ({ ok: true, status, json: async () => data, headers: { get: () => null } });
const errRes = (status, data, headers = {}) => ({ ok: false, status, json: async () => data, headers: { get: (k) => headers[k] ?? null } });
const call = (method, path, body) => ({ target: "background", type: "engine", method, path, body });

// ================= background: エンジンの API 中継 =================
test("relay: 設定が無ければ unconfigured を返し、何も送らない", async () => {
  const { st, send } = loadBackground();
  assert.deepEqual(await send(call("GET", "/v1/me")), { ok: false, code: "unconfigured" });
  assert.equal(st.fetches.length, 0);
});

test("relay: 送り先が 127.0.0.1 以外の設定なら、送らずに拒否する(token も渡さない)", async () => {
  for (const url of ["http://example.com:8787", "https://127.0.0.1:8787", "http://localhost:8787", "http://127.0.0.1:8787/x", "http://user:pw@127.0.0.1:8787"]) {
    const { st, send } = loadBackground({ storage: { "chapterlens.engine": { url, token: "tok" } } });
    const res = await send(call("GET", "/v1/me"));
    assert.equal(res.code, "bad-url", url);
    assert.equal(st.fetches.length, 0, url);
  }
});

test("relay: 許可した経路は、token つきで 127.0.0.1 へ(リダイレクト・Cookie なし)。結果をそのまま返す", async () => {
  const { st, send } = loadBackground({ storage: CFG, fetchImpl: async () => okRes({ user: { id: "local" } }) });
  const res = await send(call("GET", "/v1/me"));
  assert.deepEqual([res.ok, res.status, res.data.user.id], [true, 200, "local"]);
  const f = st.fetches[0];
  assert.equal(f.url, "http://127.0.0.1:8787/v1/me");
  assert.equal(f.opts.headers.Authorization, "Bearer tok-123");
  assert.deepEqual([f.opts.method, f.opts.redirect, f.opts.credentials, f.opts.cache], ["GET", "error", "omit", "no-store"]);
  assert.equal(f.opts.body, undefined);
  assert.ok(!("Content-Type" in f.opts.headers));
});

test("relay: POST は JSON の本文と Content-Type を付ける", async () => {
  const { st, send } = loadBackground({ storage: CFG, fetchImpl: async () => okRes({ shared: true }) });
  await send(call("POST", "/v1/shares", { video: "abc", boundaries: [10] }));
  const f = st.fetches[0];
  assert.equal(f.opts.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(f.opts.body), { video: "abc", boundaries: [10] });
});

test("relay: 許可リストにない経路・メソッド・形は、送らずに forbidden", async () => {
  const { st, send } = loadBackground({ storage: CFG });
  const bad = [
    ["POST", "/v1/transcribe"], ["POST", "/v1/detect"], ["POST", "/v1/corrections"], ["GET", "/v1/health"],
    ["GET", "/v1/live"], ["POST", "/v1/me"], ["DELETE", "/v1/me"], ["GET", "/v1/shares?video=../x"], ["GET", "/v1/shares?video="],
    ["GET", "/v1/shares?video=a&x=1"], ["POST", "/v1/admin/users/x/disable"], ["POST", "/v1/admin/users/u_0123abcd/explode"],
    ["POST", "/v1/admin/users/u_0123abcd/disable/extra"], ["GET", "/v1/admin/audit?n=abcd"], ["GET", "//evil.com/v1/me"], ["GET", "http://evil.com/v1/me"],
    ["GET", "/v1/me/../admin/users"], ["", ""],
  ];
  for (const [m, p] of bad) assert.equal((await send(call(m, p))).code, "forbidden", `${m} ${p}`);
  assert.equal(st.fetches.length, 0);
});

test("relay: この拡張の外(sender.id が違う・無い)からは呼べない", async () => {
  const { st, send } = loadBackground({ storage: CFG });
  assert.equal((await send(call("GET", "/v1/me"), { id: "other-extension" })).code, "forbidden");
  assert.equal((await send(call("GET", "/v1/me"), null)).code, "forbidden");
  assert.equal(st.fetches.length, 0);
});

test("relay: HTTP エラーは status と説明を返し、429 は Retry-After も返す", async () => {
  let reply = errRes(403, { error: "管理者だけが使えます" });
  const { send } = loadBackground({ storage: CFG, fetchImpl: async () => reply });
  assert.deepEqual(await send(call("GET", "/v1/admin/users")), { ok: false, status: 403, error: "管理者だけが使えます", retryAfter: null });
  reply = errRes(429, { error: "多すぎます" }, { "Retry-After": "7" });
  assert.equal((await send(call("GET", "/v1/me"))).retryAfter, "7");
  reply = { ok: false, status: 500, json: async () => { throw new Error("not json"); }, headers: { get: () => null } };
  assert.equal((await send(call("GET", "/v1/me"))).status, 500); // 本文が JSON でなくても例外にしない
});

test("relay: 接続できない・時間切れは、code で区別して返す(例外にしない)", async () => {
  let err = new TypeError("Failed to fetch");
  const { send } = loadBackground({ storage: CFG, fetchImpl: async () => { throw err; } });
  assert.equal((await send(call("GET", "/v1/me"))).code, "unreachable");
  err = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal((await send(call("GET", "/v1/me"))).code, "timeout");
});

test("relay: 大きすぎる本文は送らない", async () => {
  const { st, send } = loadBackground({ storage: CFG });
  const res = await send(call("POST", "/v1/live", { cues: [{ text: "x".repeat(7 * 1024 * 1024) }] }));
  assert.equal(res.code, "too-large");
  assert.equal(st.fetches.length, 0);
});

// ================= content: 章の調整 =================
async function readyPage(opts = {}) {
  const page = loadContent({ rows: threeTopicRows(), duration: 600, granularity: "fine", ...opts });
  await page.ready();
  await page.handlers.onRun();
  await flush();
  return page;
}
const lastChapters = (page) => page.ui.chapters.at(-1);
const savedKey = (id = "vid1") => `chapterlens.v.${id}`;

test("調整: 字幕から章ができ、編集できる状態になる", async () => {
  const page = await readyPage();
  const ch = lastChapters(page);
  assert.ok(ch.length >= 3, `章 ${ch.length}`);
  assert.equal(page.ui.chapterOpts.at(-1).editable, true);
  const near = (t) => ch.some((c) => Math.abs(c.start - t) <= 15);
  assert.ok(near(200) && near(400), ch.map((c) => c.start).join()); // 話題の切り替え(200・400 秒)の近くに境界がある
});

test("調整: 境界を消す・動かす・足す。直した結果は保存され、自動に戻せる", async () => {
  const page = await readyPage();
  const before = lastChapters(page).map((c) => c.start);
  const n = before.length;
  page.handlers.onChapterRemove(1);
  assert.equal(lastChapters(page).length, n - 1);
  assert.equal(page.ui.manual.at(-1), true);
  await flush();
  const saved = page.area.data[savedKey()].manual;
  assert.equal(saved.boundaries.length, n - 2);
  assert.ok(saved.auto.length >= n - 1);                         // 元の自動の境界も残す(何を直したか分かる)

  const first = lastChapters(page)[1].start;
  page.handlers.onChapterNudge(1, 5);
  assert.equal(lastChapters(page)[1].start, first + 5);

  page.video.currentTime = 123;
  page.handlers.onChapterAdd();
  assert.ok(lastChapters(page).some((c) => c.start === 123));

  page.handlers.onManualReset();
  assert.deepEqual(lastChapters(page).map((c) => c.start), before);
  assert.equal(page.ui.manual.at(-1), false);
  await flush();
  assert.equal(page.area.data[savedKey()].manual, undefined);
});

test("調整: できない直し方(近すぎ)は、章を変えずに理由を出す", async () => {
  const page = await readyPage();
  const before = JSON.stringify(lastChapters(page).map((c) => c.start));
  page.video.currentTime = lastChapters(page)[1].start + 2; // 既存の境界に近すぎる
  page.handlers.onChapterAdd();
  assert.equal(JSON.stringify(lastChapters(page).map((c) => c.start)), before);
  assert.equal(page.ui.status.at(-1).kind, "error");
  page.handlers.onChapterNudge(1, -1000);
  assert.equal(JSON.stringify(lastChapters(page).map((c) => c.start)), before);
});

test("調整: 直した章がある間は粒度を変えられない(黙って捨てない)", async () => {
  const page = await readyPage();
  page.handlers.onChapterRemove(1);
  const n = lastChapters(page).length;
  page.handlers.onGranularity("coarse");
  assert.equal(lastChapters(page).length, n);
  assert.match(page.ui.status.at(-1).t, /自動に戻す/);
});

test("調整: 次に同じ動画を開くと、保存した章立てで始まる", async () => {
  const page1 = await readyPage();
  page1.handlers.onChapterRemove(1);
  await flush();
  const expected = lastChapters(page1).map((c) => c.start);
  const page2 = await readyPage({ storage: { [savedKey()]: page1.area.data[savedKey()] } });
  assert.deepEqual(lastChapters(page2).map((c) => c.start), expected);
  assert.equal(page2.ui.manual.at(-1), true);
});

test("調整: 別の動画に移ると、調整は持ち越さない", async () => {
  const page = await readyPage();
  page.handlers.onChapterRemove(1);
  page.navigate("vid2");
  assert.deepEqual(lastChapters(page), []);
  assert.equal(page.ui.manual.at(-1), false);
  page.handlers.onChapterRemove(1); // 字幕が無いので、何も起きずにエラー表示
  assert.equal(page.ui.status.at(-1).kind, "error");
});

// ================= content: ダイジェスト =================
test("ダイジェスト: 字幕を読むと、区間の一覧と合計が出る。字幕が無いうちは使えない理由を出す", async () => {
  const fresh = loadContent({ rows: threeTopicRows() });
  await fresh.ready();
  assert.equal(fresh.ui.digest.at(-1).supported, false);
  assert.match(fresh.ui.digest.at(-1).reason, /目次/);
  const page = await readyPage();
  const d = page.ui.digest.at(-1);
  assert.equal(d.supported, true);
  assert.ok(d.spans.length >= 3 && d.spans.every((s) => s.on && s.end > s.start && s.timeLabel.includes("–")));
  assert.match(d.summary, /区間・合計/);
  assert.equal(d.adjusted, false);
});

test("ダイジェスト: 区間を外す・足す・戻す。調整すると一致率が出て、保存される", async () => {
  const page = await readyPage();
  const n = page.ui.digest.at(-1).spans.length;
  page.handlers.onSpanToggle(0);
  let d = page.ui.digest.at(-1);
  assert.equal(d.spans.length, n);                       // 外した区間も、一覧には残る(戻せる)
  assert.equal(d.spans[0].on, false);
  assert.equal(d.spans.filter((s) => s.on).length, n - 1);
  assert.match(d.summary, /自動案との一致 \d+%/);
  assert.equal(d.adjusted, true);
  await flush();
  assert.ok(page.area.data[savedKey()].digest.spans.length <= n - 1);

  page.video.currentTime = 550;
  page.handlers.onSpanAdd();
  d = page.ui.digest.at(-1);
  assert.ok(d.spans.some((s) => s.on && s.start === 550 && s.end === 565));

  page.handlers.onSpanToggle(d.spans.findIndex((s) => s.start === 550)); // 足した区間を外す
  assert.ok(!page.ui.digest.at(-1).spans.some((s) => s.on && s.start === 550));

  page.handlers.onDigestReset();
  d = page.ui.digest.at(-1);
  assert.equal(d.adjusted, false);
  assert.equal(d.spans.filter((s) => s.on).length, n);
  await flush();
  assert.equal(page.area.data[savedKey()].digest, undefined);
});

test("ダイジェスト: 割合を変えると、自動案を作り直し、それまでの調整は破棄する", async () => {
  const page = await readyPage();
  page.handlers.onSpanToggle(0);
  const small = page.ui.digest.at(-1).spans.filter((s) => s.on).reduce((a, s) => a + s.end - s.start, 0);
  page.handlers.onDigestRatio(0.3);
  const d = page.ui.digest.at(-1);
  assert.equal(d.ratio, 0.3);
  assert.equal(d.adjusted, false);
  assert.ok(d.spans.reduce((a, s) => a + s.end - s.start, 0) > small);
  page.handlers.onDigestRatio(0.9); // 範囲外は無視
  assert.equal(page.ui.digest.at(-1).ratio, 0.3);
});

test("ダイジェスト: オンにすると区間の外を飛ばす。最後の区間の後ろで自動的にオフになる", async () => {
  const page = await readyPage();
  const spans = page.ui.digest.at(-1).spans.filter((s) => s.on);
  page.video.currentTime = 0;
  page.handlers.onDigestToggle(true);
  assert.equal(page.ui.digest.at(-1).enabled, true);
  if (spans[0].start > 0.05) assert.equal(page.video.currentTime, spans[0].start); // すぐ最初の区間の頭へ
  // 区間の中は、そのまま再生
  const mid = (spans[0].start + spans[0].end) / 2;
  page.video.currentTime = mid;
  page.video.dispatchEvent(new Event("timeupdate"));
  assert.equal(page.video.currentTime, mid);
  // 区間と区間のすき間に入ったら、次の区間の頭へ
  page.video.currentTime = spans[0].end + 0.5;
  page.video.dispatchEvent(new Event("timeupdate"));
  assert.equal(page.video.currentTime, spans[1].start);
  // 最後の区間の後ろ → オフになり、通常の再生に戻る(位置は動かさない)
  const last = spans.at(-1);
  page.video.currentTime = last.end + 1;
  page.video.dispatchEvent(new Event("timeupdate"));
  assert.equal(page.ui.digest.at(-1).enabled, false);
  assert.equal(page.video.currentTime, last.end + 1);
  assert.match(page.ui.status.at(-1).t, /ダイジェストが終わりました/);
  // オフになった後の timeupdate では、もう飛ばない
  page.video.currentTime = spans[0].end + 0.5;
  page.video.dispatchEvent(new Event("timeupdate"));
  assert.equal(page.video.currentTime, spans[0].end + 0.5);
});

test("ダイジェスト: 区間が無ければオンにできない。動画を移るとオフに戻る", async () => {
  const page = await readyPage();
  page.handlers.onDigestToggle(true);
  page.navigate("vid2");
  assert.equal(page.ui.digest.at(-1).supported, false);
  page.video.currentTime = 3;
  page.video.dispatchEvent(new Event("timeupdate")); // 外した listener が残っていないこと
  assert.equal(page.video.currentTime, 3);
});

// ================= content: 共有 =================
const ME = { user: { id: "u_aaaaaaaa", name: "alice", role: "user" }, share_mode: "team" };
function fakeEngine({ me = ME, shares = [], mine = [], publish = { shared: true } } = {}) {
  const log = [];
  const fn = (method, path, body) => {
    log.push({ method, path, body });
    if (path === "/v1/me") return { ok: true, status: 200, data: me };
    if (path.startsWith("/v1/shares?video=")) return { ok: true, status: 200, data: { shares } };
    if (path === "/v1/shares" && method === "GET") return { ok: true, status: 200, data: { mine, share_mode: me.share_mode } };
    if (path === "/v1/shares" && method === "POST") return publish.ok === false ? publish : { ok: true, status: 200, data: publish };
    if (path === "/v1/shares/revoke") return { ok: true, status: 200, data: { revoked: true } };
    return { ok: false, status: 404, error: "no" };
  };
  fn.log = log;
  return fn;
}
const BOB = { from: "bob", mine: false, boundaries: [180, 420], titles: null };

test("共有: 状態を読み、他の人の章立てを一覧に出す。共有できる条件がそろうと canPublish", async () => {
  const engine = fakeEngine({ shares: [BOB] });
  const page = await readyPage({ engine });
  await page.handlers.onShareRefresh();
  const v = page.ui.share.at(-1);
  assert.match(v.note, /alice/);
  assert.match(v.note, /共有範囲/);
  assert.equal(v.canPublish, true);
  assert.deepEqual(v.shares, [{ from: "bob", count: 3, mine: false, overlay: false }]);
  assert.deepEqual(engine.log.map((c) => c.path), ["/v1/me", "/v1/shares?video=vid1"]);
});

test("共有: 公開 — 既定は区間の時刻だけ(題名・字幕は送らない)・全員向け", async () => {
  const engine = fakeEngine();
  const page = await readyPage({ engine });
  await page.handlers.onSharePublish({ audience: "", withTitles: false });
  const post = engine.log.find((c) => c.method === "POST" && c.path === "/v1/shares");
  assert.deepEqual(Object.keys(post.body).sort(), ["audience", "boundaries", "duration", "video"]);
  assert.equal(post.body.audience, "team");
  assert.equal(post.body.video, "vid1");
  assert.deepEqual(post.body.boundaries, lastChapters(page).slice(1).map((c) => c.start));
  assert.ok(!JSON.stringify(post.body).includes("について話します")); // 字幕のテキストは含まれない
});

test("共有: 題名を選んだときだけ送る(60 文字まで・章の数 + ... 同じ個数)。指定した人にだけ", async () => {
  const engine = fakeEngine();
  const page = await readyPage({ engine });
  await page.handlers.onSharePublish({ audience: "u_bbbbbbbb, u_cccccccc", withTitles: true });
  const post = engine.log.find((c) => c.method === "POST" && c.path === "/v1/shares").body;
  assert.deepEqual(post.audience, ["u_bbbbbbbb", "u_cccccccc"]);
  assert.equal(post.titles.length, post.boundaries.length + 1);
  assert.ok(post.titles.every((t) => typeof t === "string" && t.length <= 60));
});

test("共有: 不正な共有先は、送らずに理由を出す", async () => {
  const engine = fakeEngine();
  const page = await readyPage({ engine });
  await page.handlers.onSharePublish({ audience: "bob", withTitles: false });
  assert.equal(engine.log.filter((c) => c.method === "POST").length, 0);
  const v = page.ui.share.at(-1);
  assert.equal(v.error, true);
  assert.match(v.note, /利用者 ID/);
});

test("共有: エンジンの拒否(共有が無効・停止中など)は、その説明をそのまま出す", async () => {
  const engine = fakeEngine({ publish: { ok: false, status: 403, error: "共有は、管理者が無効にしています" } });
  const page = await readyPage({ engine });
  await page.handlers.onSharePublish({ audience: "", withTitles: false });
  const v = page.ui.share.at(-1);
  assert.equal(v.error, true);
  assert.equal(v.note, "共有は、管理者が無効にしています");
});

test("共有: 共有範囲が off なら公開できない。自分の共有があれば、取り下げだけはできる", async () => {
  const engine = fakeEngine({ me: { ...ME, share_mode: "off" }, mine: [{ video: "vid1", audience: "team" }] });
  const page = await readyPage({ engine });
  await page.handlers.onShareRefresh();
  const v = page.ui.share.at(-1);
  assert.deepEqual([v.canPublish, v.mine], [false, true]);
  assert.ok(!engine.log.some((c) => c.path.startsWith("/v1/shares?video=")));   // off のときは、一覧を取りに行かない
  await page.handlers.onShareRevoke();
  assert.ok(engine.log.some((c) => c.path === "/v1/shares/revoke" && c.body.video === "vid1"));
});

test("共有: エンジン未設定・接続失敗は、何をすればよいかを出す(例外にしない)", async () => {
  const page = await readyPage({ engine: undefined });
  await page.handlers.onShareRefresh();
  const v = page.ui.share.at(-1);
  assert.equal(v.error, true);
  assert.match(v.note, /アイコン/);
  assert.equal(v.canPublish, false);
});

test("共有: 他の人の章立てを重ねる・使う。重ねるのはエンジンを呼び直さない。使うと自分の調整として保存される", async () => {
  const engine = fakeEngine({ shares: [BOB] });
  const page = await readyPage({ engine });
  await page.handlers.onShareRefresh();
  const calls = engine.log.length;
  page.handlers.onShareOverlay(0, true);
  assert.equal(page.ui.share.at(-1).shares[0].overlay, true);
  assert.equal(engine.log.length, calls);
  page.handlers.onShareAdopt(0);
  assert.deepEqual(lastChapters(page).map((c) => c.start).slice(1), [180, 420]);
  assert.equal(page.ui.tab.at(-1), "chapters");
  assert.match(page.ui.status.at(-1).t, /bob/);
  await flush();
  assert.deepEqual(page.area.data[savedKey()].manual.boundaries, [180, 420]);
});

test("共有: 字幕を読み込む前に「使う」を押しても、壊れずに案内する", async () => {
  const engine = fakeEngine({ shares: [BOB] });
  const page = loadContent({ engine });
  await page.ready();
  await page.handlers.onShareRefresh();
  page.handlers.onShareAdopt(0);
  assert.equal(page.ui.status.at(-1).kind, "error");
});

// ================= content: ライブ(CH5) =================
async function livePage(engine) {
  const page = loadContent({ live: true, engine });
  await page.ready();
  page.msg({ type: "cl-started", wallMs: page.clock.t });
  return page;
}
const liveReply = (session, markers) => ({ ok: true, status: 200, data: { session, now_s: 30, markers, dropped: 0 } });

test("ライブ: 字幕をエンジンのセッションへ送り、暫定(仮)・確定の印を章にする", async () => {
  const replies = [
    liveReply("s1", [{ t: 12, status: "tentative", score: 0.8 }]),
    liveReply("s1", [{ t: 12, status: "committed", score: 0.9 }]),
  ];
  const calls = [];
  const engine = (method, path, body) => { calls.push({ method, path, body }); return replies.shift() || liveReply("s1", []); };
  const page = await livePage(engine);
  assert.match(page.ui.status.at(-1).t, /ライブ/);
  const wall0 = page.clock.t;
  page.play(30);
  page.msg({ type: "cl-cues", cues: [{ start: 2, end: 8, text: "ギターの弦について話します" }, { start: 12, end: 18, text: "料理の包丁について話します" }], chunkWallMs: wall0, info: { language: "ja" } });
  await flush();
  assert.equal(calls[0].path, "/v1/live");
  assert.equal(calls[0].body.session, undefined);                              // 最初は session なし
  assert.deepEqual(Object.keys(calls[0].body.cues[0]).sort(), ["end", "start", "text"]);
  assert.equal(calls[0].body.cues.length, 2);
  assert.equal(calls[0].body.now_s, 18);
  let ch = page.ui.chapters.at(-1);
  assert.deepEqual(ch.map((c) => c.start), [0, 12]);
  assert.deepEqual(page.ui.chapterOpts.at(-1), { editable: false, tentative: [1] }); // 2 つ目の章は「仮」・調整はできない

  page.play(30);
  page.msg({ type: "cl-cues", cues: [{ start: 0, end: 6, text: "料理の野菜について話します" }], chunkWallMs: wall0 + 30_000, info: { language: "ja" } });
  await flush();
  assert.equal(calls[1].body.session, "s1");                                   // 同じセッションに足す
  assert.deepEqual(page.ui.chapterOpts.at(-1).tentative, []);                  // 確定
  assert.match(page.ui.status.at(-1).t, /確定 1 件・暫定 0 件/);
  assert.equal(page.ui.digest.at(-1).supported, false);                        // ライブではダイジェストを使わない
  assert.match(page.ui.digest.at(-1).reason, /ライブ/);
});

test("ライブ: 検出はエンジンに任せ、バッチの検出(analyze)は走らせない", async () => {
  const engine = () => liveReply("s1", []);
  const page = await livePage(engine);
  const wall0 = page.clock.t;
  for (let c = 0; c < 4; c++) {
    page.play(60);
    page.msg({ type: "cl-cues", cues: chunkCues(c * 60, c * 60 + 60), chunkWallMs: wall0 + c * 60_000, info: { language: "ja" } });
  }
  await flush();
  assert.deepEqual(page.ui.chapters.at(-1).map((c) => c.start), [0]); // エンジンが印を返さない限り、章は分かれない(ブラウザ側で勝手に分けない)
});

test("ライブ: セッションが期限切れ(404)なら、新しく始めて、いまある字幕を全部送り直す", async () => {
  const calls = [];
  const replies = [liveReply("s1", []), { ok: false, status: 404, error: "セッションがありません" }, liveReply("s2", [{ t: 31, status: "committed", score: 0.9 }])];
  const engine = (method, path, body) => { calls.push(body); return replies.shift() || liveReply("s2", []); };
  const page = await livePage(engine);
  const wall0 = page.clock.t;
  page.play(30);
  page.msg({ type: "cl-cues", cues: [{ start: 1, end: 5, text: "ギターの話" }], chunkWallMs: wall0, info: {} });
  await flush();
  page.play(30);
  page.msg({ type: "cl-cues", cues: [{ start: 1, end: 5, text: "料理の話" }], chunkWallMs: wall0 + 30_000, info: {} });
  await flush();
  assert.equal(calls[1].session, "s1");
  assert.equal(calls[2].session, undefined);          // 新しいセッション
  assert.equal(calls[2].cues.length, 2);              // これまでの字幕をすべて
  assert.deepEqual(page.ui.chapters.at(-1).map((c) => c.start), [0, 31]);
});

test("ライブ: エンジンのエラー(token・未設定)は画面に出し、取り込みの字幕は失わない", async () => {
  const page = await livePage(() => ({ ok: false, status: 401, error: "token が違います" }));
  const wall0 = page.clock.t;
  page.play(30);
  page.msg({ type: "cl-cues", cues: [{ start: 1, end: 5, text: "ギターの話" }], chunkWallMs: wall0, info: {} });
  await flush();
  assert.equal(page.ui.status.at(-1).kind, "error");
  assert.match(page.ui.status.at(-1).t, /token/);
});

test("ライブ: 取り込みが終わるとセッションを閉じる。動画を移っても閉じる", async () => {
  const calls = [];
  const engine = (m, path, body) => { calls.push(path); return liveReply("s1", []); };
  const page = await livePage(engine);
  page.play(30);
  page.msg({ type: "cl-cues", cues: [{ start: 1, end: 5, text: "ギターの話" }], chunkWallMs: page.clock.t - 30_000, info: {} });
  await flush();
  page.msg({ type: "cl-ended" });
  await flush();
  assert.ok(calls.includes("/v1/live/close"));

  const page2 = await livePage(engine);
  page2.play(30);
  page2.msg({ type: "cl-cues", cues: [{ start: 1, end: 5, text: "ギターの話" }], chunkWallMs: page2.clock.t - 30_000, info: {} });
  await flush();
  calls.length = 0;
  page2.navigate("vid9");
  await flush();
  assert.ok(calls.includes("/v1/live/close"));
});

test("ライブ: 範囲外の印は章にせず、「仮」の番号を章の番号とずらさない", async () => {
  const engine = () => liveReply("s1", [{ t: 0, status: "committed", score: 0.9 }, { t: 12, status: "tentative", score: 0.8 }, { t: 9999, status: "committed", score: 0.7 }]);
  const page = await livePage(engine);
  page.play(30);
  page.msg({ type: "cl-cues", cues: [{ start: 2, end: 8, text: "ギターの弦について話します" }, { start: 12, end: 18, text: "料理の包丁について話します" }], chunkWallMs: page.clock.t - 30_000, info: {} });
  await flush();
  assert.deepEqual(page.ui.chapters.at(-1).map((c) => c.start), [0, 12]);
  assert.deepEqual(page.ui.chapterOpts.at(-1).tentative, [1]);
});

test("共有: エンジンの応答の形が想定と違っても、画面が止まらずエラーを出す", async () => {
  const page = await readyPage({ engine: () => ({ ok: true, status: 200, data: null }) });
  await page.handlers.onShareRefresh();
  const v = page.ui.share.at(-1);
  assert.equal(v.error, true);
  assert.match(v.note, /想定と違います/);
});

test("ライブ: エンジンの応答の形が想定と違っても、例外にせず、画面にエラーを出す", async () => {
  const page = await livePage(() => ({ ok: true, status: 200, data: null }));
  page.play(30);
  page.msg({ type: "cl-cues", cues: [{ start: 1, end: 5, text: "ギターの話" }], chunkWallMs: page.clock.t - 30_000, info: {} });
  await flush();
  assert.equal(page.ui.status.at(-1).kind, "error");
  page.play(30);
  page.msg({ type: "cl-cues", cues: [{ start: 2, end: 6, text: "ギターの弦" }], chunkWallMs: page.clock.t - 30_000, info: {} });
  await flush(); // 2 回目も処理できる(busy のまま固まらない)
  assert.equal(page.ui.status.at(-1).kind, "error");
});

test("ダイジェスト: 割合の選択は、別の動画へ移ると既定(20%)に戻る", async () => {
  const page = await readyPage();
  page.handlers.onDigestRatio(0.3);
  page.navigate("vid2");
  assert.equal(page.ui.digest.at(-1).supported, false);
  page.navigate("vid3");
  await page.handlers.onRun();
  await flush();
  assert.equal(page.ui.digest.at(-1).ratio, 0.2);
});
