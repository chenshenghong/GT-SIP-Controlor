// ─────────────────────────────────────────────────────────────────────
// dev-proxy.mjs — 本機測試代理（zero-dependency Node）
//
// 用途：在「韌體尚未提供網頁」前，於你電腦上測試 index.html。
//   它在 localhost 同源提供 index.html，並把 API 路徑轉發到真實設備，
//   因此瀏覽器看到的是「同源」→ 不會被 CORS 擋。
//
// 用法：
//   node device-web/dev-proxy.mjs 192.168.0.146
//   node device-web/dev-proxy.mjs http://192.168.0.146 8080
// 然後瀏覽器開  http://localhost:8080/
//   ★ 登入頁「進階 · 設備位址」請「留空」（因為已是同源，由代理轉發）。
// ─────────────────────────────────────────────────────────────────────
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const arg1 = process.argv[2] || process.env.DEVICE || "192.168.0.146";
const PORT = Number(process.argv[3] || process.env.PORT || 8080);
const device = new URL(/^https?:\/\//i.test(arg1) ? arg1 : "http://" + arg1);
const HERE = dirname(fileURLToPath(import.meta.url));

// 設備 REST 路徑前綴；其餘一律回 index.html
const API = ["/auth", "/get", "/set", "/call", "/system"];

const server = http.createServer(async (req, res) => {
  req.on("error", () => {});   // 客戶端中途斷線/重整不應讓代理崩潰
  res.on("error", () => {});
  const isApi = API.some((p) => req.url.startsWith(p));

  if (!isApi) {
    try {
      const html = await readFile(join(HERE, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=UTF-8" });
      res.end(html);
    } catch {
      res.writeHead(500); res.end("index.html not found next to dev-proxy.mjs");
    }
    return;
  }

  // 轉發到設備（保留 method/headers/body，原樣回傳——含 GBK 與髒資料，交由前端處理）
  const headers = { ...req.headers, host: device.host };
  // ⚠ 韌體 get_http_head 比對 header 名稱「大小寫敏感」，只認 "Authorization"。
  //   Node 會把 req.headers 的名稱全轉小寫 → 設備收到 "authorization" 認不得 → 回 A003。
  //   故此處強制以大寫 "Authorization" 轉發，避免代理層造成的假性 token 失效。
  if (headers.authorization !== undefined) {
    headers["Authorization"] = headers.authorization;
    delete headers.authorization;
  }
  // 觀察用：印出瀏覽器「實際送出」的 Authorization header 名稱原始大小寫
  //   （判斷正式上線「瀏覽器直連設備」是否也會壞的依據；fetch 無法由 JS 控制此大小寫）
  if (isApi) {
    const origAuthName = req.rawHeaders.find((h, i) => i % 2 === 0 && h.toLowerCase() === "authorization");
    if (origAuthName) console.log(`[hdr] ${req.method} ${req.url}  瀏覽器送出的 header 名稱 = "${origAuthName}"`);
  }
  const proxyReq = http.request(
    { hostname: device.hostname, port: device.port || 80,
      path: req.url, method: req.method, headers },
    (pres) => {
      pres.on("error", () => { try { res.end(); } catch (e) {} });
      res.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(res);
    }
  );
  proxyReq.setTimeout(10000, () => proxyReq.destroy(new Error("設備回應逾時")));  // 避免掛死的對外連線累積
  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", message: "代理無法連到設備",
                               error_code: "PROXY", details: String(err && err.message || err) }));
    } else { try { res.end(); } catch (e) {} }
  });
  req.pipe(proxyReq);
});

// 安全網：未處理例外/拒絕只記錄、不讓代理整個倒掉（測試工具韌性；避免客戶端斷線造成的進程崩潰）
process.on("uncaughtException", (e) => console.error("⚠ 代理捕捉未處理例外（已忽略，不中止）:", (e && e.message) || e));
process.on("unhandledRejection", (e) => console.error("⚠ 代理捕捉未處理拒絕（已忽略，不中止）:", (e && e.message) || e));

server.listen(PORT, () => {
  console.log("▶ GT-SIP-GW 測試代理已啟動");
  console.log("  轉發目標設備 :", device.origin);
  console.log("  開瀏覽器     : http://localhost:" + PORT + "/");
  console.log("  ★ 登入頁「設備位址」請留空（已是同源）。預設帳密 admin / 123456");
  console.log("  停止：在此視窗按 Ctrl + C");
});

// 乾淨停止：Ctrl + C / kill 時關閉伺服器並提示
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log("\n■ 代理已停止");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 300);  // 保險：300ms 內仍未關完就強制結束
  });
}
