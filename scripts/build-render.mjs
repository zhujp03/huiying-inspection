// Render 构建编排（npm run build:render）：
//   1) 探员端 H5（apps/web，基 /，同源 /api，零域名规则不变）；
//   2) 管理后台（apps/admin，vite --base /admin/）——Admin 的地图组件消费构建期
//      VITE_TENCENT_MAP_KEY，Render Blueprint 只提供运行时 secret TENCENT_MAP_KEY，
//      这里把它原样映射为该键注入 Admin 构建（进程环境优先于任何 envDir 文件）。
// 密钥只经环境变量流转，绝不写入仓库/模板/产物之外的位置；键缺失时注入空串
// （Admin 地图按未配置形态降级，与本地空键构建一致），不阻塞构建。
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

const run = (label, command, args, extraEnv = {}) => {
  console.log(`[build:render] ${label}`);
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
  if (result.status !== 0) {
    console.error(`[build:render] ${label} failed (exit=${result.status})`);
    process.exit(result.status || 1);
  }
};

run("build web (base /)", "npm", ["--prefix", "apps/web", "run", "build"]);
// TENCENT_MAP_KEY → VITE_TENCENT_MAP_KEY：仅此构建注入，普通 build:admin 不受影响。
run("build admin (base /admin/)", "npm", ["--prefix", "apps/admin", "run", "build:render"], {
  VITE_TENCENT_MAP_KEY: process.env.TENCENT_MAP_KEY ?? "",
});
console.log("[build:render] done");
