/*
 * 端から端までの確認(CH2b)。拡張がブラウザの中で行う処理を Node で再現して、実際のエンジンに通す:
 *   16kHz の WAV → 48kHz に増やす(タブの音の再現)→ Downsampler → Chunker(30 秒)→ WAV → HTTP(token・Origin つき)
 *   → エンジンの文字起こし → shiftCues(再生位置への変換)→ Core.detect(拡張と同じ検出)
 * 正解の境界(<wav>.json の boundaries_s)と比べる。Chrome の API(tabCapture 等)だけは再現できない。
 *
 * 使い方:
 *   node tools/e2e_audio.mjs <audio.wav> <audio.json> --url http://127.0.0.1:18788 --token <token> [--origin chrome-extension://<id>] [--lang en] [--start 0]
 *   --min-gap: 境界の最小間隔(秒。既定 30)
 *   --start: 動画を途中(秒)から見始めた想定。--rate: 再生の速さ(1 以外でも、字幕の時刻が動画の時刻になるか)
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const C = require(join(here, "../src/capture.js"));
const Core = require(join(here, "../src/core.js"));

const args = process.argv.slice(2);
const pos = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const [wavPath, jsonPath] = pos;
if (!wavPath || !jsonPath) { console.error("使い方: node tools/e2e_audio.mjs <audio.wav> <audio.json> --url ... --token ..."); process.exit(2); }
const url = opt("url", "http://127.0.0.1:8787"), token = opt("token"), origin = opt("origin"), lang = opt("lang", "auto");
const startAt = Number(opt("start", "0")), rate = Number(opt("rate", "1"));
const truth = JSON.parse(readFileSync(jsonPath, "utf-8"));

// WAV(16kHz・16bit・モノラル)を読む
const buf = readFileSync(wavPath);
const dataAt = buf.indexOf("data") + 8;
const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + dataAt, buf.byteOffset + buf.length - ((buf.length - dataAt) % 2)));
const x16 = Float32Array.from(pcm, (v) => v / 32768);
// 48kHz に(3 倍。線形補間)。タブの音がこのレートで来る状況の再現
const x48 = new Float32Array(x16.length * 3);
for (let i = 0; i < x16.length; i++) { const a = x16[i], b = x16[i + 1] ?? a; x48[3 * i] = a; x48[3 * i + 1] = a + (b - a) / 3; x48[3 * i + 2] = a + (2 * (b - a)) / 3; }

// 再生の様子: 動画 startAt 秒から、速さ rate で再生。音の流れの時刻 t(秒)の音は、動画の startAt + t*rate 秒にあたる
const wallAtZero = 5_000_000;
const map = new C.TimeMap();
for (let t = 0; t <= x16.length / 16000 + 1; t += 1) map.add(wallAtZero + t * 1000, startAt + t * rate);

const cues = [];
let coveredMedia = 0, chunks = 0;
const session = new C.CaptureSession({
  fetch: (u, o) => fetch(u, { ...o, headers: { ...o.headers, ...(origin ? { Origin: origin } : {}) } }),
  serverUrl: url, token, language: lang,
  onCues: (raw, wall, info) => { cues.push(...C.shiftCues(raw, wall, map)); chunks++; coveredMedia = Math.max(coveredMedia, info.coveredS); },
  onStatus: () => {},
  onError: (code, message) => { console.error(`エラー ${code}: ${message}`); process.exitCode = 1; },
});
const chunker = new C.Chunker({ chunkS: 30, onChunk: (ch) => session.enqueue(ch, wallAtZero) });
const down = new C.Downsampler(48000, 16000);
const t0 = performance.now();
for (let i = 0; i < x48.length; i += 4096) chunker.push(i / 48000, down.process(x48.subarray(i, i + 4096)));
chunker.flush();
await session.drain();
const secs = (performance.now() - t0) / 1000;

cues.sort((a, b) => a.start - b.start);
const dur = startAt + (x16.length / 16000) * rate;
console.log(`チャンク ${chunks} 個 / 字幕 ${cues.length} 行 / 言語 ${session.language} / 処理 ${secs.toFixed(1)} 秒(音声 ${(x16.length / 16000).toFixed(0)} 秒)`);
console.log("先頭の字幕:", cues.slice(0, 3).map((c) => `${c.start.toFixed(1)}-${c.end.toFixed(1)} ${c.text}`).join(" | "));
if (cues.length < 3) { console.error("字幕が少なすぎます"); process.exit(1); }

const want = truth.boundaries_s.map((b) => startAt + b * rate);
const minGap = Number(opt("min-gap", "30")); // 合成音声は数分と短いので、v2 の既定(60 秒)より小さく
const det = Core.detectPartial(cues, dur, { targetCount: want.length, params: { minGapS: minGap } });
console.log("正解の境界:", want.map((b) => b.toFixed(1)).join(", "));
console.log("検出の境界:", det.boundaries.map((b) => b.toFixed(1)).join(", "));
// 一対一で近いものから対応づけて、ずれを出す
const errs = want.map((w) => Math.min(...det.boundaries.map((b) => Math.abs(b - w))));
console.log("各境界の最小ずれ(秒):", errs.map((e) => e.toFixed(1)).join(", "));
// 字幕の最初の時刻: 取り込み開始の位置に近いはず
console.log(`最初の字幕の開始 ${cues[0].start.toFixed(2)} 秒(動画の ${startAt} 秒から見始めた想定)`);
const ok = errs.every((e) => e <= 15) && cues[0].start >= startAt - 1 && cues[0].start <= startAt + 15;
console.log(ok ? "OK: 境界が ±15 秒以内・字幕の位置も動画の時刻" : "NG");
process.exit(ok ? 0 : 1);
