// Render 单实例统一启动器（npm run start:render）：
//   - 同一实例、同一持久磁盘上托管 API（apps/api/src/server.js）与后台 worker（apps/worker/src/worker.js）；
//     队列只有 PostgreSQL 一份，worker 逻辑不做任何复制或内嵌。
//   - 子进程直接读运行时环境变量（Render 注入），不依赖 --env-file=.env（该文件在 Render 上不存在）。
//   - 任一子进程退出 → 立即结束另一子进程并以非零码退出（平台据此重启实例）；不做孤儿/后台化。
//   - SIGTERM/SIGINT 原样转发两个子进程，等待全部退出后以 0 退出（Render 滚动重启零残留）。
//   - 启动期先做本地存储根目录探测（STORAGE_PROVIDER=local 时），磁盘缺失/挂载错误立刻失败关闭。
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

const { loadConfig } = await import("../apps/api/src/config.js");
const { createStorageProvider } = await import("../apps/api/src/storage/index.js");
const { resolveLocalStorageRoot } = await import("../apps/api/src/storage/local.js");
const config = loadConfig(process.env);
if (config.STORAGE_PROVIDER === "local") {
  // HTTP 就绪之前完成磁盘探测：挂载缺失/路径错误在这里失败关闭（消息含路径，非敏感值）。
  await createStorageProvider(config).assertReady();
  console.log(`[render] local storage ready at ${resolveLocalStorageRoot(config)}`);
}

const children = [];
let shuttingDown = false;
let exitCode = 0;
let forceKillTimer = null;

// 真实存活判定：不能用 child.killed——它只表示「信号已成功发出」；忽略 SIGTERM 的进程
// 发送后 killed=true 但仍在运行（exitCode/signalCode 仍为 null）。force 路径必须据此
// 识别幸存者并补 SIGKILL，否则有界强杀永远跳过它们。
const isAlive = (child) => child.exitCode === null && child.signalCode === null;
const killAll = (signal) => {
  for (const { child } of children) {
    if (isAlive(child)) {
      try { child.kill(signal); } catch { /* 已退出 */ }
    }
  }
};
// 有界强杀：SIGTERM 宽限 10 秒后 SIGKILL——忽略信号的子进程无法把 supervisor 挂死。
const armForceKill = () => {
  if (forceKillTimer) return;
  forceKillTimer = setTimeout(() => {
    console.error("[render] grace period elapsed; sending SIGKILL to remaining children");
    killAll("SIGKILL");
  }, 10_000);
  forceKillTimer.unref();
};
// 信号关停与子进程意外退出共用同一有界关停路径（区别仅在退出码与日志口径）。
const shutdown = (signal, failure = false) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (failure) {
    console.error(`[render] shutting down counterpart processes (${signal})`);
    exitCode = 1;
  } else {
    console.log(`[render] received ${signal}; forwarding to children`);
  }
  killAll(signal);
  armForceKill();
};

const spawnChild = (name, scriptPath) => {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    // 任一子进程在非关停阶段退出（即使 code=0）都视为整体失败：Render 会重启实例，
    // 双进程（API+worker）状态必须始终成对存在，不允许单飞。
    console.error(`[render] ${name} exited unexpectedly (code=${code}, signal=${signal})`);
    shutdown("SIGTERM", true);
  });
  children.push({ name, child });
  console.log(`[render] ${name} started (pid=${child.pid})`);
};

spawnChild("api", "apps/api/src/server.js");
spawnChild("worker", "apps/worker/src/worker.js");

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// 全部子进程退出后 supervisor 才退出（携带首个失败子进程的退出码）。
const waitAll = () => Promise.all(children.map(({ child }) => new Promise((resolveExit) => child.once("exit", resolveExit))));
await waitAll();
console.log(`[render] all children exited; supervisor exit code=${exitCode}`);
process.exit(exitCode);
