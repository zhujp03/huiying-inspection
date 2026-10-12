import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../apps/admin/dist", import.meta.url));
const assets = join(dist, "assets");
const source = readdirSync(assets).filter((name) => name.endsWith(".js")).map((name) => readFileSync(join(assets, name), "utf8")).join("\n");
for (const forbidden of ["TraceConsole", "InspectorApp", "完整后端观察", "前端验收台", "mockRequest", "task-current", "survey-current", "edit-current"]) {
  assert.equal(source.includes(forbidden), false, `生产 bundle 不得包含 ${forbidden}`);
}
assert.ok(source.includes("管理员登录"), "生产 bundle 必须包含管理员登录入口");
console.log("admin production bundle: passed");
