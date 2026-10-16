import { expect, test } from "@playwright/test";

// Admin 路由回归：真实 pathname URL、客户端导航、深链接/刷新、登录返回、权限与未知路径、
// 历史完整性（守卫取消/确认后的返回前进顺序）、表单弹窗未保存保护、向导 URL 为准、
// 题库乐观锁/发布只读。复用 admin.spec.js 的 fixture 服务（tests/fixtures/contract-server.mjs）。

async function login(page, username = "ops") {
  await page.goto("/admin/overview");
  await page.getByLabel("管理员账号").fill(username);
  await page.getByLabel("密码").fill("correct-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("暗访执行工作台")).toBeVisible();
}

const MENU_PAGES = [
  ["数据看板", "/admin/dashboard"],
  ["探店任务", "/admin/campaigns"],
  ["用户管理", "/admin/users"],
  ["门店管理", "/admin/stores"],
  ["问卷题库", "/admin/questionnaires"],
  ["提交记录", "/admin/submissions"],
  ["导出中心", "/admin/exports"],
];

test("菜单点击产生独立 pathname 并保持导航高亮", async ({ page }) => {
  await login(page);
  for (const [label, path] of MENU_PAGES) {
    await page.getByRole("button", { name: label }).click();
    await expect(page).toHaveURL(`http://127.0.0.1:4174${path}`);
    await expect(page.locator(".admin-sidebar").getByRole("button", { name: label })).toHaveClass(/is-active/);
  }
});

test("概览卡片与「查看全部」客户端跳转对应路由", async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL(/\/admin\/overview$/);
  await page.getByRole("button", { name: "待发布任务" }).click();
  await expect(page).toHaveURL(/\/admin\/campaigns$/);
  await page.getByRole("button", { name: "运营概览" }).click();
  await page.getByRole("button", { name: "查看全部" }).click();
  await expect(page).toHaveURL(/\/admin\/submissions$/);
});

test("根入口 replace 规整为 /admin/overview 且不产生冗余历史", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("管理员账号").fill("ops");
  await page.getByLabel("密码").fill("correct-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("暗访执行工作台")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/overview$/);
  // replace 语义：返回应离开站点而不是回到 /（无冗余中间历史）。
  await page.goBack();
  expect(new URL(page.url()).pathname).not.toBe("/");
});

test("未知路径显示友好 404 页并可返回概览", async ({ page }) => {
  await login(page);
  await page.goto("/admin/some/unknown/page");
  await expect(page.getByText("页面不存在或链接有误")).toBeVisible();
  await page.getByRole("button", { name: "返回运营概览" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/);
  await expect(page.getByText("暗访执行工作台")).toBeVisible();
});

test("任务详情深链接直接拉取并渲染指派表", async ({ page }) => {
  await login(page);
  await page.goto("/admin/campaigns/campaign-one");
  await expect(page.getByText("探店员指派表")).toBeVisible();
  await expect(page.getByRole("cell", { name: "周雨晴" })).toBeVisible();
  // 子路由保持父级导航高亮
  await expect(page.locator(".admin-sidebar").getByRole("button", { name: "探店任务" })).toHaveClass(/is-active/);
});

test("首屏之外的门店深链接编辑按 ID 拉取权威数据", async ({ page }) => {
  await login(page);
  // store-z227 只在游标第二页（首屏 100 条之外），深链接必须按 ID 拉取而非依赖列表内存状态
  await page.goto("/admin/stores/store-z227/edit");
  await expect(page.getByRole("heading", { name: "编辑门店和范围" })).toBeVisible();
  await expect(page.getByLabel("门店名称")).toHaveValue("压测门店 227 号店");
  await expect(page.getByLabel("门店编号")).toHaveValue("JD-SH-227");
});

test("账号编辑深链接回填账号数据", async ({ page }) => {
  await login(page);
  await page.goto("/admin/users/user-inspector-one/edit");
  await expect(page.getByRole("heading", { name: "编辑账号" })).toBeVisible();
  await expect(page.getByLabel("姓名")).toHaveValue("周雨晴");
});

test("问卷版本深链接渲染题目编辑台并支持题目选中参数", async ({ page }) => {
  await login(page);
  await page.goto("/admin/questionnaires/version-draft?question=draft-question-2");
  await expect(page.getByText("启用 3 / 共 3 题")).toBeVisible();
  await expect(page.locator(".question-pick-item.is-active")).toContainText("地面是否干净无杂物");
  await expect(page.getByRole("heading", { name: "题目设置" })).toBeVisible();
  // 切换题目更新查询串（客户端导航）
  await page.locator(".question-pick-item").first().getByRole("button", { name: /门店门头是否整洁/ }).click();
  await expect(page).toHaveURL(/question=draft-question-1/);
  await expect(page.locator(".question-pick-item.is-active")).toContainText("门店门头是否整洁");
});

test("提交详情深链接直接渲染完整提交", async ({ page }) => {
  await login(page);
  await page.goto("/admin/submissions/submission-one");
  await expect(page.getByRole("heading", { name: "夏季门店服务品质暗访" })).toBeVisible();
  await expect(page.getByText("完整题目")).toBeVisible();
});

test("用户 tab 由查询串承载且刷新可恢复", async ({ page }) => {
  await login(page);
  await page.goto("/admin/users");
  await page.getByRole("button", { name: /注册审批/ }).click();
  await expect(page).toHaveURL(/\/admin\/users\?tab=registrations$/);
  await expect(page.locator(".registration-panel").getByText("周雨晴")).toBeVisible();
  await page.reload();
  await expect(page.locator(".registration-panel").getByText("周雨晴")).toBeVisible();
});

test("登出状态下打开深链接：登录后返回目标页面", async ({ page }) => {
  await page.goto("/admin/stores/store-one/edit");
  await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
  await page.getByLabel("管理员账号").fill("ops");
  await page.getByLabel("密码").fill("correct-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "编辑门店和范围" })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/stores\/store-one\/edit$/);
  await expect(page.getByLabel("门店名称")).toHaveValue("静安嘉里中心店");
});

test("会话过期显示重登遮罩且重新登录后回到目标路由", async ({ page }) => {
  await login(page);
  await page.route("**/api/admin/campaigns*", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "SESSION_EXPIRED" } }) }));
  await page.route("**/api/me", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "SESSION_EXPIRED" } }) }));
  await page.getByRole("button", { name: "探店任务" }).click();
  await expect(page.getByRole("heading", { name: "登录已过期，请重新登录" })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/campaigns$/); // 意图路由保留在地址栏
  await page.unroute("**/api/admin/campaigns*");
  await page.getByLabel("管理员账号").fill("ops");
  await page.getByLabel("密码").fill("correct-password");
  await page.getByRole("button", { name: "登录" }).click();
  // 过期期间列表落在可重试错误态：重登后一键恢复
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(page.getByRole("heading", { name: "探店任务与指派" })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/campaigns$/);
});

