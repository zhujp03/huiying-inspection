// start:render supervisor 有界强杀回归（复制真实 supervisor 到临时目录，替换子进程为
// SIGTERM 忽略者 + 正常进程，不改生产代码）：
//   - companion（默认信号处理）在 SIGTERM 后立即退出；
//   - ignorer 吞掉 SIGTERM 仍存活（killed=true 但进程在跑——正是 killAll 旧缺陷场景）；
//   - 10 秒宽限后 force 路径必须用 SIGKILL 终结 ignorer，supervisor 以 0 退出。
// 旧实现按 !child.killed 判存活：ignorer 被 SIGTERM 后 killed=true，SIGKILL 永远跳过它，
// supervisor 挂死——本测试对该缺陷失败（超时），对修复通过。
import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it("force path SIGKILLs a SIGTERM-ignoring child and the supervisor still exits cleanly", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "render-sup-force-"));
  const supervisorSource = await readFile(path.join(repoRoot, "scripts", "start-render.mjs"), "utf8");
  const abs = (segment) => JSON.stringify(path.join(repoRoot, segment));
  const ignorerScript = path.join(workspace, "ignorer.mjs");
  const companionScript = path.join(workspace, "companion.mjs");
  await writeFile(ignorerScript, "console.log('READY ignorer ' + process.pid);\nprocess.on('SIGTERM', () => console.log('swallowed SIGTERM'));\nprocess.on('SIGINT', () => {});\nsetInterval(() => {}, 1000);\n");
  await writeFile(companionScript, "console.log('READY companion ' + process.pid);\nsetInterval(() => {}, 1000);\n");
  const patched = supervisorSource
    .replace('"../apps/api/src/config.js"', abs("apps/api/src/config.js"))
    .replace('"../apps/api/src/storage/index.js"', abs("apps/api/src/storage/index.js"))
    .replace('"../apps/api/src/storage/local.js"', abs("apps/api/src/storage/local.js"))
    .replace('spawnChild("api", "apps/api/src/server.js");', `spawnChild("ignorer", ${JSON.stringify(ignorerScript)});`)
    .replace('spawnChild("worker", "apps/worker/src/worker.js");', `spawnChild("companion", ${JSON.stringify(companionScript)});`);
  // 源码漂移防护：替换必须全部生效，否则测试在测错东西。
  for (const marker of [abs("apps/api/src/config.js"), "ignorer", "companion"]) {
    expect(patched.includes(marker)).toBe(true);
  }
  const supervisorScript = path.join(workspace, "supervisor.mjs");
  await writeFile(supervisorScript, patched);

  const child = spawn(process.execPath, [supervisorScript], {
    env: { ...process.env, NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  const waitFor = async (needle) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const match = output.match(new RegExp(`READY ${needle} (\\d+)`));
      if (match) return Number(match[1]);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`child ${needle} never became ready: ${output.slice(-400)}`);
  };
  const ignorerPid = await waitFor("ignorer");
  const companionPid = await waitFor("companion");
  expect(alive(ignorerPid)).toBe(true);
  expect(alive(companionPid)).toBe(true);

  child.kill("SIGTERM");
  // companion 默认处理：1 秒内退出。
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
  expect(alive(companionPid), "companion should die on SIGTERM").toBe(false);
  // ignorer 吞掉 SIGTERM 仍存活：这正是需要 force 路径的场景（此时 Node 已置 killed=true）。
  expect(alive(ignorerPid), "ignorer must still be running after swallowing SIGTERM").toBe(true);

  // 10 秒宽限后 force SIGKILL：supervisor 在有界时间内以 0 退出，ignorer 被终结。
  const exitCode = await new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit("timeout"), 25_000);
    child.once("exit", (code) => { clearTimeout(timer); resolveExit(code); });
  });
  expect(exitCode, `supervisor output: ${output.slice(-500)}`).toBe(0);
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  expect(alive(ignorerPid), "ignorer must be SIGKILLed by the force path").toBe(false);
}, 45_000);
