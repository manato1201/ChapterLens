// 開発用: YouTube の動画ページに似せたモックを、ローカルだけで配信する(画面・操作の確認用)。
//   node tools/mock_server.mjs [port]   → http://localhost:8765/watch?v=mock
// 本物の YouTube とは別物。文字起こしの DOM の作り(セレクタ)は transcript.js が読むものと同じにしてある。
// 字幕は合成データ(test/golden)。ボタンを押すと、少し遅れて行が出る(本物と同じ非同期)。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const port = Number(process.argv[2] || 8765);
const golden = JSON.parse(
  readFileSync(join(root, "test", "golden", "golden.json"), "utf-8"),
);
const kase = golden.cases.find((c) => c.name === "en-6topics");
const stamp = (s) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const rows = kase.cues.map((c) => ({ t: stamp(c.start), x: c.text }));

const page = (
  variant,
) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>mock watch</title>
<style>body{font:14px system-ui;margin:0;background:#f9f9f9;color:#111}html[dark] body{background:#0f0f0f;color:#eee}
.player{position:relative;width:640px;height:360px;background:#000;margin:20px}
.ytp-progress-bar{position:absolute;left:0;right:0;bottom:0;height:5px;background:#555}
#info{margin:20px}</style></head><body>
<div class="player"><video class="html5-main-video" width="640" height="360"></video><div class="ytp-progress-bar"></div></div>
<div id="info">
  <div id="description"><tp-yt-paper-button id="expand">もっと見る</tp-yt-paper-button>
  ${variant === "notranscript" ? "" : `<ytd-video-description-transcript-section-renderer><button id="show">文字起こしを表示</button></ytd-video-description-transcript-section-renderer>`}</div>
  <div id="panel"></div>
</div>
<script>
  const video = document.querySelector('video');
  Object.defineProperty(video, 'duration', { value: ${kase.duration}, configurable: true });
  const ROWS = ${JSON.stringify(rows)};
  document.getElementById('show')?.addEventListener('click', () => {
    setTimeout(() => {
      const panel = document.getElementById('panel');
      for (const r of ROWS) {
        const seg = document.createElement('transcript-segment-view-model');
        const ts = document.createElement('div'); ts.className = 'ytwTranscriptSegmentViewModelTimestamp'; ts.textContent = r.t;
        const tx = document.createElement('span'); tx.className = 'ytAttributedStringHost'; tx.textContent = r.x;
        seg.append(ts, tx); panel.append(seg);
      }
    }, 800);
  });
  // 動画の切り替え(SPA)を模す: 同じ見た目の別 v に pushState して、yt-navigate-finish を出す
  window.mockNavigate = (v) => { history.pushState({}, '', '/watch?v=' + v); document.dispatchEvent(new Event('yt-navigate-finish')); };
</script>
<script src="/src/core.js"></script><script src="/src/transcript.js"></script><script src="/src/ui.js"></script><script src="/src/content.js"></script>
</body></html>`;

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/watch") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page(url.searchParams.get("variant")));
  } else if (/^\/src\/[a-z]+\.js$/.test(url.pathname)) {
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      // 開発用: 本物のページへの注入テストで読めるようにする(ローカルの 127.0.0.1 だけで配信)
      "access-control-allow-origin": "*",
    });
    res.end(readFileSync(join(root, url.pathname)));
  } else {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`mock: http://localhost:${port}/watch?v=mock`),
);
