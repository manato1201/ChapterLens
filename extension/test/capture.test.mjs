import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../src/capture.js");

// ---- 送り先 ----
test("validateServerUrl: 127.0.0.1 の http だけ。別ホスト・https・パス・認証情報は拒否", () => {
  assert.equal(C.validateServerUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(C.validateServerUrl("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
  for (const bad of ["http://localhost:8787", "https://127.0.0.1:8787", "http://evil.example.com", "http://127.0.0.1.evil.com:80",
    "http://127.0.0.1:8787/v1", "http://user:pw@127.0.0.1:8787", "http://127.0.0.1:8787/?x=1", "", "nope", null]) {
    assert.throws(() => C.validateServerUrl(bad), undefined, String(bad));
  }
});

// ---- 16kHz へ ----
function sine(rate, seconds, hz) {
  const a = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < a.length; i++) a[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
  return a;
}

test("Downsampler: 48k→16k は 1/3 の長さ。100Hz の波形が保たれる", () => {
  const d = new C.Downsampler(48000, 16000);
  const out = d.process(sine(48000, 1, 100));
  assert.ok(Math.abs(out.length - 16000) <= 1, String(out.length));
  const ref = sine(16000, 1, 100);
  let err = 0;
  for (let i = 10; i < 15990; i++) err = Math.max(err, Math.abs(out[i] - ref[i]));
  assert.ok(err < 0.05, `最大誤差 ${err}`);
});

test("Downsampler: 割り切れない 44.1k→16k も、ブロックを分けても結果が同じ", () => {
  const input = sine(44100, 2, 220);
  const whole = new C.Downsampler(44100, 16000).process(input);
  const d = new C.Downsampler(44100, 16000);
  const parts = [];
  for (let i = 0; i < input.length; i += 4096) parts.push(...d.process(input.subarray(i, i + 4096)));
  assert.ok(Math.abs(whole.length - 32000) <= 1);
  assert.equal(parts.length, whole.length);
  for (let i = 0; i < whole.length; i++) assert.ok(Math.abs(parts[i] - whole[i]) < 1e-6);
});

test("Downsampler: 不正なレートは拒否", () => {
  assert.throws(() => new C.Downsampler(0, 16000));
  assert.throws(() => new C.Downsampler(8000, 16000)); // 上げる方向は使わない
});

// ---- 区切る ----
test("Chunker: 30 秒ごとに区切り、各チャンクの開始時刻が連続する", () => {
  const got = [];
  const ch = new C.Chunker({ chunkS: 30, onChunk: (c) => got.push(c) });
  const block = new Float32Array(16000).fill(0.1); // 1 秒
  for (let i = 0; i < 70; i++) ch.push(100 + i, block);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((c) => c.startS), [100, 130]);
  assert.ok(got.every((c) => c.samples.length === 30 * 16000));
  ch.flush(); // 残り 10 秒
  assert.equal(got.length, 3);
  assert.equal(got[2].startS, 160);
  assert.equal(got[2].samples.length, 10 * 16000);
});

test("Chunker: 音が来なかった時間(一時停止など)は無音で埋め、時刻がずれない", () => {
  const got = [];
  const ch = new C.Chunker({ chunkS: 10, onChunk: (c) => got.push(c) });
  const one = new Float32Array(16000).fill(0.3);
  ch.push(0, one); // 0〜1 秒
  ch.push(6, one); // 5 秒の空き → 無音で埋まる。6〜7 秒に音
  ch.push(7, new Float32Array(3 * 16000).fill(0.3));
  assert.equal(got.length, 1);
  const s = got[0].samples;
  assert.equal(s.length, 160000);
  assert.ok(Math.abs(s[0] - 0.3) < 1e-6 && s[2 * 16000] === 0 && Math.abs(s[6 * 16000 + 5] - 0.3) < 1e-6);
});

test("Chunker: 1 秒に満たない端は捨てる", () => {
  const got = [];
  const ch = new C.Chunker({ chunkS: 10, onChunk: (c) => got.push(c) });
  ch.push(0, new Float32Array(8000).fill(0.2));
  ch.flush();
  assert.equal(got.length, 0);
});

// ---- WAV ----
test("encodeWav: ヘッダ・長さ・値(16bit モノラル 16kHz)", () => {
  const wav = C.encodeWav(Float32Array.from([0, 0.5, -0.5, 1, -1, 2]), 16000);
  const dv = new DataView(wav.buffer);
  const tag = (o) => String.fromCharCode(...wav.slice(o, o + 4));
  assert.equal(tag(0), "RIFF");
  assert.equal(tag(8), "WAVE");
  assert.equal(tag(36), "data");
  assert.equal(wav.length, 44 + 12);
  assert.equal(dv.getUint32(4, true), 36 + 12);
  assert.equal(dv.getUint16(22, true), 1); // モノラル
  assert.equal(dv.getUint32(24, true), 16000);
  assert.equal(dv.getUint16(34, true), 16);
  assert.ok(Math.abs(dv.getInt16(46, true) - 16384) <= 1); // 0.5(丸めで ±1)
  assert.equal(dv.getInt16(48, true), -16384); // -0.5
  assert.equal(dv.getInt16(50, true), 32767); // 1 → 最大
  assert.equal(dv.getInt16(52, true), -32768); // -1 → 最小
  assert.equal(dv.getInt16(54, true), 32767); // 範囲外は丸める
});

test("rms: 無音は 0、一定の値はその絶対値", () => {
  assert.equal(C.rms(new Float32Array(100)), 0);
  assert.ok(Math.abs(C.rms(new Float32Array(100).fill(-0.25)) - 0.25) < 1e-6);
  assert.equal(C.rms(new Float32Array(0)), 0);
});

// ---- 時計 → 動画の位置 ----
test("TimeMap: 再生中は線形(倍速も反映)、一時停止の間は動かない", () => {
  const m = new C.TimeMap();
  m.add(0, 100); // 通常速度で再生
  m.add(10_000, 110);
  m.add(10_000, 110); // pause
  m.add(20_000, 110); // play(10 秒止まっていた)
  m.add(30_000, 130); // 2 倍速: 10 秒で 20 秒進む
  assert.equal(m.mediaAt(5_000), 105);
  assert.equal(m.mediaAt(15_000), 110);
  assert.equal(m.mediaAt(25_000), 120);
  assert.equal(m.mediaAt(-500), 100); // 範囲外は端の値
  assert.equal(m.mediaAt(99_000), 130);
});

test("TimeMap: シーク(jump)の前の区間は直前の進み方で延ばし、飛んだ先の時刻を混ぜない", () => {
  const m = new C.TimeMap();
  m.add(0, 50);
  m.add(1000, 51);
  m.add(2000, 52);
  m.add(3000, 500, { jump: true }); // 2 秒のあと 500 秒へシーク
  m.add(4000, 501);
  assert.ok(Math.abs(m.mediaAt(2500) - 52.5) < 1e-9); // 前の続きとして延ばす
  assert.ok(Math.abs(m.mediaAt(3500) - 500.5) < 1e-9); // 飛んだ後は新しい位置
});

test("TimeMap: 点が無ければ null。時計が戻る点は無視", () => {
  const m = new C.TimeMap();
  assert.equal(m.mediaAt(5), null);
  m.add(100, 1);
  m.add(50, 999);
  assert.equal(m.pts.length, 1);
});

test("shiftCues: チャンクの時計の時刻から動画の位置へ。長さの無い字幕・空文字は除く", () => {
  const m = new C.TimeMap();
  m.add(1_000_000, 600);
  m.add(1_060_000, 660); // 1 倍速
  const out = C.shiftCues([
    { start: 1.0, end: 3.5, text: "a" },
    { start: 10, end: 10, text: "no length" },
    { start: 12, end: 14, text: "" },
    { start: 20, end: 25.25, text: "b" },
  ], 1_000_000, m);
  assert.deepEqual(out, [{ start: 601, end: 603.5, text: "a" }, { start: 620, end: 625.25, text: "b" }]);
});

// ---- CaptureSession ----
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, opts }); return handler(url, opts, calls.length); };
  f.calls = calls;
  return f;
}
const okJson = (obj) => ({ ok: true, status: 200, json: async () => obj });
const loud = (sec) => new Float32Array(sec * 16000).fill(0.2);

