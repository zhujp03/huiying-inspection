import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API as sharedApi } from "../packages/contracts/index.js";
import { API as miniApi } from "../apps/miniapp/miniprogram/services/contracts.generated.js";

const root = fileURLToPath(new URL("..", import.meta.url));
function collectFiles(directory) {
  return readdirSync(directory).filter((name) => !["node_modules", "dist", ".codegraph", ".git"].includes(name)).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? collectFiles(path) : [path];
  });
}

const appFiles = collectFiles(join(root, "apps"));
assert.equal(appFiles.some((file) => [".ts", ".tsx"].includes(extname(file))), false, "业务源码不得包含 TypeScript 文件");

const productSource = appFiles.filter((file) => [".js", ".jsx", ".wxml"].includes(extname(file))).map((file) => readFileSync(file, "utf8")).join("\n");
for (const forbidden of ["USE_MOCK", "mockRequest", "task-current", "survey-current", "edit-current", "junde-survey-draft"]) {
  assert.equal(productSource.includes(forbidden), false, `生产源码不得包含 ${forbidden}`);
}

const appEntry = readFileSync(join(root, "apps/admin/src/App.jsx"), "utf8");
for (const diagnostic of ["TraceConsole", "InspectorApp", "完整后端观察", "前端验收台"]) assert.equal(appEntry.includes(diagnostic), false, `生产入口不得包含 ${diagnostic}`);
assert.equal(existsSync(join(root, "apps/admin/src/mockApi.js")), false, "生产 Mock 模块必须移除");

for (const key of ["mine", "byId", "checkIn", "start", "questionnaire"]) {
  const sample = typeof sharedApi.assignments[key] === "function" ? sharedApi.assignments[key]("assignment") : sharedApi.assignments[key];
  const projected = typeof miniApi.assignments[key] === "function" ? miniApi.assignments[key]("assignment") : miniApi.assignments[key];
  assert.equal(projected, sample, `小程序 assignment 契约 ${key} 必须与共享契约一致`);
}
for (const key of ["byId", "answer", "editSessions", "editSession", "evidenceUploads", "evidenceComplete", "evidence", "confirmEdit", "cancelEdit", "dishes", "receiptAttachments", "receiptUploads", "receiptComplete", "receiptAttachment", "receiptOcrJobs", "receiptOcrJob", "receiptOcrApply", "otherRecords", "submit"]) {
  const args = ["attempt", "question", "edit", "attachment"];
  const sample = sharedApi.drafts[key](...args);
  const projected = miniApi.drafts[key](...args);
  assert.equal(projected, sample, `小程序 draft 契约 ${key} 必须与共享契约一致`);
}

const surveyStore = readFileSync(join(root, "apps/miniapp/miniprogram/store/survey.js"), "utf8");
for (const identity of ["userId", "assignmentId", "attemptId", "questionnaireVersionId", "revision"]) assert.ok(surveyStore.includes(identity), `草稿隔离必须包含 ${identity}`);

const routeFiles = ["schedule", "task", "survey", "issue", "dishes", "other"].map((name) => readFileSync(join(root, `apps/miniapp/miniprogram/pages/${name}/index.js`), "utf8"));
for (const [index, content] of routeFiles.entries()) assert.ok(content.includes("assignmentId"), `业务页面 ${index + 1} 必须携带 assignmentId`);

const dishesPage = readFileSync(join(root, "apps/miniapp/miniprogram/pages/dishes/index.js"), "utf8");
const dishesView = readFileSync(join(root, "apps/miniapp/miniprogram/pages/dishes/index.wxml"), "utf8");
const otherPage = readFileSync(join(root, "apps/miniapp/miniprogram/pages/other/index.js"), "utf8");
const otherView = readFileSync(join(root, "apps/miniapp/miniprogram/pages/other/index.wxml"), "utf8");
assert.equal(dishesPage.includes("Date.now"), false, "额外菜品不得使用时间戳作为业务 ID");
assert.ok(dishesPage.includes("secureUuid"), "额外菜品必须使用安全 UUID");
assert.ok(dishesPage.includes("saveLocalDraft") && dishesPage.includes("markDraftSynced"), "菜品返回与继续都必须保存隔离草稿");
assert.ok(dishesView.includes('wx:key="id"'), "菜品必须以稳定业务 ID 渲染");
assert.ok(dishesView.includes("未选择全部满意") || dishesPage.includes("未选择全部满意"), "满意状态必须提供非颜色说明");
assert.equal(dishesView.includes("暂未启用"), false, "消费小票不得恢复为暂未启用");
for (const label of ["来自小票", "请核对", "系统推算", "已人工修改"]) assert.ok(dishesView.includes(label), `菜品页必须显示 ${label} 业务标记`);
const miniService = readFileSync(join(root, "apps/miniapp/miniprogram/services/api.js"), "utf8");
for (const method of ["listReceiptAttachments", "initializeReceiptUpload", "uploadToSignedTarget", "completeReceiptUpload", "deleteReceiptAttachment", "createReceiptOcrJob", "getReceiptOcrJob", "applyReceiptOcrJob"]) assert.ok(miniService.includes(`function ${method}`), `小程序服务必须实现 ${method}`);
for (const fixtureLeak of ["contract-server", "fixture adapter", "fixture://", "USE_FIXTURE"]) assert.equal(productSource.includes(fixtureLeak), false, `生产源码不得依赖测试设施 ${fixtureLeak}`);
const comparisonView = readFileSync(join(root, "apps/admin/src/components/ReceiptComparison.jsx"), "utf8");
assert.ok(comparisonView.includes("已锁定") && comparisonView.includes("小票识别原始结果") && comparisonView.includes("探店员最终菜品"), "管理员详情必须包含只读小票比对");
assert.equal(/<(input|textarea|select|button)\b/.test(comparisonView), false, "管理员小票比对不得提供编辑控件");
assert.ok(otherPage.indexOf("saveRecords()") < otherPage.indexOf("wx.showModal"), "其他记录必须保存成功后再显示不可逆确认");
assert.ok(otherView.includes("输入闪光点") && otherView.includes("请填写问卷中未列出但您认为可以改进的地方"), "其他记录占位文案必须符合阶段规格");

const visibleFiles = [
  ...collectFiles(join(root, "apps/miniapp/miniprogram/pages")).filter((file) => extname(file) === ".wxml"),
  join(root, "apps/admin/src/pages/AdminLogin.jsx"),
];
const forbiddenVisiblePatterns = [/\/api\//i, /HTTP\s*\d/i, /assignment[_ ]?id/i, /attempt[_ ]?id/i, /storage[_ ]?key/i, /stack\s*trace/i, /409\s*Conflict/i, /submit\s*token/i, /revision/i];
for (const file of visibleFiles) {
  const content = readFileSync(file, "utf8");
  for (const pattern of forbiddenVisiblePatterns) assert.equal(pattern.test(content), false, `${file} 不得出现用户可见工程信息 ${pattern}`);
}

console.log("frontend contracts: passed");
