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

  /** 境界の時刻の列 → 章の一覧。先頭は 0 秒。title は最初の字幕の冒頭。 */
  function buildChapters(boundaries, cues, durationS) {
    const starts = [0, ...boundaries.filter((b) => b > 0 && b < durationS)];
    const chapters = [];
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      const end = i + 1 < starts.length ? starts[i + 1] : durationS;
      const cue = cues.find((c) => c.start >= start - 1e-6);
      chapters.push({ start, end, title: cue ? excerpt(cue.text, 24) : "" });
    }
    return chapters;
  }

  /** YouTube の概要欄に貼れる形(先頭 0:00・3 つ以上・各 10 秒以上)。満たせないときは null。 */
  function descriptionText(chapters) {
    if (chapters.length < 3) return null;
    if (chapters.some((c) => c.end - c.start < 10)) return null;
    return chapters.map((c) => `${formatTimestamp(c.start)} ${c.title || "チャプター"}`).join("\n");
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

  return {
    tokens, termCounts, cosine, similarityCurve, selectBoundaries, refineBoundaries, snap,
    detect, V2_PARAMS, GRANULARITY, targetCountFor,
    formatTimestamp, excerpt, buildChapters, descriptionText, chapterIndexAt, cuesFromRows,
    PreparedCues,
  };
});
