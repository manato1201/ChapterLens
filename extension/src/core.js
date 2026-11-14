/*
 * ChapterLens core(CH1): 字幕から話題の切り替えを検出する。
 *
 * engine/src/chapterlens/detectors/topic_shift.py(topic-shift@2)の JavaScript 版。
 * **同じ入力で同じ境界を返すこと**が条件で、test/golden.test.mjs が Python 版の出力と突き合わせる。
 * 依存なし・DOM なし(拡張でも Node でも動く)。
 *
 * 字幕(cue)= { start: 開始秒, end: 終了秒, text }。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChapterLensCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- 分かち書き(engine/text.py と同じ) ----------
  const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]+/g;
  const LATIN_WORD = /[a-z][a-z0-9']+/g;
  const STOP = new Set(
    ("the and that this with for you are was have not but what all can will from they there about " +
      "would which their just like going gonna here then when your into some them one out has had were been " +
      "its it's i'm you're that's don't can't let's also very really right okay yeah well now get got").split(/\s+/)
  );

  function tokens(text) {
    const out = [];
    const lowered = text.toLowerCase();
    for (const run of lowered.match(CJK_RUN) || []) {
      if (run.length === 1) continue;
      for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    }
    for (const word of lowered.replace(CJK_RUN, " ").match(LATIN_WORD) || []) {
      if (word.length >= 3 && !STOP.has(word)) out.push(word);
    }
    return out;
  }

  function termCounts(text) {
    const m = new Map();
    for (const t of tokens(text)) m.set(t, (m.get(t) || 0) + 1);
    return m;
  }

  function addCounts(total, counts) {
    for (const [t, c] of counts) total.set(t, (total.get(t) || 0) + c);
  }

  // ---------- 類似度 ----------
  function cosine(a, b) {
    if (a.size === 0 || b.size === 0) return 1.0; // 片側が空なら、切り替えの根拠が無い
    if (a.size > b.size) [a, b] = [b, a];
    let dot = 0;
    for (const [t, v] of a) dot += v * (b.get(t) || 0);
    let na = 0;
    for (const v of a.values()) na += v * v;
    let nb = 0;
    for (const v of b.values()) nb += v * v;
    na = Math.sqrt(na);
    nb = Math.sqrt(nb);
    return na && nb ? dot / (na * nb) : 1.0;
  }

  function smooth(values, width) {
    if (width <= 1) return values.slice();
    const half = Math.floor(width / 2);
    return values.map((_, i) => {
      const lo = Math.max(0, i - half);
      const hi = Math.min(values.length, i + half + 1);
      let s = 0;
      for (let j = lo; j < hi; j++) s += values[j];
      return s / (hi - lo);
    });
  }

  function depthScores(sims) {
    return sims.map((s, i) => {
      let left = i;
      while (left > 0 && sims[left - 1] >= sims[left]) left--;
      let right = i;
      while (right < sims.length - 1 && sims[right + 1] >= sims[right]) right++;
      return sims[left] - s + (sims[right] - s);
    });
  }

  // ---------- 二分探索(Python の bisect と同じ意味) ----------
  function bisectLeft(a, x) {
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  function bisectRight(a, x) {
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (x < a[mid]) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  // ---------- 置き直しの準備(字幕 1 つ単位の語と IDF) ----------
  class PreparedCues {
    constructor(cues) {
      this.starts = cues.map((c) => c.start);
      this.counts = cues.map((c) => termCounts(c.text));
      const df = new Map();
      for (const c of this.counts) for (const t of c.keys()) df.set(t, (df.get(t) || 0) + 1);
      const n = Math.max(1, cues.length);
      this.idf = new Map();
      for (const [t, k] of df) this.idf.set(t, Math.log((n + 1) / (k + 1)) + 1.0);
    }
    vector(lo, hi) {
      const total = new Map();
      for (let i = lo; i < hi; i++) addCounts(total, this.counts[i]);
      const v = new Map();
      for (const [t, c] of total) v.set(t, (1.0 + Math.log(c)) * this.idf.get(t));
      return v;
    }
  }

  function refineBoundaries(boundaries, prepared, radiusS, windowS, minGapS) {
    const starts = prepared.starts;
    const out = [];
    for (const b of boundaries) {
      const loI = bisectLeft(starts, b - radiusS);
      const hiI = bisectRight(starts, b + radiusS);
      let bestT = b;
      let bestSim = null;
      for (let i = loI; i < hiI; i++) {
        const t = starts[i];
        const left = prepared.vector(bisectLeft(starts, t - windowS), i);
        const right = prepared.vector(i, bisectLeft(starts, t + windowS));
        if (left.size === 0 || right.size === 0) continue;
        const sim = cosine(left, right);
        // 同点なら、元の位置に近いほう
        if (
          bestSim === null ||
          sim < bestSim - 1e-9 ||
          (Math.abs(sim - bestSim) <= 1e-9 && Math.abs(t - b) < Math.abs(bestT - b))
        ) {
          bestT = t;
          bestSim = sim;
        }
      }
      out.push(bestT);
    }
    out.sort((x, y) => x - y);
    const kept = [];
    for (const t of out) if (kept.length === 0 || t - kept[kept.length - 1] >= minGapS) kept.push(t);
    return kept;
  }

  // ---------- 類似度の曲線 ----------
  function numBins(durationS, stepS) {
    return durationS > 0 ? Math.ceil(durationS / stepS) : 0;
  }
  function binIndex(startS, stepS, nbins) {
    return Math.min(nbins - 1, Math.max(0, Math.floor(startS / stepS)));
  }

  function similarityCurve(cues, durationS, stepS, windowBins) {
    const nbins = numBins(durationS, stepS);
    if (nbins < 3 || cues.length === 0) return [];
    const bins = Array.from({ length: nbins }, () => new Map());
    for (const cue of cues) addCounts(bins[binIndex(cue.start, stepS, nbins)], termCounts(cue.text));

    const df = new Map();
    for (const b of bins) for (const t of b.keys()) df.set(t, (df.get(t) || 0) + 1);
    const idf = new Map();
    for (const [t, n] of df) idf.set(t, Math.log((nbins + 1) / (n + 1)) + 1.0);

    const vector = (lo, hi) => {
      const total = new Map();
      for (let i = lo; i < hi; i++) addCounts(total, bins[i]);
      const v = new Map();
      for (const [t, c] of total) v.set(t, (1.0 + Math.log(c)) * idf.get(t));
      return v;
    };
    const w = windowBins;
    const curve = [];
    for (let g = 1; g < nbins; g++) curve.push(cosine(vector(Math.max(0, g - w), g), vector(g, Math.min(nbins, g + w))));
    return curve;
  }

  // ---------- 境界の選択 ----------
  /** 境界を、近くの字幕の開始時刻に寄せる(話題の変わり目は、たいてい発話の頭)。 */
  function snap(t, starts, stepS) {
    const i = bisectLeft(starts, t);
    let best = null;
    for (const j of [i - 1, i]) {
      if (j >= 0 && j < starts.length && Math.abs(starts[j] - t) <= stepS / 2) {
        if (best === null || Math.abs(starts[j] - t) < Math.abs(best - t)) best = starts[j];
      }
    }
    return best !== null ? best : t;
  }

  const round3 = (x) => Math.round(x * 1000) / 1000;

  function selectBoundaries(sims, cues, durationS, p, targetCount, prepared) {
    if (sims.length === 0) return { boundaries: [], scores: [] };
    const nbins = sims.length + 1;
    const depths = depthScores(smooth(sims, p.smoothBins));
    let maxDepth = -Infinity;
    for (const d of depths) if (d > maxDepth) maxDepth = d;
    if (!(maxDepth > 0)) return { boundaries: [], scores: [] };

    const cutTime = (g) => g * p.stepS;
    let candidates = [];
    for (let g = 1; g < nbins; g++) {
      if (cutTime(g) >= p.minGapS && cutTime(g) <= durationS - p.minGapS && depths[g - 1] > 0) candidates.push([depths[g - 1], g]);
    }
    // Python の candidates.sort(reverse=True) と同じ: 深さの降順、同じなら g の降順
    candidates.sort((a, b) => b[0] - a[0] || b[1] - a[1]);

    let limit = null;
    if (targetCount === null || targetCount === undefined) {
      const mean = depths.reduce((s, d) => s + d, 0) / depths.length;
      const std = Math.sqrt(depths.reduce((s, d) => s + (d - mean) * (d - mean), 0) / depths.length);
      const threshold = Math.max(mean + p.alpha * std, p.minDepth);
      candidates = candidates.filter((c) => c[0] > threshold);
    } else {
      limit = Math.max(0, targetCount);
    }

    const starts = cues.map((c) => c.start);
    const chosen = []; // [時刻, depth]
    for (const [depth, g] of candidates) {
      if (limit !== null && chosen.length >= limit) break;
      const t = snap(cutTime(g), starts, p.stepS);
      if (chosen.every(([other]) => Math.abs(t - other) >= p.minGapS)) chosen.push([t, depth]);
    }
    chosen.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let times = chosen.map((c) => c[0]);
    let scores = chosen.map((c) => round3(Math.min(1.0, c[1] / maxDepth)));
    if (p.refineRadiusS > 0 && times.length > 0) {
      const moved = refineBoundaries(times, prepared || new PreparedCues(cues), p.refineRadiusS, p.refineWindowS, p.minGapS);
      if (moved.length === times.length) times = moved;
      else {
        times = moved;
        scores = scores.slice(0, moved.length);
      }
    }
    return { boundaries: times.map(round3), scores };
  }

  /** topic-shift@2 の既定(engine の V2_PARAMS と同じ)。 */
  const V2_PARAMS = Object.freeze({
    stepS: 10, windowBins: 8, smoothBins: 3, minGapS: 60, alpha: 0, minDepth: 0.1,
    refineRadiusS: 10, refineWindowS: 45,
  });

  /** 字幕から境界を検出する。targetCount を渡すと、その数だけ選ぶ(粒度の指定)。 */
  function detect(cues, durationS, options) {
    const opts = options || {};
    const p = Object.assign({}, V2_PARAMS, opts.params || {});
    const sims = similarityCurve(cues, durationS, p.stepS, p.windowBins);
    return selectBoundaries(sims, cues, durationS, p, opts.targetCount === undefined ? null : opts.targetCount, opts.prepared);
  }

  /**
   * 途中から聞いた(取り込んだ)字幕の検出。最初の字幕より前は「空」なので、そのまま検出すると
   * 「空 → 内容」の差を話題の切り替えと誤る。最初の字幕を 0 秒に詰めてから検出し、境界を元の時刻へ戻す。
   * 最初の字幕が 0 秒付近なら、detect と同じ。
   */
  function detectPartial(cues, durationS, options) {
    const first = cues.length ? Math.min(...cues.map((c) => c.start)) : 0;
    if (first <= 1) return detect(cues, durationS, options);
    const shifted = cues.map((c) => ({ start: c.start - first, end: c.end - first, text: c.text }));
    const det = detect(shifted, durationS - first, options);
    return Object.assign({}, det, { boundaries: det.boundaries.map((b) => b + first) });
  }

  // ---------- 粒度・章・書式(拡張の画面で使う) ----------
  /**
   * 利用者が選ぶ「粒度」。区間数 = round(動画の長さ ÷ segLenS) - 1。
   * 投稿者のチャプター数は 6〜70 とばらつくので、見積もりは当たらない。だから自動(auto)のほかに、
   * 利用者が選べるようにした。segLenS は仮の値(評価データ 39 本の 1 区間の長さの中央値 255 秒を基準に、約 1.6 倍・0.6 倍)。
   */
  const GRANULARITY = Object.freeze({
    auto: { label: "自動", segLenS: null },
    coarse: { label: "粗い", segLenS: 420 },
    standard: { label: "標準", segLenS: 255 },
    fine: { label: "細かい", segLenS: 150 },
  });

  function targetCountFor(granularityKey, durationS) {
    const g = GRANULARITY[granularityKey];
    if (!g || g.segLenS === null) return null;
    return Math.max(0, Math.round(durationS / g.segLenS) - 1);
  }

  function formatTimestamp(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  /** 区間の題名: その区間の最初の字幕の冒頭(CH1 は規則だけ。要約はしない)。 */
  function excerpt(text, maxChars) {
    const t = text.replace(/\s+/g, " ").trim();
    const chars = Array.from(t);
    return chars.length > maxChars ? chars.slice(0, maxChars).join("") + "…" : t;
  }

  // ---------- 題名: その章で「よく出て、他の章では出ない」言葉を並べる(要約ではなく、手がかりの語) ----------
  // 字幕の冒頭(「こんにちは。こんにちは。…」)では、どの場面か分からない。章ごとの特徴語を、TF-IDF で選んで題名にする。
  const TERM_KATA = /[ァ-ヴー]{3,}/g;
  const TERM_KANJI = /[一-鿿々]{2,}/g;
  const TERM_LATIN = /[A-Za-z][A-Za-z0-9+#.]{1,}|[0-9]+[A-Za-z]{1,}/g;
  // どの章にも出る、題名の手がかりにならない言葉(多くの章に出れば idf で下がるが、章が少ないときの保険)
  const GENERIC_TERMS = new Set(
    ("今日 自分 本当 結構 全然 一番 最初 最後 今回 動画 皆さん 感じ 意味 問題 時間 部分 場合 普通 完全 絶対 大丈夫 " +
      "ありがとう こんにちは こんばんは お願い 今度 全部 一応 気持ち 人間 something just very really thing things").split(/\s+/)
  );

  function candidateTerms(text) {
    const out = new Map(); // 小文字 → { shown, count }
    const add = (raw) => {
      const key = raw.toLowerCase();
      if (GENERIC_TERMS.has(key) || STOP.has(key) || /^[0-9.]+$/.test(key)) return;
      const e = out.get(key);
      if (e) e.count++;
      else out.set(key, { shown: raw, count: 1 });
    };
    for (const m of text.match(TERM_KATA) || []) add(m);
    for (const m of text.match(TERM_KANJI) || []) add(m);
    for (const m of text.match(TERM_LATIN) || []) add(m.replace(/\.+$/, ""));
    return out;
  }

  /** sections: [{ text, cues }] → [{ title, snippet }]。章が 1 つなら idf が働かないので、出現数だけで選ぶ。 */
  function labelSections(sections) {
    const per = sections.map((sec) => candidateTerms(sec.text));
    const N = per.length;
    const df = new Map();
    for (const terms of per) for (const k of terms.keys()) df.set(k, (df.get(k) || 0) + 1);
    return sections.map((sec, i) => {
      const scored = [];
      for (const [k, e] of per[i]) {
        const idf = N > 1 ? Math.log(1 + N / df.get(k)) : 1;
        scored.push({ k, shown: e.shown, score: e.count * idf * (1 + 0.12 * Math.min(Array.from(k).length, 8)) });
      }
      scored.sort((x, y) => y.score - x.score || x.k.localeCompare(y.k));
      const picked = [];
      for (const t of scored) {
        if (picked.length >= 3) break;
        if (picked.some((p) => p.k.includes(t.k) || t.k.includes(p.k))) continue; // 「モデル」と「3Dモデル」のような重なりは 1 つに
        picked.push(t);
      }
      let title = "";
      for (const t of picked) {
        const next = title ? `${title}・${t.shown}` : t.shown;
        if (Array.from(next).length > 28 && title) break;
        title = next;
      }
      // 代表の 1 文: 特徴語をいちばん含む、10〜60 文字の字幕
      const weight = new Map(picked.map((t) => [t.k, t.score]));
      let best = null, bestScore = 0;
      for (const cue of sec.cues) {
        const len = Array.from(cue.text.trim()).length;
        if (len < 10 || len > 60) continue;
        const low = cue.text.toLowerCase();
        let sc = 0;
        for (const [k, w] of weight) if (low.includes(k)) sc += w;
        sc = sc / Math.sqrt(len);
        if (sc > bestScore) { bestScore = sc; best = cue; }
      }
      return { title, snippet: best ? excerpt(best.text, 40) : "" };
    });
  }

  /** 境界の時刻の列 → 章の一覧。先頭は 0 秒。title は章の特徴語(無ければ最初の字幕の冒頭)、snippet は代表の 1 文。 */
  function buildChapters(boundaries, cues, durationS) {
    const starts = [0, ...boundaries.filter((b) => b > 0 && b < durationS)];
    const chapters = [];
    const sections = [];
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      const end = i + 1 < starts.length ? starts[i + 1] : durationS;
      const inside = cues.filter((c) => c.start >= start - 1e-6 && c.start < end - 1e-6);
      const first = cues.find((c) => c.start >= start - 1e-6);
      chapters.push({ start, end, title: first ? excerpt(first.text, 24) : "", snippet: "" });
      sections.push({ text: inside.map((c) => c.text).join(" "), cues: inside });
    }
    const labels = labelSections(sections);
    labels.forEach((l, i) => {
      if (l.title) chapters[i].title = l.title;
      chapters[i].snippet = l.snippet;
    });
    return chapters;
  }

  /** YouTube の概要欄に貼れる形(先頭 0:00・3 つ以上・各 10 秒以上)。満たせないときは null。 */
  function descriptionText(chapters) {
    if (chapters.length < 3) return null;
    if (chapters.some((c) => c.end - c.start < 10)) return null;
    return chapters.map((c) => `${formatTimestamp(c.start)} ${c.title || "チャプター"}`).join("\n");
  }

  // ---------- 書き出し・検索・題名の上書き(画面の外でも使える純粋な関数) ----------
  function srtTime(sec, comma) {
    const ms = Math.max(0, Math.round(sec * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
    const p = (n, w) => String(n).padStart(w, "0");
    return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)}${comma ? "," : "."}${p(r, 3)}`;
  }
  /** 字幕 → SRT(番号つき・カンマ区切りの時刻)。 */
  function srtText(cues) {
    return cues.map((c, i) => `${i + 1}\n${srtTime(c.start, true)} --> ${srtTime(c.end, true)}\n${c.text.trim()}\n`).join("\n");
  }
  /** 字幕 → WebVTT。 */
  function vttText(cues) {
    return "WEBVTT\n\n" + cues.map((c) => `${srtTime(c.start, false)} --> ${srtTime(c.end, false)}\n${c.text.trim()}\n`).join("\n");
  }
  /** 章 → Markdown(見出し・時刻・代表の 1 文)。videoUrl があれば、時刻を、その位置へ飛ぶリンクにする。 */
  function markdownText(chapters, opts) {
    const o = opts || {};
    const lines = [];
    if (o.heading) lines.push(`# ${o.heading}`, "");
    for (const c of chapters) {
      const t = formatTimestamp(c.start);
      const link = o.videoUrl ? `[${t}](${o.videoUrl}${o.videoUrl.includes("?") ? "&" : "?"}t=${Math.floor(c.start)}s)` : t;
      lines.push(`## ${link} ${c.title || "チャプター"}`);
      if (c.snippet) lines.push("", `> ${c.snippet}`);
      lines.push("");
    }
    return lines.join("\n").trimEnd() + "\n";
  }
  /** 字幕の中から、語を含む行を探す(大文字小文字・全角半角の差は無視)。最大 limit 件。 */
  function searchCues(cues, query, limit) {
    const q = String(query || "").normalize("NFKC").toLowerCase().trim();
    if (!q) return [];
    const out = [];
    for (const c of cues || []) {
      if (c.text.normalize("NFKC").toLowerCase().includes(q)) {
        out.push({ start: c.start, text: c.text.trim() });
        if (out.length >= (limit || 50)) break;
      }
    }
    return out;
  }
  /** 利用者が付けた題名([{start, title}])を、開始時刻が 1 秒以内の章へ当てる。 */
  function applyTitleOverrides(chapters, overrides) {
    if (!overrides || overrides.length === 0) return chapters;
    return chapters.map((c) => {
      const o = overrides.find((x) => Math.abs(x.start - c.start) <= 1);
      return o && o.title ? Object.assign({}, c, { title: o.title, custom: true }) : c;
    });
  }

  /** いま再生中の章の番号(二分探索)。 */
  function chapterIndexAt(chapters, t) {
    let lo = 0, hi = chapters.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chapters[mid].start <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  /** 文字起こしの行 [{start, text}] → cue(終わりは次の開始。最後は動画の終わり)。 */
  function cuesFromRows(rows, durationS) {
    return rows.map((r, i) => ({
      start: r.start,
      end: i + 1 < rows.length ? rows[i + 1].start : Math.max(r.start, durationS),
      text: r.text,
    }));
  }

  // ---------- ダイジェスト(CH4。engine/digest.py の digest@1 の JavaScript 版) ----------
  const REST_EPS = 1e-12;
  const DIGEST = Object.freeze({ unitS: 15, ratio: 0.2, wInfo: 0.5, wCentral: 0.5, wLead: 0.25, minSpanS: 5, endSlackS: 5 });

  function cosineOrZero(a, b) {
    return a.size === 0 || b.size === 0 ? 0 : cosine(a, b); // 片側が空なら重なりは 0(検出器の cosine は 1)
  }

  /**
   * 重要な区間 [{start, end, score, chapter}](昇順・重ならない)。動画は切り出さず、飛ぶための区間リストだけ。
   * 手順は digest.py と同じ(15 秒のかたまりを、情報量・章の代表性・章の導入で採点 → 各章の最高点 → 点の高い順に予算まで →
   * 1 つ空いたすき間を埋めて連続をまとめる)。
   */
  function selectDigest(cues, boundaries, durationS, options) {
    const o = Object.assign({}, DIGEST, options || {});
    const unitS = o.unitS;
    const n = durationS > 0 ? Math.ceil(durationS / unitS) : 0;
    if (n < 2 || cues.length === 0 || !(o.ratio > 0 && o.ratio <= 1)) return [];

    const unitCues = Array.from({ length: n }, () => []);
    const counts = Array.from({ length: n }, () => new Map());
    for (const cue of cues) {
      const u = Math.min(n - 1, Math.max(0, Math.floor(cue.start / unitS)));
      unitCues[u].push(cue);
      addCounts(counts[u], termCounts(cue.text));
    }
    const df = new Map();
    for (const c of counts) for (const t of c.keys()) df.set(t, (df.get(t) || 0) + 1);
    const idf = new Map();
    for (const [t, k] of df) idf.set(t, Math.log((n + 1) / (k + 1)) + 1.0);
    const vectors = counts.map((unit) => {
      const v = new Map();
      for (const [t, c] of unit) v.set(t, (1.0 + Math.log(c)) * idf.get(t));
      return v;
    });
    const info = vectors.map((v) => { let s = 0; for (const x of v.values()) s += x; return s; });
    let top = 0;
    for (const x of info) if (x > top) top = x;
    if (!(top > 0)) return [];

    const cuts = boundaries.filter((b) => b > 0 && b < durationS).sort((a, b) => a - b);
    const chapter = Array.from({ length: n }, (_, i) => bisectRight(cuts, (i + 0.5) * unitS));
    const members = new Map();
    chapter.forEach((ch, i) => { if (!members.has(ch)) members.set(ch, []); members.get(ch).push(i); });

    const score = new Array(n).fill(0);
    for (const idxs of members.values()) {
      const total = new Map(); // 章の合計。「自分以外」は、ここから自分を引いて作る(digest.py と同じ)
      for (const j of idxs) for (const [t, x] of vectors[j]) total.set(t, (total.get(t) || 0) + x);
      idxs.forEach((i, pos) => {
        if (info[i] <= 0) return;
        const others = new Map();
        for (const [t, x] of total) {
          const rest = x - (vectors[i].get(t) || 0);
          if (rest > REST_EPS) others.set(t, rest);
        }
        score[i] = o.wInfo * (info[i] / top) + o.wCentral * cosineOrZero(vectors[i], others) + (pos === 0 ? o.wLead : 0);
      });
    }

    const budget = Math.max(1, Math.floor(o.ratio * n + 0.5));
    const ranked = [];
    for (let i = 0; i < n; i++) if (info[i] > 0) ranked.push(i);
    ranked.sort((a, b) => score[b] - score[a] || a - b);
    const perChapter = [];
    for (const ch of [...members.keys()].sort((a, b) => a - b)) {
      const best = ranked.find((i) => chapter[i] === ch);
      if (best !== undefined) perChapter.push(best);
    }
    perChapter.sort((a, b) => score[b] - score[a] || a - b);
    const taken = new Set(perChapter.slice(0, budget));
    let count = taken.size;
    for (const i of ranked) {
      if (count >= budget) break;
      if (!taken.has(i)) { taken.add(i); count++; }
    }
    const picked = [...taken].sort((a, b) => a - b);
    if (picked.length === 0) return [];

    const groups = [[picked[0]]];
    for (const i of picked.slice(1)) {
      const g = groups[groups.length - 1];
      if (i - g[g.length - 1] <= 2) { for (let k = g[g.length - 1] + 1; k <= i; k++) g.push(k); }
      else groups.push([i]);
    }
    const spans = [];
    for (const g of groups) {
      const inSpan = g.flatMap((u) => unitCues[u]);
      if (inSpan.length === 0) continue;
      const start = Math.min(...inSpan.map((c) => c.start));
      const end = Math.min(Math.max(...inSpan.map((c) => c.end)), (g[g.length - 1] + 1) * unitS + o.endSlackS, durationS);
      if (end - start < o.minSpanS) continue;
      const s = Math.max(...g.map((u) => score[u]));
      spans.push({ start: round3(start), end: round3(end), score: round3(Math.min(1.0, s)), chapter: chapter[g[0]] });
    }
    for (let k = 0; k + 1 < spans.length; k++) if (spans[k].end > spans[k + 1].start) spans[k].end = spans[k + 1].start;
    return spans.filter((s) => s.end - s.start >= o.minSpanS);
  }

  function mergeIntervals(list) {
    const out = [];
    for (const [a, b] of list.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
      if (b <= a) continue;
      if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
      else out.push([a, b]);
    }
    return out;
  }

  /** 自動の区間と、利用者が調整した区間の、時間での一致(digest.py の agreement と同じ)。 */
  function digestAgreement(auto, reference) {
    const a = mergeIntervals(auto.map((s) => [s.start, s.end]));
    const r = mergeIntervals(reference.map((s) => [s.start, s.end]));
    const len = (xs) => xs.reduce((s, [x, y]) => s + (y - x), 0);
    const la = len(a), lr = len(r);
    let inter = 0;
    for (let i = 0, j = 0; i < a.length && j < r.length;) {
      const lo = Math.max(a[i][0], r[j][0]), hi = Math.min(a[i][1], r[j][1]);
      if (hi > lo) inter += hi - lo;
      if (a[i][1] < r[j][1]) i++; else j++;
    }
    if (la === 0 && lr === 0) return { precision: 1, recall: 1, f1: 1 };
    const p = la ? inter / la : 0, rc = lr ? inter / lr : 0;
    const f1 = p + rc ? (2 * p * rc) / (p + rc) : 0;
    const r4 = (x) => Math.round(x * 10000) / 10000;
    return { precision: r4(p), recall: r4(rc), f1: r4(f1) };
  }

  /**
   * 再生中の自動シーク。いまの位置 t に対して、次にすること:
   *   区間の中 → null(そのまま再生)/ 区間と区間のすき間 → {seekTo: 次の区間の頭}/ 最後の区間の後ろ → {done: true}
   * 区間の終わりの手前 endGuardS 秒に入ったら、もう「すき間」とみなす(timeupdate は約 0.25 秒おきなので、取りこぼさない)。
   */
  function digestNext(spans, t, endGuardS) {
    const guard = endGuardS === undefined ? 0.15 : endGuardS;
    for (const s of spans) {
      if (t >= s.start - 1e-6 && t < s.end - guard) return null;
      if (t < s.start) return { seekTo: s.start };
    }
    return { done: true };
  }

  // ---------- 章の調整(利用者が境界を消す・動かす・足す。CH3b) ----------
  const EDIT_MIN_GAP_S = 5; // 境界どうし・先頭/末尾との最小の間隔(これより短い章は作らない)

  /** 境界の列を整える: 数でない・範囲外・近すぎるものを除き、昇順にする。 */
  function normalizeBoundaries(list, durationS, minGapS) {
    const gap = minGapS === undefined ? EDIT_MIN_GAP_S : minGapS;
    const out = [];
    const sorted = list.filter((x) => typeof x === "number" && Number.isFinite(x) && x >= gap && (!(durationS > 0) || x <= durationS - gap)).sort((a, b) => a - b);
    for (const b of sorted) if (out.length === 0 || b - out[out.length - 1] >= gap) out.push(round3(b));
    return out;
  }

  /** i 番目の境界を消した列。範囲外なら null。 */
  function removeBoundary(list, i) {
    if (!Number.isInteger(i) || i < 0 || i >= list.length) return null;
    return list.filter((_, k) => k !== i);
  }

  /** i 番目の境界を delta 秒動かした列。前後の境界・先頭・末尾と minGap 未満になるなら null。 */
  function moveBoundary(list, i, delta, durationS, minGapS) {
    const gap = minGapS === undefined ? EDIT_MIN_GAP_S : minGapS;
    if (!Number.isInteger(i) || i < 0 || i >= list.length || !Number.isFinite(delta)) return null;
    const t = list[i] + delta;
    const prev = i > 0 ? list[i - 1] : 0;
    const next = i + 1 < list.length ? list[i + 1] : (durationS > 0 ? durationS : Infinity);
    if (t - prev < gap || next - t < gap) return null;
    return list.map((b, k) => (k === i ? round3(t) : b));
  }

  /** 時刻 t に境界を足した列。既存の境界・先頭・末尾と minGap 未満なら null。 */
  function addBoundary(list, t, durationS, minGapS) {
    const gap = minGapS === undefined ? EDIT_MIN_GAP_S : minGapS;
    if (!Number.isFinite(t) || t < gap || (durationS > 0 && t > durationS - gap)) return null;
    if (list.some((b) => Math.abs(b - t) < gap)) return null;
    return list.concat([round3(t)]).sort((a, b) => a - b);
  }

  return {
    tokens, termCounts, cosine, similarityCurve, selectBoundaries, refineBoundaries, snap,
    detect, detectPartial, V2_PARAMS, GRANULARITY, targetCountFor,
    formatTimestamp, excerpt, labelSections, buildChapters, srtText, vttText, markdownText, searchCues, applyTitleOverrides, descriptionText, chapterIndexAt, cuesFromRows,
    PreparedCues, DIGEST, selectDigest, digestAgreement, digestNext,
    EDIT_MIN_GAP_S, normalizeBoundaries, removeBoundary, moveBoundary, addBoundary,
  };
});
