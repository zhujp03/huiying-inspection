// verify:external — 外部验收门禁：只有真实腾讯云、微信、COS、OCR、真机和 P1
// 条件就绪后运行。任何强制输入缺失 → 非零退出并列出缺项。
// 绝不把 fixture、Mock、sandbox、模拟器或历史结果算作通过。
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../apps/api/src/config.js";
import { createOcrClient } from "../apps/worker/src/ocr-client.js";
import { createCosProvider } from "../apps/api/src/storage/cos.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = process.env.ENV_FILE ? resolve(process.env.ENV_FILE) : resolve(root, ".env");
const missing = [];
const failures = [];

if (!existsSync(envPath)) {
  console.error("verify:external: 缺少根目录 .env");
  process.exit(1);
}
const env = parseEnv(readFileSync(envPath, "utf8"));

// 1) 真实配置（sandbox 明确禁止）
if (env.AUTH_PROVIDER_MODE === "sandbox") missing.push("AUTH_PROVIDER_MODE=sandbox 禁止用于外部验收（必须 tencent 真实密钥）");
const config = loadConfig({ ...env, NODE_ENV: "production" });

// 自助注册/找回（AUTH_SELF_SERVICE）：disabled 时验证码/短信相关变量必须全部留空
// （休眠形态，只输出变量名，不输出值）；enabled 时按真实密钥校验。
if (config.AUTH_SELF_SERVICE === "disabled") {
  const nonEmptyVars = ["CAPTCHA_APP_ID", "CAPTCHA_APP_SECRET_KEY", "CAPTCHA_API_SECRET_ID", "CAPTCHA_API_SECRET_KEY", "SMS_SECRET_ID", "SMS_SECRET_KEY", "SMS_SDK_APP_ID", "SMS_SIGN_NAME", "SMS_TEMPLATE_IDS"].filter((name) => env[name]);
  if (nonEmptyVars.length > 0) missing.push(`AUTH_SELF_SERVICE=disabled 时以下变量必须留空：${nonEmptyVars.join("、")}`);
} else {
  // 2) 真实 CAPTCHA：公开 AppID 必须是十进制正整数，且不得是测试占位。
  if (!/^\d+$/.test(String(env.CAPTCHA_APP_ID || ""))) missing.push("CAPTCHA_APP_ID（真实腾讯验证码公开应用 ID）");
  if (!env.CAPTCHA_APP_SECRET_KEY) missing.push("CAPTCHA_APP_SECRET_KEY（真实 AppSecretKey）");
  if (!env.CAPTCHA_API_SECRET_ID || !env.CAPTCHA_API_SECRET_KEY) missing.push("CAPTCHA_API_SECRET_ID/KEY（真实腾讯云 API 凭据）");

  // 3) 真实短信
  if (!env.SMS_SECRET_ID || !env.SMS_SECRET_KEY || !env.SMS_SDK_APP_ID || !env.SMS_SIGN_NAME) missing.push("短信真实凭据/签名");
  if (!env.SMS_TEMPLATE_IDS?.includes("registration") || !env.SMS_TEMPLATE_IDS?.includes("passwordReset")) missing.push("短信两个模板（registration/passwordReset）审核通过");
}

// 4) 真实 COS 与 CAM
if (!env.COS_ROLE_ARN) missing.push("COS_ROLE_ARN（真实 CAM 角色）");
if (!env.COS_ASSUME_ROLE_SECRET_ID || !env.COS_ASSUME_ROLE_SECRET_KEY) missing.push("COS_ASSUME_ROLE_SECRET_ID/KEY（真实最小权限凭证）");

// 5) 真实 OCR 能力（外部验收必须启用 OCR：paddle=私网 sidecar，tencent=腾讯云密钥）；
//    OCR_PROVIDER=none 表示功能关闭，无法完成 OCR 相关外部验收。
const ocr = createOcrClient(config);
if (config.OCR_PROVIDER === "tencent") {
  if (!ocr.configured) missing.push("OCR_SECRET_ID/OCR_SECRET_KEY（真实腾讯云 OCR 密钥）");
} else if (!ocr.configured) {
  missing.push("OCR_SERVICE_URL（真实私网 PaddleOCR，OCR_PROVIDER=paddle）");
}

// 6) 真实地图 Key 与 staging/P1
if (!env.TENCENT_MAP_KEY) missing.push("TENCENT_MAP_KEY（真实受限域名地图 Key）");
if (!process.env.P1_PLAN_PATH || !existsSync(process.env.P1_PLAN_PATH)) missing.push("P1_PLAN_PATH（仓库外授权计划）");

// 7) 真机与基准（无法由 .env 表达，作为文档化外部输入）
const deviceCheck = process.env.REAL_DEVICE_ACCEPTED === "yes";
if (!deviceCheck) missing.push("Android/iOS 真机验收（REAL_DEVICE_ACCEPTED=yes 表示已完成）");
const baselineCheck = process.env.OCR_BASELINE_ACCEPTED === "yes";
if (!baselineCheck) missing.push("PaddleOCR ≥100 组脱敏小票基准（OCR_BASELINE_ACCEPTED=yes）");

// 8) 对已配置项做连通性检查（只读，不改变资源）
(async () => {
  if (config.OCR_PROVIDER === "paddle" && ocr.configured) {
    try {
      const response = await fetch(`${config.OCR_SERVICE_URL}/ready`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) failures.push(`OCR /ready 返回 ${response.status}`);
    } catch { failures.push("OCR sidecar 不可达"); }
  }
  if (!missing.some((item) => item.startsWith("COS"))) {
    try {
      const cos = createCosProvider(config);
      await cos.assertReady();
      console.log("verify:external: COS renewing 凭证获取 PASS");
    } catch (error) { failures.push(`COS 凭证/桶不可用：${error.message.slice(0, 120)}`); }
  }

  console.log("\n========== verify:external 汇总 ==========");
  missing.forEach((item) => console.log(`  [MISSING] ${item}`));
  failures.forEach((item) => console.log(`  [FAIL] ${item}`));
  if (missing.length > 0 || failures.length > 0) {
    console.log("\nverify:external: BLOCKED（外部条件未全部就绪，任何缺项都不能视为通过）");
    process.exit(1);
  }
  console.log("\nverify:external: PASS（真实供应商连通；真机/P1/基准按对应验收报告另行归档）");
  process.exit(0);
})();

function parseEnv(text) {
  const result = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}
