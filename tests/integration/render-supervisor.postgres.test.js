// start:render 统一 supervisor 行为测试：
//   1) 子进程失败联动：worker 因缺 DATABASE_URL 立即退出 → supervisor 以非零码退出且 API 子进程被终止（端口释放）；
//   2) 正常运行 + 优雅关停：junde_test 上 API/worker 就绪后 SIGTERM → 转发两子进程、全部退出、退出码 0、端口释放。
// 只允许 junde_test（保险丝）；不写任何业务数据。
import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

assertIntegrationTestDatabase();

// fileURLToPath：仓库路径含中文，URL.pathname 的百分号编码不能直接交给 CJS loader。
const supervisorPath = fileURLToPath(new URL("../../scripts/start-render.mjs", import.meta.url));
const storageRoot = await mkdtemp(path.join(tmpdir(), "junde-render-supervisor-"));

const freePort = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const busy = await new Promise((resolveProbe) => {
      const socket = connect(port, "127.0.0.1");
      socket.on("connect", () => { socket.destroy(); resolveProbe(true); });
      socket.on("error", () => resolveProbe(false));
    });
    if (!busy) return port;
  }
  throw new Error("no free port found");
};

const portResponds = (port) => new Promise((resolveProbe) => {
  const socket = connect(port, "127.0.0.1");
  socket.on("connect", () => { socket.destroy(); resolveProbe(true); });
  socket.on("error", () => resolveProbe(false));
});

const waitUntil = async (condition, timeoutMs, label, dump = null) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`timeout waiting for ${label}${dump ? `: ${String(dump()).slice(-1800)}` : ""}`);
};

const stop = (child) => new Promise((resolveStop) => {
  child.removeAllListeners("exit");
  if (child.exitCode !== null || child.signalCode) return resolveStop();
  child.kill("SIGKILL");
  child.once("exit", resolveStop);
});

describe.sequential("start:render supervisor", () => {
  const spawned = [];

  it("exits non-zero and releases the port when either child fails (missing DATABASE_URL)", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [supervisorPath], {
      env: { ...process.env, NODE_ENV: "test", PORT: String(port), HOST: "127.0.0.1", STORAGE_PROVIDER: "local", LOCAL_STORAGE_DIR: storageRoot, DATABASE_URL: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    spawned.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const code = await new Promise((resolveExit) => child.once("exit", (exitCode) => resolveExit(exitCode)));
    expect(code, output.slice(-400)).not.toBe(0);
    // API 子进程必须已被联动终止：端口不再接受连接。
    await waitUntil(async () => !(await portResponds(port)), 10_000, "api port release after worker failure");
  }, 30_000);

  it("runs API and worker together and shuts both down gracefully on SIGTERM", async (ctx) => {
    const connectionString = process.env.DATABASE_URL;
    // 显式 skip（不计通过）：真实库关停链路需要 DATABASE_URL。
    if (!connectionString) return ctx.skip();
    const port = await freePort();
    const child = spawn(process.execPath, [supervisorPath], {
      env: { ...process.env, NODE_ENV: "test", PORT: String(port), HOST: "127.0.0.1", STORAGE_PROVIDER: "local", LOCAL_STORAGE_DIR: storageRoot, DATABASE_URL: connectionString },
      stdio: ["ignore", "pipe", "pipe"],
    });
    spawned.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    // API 就绪（/health/ready 走真实 junde_test 连接池）。
    await waitUntil(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
        return response.status === 200;
      } catch {
        return false;
      }
    }, 30_000, "api readiness on junde_test", () => output);
    // worker 已启动（supervisor 日志出现 worker started）。
    expect(output).toContain("worker started");
    // 优雅关停：SIGTERM → supervisor 退出码 0 → 端口释放。
    child.kill("SIGTERM");
    const code = await new Promise((resolveExit) => child.once("exit", (exitCode, signal) => resolveExit(signal ? -1 : exitCode)));
    expect(code, output.slice(-400)).toBe(0);
    await waitUntil(async () => !(await portResponds(port)), 10_000, "api port release after SIGTERM");
  }, 60_000);

  afterAll(async () => {
    for (const child of spawned) await stop(child);
  });
});
