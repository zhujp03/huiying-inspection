// fixture 测试专用：把小程序项目复制到临时目录，并剥离生产 app.json 中尚未在
// 开发者工具授权的人机验证插件声明（插件需要在微信公众平台添加后才能本地编译）。
// 生产项目配置保持不动；本工具只服务于 tests/e2e 的 fixture 视觉/交互回归。
const { cp, mkdtemp, rm, readFile, writeFile } = require("node:fs/promises");
const { execFileSync, spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const projectRoot = resolve(__dirname, "../..");
const CLI = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 彻底停止开发者工具（cli quit → 兜底强杀残留进程），保证下一次 launch 从干净状态开始。
async function stopDevTools() {
  try { spawnSync(CLI, ["quit"], { timeout: 30000 }); } catch { /* 忽略 */ }
  await sleep(6000);
  try {
    const listening = execFileSync("lsof", ["-nP", "-iTCP:9420", "-sTCP:LISTEN"], { encoding: "utf8" });
    if (listening.trim()) {
      try { spawnSync("pkill", ["-f", "wechatwebdevtools"], { timeout: 10000 }); } catch { /* 忽略 */ }
      await sleep(6000);
    }
  } catch { /* 9420 未监听，无需强杀 */ }
}

async function prepareMiniappProjectForFixture(projectPath = join(projectRoot, "apps/miniapp")) {
  const work = await mkdtemp(join(tmpdir(), "junde-miniapp-fixture-"));
  await cp(projectPath, work, { recursive: true, force: true });
  const appJsonPath = join(work, "miniprogram/app.json");
  const appJson = JSON.parse(await readFile(appJsonPath, "utf8"));
  if (appJson.plugins) {
    delete appJson.plugins;
    await writeFile(appJsonPath, JSON.stringify(appJson, null, 2));
    process.stdout.write("fixture miniapp copy: captcha plugin declaration stripped (production app.json unchanged)\n");
  }
  const loginJsonPath = join(work, "miniprogram/pages/login/index.json");
  try {
    const loginJson = JSON.parse(await readFile(loginJsonPath, "utf8"));
    if (loginJson.usingComponents?.["t-captcha"]) {
      delete loginJson.usingComponents["t-captcha"];
      await writeFile(loginJsonPath, JSON.stringify(loginJson, null, 2));
    }
  } catch { /* 页面可能不存在 */ }
  return { projectPath: work, cleanup: () => rm(work, { recursive: true, force: true }) };
}

module.exports = { prepareMiniappProjectForFixture, stopDevTools };
