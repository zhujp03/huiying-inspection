import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { attachBusinessConsoleCollector } from "../helpers/admin-e2e-console.mjs";

// 会话过期恢复 / 门店编辑器可恢复性 / 测试任务清理 的端到端回归。
// 固件：tests/fixtures/contract-server.mjs（/__test/control 注入故障计数器，/__test/reset 复位）。
const contractPort = Number(process.env.CONTRACT_PORT || 8787);
const fixtureControl = `http://127.0.0.1:${contractPort}/__test/control`;
const recoveryShotDir = "/private/tmp/junde-admin-recovery";

async function resetFixture(request) {
  await request.post(`http://127.0.0.1:${contractPort}/__test/reset`);
}

async function setFixtureScenario(request, scenario) {
  await request.post(fixtureControl, { data: scenario });
}

async function login(page, username = "ops") {
  await page.goto("/");
  await page.getByLabel("管理员账号").fill(username);
  await page.getByLabel("密码").fill("correct-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("暗访执行工作台")).toBeVisible();
}

function wizardStoreSelect(page, label) {
  return page.getByLabel(new RegExp(`^${label}`));
}

// 离线地图桩：TencentStoreMap 在 window.TMap 已存在时直接复用（不加载外网脚本），
// 供「搜索选点 → 坐标写入表单 → 保存」的新建门店全流程使用。
const TMAP_STUB = `
window.TMap = {
  LatLng: function (lat, lng) { this.lat = lat; this.lng = lng; },
  Map: function (container, options) { this.center = options.center; this.on = function () {}; this.getCenter = () => this.center; this.setCenter = (center) => { this.center = center; }; this.destroy = function () {}; },
  MultiMarker: function () { this.setGeometries = function () {}; },
  MultiCircle: function () { this.setGeometries = function () {}; },
  CircleStyle: function (style) { this.style = style; },
  service: {
    Suggestion: function () {
      this.getSuggestions = async ({ keyword }) => ({ data: [{ id: "poi-fixture-1", title: keyword + " 测试地点", address: "静安区测试路 1 号", province: "上海市", city: "上海市", district: "静安区", location: { lat: 31.2265, lng: 121.4452 } }] });
    },
  },
};
`;

test.describe("admin 会话过期与编辑器恢复", () => {
  test.beforeEach(async ({ request }) => {
    await resetFixture(request);
  });

  test("初始恢复遇到服务不可用：显示可重试的恢复页而不是登录表单，重试后正常进入", async ({ page, request }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowHttpFailures: 2 }); // 两次探测各产生一条 503 资源错误
    await setFixtureScenario(request, { meFailures: 2 }); // dev StrictMode 会对 /api/me 探测两次（首次被 abort 但服务端已计数）
    await page.goto("/");
    await expect(page.getByText("无法恢复登录状态")).toBeVisible();
    await expect(page.getByText("服务暂时不可用")).toBeVisible(); // 固件 503 的服务端消息原样展示
    await expect(page.getByLabel("管理员账号")).toBeHidden(); // 绝不误判为未登录
    await setFixtureScenario(request, { meFailures: 0 }); // 清除注入故障后重试：恢复探测明确 401 → 登录页
    await page.getByRole("button", { name: "重试" }).click();
    await expect(page.getByLabel("管理员账号")).toBeVisible();
    await login(page);
    await consoleCollector.expectClean();
  });

  test("新建门店：品牌下拉由路由加载；缺字段逐项报错并聚焦，输入不丢", async ({ page }) => {
    const consoleCollector = attachBusinessConsoleCollector(page);
    await page.addInitScript(TMAP_STUB);
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("button", { name: "新建门店" }).click();
    // 品牌（此前在新建/编辑路由永远为空）：来自权威品牌列表，仅启用中的品牌
    const brandSelect = wizardStoreSelect(page, "品牌");
    await expect(brandSelect.locator("option", { hasText: "建新园" })).toHaveCount(1);
    await expect(brandSelect.locator("option", { hasText: "停用示例品牌" })).toHaveCount(0);
    await page.getByRole("button", { name: "保存门店" }).click();
    // 逐字段错误 + 聚焦第一个错误字段；按钮不再被禁用遮蔽原因
    await expect(page.getByText("请填写门店编号")).toBeVisible();
    await expect(page.locator("#store-field-businessNo input")).toBeFocused();
    await page.getByLabel("门店编号").fill("JD-E2E-900");
    await page.getByLabel("门店名称").fill("恢复流程测试门店");
    await page.getByRole("button", { name: "保存门店" }).click();
    await expect(page.locator("#store-field-brandId").getByRole("alert")).toHaveText("请选择品牌");
    await expect(wizardStoreSelect(page, "品牌")).toBeFocused();
    await expect(page.getByLabel("门店编号")).toHaveValue("JD-E2E-900");
    await expect(page.getByLabel("门店名称")).toHaveValue("恢复流程测试门店");
    await consoleCollector.expectClean();
  });

  test("新建门店保存成功后快照推进：路由切换为编辑，继续修改再保存不重复创建、不 409", async ({ page, request }) => {
    const consoleCollector = attachBusinessConsoleCollector(page);
    await page.addInitScript(TMAP_STUB);
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("button", { name: "新建门店" }).click();
    await page.getByLabel("门店编号").fill("JD-E2E-901");
    await page.getByLabel("门店名称").fill("快照推进测试门店");
    await wizardStoreSelect(page, "品牌").selectOption({ label: "建新园" });
    await wizardStoreSelect(page, "省份").selectOption({ label: "上海市" });
    await wizardStoreSelect(page, "城市").selectOption({ label: "上海市市辖区" });
    await wizardStoreSelect(page, "区县").selectOption({ label: "静安区" });
    await page.getByLabel("打卡半径（米）").fill("350");
    await page.getByPlaceholder("搜索门店或商场").fill("快照测试");
    await page.getByRole("button", { name: "搜索" }).click();
    await page.locator(".map-search-results button").first().click();
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click();
    await expect(page.getByText("门店已创建")).toBeVisible();
    // 创建成功后 URL 切换为编辑路由，权威 id/revision 落地
    await expect(page).toHaveURL(/\/admin\/stores\/store-created-1\/edit/);
    await expect(page.getByLabel("门店名称")).toHaveValue("快照推进测试门店");
    // 继续修改并再次保存：PATCH 用最新 revision，成功且列表只有这一家
    await page.getByLabel("门店名称").fill("快照推进测试门店（改）");
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click();
    await expect(page.getByText("门店范围已保存")).toBeVisible();
    const list = await request.get(`http://127.0.0.1:${contractPort}/api/admin/stores?businessNo=JD-E2E-901`, { headers: { cookie: "adminRole=operations_admin" } });
    const listBody = await list.json();
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0].name).toBe("快照推进测试门店（改）");
    await consoleCollector.expectClean();
  });

  test("保存遇到服务失败：弹窗内错误可原位重试，输入全程保留", async ({ page }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowHttpFailures: 1 });
    await page.addInitScript(TMAP_STUB);
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
    await expect(page.getByLabel("门店名称")).toHaveValue("静安嘉里中心店");
    await page.getByLabel("门店名称").fill("静安嘉里中心店（服务失败编辑）");
    await page.getByLabel("打卡半径（米）").fill("420");
    await page.request.post(fixtureControl, { data: { storeSaveServiceFailures: 1 } });
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click();
    // 服务失败（写入前被拒/已回滚类）：弹窗保持并展示服务端原因，提供原位「重试」
    await expect(page.getByText("服务繁忙，请稍后重试")).toBeVisible();
    await page.getByRole("button", { name: "重试" }).click();
    await expect(page.getByText("门店范围已保存")).toBeVisible();
    await expect(page.getByLabel("门店名称")).toHaveValue("静安嘉里中心店（服务失败编辑）");
    await expect(page.getByLabel("打卡半径（米）")).toHaveValue("420");
    await consoleCollector.expectClean();
  });

  test("保存遇到乐观锁冲突：展示服务器最新内容供对照，可保留我的修改并以新版本保存", async ({ page }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowHttpFailures: 1 }); // 注入的 409 资源错误
    await page.addInitScript(TMAP_STUB);
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
    await page.getByLabel("门店名称").fill("我的冲突版本");
    await page.request.post(fixtureControl, { data: { storeSaveConflicts: 1 } });
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click();
    await expect(page.getByText("门店已被他人更新")).toBeVisible();
    await expect(page.locator(".conflict-server-fields")).toContainText("静安嘉里中心店");
    // 表单内容仍在（不被静默覆盖）
    await expect(page.getByLabel("门店名称")).toHaveValue("我的冲突版本");
    await page.getByRole("button", { name: "以我的修改为准保存" }).click();
    await expect(page.getByText("门店范围已保存")).toBeVisible();
    await expect(page.getByLabel("门店名称")).toHaveValue("我的冲突版本");
    // 保存成功后 revision 已推进：再次修改保存不再 409
    await page.getByLabel("打卡半径（米）").fill("380");
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click();
    await expect(page.getByText("门店范围已保存")).toBeVisible();
    await consoleCollector.expectClean();
  });

  test("保存时会话过期：登录遮罩覆盖现场，重登同一账号后草稿与弹窗保留并可重试", async ({ page }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowSession401: true });
    await page.addInitScript(TMAP_STUB);
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
    await page.getByLabel("门店名称").fill("过期恢复编辑门店");
    await page.request.post(fixtureControl, { data: { storeSaveUnauthorized: 1, expireOnMe: 1 } }); // 401 建模真实失效：身份核对探测同样被拒
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click();
    // 登录遮罩出现（过期文案），被遮罩的编辑器不可见、不可交互
    await expect(page.getByRole("heading", { name: "登录已过期，请重新登录" })).toBeVisible();
    await expect(page.getByText("重新登录后可继续当前页面未保存的编辑内容")).toBeVisible();
    await expect(page.getByLabel("门店名称")).toBeHidden();
    mkdirSync(recoveryShotDir, { recursive: true });
    await page.screenshot({ path: `${recoveryShotDir}/store-reauth-overlay.png`, fullPage: true });
    // 同一账号重登：现场恢复——编辑器与保存弹窗都在，输入未丢，可直接重试
    await page.getByLabel("管理员账号").fill("ops");
    await page.getByLabel("密码").fill("correct-password");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByLabel("门店名称")).toHaveValue("过期恢复编辑门店");
    await expect(page.getByText("登录已过期，请重新登录后再试")).toBeVisible();
    await page.getByRole("button", { name: "重试" }).click();
    await expect(page.getByText("门店范围已保存")).toBeVisible();
    await consoleCollector.expectClean();
  });

  test("过期后换账号登录：编辑器按用户重挂，不向前账号之外泄露未保存内容", async ({ page }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowSession401: true });
    await page.addInitScript(TMAP_STUB);
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
    await page.getByLabel("门店名称").fill("仅限前账号可见的草稿");
    await page.request.post(fixtureControl, { data: { storeSaveUnauthorized: 1, expireOnMe: 1 } }); // 401 建模真实失效
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click();
    await expect(page.getByRole("heading", { name: "登录已过期，请重新登录" })).toBeVisible();
    // 换账号登录：工作台整体重挂，编辑器重新拉取服务端内容
    await page.getByLabel("管理员账号").fill("store");
    await page.getByLabel("密码").fill("correct-password");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.locator(".admin-user").getByText("静安嘉里中心店")).toBeVisible(); // 换账号成功（门店负责人专属数据范围）
    await expect(page.getByLabel("门店名称")).toHaveValue("静安嘉里中心店");
    await expect(page.getByText("仅限前账号可见的草稿")).toHaveCount(0);
    await consoleCollector.expectClean();
  });

  test("变更请求被 CSRF 拒绝：客户端刷新令牌后精确重试一次并成功", async ({ page }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowHttpFailures: 1 });
    await page.addInitScript(TMAP_STUB);
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
    await page.getByLabel("门店名称").fill("CSRF 恢复门店");
    await page.request.post(fixtureControl, { data: { csrfRejects: 1 } });
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click();
    // CSRF 拒绝发生在写入之前：客户端刷新令牌重试一次，用户无感知
    await expect(page.getByText("门店范围已保存")).toBeVisible();
    await expect(page.getByLabel("门店名称")).toHaveValue("CSRF 恢复门店");
    await consoleCollector.expectClean();
  });

  test("新建门店撞上真实重复编号：保留全部输入，可修改编号后保存成功", async ({ page }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowHttpFailures: 1 }); // 注入的 409 资源错误
    await page.addInitScript(TMAP_STUB);
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("button", { name: "新建门店" }).click();
    await page.getByLabel("门店编号").fill("JD-SH-001"); // 已属于「静安嘉里中心店」（内容不同的他人门店）
    await page.getByLabel("门店名称").fill("完全不同的新门店");
    await wizardStoreSelect(page, "品牌").selectOption({ label: "建新园" });
    await page.getByPlaceholder("搜索门店或商场").fill("重复编号测试");
    await page.getByRole("button", { name: "搜索" }).click();
    await page.locator(".map-search-results button").first().click();
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click();
    // 内容不同 → 绝不自动采纳：弹窗说明撞车，保留全部输入
    await expect(page.getByText("门店编号已被其他门店使用")).toBeVisible();
    await expect(page.getByText(/已属于现有门店「静安嘉里中心店」/)).toBeVisible();
    await page.getByRole("button", { name: "返回修改" }).click();
    await expect(page.getByLabel("门店编号")).toHaveValue("JD-SH-001");
    await expect(page.getByLabel("门店名称")).toHaveValue("完全不同的新门店");
    // 修改编号后保存成功（未对他人门店做任何修改）
    await page.getByLabel("门店编号").fill("JD-E2E-902");
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click();
    await expect(page.getByText("门店已创建")).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/stores\/store-created-\d+\/edit/);
    await consoleCollector.expectClean();
  });

  test("新建门店响应不可用：按编号对账，内容一致才切换为编辑且不重复创建", async ({ page, request }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowHttpFailures: 1 }); // 注入的坏响应资源错误
    await page.addInitScript(TMAP_STUB);
    await login(page);
    let createPosts = 0;
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/admin/stores")) createPosts += 1; });
    await page.request.post(fixtureControl, { data: { storeCreateInvalidResponse: 1 } });
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("button", { name: "新建门店" }).click();
    await page.getByLabel("门店编号").fill("JD-E2E-903");
    await page.getByLabel("门店名称").fill("对账恢复测试门店");
    await wizardStoreSelect(page, "品牌").selectOption({ label: "建新园" });
    await page.getByPlaceholder("搜索门店或商场").fill("对账测试");
    await page.getByRole("button", { name: "搜索" }).click();
    await page.locator(".map-search-results button").first().click();
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click();
    // 服务端已落库但响应不可用：对账发现编号与内容一致的记录 → 自动切换为编辑，且只发过一次创建请求
    await expect(page.getByText("上一次保存已成功，已切换为编辑现有门店")).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/stores\/store-created-\d+\/edit/);
    expect(createPosts).toBe(1);
    const list = await request.get(`http://127.0.0.1:${contractPort}/api/admin/stores?businessNo=JD-E2E-903`, { headers: { cookie: "adminRole=operations_admin" } });
    expect((await list.json()).items).toHaveLength(1);
    await consoleCollector.expectClean();
  });

  test("清理预览遇到会话过期：重登后手动重试预览成功，且不自动清理", async ({ page, request }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowSession401: true });
    await setFixtureScenario(request, { showCleanupCampaign: 1, cleanupPreviewUnauthorized: 2, expireOnMe: 2 }); // 双发预览（首个被 abort 但服务端已计数）+ 身份核对探测同样被拒
    await login(page, "super");
    await page.getByRole("button", { name: "探店任务" }).click();
    await page.getByRole("row", { name: /已取消的测试任务/ }).getByRole("button", { name: "清理测试数据" }).click();
    // 预览 401：切登录遮罩，弹窗保持打开
    await expect(page.getByRole("heading", { name: "登录已过期，请重新登录" })).toBeVisible();
    await page.getByLabel("管理员账号").fill("super");
    await page.getByLabel("密码").fill("correct-password");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText("登录已失效，请重新登录后再试")).toBeVisible();
    await expect(page.getByRole("button", { name: "确认清理" })).toBeDisabled();
    // 手动重试：只重新拉取预览
    await page.getByRole("button", { name: "重试" }).click();
    await expect(page.locator(".cleanup-count-list")).toContainText("指派");
    await page.getByLabel(/以确认清理/).fill("已取消的测试任务");
    await expect(page.getByRole("button", { name: "确认清理" })).toBeEnabled();
    // 预览重试绝不自动清理：任务行仍在列表中
    await expect(page.getByRole("row", { name: /已取消的测试任务/ })).toBeVisible();
    await consoleCollector.expectClean();
  });

  test("门店编辑器区域加载失败：可重试且保留全部表单内容", async ({ page }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowHttpFailures: 1 }); // 注入的 503 资源错误
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await expect(page.getByRole("row", { name: /静安嘉里中心店/ })).toBeVisible(); // 列表页自身的区域请求先行完成
    await page.request.post(fixtureControl, { data: { regionsFailures: 2 } }); // dev StrictMode 双发（首个被 abort 但服务端已计数）
    await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
    await expect(page.getByText("区域列表加载失败：服务暂时不可用")).toBeVisible();
    await page.getByRole("button", { name: "重试" }).click();
    // 重试成功：区域级联恢复（含该门店已选区县），其他字段原样保留
    await expect(page.getByLabel("门店名称")).toHaveValue("静安嘉里中心店");
    await expect(page.getByLabel("门店编号")).toHaveValue("JD-SH-001");
    await expect(wizardStoreSelect(page, "省份").locator("option", { hasText: "上海市" })).toHaveCount(1);
    await expect(wizardStoreSelect(page, "区县").locator("option", { hasText: "静安区" })).toHaveCount(1);
    await consoleCollector.expectClean();
  });

  test("门店编辑器区域加载遇到会话过期：重登后重试恢复且表单保留", async ({ page }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowSession401: true });
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await expect(page.getByRole("row", { name: /静安嘉里中心店/ })).toBeVisible(); // 列表页自身的区域请求先行完成
    await page.request.post(fixtureControl, { data: { regionsUnauthorized: 2, expireOnMe: 2 } }); // dev StrictMode 双发（首个被 abort 但服务端已计数）+ 身份核对探测同样被拒
    await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
    await expect(page.getByRole("heading", { name: "登录已过期，请重新登录" })).toBeVisible();
    await page.getByLabel("管理员账号").fill("ops");
    await page.getByLabel("密码").fill("correct-password");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText("区域列表加载失败：登录已失效，请重新登录后再试")).toBeVisible();
    await expect(page.getByLabel("门店名称")).toHaveValue("静安嘉里中心店");
    await page.getByRole("button", { name: "重试" }).click();
    await expect(wizardStoreSelect(page, "省份").locator("option", { hasText: "上海市" })).toHaveCount(1);
    await expect(wizardStoreSelect(page, "区县").locator("option", { hasText: "静安区" })).toHaveCount(1);
    mkdirSync(recoveryShotDir, { recursive: true });
    await page.screenshot({ path: `${recoveryShotDir}/store-form-region-recovered.png`, fullPage: true }); // 恢复后的门店表单（仓库外）
    await consoleCollector.expectClean();
  });

  test("跨标签重认证：迟到的 CSRF 403 不刷新也不重放旧写入", async ({ page, context }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowHttpFailures: 1 }); // 注入的 403 资源错误
    await page.addInitScript(TMAP_STUB);
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
    let patchCount = 0;
    page.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes("/api/admin/stores/")) patchCount += 1; });
    await page.getByLabel("门店名称").fill("跨标签竞态门店");
    await page.request.post(fixtureControl, { data: { csrfRejects: 1, csrfRejectsDelayMs: 3000 } });
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click(); // PATCH 在途：3 秒后返回 403
    // 在途期间在另一标签完成登出+换账号登录（同一 cookie 空间）
    const tab2 = await context.newPage();
    await tab2.goto("/");
    await tab2.getByRole("button", { name: "退出登录" }).click();
    await expect(tab2.getByLabel("管理员账号")).toBeVisible();
    await tab2.getByLabel("管理员账号").fill("store");
    await tab2.getByLabel("密码").fill("correct-password");
    await tab2.getByRole("button", { name: "登录" }).click();
    await expect(tab2.locator(".admin-user").getByText("静安嘉里中心店")).toBeVisible();
    // 迟到的 403 回到标签 1：认证代际已切换 → 不刷新令牌、不重放（全程仅一次 PATCH）、不显示成功
    await page.waitForTimeout(3500);
    expect(patchCount).toBe(1);
    await expect(page.getByText("门店范围已保存")).toHaveCount(0);
    await expect(page.getByLabel("门店名称")).toHaveValue("跨标签竞态门店");
    await expect(tab2.getByRole("heading", { name: "暗访执行工作台" })).toBeVisible(); // 新账号登录不受打扰
    await consoleCollector.expectClean();
  });

  test("跨标签重认证：迟到的 401 不遮罩新登录用户也不重放", async ({ page, context }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowSession401: true });
    await page.addInitScript(TMAP_STUB);
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
    await page.getByLabel("门店名称").fill("迟到401竞态门店");
    await page.request.post(fixtureControl, { data: { storeSaveUnauthorized: 1, storeSaveUnauthorizedDelayMs: 3000 } });
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click(); // PATCH 在途：3 秒后返回 401
    const tab2 = await context.newPage();
    await tab2.goto("/");
    await tab2.getByRole("button", { name: "退出登录" }).click();
    await expect(tab2.getByLabel("管理员账号")).toBeVisible();
    await tab2.getByLabel("管理员账号").fill("store");
    await tab2.getByLabel("密码").fill("correct-password");
    await tab2.getByRole("button", { name: "登录" }).click();
    await expect(tab2.locator(".admin-user").getByText("静安嘉里中心店")).toBeVisible();
    // 迟到的 401 回到标签 1：代际已切换 → stale，不切过期遮罩、不进入重登/重试流
    await page.waitForTimeout(3500);
    await expect(page.getByRole("heading", { name: "登录已过期，请重新登录" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "编辑门店和范围" })).toBeVisible(); // 标签 1 保持原编辑界面，未被遮罩
    await expect(page.getByText("登录已失效，请重新登录")).toBeVisible(); // stale 错误只就地展示
    await expect(tab2.getByRole("heading", { name: "暗访执行工作台" })).toBeVisible(); // 新账号登录不受打扰
    await consoleCollector.expectClean();
  });

  test("禁用存储时跨标签换号：迟到的 CSRF 403 按会话身份核对 fail closed，不重放旧写入", async ({ page, context }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowSession401: true, allowHttpFailures: 1 }); // 注入的 403 资源错误
    const STORAGE_BREAKER = `
      Object.defineProperty(window, "localStorage", { value: { getItem: () => { throw new Error("storage disabled"); }, setItem: () => { throw new Error("storage disabled"); }, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } });
    `;
    await page.addInitScript(STORAGE_BREAKER); // 内存代际栅栏在存储不可用时依旧完整
    await page.addInitScript(TMAP_STUB);
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
    let patchCount = 0;
    page.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes("/api/admin/stores/")) patchCount += 1; });
    await page.getByLabel("门店名称").fill("禁用存储竞态门店");
    await page.request.post(fixtureControl, { data: { csrfRejects: 1, csrfRejectsDelayMs: 3000 } });
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click(); // PATCH 在途：3 秒后 403
    // 在途期间另一标签（同样禁用存储）登出并换账号登录：cookie 已换人，本标签代际不可见
    const tab2 = await context.newPage();
    await tab2.addInitScript(STORAGE_BREAKER);
    await tab2.goto("/");
    await tab2.getByRole("button", { name: "退出登录" }).click();
    await expect(tab2.getByLabel("管理员账号")).toBeVisible();
    await tab2.getByLabel("管理员账号").fill("store");
    await tab2.getByLabel("密码").fill("correct-password");
    await tab2.getByRole("button", { name: "登录" }).click();
    await expect(tab2.locator(".admin-user").getByText("静安嘉里中心店")).toBeVisible();
    // 迟到的 403：CSRF 刷新到的 /api/me 归属（门店负责人）≠ 发起请求的用户（运营管理员）
    // → fail closed 进入可恢复重认证；全程仅一次 PATCH，旧写入绝不重放
    await page.waitForTimeout(3500);
    expect(patchCount).toBe(1);
    // fail closed：可恢复的重认证遮罩，表单完全被覆盖
    await expect(page.getByRole("heading", { name: "登录已过期，请重新登录" })).toBeVisible();
    await expect(page.getByLabel("门店名称")).toBeHidden();
    await expect(tab2.getByRole("heading", { name: "暗访执行工作台" })).toBeVisible(); // 新账号登录不受打扰
    // 同账号重登后：保存弹窗与输入仍在，可重试且只补一次 PATCH
    await page.getByLabel("管理员账号").fill("ops");
    await page.getByLabel("密码").fill("correct-password");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText("登录已过期，请重新登录后再试")).toBeVisible();
    await page.getByRole("button", { name: "重试" }).click();
    await expect(page.getByText("门店范围已保存")).toBeVisible();
    expect(patchCount).toBe(2); // 原 403 拒绝 + 重试成功，从未重放被拒的写入
    await consoleCollector.expectClean();
  });

  test("禁用存储时跨标签换号：迟到的 401 经身份核对按过期响应丢弃，不遮罩新登录", async ({ page, context }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowSession401: true });
    const STORAGE_BREAKER = `
      Object.defineProperty(window, "localStorage", { value: { getItem: () => { throw new Error("storage disabled"); }, setItem: () => { throw new Error("storage disabled"); }, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } });
    `;
    await page.addInitScript(STORAGE_BREAKER);
    await page.addInitScript(TMAP_STUB);
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
    await page.getByLabel("门店名称").fill("禁用存储迟到401门店");
    await page.request.post(fixtureControl, { data: { storeSaveUnauthorized: 1, storeSaveUnauthorizedDelayMs: 3000 } });
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click(); // PATCH 在途：3 秒后 401
    const tab2 = await context.newPage();
    await tab2.addInitScript(STORAGE_BREAKER);
    await tab2.goto("/");
    await tab2.getByRole("button", { name: "退出登录" }).click();
    await expect(tab2.getByLabel("管理员账号")).toBeVisible();
    await tab2.getByLabel("管理员账号").fill("store");
    await tab2.getByLabel("密码").fill("correct-password");
    await tab2.getByRole("button", { name: "登录" }).click();
    await expect(tab2.locator(".admin-user").getByText("静安嘉里中心店")).toBeVisible();
    // 迟到的 401：身份核对发现 cookie 仍有效（门店负责人）→ 按 stale 丢弃——不遮罩、不重放
    await page.waitForTimeout(3500);
    await expect(page.getByRole("heading", { name: "登录已过期，请重新登录" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "编辑门店和范围" })).toBeVisible();
    await expect(page.getByText("登录已失效，请重新登录")).toBeVisible(); // stale 只就地展示
    await expect(tab2.getByRole("heading", { name: "暗访执行工作台" })).toBeVisible(); // 新账号登录不受打扰
    await consoleCollector.expectClean();
  });

  test("迟到的成功恢复响应跨登录被丢弃：不覆盖新登录状态", async ({ page, context }) => {
    const consoleCollector = attachBusinessConsoleCollector(page);
    await login(page);
    // 仅延迟本页恢复探测的「交付」：服务端立即返回换号前的 ops 会话，5 秒后才交给应用（page.route 只作用于本页）
    await page.route((url) => url.pathname === "/api/me", async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await route.fulfill({ response });
    });
    await page.reload();
    await expect(page.getByText("正在恢复登录状态…")).toBeVisible(); // 延迟窗口内：恢复请求在途（ops 凭证已被捕获）
    // 延迟窗口内另一标签登出并换账号登录（代际推进）
    const tab2 = await context.newPage();
    await tab2.goto("/");
    await tab2.getByRole("button", { name: "退出登录" }).click();
    await expect(tab2.getByLabel("管理员账号")).toBeVisible();
    await tab2.getByLabel("管理员账号").fill("store");
    await tab2.getByLabel("密码").fill("correct-password");
    await tab2.getByRole("button", { name: "登录" }).click();
    await expect(tab2.locator(".admin-user").getByText("静安嘉里中心店")).toBeVisible();
    // 迟到的 200 恢复响应（换号前捕获的 ops 会话）：代际已变 → 按过期丢弃；
    // 标签 1 落到登录页（不采用旧身份，也不自动变成 cookie 上的新身份）
    await expect(page.getByLabel("管理员账号")).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("heading", { name: "暗访执行工作台" })).toHaveCount(0);
    await expect(page.getByText("静安嘉里中心店")).toHaveCount(0);
    await consoleCollector.expectClean();
  });

  test("指派复合保存断点续跑：第一段成功后第二段 401，重登重试只补菜品步骤", async ({ page }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowSession401: true });
    await login(page);
    await page.request.post(fixtureControl, { data: { dishRequirementsUnauthorized: 1, expireOnMe: 1 } }); // 401 建模真实失效
    await page.getByRole("button", { name: "探店任务" }).click();
    await page.getByRole("row", { name: /夏季门店服务品质暗访/ }).getByRole("button", { name: "查看指派" }).click();
    await page.getByRole("row", { name: /周雨晴/ }).getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: "编辑要求" }).click();
    await expect(page.getByRole("heading", { name: "编辑指派" })).toBeVisible();
    let patchCount = 0;
    let dishPutCount = 0;
    page.on("request", (r) => {
      if (r.method() === "PATCH" && /\/api\/admin\/assignments\/[^/]+$/.test(r.url())) patchCount += 1;
      if (r.method() === "PUT" && r.url().includes("/dish-requirements")) dishPutCount += 1;
    });
    await page.getByLabel("预算上限（元）").fill("560");
    await page.getByRole("button", { name: "保存指派" }).click();
    await page.getByRole("button", { name: "确认" }).click();
    // 第一段（指派 PATCH）已成功，第二段（菜品 PUT）401：弹窗保持 + 登录遮罩，输入不丢
    await expect(page.getByRole("heading", { name: "登录已过期，请重新登录" })).toBeVisible();
    await expect(page.getByLabel("预算上限（元）")).toBeHidden();
    await page.getByLabel("管理员账号").fill("ops");
    await page.getByLabel("密码").fill("correct-password");
    await page.getByRole("button", { name: "登录" }).click();
    // 重登后弹窗与输入均在，可原位重试：检查点生效——只补跑菜品 PUT，绝不带旧 revision 重发指派 PATCH
    await expect(page.getByText("登录已过期，请重新登录后再试")).toBeVisible();
    await expect(page.getByLabel("预算上限（元）")).toHaveValue("560");
    await page.getByRole("button", { name: "重试" }).click();
    await expect(page.getByText("指派已保存")).toBeVisible();
    expect(patchCount).toBe(1);
    expect(dishPutCount).toBe(2);
    await consoleCollector.expectClean();
  });

  test("禁用存储时探测在途被新登录取代：迟到的 401 经探测与代际复核 fail closed，不重放", async ({ page, context }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowSession401: true });
    const STORAGE_BREAKER = `
      Object.defineProperty(window, "localStorage", { value: { getItem: () => { throw new Error("storage disabled"); }, setItem: () => { throw new Error("storage disabled"); }, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } });
    `;
    await page.addInitScript(STORAGE_BREAKER);
    await page.addInitScript(TMAP_STUB);
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
    let patchCount = 0;
    page.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes("/api/admin/stores/")) patchCount += 1; });
    await page.getByLabel("门店名称").fill("探测保持竞态门店");
    await page.request.post(fixtureControl, { data: { storeSaveUnauthorized: 1, storeSaveUnauthorizedDelayMs: 2500 } });
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click(); // PATCH 在途：2.5 秒后 401
    // 401 抵达后触发身份核对探测；探测被本页路由扣住 6 秒——期间另一标签完成换账号登录
    await page.route((url) => url.pathname === "/api/me", async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 6000));
      await route.fulfill({ response });
    });
    const tab2 = await context.newPage();
    await tab2.addInitScript(STORAGE_BREAKER);
    await tab2.goto("/");
    await tab2.getByRole("button", { name: "退出登录" }).click();
    await expect(tab2.getByLabel("管理员账号")).toBeVisible();
    await tab2.getByLabel("管理员账号").fill("store");
    await tab2.getByLabel("密码").fill("correct-password");
    await tab2.getByRole("button", { name: "登录" }).click();
    await expect(tab2.locator(".admin-user").getByText("静安嘉里中心店")).toBeVisible();
    // 迟到的 401 → 探测在途期间已完成换账号登录：探测结果（新身份有效）+ 代际复核 → stale
    await page.waitForTimeout(8000);
    await expect(page.getByRole("heading", { name: "登录已过期，请重新登录" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "编辑门店和范围" })).toBeVisible();
    await expect(page.getByText("登录已失效，请重新登录")).toBeVisible(); // stale 只就地展示
    expect(patchCount).toBe(1); // 零重放
    await expect(tab2.getByRole("heading", { name: "暗访执行工作台" })).toBeVisible(); // 新账号登录不受打扰
    await consoleCollector.expectClean();
  });

  test("跨登录的迟到网络失败：不对账、不导航、不遮罩新登录", async ({ page, context }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowHttpFailures: 2 }); // 断连及其重试的资源错误
    await page.addInitScript(TMAP_STUB);
    await login(page);
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("button", { name: "新建门店" }).click();
    await page.getByLabel("门店编号").fill("JD-E2E-910");
    await page.getByLabel("门店名称").fill("跨登录网络失败门店");
    await wizardStoreSelect(page, "品牌").selectOption({ label: "建新园" });
    await page.getByPlaceholder("搜索门店或商场").fill("网络失败测试");
    await page.getByRole("button", { name: "搜索" }).click();
    await page.locator(".map-search-results button").first().click();
    // 仅延迟并中止本页的新建门店请求（page.route 只作用于本页，且 abort 不触发浏览器重试）
    await page.route((url) => url.pathname === "/api/admin/stores", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.abort("connectionreset");
    });
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click(); // POST 在途：3 秒后网络失败
    // 在途期间另一标签登出并换账号登录（代际推进）
    const tab2 = await context.newPage();
    await tab2.goto("/");
    await tab2.getByRole("button", { name: "退出登录" }).click();
    await expect(tab2.getByLabel("管理员账号")).toBeVisible();
    await tab2.getByLabel("管理员账号").fill("store");
    await tab2.getByLabel("密码").fill("correct-password");
    await tab2.getByRole("button", { name: "登录" }).click();
    await expect(tab2.locator(".admin-user").getByText("静安嘉里中心店")).toBeVisible();
    // 迟到的网络失败：按 stale 就地展示——绝不进入唯一编号对账、不切换路由、不遮罩新登录
    await page.waitForTimeout(3500);
    await expect(page.getByRole("heading", { name: "登录已过期，请重新登录" })).toHaveCount(0);
    await expect(page).toHaveURL(/\/admin\/stores\/new$/);
    await expect(page.getByText("暂时无法连接服务，请检查网络后重试")).toBeVisible();
    await expect(page.getByLabel("门店名称")).toHaveValue("跨登录网络失败门店");
    await expect(page.getByRole("heading", { name: "暗访执行工作台" })).toHaveCount(0);
    await expect(tab2.getByRole("heading", { name: "暗访执行工作台" })).toBeVisible(); // 新账号登录不受打扰
    await consoleCollector.expectClean();
  });

  test("被取代的迟到的登出不清除新登录：过期重登后旧登出结算仍可继续使用", async ({ page }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowSession401: true });
    await page.addInitScript(TMAP_STUB);
    await login(page);
    await page.request.post(fixtureControl, { data: { logoutDelayMs: 4000 } });
    await page.getByRole("button", { name: "退出登录" }).click(); // 登出在途：4 秒后才结算
    // 在途期间会话过期（保存 401 + 身份核对探测同样被拒）→ 遮罩 → 新登录（新认证意图取消在途登出）
    await page.getByRole("button", { name: "门店管理" }).click();
    await page.getByRole("row", { name: /静安嘉里中心店/ }).getByRole("button", { name: "编辑范围" }).click();
    await page.request.post(fixtureControl, { data: { storeSaveUnauthorized: 1, expireOnMe: 1 } });
    await page.getByLabel("门店名称").fill("新登录可用门店");
    await page.getByRole("button", { name: "保存门店" }).click();
    await page.getByRole("button", { name: "确认保存" }).click();
    await expect(page.getByRole("heading", { name: "登录已过期，请重新登录" })).toBeVisible();
    await page.getByLabel("管理员账号").fill("store");
    await page.getByLabel("密码").fill("correct-password");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.locator(".admin-user").getByText("静安嘉里中心店")).toBeVisible();
    // 被取代的登出结算（或已被取消）不得清除新会话：新登录保持可用
    await page.waitForTimeout(4500);
    await expect(page.getByRole("heading", { name: "编辑门店和范围" })).toBeVisible(); // 仍处于新账号的登录态
    await expect(page.getByLabel("管理员账号")).toHaveCount(0); // 未被旧登出踢回登录页
    await page.getByRole("button", { name: "运营概览" }).click();
    await expect(page.getByRole("heading", { name: "暗访执行工作台" })).toBeVisible(); // 新登录可正常发起请求
    await consoleCollector.expectClean();
  });

  test("指派分段保存：第二段再次失败仍提示未保存，重试补跑且不重复第一段", async ({ page }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowSession401: true });
    await login(page);
    await page.request.post(fixtureControl, { data: { dishRequirementsUnauthorized: 2 } }); // 菜品步骤连续两次 401（cookie 有效 → stale 就地报错）
    await page.getByRole("button", { name: "探店任务" }).click();
    await page.getByRole("row", { name: /夏季门店服务品质暗访/ }).getByRole("button", { name: "查看指派" }).click();
    await page.getByRole("row", { name: /周雨晴/ }).getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: "编辑要求" }).click();
    await expect(page.getByRole("heading", { name: "编辑指派" })).toBeVisible();
    let patchCount = 0;
    let dishPutCount = 0;
    page.on("request", (r) => {
      if (r.method() === "PATCH" && /\/api\/admin\/assignments\/[^/]+$/.test(r.url())) patchCount += 1;
      if (r.method() === "PUT" && r.url().includes("/dish-requirements")) dishPutCount += 1;
    });
    await page.getByLabel("预算上限（元）").fill("560");
    await page.getByRole("button", { name: "保存指派" }).click();
    await page.getByRole("button", { name: "确认" }).click();
    // 第一段成功、第二段 401（cookie 有效 → stale）：就地报错，弹窗提供「返回修改」
    await expect(page.getByText("登录已失效，请重新登录")).toBeVisible();
    await page.getByRole("button", { name: "返回修改" }).click();
    expect(patchCount).toBe(1);
    // 继续修改字段与菜品后再次保存：以检查点 revision 精确重发第一段
    await page.getByLabel("预算上限（元）").fill("600");
    await page.locator(".dish-requirement-row input").first().fill("改后菜品");
    await page.getByRole("button", { name: "保存指派" }).click();
    await page.getByRole("button", { name: "确认" }).click();
    await expect(page.getByText("登录已失效，请重新登录")).toBeVisible();
    await page.getByRole("button", { name: "返回修改" }).click();
    expect(patchCount).toBe(2);
    // 两段未全部完成：未保存修改守卫仍然拦截返回
    await page.goBack();
    await expect(page.getByText("有未保存的修改")).toBeVisible();
    await page.getByRole("button", { name: "留在本页" }).click();
    // 第三次保存：指纹一致 → 只补跑菜品步骤（不重复第一段）并完成，基准推进
    await page.getByRole("button", { name: "保存指派" }).click();
    await page.getByRole("button", { name: "确认" }).click();
    await expect(page.getByText("指派已保存")).toBeVisible();
    expect(patchCount).toBe(2);
    expect(dishPutCount).toBe(3);
    await consoleCollector.expectClean();
  });

  test("测试任务清理：非超管无入口；预览计数、逐字名称确认、清理后列表移除", async ({ page, request }) => {
    const consoleCollector = attachBusinessConsoleCollector(page, { allowSession401: true });
    await setFixtureScenario(request, { showCleanupCampaign: 1 });
    // 非超管角色（operations_admin）看不到清理入口
    await login(page, "ops");
    await page.getByRole("button", { name: "探店任务" }).click();
    await expect(page.getByRole("row", { name: /已取消的测试任务/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "清理测试数据" })).toHaveCount(0);
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByLabel("管理员账号")).toBeVisible();
    await login(page, "super");
    await page.getByRole("button", { name: "探店任务" }).click();
    const row = page.getByRole("row", { name: /已取消的测试任务/ });
    await expect(row).toBeVisible();
    await expect(page.getByRole("button", { name: "清理测试数据" })).toHaveCount(1);
    await row.getByRole("button", { name: "清理测试数据" }).click();
    await expect(page.getByText("清理这个测试任务的数据？")).toBeVisible();
    await expect(page.locator(".cleanup-count-list")).toContainText("指派");
    await expect(page.locator(".cleanup-count-list")).toContainText("消费小票");
    // 名称不一致时确认按钮保持禁用
    await page.getByLabel(/以确认清理/).fill("错别的名字");
    await expect(page.getByRole("button", { name: "确认清理" })).toBeDisabled();
    await page.getByLabel(/以确认清理/).fill("已取消的测试任务");
    await page.getByRole("button", { name: "确认清理" }).click();
    await expect(page.getByText("任务测试数据已清理")).toBeVisible();
    await expect(page.getByRole("row", { name: /已取消的测试任务/ })).toHaveCount(0);
    await consoleCollector.expectClean();
  });
});
