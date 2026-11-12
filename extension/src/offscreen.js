/*
 * offscreen document: タブの音を受け取り、16kHz に直し、30 秒ずつ、この PC のエンジン(127.0.0.1)へ送る。
 * 音は(1)再生の続きとして利用者に聞こえるまま流し、(2)メモリの中だけで処理する。ファイルには保存しない。
 * 結果(字幕)は background 経由で、元のタブの content script へ渡す。
 */
(function () {
  "use strict";
  const C = self.ChapterLensCapture;
  const CHUNK_S = 30;
  let run = null; // 実行中の取り込み

  const toTab = (tabId, payload) =>
    chrome.runtime
      .sendMessage({ target: "background", type: "relay", tabId, payload })
      .catch(() => {});

  async function start(msg) {
    if (run)
      throw new Error("すでに別の取り込みが動いています。先に停止してください");
    const base = C.validateServerUrl(msg.serverUrl); // 送り先は 127.0.0.1 だけ
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaStreamId: msg.streamId,
        },
      },
      video: false,
    });
    const ctx = new AudioContext(); // 再生の音質を落とさないよう、既定のレートのまま(16kHz への変換は Downsampler)
    await ctx.audioWorklet.addModule("pcm-worklet.js");
    const source = ctx.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(ctx, "pcm-tap", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    source.connect(tap);
    source.connect(ctx.destination); // タブの音は、取り込むと消えてしまう。そのまま利用者にも聞こえるようにする
    const wallAtZero = Date.now() - ctx.currentTime * 1000; // 音の流れの 0 秒の、時計の時刻
    const down = new C.Downsampler(ctx.sampleRate, C.TARGET_RATE);

    const session = new C.CaptureSession({
      fetch: (u, o) => fetch(u, o),
      serverUrl: base,
      token: msg.token,
      language: msg.language,
      onCues: (cues, chunkWallMs, info) =>
        toTab(msg.tabId, { type: "cl-cues", cues, chunkWallMs, info }),
      onStatus: (info) => toTab(msg.tabId, { type: "cl-status", info }),
      onError: (code, message) =>
        toTab(msg.tabId, { type: "cl-error", code, message }),
    });
    const chunker = new C.Chunker({
      chunkS: CHUNK_S,
      onChunk: (ch) => session.enqueue(ch, wallAtZero),
    });
    tap.port.onmessage = (e) =>
      chunker.push(e.data.t, down.process(e.data.samples));

    run = {
      stream,
      ctx,
      session,
      chunker,
      tabId: msg.tabId,
      startedAt: Date.now(),
    };
    stream
      .getAudioTracks()
      .forEach((t) => t.addEventListener("ended", () => stop())); // タブが閉じられた・共有が切れた
  }

  async function stop() {
    if (!run) return;
    const r = run;
    run = null;
    try {
      r.chunker.flush();
      await r.session.drain();
    } catch (_) {
      /* 仕上げの失敗は無視 */
    }
    r.session.stop();
    r.stream.getTracks().forEach((t) => t.stop());
    try {
      await r.ctx.close();
    } catch (_) {
      /* 既に閉じている */
    }
    await toTab(r.tabId, { type: "cl-ended" });
    chrome.runtime
      .sendMessage({ target: "background", type: "ended" })
      .catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== "offscreen") return;
    if (msg.type === "start") {
      start(msg).then(
        () => sendResponse({ ok: true }),
        (e) =>
          sendResponse({ ok: false, error: String((e && e.message) || e) }),
      );
      return true;
    }
    if (msg.type === "stop") {
      stop().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === "status") {
      sendResponse(
        run
          ? { active: true, tabId: run.tabId, startedAt: run.startedAt }
          : { active: false },
      );
      return;
    }
  });
})();
