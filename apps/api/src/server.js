import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createConfiguredProviders } from "./auth/providers.js";
import { createStorageProvider } from "./storage/index.js";

const config = loadConfig();
// 正式认证供应商（Tencent CAPTCHA / Tencent SMS）在此按配置创建并注入；
// 生产环境缺少必需供应商配置时 loadConfig/createConfiguredProviders 直接失败。
const providers = createConfiguredProviders(config);
const pool = createPool(config);
// 本地磁盘形态：HTTP 就绪之前先做存储根目录探测（mkdir + 写探针），磁盘缺失/挂载路径
// 错误在启动期直接失败关闭，绝不带着坏存储进入可访问状态。
if (config.STORAGE_PROVIDER === "local") await createStorageProvider(config).assertReady();
const app = buildApp({ config, pool, providers });
const close = async (signal) => { app.log.info({ signal }, "shutting down"); await app.close(); await pool?.end(); process.exit(0); };
process.once("SIGINT", () => close("SIGINT"));
process.once("SIGTERM", () => close("SIGTERM"));
await app.listen({ host: config.HOST, port: config.PORT });
