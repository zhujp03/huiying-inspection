// 存储供应商工厂：STORAGE_PROVIDER=local 走本地磁盘形态（仅 development/test），
// 默认 cos 保持既有私有 COS 形态与全部云上行为不变。API 与 worker 都经由此工厂创建，
// 保证两端共享同一 LOCAL_STORAGE_DIR 配置。
import { createCosProvider } from "./cos.js";
import { createLocalStorageProvider } from "./local.js";

export function createStorageProvider(config, clock = () => new Date(), logger = console) {
  if (config.STORAGE_PROVIDER === "local") return createLocalStorageProvider(config, clock, logger);
  return createCosProvider(config, clock, logger);
}
