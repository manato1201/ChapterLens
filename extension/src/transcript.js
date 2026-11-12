/*
 * ソース・アダプタ(設計書 §3): 「字幕をどこから取るか」を、ここ 1 か所に閉じ込める。
 *
 * YouTube のページが見せている「文字起こし」パネルを読む(利用者が自分で開いて読むのと同じ操作)。
 * 字幕ファイル(timedtext)を直接取りに行く経路は、サイト側に止められるので使わない。
 * YouTube の画面の作りが変わると壊れるのは、このファイルのセレクタだけ。壊れたら黙って誤った結果を出さず、
 * 理由つきのエラー(code)で知らせる。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChapterLensTranscript = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SEL = {
    descriptionExpand: ["tp-yt-paper-button#expand", "#expand"],
    transcriptButton: "ytd-video-description-transcript-section-renderer button",
    segment: "transcript-segment-view-model",
    timestamp: ".ytwTranscriptSegmentViewModelTimestamp",
    text: ".ytAttributedStringHost",
  };

  /** "1:23" / "1:02:03" → 秒。読めなければ null。 */
  function parseTimestamp(text) {
    const parts = String(text).trim().split(":");
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
    return parts.map(Number).reduce((a, b) => a * 60 + b, 0);
  }

  /** [{timestamp: "0:15", text: "..."}] → [{start, text}]。時刻の読めない行・空の行は除く。 */
  function rowsFromPairs(pairs) {
    const rows = [];
    for (const p of pairs) {
      const start = parseTimestamp(p.timestamp);
      const text = String(p.text || "").replace(/\s+/g, " ").trim();
      if (start !== null && text) rows.push({ start, text });
    }
    return rows;
  }

  function readSegments(doc) {
    const pairs = [];
    for (const el of doc.querySelectorAll(SEL.segment)) {
      pairs.push({
        timestamp: el.querySelector(SEL.timestamp)?.textContent || "",
        text: el.querySelector(SEL.text)?.textContent || "",
      });
    }
    return rowsFromPairs(pairs);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fail(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  /**
   * 文字起こしを読む。パネルがまだ開いていなければ、概要欄を開いて「文字起こしを表示」を押す。
   * 失敗: code = "no-button"(文字起こしが無い動画)/ "timeout"(開いたが行が出ない)/ "empty"(行が 0)。
   */
  async function loadTranscript(doc, options) {
    const timeoutMs = (options && options.timeoutMs) || 15000;
    let rows = readSegments(doc);
    if (rows.length === 0) {
      for (const sel of SEL.descriptionExpand) {
        const expand = doc.querySelector(sel);
        if (expand) { expand.click(); break; }
      }
      await sleep(600);
      const button = doc.querySelector(SEL.transcriptButton);
      if (!button) throw fail("no-button", "文字起こしを開くボタンが見つかりません");
      button.click();
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        await sleep(500);
        if (doc.querySelector(SEL.segment)) break;
      }
      if (!doc.querySelector(SEL.segment)) throw fail("timeout", "文字起こしの行が表示されませんでした");
      await sleep(1000); // 行が出そろうのを待つ
      rows = readSegments(doc);
    }
    if (rows.length === 0) throw fail("empty", "文字起こしが空です");
    return rows;
  }

  return { SEL, parseTimestamp, rowsFromPairs, readSegments, loadTranscript };
});
