// 集成测试会 TRUNCATE 业务表（用户/门店/品牌/任务等）：误指向开发库时必须立即失败，而不是清空数据。
// 事故背景：2026-09-05 campaign-deadline 集成测试跑在开发库上，清空了全部业务数据。
export function assertIntegrationTestDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) return; // 未提供 DATABASE_URL 时测试自行跳过（各文件既有行为）
  let database = "";
  try {
    database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("DATABASE_URL 无法解析，拒绝运行集成测试");
  }
  if (!/(test|realapi)/i.test(database)) {
    throw new Error(`集成测试只允许在测试库上运行（当前库名「${database}」不含 test/realapi）。开发库会被清空；请使用：DATABASE_URL="postgresql://<user>:<pw>@<host>:<port>/junde_test" npm run test:backend`);
  }
}
