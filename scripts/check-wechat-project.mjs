// 微信项目唯一性检查（WP5）：
//   1. 唯一正式微信项目目录是 apps/miniapp；正式 AppID 只允许 wx35690c1079fb5a5d。
//   2. 仓库不得出现第二个生产 AppID（测试 fixture 的特殊 AppID 在白名单内）。
//   3. 小程序源码不得包含占位值（YOUR_*/change-me）。
//   4. app.json 插件版本/位置权限/requiredPrivateInfos/组件声明检查。
// 根目录 project.config.json 与 apps/miniapp/miniprogram/project.config.json 是
// 用户既有改动，本检查只允许它们声明正式 AppID，不删除、不覆盖。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PRODUCTION_APPID = "wx35690c1079fb5a5d";
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

// 1) 全仓库扫描 project.config.json，收集 AppID
const appidFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name === "project.config.json") appidFiles.push(full);
  }
};
walk(root);

const testFixtureWhitelist = new Set([]);
for (const file of appidFiles) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  const appid = json.appid || null;
  if (!appid) continue;
  if (appid === PRODUCTION_APPID) continue;
  if (testFixtureWhitelist.has(appid)) continue;
  failures.push(`发现非正式 AppID ${appid} 在 ${file}`);
}

// 2) 正式项目必须存在且指向 miniprogram/
const officialConfig = join(root, "apps/miniapp/project.config.json");
check(existsSync(officialConfig), "apps/miniapp/project.config.json 不存在（唯一正式微信项目目录）");
if (existsSync(officialConfig)) {
  const official = JSON.parse(readFileSync(officialConfig, "utf8"));
  check(official.appid === PRODUCTION_APPID, `apps/miniapp 正式 AppID 必须是 ${PRODUCTION_APPID}`);
  check(official.miniprogramRoot === "miniprogram/", "apps/miniapp/project.config.json 的 miniprogramRoot 必须是 miniprogram/");
}

// 3) 小程序源码占位值扫描（不含生成文件与测试目录）
const miniappSource = join(root, "apps/miniapp/miniprogram");
const skipDirs = new Set(["fixtures"]);
const scanPlaceholders = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || skipDirs.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) scanPlaceholders(full);
    else if (/\.(js|json|wxml|wxss)$/.test(entry.name)) {
      const source = readFileSync(full, "utf8");
      if (/YOUR_|change-me|YOUR_TENCENT/i.test(source)) failures.push(`小程序源码含占位值：${full}`);
    }
  }
};
scanPlaceholders(miniappSource);

// 4) app.json 插件/权限/组件声明
const appJsonPath = join(miniappSource, "app.json");
const appJson = JSON.parse(readFileSync(appJsonPath, "utf8"));
check(appJson.plugins?.captcha?.version === "2.1.4", "app.json 腾讯验证码插件 version 必须是 2.1.4");
check(appJson.plugins?.captcha?.provider === "wx1fe8d9a3cb067a75", "app.json 腾讯验证码插件 provider 必须是 wx1fe8d9a3cb067a75");
check(Boolean(appJson.permission?.["scope.userLocation"]?.desc), "app.json 必须声明 scope.userLocation 权限描述");
check(Array.isArray(appJson.requiredPrivateInfos) && appJson.requiredPrivateInfos.includes("getLocation"), "app.json requiredPrivateInfos 必须包含 getLocation");
const loginJson = JSON.parse(readFileSync(join(miniappSource, "pages/login/index.json"), "utf8"));
check(loginJson.usingComponents?.["t-captcha"] === "plugin://captcha/t-captcha", "登录页必须声明 plugin://captcha/t-captcha 组件");

if (failures.length > 0) {
  console.error("check-wechat-project FAILED:");
  failures.forEach((failure) => console.error(`  - ${failure}`));
  process.exit(1);
}
console.log("check-wechat-project PASS（唯一正式项目 apps/miniapp，AppID " + PRODUCTION_APPID + "）");
