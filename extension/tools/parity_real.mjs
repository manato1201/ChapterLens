// 実データ(engine/dataset)で、JavaScript 版と Python 版(topic-shift@2)の境界が一致するかを確かめる。
// ローカル専用: 他人の字幕を含む results/parity_python.json を読む(コミットしない)。
//   先に:  (engine) uv run python tools/export_golden.py real
//   実行:  (extension) node tools/parity_real.mjs
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const core = require("../src/core.js");
const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, "..", "..", "engine", "results", "parity_python.json");
if (!existsSync(path)) {
  console.error("results/parity_python.json がありません。先に engine で export_golden.py real を実行してください。");
  process.exit(2);
}
const rows = JSON.parse(readFileSync(path, "utf-8"));

let total = 0;
let exact = 0;
const diffs = [];
for (const r of rows) {
  for (const [key, k] of [["free", undefined], ["k6", 6]]) {
    total++;
    const got = core.detect(r.cues, r.duration, { targetCount: k });
    const want = r[key].boundaries;
    const same = got.boundaries.length === want.length && got.boundaries.every((b, i) => b === want[i]);
    if (same) exact++;
    else diffs.push({ id: r.id, key, got: got.boundaries.length, want: want.length, firstDiff: got.boundaries.find((b, i) => b !== want[i]) });
  }
}
// ダイジェスト(k6 の境界を入力に)
let dTotal = 0, dExact = 0;
for (const r of rows) {
  if (!r.digest) continue;
  dTotal++;
  const got = core.selectDigest(r.cues, r.k6.boundaries, r.duration);
  const same = got.length === r.digest.length && got.every((s, i) => s.start === r.digest[i].start && s.end === r.digest[i].end && s.chapter === r.digest[i].chapter);
  if (same) dExact++;
  else diffs.push({ id: r.id, key: "digest", got: got.length, want: r.digest.length });
}
if (dTotal) console.log(`ダイジェスト ${dTotal} 本: 完全一致 ${dExact} / 不一致 ${dTotal - dExact}`);
console.log(`実データ ${rows.length} 本 × 2 モード = ${total} 通り: 完全一致 ${exact} / 不一致 ${total - exact}`);
for (const d of diffs.slice(0, 10)) console.log("  不一致:", JSON.stringify(d));
process.exit(diffs.length === 0 ? 0 : 1);
