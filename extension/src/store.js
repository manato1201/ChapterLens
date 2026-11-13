/*
 * 動画ごとの、利用者の調整の保存(chrome.storage.local)。この PC のブラウザの中だけ。どこにも送らない。
 *   manual: 章の境界を利用者が直した結果 { boundaries: [秒…], auto: [自動の境界…], at }
 *   digest: ダイジェストの区間を利用者が調整した結果 { spans: [{start,end}…], auto: [{start,end}…], ratio, at }
 * 保存するのは時刻と設定だけ(字幕・題名・動画の中身は保存しない)。動画が増えすぎないよう、新しい順に maxVideos 本まで。
 * area は chrome.storage.local と同じ形({get(keys), set(obj), remove(keys)}。Promise を返す)。壊れた値は読み飛ばす。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChapterLensStore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PREFIX = "chapterlens.v.";
  const INDEX_KEY = "chapterlens.index";
  const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const MAX_BOUNDARIES = 500;
  const MAX_SPANS = 500;
  const MAX_SECONDS = 24 * 3600;

  const isTime = (x) =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 && x < MAX_SECONDS;

  function cleanBoundaries(list) {
    if (
      !Array.isArray(list) ||
      list.length > MAX_BOUNDARIES ||
      !list.every(isTime)
    )
      return null;
    return list.slice().sort((a, b) => a - b);
  }

  function cleanSpans(list) {
    if (!Array.isArray(list) || list.length > MAX_SPANS) return null;
    const out = [];
    for (const s of list) {
      if (!s || !isTime(s.start) || !isTime(s.end) || !(s.end > s.start))
        return null;
      out.push({ start: s.start, end: s.end });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  function create(area, options) {
    const opts = options || {};
    const maxVideos = opts.maxVideos || 100;
    const now = opts.now || (() => Date.now());

    async function readIndex() {
      try {
        const got = await area.get(INDEX_KEY);
        const idx = got && got[INDEX_KEY];
        return Array.isArray(idx)
          ? idx.filter((v) => typeof v === "string" && VIDEO_ID.test(v))
          : [];
      } catch (_) {
        return [];
      }
    }

    async function touch(videoId) {
      const idx = (await readIndex()).filter((v) => v !== videoId);
      idx.unshift(videoId);
      const dropped = idx.splice(maxVideos);
      await area.set({ [INDEX_KEY]: idx });
      if (dropped.length) await area.remove(dropped.map((v) => PREFIX + v));
    }

    async function read(videoId) {
      if (!VIDEO_ID.test(videoId || "")) return {};
      try {
        const got = await area.get(PREFIX + videoId);
        const v = got && got[PREFIX + videoId];
        if (!v || typeof v !== "object") return {};
        const out = {};
        if (v.manual) {
          const b = cleanBoundaries(v.manual.boundaries),
            a = cleanBoundaries(v.manual.auto);
          if (b && a) out.manual = { boundaries: b, auto: a, at: v.manual.at };
        }
        if (v.digest) {
          const s = cleanSpans(v.digest.spans),
            a = cleanSpans(v.digest.auto);
          if (s && a)
            out.digest = {
              spans: s,
              auto: a,
              ratio: Number(v.digest.ratio) || 0.2,
              at: v.digest.at,
            };
        }
        return out;
      } catch (_) {
        return {};
      }
    }

    // 読んでから書く(read-modify-write)ので、同時に走ると片方の変更が消える。順番に実行する
    let chain = Promise.resolve();
    function write(videoId, patch) {
      if (!VIDEO_ID.test(videoId || "")) return Promise.resolve(false);
      const job = chain.then(async () => {
        const cur = await read(videoId);
        const next = Object.assign({}, cur, patch);
        for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
        try {
          await area.set({ [PREFIX + videoId]: next });
          await touch(videoId);
          return true;
        } catch (_) {
          return false;
        }
      });
      chain = job.then(() => undefined, () => undefined);
      return job;
    }

    return {
      load: read,
      async saveManual(videoId, boundaries, auto) {
        const b = cleanBoundaries(boundaries),
          a = cleanBoundaries(auto);
        if (!b || !a) return false;
        return write(videoId, {
          manual: { boundaries: b, auto: a, at: now() },
        });
      },
      clearManual: (videoId) => write(videoId, { manual: null }),
      async saveDigest(videoId, spans, auto, ratio) {
        const s = cleanSpans(spans),
          a = cleanSpans(auto);
        if (!s || !a) return false;
        return write(videoId, {
          digest: { spans: s, auto: a, ratio, at: now() },
        });
      },
      clearDigest: (videoId) => write(videoId, { digest: null }),
      async forgetAll() {
        const idx = await readIndex();
        try {
          await area.remove([INDEX_KEY, ...idx.map((v) => PREFIX + v)]);
          return true;
        } catch (_) {
          return false;
        }
      },
    };
  }

  return { create, cleanBoundaries, cleanSpans, VIDEO_ID, PREFIX };
});