test("问卷版本深链接会话失效切登录遮罩且登录后恢复", async ({ page }) => {
  await login(page);
  // 会话失效发生在「已加载的应用」里：恢复探测与该版本的详情请求一并被拒（列表端点不受拦截）
  await page.route("**/api/me", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "SESSION_EXPIRED", requestId: "fixture-request" } }) }));
  await page.route("**/api/admin/questionnaire-versions/version-draft*", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "SESSION_EXPIRED", requestId: "fixture-request" } }) }));
  await page.getByRole("button", { name: "问卷题库" }).click();
  await page.getByRole("row", { name: /秋季草稿版/ }).getByRole("button", { name: "查看题目" }).click();
  await expect(page.getByRole("heading", { name: "登录已过期，请重新登录" })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/questionnaires\/version-draft/); // 意图路由保留在地址栏
  await page.unroute("**/api/admin/questionnaire-versions/version-draft*");
  await page.unroute("**/api/me");
  await page.getByLabel("管理员账号").fill("ops");
  await page.getByLabel("密码").fill("correct-password");
  await page.getByRole("button", { name: "登录" }).click();
  // 过期期间详情落在可重试错误态：重登后一键恢复，再进入选中题目
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(page.getByRole("heading", { name: "秋季暗访问卷" })).toBeVisible();
  await page.locator(".question-pick-main", { hasText: "地面是否干净无杂物" }).click();
  await expect(page.getByRole("heading", { name: "题目设置" })).toBeVisible();
  await expect(page).toHaveURL(/question=draft-question-2/);
});

test("新标签页借助会话 cookie 恢复登录态并直达深链接", async ({ context }) => {
  const first = await context.newPage();
  await login(first);
  const second = await context.newPage();
  await second.goto("/admin/submissions/submission-one");
  await expect(second.getByRole("heading", { name: "夏季门店服务品质暗访" })).toBeVisible();
  await first.close();
  await second.close();
});

test("有效 cookie 在无任何本地提示（含旧版本提示）时依然恢复登录态", async ({ context, baseURL }) => {
  // 旧版本只在 sessionStorage 写 junde:admin-session=active；新版本不再依赖任何本地提示——
  // 只要服务端 cookie 有效（这里直接注入 fixture 会话 cookie），冷加载探测即可恢复。
  await context.addCookies([{ name: "adminRole", value: "operations_admin", url: baseURL }]);
  const legacy = await context.newPage();
  await legacy.addInitScript(() => sessionStorage.setItem("junde:admin-session", "active"));
  await legacy.goto("/admin/campaigns/campaign-one");
  await expect(legacy.getByText("探店员指派表")).toBeVisible(); // 旧提示 + cookie：直接恢复
  await legacy.close();
  const bare = await context.newPage(); // 无任何提示：cookie 权威恢复
  await bare.goto("/admin/campaigns/campaign-one");
  await expect(bare.getByText("探店员指派表")).toBeVisible();
  await bare.close();
});

test("无效会话 cookie 冷加载回登录页并保留意图路由", async ({ page }) => {
  await page.goto("/admin/stores/store-z227/edit");
  await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/stores\/store-z227\/edit$/);
  await page.getByLabel("管理员账号").fill("ops");
  await page.getByLabel("密码").fill("correct-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByLabel("门店名称")).toHaveValue("压测门店 227 号店");
});

test("无权限路径零请求并显示友好拒绝页", async ({ page }) => {
  await login(page, "store"); // store_manager：仅 store:manage + submission:read
  await expect(page.getByRole("button", { name: "探店任务" })).toHaveCount(0); // 侧栏无权菜单不显示
  // 只统计被拒路由导航窗口内的受保护请求（概览卡片统计是既有行为，不计入）。
  let protectedRequests = 0;
  let counting = false;
  page.on("request", (request) => { if (counting && /\/api\/admin\/(users|campaigns)(\?|$)/.test(request.url())) protectedRequests += 1; });
  counting = true;
  await page.goto("/admin/users");
  await expect(page.getByText("你没有权限访问此页面")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await page.goto("/admin/campaigns");
  await expect(page.getByText("你没有权限访问此页面")).toBeVisible();
  counting = false;
  expect(protectedRequests).toBe(0); // 拒绝页不发受保护列表请求
});

test("不存在/已删除的 ID 给出可恢复的业务提示", async ({ page }) => {
  await login(page);
  await page.goto("/admin/campaigns/not-exist-campaign");
  await expect(page.locator(".empty-business").getByText(/数据不存在|不存在/)).toBeVisible();
  await expect(page.getByRole("button", { name: "返回任务列表" })).toBeVisible();
  await page.getByRole("button", { name: "返回任务列表" }).click();
  await expect(page).toHaveURL(/\/admin\/campaigns$/);
});

test("浏览器返回/前进在列表与详情之间正确恢复", async ({ page }) => {
  await login(page);
  await page.goto("/admin/campaigns");
  await page.getByRole("button", { name: "查看指派" }).click();
  await expect(page).toHaveURL(/\/admin\/campaigns\/campaign-one$/);
  await expect(page.getByText("探店员指派表")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/campaigns$/);
  await expect(page.getByRole("heading", { name: "探店任务与指派" })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/admin\/campaigns\/campaign-one$/);
  await expect(page.getByText("探店员指派表")).toBeVisible();
  // 顶层页面间返回/前进同样成立
  await page.getByRole("button", { name: "门店管理" }).click();
  await expect(page).toHaveURL(/\/admin\/stores$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/campaigns\/campaign-one$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/admin\/stores$/);
});

test("守卫确认后历史保持真实遍历：返回顺序不乱、前进条目不丢", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click(); // entry: stores
  await page.getByRole("button", { name: "新建门店" }).click(); // entry: stores/new
  await page.getByLabel("门店名称").fill("历史完整性门店");
  await page.goBack();
  await page.getByRole("button", { name: "放弃并离开" }).click(); // 确认 → 真实遍历回 stores
  await expect(page).toHaveURL(/\/admin\/stores$/);
  await expect(page.getByRole("heading", { name: "门店与打卡范围" })).toBeVisible();
  // 再返回 → 应到 overview（真实历史顺序，不会被 pushState 卷入重复条目）
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/overview$/);
  // 前进链未被销毁：overview → stores → stores/new
  await page.goForward();
  await expect(page).toHaveURL(/\/admin\/stores$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/admin\/stores\/new$/);
  await expect(page.getByRole("heading", { name: "新建门店" })).toBeVisible();
  await expect(page.getByLabel("门店名称")).toHaveValue(""); // 新挂载的干净编辑器（确认丢弃不残留）
});

