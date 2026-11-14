// 画面の動きの規則: 無限ループを足さない・動きは「動きを減らす設定」で止まる・動かす性質は transform と opacity だけ。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../src/ui.js", import.meta.url)), "utf8");
const section = src.slice(src.indexOf("ちいさな遊び"), src.indexOf("`;", src.indexOf("ちいさな遊び")));

test("the playful motion section exists and never loops forever", () => {
  assert.ok(section.length > 300);
  assert.ok(!/infinite/.test(section));
});

test("every animation and transition sits inside prefers-reduced-motion: no-preference", () => {
  const guardStart = section.indexOf("@media (prefers-reduced-motion: no-preference)");
  assert.ok(guardStart >= 0);
  // ガードのブロックの終わり(@keyframes の直前)までが「動きの規則」。keyframes の外で、animation / transition を使わない
  const firstKeyframes = section.indexOf("@keyframes");
  const outsideGuard = section.slice(0, guardStart) + section.slice(firstKeyframes);
  const keyframesFree = outsideGuard.replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})+[^{}]*\}/g, "");
  assert.ok(!/animation\s*:|transition\s*:/.test(keyframesFree), keyframesFree);
});

test("keyframes move only transform and opacity", () => {
  const frames = [...section.matchAll(/@keyframes\s+[\w-]+\s*\{((?:[^{}]*\{[^{}]*\})+[^{}]*)\}/g)].map((m) => m[1]);
  assert.ok(frames.length >= 3);
  for (const body of frames) {
    for (const decl of body.matchAll(/\{([^}]*)\}/g)) {
      for (const prop of decl[1].split(";").map((d) => d.split(":")[0].trim()).filter(Boolean)) {
        assert.ok(["transform", "opacity"].includes(prop), `動かしてはいけない性質: ${prop}`);
      }
    }
  }
});
