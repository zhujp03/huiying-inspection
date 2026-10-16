import { expect, test } from "@playwright/test";
import { attachBusinessConsoleCollector } from "../helpers/admin-e2e-console.mjs";

async function login(page, username = "ops") {
  await page.goto("/");
  await page.getByLabel("管理员账号").fill(username);
  await page.getByLabel("密码").fill("correct-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("暗访执行工作台")).toBeVisible();
}

// 向导门店三级下拉的可访问名以选项文本结尾（如"店号请先选择品牌"），
// getByLabel 默认子串匹配会让"品牌"误中"店号"，这里用锚定正则只认字段自身的 span 文本。
function wizardStoreSelect(page, label) {
  return page.getByLabel(new RegExp(`^${label}`));
}

test("管理员登录、角色菜单和主要业务数据", async ({ page }) => {
  const consoleCollector = attachBusinessConsoleCollector(page);
  await login(page);
  await page.getByRole("button", { name: "用户管理" }).click();
  await page.getByRole("button", { name: /注册审批/ }).click();
  await expect(page.locator(".registration-panel").getByText("周雨晴")).toBeVisible();
  await page.getByRole("button", { name: "批准", exact: true }).click();
  await expect(page.getByText("批准这名探店员？")).toBeVisible();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("申请已批准")).toBeVisible();
  await page.getByRole("button", { name: "提交记录" }).click();
  await page.getByRole("button", { name: "查看详情" }).click();
  await expect(page.getByText("完整题目")).toBeVisible();
  await expect(page.locator(".submission-question-list article")).toHaveCount(50);
  const visibleText = await page.locator("body").innerText();
  expect(visibleText).not.toMatch(/\/api\/|HTTP\s*\d|assignment_id|attempt_id|storage key|stack trace|submit token|revision/i);
  await consoleCollector.expectClean();
});

test("门店负责人只能看到授权菜单", async ({ page }) => {
  await login(page, "store");
  await expect(page.getByRole("button", { name: "门店管理" })).toBeVisible();
  await expect(page.getByRole("button", { name: "提交记录" })).toBeVisible();
  await expect(page.getByRole("button", { name: "数据看板" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "用户管理" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "问卷题库" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "导出中心" })).toHaveCount(0);
});

test("数据看板展示统计报表并支持导出 Excel", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "数据看板" }).click();
  await expect(page.getByRole("heading", { name: "得分趋势" })).toBeVisible();
  await expect(page.getByText("2026-07月").first()).toBeVisible();
  await page.locator(".report-nav").getByRole("button", { name: "门店大项得分率对比" }).click();
  await expect(page.getByRole("heading", { name: "门店大项得分率对比" })).toBeVisible();
  await expect(page.getByText("共 2 条")).toBeVisible();
  await page.locator(".report-nav").getByRole("button", { name: "考核点整体得分率展示" }).click();
  await expect(page.getByText("点餐时是否有向您推荐特色产品？")).toBeVisible();
  await page.getByRole("button", { name: /导出 Excel/ }).click();
  await expect(page.getByText("统计表已生成，已开始下载")).toBeVisible();
});

test("服务失败显示业务化错误并允许重试", async ({ page }) => {
  await login(page);
  await page.route("**/api/admin/stores*", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SERVICE_DOWN" } }) }));
  await page.getByRole("button", { name: "门店管理" }).click();
  await expect(page.getByText("服务暂时不可用，请稍后重试")).toBeVisible();
  await expect(page.getByRole("button", { name: "重新加载" })).toBeVisible();
});

test("会话过期显示原位重登遮罩（登录后可回到当前路由）", async ({ page }) => {
  await login(page);
  // 模拟真实过期：业务请求与 /api/me 探测都被拒绝（客户端会先核对 cookie 真实身份）
  await page.route("**/api/admin/campaigns*", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "SESSION_EXPIRED" } }) }));
  await page.route("**/api/me", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "SESSION_EXPIRED" } }) }));
  await page.getByRole("button", { name: "探店任务" }).click();
  // 过期不再整页跳回登录：工作台被遮罩覆盖并提示重新登录，重登后按当前路由恢复
  await expect(page.getByRole("heading", { name: "登录已过期，请重新登录" })).toBeVisible();
  await expect(page.getByText("暗访执行工作台")).toBeHidden();
});

