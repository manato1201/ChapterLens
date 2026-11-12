import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const core = require("../src/core.js");
const here = dirname(fileURLToPath(import.meta.url));

// ---- Python 版(topic-shift@2)との一致(合成データ) ----
const golden = JSON.parse(readFileSync(join(here, "golden", "golden.json"), "utf-8"));

for (const c of golden.cases) {
  for (const [key, expected] of Object.entries(c.expect)) {
    test(`golden: ${c.name} / ${key} が Python 版と一致する`, () => {
      const k = key === "free" ? undefined : Number(key.slice(1));
      const got = core.detect(c.cues, c.duration, { targetCount: k });
      assert.deepEqual(got.boundaries, expected.boundaries);
      assert.equal(got.scores.length, expected.scores.length);
      got.scores.forEach((s, i) => assert.ok(Math.abs(s - expected.scores[i]) < 1e-3, `score ${i}: ${s} vs ${expected.scores[i]}`));
    });
  }
}

// ---- 分かち書き(engine/text.py と同じ) ----
test("tokens: かな・漢字は 2 文字の組、英語は単語(短い語・ストップワードは除く)", () => {
  assert.deepEqual(core.tokens("機械学習"), ["機械", "械学", "学習"]);
  assert.deepEqual(core.tokens("The quick brown fox is Running"), ["quick", "brown", "fox", "running"]);
  assert.deepEqual(core.tokens("a"), []);
  assert.deepEqual(core.tokens(""), []);
  assert.deepEqual(core.tokens("日"), []); // 1 文字の連なりは捨てる
});

// ---- 書式 ----
test("formatTimestamp: m:ss と h:mm:ss", () => {
  assert.equal(core.formatTimestamp(0), "0:00");
  assert.equal(core.formatTimestamp(65.9), "1:05");
  assert.equal(core.formatTimestamp(3599), "59:59");
  assert.equal(core.formatTimestamp(3600), "1:00:00");
  assert.equal(core.formatTimestamp(3723), "1:02:03");
  assert.equal(core.formatTimestamp(-5), "0:00");
});

test("excerpt: 空白をつめ、長ければ「…」で切る(サロゲートペアも壊さない)", () => {
  assert.equal(core.excerpt("  hello   world  ", 24), "hello world");
  assert.equal(core.excerpt("あいうえおかきくけこ", 5), "あいうえお…");
  assert.equal(core.excerpt("𠮷田恵輔監督に聞く", 2), "𠮷田…");
});

// ---- 章 ----
const cues = [
  { start: 0, end: 30, text: "はじめに" },
  { start: 30, end: 100, text: "第一の話題" },
  { start: 100, end: 200, text: "第二の話題" },
  { start: 200, end: 300, text: "おわりに" },
];

test("buildChapters: 先頭は 0 秒・区間は連続・題名は最初の字幕", () => {
  const ch = core.buildChapters([100, 200], cues, 300);
  assert.deepEqual(ch.map((c) => [c.start, c.end]), [[0, 100], [100, 200], [200, 300]]);
  assert.deepEqual(ch.map((c) => c.title), ["はじめに", "第二の話題", "おわりに"]);
  // 範囲外・0 の境界は無視する
  assert.equal(core.buildChapters([0, 500, 100], cues, 300).length, 2);
});

test("descriptionText: YouTube の規則(3 つ以上・各 10 秒以上)を満たすときだけ", () => {
  const ch = core.buildChapters([100, 200], cues, 300);
  assert.equal(core.descriptionText(ch), "0:00 はじめに\n1:40 第二の話題\n3:20 おわりに");
  assert.equal(core.descriptionText(core.buildChapters([100], cues, 300)), null); // 2 つだけ
  assert.equal(core.descriptionText(core.buildChapters([5, 100], cues, 300)), null); // 5 秒の章
});

test("chapterIndexAt: 再生位置の章", () => {
  const ch = core.buildChapters([100, 200], cues, 300);
  assert.equal(core.chapterIndexAt(ch, 0), 0);
  assert.equal(core.chapterIndexAt(ch, 99.9), 0);
  assert.equal(core.chapterIndexAt(ch, 100), 1);
  assert.equal(core.chapterIndexAt(ch, 299), 2);
  assert.equal(core.chapterIndexAt(ch, 9999), 2);
});

