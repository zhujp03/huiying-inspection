const { spawn } = require("node:child_process");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "../..");
const port = 8788;

function startMiniappFixtureServer() {
  return new Promise((resolve, reject) => {
    // 清理被强杀测试遗留的旧契约服务，避免 8788 端口占用导致本次启动失败。
    try { require("node:child_process").execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`); } catch { /* 无占用 */ }
    const child = spawn(process.execPath, ["tests/fixtures/contract-server.mjs"], {
      cwd: projectRoot,
      env: { ...process.env, CONTRACT_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => finish(new Error("小程序测试契约服务启动超时")), 10_000);
    const finish = (error) => {
      clearTimeout(timeout);
      child.stdout.off("data", onOutput);
      child.stderr.off("data", onOutput);
      child.off("error", finish);
      child.off("exit", onExit);
      error ? reject(error) : resolve(child);
    };
    const onOutput = (chunk) => {
      output += String(chunk);
      if (output.includes(`test contract server ready on ${port}`)) finish();
    };
    const onExit = (code) => finish(new Error(`小程序测试契约服务提前退出 (${code}): ${output}`));
    child.on("error", finish);
    child.on("exit", onExit);
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
  });
}

function stopMiniappFixtureServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKill);
      clearTimeout(timeout);
      resolve();
    };
    const forceKill = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1_000);
    const timeout = setTimeout(finish, 5_000);
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

module.exports = { startMiniappFixtureServer, stopMiniappFixtureServer };