test("探店任务指派、题库五十题、空导出和审计页面", async ({ page }) => {
  // 操作审计仅 super_admin/auditor 可见（普通管理员已无 audit:read），本用例改用超管登录
  await login(page, "super");
  await page.getByRole("button", { name: "探店任务" }).click();
  await page.getByRole("button", { name: "查看指派" }).click();
  await expect(page.getByText("探店员指派表")).toBeVisible();
  await expect(page.getByRole("cell", { name: "周雨晴" })).toBeVisible();
  await page.getByRole("row", { name: /周雨晴/ }).getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "豁免记录" }).click();
  await expect(page.getByText("商场室内定位漂移")).toBeVisible();
  await page.getByRole("button", { name: "问卷题库" }).click();
  await page.getByRole("row", { name: /夏季版/ }).getByRole("button", { name: "查看题目" }).click();
  await expect(page.locator(".question-pick-list button")).toHaveCount(50);
  await expect(page.getByRole("button", { name: "保存题目设置" })).toHaveCount(0);
  await page.getByRole("button", { name: "导出中心" }).click();
  await expect(page.getByText(/还没有导出记录/)).toBeVisible();
  await page.getByRole("button", { name: "操作审计" }).click();
  await expect(page.getByText("批准注册申请")).toBeVisible();
});

test("审批 revision 冲突转换为业务提示", async ({ page }) => {
  await login(page);
  await page.route("**/api/admin/inspector-registrations/registration-one/approve", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "REVISION_CONFLICT" } }) }));
  await page.getByRole("button", { name: "用户管理" }).click();
  await page.getByRole("button", { name: /注册审批/ }).click();
  await page.getByRole("button", { name: "批准", exact: true }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("内容已更新，请刷新后重试")).toBeVisible();
});

test("父任务表单使用服务端门店并保存完整时间窗口", async ({ page }, testInfo) => {
  await login(page);
  await page.getByRole("button", { name: "探店任务" }).click();
  await page.getByRole("button", { name: "新建探店任务" }).click();
  await expect(page.getByRole("heading", { name: "新建探店任务" })).toBeVisible();
  await page.getByLabel("任务名称").fill("秋季暗访计划");
  await wizardStoreSelect(page, "品牌").selectOption("1a6fd7a0-1111-4111-8111-000000000001");
  await wizardStoreSelect(page, "店号").selectOption("JD-SH-001");
  // JD-SH-001 在建新园组内对应两家门店，不会自动收敛，需手选店名
  await wizardStoreSelect(page, "店名").selectOption("store-one");
  await page.getByLabel("探店开始日期").fill("2026-07-20");
  await page.getByLabel("探店结束日期").fill("2026-07-20");
  await page.getByLabel("探店开始时间").fill("10:00");
  await page.getByLabel("探店结束时间").fill("14:00");
  await page.getByLabel("问卷最终截止").fill("2026-07-20T20:00");
  await page.getByLabel("共用说明").fill("保持自然就餐，关注高峰期服务。");
  await page.screenshot({ path: testInfo.outputPath("admin-campaign-wizard.png"), fullPage: true });
  await page.getByRole("button", { name: "下一步：指派探店员" }).click();
  await expect(page.getByText("任务草稿已创建，请继续指派探店员")).toBeVisible();
  await expect(page.getByRole("button", { name: "添加探店员" })).toBeVisible();
});

test("父任务表单门店三级级联选择与组切换清空", async ({ page }) => {
  let savedCampaign;
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/admin/campaigns")) savedCampaign = request.postDataJSON(); });
  await login(page);
  await page.getByRole("button", { name: "探店任务" }).click();
  await page.getByRole("button", { name: "新建探店任务" }).click();
  await expect(page.getByRole("heading", { name: "新建探店任务" })).toBeVisible();
  await expect(wizardStoreSelect(page, "品牌")).toBeEnabled();
  await expect(wizardStoreSelect(page, "店号")).toBeDisabled();
  await expect(wizardStoreSelect(page, "店名")).toBeDisabled();
  await wizardStoreSelect(page, "品牌").selectOption("1a6fd7a0-1111-4111-8111-000000000001");
  await expect(wizardStoreSelect(page, "店号")).toBeEnabled();
  const noOptions = await wizardStoreSelect(page, "店号").locator("option").evaluateAll((options) => options.filter((option) => option.value).map((option) => option.value));
  expect(noOptions).toEqual(["JD-SH-001"]);
  await wizardStoreSelect(page, "店号").selectOption("JD-SH-001");
  await expect(wizardStoreSelect(page, "店名")).toBeEnabled();
  await expect(wizardStoreSelect(page, "店名")).toHaveValue("");
  const nameOptions = await wizardStoreSelect(page, "店名").locator("option").evaluateAll((options) => options.filter((option) => option.value).map((option) => option.textContent.trim()));
  expect(nameOptions).toEqual(["静安嘉里中心店 · 静安区", "静安大融城店 · 静安区"]);
  await wizardStoreSelect(page, "店名").selectOption("store-three");
  await page.getByLabel("任务名称").fill("级联暗访计划");
  await page.getByLabel("探店开始日期").fill("2026-07-21");
  await page.getByLabel("探店结束日期").fill("2026-07-21");
  await page.getByLabel("探店开始时间").fill("09:00");
  await page.getByLabel("探店结束时间").fill("12:00");
  await page.getByLabel("问卷最终截止").fill("2026-07-21T18:00");
  await page.getByRole("button", { name: "下一步：指派探店员" }).click();
  await expect(page.getByText("任务草稿已创建，请继续指派探店员")).toBeVisible();
  expect(savedCampaign.storeId).toBe("store-three");
  await page.getByRole("button", { name: "上一步" }).click();
  await wizardStoreSelect(page, "品牌").selectOption("__unbranded__");
  await expect(wizardStoreSelect(page, "店号")).toHaveValue("");
  await expect(wizardStoreSelect(page, "店名")).toHaveValue("");
  await wizardStoreSelect(page, "店号").selectOption("JD-SH-002");
  await expect(wizardStoreSelect(page, "店名")).toHaveValue("store-two");
});

