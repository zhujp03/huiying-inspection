// 本地开发一键启动：数据库/OCR 容器 -> API(3000) -> Worker -> 管理后台(5173)。
// 用法：npm run dev:up   （Ctrl+C 一键全部停止）
// 已在运行的组件会自动跳过，不会重复拉起。
import { spawn } from "node:child_process";
import net from "node:net";
import { platform } from "node:os";

const CONTAINERS = ["junde-pg17", "ocr-test"];
const API_PORT = 3000;
const ADMIN_PORT = 5173;
const DB_PORT = Number(process.env.DB_PORT || 5433);

const run = (command, args, { timeoutMs = 60_000 } = {}) => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ ok: false, stderr: `${command} 超时` }); }, timeoutMs);
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, stderr: String(error) }); });
  child.on("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, stderr: stderr.slice(0, 300) }); });
});

const portOpen = (port, host = "127.0.0.1") => new Promise((resolve) => {
  const socket = net.connect({ port, host });
  socket.setTimeout(800);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("timeout", () => { socket.destroy(); resolve(false); });
  socket.once("error", () => resolve(false));
});

const waitFor = async (check, { timeoutMs = 30_000, label }) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error(`  [dev-up] 等待超时：${label}`);
  return false;
};

// 带前缀转发子进程日志，避免三个服务输出混在一起难以分辨。
const pipeWithPrefix = (child, label) => {
  const prefix = (chunk) => String(chunk).split("\n").filter(Boolean).map((line) => `  [${label}] ${line}`).join("\n") + "\n";
  child.stdout.on("data", (chunk) => process.stdout.write(prefix(chunk)));
  child.stderr.on("data", (chunk) => process.stderr.write(prefix(chunk)));
};

const children = [];
const startChild = (label, command, args) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  pipeWithPrefix(child, label);
  child.on("exit", (code) => console.error(`  [dev-up] ${label} 已退出（code=${code}）`));
  children.push({ label, child });
};

console.log("== dev-up：启动本地开发环境 ==");

// 1) Docker（数据库 + OCR）：OrbStack 未运行时先尝试拉起
const dockerAlive = await run("docker", ["info", "--format", "ok"], { timeoutMs: 5_000 });
if (!dockerAlive.ok && platform() === "darwin") {
  console.log("  [dev-up] Docker daemon 未运行，尝试启动 OrbStack…");
  await run("open", ["-a", "OrbStack"], { timeoutMs: 15_000 });
  await waitFor(() => run("docker", ["info", "--format", "ok"], { timeoutMs: 3_000 }).then((r) => r.ok), { timeoutMs: 30_000, label: "Docker daemon" });
}
const containers = await run("docker", ["start", ...CONTAINERS]);
console.log(containers.ok ? "  [dev-up] 数据库/OCR 容器已就绪" : `  [dev-up] 容器启动失败（继续，但 OCR/持久化可能不可用）：${containers.stderr}`);
if (containers.ok) await waitFor(() => portOpen(DB_PORT), { timeoutMs: 20_000, label: `数据库端口 ${DB_PORT}` });

// 2) API（跳过条件：端口已被占用 = 已在运行）
if (await portOpen(API_PORT)) {
  console.log(`  [dev-up] API 已在运行（端口 ${API_PORT}），跳过`);
} else {
  startChild("api", "node", ["--env-file=.env", "--watch", "apps/api/src/server.js"]);
  await waitFor(() => portOpen(API_PORT), { timeoutMs: 30_000, label: "API" });
  console.log(`  [dev-up] API: http://127.0.0.1:${API_PORT}`);
}

// 3) Worker（小票 OCR 等后台任务；无端口，按进程名判重）
const pgrep = await run("pgrep", ["-f", "apps/worker/src/worker.js"]);
if (pgrep.ok) {
  console.log("  [dev-up] Worker 已在运行，跳过");
} else {
  startChild("worker", "node", ["--env-file=.env", "apps/worker/src/worker.js"]);
  console.log("  [dev-up] Worker 已启动");
}

// 4) 管理后台（Vite）
if (await portOpen(ADMIN_PORT)) {
  console.log(`  [dev-up] 管理后台已在运行（端口 ${ADMIN_PORT}），跳过`);
} else {
  startChild("admin", "npm", ["--prefix", "apps/admin", "run", "dev"]);
  await waitFor(() => portOpen(ADMIN_PORT), { timeoutMs: 30_000, label: "管理后台" });
  console.log(`  [dev-up] 管理后台: http://localhost:${ADMIN_PORT}`);
}

console.log("== dev-up 完成：Ctrl+C 一键停止全部 ==");
const shutdown = () => {
  for (const { child } of children) child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
