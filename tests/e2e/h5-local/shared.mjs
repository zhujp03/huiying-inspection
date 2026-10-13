// H5 本地全流程浏览器回归共享常量：server.mjs（API 进程）与 spec（种子进程）必须一致。
// 密钥是测试专用值（与根 .env 的生产/开发密钥无关），只作用于 junde_test 与临时本地存储目录。
export const H5_TEST_AUTH_KEY = "h5-local-e2e-auth-key-h5-local-e2e-auth-key";
export const H5_TEST_PHONE_KEY = Buffer.alloc(32, 9).toString("base64");
export const H5_API_PORT = 3941;
export const H5_WEB_PORT = 5199;
export const INSPECTOR_USERNAME = "InspectorOne";
export const INSPECTOR_PASSWORD = "A-secure-pass";
export const ADMIN_USERNAME = "AdminOne";
export const ADMIN_PASSWORD = "A-secure-pass";

// 从根 .env 取 DATABASE_URL 并把库名替换为 junde_test；保险丝确保绝不指向开发库。不打印连接串。
import { readFileSync } from "node:fs";

export function testDatabaseUrl() {
  const envText = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
  const match = envText.match(/^DATABASE_URL=(.*)$/m);
  if (!match) throw new Error("DATABASE_URL not found in root .env");
  const devUrl = match[1].trim().replace(/^["']|["']$/g, "");
  const testUrl = new URL(devUrl);
  // 本机保险丝：仅允许回环地址上的 junde_test，绝不触碰开发/远端（Render）库。
  if (!["127.0.0.1", "::1", "localhost"].includes(testUrl.hostname)) throw new Error("refusing to operate on non-local database host");
  testUrl.pathname = "/junde_test";
  if (!/(test|realapi)/i.test(testUrl.pathname)) throw new Error("refusing to operate on non-test database");
  return testUrl.toString();
}