function session(over = {}) {
  const log = { cues: [], status: [], errors: [] };
  const s = new C.CaptureSession({
    fetch: over.fetch, serverUrl: "http://127.0.0.1:8787", token: "tok", language: over.language,
    onCues: (cues, wall, info) => log.cues.push({ cues, wall, info }),
    onStatus: (i) => log.status.push(i), onError: (code, message) => log.errors.push({ code, message }),
    maxQueue: over.maxQueue,
  });
  return { s, log };
}

test("CaptureSession: Bearer token つきで 127.0.0.1 へ WAV を送り、字幕と時計の時刻を返す", async () => {
  const f = fakeFetch(() => okJson({ language: "ja", cues: [{ start: 0, end: 2, text: "こんにちは" }, { start: 2, end: 4, text: "世界" }] }));
  const { s, log } = session({ fetch: f });
  s.enqueue({ startS: 30, samples: loud(30) }, 1_000_000);
  await s.drain();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "http://127.0.0.1:8787/v1/transcribe");
  assert.equal(f.calls[0].opts.headers.Authorization, "Bearer tok");
  assert.equal(f.calls[0].opts.headers["Content-Type"], "audio/wav");
  assert.equal(f.calls[0].opts.body.length, 44 + 30 * 16000 * 2);
  assert.equal(log.cues[0].wall, 1_000_000 + 30_000); // チャンクの先頭の時計の時刻
  assert.equal(log.cues[0].cues.length, 2);
});