test("targetCountFor: 粒度 → 区間数(自動は null)", () => {
  assert.equal(core.targetCountFor("auto", 3600), null);
  assert.equal(core.targetCountFor("standard", 3600), Math.round(3600 / 255) - 1);
  assert.ok(core.targetCountFor("fine", 3600) > core.targetCountFor("standard", 3600));
  assert.ok(core.targetCountFor("coarse", 3600) < core.targetCountFor("standard", 3600));
  assert.equal(core.targetCountFor("standard", 100), 0); // 短い動画は 0 個(= 章を作らない)
  assert.equal(core.targetCountFor("unknown", 3600), null);
});

test("cuesFromRows: 終わりは次の開始・最後は動画の終わり", () => {
  const cs = core.cuesFromRows([{ start: 1, text: "a" }, { start: 5, text: "b" }], 20);
  assert.deepEqual(cs, [{ start: 1, end: 5, text: "a" }, { start: 5, end: 20, text: "b" }]);
});

// ---- 退化した入力 ----
test("detect: 字幕なし・短すぎる・長さ 0 は境界なし(例外を出さない)", () => {
  assert.deepEqual(core.detect([], 600).boundaries, []);
  assert.deepEqual(core.detect(cues, 15).boundaries, []);
  assert.deepEqual(core.detect(cues, 0).boundaries, []);
});

// ---- 途中から聞いた字幕(音声の取り込み) ----
test("detectPartial: 先頭が空でも、空と内容の差を境界と誤らない。最初の字幕が 0 秒付近なら detect と同じ", () => {
  const T = [
    ["ギター", "弦", "コード", "演奏", "音色", "ピック", "指板", "リズム"],
    ["料理", "野菜", "包丁", "出汁", "味噌", "鍋", "火加減", "調味料"],
    ["天気", "気温", "湿度", "台風", "降水", "前線", "高気圧", "予報"],
  ];
  const cues = [];
  for (let t = 0; t < 360; t += 6) {
    const w = T[Math.floor(t / 120)];
    cues.push({ start: t, end: t + 6, text: Array.from({ length: 5 }, (_, i) => w[(t / 6 + i * 3) % w.length]).join("") + "について話します" });
  }
  assert.deepEqual(core.detectPartial(cues, 360).boundaries, core.detect(cues, 360).boundaries); // 0 秒始まりは同じ
  // 600 秒から聞き始めた(同じ内容を 600 秒ずらす)。本当の境界は 720・840
  const late = cues.map((c) => ({ ...c, start: c.start + 600, end: c.end + 600 }));
  const naive = core.detect(late, 960).boundaries;
  const part = core.detectPartial(late, 960).boundaries;
  assert.ok(naive.some((b) => b < 700), `素の detect は、空との差を境界にしてしまう: ${naive}`);
  assert.equal(part.length, 2);
  assert.ok(Math.abs(part[0] - 720) <= 12 && Math.abs(part[1] - 840) <= 12, `境界 ${part}`);
});

// ---- ダイジェスト(digest@1): Python 版との一致・飛び方・一致率 ----
for (const c of golden.cases) {
  for (const [key, expected] of Object.entries(c.digest || {})) {
    test(`golden: ${c.name} / digest ${key} が Python 版と一致する`, () => {
      const ratio = Number(key.slice(1));
      const bounds = c.expect.k3.boundaries; // Python 版が、この境界を入力にして作った
      const got = core.selectDigest(c.cues, bounds, c.duration, { ratio });
      assert.equal(got.length, expected.length);
      got.forEach((s, i) => {
        assert.equal(s.start, expected[i].start, `start ${i}`);
        assert.equal(s.end, expected[i].end, `end ${i}`);
        assert.equal(s.chapter, expected[i].chapter);
        assert.ok(Math.abs(s.score - expected[i].score) < 1e-3, `score ${i}`);
      });
    });
  }
}

test("selectDigest: 退化した入力は空(例外を出さない)", () => {
  assert.deepEqual(core.selectDigest([], [], 600), []);
  assert.deepEqual(core.selectDigest(cues, [], 0), []);
  assert.deepEqual(core.selectDigest(cues, [], 10), []);
  assert.deepEqual(core.selectDigest(cues, [], 300, { ratio: 0 }), []);
  assert.deepEqual(core.selectDigest([{ start: 0, end: 5, text: "yeah okay" }], [], 300), []);
});

