import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
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

// ---- manifest(権限は最小・外部に出ない) ----
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8"));

test("manifest: MV3・権限は storage だけ・対象は YouTube だけ・host_permissions なし", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.background, undefined); // 常駐しない
  assert.deepEqual(manifest.content_scripts.map((c) => c.matches), [["https://www.youtube.com/*"]]);
});

test("manifest: 読み込む JS がすべて存在し、core が content より先", () => {
  const js = manifest.content_scripts[0].js;
  for (const f of js) assert.ok(existsSync(join(root, f)), f);
  assert.ok(js.indexOf("src/core.js") < js.indexOf("src/content.js"));
  assert.equal(js.at(-1), "src/content.js");
});

test("ソースにネットワーク送信・動的コード実行・HTML 文字列の挿入がない", () => {
  for (const f of manifest.content_scripts[0].js) {
    const src = readFileSync(join(root, f), "utf-8");
    for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /\beval\s*\(/, /new Function/, /\.innerHTML\s*=/, /insertAdjacentHTML/, /document\.write/]) {
      assert.ok(!bad.test(src), `${f}: ${bad}`);
    }
  }
});