test("任务指派完整保存问卷、时间、预算和菜品", async ({ page }, testInfo) => {
  let savedAssignment;
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/admin/campaigns/campaign-one/assignments")) savedAssignment = request.postDataJSON(); });
  await login(page);
  await page.getByRole("button", { name: "探店任务" }).click();
  await page.getByRole("button", { name: "查看指派" }).click();
  // 详情页「添加探店员」直达向导指派步；向导内再添加一位探店员
  await page.getByRole("button", { name: "添加探店员" }).click();
  await page.locator(".wizard-row").first().waitFor();
  await page.getByRole("button", { name: "添加探店员" }).click();
  const row = page.locator(".wizard-row").last();
  await row.getByLabel("探店员").selectOption("user-inspector-two");
  await row.getByLabel("已发布问卷版本").selectOption("version-one");
  await row.getByLabel("预算上限（元）").fill("600");
  await row.getByRole("checkbox", { name: "要求上传消费小票" }).check();
  await row.getByLabel("个人特别说明").fill("重点观察迎宾和巡台。");
  await row.getByLabel("菜品名称").fill("招牌烤鸭");
  await page.screenshot({ path: testInfo.outputPath("admin-assignment-editor.png"), fullPage: true });
  await page.getByRole("button", { name: "下一步：确认并发布" }).click();
  await expect(page.getByRole("heading", { name: /指派明细/ })).toBeVisible();
  expect(savedAssignment.receiptRequired).toBe(true);
  expect(savedAssignment.budgetLimit).toBe(600);
  expect(savedAssignment.inspectorId).toBe("user-inspector-two");
});

test("提交筛选、分类得分、菜品和审计详情", async ({ page }, testInfo) => {
  await login(page);
  await page.getByRole("button", { name: "提交记录" }).click();
  await page.getByLabel("门店筛选").selectOption("静安嘉里中心店");
  await page.getByLabel("区域筛选").selectOption("静安区");
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect(page.getByRole("button", { name: "应用筛选" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "周雨晴" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("admin-submission-filters.png"), fullPage: true });
  await page.getByRole("button", { name: "查看详情" }).click();
  await expect(page.getByText("环境卫生")).toBeVisible();
  await expect(page.getByText("招牌烤鸭").first()).toBeVisible();
  // 详情契约回归：真实响应形态（售罄菜品 evaluation=null、fullySatisfied=false、得分题无备注键）
  // 曾因 dishes DTO 缺字段/备注 null 导致整页契约失败——这里必须渲染出菜品记录与导出入口，而非报错
  await expect(page.getByText("消费小票与最终菜品比对")).toBeVisible();
  await expect(page.getByText("小票识别原始结果")).toBeVisible();
  await expect(page.getByText("探店员最终菜品")).toBeVisible();
  await expect(page.locator(".receipt-thumbnail-list a")).toHaveCount(2);
  await expect(page.locator(".receipt-comparison input, .receipt-comparison textarea, .receipt-comparison select, .receipt-comparison button")).toHaveCount(0);
  await expect(page.getByText("人工新增菜品").first()).toBeVisible();
  await expect(page.getByText("价格已人工核对")).toBeVisible();
  await expect(page.getByText("提交审计记录")).toBeVisible();
  await expect(page.locator(".submission-question-list article")).toHaveCount(50);
  // 售罄菜品按真实快照渲染：状态「已售罄」、未评价菜品不冒充满意
  await expect(page.locator(".dish-result-list article", { hasText: "桂花糖藕" })).toContainText("已售罄");
  await expect(page.locator(".dish-result-list article", { hasText: "桂花糖藕" })).toContainText("未填写评价");
  // 导出控件在详情契约通过后可见（此前被契约失败整体遮蔽）
  await expect(page.getByRole("button", { name: /导出这份问卷 Excel/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("admin-submission-detail-full.png"), fullPage: true });
  await page.locator(".receipt-comparison").screenshot({ path: testInfo.outputPath("admin-receipt-comparison.png") });
});

test("提交记录导出携带至多不得分数筛选且不含旧键", async ({ page }) => {
  let exportPayload;
  // pattern 尾缀 * 必须盖住 query string；在浏览器层优先拦截，fixture 服务不校验导出 body
  await page.route("**/api/admin/exports*", (route) => {
    exportPayload = route.request().postDataJSON();
    route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "44444444-4444-4444-8444-444444444444", fileName: "导出任务处理中", createdAt: "2026-10-11T08:00:00Z", status: "queued", downloadUrl: null }) });
  });
  await login(page);
  await page.getByRole("button", { name: "提交记录" }).click();
  await page.getByRole("button", { name: /更多筛选/ }).click();
  await page.getByLabel("最多不得分数").fill("2");
  await page.getByRole("button", { name: "导出当前结果" }).click();
  await expect(page.getByText("导出当前结果？")).toBeVisible();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("筛选结果导出已创建")).toBeVisible();
  expect(exportPayload.filters.maxIssueCount).toBe(2);
  expect(exportPayload.filters).not.toHaveProperty("issueCountAtLeast");
});

