import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const tr = require("../src/transcript.js");
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// ---- 文字起こしの解釈 ----
test("parseTimestamp: m:ss / h:mm:ss / 読めないものは null", () => {
  assert.equal(tr.parseTimestamp("0:15"), 15);
  assert.equal(tr.parseTimestamp(" 1:23 "), 83);
  assert.equal(tr.parseTimestamp("1:02:03"), 3723);
  for (const bad of ["", "15", "a:bc", "1:2:3:4", "-1:00", "1.5:00"]) assert.equal(tr.parseTimestamp(bad), null, bad);
});

test("rowsFromPairs: 空白をつめ、時刻の読めない行・空の行は除く", () => {
  const rows = tr.rowsFromPairs([
    { timestamp: "0:01", text: "  こんにちは \n 世界 " },
    { timestamp: "?", text: "壊れた時刻" },
    { timestamp: "0:05", text: "   " },
    { timestamp: "0:09", text: "次の行" },
  ]);
  assert.deepEqual(rows, [{ start: 1, text: "こんにちは 世界" }, { start: 9, text: "次の行" }]);
});

// ---- manifest(権限は最小・外に出るのはこの PC の 127.0.0.1 だけ) ----
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8"));
const EXT_ID = "egcgicajchobpecnggcblcbnoadlnfai"; // README・エンジンの --allow-origin に書く、固定の拡張 ID

test("manifest: MV3・権限は4つだけ・host_permissions は 127.0.0.1 だけ・content script の対象は YouTube だけ", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "offscreen", "storage", "tabCapture"]);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.deepEqual(manifest.content_scripts.map((c) => c.matches), [["https://www.youtube.com/*"]]);
  assert.equal(manifest.background.service_worker, "src/background.js");
  assert.equal(manifest.action.default_popup, "src/popup.html");
});

test("manifest: key から作った拡張 ID が、文書の ID と一致する", () => {
  const der = Buffer.from(manifest.key, "base64");
  const hash = createHash("sha256").update(der).digest().subarray(0, 16);
  const id = [...hash].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
  assert.equal(id, EXT_ID);
  assert.ok(readFileSync(join(root, "README.md"), "utf-8").includes(EXT_ID), "README に拡張 ID がない");
});

test("manifest: 読み込む JS・HTML がすべて存在し、依存が content より先", () => {
  const js = manifest.content_scripts[0].js;
  for (const f of [...js, manifest.background.service_worker, manifest.action.default_popup, "src/offscreen.html", "src/offscreen.js", "src/pcm-worklet.js", "src/admin.html", "src/admin.js"]) assert.ok(existsSync(join(root, f)), f);
  for (const dep of ["core", "capture", "store", "engine", "transcript", "ui"]) assert.ok(js.indexOf(`src/${dep}.js`) >= 0 && js.indexOf(`src/${dep}.js`) < js.indexOf("src/content.js"), dep);
  assert.equal(js.at(-1), "src/content.js");
});

test("HTML が読み込む script は、すべて src/ にある自分のファイル", () => {
  for (const f of ["popup.html", "admin.html", "offscreen.html"]) {
    const html = readFileSync(join(root, "src", f), "utf-8");
    for (const m of html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) assert.ok(existsSync(join(root, "src", m[1])), `${f}: ${m[1]}`);
  }
});

const BAD_ALWAYS = [/XMLHttpRequest/, /sendBeacon/, /WebSocket/, /\beval\s*\(/, /new Function/, /\.innerHTML\s*=/, /insertAdjacentHTML/, /document\.write/];

test("ソース全体: 動的コード実行・HTML 文字列の挿入・WebSocket 等がない", () => {
  for (const f of readdirSync(join(root, "src")).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(join(root, "src", f), "utf-8");
    for (const bad of BAD_ALWAYS) assert.ok(!bad.test(src), `${f}: ${bad}`);
  }
});

test("importScripts は、自分のファイル(相対パス)だけ", () => {
  for (const f of readdirSync(join(root, "src")).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(join(root, "src", f), "utf-8");
    for (const m of src.matchAll(/importScripts\s*\(([^)]*)\)/g)) assert.match(m[1].trim(), /^"[A-Za-z0-9_.-]+\.js"$/, `${f}: importScripts(${m[1]})`);
  }
});

test("通信: fetch は offscreen.js(音声)と background.js(エンジンの API 中継)だけ。画面・content script は何も直接送らない", () => {
  for (const f of readdirSync(join(root, "src")).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(join(root, "src", f), "utf-8");
    const calls = src.match(/(?<![.\w])fetch\s*\(/g) || []; // 単独の fetch( だけ(this.d.fetch( は別)
    if (f === "offscreen.js" || f === "background.js") assert.ok(calls.length >= 1, f);
    else assert.equal(calls.length, 0, `${f} が fetch を直接呼んでいる`);
  }
  // 送り先の検査(127.0.0.1 だけ)を、送る前に必ず通している
  const off = readFileSync(join(root, "src/offscreen.js"), "utf-8");
  assert.ok(off.includes("validateServerUrl"));
  assert.ok(readFileSync(join(root, "src/capture.js"), "utf-8").includes("this.base = validateServerUrl"));
  const bg = readFileSync(join(root, "src/background.js"), "utf-8");
  assert.ok(bg.indexOf("validateServerUrl") > 0 && bg.indexOf("validateServerUrl") < bg.indexOf("await fetch("), "background は fetch の前に送り先を検査する");
  for (const must of ['redirect: "error"', 'credentials: "omit"', "sender.id !== chrome.runtime.id"]) assert.ok(bg.includes(must), must);
});

test("エンジンの中継の許可リスト: 音声(/v1/transcribe)・/v1/detect・/v1/corrections は通さない。管理の経路は ID の形まで縛る", () => {
  const bg = readFileSync(join(root, "src/background.js"), "utf-8");
  const table = bg.slice(bg.indexOf("const ENGINE_ROUTES"), bg.indexOf("async function hasOffscreen"));
  for (const bad of ["transcribe", "detect", "corrections"]) assert.ok(!table.includes(bad), bad);
  assert.equal((table.match(/\["(GET|POST)", \//g) || []).length, 13);
  assert.ok(table.includes("(local|u_[0-9a-f]{8})"));
});

test("外部の URL を読み込まない(HTML も)・HTML にインラインのスクリプトがない(CSP)", () => {
  for (const f of ["popup.html", "offscreen.html", "admin.html"]) {
    const html = readFileSync(join(root, "src", f), "utf-8");
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${f} にインラインの script`);
    assert.ok(!/(?:src|href)\s*=\s*["']https?:/i.test(html), `${f} が外部を読み込む`);
  }
});
