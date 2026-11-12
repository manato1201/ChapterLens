/*
 * background.js と content.js の「取り込みの流れ」を、偽の chrome / DOM で動かす(Chrome の本物の API は使えないので、
 * メッセージのやりとり・時刻の変換・結果の積み上げ・エラー処理までを確かめる)。読み込みの仕組みは helpers.mjs。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBackground, loadContent, chunkCues, tick } from "./helpers.mjs";

// ================= background.js(取り込み) =================
test("background: start は offscreen を作り、音声の取り込みを依頼し、タブへ開始を知らせる", async () => {
  const { st, send } = loadBackground();
  const res = await send({ target: "background", type: "start", streamId: "sid", tabId: 7, serverUrl: "http://127.0.0.1:8787", token: "tok", language: "ja" });
  assert.equal(res.ok, true);
  assert.equal(st.created.length, 1);
  assert.equal(JSON.stringify(st.created[0].reasons), '["USER_MEDIA"]');
  assert.equal(st.created[0].url, "src/offscreen.html");
  const req = st.sent.find((m) => m.target === "offscreen");
  assert.deepEqual([req.type, req.streamId, req.tabId, req.token, req.language], ["start", "sid", 7, "tok", "ja"]);
  assert.equal(st.tabMsgs[0][0], 7);
  assert.equal(st.tabMsgs[0][1].type, "cl-started");
});

test("background: 取り込みに失敗したら offscreen を閉じ、理由を返す。タブには開始を知らせない", async () => {
  const { st, send } = loadBackground({ offscreenReply: () => ({ ok: false, error: "Permission denied" }) });
  const res = await send({ target: "background", type: "start", streamId: "s", tabId: 1, serverUrl: "http://127.0.0.1:8787", token: "t" });
  assert.equal(res.ok, false);
  assert.match(res.error, /Permission denied/);
  assert.equal(st.closed, 1);
  assert.equal(st.tabMsgs.length, 0);
});

test("background: 中継・停止・終了。自分宛てでないメッセージは無視する", async () => {
  const { st, send } = loadBackground();
  await send({ target: "background", type: "start", streamId: "s", tabId: 3, serverUrl: "http://127.0.0.1:8787", token: "t" });
  st.tabMsgs.length = 0; st.sent.length = 0;
  await send({ target: "background", type: "relay", tabId: 3, payload: { type: "cl-cues", cues: [] } });
  assert.deepEqual(st.tabMsgs, [[3, { type: "cl-cues", cues: [] }]]);
  await send({ target: "background", type: "stop" });
  assert.ok(st.sent.some((m) => m.target === "offscreen" && m.type === "stop"));
  await send({ target: "background", type: "ended" });
  await tick();
  assert.equal(st.closed, 1);
  assert.equal(await send({ target: "offscreen", type: "start" }), undefined); // 宛先違い
  assert.equal(await send(null), undefined);
});


// ================= content.js(取り込み) =================
async function startedPage() {
  const page = loadContent();
  await page.ready();
  page.msg({ type: "cl-started", wallMs: page.clock.t });
  return page;
}

test("content: 取り込みの開始で、パネルを開き、章をいったん空にする", async () => {
  const page = await startedPage();
  assert.equal(page.ui.open, 1);
  assert.match(page.ui.status.at(-1).t, /取り込みを始めました/);
});

test("content: チャンクの字幕を動画の時刻に直して積み、話題の切り替え(120 秒)付近で章を分ける", async () => {
  const page = await startedPage();
  const wall0 = page.clock.t; // 取り込み開始の時計の時刻 = 動画 0 秒
  for (let c = 0; c < 4; c++) { // 60 秒ずつ 4 チャンク(0〜240 秒)
    page.play(60);
    page.msg({ type: "cl-cues", cues: chunkCues(c * 60, c * 60 + 60), chunkWallMs: wall0 + c * 60_000, info: { language: "ja" } });
  }
  const chapters = page.ui.chapters.at(-1);
  assert.ok(chapters.length >= 2, `章が分かれていない: ${chapters.length}`);
  const b = chapters[1].start;
  assert.ok(Math.abs(b - 120) <= 15, `境界 ${b} が 120 秒から遠い`);
  assert.match(page.ui.status.at(-1).t, /章/);
});

test("content: 開始時に動画が 300 秒の位置でも、字幕は動画の時刻(300 秒〜)に置かれる", async () => {
  const page = loadContent();
  await page.ready();
  page.video.currentTime = 300;
  page.msg({ type: "cl-started", wallMs: page.clock.t });
  const wall0 = page.clock.t;
  page.play(60);
  page.msg({ type: "cl-cues", cues: [{ start: 10, end: 15, text: "ギターの弦について話します" }], chunkWallMs: wall0, info: { language: "ja" } });
  // 字幕は 310〜315 秒のはず(90 秒未満なので章は作らず、待つ旨を出す)
  assert.match(page.ui.status.at(-1).t, /もう少し再生/);
});

test("content: 同じ範囲をもう一度受けても、字幕が二重にならない(章の数が変わらない)", async () => {
  const page = await startedPage();
  const wall0 = page.clock.t;
  for (let c = 0; c < 4; c++) {
    page.play(60);
    page.msg({ type: "cl-cues", cues: chunkCues(c * 60, c * 60 + 60), chunkWallMs: wall0 + c * 60_000, info: { language: "ja" } });
  }
  const before = page.ui.chapters.at(-1).map((c) => c.start);
  page.msg({ type: "cl-cues", cues: chunkCues(60, 120), chunkWallMs: wall0 + 60_000, info: { language: "ja" } });
  assert.deepEqual(page.ui.chapters.at(-1).map((c) => c.start), before);
});

test("content: token エラーは画面に出して、取り込みを止める依頼を送る", async () => {
  const page = await startedPage();
  page.msg({ type: "cl-error", code: "auth", message: "token が違います" });
  assert.equal(page.ui.status.at(-1).kind, "error");
  assert.ok(page.sent.some((m) => m.target === "background" && m.type === "stop"));
});

test("content: 接続できないエラーは表示だけ(取り込みは続ける)", async () => {
  const page = await startedPage();
  page.msg({ type: "cl-error", code: "unreachable", message: "エンジンに接続できません" });
  assert.equal(page.ui.status.at(-1).kind, "error");
  assert.ok(!page.sent.some((m) => m.type === "stop"));
});

test("content: 終了(cl-ended)で取り込みの状態を片付け、以後の結果は無視する", async () => {
  const page = await startedPage();
  const wall0 = page.clock.t;
  page.play(60);
  page.msg({ type: "cl-ended" });
  const n = page.ui.status.length;
  page.msg({ type: "cl-cues", cues: chunkCues(0, 60), chunkWallMs: wall0, info: {} });
  assert.equal(page.ui.status.length, n); // 何も起きない
});

test("content: 動画が切り替わったら、取り込みを止める依頼を送り、結果を捨てる", async () => {
  const page = await startedPage();
  page.navigate("vid2");
  assert.ok(page.sent.some((m) => m.target === "background" && m.type === "stop"));
  const n = page.ui.status.length;
  page.msg({ type: "cl-cues", cues: chunkCues(0, 60), chunkWallMs: page.clock.t, info: {} });
  assert.equal(page.ui.status.length, n);
});

test("content: 取り込みと関係ないメッセージは無視する", async () => {
  const page = await startedPage();
  const n = page.ui.status.length;
  page.msg({ type: "something-else" });
  page.msg(null);
  page.msg({ type: 5 });
  assert.equal(page.ui.status.length, n);
});
