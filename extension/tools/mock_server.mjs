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


// 開発用の擬似 chrome(?variant=shim): 保存はメモリ、エンジンの呼び出しは決まった返事。共有・保存の画面を、実ブラウザで確かめる用。
const SHIM = `<script>
  (function () {
    const mem = {};
    window.__engineLog = [];
    window.chrome = {
      storage: { local: {
        get: async (k) => { const ks = typeof k === "string" ? [k] : k; return Object.fromEntries(ks.filter((x) => x in mem).map((x) => [x, JSON.parse(JSON.stringify(mem[x]))])); },
        set: async (o) => { for (const [k, v] of Object.entries(o)) mem[k] = JSON.parse(JSON.stringify(v)); },
        remove: async (k) => { for (const x of [].concat(k)) delete mem[x]; },
      } },
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async (m) => {
          if (m.target !== "background" || m.type !== "engine") return;
          window.__engineLog.push({ method: m.method, path: m.path, body: m.body });
          if (m.path === "/v1/me") return { ok: true, status: 200, data: { user: { id: "u_aaaaaaaa", name: "alice", role: "user" }, share_mode: "team" } };
          if (m.path.startsWith("/v1/shares?video=")) return { ok: true, status: 200, data: { shares: [
            { from: "bob", mine: false, boundaries: [190, 395, 760, 1210, 1520], titles: null },
            { from: "carol", mine: false, boundaries: [200, 600, 1300], titles: null } ] } };
          if (m.path === "/v1/shares" && m.method === "POST") return { ok: true, status: 200, data: { shared: true } };
          return { ok: false, status: 404, error: "mock" };
        },
      },
    };
  })();
</script>`;

// 開発用: 管理ページ(/admin)を擬似 chrome つきで配信する(画面の確認用)
const ADMIN_SHIM = `<script>
  (function () {
    const users = [{ id: "local", name: "local", role: "admin", disabled: false }, { id: "u_1a2b3c4d", name: "alice", role: "user", disabled: false }, { id: "u_5e6f7a8b", name: "bob", role: "user", disabled: true }];
    window.chrome = { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } }, runtime: { sendMessage: async (m) => {
      const p = m.path;
      if (p === "/v1/me") return { ok: true, status: 200, data: { user: users[0], share_mode: "team" } };
      if (p === "/v1/admin/users" && m.method === "GET") return { ok: true, status: 200, data: { users } };
      if (p === "/v1/admin/users" && m.method === "POST") return { ok: true, status: 200, data: { user: { id: "u_99999999", name: m.body.name, role: m.body.role }, token: "TOKEN-SHOWN-ONCE-abcdefghijklmnopqrstuvwxyz0123456789" } };
      if (p.startsWith("/v1/admin/audit")) return { ok: true, status: 200, data: { events: [{ t: 1700000000, event: "admin.user.create", actor: "cli", target: "u_1a2b3c4d", role: "user" }, { t: 1700000100, route: "/v1/me", status: 200, owner: "local", role: "admin", ms: 2 }] } };
      return { ok: false, status: 404, error: "mock" };
    } } };
  })();
</script>`;

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
${variant === "shim" ? SHIM : ""}
<script src="/src/core.js"></script><script src="/src/capture.js"></script><script src="/src/store.js"></script><script src="/src/engine.js"></script><script src="/src/transcript.js"></script><script src="/src/ui.js"></script><script src="/src/content.js"></script>
</body></html>`;

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/watch") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page(url.searchParams.get("variant")));
  } else if (url.pathname === "/admin") {
    const html = readFileSync(join(root, "src", "admin.html"), "utf-8").replace(/<script src="([a-z]+\.js)">/g, '<script src="/src/$1">').replace("<script src=\"/src/capture.js\">", ADMIN_SHIM + "<script src=\"/src/capture.js\">");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
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