test("审批默认待审核并支持已批准、未通过和已停用筛选", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "用户管理" }).click();
  await page.getByRole("button", { name: /注册审批/ }).click();
  await expect(page.locator(".registration-panel").getByText("周雨晴")).toBeVisible();
  await page.locator(".registration-panel").getByRole("button", { name: "已批准 1" }).click();
  await expect(page.locator(".registration-panel").getByText("陈一帆")).toBeVisible();
  await page.locator(".registration-panel").getByRole("button", { name: "未通过 1" }).click();
  await expect(page.locator(".registration-panel").getByText("孙可欣")).toBeVisible();
  await page.locator(".registration-panel").getByRole("button", { name: "已停用 1" }).click();
  await expect(page.locator(".registration-panel").getByText("赵书瑞")).toBeVisible();
});

test("门店编辑展示地图业务失败和启停控件", async ({ page }, testInfo) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
  await expect(page.locator(".map-footer").getByText("地图服务尚未配置，请联系管理员")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "门店启用，可创建新任务" })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("admin-store-map-unconfigured.png"), fullPage: true });
});

test("问卷详情显示发布检查", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "问卷题库" }).click();
  await page.getByRole("row", { name: /夏季版/ }).getByRole("button", { name: "查看题目" }).click();
  await expect(page.getByText("启用题数量：通过")).toBeVisible();
  await expect(page.getByText("题号连续：通过")).toBeVisible();
  await expect(page.getByText("证据配置：通过")).toBeVisible();
});

test("问卷草稿支持分类筛选与题目管理操作", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "问卷题库" }).click();
  await page.getByRole("row", { name: /秋季草稿版/ }).getByRole("button", { name: "查看题目" }).click();
  await expect(page.getByRole("button", { name: "添加题目" })).toBeVisible();
  await expect(page.locator(".question-pick-item")).toHaveCount(3);
  await page.locator(".question-filter-row").getByRole("button", { name: "为客服务" }).click();
  await expect(page.locator(".question-pick-item")).toHaveCount(1);
  await page.locator(".question-filter-row").getByRole("button", { name: "全部" }).click();
  await expect(page.locator(".question-pick-actions")).toHaveCount(3);
  await expect(page.locator(".question-pick-actions button.link-danger")).toHaveCount(3);
});

test("门店列表支持删除且确认后提示成功", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  const row = page.getByRole("row", { name: /静安嘉里中心店/ });
  await row.getByRole("button", { name: "删除" }).click();
  await expect(page.getByText("删除这家门店？")).toBeVisible();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("门店已删除")).toBeVisible();
});

test("用户管理支持删除账号且确认后提示成功", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "用户管理" }).click();
  const row = page.getByRole("row", { name: /周雨晴/ });
  await row.getByRole("button", { name: "删除" }).click();
  await expect(page.getByText("删除这个账号？")).toBeVisible();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("账号已删除")).toBeVisible();
});

test("运营概览显示数据看板并可跳转", async ({ page }) => {
  await login(page);
  await expect(page.getByText("待审核申请")).toBeVisible();
  await expect(page.getByText("待发布任务")).toBeVisible();
  await expect(page.getByText("进行中任务")).toBeVisible();
  await expect(page.getByText("已发布问卷")).toBeVisible();
  await expect(page.getByRole("button", { name: /门店/ }).first()).toBeVisible();
  await expect(page.getByText("累计提交")).toBeVisible();
  await expect(page.getByText("最近提交")).toBeVisible();
  // 功能开关只读展示：fixture 的 client-config 下发 features.receiptOcr=true，概览应显示「已开启」。
  await expect(page.getByText("小票识别（OCR）")).toBeVisible();
  await expect(page.locator(".feature-flag").getByText("已开启")).toBeVisible();
  await expect(page.getByRole("cell", { name: "周雨晴" })).toHaveCount(0);
  await expect(page.getByText("周雨晴", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "待发布任务" }).click();
  await expect(page.getByRole("heading", { name: "探店任务与指派" })).toBeVisible();
});

