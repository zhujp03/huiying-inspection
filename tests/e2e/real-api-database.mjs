// 真实 API 小程序流程的测试库派生助手（纯函数，便于安全回归测试）：
//   - loadRootEnvFile：Node24 process.loadEnvFile 的“存在才加载”包装（ENOENT 静默跳过），
//     让本机开发者在根 .env 提供连接串；不打印、不持久化任何值。
//   - deriveRealApiTestDatabaseUrl：从管理连接串派生独立测试库 URL（pathname 替换为
//     /junde_realapi），并强制校验目标隔离：主机必须回环、库名必须为 junde_realapi——
//     绝不把源 junde 库 / 生产 / 云端库当作测试靶（即使显式传入也失败关闭）。
//   - postgresAdminUrl：管理连接（server 级，db=postgres），用于 DROP/CREATE 测试库。
// 源码中不得出现任何具体连接串字面量；凭证只经环境变量/根 .env 流转。
import { existsSync } from "node:fs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export const REAL_API_TEST_DB_NAME = "junde_realapi";

export function loadRootEnvFile(envFilePath) {
  // Node ≥21.7 提供 process.loadEnvFile；存在才加载，缺失视为“未提供本地配置”。
  if (!existsSync(envFilePath)) return false;
  try {
    process.loadEnvFile(envFilePath);
    return true;
  } catch (error) {
    throw new Error(`根 .env 解析失败（${error.code || error.message}）；请修正后再运行真实 API 流程`);
  }
}

const assertLoopback = (url, label) => {
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${label} 必须指向本机回环地址（127.0.0.1/localhost），禁止指向生产/云端数据库`);
  }
};

export function deriveRealApiTestDatabaseUrl({ databaseUrl, adminDatabaseUrl } = {}) {
  const source = databaseUrl || adminDatabaseUrl;
  if (!source || typeof source !== "string") {
    throw new Error("缺少数据库连接：请通过环境变量 REAL_API_DATABASE_URL / DATABASE_URL（或根 .env）提供，源码不内嵌凭证");
  }
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error("REAL_API_DATABASE_URL/DATABASE_URL 无法解析");
  }
  assertLoopback(parsed, "真实 API 测试库");
  const testUrl = new URL(source);
  testUrl.protocol = "postgresql:";
  testUrl.pathname = `/${REAL_API_TEST_DB_NAME}`;
  testUrl.search = "";
  testUrl.hash = "";
  // 二次校验派生结果：隔离库命中 + 回环，双闸缺一不可。
  if (testUrl.pathname !== `/${REAL_API_TEST_DB_NAME}`) throw new Error("测试库名派生失败");
  assertLoopback(testUrl, "真实 API 测试库");
  return testUrl.toString();
}

export function postgresAdminUrl(databaseUrl) {
  if (!databaseUrl || typeof databaseUrl !== "string") throw new Error("缺少管理连接：请提供 REAL_API_ADMIN_DATABASE_URL / DATABASE_URL（或根 .env）");
  const parsed = new URL(databaseUrl);
  assertLoopback(parsed, "测试库管理连接");
  const adminUrl = new URL(databaseUrl);
  adminUrl.protocol = "postgresql:";
  adminUrl.pathname = "/postgres";
  adminUrl.search = "";
  adminUrl.hash = "";
  return adminUrl.toString();
}