test("脏态下被取消的 Forward 保留前进条目，确认 Forward 真实到达", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click(); // stores
  await page.getByRole("button", { name: "新建门店" }).click(); // stores/new
  await page.getByRole("button", { name: "提交记录" }).click(); // 前推一个干净条目（编辑器尚干净）
  await expect(page).toHaveURL(/\/admin\/submissions$/);
  await page.goBack(); // 回到 stores/new（干净，直接返回）
  await expect(page).toHaveURL(/\/admin\/stores\/new$/);
  await page.getByLabel("门店名称").fill("前进拦截门店"); // 当前条目变脏
  // Forward → 被守卫拦截 → 取消：留在编辑器、数据保留、前进条目仍在
  await page.goForward();
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toBeVisible();
  await page.getByRole("button", { name: "留在本页" }).click();
  await expect(page).toHaveURL(/\/admin\/stores\/new$/);
  await expect(page.getByLabel("门店名称")).toHaveValue("前进拦截门店");
  // Forward → 再拦截 → 确认：真实遍历到前进条目
  await page.goForward();
  await page.getByRole("button", { name: "放弃并离开" }).click();
  await expect(page).toHaveURL(/\/admin\/submissions$/);
  // Back 回到 stores/new（新挂载干净编辑器，无拦截）
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/stores\/new$/);
  await expect(page.getByLabel("门店名称")).toHaveValue("");
});

test("向导从任务详情进入时 URL 携带指派步且返回任务详情", async ({ page }) => {
  await login(page);
  await page.goto("/admin/campaigns/campaign-one");
  await page.getByRole("button", { name: "添加探店员" }).click();
  await expect(page).toHaveURL(/\/admin\/campaigns\/campaign-one\/edit\?step=2$/);
  await expect(page.getByRole("button", { name: "返回任务详情" })).toBeVisible();
  await page.getByRole("button", { name: "返回任务详情" }).click();
  await expect(page).toHaveURL(/\/admin\/campaigns\/campaign-one$/);
  await expect(page.getByText("探店员指派表")).toBeVisible();
});

test("列表编辑进入的向导以 from=list 返回任务列表", async ({ page }) => {
  await login(page);
  await page.goto("/admin/campaigns");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/campaigns\/campaign-one\/edit\?from=list$/);
  await expect(page.getByRole("button", { name: "返回任务列表" })).toBeVisible();
  await page.getByRole("button", { name: "返回任务列表" }).click();
  await expect(page).toHaveURL(/\/admin\/campaigns$/);
  await expect(page.getByRole("heading", { name: "探店任务与指派" })).toBeVisible();
});

test("列表新建任务进入 /admin/campaigns/new 且取消回列表", async ({ page }) => {
  await login(page);
  await page.goto("/admin/campaigns");
  await page.getByRole("button", { name: "新建探店任务" }).click();
  await expect(page).toHaveURL(/\/admin\/campaigns\/new$/);
  await expect(page.getByRole("heading", { name: "新建探店任务" })).toBeVisible();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page).toHaveURL(/\/admin\/campaigns$/);
});

test("向导首次保存 replace 为已保存草稿地址，刷新不重复 POST", async ({ page }) => {
  await login(page);
  let createPosts = 0;
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/admin/campaigns") createPosts += 1; });
  await page.goto("/admin/campaigns/new");
  await page.getByLabel("任务名称").fill("刷新回归任务");
  await wizardFillStore(page);
  await page.getByLabel("探店开始日期").fill("2026-07-20");
  await page.getByLabel("探店结束日期").fill("2026-07-20");
  await page.getByLabel("探店开始时间").fill("10:00");
  await page.getByLabel("探店结束时间").fill("14:00");
  await page.getByLabel("问卷最终截止").fill("2026-07-20T20:00");
  await page.getByRole("button", { name: "下一步：指派探店员" }).click();
  await expect(page.getByText("任务草稿已创建，请继续指派探店员")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/campaigns\/campaign-two\/edit\?step=2&from=list$/); // URL 已是持久化草稿
  expect(createPosts).toBe(1);
  await page.reload(); // 刷新：走详情加载回填持久化数据，无第二次 POST
  await expect(page.getByRole("heading", { name: "编辑探店任务" })).toBeVisible();
  await page.getByRole("button", { name: "上一步" }).click(); // 回第 1 步校验持久化回填
  await expect(page.getByLabel("任务名称")).toHaveValue("新建探店任务"); // fixture 持久化的草稿名
  expect(createPosts).toBe(1);
});

test("向导指派步保存后 URL 进入 ?step=3，刷新回显持久化指派", async ({ page }) => {
  await login(page);
  await page.goto("/admin/campaigns/campaign-two/edit?step=2&from=list");
  await expect(page.getByRole("heading", { name: "编辑探店任务" })).toBeVisible();
  await page.getByRole("button", { name: "添加探店员" }).click();
  const row = page.locator(".wizard-row").last();
  await row.getByLabel("探店员").selectOption("user-inspector-two");
  await row.getByLabel("已发布问卷版本").selectOption("version-one");
  await page.getByRole("button", { name: "下一步：确认并发布" }).click();
  await expect(page.getByRole("heading", { name: /指派明细/ })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/campaigns\/campaign-two\/edit\?step=3&from=list$/);
  await page.reload(); // 刷新：详情重查回显已落库指派
  await expect(page.getByRole("heading", { name: /指派明细/ })).toBeVisible();
  await expect(page.locator(".wizard-summary table tbody tr").first()).toContainText("林晓峰");
});

test("向导步间返回/前进由 URL 驱动且未保存输入保留", async ({ page }) => {
  await login(page);
  await page.goto("/admin/campaigns/campaign-one/edit?from=list");
  await expect(page.getByRole("heading", { name: "编辑探店任务" })).toBeVisible();
  await page.getByLabel("共用说明").fill("步间导航保留这段说明");
  await page.getByRole("button", { name: "下一步：指派探店员" }).click();
  await expect(page).toHaveURL(/\?step=2&from=list$/);
  // 上一步 = push 新条目（?step=1）；未保存的表单输入保留（组件未卸载）
  await page.getByRole("button", { name: "上一步" }).click();
  await expect(page).toHaveURL(/\/admin\/campaigns\/campaign-one\/edit\?from=list$/);
  await expect(page.getByLabel("共用说明")).toHaveValue("步间导航保留这段说明");
  // 浏览器返回 → 回到 ?step=2 条目，输入仍在
  await page.goBack();
  await expect(page).toHaveURL(/\?step=2&from=list$/);
  await expect(page.locator(".wizard-row").first()).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/admin\/campaigns\/campaign-one\/edit\?from=list$/);
  await expect(page.getByLabel("共用说明")).toHaveValue("步间导航保留这段说明");
});

