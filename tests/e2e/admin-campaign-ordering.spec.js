import { expect, test } from "@playwright/test";

// 探店任务与指派列表排序回归：列表请求带 sort=dueAt（执行窗口截止时间倒序，截止晚的在前），
// 行序完全由服务端返回决定（前端不做页面内重排），执行窗口列逐行保持原 startsAt/dueAt；
// 其他 /campaigns 消费者（概览统计）不带 sort，保持既有 id 排序不受影响。
// 固件：tests/fixtures/contract-server.mjs（本用例仅接管 sort=dueAt 的列表请求，其余照常透传）。

// 固定时区让 toLocaleString("zh-CN") 的日期部分确定（窗口时间均取当地 14:00-18:00，不跨日）
test.use({ timezoneId: "Asia/Shanghai" });

async function login(page, username = "ops") {
  await page.goto("/");
  await page.getByLabel("管理员账号").fill(username);
  await page.getByLabel("密码").fill("correct-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("暗访执行工作台")).toBeVisible();
}

// 服务端按 dueAt 倒序返回：id 序（due-1→2→3）与任务名称序都与返回序不同，
// 排除前端按 id/名称重排的可能——渲染顺序只能来自响应数组本身。
const servedRows = [
  { id: "campaign-due-1", name: "三月末截止任务", businessNo: "JD-DUE-003", storeName: "静安嘉里中心店", startsAt: "2026-03-20T06:00:00Z", dueAt: "2026-03-25T06:00:00Z", questionnaireDeadlineAt: "2026-03-25T10:00:00Z", assignmentCount: 1, overdueCount: 0, status: "draft", revision: 1 },
  { id: "campaign-due-3", name: "三月中截止任务", businessNo: "JD-DUE-002", storeName: "静安大融城店", startsAt: "2026-03-10T06:00:00Z", dueAt: "2026-03-15T06:00:00Z", questionnaireDeadlineAt: "2026-03-15T10:00:00Z", assignmentCount: 2, overdueCount: 0, status: "published", revision: 2 },
  { id: "campaign-due-2", name: "三月初截止任务", businessNo: "JD-DUE-001", storeName: "静安晶品店", startsAt: "2026-03-01T06:00:00Z", dueAt: "2026-03-05T06:00:00Z", questionnaireDeadlineAt: "2026-03-05T10:00:00Z", assignmentCount: 3, overdueCount: 0, status: "in_progress", revision: 3 },
];

test("探店任务列表按执行窗口截止时间倒序请求并按服务端顺序渲染", async ({ page }) => {
  const campaignQueries = [];
  await page.route("**/api/admin/campaigns*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/api/admin/campaigns")) campaignQueries.push(url.searchParams);
    // 只接管列表页的 sort=dueAt 请求；概览统计等其余消费者透传给 fixture 服务
    if (url.searchParams.get("sort") !== "dueAt") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: servedRows, nextCursor: null }) });
  });
  await login(page);
  await page.getByRole("button", { name: "探店任务" }).click();
  await expect(page.getByRole("heading", { name: "探店任务与指派" })).toBeVisible();

  // 列表请求携带排序选择器（order=desc + sort=dueAt），且概览统计的并发请求不带 sort
  expect(campaignQueries.length).toBeGreaterThanOrEqual(2);
  const listQuery = campaignQueries.find((query) => query.get("sort") === "dueAt");
  expect(listQuery.get("order")).toBe("desc");
  expect(listQuery.get("limit")).toBe("100");
  expect(campaignQueries.some((query) => query.get("sort") === null)).toBe(true);

  // 行序 = 服务端返回的截止倒序；各任务行完整可操作（状态徽标与行内操作按钮照常渲染）
  const rowNames = await page.locator(".data-table tbody tr td:first-child strong").allInnerTexts();
  expect(rowNames).toEqual(["三月末截止任务", "三月中截止任务", "三月初截止任务"]);
  // 执行窗口列逐行保持原窗口（多日窗口展示 起点 至 最终截止，不被排序截断改写）
  const windows = await page.locator(".data-table tbody tr td:nth-child(3)").allInnerTexts();
  expect(windows[0]).toContain("2026/3/20");
  expect(windows[0]).toContain("2026/3/25");
  expect(windows[2]).toContain("2026/3/1");
  expect(windows[2]).toContain("2026/3/5");
  // nextCursor 为空时不出现「加载更多」（列表一次性取 100 条的正常形态）
  await expect(page.locator(".pager")).toHaveCount(0);
});