test("新建问卷支持创建并发布", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "问卷题库" }).click();
  await page.getByRole("button", { name: "新建问卷" }).click();
  await page.getByLabel("问卷名称").fill("创建即发布问卷");
  await page.getByPlaceholder("第 1 题内容").fill("门头招牌是否完好整洁");
  await page.getByPlaceholder("第 2 题内容").fill("地面是否干净无杂物");
  await page.locator(".editor-footer").getByRole("button", { name: "创建并发布" }).click();
  await expect(page.getByText("创建并发布这个问卷版本？")).toBeVisible();
  await expect(page.getByText(/将创建并发布 V1，共 2 道题/)).toBeVisible();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("问卷已发布")).toBeVisible();
  const row = page.getByRole("row", { name: /创建即发布问卷/ });
  await expect(row).toBeVisible();
  await expect(row.getByText("已发布")).toBeVisible();
});

test("创建并发布在发布检查未过时阻断并定位问题行", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "问卷题库" }).click();
  await page.getByRole("button", { name: "新建问卷" }).click();
  await page.getByLabel("问卷名称").fill("清零冲突问卷");
  await page.getByPlaceholder("第 1 题内容").fill("门头招牌是否完好整洁");
  await page.getByPlaceholder("第 2 题内容").fill("地面是否干净无杂物");
  await page.getByRole("checkbox", { name: "分数清零题" }).first().check();
  await page.getByRole("checkbox", { name: "分数清零题" }).nth(1).check();
  await expect(page.locator(".qw-error")).toHaveCount(2);
  await page.locator(".editor-footer").getByRole("button", { name: "创建并发布" }).click();
  await expect(page.getByText(/发布检查未通过：第 1 题/)).toBeVisible();
  await expect(page.getByText("创建并发布这个问卷版本？")).toHaveCount(0);
});

test("草稿详情操作条随检查状态启停", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "问卷题库" }).click();
  await page.getByRole("row", { name: /秋季草稿版/ }).getByRole("button", { name: "查看题目" }).click();
  const actionBar = page.locator(".questionnaire-action-bar");
  await expect(actionBar).toBeVisible();
  await expect(actionBar).toContainText("检查 4/4 通过");
  await expect(actionBar.getByRole("button", { name: "发布版本" })).toHaveCount(1);
  await expect(actionBar.getByRole("button", { name: "发布版本" })).toBeEnabled();
  await page.getByRole("button", { name: "返回版本列表" }).click();
  await page.getByRole("row", { name: /发布检查未过草稿/ }).getByRole("button", { name: "查看题目" }).click();
  await expect(page.locator(".questionnaire-action-bar")).toContainText("检查 3/4 通过（未过：清零题数量）");
  await expect(page.locator(".questionnaire-action-bar").getByRole("button", { name: "发布版本" })).toBeDisabled();
});

test("门店列表超过 100 条支持加载更多并操作靠后记录", async ({ page }) => {
  const consoleCollector = attachBusinessConsoleCollector(page);
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  // fixture 造了 130 家门店：首屏 limit=100 只见前 100 条，压测门店 227 号店（store-z227，asc 排序在 101+ 位）不在
  await expect(page.getByText("已加载 100 家门店")).toBeVisible();
  await expect(page.getByRole("cell", { name: /静安嘉里中心店/ })).toBeVisible();
  await expect(page.getByText("压测门店 227 号店")).toHaveCount(0);
  await page.getByRole("button", { name: "加载更多" }).click();
  await expect(page.getByText("压测门店 227 号店")).toBeVisible();
  // 加载完后 nextCursor=null，pager 隐藏
  await expect(page.getByText(/已加载 \d+ 家门店/)).toHaveCount(0);
  // 对靠后记录执行操作：行内删除按钮可用并弹出确认
  await page.getByRole("row", { name: /压测门店 227 号店/ }).getByRole("button", { name: "删除" }).click();
  await expect(page.getByText("删除这家门店？")).toBeVisible();
  await consoleCollector.expectClean();
});

test("向导指派步通过加载更多与检索选中第 100 名以外的探员", async ({ page }) => {
  const consoleCollector = attachBusinessConsoleCollector(page);
  let savedAssignment;
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/admin/campaigns/campaign-one/assignments")) savedAssignment = request.postDataJSON(); });
  await login(page);
  await page.getByRole("button", { name: "探店任务" }).click();
  await page.getByRole("button", { name: "查看指派" }).click();
  // 详情页「添加探店员」直达向导指派步
  await page.getByRole("button", { name: "添加探店员" }).click();
  await page.locator(".wizard-row").first().waitFor();
  // 新增一行待指派
  await page.getByRole("button", { name: "添加探店员" }).click();
  const row = page.locator(".wizard-row").last();
  const inspectorSelect = row.getByLabel("探店员");
  // 首屏 100 位探员（user-inspector-131..228 + 2 名既有），第 128 号不在其中
  await expect(page.getByRole("button", { name: /加载更多探店员/ })).toBeVisible();
  await page.getByLabel("检索探店员").fill("压测探员 128");
  await expect(inspectorSelect.locator("option")).toHaveCount(1); // 仅剩空选项
  await page.getByRole("button", { name: /加载更多探店员/ }).click();
  await expect(page.getByRole("button", { name: /加载更多探店员/ })).toHaveCount(0); // 130 位加载完，游标到底
  await inspectorSelect.selectOption("user-inspector-128");
  await row.getByLabel("已发布问卷版本").selectOption("version-one");
  await page.getByRole("button", { name: "下一步：确认并发布" }).click();
  await expect(page.getByRole("heading", { name: /指派明细/ })).toBeVisible();
  expect(savedAssignment.inspectorId).toBe("user-inspector-128");
  await consoleCollector.expectClean();
});