test("指派编辑器由任务/指派双 ID 定位并返回详情", async ({ page }) => {
  await login(page);
  await page.goto("/admin/campaigns/campaign-one");
  await page.getByRole("row", { name: /周雨晴/ }).getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "编辑要求" }).click();
  await expect(page).toHaveURL(/\/admin\/campaigns\/campaign-one\/assignments\/assignment-one\/edit$/);
  await expect(page.getByRole("heading", { name: "编辑指派" })).toBeVisible();
  await page.getByRole("button", { name: "返回指派列表" }).click();
  await expect(page).toHaveURL(/\/admin\/campaigns\/campaign-one$/);
  await expect(page.getByText("探店员指派表")).toBeVisible();
});

test("脏态新建门店：浏览器返回先确认，取消保留数据、确认才离开", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  await page.getByRole("button", { name: "新建门店" }).click();
  await expect(page).toHaveURL(/\/admin\/stores\/new$/);
  await page.getByLabel("门店名称").fill("回归测试门店");
  await page.goBack(); // 站内 pushState 历史 → popstate 触发守卫
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toBeVisible(); // 拦截而非直接离开
  await expect(page).toHaveURL(/\/admin\/stores\/new$/);
  await page.getByRole("button", { name: "留在本页" }).click();
  await expect(page.getByLabel("门店名称")).toHaveValue("回归测试门店"); // 取消：数据保留
  await page.goBack();
  await page.getByRole("button", { name: "放弃并离开" }).click();
  await expect(page).toHaveURL(/\/admin\/stores$/);
  await expect(page.getByRole("heading", { name: "门店与打卡范围" })).toBeVisible();
});

test("脏态编辑器点击菜单导航同样先确认，确认后正确跳转", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  await page.getByRole("button", { name: "新建门店" }).click();
  await page.getByLabel("门店名称").fill("菜单拦截门店");
  await page.getByRole("button", { name: "提交记录" }).click();
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toBeVisible();
  await page.getByRole("button", { name: "留在本页" }).click();
  await expect(page).toHaveURL(/\/admin\/stores\/new$/);
  await page.getByRole("button", { name: "提交记录" }).click();
  await page.getByRole("button", { name: "放弃并离开" }).click();
  await expect(page).toHaveURL(/\/admin\/submissions$/);
});

test("脏态弹窗：底层编辑器与弹窗叠加守卫，取消弹窗后编辑器仍受保护", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  await page.getByRole("button", { name: "新建门店" }).click();
  await page.getByLabel("门店名称").fill("弹窗叠加门店");
  await page.getByRole("button", { name: "新建品牌" }).click();
  await page.getByLabel("品牌名称").fill("回归品牌");
  // 浏览器返回：弹窗脏态先拦（最上层提示）
  await page.goBack();
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toBeVisible();
  await page.getByRole("button", { name: "留在本页" }).click();
  await expect(page).toHaveURL(/\/admin\/stores\/new$/);
  await expect(page.getByLabel("品牌名称")).toHaveValue("回归品牌");
  // 弹窗自身取消：脏态先确认放弃内容
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByText("放弃填写的内容？")).toBeVisible();
  await page.getByRole("button", { name: "继续填写" }).click();
  await expect(page.getByLabel("品牌名称")).toHaveValue("回归品牌");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "放弃内容" }).click();
  await expect(page.getByLabel("品牌名称")).toHaveCount(0); // 弹窗关闭
  // 底层编辑器仍然受保护（叠加守卫未被弹窗注销）
  await page.goBack();
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toBeVisible();
  await page.getByRole("button", { name: "放弃并离开" }).click();
  await expect(page).toHaveURL(/\/admin\/stores$/);
});

test("干净页面上的脏弹窗：返回确认后导航且弹窗不残留", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  await page.getByRole("button", { name: "新建门店" }).click(); // 编辑器保持干净
  await page.getByRole("button", { name: "新建品牌" }).click();
  await page.getByLabel("品牌名称").fill("孤儿弹窗品牌");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toBeVisible();
  await page.getByRole("button", { name: "放弃并离开" }).click();
  await expect(page).toHaveURL(/\/admin\/stores$/);
  // 确认离开时弹窗被一并丢弃：列表页不出现带过期回调的旧弹窗
  await expect(page.getByLabel("品牌名称")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "门店与打卡范围" })).toBeVisible();
});

test("干净弹窗直接关闭，不误报底层脏态", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
  await expect(page.getByRole("heading", { name: "编辑门店和范围" })).toBeVisible();
  await page.getByRole("button", { name: "新建品牌" }).click(); // 未输入任何内容 → 干净弹窗
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByLabel("品牌名称")).toHaveCount(0); // 直接关闭，无「放弃填写内容」确认
  await expect(page.getByText("放弃填写的内容？")).toHaveCount(0);
});

test("表单弹窗保存失败保持弹窗、内容与保护", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  await page.getByRole("button", { name: "新建品牌" }).click();
  await page.getByLabel("品牌名称").fill("失败品牌");
  await page.route("**/api/admin/brands", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SERVICE_DOWN", message: "服务暂时不可用，请稍后重试", requestId: "fixture-request" } }) }));
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("服务暂时不可用，请稍后重试").first()).toBeVisible(); // 就地错误
  await page.unroute("**/api/admin/brands");
  await expect(page.getByLabel("品牌名称")).toHaveValue("失败品牌"); // 弹窗保持、内容不丢
  await page.goBack(); // 失败后保护仍在
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toBeVisible();
  await page.getByRole("button", { name: "留在本页" }).click();
  await expect(page.getByLabel("品牌名称")).toHaveValue("失败品牌");
});

test("延期弹窗失败保持可编辑且参与离开保护", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "探店任务" }).click();
  await page.getByRole("button", { name: "查看指派" }).click(); // 站内导航，Back 为同文档 popstate
  await page.getByRole("row", { name: /压测探员 101 号/ }).getByRole("button", { name: "延期", exact: true }).click();
  await expect(page.getByText("延期这条指派？")).toBeVisible();
  await page.getByLabel("延期原因").fill("雨天顺延");
  await page.getByRole("button", { name: "确认延期" }).click();
  await expect(page.getByText("请至少填写一项延期时间")).toBeVisible(); // 失败就地展示
  await expect(page.getByLabel("延期原因")).toHaveValue("雨天顺延"); // 内容保留
  await page.goBack(); // 脏弹窗参与离开保护
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toBeVisible();
  await page.getByRole("button", { name: "留在本页" }).click();
  await expect(page.getByLabel("延期原因")).toHaveValue("雨天顺延");
  await page.getByRole("button", { name: "取消" }).click();
  await page.getByRole("button", { name: "放弃内容" }).click();
  await expect(page.getByText("延期这条指派？")).toHaveCount(0);
});