test("digestNext: 区間の中は何もしない・すき間は次の区間の頭へ・最後の後ろは done", () => {
  const spans = [{ start: 10, end: 30 }, { start: 60, end: 80 }];
  assert.equal(core.digestNext(spans, 10), null);
  assert.equal(core.digestNext(spans, 29), null);
  assert.deepEqual(core.digestNext(spans, 0), { seekTo: 10 });          // 最初の前
  assert.deepEqual(core.digestNext(spans, 29.9), { seekTo: 60 });       // 終わりの直前(0.15 秒)は、もうすき間
  assert.deepEqual(core.digestNext(spans, 45), { seekTo: 60 });
  assert.equal(core.digestNext(spans, 70), null);
  assert.deepEqual(core.digestNext(spans, 80), { done: true });
  assert.deepEqual(core.digestNext(spans, 500), { done: true });
  assert.deepEqual(core.digestNext([], 5), { done: true });
});

test("digestAgreement: 時間の重なりで一致率(自動と、利用者の調整)", () => {
  const S = (start, end) => ({ start, end });
  assert.equal(core.digestAgreement([S(0, 10)], [S(0, 10)]).f1, 1);
  const r = core.digestAgreement([S(0, 10)], [S(5, 15)]);
  assert.deepEqual([r.precision, r.recall, r.f1], [0.5, 0.5, 0.5]);
  assert.equal(core.digestAgreement([S(0, 10)], [S(50, 60)]).f1, 0);
  assert.equal(core.digestAgreement([], []).f1, 1);
  assert.equal(core.digestAgreement([S(0, 10)], []).f1, 0);
  assert.equal(core.digestAgreement([S(0, 10), S(5, 10)], [S(0, 10)]).precision, 1); // 重なりは 1 つにまとめる
});

// ---- 章の調整(消す・動かす・足す) ----
test("normalizeBoundaries: 範囲外・近すぎ・数でないものを除き、昇順にする", () => {
  assert.deepEqual(core.normalizeBoundaries([300, 100, 102, 5, 2, -4, NaN, 600], 600), [5, 100, 300]); // 102 は 100 に近すぎ。600 は末尾から 5 秒未満
  assert.deepEqual(core.normalizeBoundaries([100, 200], 0), [100, 200]);                              // 長さ不明なら上限なし
  assert.deepEqual(core.normalizeBoundaries(["9", null, 50], 600), [50]);
});

test("removeBoundary / moveBoundary / addBoundary: 5 秒の最小間隔を守り、守れなければ null(元の列は変えない)", () => {
  const list = [100, 200, 300];
  assert.deepEqual(core.removeBoundary(list, 1), [100, 300]);
  assert.equal(core.removeBoundary(list, 3), null);
  assert.equal(core.removeBoundary(list, -1), null);
  assert.deepEqual(core.moveBoundary(list, 1, 5, 600), [100, 205, 300]);
  assert.deepEqual(core.moveBoundary(list, 0, -95, 600), [5, 200, 300]);   // 先頭から 5 秒はOK
  assert.equal(core.moveBoundary(list, 0, -96, 600), null);                 // 先頭から 5 秒未満
  assert.equal(core.moveBoundary(list, 1, 96, 600), null);                  // 次の境界に近すぎ
  assert.equal(core.moveBoundary(list, 2, 296, 600), null);                 // 末尾に近すぎ
  assert.equal(core.moveBoundary(list, 5, 1, 600), null);
  assert.equal(core.moveBoundary(list, 0, NaN, 600), null);
  assert.deepEqual(core.addBoundary(list, 150, 600), [100, 150, 200, 300]);
  assert.equal(core.addBoundary(list, 103, 600), null);                     // 既存に近すぎ
  assert.equal(core.addBoundary(list, 2, 600), null);
  assert.equal(core.addBoundary(list, 598, 600), null);
  assert.equal(core.addBoundary(list, NaN, 600), null);
  assert.deepEqual(list, [100, 200, 300]);                                  // 元は変わらない
});