test("门店品牌筛选切换后游标重置并从首页重新查询", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  await expect(page.getByText("已加载 100 家门店")).toBeVisible();
  await page.getByRole("button", { name: "加载更多" }).click();
  await expect(page.getByText("压测门店 227 号店")).toBeVisible();
  // 切筛选 = 换 path 重查：请求带 brandId 且不含 cursor，追加行不残留
  const filterRequest = page.waitForRequest((request) => request.url().includes("/api/admin/stores?") && request.url().includes("brandId=1a6fd7a0-1111-4111-8111-000000000001"));
  await page.getByLabel("门店品牌筛选").selectOption("1a6fd7a0-1111-4111-8111-000000000001");
  const matched = await filterRequest;
  expect(matched.url()).not.toContain("cursor=");
  await expect(page.getByRole("row", { name: /静安嘉里中心店/ })).toBeVisible();
  await expect(page.getByText("压测门店 227 号店")).toHaveCount(0);
  await expect(page.getByText(/已加载 \d+ 家门店/)).toHaveCount(0); // 建新园仅 2 家，无更多页
});

// —— 延期弹窗（双窗口 + 原因必填，钉死契约 POST /api/admin/assignments/:id/extend）———
// 用例统一走 campaign-one 详情里延期专用的「压测探员 101 号」指派行（fixture assignment-extend，
// 该探员不被任何既有用例选中指派），避免污染既有用例依赖的 assignment-one 数据。
async function openExtendDialog(page) {
  await login(page);
  await page.getByRole("button", { name: "探店任务" }).click();
  await page.getByRole("button", { name: "查看指派" }).click();
  await expect(page.getByText("探店员指派表")).toBeVisible();
  await page.getByRole("row", { name: /压测探员 101 号/ }).getByRole("button", { name: "延期", exact: true }).click();
  await expect(page.getByText("延期这条指派？")).toBeVisible();
}

test("延期弹窗展示双窗口字段与当前截止提示", async ({ page }) => {
  const consoleCollector = attachBusinessConsoleCollector(page);
  await openExtendDialog(page);
  // 只读提示：展示该指派当前 dueAt / questionnaireDeadlineAt，帮助运营判断
  await expect(page.getByText(/当前执行截止/)).toBeVisible();
  await expect(page.getByText(/当前问卷最终截止/)).toBeVisible();
  // 双窗口均可空，默认空；原因必填
  await expect(page.getByLabel("执行截止")).toHaveValue("");
  await expect(page.getByLabel("问卷最终截止")).toHaveValue("");
  await expect(page.getByLabel("延期原因")).toHaveValue("");
  await consoleCollector.expectClean();
});

test("延期弹窗行内校验拦截缺时间与缺原因且不发请求", async ({ page }) => {
  const consoleCollector = attachBusinessConsoleCollector(page);
  let extendRequests = 0;
  page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/api/admin/assignments/assignment-extend/extend")) extendRequests += 1; });
  await openExtendDialog(page);
  // 只填原因、两日期全空：拦截「至少一项」，不发请求
  await page.getByLabel("延期原因").fill("门店装修停电");
  await page.getByRole("button", { name: "确认延期" }).click();
  await expect(page.getByText("请至少填写一项延期时间")).toBeVisible();
  // 原因也清空：必填错误同样就地展示，仍无网络请求
  await page.getByLabel("延期原因").fill("");
  await page.getByRole("button", { name: "确认延期" }).click();
  await expect(page.getByText("请填写延期原因")).toBeVisible();
  expect(extendRequests).toBe(0);
  await consoleCollector.expectClean();
});