test("保存成功解除脏态：创建并发布后回列表不再拦截", async ({ page }) => {
  await login(page);
  await page.goto("/admin/questionnaires/new");
  await page.getByLabel("问卷名称").fill("路由回归问卷");
  await page.getByPlaceholder("第 1 题内容").fill("门头招牌是否完好整洁");
  await page.locator(".editor-footer").getByRole("button", { name: "创建并发布" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("问卷已发布")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/questionnaires$/); // onSuccess 导航不被脏态拦截
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toHaveCount(0);
});

test("加载完成后的干净编辑器不误报脏态", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
  await expect(page).toHaveURL(/\/admin\/stores\/store-one\/edit$/);
  await expect(page.getByRole("heading", { name: "编辑门店和范围" })).toBeVisible();
  await page.goBack(); // 异步水合（区域/品牌加载）不算编辑：直接返回，无确认弹窗
  await expect(page).toHaveURL(/\/admin\/stores$/);
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toHaveCount(0);
});

test("字段改回原值后不再视为脏", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
  await expect(page.getByRole("heading", { name: "编辑门店和范围" })).toBeVisible();
  await page.getByLabel("门店名称").fill("临时改名");
  await page.getByLabel("门店名称").fill("静安嘉里中心店"); // 改回原值
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/stores$/); // 无拦截
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toHaveCount(0);
});

