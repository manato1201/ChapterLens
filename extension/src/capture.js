/*
 * タブの音声 → ローカルエンジン(CH2b)の、ブラウザ API に触れない部分。DOM・chrome.* は使わない(Node でテストできる)。
 *
 *   Downsampler   : 再生の音(例 48kHz)→ 16kHz(認識に使う標準)。平均を取って間引く
 *   Chunker       : 16kHz の音を一定の長さ(既定 30 秒)に区切る。止まっていた時間は無音で埋める(時刻がずれない)
 *   encodeWav     : 16bit モノラルの WAV にする(エンジンの /v1/transcribe が読める形)
 *   TimeMap       : 「時計の時刻」→「動画の再生位置」。一時停止・シーク・倍速でも、字幕の時刻を動画の時刻に直す
 *   shiftCues     : チャンク内の相対時刻の字幕を、動画の時刻へ
 *   CaptureSession: 区切った音を順番にエンジンへ送り、字幕を返す(送り先・通知は外から渡す=テストで差し替え)。
 *                   返す字幕はチャンク内の相対時刻。動画の時刻への変換(shiftCues)は、動画を持つ content script で行う
 *   validateServerUrl: 音声を送れるのは http://127.0.0.1:<port> だけ(別のホストには送らない)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChapterLensCapture = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TARGET_RATE = 16000;

  // ---- 送り先は、この PC の中だけ ----
  function validateServerUrl(raw) {
    let u;
    try { u = new URL(String(raw || "")); } catch (_) { throw new Error("エンジンの URL が読めません"); }
    if (u.protocol !== "http:" || u.hostname !== "127.0.0.1") throw new Error("エンジンの URL は http://127.0.0.1:<ポート> だけ使えます");
    if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw new Error("エンジンの URL にパス・認証情報は付けられません");
    return u.origin;
  }

  // ---- 16kHz にする(位置ベースの平均。48k→16k のような割り切れる比も、44.1k のような割り切れない比も扱える) ----
  class Downsampler {
    constructor(inRate, outRate = TARGET_RATE) {
      if (!(inRate > 0) || !(outRate > 0) || outRate > inRate) throw new Error("サンプリングレートが不正です");
      this.ratio = inRate / outRate;
      this.sum = 0; this.weight = 0; this.pos = 0; // 現在の出力 1 つぶんに入った、入力の合計・重み
      this.binEnd = this.ratio;                     // 出力 1 つぶんが終わる入力位置(入力サンプル単位)
    }
    process(input) {
      const out = [];
      for (let i = 0; i < input.length; i++) {
        let from = this.pos, to = this.pos + 1;
        const v = input[i];
        while (to > this.binEnd + 1e-9) {
          const w = this.binEnd - from;
          this.sum += v * w; this.weight += w;
          out.push(this.sum / this.weight);
          this.sum = 0; this.weight = 0;
          from = this.binEnd; this.binEnd += this.ratio;
        }
        this.sum += v * (to - from); this.weight += to - from;
        if (Math.abs(to - this.binEnd) < 1e-9) {
          out.push(this.sum / this.weight);
          this.sum = 0; this.weight = 0; this.binEnd += this.ratio;
        }
        this.pos = to;
      }
      return Float32Array.from(out);
    }
  }

  // ---- 一定の長さに区切る。streamTime は音の流れの上の時刻(秒)。飛んだ分は無音で埋める ----
  class Chunker {
    constructor({ rate = TARGET_RATE, chunkS = 30, onChunk }) {
      this.rate = rate; this.size = Math.round(chunkS * rate); this.onChunk = onChunk;
      this.buf = new Float32Array(this.size); this.n = 0; this.startS = null; this.nextS = null;
    }
    push(streamTimeS, samples) {
      if (this.startS === null) { this.startS = streamTimeS; this.nextS = streamTimeS; }
      // 時刻が飛んでいたら(停止中は音が来ない)、その分を無音で埋める。ずれを溜めない
      const gapSamples = Math.round((streamTimeS - this.nextS) * this.rate);
      if (gapSamples > this.rate * 0.05) this._append(new Float32Array(Math.min(gapSamples, this.rate * 600)));
      this._append(samples);
      this.nextS = streamTimeS + samples.length / this.rate;
    }
    _append(arr) {
      let off = 0;
      while (off < arr.length) {
        const take = Math.min(this.size - this.n, arr.length - off);
        this.buf.set(arr.subarray(off, off + take), this.n);
        this.n += take; off += take;
        if (this.n === this.size) this._emit(this.size);
      }
    }
    _emit(count) {
      const samples = this.buf.slice(0, count);
      const startS = this.startS;
      this.startS += count / this.rate; this.n = 0;
      this.onChunk({ startS, samples });
    }
    flush() { if (this.n > this.rate * 1.0) this._emit(this.n); else { this.n = 0; } } // 1 秒に満たない端は捨てる
  }

  function rms(samples) {
    if (!samples.length) return 0;
    let s = 0;
    for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
    return Math.sqrt(s / samples.length);
  }

  function encodeWav(samples, rate = TARGET_RATE) {
    const bytes = new Uint8Array(44 + samples.length * 2);
    const dv = new DataView(bytes.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); dv.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, "data"); dv.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const x = Math.max(-1, Math.min(1, samples[i]));
      dv.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return bytes;
  }

  // ---- 時計 → 動画の再生位置 ----
  class TimeMap {
    /** add(wallMs, mediaS, {jump}) — 一時停止/再生/シーク/倍速の変化/一定間隔で呼ぶ。jump=true はシークの直後(時刻が飛ぶ) */
    constructor() { this.pts = []; }
    add(wallMs, mediaS, opts = {}) {
      const last = this.pts[this.pts.length - 1];
      if (last && wallMs < last.wall) return; // 時計は戻らない
      this.pts.push({ wall: wallMs, media: mediaS, jump: !!opts.jump });
    }
    mediaAt(wallMs) {
      const p = this.pts;
      if (p.length === 0) return null;
      if (wallMs <= p[0].wall) return p[0].media;
      for (let i = 1; i < p.length; i++) {
        if (wallMs <= p[i].wall) {
          const a = p[i - 1], b = p[i];
          if (b.jump) { // 飛ぶ前の区間: 直前の進み方で延ばす(飛んだ後の時刻は使わない)
            const rate = i >= 2 ? Math.max(0, (a.media - p[i - 2].media) / Math.max(1, a.wall - p[i - 2].wall)) : 0.001;
            return a.media + (wallMs - a.wall) * rate;
          }
          if (b.wall === a.wall) return b.media;
          return a.media + ((b.media - a.media) * (wallMs - a.wall)) / (b.wall - a.wall);
        }
      }
      return p[p.length - 1].media;
    }
  }

  /** チャンク内の相対時刻の字幕 → 動画の時刻。逆順になった・長さが無くなったものは除く */
  function shiftCues(cues, chunkWallMs, map) {
    const out = [];
    for (const c of cues) {
      const s = map.mediaAt(chunkWallMs + c.start * 1000), e = map.mediaAt(chunkWallMs + c.end * 1000);
      if (s === null || e === null || !(e > s) || !c.text) continue;
      out.push({ start: round3(s), end: round3(e), text: c.text });
    }
    return out;
  }
  const round3 = (x) => Math.round(x * 1000) / 1000;

  // ---- 区切った音を、順番にエンジンへ ----
  /**
   * deps: { fetch, serverUrl, token, language?, onCues(rawCues, chunkWallMs, info), onStatus(info), onError(code, message) }
   * enqueue({startS, samples}, wallAtStreamZeroMs) で 1 チャンクを受け、直列に送る。
   */
  class CaptureSession {
    constructor(deps) {
      this.d = deps; this.base = validateServerUrl(deps.serverUrl);
      this.language = deps.language && deps.language !== "auto" ? deps.language : null;
      this.queue = []; this.running = false; this.stopped = false;
      this.maxQueue = deps.maxQueue || 8; this.silenceRms = deps.silenceRms ?? 0.002;
      this.stats = { sent: 0, skippedSilent: 0, dropped: 0, errors: 0, coveredS: 0 };
    }
    enqueue(chunk, wallAtStreamZeroMs) {
      if (this.stopped) return;
      if (rms(chunk.samples) < this.silenceRms) { this.stats.skippedSilent++; this.stats.coveredS = chunk.startS + chunk.samples.length / TARGET_RATE; this._status(); return; }
      if (this.queue.length >= this.maxQueue) { this.stats.dropped++; this.d.onError("backlog", "エンジンの処理が追いつかず、音声の一部を飛ばしました"); return; }
      this.queue.push({ chunk, wallMs: wallAtStreamZeroMs + chunk.startS * 1000 });
      this._pump();
    }
    stop() { this.stopped = true; this.queue.length = 0; }
    /** 受けたぶんを送りきるまで待つ(止める前の仕上げ用) */
    async drain() { while (this.queue.length || this.running) await new Promise((r) => setTimeout(r, 20)); }
    async _pump() {
      if (this.running) return;
      this.running = true;
      try {
        while (this.queue.length && !this.stopped) {
          const item = this.queue.shift();
          await this._send(item);
        }
      } finally { this.running = false; }
    }
    async _send({ chunk, wallMs }) {
      const q = new URLSearchParams();
      if (this.language) q.set("language", this.language);
      let res;
      try {
        res = await this.d.fetch(`${this.base}/v1/transcribe${q.toString() ? "?" + q.toString() : ""}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.d.token}`, "Content-Type": "audio/wav" },
          body: encodeWav(chunk.samples),
        });
      } catch (_) { this.stats.errors++; this.d.onError("unreachable", "エンジンに接続できません。エンジン(engine/ で uv run --extra asr python -m chapterlens serve)を起動しているか確認してください"); return; }
      if (res.status === 401) { this.stats.errors++; this.d.onError("auth", "token が違います。エンジンの token をもう一度貼り付けてください"); this.stop(); return; }
      if (res.status === 403) { this.stats.errors++; this.d.onError("origin", "エンジンが、この拡張を許可していません(--allow-origin を確認)"); this.stop(); return; }
      if (!res.ok) { this.stats.errors++; this.d.onError("server", `エンジンがエラーを返しました(${res.status})`); return; }
      let body;
      try { body = await res.json(); } catch (_) { this.stats.errors++; this.d.onError("server", "エンジンの返事を読めませんでした"); return; }
      if (!this.language && body.language && Array.isArray(body.cues) && body.cues.length >= 2) this.language = body.language; // 最初に言葉を決めたら、以後は固定(途中で別の言語に誤認されない)
      this.stats.sent++;
      this.stats.coveredS = chunk.startS + chunk.samples.length / TARGET_RATE;
      this.d.onCues(body.cues || [], wallMs, { language: this.language || body.language || null, coveredS: this.stats.coveredS });
      this._status();
    }
    _status() { if (this.d.onStatus) this.d.onStatus({ ...this.stats, language: this.language, queued: this.queue.length }); }
  }

  return { TARGET_RATE, validateServerUrl, Downsampler, Chunker, rms, encodeWav, TimeMap, shiftCues, CaptureSession };
});