test("CaptureSession: 最初に言語が決まったら固定する(以後 ?language= を付ける)", async () => {
  const f = fakeFetch(() => okJson({ language: "en", cues: [{ start: 0, end: 1, text: "a b" }, { start: 1, end: 2, text: "c d" }] }));
  const { s } = session({ fetch: f });
  s.enqueue({ startS: 0, samples: loud(30) }, 0);
  s.enqueue({ startS: 30, samples: loud(30) }, 0);
  await s.drain();
  assert.ok(!f.calls[0].url.includes("language="));
  assert.ok(f.calls[1].url.endsWith("?language=en"));
});

test("CaptureSession: 言語を指定したときは最初から付ける", async () => {
  const f = fakeFetch(() => okJson({ language: "ja", cues: [] }));
  const { s } = session({ fetch: f, language: "ja" });
  s.enqueue({ startS: 0, samples: loud(30) }, 0);
  await s.drain();
  assert.ok(f.calls[0].url.endsWith("?language=ja"));
});

test("CaptureSession: 無音のチャンクは送らない", async () => {
  const f = fakeFetch(() => okJson({ cues: [] }));
  const { s } = session({ fetch: f });
  s.enqueue({ startS: 0, samples: new Float32Array(30 * 16000) }, 0);
  await s.drain();
  assert.equal(f.calls.length, 0);
  assert.equal(s.stats.skippedSilent, 1);
});

test("CaptureSession: 401 は token エラーで取り込みを止め、以後は送らない", async () => {
  const f = fakeFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));
  const { s, log } = session({ fetch: f });
  s.enqueue({ startS: 0, samples: loud(30) }, 0);
  await s.drain();
  assert.equal(log.errors[0].code, "auth");
  s.enqueue({ startS: 30, samples: loud(30) }, 0);
  await s.drain();
  assert.equal(f.calls.length, 1);
});

test("CaptureSession: 403(Origin)・接続できない・5xx・壊れた返事は、それぞれのエラー", async () => {
  for (const [handler, code] of [
    [() => ({ ok: false, status: 403, json: async () => ({}) }), "origin"],
    [() => { throw new TypeError("Failed to fetch"); }, "unreachable"],
    [() => ({ ok: false, status: 500, json: async () => ({}) }), "server"],
    [() => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }), "server"],
  ]) {
    const { s, log } = session({ fetch: fakeFetch(handler) });
    s.enqueue({ startS: 0, samples: loud(30) }, 0);
    await s.drain();
    assert.equal(log.errors[0].code, code);
    assert.equal(log.cues.length, 0);
  }
});

test("CaptureSession: 処理が詰まったら(queue 上限)音声を飛ばして知らせる。残りは全部送る", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = fakeFetch(async () => { await gate; return okJson({ cues: [] }); });
  const { s, log } = session({ fetch: f, maxQueue: 2 });
  for (let i = 0; i < 5; i++) s.enqueue({ startS: i * 30, samples: loud(30) }, 0);
  // 1 つ目は送信中、queue に 2 つ、残り 2 つは飛ばす
  assert.equal(s.stats.dropped, 2);
  assert.equal(log.errors.filter((e) => e.code === "backlog").length, 2);
  release();
  await s.drain();
  assert.equal(f.calls.length, 3);
});

test("CaptureSession: stop 後は何も送らない", async () => {
  const f = fakeFetch(() => okJson({ cues: [] }));
  const { s } = session({ fetch: f });
  s.stop();
  s.enqueue({ startS: 0, samples: loud(30) }, 0);
  await s.drain();
  assert.equal(f.calls.length, 0);
});

test("CaptureSession: 別ホストの URL では作れない", () => {
  assert.throws(() => new C.CaptureSession({ serverUrl: "http://evil.example.com", token: "t", fetch: async () => {} }));
});
