/* AudioWorklet: タブの音(ステレオ)をモノラルにして、まとまりごとにメインへ渡すだけ。処理は capture.js 側。 */
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.t0 = 0;
  }
  process(inputs) {
    const ch = inputs[0];
    if (!ch || ch.length === 0) return true; // 入力が無い間は何も送らない(時刻の飛びは Chunker が無音で埋める)
    const L = ch[0],
      R = ch[1];
    for (let i = 0; i < L.length; i++) {
      if (this.n === 0) this.t0 = currentTime + i / sampleRate;
      this.buf[this.n++] = R ? (L[i] + R[i]) / 2 : L[i];
      if (this.n === this.buf.length) {
        const out = this.buf;
        this.port.postMessage({ t: this.t0, rate: sampleRate, samples: out }, [
          out.buffer,
        ]);
        this.buf = new Float32Array(4096);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