test("保存失败保留脏态拦截", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
  await expect(page.getByRole("heading", { name: "编辑门店和范围" })).toBeVisible();
  await page.getByLabel("门店名称").fill("改过的门店名");
  await page.route("**/api/admin/stores/store-one", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SERVICE_DOWN", message: "服务暂时不可用，请稍后重试", requestId: "fixture-request" } }) }));
  await page.getByRole("button", { name: "保存门店" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("服务暂时不可用，请稍后重试").first()).toBeVisible();
  await page.unroute("**/api/admin/stores/store-one");
  // 失败后仍处于编辑器且脏态保留：返回被拦截
  await page.goBack();
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toBeVisible();
  await page.getByRole("button", { name: "留在本页" }).click();
  await expect(page.getByLabel("门店名称")).toHaveValue("改过的门店名");
});

test("脏态刷新被 beforeunload 拦截在当前页", async ({ page }) => {
  await login(page);
  await page.goto("/admin/users/user-inspector-one/edit");
  await expect(page.getByRole("heading", { name: "编辑账号" })).toBeVisible();
  await page.getByLabel("姓名").fill("改过的姓名");
  // Playwright 对 beforeunload 对话框默认拒绝（取消导航）→ 刷新停留在原页面
  await page.reload();
  await expect(page).toHaveURL(/\/admin\/users\/user-inspector-one\/edit$/);
  await expect(page.getByRole("heading", { name: "编辑账号" })).toBeVisible();
});

test("脏态下退出登录先确认，确认后才回到登录页", async ({ page }) => {
  await login(page);
  await page.goto("/admin/users/user-inspector-one/edit");
  await expect(page.getByRole("heading", { name: "编辑账号" })).toBeVisible();
  await page.getByLabel("姓名").fill("未保存的姓名");
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toBeVisible();
  await page.getByRole("button", { name: "留在本页" }).click();
  await expect(page.getByLabel("姓名")).toHaveValue("未保存的姓名"); // 取消：仍在编辑器
  await page.getByRole("button", { name: "退出登录" }).click();
  await page.getByRole("button", { name: "放弃并离开" }).click();
  await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
});

test("题目编辑脏态时切换题目先确认：取消保留内容，确认丢弃并切换", async ({ page }) => {
  await login(page);
  await page.goto("/admin/questionnaires/version-draft?question=draft-question-2");
  await expect(page.getByRole("heading", { name: "题目设置" })).toBeVisible();
  const editor = page.locator(".question-editor-panel");
  await editor.getByLabel("题目内容").fill("改过的题目内容");
  // 切换题目是一次导航：脏态先确认
  await page.locator(".question-pick-item").first().getByRole("button", { name: /门店门头是否整洁/ }).click();
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toBeVisible();
  await page.getByRole("button", { name: "留在本页" }).click();
  await expect(editor.getByLabel("题目内容")).toHaveValue("改过的题目内容"); // 取消：内容保留、题目未切换
  await expect(page).toHaveURL(/question=draft-question-2/);
  await page.locator(".question-pick-item").first().getByRole("button", { name: /门店门头是否整洁/ }).click();
  await page.getByRole("button", { name: "放弃并离开" }).click();
  await expect(page).toHaveURL(/question=draft-question-1/);
  await expect(page.locator(".question-pick-item.is-active")).toContainText("门店门头是否整洁");
  await expect(page.locator(".question-editor-panel").getByLabel("题目内容")).toHaveValue("门店门头是否整洁");
});

test("确认丢弃的题目草稿不会在重选时复活", async ({ page }) => {
  await login(page);
  await page.goto("/admin/questionnaires/version-draft?question=draft-question-2");
  const editor = page.locator(".question-editor-panel");
  await editor.getByRole("checkbox", { name: /分数清零题/ }).check(); // 本地草稿
  await page.locator(".question-pick-item").first().getByRole("button", { name: /门店门头是否整洁/ }).click();
  await page.getByRole("button", { name: "放弃并离开" }).click(); // 确认丢弃
  await expect(page).toHaveURL(/question=draft-question-1/);
  await page.locator(".question-pick-item").nth(1).getByRole("button", { name: /地面是否干净无杂物/ }).click();
  await expect(page).toHaveURL(/question=draft-question-2/);
  // 重选同一题：显示服务端已保存值（清零标记未勾选），且不误报脏态
  await expect(editor.getByRole("checkbox", { name: /分数清零题/ })).not.toBeChecked();
  await page.getByRole("button", { name: "返回版本列表" }).click();
  await expect(page).toHaveURL(/\/admin\/questionnaires$/);
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toHaveCount(0);
});

test("同一题目编辑器连续两次保存各用最新乐观锁", async ({ page }) => {
  await login(page);
  await page.goto("/admin/questionnaires/version-draft?question=draft-question-2");
  const editor = page.locator(".question-editor-panel");
  await editor.getByLabel("题目内容").fill("第一次保存的内容");
  await editor.getByRole("button", { name: "保存题目设置" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("题目配置已保存")).toBeVisible();
  await editor.getByLabel("题目内容").fill("第二次保存的内容"); // 不换题、不刷新，直接二次保存
  await editor.getByRole("button", { name: "保存题目设置" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("题目配置已保存")).toBeVisible(); // 第二次保存成功（revision 冲突会在此报错）
  await expect(editor.getByLabel("题目内容")).toHaveValue("第二次保存的内容");
  await page.reload(); // 权威值持久化
  await expect(page.locator(".question-editor-panel").getByLabel("题目内容")).toHaveValue("第二次保存的内容");
});

test("题目保存成功解除脏态：返回版本列表不再拦截", async ({ page }) => {
  await login(page);
  await page.goto("/admin/questionnaires/version-draft?question=draft-question-2");
  await expect(page.getByRole("heading", { name: "题目设置" })).toBeVisible();
  const editor = page.locator(".question-editor-panel");
  await editor.getByLabel("题目内容").fill("地面是否干净无杂物（更新）");
  await editor.getByRole("button", { name: "保存题目设置" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("题目配置已保存")).toBeVisible();
  await page.getByRole("button", { name: "返回版本列表" }).click();
  await expect(page).toHaveURL(/\/admin\/questionnaires$/);
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toHaveCount(0); // 保存成功：脏态解除
});

test("草稿发布后界面立即只读且刷新保持已发布", async ({ page }) => {
  await login(page);
  // 用例自建草稿（不污染其他用例依赖的 version-draft/version-check-fail）
  await page.goto("/admin/questionnaires/new");
  await page.getByLabel("问卷名称").fill("发布只读回归问卷");
  await page.getByPlaceholder("第 1 题内容").fill("门头是否完好");
  await page.getByPlaceholder("第 2 题内容").fill("地面是否干净");
  await page.locator(".editor-footer").getByRole("button", { name: "保存草稿" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("问卷草稿已创建")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/questionnaires$/);
  const row = page.getByRole("row", { name: /发布只读回归问卷/ });
  await row.getByRole("button", { name: "查看题目" }).click();
  await expect(page.getByText("启用 2 / 共 2 题")).toBeVisible();
  await page.getByRole("button", { name: "发布版本" }).first().click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("问卷版本已发布")).toBeVisible();
  // 发布成功后立即只读：编辑控件消失
  await expect(page.getByRole("button", { name: "保存题目设置" })).toHaveCount(0);
  await expect(page.getByText("已发布版本不可修改。如需调整，请先复制为新草稿。")).toBeVisible();
  await page.reload(); // 刷新后保持已发布（权威状态）
  await expect(page.getByText("已发布版本不可修改。如需调整，请先复制为新草稿。")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存题目设置" })).toHaveCount(0);
});

test("反复取消的返回不破坏历史：取消两次后仍可正常确认返回", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  await page.getByRole("button", { name: "新建门店" }).click();
  await expect(page).toHaveURL(/\/admin\/stores\/new$/);
  await page.getByLabel("门店名称").fill("往返门店");
  for (let round = 0; round < 2; round += 1) {
    await page.goBack();
    await expect(page.getByRole("heading", { name: "有未保存的修改" })).toBeVisible();
    await page.getByRole("button", { name: "留在本页" }).click();
    await expect(page.getByLabel("门店名称")).toHaveValue("往返门店");
  }
  await page.goBack();
  await page.getByRole("button", { name: "放弃并离开" }).click();
  await expect(page).toHaveURL(/\/admin\/stores$/);
  await expect(page.getByRole("heading", { name: "门店与打卡范围" })).toBeVisible();
});

test("门店品牌筛选在编辑往返（站内/浏览器返回/新建）后保持", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  await page.getByLabel("门店品牌筛选").selectOption("1a6fd7a0-1111-4111-8111-000000000001");
  await expect(page).toHaveURL(/\/admin\/stores\?brandId=1a6fd7a0-1111-4111-8111-000000000001$/);
  await expect(page.getByRole("row", { name: /静安嘉里中心店/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /浦东世纪公园店/ })).toHaveCount(0);
  await expect(page.getByText("压测门店 227 号店")).toHaveCount(0);
  // 站内返回：筛选与行集保持
  await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
  await expect(page).toHaveURL(/\/admin\/stores\/store-one\/edit\?list=/);
  await page.getByRole("button", { name: "返回门店列表" }).click();
  await expect(page).toHaveURL(/\/admin\/stores\?brandId=1a6fd7a0-1111-4111-8111-000000000001$/);
  await expect(page.getByRole("row", { name: /静安嘉里中心店/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /浦东世纪公园店/ })).toHaveCount(0);
  // 浏览器返回同样保持
  await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/stores\?brandId=1a6fd7a0-1111-4111-8111-000000000001$/);
  await expect(page.getByRole("row", { name: /静安嘉里中心店/ })).toBeVisible();
  // 新建门店入口携带父上下文，返回后筛选仍保持
  await page.getByRole("button", { name: "新建门店" }).click();
  await page.getByRole("button", { name: "返回门店列表" }).click();
  await expect(page).toHaveURL(/\/admin\/stores\?brandId=1a6fd7a0-1111-4111-8111-000000000001$/);
});

test("门店列表筛选 URL 刷新可恢复", async ({ page }) => {
  await login(page);
  await page.goto("/admin/stores?brandId=1a6fd7a0-1111-4111-8111-000000000001");
  await expect(page.getByRole("row", { name: /静安嘉里中心店/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /浦东世纪公园店/ })).toHaveCount(0);
});

test("提交筛选在详情往返（站内/浏览器返回）后保持", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "提交记录" }).click();
  await page.getByLabel("门店筛选").selectOption("静安嘉里中心店");
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect(page).toHaveURL(/\/admin\/submissions\?storeName=/);
  await expect(page.getByText("共 1 条")).toBeVisible();
  await page.getByRole("button", { name: "查看详情" }).click();
  await expect(page).toHaveURL(/\/admin\/submissions\/submission-one\?list=/);
  await page.getByRole("button", { name: "返回提交列表" }).click();
  await expect(page).toHaveURL(/\/admin\/submissions\?storeName=/);
  await expect(page.getByLabel("门店筛选")).toHaveValue("静安嘉里中心店");
  await expect(page.getByText("共 1 条")).toBeVisible();
  await page.getByRole("button", { name: "查看详情" }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/submissions\?storeName=/);
  await expect(page.getByLabel("门店筛选")).toHaveValue("静安嘉里中心店");
  await expect(page.getByText("共 1 条")).toBeVisible();
});

test("详情深链接直接打开时返回未过滤列表", async ({ page }) => {
  await login(page);
  await page.goto("/admin/submissions/submission-one");
  await expect(page.getByRole("heading", { name: "夏季门店服务品质暗访" })).toBeVisible();
  await page.getByRole("button", { name: "返回提交列表" }).click();
  await expect(page).toHaveURL(/\/admin\/submissions$/);
});