test("延期提交携带 revision 与已填时间原因并刷新详情回显", async ({ page }) => {
  const consoleCollector = attachBusinessConsoleCollector(page);
  const extendPosted = page.waitForRequest((request) => request.method() === "POST" && request.url().includes("/api/admin/assignments/assignment-extend/extend"));
  await openExtendDialog(page);
  await page.getByLabel("执行截止").fill("2026-07-25T10:30");
  await page.getByLabel("延期原因").fill("门店装修停电，顺延执行窗口");
  await page.getByRole("button", { name: "确认延期" }).click();
  const payload = (await extendPosted).postDataJSON();
  // 钉死契约（AssignmentExtendSchema）：dueAt 为 UTC ISO；revision 必填（乐观锁）；
  // 未填的 questionnaireDeadlineAt 不出现在 body
  expect(payload.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
  expect(payload.reason).toBe("门店装修停电，顺延执行窗口");
  expect(payload).not.toHaveProperty("questionnaireDeadlineAt");
  expect(Number.isInteger(payload.revision)).toBe(true);
  expect(payload.revision).toBeGreaterThanOrEqual(1);
  // 成功：关闭弹窗 + 任务详情刷新，新截止时间回显到指派表
  await expect(page.getByText("任务已延期")).toBeVisible();
  await expect(page.getByText("延期这条指派？")).toHaveCount(0);
  const expected = new Date(payload.dueAt).toLocaleString("zh-CN", { hour12: false });
  await expect(page.getByRole("row", { name: /压测探员 101 号/ })).toContainText(expected);
  await consoleCollector.expectClean();
});

test("延期双窗口提交两键均在且为 UTC ISO", async ({ page }) => {
  const consoleCollector = attachBusinessConsoleCollector(page);
  const extendPosted = page.waitForRequest((request) => request.method() === "POST" && request.url().includes("/api/admin/assignments/assignment-extend/extend"));
  await openExtendDialog(page);
  await page.getByLabel("执行截止").fill("2026-07-26T10:30");
  await page.getByLabel("问卷最终截止").fill("2026-07-26T20:00");
  await page.getByLabel("延期原因").fill("台风过境，双窗口整体顺延");
  await page.getByRole("button", { name: "确认延期" }).click();
  const payload = (await extendPosted).postDataJSON();
  expect(payload.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
  expect(payload.questionnaireDeadlineAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
  expect(Number.isInteger(payload.revision)).toBe(true);
  expect(payload.revision).toBeGreaterThanOrEqual(1);
  await expect(page.getByText("任务已延期")).toBeVisible();
  await consoleCollector.expectClean();
});

test("提交详情单份问卷导出：确认→排队→生成→下载链接", async ({ page }) => {
  const consoleCollector = attachBusinessConsoleCollector(page);
  await login(page);
  await page.getByRole("button", { name: "提交记录" }).click();
  await page.getByRole("button", { name: "查看详情" }).click();
  await expect(page.getByText("完整题目")).toBeVisible();
  // 创建任务只绑定这一份提交（body 携带 submissionId，无任何汇总筛选键）
  const exportPosted = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/api/admin/exports"));
  await page.getByRole("button", { name: "导出这份问卷 Excel" }).click();
  await expect(page.getByText("导出这份问卷？")).toBeVisible();
  await page.getByRole("button", { name: "确认导出" }).click();
  const payload = (await exportPosted).postDataJSON();
  expect(Object.keys(payload)).toEqual(["submissionId"]);
  // 行内状态随轮询推进（排队→生成中→成功），pending 期间按钮禁用防重复发起
  await expect(page.getByText("单份问卷导出已创建，正在生成文件")).toBeVisible();
  await expect(page.getByRole("button", { name: /导出进行中…|正在创建导出任务…/ })).toBeDisabled();
  await expect(page.getByText(/正在生成 Excel 文件…|导出任务排队中…/)).toBeVisible();
  await expect(page.getByRole("link", { name: "下载 Excel" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/下载链接有时效/)).toBeVisible();
  await consoleCollector.expectClean();
});

test("单份问卷导出失败展示安全原因并可重新生成，pending 期间禁止重复发起", async ({ page }) => {
  const consoleCollector = attachBusinessConsoleCollector(page);
  const failedJobId = "66666666-6666-6666-8666-666666666666";
  // 浏览器层拦截：任务始终失败（第 3 次轮询起），前两轮保持排队以验证禁用态
  let statusPolls = 0;
  const jobResponse = (status) => JSON.stringify({ id: failedJobId, fileName: "单份问卷导出（生成中）", createdByName: "测试管理员", createdAt: "2026-10-11T08:00:00Z", status, downloadUrl: null, failureCode: status === "failed" ? "EXPORT_SUBMISSION_SCORES_MISSING" : null });
  await page.route("**/api/admin/exports", async (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: failedJobId, fileName: "单份问卷导出（生成中）", createdAt: "2026-10-11T08:00:00Z", status: "queued", downloadUrl: null }) });
    }
    await route.fallback();
  });
  await page.route(`**/api/admin/exports/${failedJobId}`, (route) => {
    statusPolls += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: jobResponse(statusPolls <= 2 ? "queued" : "failed") });
  });
  await login(page);
  await page.getByRole("button", { name: "提交记录" }).click();
  await page.getByRole("button", { name: "查看详情" }).click();
  await expect(page.getByText("完整题目")).toBeVisible();
  await page.getByRole("button", { name: "导出这份问卷 Excel" }).click();
  await page.getByRole("button", { name: "确认导出" }).click();
  // 失败原因按稳定错误码映射为安全可行动提示（不引导用户去别处“查看原因”）
  await expect(page.getByText("这份提交缺少可安全导出的逐题得分数据（可能是历史数据不完整），无法生成评估表。")).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "重新生成" })).toBeVisible();
  // 重新生成：新任务进入 pending → 按钮禁用防重复；随后轮询再次失败仍可重试
  await page.getByRole("button", { name: "重新生成" }).click();
  await expect(page.getByRole("button", { name: /导出进行中…|正在创建导出任务…/ })).toBeDisabled();
  await expect(page.getByText("这份提交缺少可安全导出的逐题得分数据（可能是历史数据不完整），无法生成评估表。")).toBeVisible({ timeout: 15000 });
  await consoleCollector.expectClean();
});

