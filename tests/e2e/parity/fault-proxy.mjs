// 对齐验收专用故障注入反向代理（只监听回环地址）。
//
// 链路：小程序 → 本代理(:3100) → 真实 API(:3000)。除注入的故障外逐字节原样转发
// （含 multipart 直传请求体），保证正常场景与直连 API 行为一致。
// 用法（match 均为「可选 method + path」对象，path 支持 RegExp（对 pathname 做 .test）
// 或字符串（与 pathname 严格相等），query 不参与匹配）：
//   proxy.failNext({ method: "POST", path: /\/receipt-attachments\/.+\/complete$/ }, { status: 500, body: { error: { code: "FAULT_INJECTED" } } });
//   proxy.dropNext({ method: "POST", path: "/api/local-storage/objects" });   // 断开连接，模拟断网
//   proxy.offline(true);                                                      // 全量断网
//   const { count, records } = proxy.hits({ method: "GET", path: /\/questionnaire$/ });
//   proxy.reset();                                                            // 清空待生效故障与命中记录
//   await proxy.close();
// 隐私约定：hits 记录绝不包含请求头（token）与请求体值（密码）——JSON 体只记顶层键名，
// multipart 只记字段名与字节数，其余记字节数。
import http from "node:http";

const MAX_FORWARDED_BODY_BYTES = 32 * 1024 * 1024;

const normalizeMatch = (match) => {
  if (!match || typeof match !== "object") throw new TypeError("match 必须是 { method?, path } 对象");
  const method = match.method ? String(match.method).toUpperCase() : null;
  if (!(match.path instanceof RegExp) && typeof match.path !== "string") throw new TypeError("match.path 必须是 RegExp 或字符串");
  return { method, path: match.path };
};

const matchRequest = (match, method, pathname) => {
  const normalized = normalizeMatch(match);
  if (normalized.method && normalized.method !== method) return false;
  return normalized.path instanceof RegExp ? normalized.path.test(pathname) : normalized.path === pathname;
};

// 请求体摘要（脱敏）：只取结构信息，不取任何值。
const summarizeBody = (contentType, body) => {
  if (!body || body.length === 0) return { kind: "empty" };
  const type = String(contentType || "").toLowerCase();
  if (type.includes("application/json")) {
    const text = body.toString("utf8");
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { kind: "json", keys: Object.keys(parsed) };
      return { kind: "json", bytes: body.length };
    } catch {
      return { kind: "text", bytes: body.length };
    }
  }
  if (type.includes("multipart/form-data")) {
    const head = body.subarray(0, 16 * 1024).toString("latin1");
    const fields = [...new Set([...head.matchAll(/name="([^"]+)"/g)].map((item) => item[1]))];
    return { kind: "multipart", fields, bytes: body.length };
  }
  return { kind: "opaque", bytes: body.length };
};

export async function startFaultProxy({ target, port = 3100, host = "127.0.0.1" } = {}) {
  if (!target) throw new TypeError("startFaultProxy 需要 { target } 上游地址（如 http://127.0.0.1:3000）");
  const targetUrl = new URL(target);
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(targetUrl.hostname)) {
    throw new Error("fault-proxy 只允许回环上游（安全边界），拒绝转发到非回环地址");
  }
  const faults = [];
  const records = [];
  let offlineMode = false;
  let recordSeq = 0;

  const record = (entry) => {
    const item = { id: recordSeq++, method: entry.method, path: entry.path, fault: entry.fault || null, status: entry.status ?? null, body: entry.body || { kind: "empty" }, at: new Date().toISOString() };
    records.push(item);
    return item;
  };

  const server = http.createServer((clientReq, clientRes) => {
    const method = String(clientReq.method || "GET").toUpperCase();
    const parsed = new URL(clientReq.url, targetUrl);
    const pathname = parsed.pathname;
    const chunks = [];
    let total = 0;
    let aborted = false;
    clientReq.on("data", (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total <= MAX_FORWARDED_BODY_BYTES) chunks.push(chunk);
    });
    clientReq.on("error", () => { aborted = true; });

    const summary = () => summarizeBody(clientReq.headers["content-type"], Buffer.concat(chunks));

    clientReq.on("end", () => {
      if (aborted) return;
      // offline 全量断网：直接断开连接，不产生响应。
      if (offlineMode) {
        record({ method, path: pathname, fault: "offline", body: summary() });
        clientRes.destroy();
        return;
      }
      // 一次性故障按入队顺序取第一个命中的。
      const faultIndex = faults.findIndex((fault) => matchRequest(fault.match, method, pathname));
      if (faultIndex >= 0) {
        const [fault] = faults.splice(faultIndex, 1);
        if (fault.kind === "drop") {
          record({ method, path: pathname, fault: "drop", body: summary() });
          clientRes.destroy();
          return;
        }
        const options = fault.options || {};
        const body = options.body === undefined ? JSON.stringify({ error: { code: "FAULT_INJECTED", message: "injected failure by fault-proxy" } }) : options.body;
        const payload = typeof body === "string" ? body : JSON.stringify(body);
        const contentType = options.contentType || (typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8");
        record({ method, path: pathname, fault: "fail", status: options.status ?? 500, body: summary() });
        clientRes.writeHead(options.status ?? 500, { "content-type": contentType, "content-length": Buffer.byteLength(payload) });
        clientRes.end(payload);
        return;
      }
      // 常规转发：整段缓冲后原样转发（本地小文件场景，上传上限 10MiB 远低于缓冲上限）。
      const body = Buffer.concat(chunks);
      const entry = record({ method, path: pathname, body: summary() });
      const headers = { ...clientReq.headers, host: targetUrl.host };
      const upstream = http.request(parsed, { method, headers }, (upstreamRes) => {
        entry.status = upstreamRes.statusCode || 0;
        const responseHeaders = { ...upstreamRes.headers };
        delete responseHeaders["content-length"];
        delete responseHeaders["transfer-encoding"];
        clientRes.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        upstreamRes.pipe(clientRes);
      });
      upstream.on("error", () => { entry.fault = "upstream-error"; clientRes.destroy(); });
      if (body.length > 0) upstream.write(body);
      upstream.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  return {
    port: server.address().port,
    // 下一次命中的请求不转发，直接返回给定状态码/响应体（body 为对象时按 JSON 发送）。
    failNext(match, options) { faults.push({ kind: "fail", match: normalizeMatch(match), options }); },
    // 下一次命中的请求直接断开连接（模拟断网）。
    dropNext(match) { faults.push({ kind: "drop", match: normalizeMatch(match) }); },
    // 全量断网开关：开启后所有请求断开连接；关闭后恢复转发（一次性故障队列不受影响）。
    offline(on) { offlineMode = Boolean(on); },
    // 命中查询：返回匹配请求的计数与记录（records 为副本，含 fault/status/body 摘要）。
    hits(match) {
      const matched = match ? records.filter((item) => matchRequest(match, item.method, item.path)) : [...records];
      return { count: matched.length, records: matched };
    },
    // 清空待生效故障与全部命中记录（场景隔离用，不影响离线开关）。
    reset() { faults.length = 0; records.length = 0; },
    close() {
      return new Promise((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => {
          if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else resolve();
        });
      });
    },
  };
}