test("题目保存后本地草稿与服务端规范化一致，无残留脏态", async ({ page }) => {
  await login(page);
  await page.goto("/admin/questionnaires/version-draft?question=draft-question-3");
  const editor = page.locator(".question-editor-panel");
  await editor.getByLabel("题目内容").fill("  本地保存空格验收  ");
  await editor.getByRole("button", { name: "保存题目设置" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("题目配置已保存")).toBeVisible();
  await expect(editor.getByLabel("题目内容")).toHaveValue("本地保存空格验收"); // 权威规范化回显
  await page.getByRole("button", { name: "返回版本列表" }).click();
  await expect(page).toHaveURL(/\/admin\/questionnaires$/);
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toHaveCount(0); // 基线与草稿一致，无误报
});

test("题目草稿未保存时发布入口禁用且零发布请求，保存后恢复", async ({ page }) => {
  await login(page);
  let publishPosts = 0;
  page.on("request", (request) => { if (request.url().includes("/publish")) publishPosts += 1; });
  await page.goto("/admin/questionnaires/version-draft?question=draft-question-1");
  const editor = page.locator(".question-editor-panel");
  await editor.getByLabel("题目内容").fill("未保存的草稿内容");
  const publishButtons = page.getByRole("button", { name: "发布版本" });
  await expect(publishButtons).toHaveCount(2);
  await expect(publishButtons.first()).toBeDisabled();
  await expect(publishButtons.last()).toBeDisabled();
  await expect(page.getByText("当前题目有未保存的修改，保存或放弃后才能发布")).toBeVisible();
  expect(publishPosts).toBe(0); // 禁用即零请求
  await editor.getByRole("button", { name: "保存题目设置" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("题目配置已保存")).toBeVisible();
  await expect(publishButtons.first()).toBeEnabled();
  // 还原服务端文本（其他用例依赖该题目内容）
  await editor.getByLabel("题目内容").fill("门店门头是否整洁");
  await editor.getByRole("button", { name: "保存题目设置" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("题目配置已保存")).toBeVisible();
});

test("同地址导航为 no-op：选中题目重复点击不弹确认不堆历史", async ({ page }) => {
  await login(page);
  await page.goto("/admin/questionnaires/version-draft?question=draft-question-2");
  const editor = page.locator(".question-editor-panel");
  await editor.getByLabel("题目内容").fill("草稿内容");
  const historyBefore = await page.evaluate(() => history.length);
  await page.locator(".question-pick-item.is-active .question-pick-main").click();
  await expect(page.getByRole("heading", { name: "有未保存的修改" })).toHaveCount(0);
  await expect(page).toHaveURL(/question=draft-question-2/);
  await expect(editor.getByLabel("题目内容")).toHaveValue("草稿内容");
  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
});

test("当前激活菜单重复点击不新增历史", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "门店管理" }).click();
  await expect(page).toHaveURL(/\/admin\/stores$/);
  const historyBefore = await page.evaluate(() => history.length);
  await page.locator(".admin-sidebar").getByRole("button", { name: "门店管理" }).click();
  await page.locator(".admin-sidebar").getByRole("button", { name: "门店管理" }).click();
  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
});

test("叠加弹窗可访问名称互不串扰，取消保留底层保存确认与草稿", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "问卷题库" }).click();
  await page.getByRole("row", { name: /秋季草稿版/ }).getByRole("button", { name: "查看题目" }).click();
  await page.locator(".question-pick-item").nth(1).getByRole("button", { name: /地面是否干净无杂物/ }).click();
  const editor = page.locator(".question-editor-panel");
  await editor.getByLabel("题目内容").fill("叠加弹窗草稿");
  await editor.getByRole("button", { name: "保存题目设置" }).click();
  const saveDialog = page.getByRole("dialog", { name: "保存题目设置？" });
  await expect(saveDialog).toBeVisible();
  await page.goBack(); // 触发离开警告（顶层）
  const leaveDialog = page.getByRole("dialog", { name: "有未保存的修改" });
  await expect(leaveDialog).toBeVisible();
  await expect(page.getByRole("dialog", { name: "保存题目设置？" })).toBeVisible(); // 底层仍在、名称可区分
  await leaveDialog.getByRole("button", { name: "留在本页" }).click(); // 顶层可点按
  await expect(saveDialog).toBeVisible(); // 底层保存确认保留
  await expect(editor.getByLabel("题目内容")).toHaveValue("叠加弹窗草稿"); // 草稿保留
  await saveDialog.getByRole("button", { name: "取消" }).click();
  await expect(saveDialog).toHaveCount(0);
});

test("创建后直达另一任务编辑再返回：各按 URL 拉取正确实体", async ({ page }) => {
  await login(page);
  await page.goto("/admin/campaigns/new");
  await page.getByLabel("任务名称").fill("身份回归任务");
  await wizardFillStore(page);
  await page.getByLabel("探店开始日期").fill("2026-07-20");
  await page.getByLabel("探店结束日期").fill("2026-07-20");
  await page.getByLabel("探店开始时间").fill("10:00");
  await page.getByLabel("探店结束时间").fill("14:00");
  await page.getByLabel("问卷最终截止").fill("2026-07-20T20:00");
  await page.getByRole("button", { name: "下一步：指派探店员" }).click();
  await expect(page).toHaveURL(/campaign-two\/edit\?step=2&from=list$/);
  await expect(page.getByRole("heading", { name: "编辑探店任务" })).toBeVisible();
  // 站内直达另一任务的编辑器（向导组件跨分支复用，必须按 URL 重新拉取对应实体）
  await page.getByRole("button", { name: "探店任务" }).click(); // 已保存向导为干净态，直接返回列表
  await page.getByRole("button", { name: "查看指派" }).click();
  await page.getByRole("button", { name: "添加探店员" }).click();
  await expect(page).toHaveURL(/campaign-one\/edit\?step=2$/);
  await expect(page.locator(".wizard-row").first()).toContainText("周雨晴"); // campaign-one 的指派
  // 多条目跳转（go ±2，跳过详情中介条目）后编辑器仍按 URL 实体渲染
  await page.evaluate(() => history.go(-2));
  await expect(page).toHaveURL(/\/admin\/campaigns$/);
  await expect(page.getByRole("heading", { name: "探店任务与指派" })).toBeVisible();
  await page.evaluate(() => history.go(2));
  await expect(page).toHaveURL(/campaign-one\/edit\?step=2$/);
  await expect(page.locator(".wizard-row").first()).toContainText("周雨晴");
  // 跨条目返回创建的任务：按 campaign-two 重新拉取，而非残留 campaign-one 数据
  await page.goBack();
  await expect(page).toHaveURL(/campaign-one$/); // 详情
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/campaigns$/); // 列表
  // 多条目跳转：history.go(-1)+1 已覆盖相邻条目；这里再验证从列表直接回到 two/edit 的条目
  await page.goForward();
  await expect(page).toHaveURL(/campaign-one$/);
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/campaign-two\/edit\?step=2&from=list$/);
  await expect(page.getByRole("heading", { name: "编辑探店任务" })).toBeVisible();
  await page.getByRole("button", { name: "上一步" }).click();
  await expect(page.getByLabel("任务名称")).toHaveValue("新建探店任务"); // campaign-two 持久化数据
  await expect(page.getByLabel("任务名称")).not.toHaveValue("夏季门店服务品质暗访");
});