test("离开详情页即中止在途创建与轮询（卸载后无任何状态查询）", async ({ page }) => {
  const consoleCollector = attachBusinessConsoleCollector(page);
  const delayedJobId = "77777777-7777-7777-8777-777777777777";
  let statusPolls = 0;
  await page.route("**/api/admin/exports", async (route) => {
    if (route.request().method() === "POST") {
      // 创建请求保持在途，让“离开页面”发生在 POST 未返回时
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: delayedJobId, fileName: "单份问卷导出（生成中）", createdAt: "2026-10-11T08:00:00Z", status: "queued", downloadUrl: null }) });
    }
    await route.fallback();
  });
  await page.route(`**/api/admin/exports/${delayedJobId}`, (route) => {
    statusPolls += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: delayedJobId, fileName: "单份问卷导出（生成中）", createdByName: "测试管理员", createdAt: "2026-10-11T08:00:00Z", status: "queued", downloadUrl: null }) });
  });
  await login(page);
  await page.getByRole("button", { name: "提交记录" }).click();
  await page.getByRole("button", { name: "查看详情" }).click();
  await expect(page.getByText("完整题目")).toBeVisible();
  await page.getByRole("button", { name: "导出这份问卷 Excel" }).click();
  await page.getByRole("button", { name: "确认导出" }).click();
  // 创建仍在途即返回列表（组件卸载应中止创建请求，且不启动轮询）
  await page.getByRole("button", { name: "返回提交列表" }).click();
  await expect(page.getByText("提交结果")).toBeVisible();
  // 越过「创建返回（1.5s）+ 首个轮询间隔（2s）」窗口后仍无任何状态查询
  await page.waitForTimeout(4200);
  expect(statusPolls).toBe(0);
  await consoleCollector.expectClean();
});

test("状态查询失败保留任务并可「重新检查」恢复，不自动重复生成", async ({ page }) => {
  // 刻意 503 会产生浏览器自身的资源加载 console error（同既有“服务失败”用例，不采集 console）
  const jobId = "88888888-8888-8888-8888-888888888888";
  let statusCalls = 0;
  await page.route("**/api/admin/exports", async (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: jobId, fileName: "单份问卷导出（生成中）", createdAt: "2026-10-11T08:00:00Z", status: "queued", downloadUrl: null }) });
    }
    await route.fallback();
  });
  await page.route(`**/api/admin/exports/${jobId}`, (route) => {
    statusCalls += 1;
    // 503 不在自动重试窗口内：首次查询失败即转入可恢复的「重新检查」态
    if (statusCalls <= 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SERVICE_DOWN" } }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: jobId, fileName: "暗访评估_测试.xlsx", createdByName: "测试管理员", createdAt: "2026-10-11T08:00:00Z", status: "succeeded", downloadUrl: "https://exports.example.cos.test/signed-download" }) });
  });
  await login(page);
  await page.getByRole("button", { name: "提交记录" }).click();
  await page.getByRole("button", { name: "查看详情" }).click();
  await expect(page.getByText("完整题目")).toBeVisible();
  await page.getByRole("button", { name: "导出这份问卷 Excel" }).click();
  await page.getByRole("button", { name: "确认导出" }).click();
  // 查询失败：任务保留、出现「重新检查」，主按钮保持禁用（不重复生成）
  await expect(page.getByText("服务暂时不可用，请稍后重试")).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "重新检查" })).toBeVisible();
  await expect(page.getByRole("button", { name: /导出进行中…|正在创建导出任务…/ })).toBeDisabled();
  // 恢复：复查同一任务（无新 POST），查询成功后出下载链接
  const postsDuring = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/api/admin/exports"), { timeout: 1000 }).catch(() => null);
  await page.getByRole("button", { name: "重新检查" }).click();
  await expect(page.getByRole("link", { name: "下载 Excel" })).toBeVisible({ timeout: 15000 });
  expect(await postsDuring).toBeNull(); // 重新检查绝不新建任务
});
