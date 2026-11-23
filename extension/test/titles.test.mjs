/*
 * 題名・大見出し(ローカル LLM)の画面の流れ: content.js を偽の chrome・偽のエンジンの上で動かす(helpers.mjs)。
 * エンジンの検証(作り話の数字を落とす)は Python 側のテスト。ここは、呼び方・反映・保存・中断・失敗時の挙動を確かめる。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadContent, threeTopicRows, flush } from "./helpers.mjs";

const KEY = (id = "vid1") => `chapterlens.v.${id}`;
const last = (page) => page.ui.chapters.at(-1);

function engineStub(overrides = {}) {
  const calls = { title: [], sections: [] };
  const fn = (method, path, body) => {
    if (path === "/v1/title") {
      calls.title.push(body);
      if (overrides.title) return overrides.title(body, calls.title.length);
      return { ok: true, status: 200, data: { title: `${calls.title.length} 番目の話をする`, title_by: "llm", rejected: 0 } };
    }
    if (path === "/v1/sections") {
      calls.sections.push(body);
      if (overrides.sections) return overrides.sections(body);
      const n = body.titles.length, mid = Math.ceil(n / 2);
      return { ok: true, status: 200, data: { sections: [{ heading: "前半", from: 0, to: mid - 1 }, { heading: "後半", from: mid, to: n - 1 }], rejected: 0 } };
    }
    return { ok: false, code: "unconfigured" };
  };
  return { fn, calls };
}

async function readyPage(stub, opts = {}) {
  const page = loadContent({ rows: threeTopicRows(), duration: 600, granularity: "fine", engine: stub.fn, ...opts });
  await page.ready();
  await page.handlers.onRun();
  await flush();
  return page;
}

async function generate(page) {
  await page.handlers.onTitles();
  await flush(20);
}

test("題名付け: 章ごとに /v1/title を呼び、出来た順に反映。最後に見出しを 1 回。結果を保存する", async () => {
  const stub = engineStub();
  const page = await readyPage(stub);
  const n = last(page).length;
  assert.ok(n >= 4, `章 ${n}`);
  await generate(page);
  assert.equal(stub.calls.title.length, n);
  assert.ok(stub.calls.title.every((b) => typeof b.text === "string" && b.text.length >= 20 && b.text.length <= 12000));
  assert.equal(stub.calls.title[1].prev_title, "1 番目の話をする"); // 直前の題名を渡す
  assert.deepEqual(last(page).map((c) => c.title), Array.from({ length: n }, (_, i) => `${i + 1} 番目の話をする`));
  assert.equal(stub.calls.sections.length, 1);
  assert.deepEqual(stub.calls.sections[0].titles, last(page).map((c) => c.title));
  assert.deepEqual(last(page).map((c) => c.section), last(page).map((_, i) => (i < Math.ceil(n / 2) ? 0 : 1)));
  assert.deepEqual(page.ui.chapterOpts.at(-1).sections.map((s) => s.heading), ["前半", "後半"]);
  const saved = (await page.area.get(KEY())) [KEY()];
  assert.equal(saved.generated.titles.length, n);
  assert.equal(saved.generated.sections.length, 2);
  const prog = page.ui.progress.at(-1);
  assert.equal(prog.running, false);
  assert.ok(page.ui.progress.some((p) => p.running && p.total === n && p.done >= 1));
});

test("題名付け: 利用者が直した題名は、呼び出しもせず・上書きもしない", async () => {
  const stub = engineStub();
  const page = await readyPage(stub);
  const n = last(page).length;
  page.handlers.onTitleEdit(1, "自分で付けた題名です");
  await generate(page);
  assert.equal(stub.calls.title.length, n - 1);
  assert.equal(last(page)[1].title, "自分で付けた題名です");
  assert.equal(stub.calls.sections[0].titles[1], "自分で付けた題名です");
});

test("題名付け: 検証に落ちた章(題名が空)は、規則の題名のまま", async () => {
  const stub = engineStub({ title: (_b, i) => ({ ok: true, status: 200, data: i === 2 ? { title: "", title_by: "rule", rejected: 2 } : { title: `${i} 番目の話をする`, title_by: "llm", rejected: 0 } }) });
  const page = await readyPage(stub);
  const rule = last(page).map((c) => c.title);
  await generate(page);
  assert.equal(last(page)[1].title, rule[1]); // 2 番目の呼び出し(i=2)は、章 index 1
  assert.equal(last(page)[0].title, "1 番目の話をする");
});

test("題名付け: 無効(403)・窓口が落ちている(502)・未設定では、案内を出し、基本の目次はそのまま", async () => {
  for (const [res, re] of [
    [{ ok: false, status: 403, error: "題名付け(ローカル LLM)は無効です。管理者が有効にしてください" }, /無効/],
    [{ ok: false, status: 502, error: "ローカル LLM(窓口)に接続できません。LocalLLMHarness を起動してください(uv run llh serve)" }, /llh serve/],
    [{ ok: false, code: "unconfigured" }, /アイコン/],
  ]) {
    const stub = engineStub({ title: () => res });
    const page = await readyPage(stub);
    const before = last(page).map((c) => c.title);
    await generate(page);
    assert.equal(stub.calls.title.length, 1, "最初の失敗で止める");
    assert.deepEqual(last(page).map((c) => c.title), before);
    assert.match(page.ui.status.at(-1).t, re);
    assert.equal(page.ui.status.at(-1).kind, "error");
    assert.equal(page.ui.progress.at(-1).running, false);
    assert.equal((await page.area.get(KEY()))[KEY()]?.generated, undefined);
  }
});

test("題名付け: 「止める」で、途中までを保存し、見出しは作らない", async () => {
  let page;
  const stub = engineStub({ title: (_b, i) => { if (i === 2) page.handlers.onTitlesStop(); return { ok: true, status: 200, data: { title: `${i} 番目の話をする`, title_by: "llm", rejected: 0 } }; } });
  page = await readyPage(stub);
  await generate(page);
  assert.equal(stub.calls.title.length, 2);
  assert.equal(stub.calls.sections.length, 0);
  const saved = (await page.area.get(KEY()))[KEY()];
  assert.equal(saved.generated.titles.length, 2);
  assert.deepEqual(saved.generated.sections, []);
  assert.equal(page.ui.progress.at(-1).running, false);
});

test("題名付け: 生成中に別の動画へ移ったら、以降の結果を捨て、前の動画へ保存しない", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let page;
  const stub = engineStub({ title: async (_b, i) => { if (i === 1) await gate; return { ok: true, status: 200, data: { title: `${i} 番目の話をする`, title_by: "llm", rejected: 0 } }; } });
  page = await readyPage(stub);
  const running = page.handlers.onTitles();
  await flush();
  page.navigate("vid2");
  await flush();
  release();
  await running;
  await flush(20);
  assert.equal(stub.calls.title.length, 1, "移った後は、次の章を呼ばない");
  assert.equal((await page.area.get(KEY("vid1")))[KEY("vid1")]?.generated, undefined);
  assert.equal(stub.calls.sections.length, 0);
});

test("題名付け: 保存済みの題名・見出しは、「目次を作る」で、エンジンを呼ばずに反映される", async () => {
  const first = await readyPage(engineStub());
  const starts = last(first).map((c) => c.start);
  const n = starts.length;
  const storage = { [KEY()]: { generated: { titles: starts.map((start, i) => ({ start, title: `保存した ${i} 番目の題名` })), sections: [{ heading: "前半", from: 0, to: 1 }, { heading: "後半", from: 2, to: n - 1 }], starts } } };
  const stub = engineStub();
  const page = await readyPage(stub, { storage });
  assert.equal(stub.calls.title.length + stub.calls.sections.length, 0);
  assert.equal(last(page)[0].title, "保存した 0 番目の題名");
  assert.deepEqual(last(page).slice(0, 3).map((c) => c.section), [0, 0, 1]);
});

test("題名付け: 章の調整で章の数が変わると、見出しは消える(題名は、開始時刻が合う章に残る)", async () => {
  const page = await readyPage(engineStub());
  await generate(page);
  const n = last(page).length;
  page.handlers.onChapterRemove(1);
  await flush();
  assert.equal(last(page).length, n - 1);
  assert.deepEqual(page.ui.chapterOpts.at(-1).sections ?? [], []);
  assert.ok(last(page).every((c) => c.section === null));
  assert.ok(/ 番目の話をする$/.test(last(page)[0].title));
});

test("題名付け: 概要欄用のコピーに、【見出し】の行が入る(見出しが無ければ従来どおり)", async () => {
  let copied = "";
  const page = await readyPage(engineStub(), { clipboard: (t) => { copied = t; } });
  await page.handlers.onCopy();
  assert.doesNotMatch(copied, /【/);
  await generate(page);
  await page.handlers.onCopy();
  assert.ok(copied.startsWith("【前半】\n0:00 "), copied);
  assert.ok(copied.includes("\n\n【後半】\n"), copied);
});

// ---- 最終レビューの指摘(I5: 章立てが変わったら、見出しを使わない) ----
test("題名付け: 章の境界を動かすと(章の数が同じでも)、大見出しは消える", async () => {
  const page = await readyPage(engineStub());
  await generate(page);
  assert.ok(page.ui.chapterOpts.at(-1).sections.length === 2);
  page.handlers.onChapterNudge(1, 5);
  await flush();
  assert.ok((page.ui.chapterOpts.at(-1).sections ?? []).length === 0);
  assert.ok(last(page).every((c) => c.section === null));
});

test("題名付け: 保存済みの見出しが、いまの章立て(開始時刻)と合わないときは、使わない", async () => {
  const first = await readyPage(engineStub());
  const starts = last(first).map((c) => c.start);
  const n = starts.length;
  const storage = { [KEY()]: { generated: {
    titles: starts.map((start, i) => ({ start, title: `保存した ${i} 番目の題名` })),
    sections: [{ heading: "前半", from: 0, to: 1 }, { heading: "後半", from: 2, to: n - 1 }],
    starts: starts.map((t) => t + 30), // 別の粒度で作った見出し
  } } };
  const page = await readyPage(engineStub(), { storage });
  assert.ok((page.ui.chapterOpts.at(-1).sections ?? []).length === 0);
  assert.equal(last(page)[0].title, "保存した 0 番目の題名", "題名は、開始時刻が合うので残る");
});

test("題名付け: 題名を付けている間は、章の編集・粒度の変更・目次の作り直しを受け付けない", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const stub = engineStub({ title: async (_b, i) => { if (i === 1) await gate; return { ok: true, status: 200, data: { title: `${i} 番目の話をする`, title_by: "llm", rejected: 0 } }; } });
  const page = await readyPage(stub);
  const starts = last(page).map((c) => c.start);
  const running = page.handlers.onTitles();
  await flush();
  page.handlers.onChapterNudge(1, 5);
  page.handlers.onChapterRemove(1);
  page.handlers.onGranularity("coarse");
  await page.handlers.onRun();
  assert.deepEqual(last(page).map((c) => c.start), starts, "章立ては変わらない");
  assert.equal(page.ui.chapterOpts.at(-1).editable, false);
  assert.match(page.ui.status.at(-1).t, /題名を付けている/);
  release();
  await running;
  await flush(20);
  assert.equal(page.ui.chapterOpts.at(-1).editable, true, "終わったら、また直せる");
});