test("跨条目回到 /new 恒为全新空白上下文", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "探店任务" }).click();
  await page.getByRole("button", { name: "新建探店任务" }).click();
  await page.getByLabel("任务名称").fill("会被丢弃的草稿");
  await page.getByRole("button", { name: "探店任务" }).click(); // /new 干净？—已输入，会弹确认
  await page.getByRole("button", { name: "放弃并离开" }).click();
  await expect(page).toHaveURL(/\/admin\/campaigns$/);
  await page.getByRole("button", { name: "新建探店任务" }).click();
  await expect(page).toHaveURL(/\/admin\/campaigns\/new$/);
  await expect(page.getByRole("heading", { name: "新建探店任务" })).toBeVisible();
  await expect(page.getByLabel("任务名称")).toHaveValue(""); // 全新上下文，不残留上一轮输入
});

test("放弃题目草稿回到无选中状态：编辑器消失且发布入口恢复可用", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "问卷题库" }).click();
  await page.getByRole("row", { name: /秋季草稿版/ }).getByRole("button", { name: "查看题目" }).click();
  await expect(page).toHaveURL(/\/admin\/questionnaires\/version-draft$/);
  await page.locator(".question-pick-item").first().getByRole("button", { name: /门店门头是否整洁/ }).click();
  await expect(page).toHaveURL(/question=draft-question-1/);
  const editor = page.locator(".question-editor-panel");
  await editor.getByLabel("题目内容").fill("将被放弃的草稿");
  const publishButtons = page.getByRole("button", { name: "发布版本" });
  await expect(publishButtons.first()).toBeDisabled(); // 草稿未保存：发布禁用
  await page.goBack(); // 浏览器返回 → 确认放弃
  await page.getByRole("button", { name: "放弃并离开" }).click();
  await expect(page).toHaveURL(/\/admin\/questionnaires\/version-draft$/);
  await expect(page).not.toHaveURL(/question=/); // 回到无选中状态
  await expect(page.locator(".question-editor-panel")).toHaveCount(0); // 无编辑器残留
  await expect(page.getByText("当前题目有未保存的修改，保存或放弃后才能发布")).toHaveCount(0); // 警告消除
  await expect(publishButtons.first()).toBeEnabled(); // 发布入口恢复（该题草稿已确认丢弃）
  await expect(publishButtons.last()).toBeEnabled();
  await expect(page.getByText("检查 4/4 通过")).toBeVisible(); // 发布检查提示恢复展示
});

test("取消返回保留编辑器、草稿与发布禁用态", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "问卷题库" }).click();
  await page.getByRole("row", { name: /秋季草稿版/ }).getByRole("button", { name: "查看题目" }).click();
  await page.locator(".question-pick-item").first().getByRole("button", { name: /门店门头是否整洁/ }).click();
  const editor = page.locator(".question-editor-panel");
  await editor.getByLabel("题目内容").fill("取消分支保留草稿");
  await page.goBack();
  await page.getByRole("button", { name: "留在本页" }).click();
  await expect(page).toHaveURL(/question=draft-question-1/);
  await expect(page.locator(".question-editor-panel")).toHaveCount(1); // 编辑器仍在
  await expect(editor.getByLabel("题目内容")).toHaveValue("取消分支保留草稿");
  await expect(page.getByRole("button", { name: "发布版本" }).first()).toBeDisabled(); // 脏态仍在
  await expect(page.getByText("当前题目有未保存的修改，保存或放弃后才能发布")).toBeVisible();
});

test("切换到未编辑题目后旧题脏态正确清除", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "问卷题库" }).click();
  await page.getByRole("row", { name: /秋季草稿版/ }).getByRole("button", { name: "查看题目" }).click();
  await page.locator(".question-pick-item").first().getByRole("button", { name: /门店门头是否整洁/ }).click();
  const editor = page.locator(".question-editor-panel");
  await editor.getByLabel("题目内容").fill("第一题的脏草稿");
  // 切到第 2 题（放弃确认后）：第 2 题是干净编辑器，旧题脏态不得残留。
  // 用位置选取并对照题库列表文本断言（不依赖具体文本，规避其他用例对题面的合法修改）。
  const secondItem = page.locator(".question-pick-item").nth(1);
  const secondText = await secondItem.locator(".question-pick-main p").textContent();
  await secondItem.locator(".question-pick-main").click();
  await page.getByRole("button", { name: "放弃并离开" }).click();
  await expect(page).toHaveURL(/question=draft-question-2/);
  await expect(page.locator(".question-editor-panel")).toHaveCount(1);
  expect(await editor.getByLabel("题目内容").inputValue()).toBe(secondText); // 服务端值
  await expect(page.getByText("当前题目有未保存的修改，保存或放弃后才能发布")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发布版本" }).first()).toBeEnabled();
});

test("在途的旧版本后台刷新不会覆盖新版本数据", async ({ page }) => {
  await login(page);
  await page.goto("/admin/questionnaires/version-draft?question=draft-question-1");
  await expect(page.getByText("启用 3 / 共 3 题")).toBeVisible();
  await page.route("**/api/admin/questionnaire-versions/version-draft/questions", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  // 触发一次结构性变更 → 后台刷新在途
  await page.locator(".question-pick-item").first().getByRole("button", { name: "停用", exact: true }).click();
  await page.getByRole("button", { name: "确认" }).click();
  // 刷新落地前切到另一版本
  await page.getByRole("button", { name: "返回版本列表" }).click();
  await expect(page).toHaveURL(/\/admin\/questionnaires$/);
  await page.getByRole("row", { name: /发布检查未过草稿/ }).getByRole("button", { name: "查看题目" }).click();
  await expect(page).toHaveURL(/version-check-fail/);
  await expect(page.getByRole("heading", { name: "发布检查未过草稿 · V3" })).toBeVisible();
  await page.waitForTimeout(1600); // 迟到的 version-draft 刷新若未取消会在此覆盖当前页
  await expect(page.getByRole("heading", { name: "发布检查未过草稿 · V3" })).toBeVisible();
  await expect(page.getByText("启用 2 / 共 2 题")).toBeVisible();
  await page.unroute("**/api/admin/questionnaire-versions/version-draft/questions");
});

async function wizardFillStore(page) {
  await page.getByLabel(new RegExp("^品牌")).selectOption("1a6fd7a0-1111-4111-8111-000000000001");
  await page.getByLabel(new RegExp("^店号")).selectOption("JD-SH-001");
  await page.getByLabel(new RegExp("^店名")).selectOption("store-one");
}
