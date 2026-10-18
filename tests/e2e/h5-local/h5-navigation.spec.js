// H5 本地导航回归（真实 API + 真实 junde_test + 真实构建产物）：
// 探店员端导航来源修复的端到端用户流——
//   1) 全新登录 → 定位说明 → 完成后进「首页」（不再日程）；冷启动已有会话直接首页；
//   2) 任务详情返回随业务来源（日程→日程 / 首页→首页），文案与去向一致；
//   3) 任务 → 问卷（顶部返回键）→ 任务 → 来源页；问卷内选中分类跨 问题页往返 与
//      菜品往返、刷新保留；业务 ID 全程一致；
//   4) 直达问题页 + 无关浏览器历史：确认后落到规范问卷 URL（绝不 history.back 出应用）；
//   5) 非法 source 回落日程；合法 source 刷新保留；
//   6) 我的 → 隐私与定位/填写帮助 → 返回我的。
// 只允许 junde_test（shared.testDatabaseUrl 保险丝）；定位经 Playwright geolocation。
import { expect, test } from "@playwright/test";
import pg from "pg";
import { createPasswordService } from "../../../apps/api/src/auth/passwords.js";
import { encrypt, hmac, normalizePhone } from "../../../apps/api/src/auth/crypto.js";
import { uuidv7 } from "../../../apps/api/src/ids.js";
import { wgs84ToGcj02 } from "../../../apps/web/src/utils/coordinates.js";
import { seedRbac } from "../../../db/seeds/rbac.mjs";
import {
  H5_TEST_AUTH_KEY, H5_TEST_PHONE_KEY, INSPECTOR_PASSWORD, INSPECTOR_USERNAME, testDatabaseUrl,
} from "./shared.mjs";

// 保险丝：连接前先失败关闭（绝不指向 junde 开发库）。
testDatabaseUrl();

const config = {
  NODE_ENV: "test",
  AUTH_TOKEN_HMAC_KEY: H5_TEST_AUTH_KEY,
  PHONE_ENCRYPTION_KEY_BASE64: H5_TEST_PHONE_KEY,
};

// 使浏览器（WGS84）定位经 wgs84ToGcj02 转换后正好落在门店坐标（迭代收敛，误差远小于半径）。
function wgs84NearStore(storeGcj) {
  let point = { latitude: storeGcj.latitude, longitude: storeGcj.longitude };
  for (let index = 0; index < 4; index += 1) {
    const converted = wgs84ToGcj02(point.latitude, point.longitude);
    point = {
      latitude: point.latitude - (converted.latitude - storeGcj.latitude),
      longitude: point.longitude - (converted.longitude - storeGcj.longitude),
    };
  }
  return point;
}

let pool;
let world;

async function seedWorld() {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash(INSPECTOR_PASSWORD);
  const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const inspectorId = uuidv7();
  await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,'InspectorOne','inspectorone','探员',$2,$3,now(),$4,'approved_active')`,
    [inspectorId, encrypt(encryptionKey, normalizePhone("13800000000")), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13800000000")), passwordHash]);
  const inspectorRole = await pool.query("SELECT id FROM roles WHERE code='inspector'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), inspectorId, inspectorRole.rows[0].id]);
  const provinceId = uuidv7(); const cityId = uuidv7(); const regionId = uuidv7(); const storeId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'静安区','310106',$2,3)", [regionId, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-H5NAV','导航回归门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, inspectorId]);
  const templateId = uuidv7(); const versionId = uuidv7();
  const questionEnv = uuidv7(); const questionService = uuidv7(); const questionProduct = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'H5导航回归问卷','secret',$2)", [templateId, inspectorId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_by,published_at) VALUES ($1,$2,1,'published',$3,$3,now())", [versionId, templateId, inspectorId]);
  // 三分类各一题，全部免证据（不得分只需说明）：分类 tab 由服务端聚合下发（migration 0025 种子行）。
  await pool.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,sort_order) VALUES
    ($1,$2,'nq1',1,'environment','导航回归题一',2,true,1),
    ($3,$2,'nq2',2,'service','导航回归题二',3,true,2),
    ($4,$2,'nq3',3,'product','导航回归题三',2,true,3)`,
    [questionEnv, versionId, questionService, questionProduct]);
  await pool.query(`INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count,image_max_count,audio_max_duration_seconds)
    VALUES ($1,false,false,false,0,0,3,10),($2,false,false,false,0,0,3,10),($3,false,false,false,0,0,3,10)`,
    [questionEnv, questionService, questionProduct]);
  const campaignId = uuidv7(); const assignmentId = uuidv7(); const cancelledCampaignId = uuidv7(); const cancelledId = uuidv7();
  const startsAt = new Date(Date.now() - 60_000); const dueAt = new Date(Date.now() + 3_600_000);
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,'C-H5NAV','H5导航回归任务',$2,$3,$4,$5,'published',$6)", [campaignId, storeId, startsAt, dueAt, new Date(Date.now() + 7_200_000), inspectorId]);
  await pool.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,receipt_required,status,created_by)
    VALUES ($1,'A-H5NAV',$2,$3,$4,'secret',$5,$6,0,false,'assigned',$7)`, [assignmentId, campaignId, inspectorId, versionId, startsAt, dueAt, inspectorId]);
  // 已取消任务（同一活动+探员唯一，故单开一个活动）：终态卡渲染来源返回按钮（返回首页/返回日程文案与去向一致）。
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,'C-H5NAV-C','H5导航回归取消任务',$2,$3,$4,$5,'published',$6)", [cancelledCampaignId, storeId, startsAt, dueAt, new Date(Date.now() + 7_200_000), inspectorId]);
  await pool.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,receipt_required,status,cancel_reason,cancelled_at,cancelled_by,created_by)
    VALUES ($1,'A-H5NAV-C',$2,$3,$4,'secret',$5,$6,0,false,'cancelled','管理员取消',now(),$3,$7)`, [cancelledId, cancelledCampaignId, inspectorId, versionId, startsAt, dueAt, inspectorId]);
  return { inspectorId, assignmentId, cancelledId, questionnaireVersionId: versionId, questions: [questionEnv, questionService, questionProduct], storeGcj: { latitude: 31.2304, longitude: 121.4737 } };
}

let api;

// 植入探员会话（真实 /api/auth/login 返回值）并授予定位权限。
async function plantSession(page, context) {
  const login = await context.request.post("/api/auth/login", { data: { username: INSPECTOR_USERNAME, password: INSPECTOR_PASSWORD } });
  expect(login.ok(), await login.text()).toBeTruthy();
  const session = await login.json();
  await page.addInitScript(([key, value]) => { window.localStorage.setItem(key, value); }, ["junde:session", JSON.stringify(session)]);
  return session;
}

test.beforeAll(async ({ playwright, baseURL }) => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
  await pool.query("SELECT 1 FROM users LIMIT 1"); // schema 未迁移时立即失败
  await pool.query(`TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users, questionnaire_templates, questionnaire_versions, questions, question_evidence_requirements, regions, stores, audit_campaigns, audit_assignments, survey_attempts, question_evidence_attachments, question_answer_edit_sessions, question_answer_edit_session_removals, receipt_attachments, receipt_ocr_jobs, receipt_ocr_job_attachments, receipt_ocr_candidates, receipt_ocr_applications, export_jobs, object_cleanup_jobs, submission_versions, submission_question_scores, audit_logs, idempotency_keys, dish_records, other_records, audit_checkins, checkin_exemptions RESTART IDENTITY CASCADE`);
  await seedRbac(pool);
  // 评估分类基线自足：其他套件会 TRUNCATE question_categories 并只回种部分行，按 0025 规范集合补齐。
  await pool.query(`INSERT INTO question_categories (id,code,name,sort_order) VALUES
    (gen_random_uuid(),'environment','环境卫生',1),(gen_random_uuid(),'service','为客服务',2),(gen_random_uuid(),'product','产品品质',3)
    ON CONFLICT (code) DO NOTHING`);
  world = await seedWorld();
  api = await playwright.request.newContext({ baseURL });
});

test.afterAll(async () => {
  await api?.dispose();
  await pool?.end();
});

// 浏览器定位桩：经 wgs84ToGcj02 收敛后正好落在门店；accuracy 必须为正（后端 schema 校验）。
async function grantStoreLocation(context) {
  await context.grantPermissions(["geolocation"], { origin: "http://127.0.0.1:5199" });
  const point = wgs84NearStore(world.storeGcj);
  await context.setGeolocation({ latitude: point.latitude, longitude: point.longitude, accuracy: 10 });
}

test("fresh login goes through location and lands on Home (not Schedule)", async ({ page, context }) => {
  await grantStoreLocation(context);
  await page.goto("/#/login");
  await page.locator('[data-page="login"]').waitFor();
  await page.getByPlaceholder("请输入用户名").fill(INSPECTOR_USERNAME);
  await page.getByPlaceholder("请输入密码（10-64 字符）").fill(INSPECTOR_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  // 登录成功 → 定位说明页（隐私/授权策略保留）。
  const location = page.locator('[data-page="location"]');
  await expect(location).toHaveAttribute("data-status", "idle", { timeout: 15_000 });
  // 定位成功 → 完成按钮文案与去向一致：进入首页。
  await page.getByRole("button", { name: "允许获取位置" }).click();
  const enterHome = page.getByRole("button", { name: "进入首页" });
  await expect(enterHome).toBeVisible({ timeout: 15_000 });
  await enterHome.click();
  await expect(page.locator('[data-page="home"]')).toBeVisible();
  expect(page.url()).toContain("#/home");
});

test("cold start with an existing session lands on Home from the login page", async ({ page, context }) => {
  await plantSession(page, context);
  await page.goto("/#/login");
  await expect(page.locator('[data-page="home"]')).toBeVisible({ timeout: 15_000 });
});

test("task back button returns to the actual business origin with honest labels", async ({ page, context }) => {
  await plantSession(page, context);
  // 日程进入 → 返回日程（进行中任务用顶部返回键，去向为行为断言）。
  await page.goto("/#/schedule");
  await expect(page.locator('[data-page="schedule"]')).toBeVisible();
  await page.locator('[data-page="schedule"] .card').first().click();
  const task = page.locator('[data-page="task"]');
  await expect(task).toBeVisible();
  await task.locator(".page-nav__back").click();
  await expect(page.locator('[data-page="schedule"]')).toBeVisible();
  // 首页进入 → 返回首页。
  await page.goto("/#/home");
  await expect(page.locator('[data-page="home"]')).toBeVisible();
  await page.locator('[data-page="home"] .card').nth(1).click(); // 大任务卡（首卡为 Hero）
  const taskFromHome = page.locator('[data-page="task"]');
  await expect(taskFromHome).toBeVisible();
  await taskFromHome.locator(".page-nav__back").click();
  await expect(page.locator('[data-page="home"]')).toBeVisible();
  // 终态（已取消）卡：来源按钮文案与去向一致（日程来源 → 返回日程）。
  await page.goto(`/#/task?assignmentId=${world.cancelledId}&source=schedule`);
  await expect(task).toContainText("任务已取消");
  await expect(task).toContainText("返回日程");
  await task.getByRole("button", { name: "返回日程" }).click();
  await expect(page.locator('[data-page="schedule"]')).toBeVisible();
  // 同一终态任务从首页进入 → 返回首页。
  await page.goto(`/#/task?assignmentId=${world.cancelledId}&source=home`);
  await expect(task).toContainText("返回首页");
  await task.getByRole("button", { name: "返回首页" }).click();
  await expect(page.locator('[data-page="home"]')).toBeVisible();
  // 加载错误（不存在的任务）同样随来源返回（错误卡按钮）。
  await page.goto(`/#/task?assignmentId=not-a-real-id&source=home`);
  await expect(task).toContainText("暂时无法打开任务");
  await task.getByRole("button", { name: "返回首页" }).click();
  await expect(page.locator('[data-page="home"]')).toBeVisible();
});

test("task -> survey -> back to task -> back to Home keeps the origin chain", async ({ page, context }) => {
  await grantStoreLocation(context);
  await plantSession(page, context);
  await page.goto("/#/home");
  await expect(page.locator('[data-page="home"]')).toBeVisible();
  await page.locator('[data-page="home"] .card').nth(1).click();
  const task = page.locator('[data-page="task"]');
  await expect(task).toBeVisible();
  // 开始探店：定位 → 打卡 → 创建问卷 → 进入问卷（等待阶段机完成）。
  await task.getByRole("button", { name: "开始探店" }).click();
  const survey = page.locator('[data-page="survey"]');
  await expect(survey).toBeVisible({ timeout: 30_000 });
  expect(page.url()).toContain(`assignmentId=${world.assignmentId}`);
  // 记录 attemptId（start 响应产生），供后续直达问题页用例构造同任务深链。
  world.attemptId = new URLSearchParams(page.url().split("#/survey?")[1]).get("attemptId");
  expect(world.attemptId).toBeTruthy();
  // 问卷顶部返回键存在 → 回到任务详情（任务来源保留）。
  await survey.locator(".page-nav__back").click();
  await expect(task).toContainText("继续填写");
  // 任务返回 → 首页（来源链：survey → task → home）。
  await task.locator(".page-nav__back").click();
  await expect(page.locator('[data-page="home"]')).toBeVisible();
});

test("selected category survives issue roundtrip, dishes roundtrip and reload; ids stay identical", async ({ page, context }) => {
  await plantSession(page, context);
  await page.goto("/#/home");
  await expect(page.locator('[data-page="home"]')).toBeVisible();
  await page.locator('[data-page="home"] .card').nth(1).click();
  const task = page.locator('[data-page="task"]');
  await expect(task).toBeVisible();
  await task.getByRole("button", { name: "继续填写" }).click();
  const survey = page.locator('[data-page="survey"]');
  await expect(survey).toBeVisible();
  const idsBefore = page.url();

  // 分类一（环境卫生）：不得分 → 问题页 → 确认 → 回问卷。
  await survey.locator(".filter-chips .chip", { hasText: "环境卫生" }).click();
  await survey.getByRole("button", { name: "不得分", exact: true }).click();
  const issue = page.locator('[data-page="issue"]');
  await expect(issue).toBeVisible();
  await issue.locator("textarea").fill("导航回归：环境卫生问题说明");
  await issue.getByRole("button", { name: "确认", exact: true }).click();
  await expect(survey).toBeVisible();
  // 回到问卷后仍停在「环境卫生」分类（会话级记忆，等价问题页往返不丢分类）。
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("环境卫生");

  // 分类二（为客服务）：不得分往返后切分类三（产品品质）点「得分」。
  await survey.locator(".filter-chips .chip", { hasText: "为客服务" }).click();
  await survey.getByRole("button", { name: "不得分", exact: true }).click();
  await expect(page.locator('[data-page="issue"]')).toBeVisible();
  await page.locator('[data-page="issue"] textarea').fill("导航回归：为客服务问题说明");
  await page.locator('[data-page="issue"]').getByRole("button", { name: "确认", exact: true }).click();
  await expect(survey).toBeVisible();
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("为客服务");
  await survey.locator(".filter-chips .chip", { hasText: "产品品质" }).click();
  await survey.getByRole("button", { name: "得分", exact: true }).click();
  await expect(survey).toContainText("已保存");

  // 全题完成 → 下一步进菜品页（receiptRequired=false 无小票要求）→ 上一步回问卷。
  await survey.getByRole("button", { name: "下一步：其他照片" }).click();
  const dishes = page.locator('[data-page="dishes"]');
  await expect(dishes).toBeVisible();
  await dishes.getByRole("button", { name: "上一步：答题" }).click();
  await expect(survey).toBeVisible();
  // 菜品往返后分类仍为「产品品质」（保存前选中的分类被记忆还原）。
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("产品品质");
  // 业务 ID 全程一致（进入问卷与往返后的任务身份不变）。
  const beforeParams = new URLSearchParams(idsBefore.split("#/survey?")[1] || "");
  const after = new URLSearchParams(page.url().split("#/survey?")[1] || "");
  expect(after.get("assignmentId")).toBe(beforeParams.get("assignmentId"));
  expect(after.get("attemptId")).toBe(beforeParams.get("attemptId"));
  expect(after.get("questionnaireVersionId")).toBe(beforeParams.get("questionnaireVersionId"));

  // 刷新：分类仍还原（会话级记忆），任务身份仍一致。
  await page.reload();
  await expect(survey).toBeVisible();
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("产品品质");
  expect(page.url()).toContain(`assignmentId=${encodeURIComponent(after.get("assignmentId"))}`);
});

test("direct-entry issue with unrelated browser history returns to the canonical in-app survey", async ({ page, context }) => {
  const session = await plantSession(page, context);
  // 本用例自备 attempt（不依赖前序用例）：start 已存在时回退读任务详情。
  const started = await api.post(`/api/assignments/${world.assignmentId}/start`, { headers: { authorization: `Bearer ${session.accessToken}` } });
  let attemptId = started.ok() ? (await started.json()).attempt.id : null;
  if (!attemptId) {
    const detail = await api.get(`/api/assignments/${world.assignmentId}`, { headers: { authorization: `Bearer ${session.accessToken}` } });
    expect(detail.ok(), await detail.text()).toBeTruthy();
    attemptId = (await detail.json()).attempt?.id;
  }
  expect(attemptId, "attempt must exist for the direct-entry deep link").toBeTruthy();
  // 无关历史条目（非应用路由）：旧实现凭 history.length 会 back 到这里。
  await page.goto("/healthz");
  await expect(page.getByText("ok", { exact: true })).toBeVisible();
  // 直达问题页（无任何应用内父页证据），携来源链与分类（source=home、category=service）。
  await page.goto(`/#/issue?assignmentId=${world.assignmentId}&attemptId=${attemptId}&questionnaireVersionId=${world.questionnaireVersionId}&questionId=${world.questions[1]}&target=unscored&revision=0&source=home&category=service`);
  const issue = page.locator('[data-page="issue"]');
  await expect(issue).toBeVisible();
  await issue.locator("textarea").fill("导航回归：直达问题页说明");
  await issue.getByRole("button", { name: "确认", exact: true }).click();
  // 落到携全量业务参数的规范问卷页（同任务），而不是回退到 /healthz。
  const survey = page.locator('[data-page="survey"]');
  await expect(survey).toBeVisible();
  expect(page.url()).toContain("#/survey?assignmentId=");
  const params = new URLSearchParams(page.url().split("#/survey?")[1]);
  expect(params.get("assignmentId")).toBe(world.assignmentId);
  expect(params.get("attemptId")).toBe(attemptId);
  expect(params.get("questionnaireVersionId")).toBe(world.questionnaireVersionId);
  expect(params.get("source")).toBe("home");
  // 路由指定的分类优先于会话记忆（此前用例记忆了「产品品质」），确认后落在「为客服务」。
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("为客服务");
  expect(await page.getByText("ok", { exact: true }).count()).toBe(0);
  // 来源链保持：问卷 → 任务（source=home）→ 首页（而非日程）。
  await survey.locator(".page-nav__back").click();
  const task = page.locator('[data-page="task"]');
  await expect(task).toBeVisible();
  expect(page.url()).toContain("&source=home");
  await task.locator(".page-nav__back").click();
  await expect(page.locator('[data-page="home"]')).toBeVisible();

  // 取消路径：直达问题页（target=scored 免校验）→ 取消 → 同样落规范问卷并保持来源。
  await page.goto("/healthz");
  await page.goto(`/#/issue?assignmentId=${world.assignmentId}&attemptId=${attemptId}&questionnaireVersionId=${world.questionnaireVersionId}&questionId=${world.questions[2]}&target=scored&revision=0&source=home&category=product`);
  await expect(page.locator('[data-page="issue"]')).toBeVisible();
  await page.locator('[data-page="issue"]').getByRole("button", { name: "取消", exact: true }).click();
  await expect(survey).toBeVisible();
  expect(new URLSearchParams(page.url().split("#/survey?")[1]).get("source")).toBe("home");
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("产品品质");
});

test("invalid task source falls back to Schedule; valid source survives reload", async ({ page, context }) => {
  await plantSession(page, context);
  const task = page.locator('[data-page="task"]');
  // 非法 source → 白名单回落日程：返回键去向为行为断言。
  await page.goto(`/#/task?assignmentId=${world.assignmentId}&source=https://evil.example`);
  await expect(task).toBeVisible();
  await task.locator(".page-nav__back").click();
  await expect(page.locator('[data-page="schedule"]')).toBeVisible();

  // 合法 source 刷新保留（来源随 URL，不依赖内存）。
  await page.goto(`/#/task?assignmentId=${world.assignmentId}&source=home`);
  await expect(task).toBeVisible();
  await page.reload();
  await expect(task).toBeVisible();
  await task.locator(".page-nav__back").click();
  await expect(page.locator('[data-page="home"]')).toBeVisible();
});

test("profile -> privacy/location and help both return to Profile", async ({ page, context }) => {
  await grantStoreLocation(context);
  await plantSession(page, context);
  await page.goto("/#/profile");
  await expect(page.locator('[data-page="profile"]')).toBeVisible();
  // 隐私与定位：携带来源进入，顶部返回键回 Profile。
  await page.locator('[data-page="profile"] .list-row', { hasText: "隐私与定位" }).click();
  const location = page.locator('[data-page="location"]');
  await expect(location).toHaveAttribute("data-source", "profile");
  await location.locator(".page-nav__back").click();
  await expect(page.locator('[data-page="profile"]')).toBeVisible();
  // 再次进入，定位成功后走完成按钮（返回我的，文案与去向一致）。
  await page.locator('[data-page="profile"] .list-row', { hasText: "隐私与定位" }).click();
  await expect(page.locator('[data-page="location"]')).toHaveAttribute("data-source", "profile");
  await page.getByRole("button", { name: "允许获取位置" }).click();
  const backToProfile = page.getByRole("button", { name: "返回我的" });
  await expect(backToProfile).toBeVisible({ timeout: 15_000 });
  await backToProfile.click();
  await expect(page.locator('[data-page="profile"]')).toBeVisible();
  // 填写帮助：返回我的。
  await page.locator('[data-page="profile"] .list-row', { hasText: "填写帮助" }).click();
  await expect(page.locator('[data-page="help"]')).toBeVisible();
  await page.locator('[data-page="help"] .page-nav__back').click();
  await expect(page.locator('[data-page="profile"]')).toBeVisible();
  // 同文档来源切换（profile → 默认）：组件重读 query，完成去向变为首页。
  await page.goto("/#/location");
  const locationPlain = page.locator('[data-page="location"]');
  await expect(locationPlain).toHaveAttribute("data-source", "");
  await page.getByRole("button", { name: "允许获取位置" }).click();
  const enterHome = page.getByRole("button", { name: "进入首页" });
  await expect(enterHome).toBeVisible({ timeout: 15_000 });
  await enterHome.click();
  await expect(page.locator('[data-page="home"]')).toBeVisible();
});

test("browser Back/Forward and top-button roundtrip follow the task parent chain without bounce", async ({ page, context }) => {
  await plantSession(page, context);
  // 先落日程（应用内既有条目），再进首页：顶部返回后的浏览器后退有应用内去向可断言。
  await page.goto("/#/schedule");
  await expect(page.locator('[data-page="schedule"]')).toBeVisible();
  await page.goto("/#/home");
  await expect(page.locator('[data-page="home"]')).toBeVisible();
  // home → task → survey（压栈：任务保留为问卷父页）。
  await page.locator('[data-page="home"] .card').nth(1).click();
  const task = page.locator('[data-page="task"]');
  await expect(task).toBeVisible();
  await task.getByRole("button", { name: "继续填写" }).click();
  const survey = page.locator('[data-page="survey"]');
  await expect(survey).toBeVisible();
  // 浏览器后退：survey → task → home（任务条目不再被 replace 抹掉）。
  await page.goBack();
  await expect(task).toBeVisible();
  await page.goBack();
  await expect(page.locator('[data-page="home"]')).toBeVisible();
  // 浏览器前进：home → task → survey；再后退回 task。
  await page.goForward();
  await expect(task).toBeVisible();
  await page.goForward();
  await expect(survey).toBeVisible();
  await page.goBack();
  await expect(task).toBeVisible();
  // 顶部返回键（校验后退）：task → home 后浏览器后退回到日程（无任务 bounce 条目）。
  await task.locator(".page-nav__back").click();
  await expect(page.locator('[data-page="home"]')).toBeVisible();
  await page.goBack();
  await expect(page.locator('[data-page="schedule"]')).toBeVisible();
  // 刷新尊重来源：task?source=home 刷新后顶部返回仍回首页。
  await page.goto(`/#/task?assignmentId=${world.assignmentId}&source=home`);
  await expect(task).toBeVisible();
  await page.reload();
  await expect(task).toBeVisible();
  await task.locator(".page-nav__back").click();
  await expect(page.locator('[data-page="home"]')).toBeVisible();
});

test("full-document detour to /healthz and back to the same Help URL must not history.back outside the app", async ({ page, context }) => {
  await plantSession(page, context);
  await page.goto("/#/profile");
  await expect(page.locator('[data-page="profile"]')).toBeVisible();
  await page.locator('[data-page="profile"] .list-row', { hasText: "填写帮助" }).click();
  const help = page.locator('[data-page="help"]');
  await expect(help).toBeVisible();
  // 应用内浏览器后退/前进 + 重复进入同一帮助页：后退键仍回「我的」。
  await page.goBack();
  await expect(page.locator('[data-page="profile"]')).toBeVisible();
  await page.goForward();
  await expect(help).toBeVisible();
  await help.locator(".page-nav__back").click();
  await expect(page.locator('[data-page="profile"]')).toBeVisible();
  // 关键回归：整页离开应用（/healthz）再整页回到同一 #/help —— 相邻历史已变（healthz），
  // 顶部后退必须留在应用内（replace 到「我的」），绝不 history.back 到 /healthz。
  await page.locator('[data-page="profile"] .list-row', { hasText: "填写帮助" }).click();
  await expect(help).toBeVisible();
  await page.goto("/healthz");
  await expect(page.getByText("ok", { exact: true })).toBeVisible();
  await page.goto("/#/help");
  await expect(help).toBeVisible();
  await help.locator(".page-nav__back").click();
  await expect(page.locator('[data-page="profile"]')).toBeVisible();
  expect(page.url()).not.toContain("healthz");
  expect(await page.getByText("ok", { exact: true }).count()).toBe(0);
});

test("direct-entry other with source=home falls back through dishes/survey/task and lands on Home", async ({ page, context }) => {
  const session = await plantSession(page, context);
  const started = await api.post(`/api/assignments/${world.assignmentId}/start`, { headers: { authorization: `Bearer ${session.accessToken}` } });
  let attemptId = started.ok() ? (await started.json()).attempt.id : null;
  if (!attemptId) {
    const detail = await api.get(`/api/assignments/${world.assignmentId}`, { headers: { authorization: `Bearer ${session.accessToken}` } });
    attemptId = (await detail.json()).attempt?.id;
  }
  expect(attemptId).toBeTruthy();
  await page.goto("/healthz"); // 无关历史：整链兜底必须 replace，绝不 back 到这里
  await page.goto(`/#/other?assignmentId=${world.assignmentId}&attemptId=${attemptId}&questionnaireVersionId=${world.questionnaireVersionId}&revision=0&source=home`);
  const other = page.locator('[data-page="other"]');
  await expect(other).toBeVisible();
  await other.locator("textarea").first().fill("导航回归：其他记录闪光点");
  // 上一步：菜品（保存先行）→ 无父页 → replace 规范菜品页（携来源）。
  await other.getByRole("button", { name: "上一步：其他照片" }).click();
  const dishes = page.locator('[data-page="dishes"]');
  await expect(dishes).toBeVisible();
  expect(page.url()).toContain("&source=home");
  expect(new URLSearchParams(page.url().split("#/dishes?")[1]).get("attemptId")).toBe(attemptId);
  // 上一步：答题（保存先行）→ replace 规范问卷页（category=product + 来源）。
  await dishes.getByRole("button", { name: "上一步：答题" }).click();
  const survey = page.locator('[data-page="survey"]');
  await expect(survey).toBeVisible();
  expect(new URLSearchParams(page.url().split("#/survey?")[1]).get("source")).toBe("home");
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("产品品质");
  // 问卷 → 任务（source=home）→ 首页：完整兜底链来源不丢。
  await survey.locator(".page-nav__back").click();
  const task = page.locator('[data-page="task"]');
  await expect(task).toBeVisible();
  expect(page.url()).toContain("&source=home");
  await task.locator(".page-nav__back").click();
  await expect(page.locator('[data-page="home"]')).toBeVisible();
  expect(await page.getByText("ok", { exact: true }).count()).toBe(0);
});

test("multi-entry history.go(-2)/go(2) keeps true adjacency: survey/task top Back lands Home without bounce", async ({ page, context }) => {
  await plantSession(page, context);
  // 物理历史链：home → task(source=home) → survey（真实应用内压栈）。
  await page.goto("/#/home");
  await expect(page.locator('[data-page="home"]')).toBeVisible();
  await page.locator('[data-page="home"] .card').nth(1).click();
  const task = page.locator('[data-page="task"]');
  await expect(task).toBeVisible();
  await task.getByRole("button", { name: "继续填写" }).click();
  const survey = page.locator('[data-page="survey"]');
  await expect(survey).toBeVisible();
  // 跨条目多步跳转：go(-2) 回首页、go(2) 回问卷（forward 记录不得被丢弃）。
  await page.evaluate(() => history.go(-2));
  await expect(page.locator('[data-page="home"]')).toBeVisible();
  await page.evaluate(() => history.go(2));
  await expect(survey).toBeVisible();
  // 问卷顶部返回：相邻父页是同来源任务（不是 Home）→ 原生后退到任务。
  await survey.locator(".page-nav__back").click();
  await expect(task).toBeVisible();
  expect(page.url()).toContain("#/task?");
  expect(page.url()).toContain("&source=home");
  // 任务顶部返回：相邻父页是首页 → 原生后退到首页（无 bounce、不再重访任务/问卷）。
  await task.locator(".page-nav__back").click();
  await expect(page.locator('[data-page="home"]')).toBeVisible();
});

test("same-document task source/id transitions re-read query without reload", async ({ page, context }) => {
  await plantSession(page, context);
  // 同文档切换来源（hash 变化、无整页刷新）：任务组件必须重读 query。
  await page.goto(`/#/task?assignmentId=${world.assignmentId}&source=home`);
  await expect(page.locator('[data-page="task"]')).toBeVisible();
  await page.goto(`/#/task?assignmentId=${world.assignmentId}&source=schedule`);
  await expect(page.locator('[data-page="task"]')).toBeVisible();
  await page.locator('[data-page="task"] .page-nav__back').click();
  await expect(page.locator('[data-page="schedule"]')).toBeVisible();
  // 浏览器后退回到 source=home 的任务条目：返回键去向随之回到首页。
  await page.goBack();
  await expect(page.locator('[data-page="task"]')).toBeVisible();
  await page.locator('[data-page="task"] .page-nav__back').click();
  await expect(page.locator('[data-page="home"]')).toBeVisible();
  // 同文档切换任务 ID：加载错误卡（含来源按钮）证明组件按新参数重建。
  await page.goto("/#/task?assignmentId=not-a-real-id&source=home");
  const task = page.locator('[data-page="task"]');
  await expect(task).toContainText("暂时无法打开任务");
  await expect(task).toContainText("返回首页");
  await page.goto("/#/task?assignmentId=not-a-real-id&source=schedule");
  await expect(task).toContainText("返回日程");
  await task.getByRole("button", { name: "返回日程" }).click();
  await expect(page.locator('[data-page="schedule"]')).toBeVisible();
});

test("survey URL category stays in sync with live selection across issue roundtrip and reload", async ({ page, context }) => {
  await plantSession(page, context);
  const params = new URLSearchParams({ assignmentId: world.assignmentId, attemptId: world.attemptId, questionnaireVersionId: world.questionnaireVersionId, revision: "0", source: "home", category: "product" });
  // 直达带 category=product 的问卷 URL（真实直接进入场景，显式分类优先）。
  await page.goto(`/#/survey?${params.toString()}`);
  const survey = page.locator('[data-page="survey"]');
  await expect(survey).toBeVisible();
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("产品品质");
  // 点击「为客服务」：规范 URL 原位同步（replace，不加历史），组件不重挂载。
  await survey.locator(".filter-chips .chip", { hasText: "为客服务" }).click();
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("为客服务");
  expect(page.url()).toContain("category=service");
  expect(page.url()).not.toContain("category=product");
  // 不得分 → 问题页（URL 携 category=service）→ 取消 → 问卷落在为客服务（旧 product 参数不再回魂）。
  await survey.getByRole("button", { name: "不得分", exact: true }).click();
  const issue = page.locator('[data-page="issue"]');
  await expect(issue).toBeVisible();
  expect(page.url()).toContain("category=service");
  await issue.getByRole("button", { name: "取消", exact: true }).click();
  await expect(survey).toBeVisible();
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("为客服务");
  expect(new URLSearchParams(page.url().split("#/survey?")[1]).get("category")).toBe("service");
  // 刷新后仍为实际所选分类。
  await page.reload();
  await expect(survey).toBeVisible();
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("为客服务");
});

test("same-document category query change is consumed in-place; chip sync, issue roundtrip and refresh hold", async ({ page, context }) => {
  await plantSession(page, context);
  const base = { assignmentId: world.assignmentId, attemptId: world.attemptId, questionnaireVersionId: world.questionnaireVersionId, revision: "0", source: "home" };
  await page.goto(`/#/survey?${new URLSearchParams({ ...base, category: "service" }).toString()}`);
  const survey = page.locator('[data-page="survey"]');
  await expect(survey).toBeVisible();
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("为客服务");
  // 标记同文档（无整页刷新）。
  await page.evaluate(() => { window.__navSameDoc = "keep"; });
  // 同路径仅 category 变化（service → product）：不重载，活动分类就地跟随参数。
  await page.goto(`/#/survey?${new URLSearchParams({ ...base, category: "product" }).toString()}`);
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("产品品质");
  expect(await page.evaluate(() => window.__navSameDoc)).toBe("keep");
  const ids = new URLSearchParams(page.url().split("#/survey?")[1]);
  expect(ids.get("assignmentId")).toBe(world.assignmentId);
  expect(ids.get("attemptId")).toBe(world.attemptId);
  // 点选仍同步 URL（replace，不加历史）。
  await survey.locator(".filter-chips .chip", { hasText: "环境卫生" }).click();
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("环境卫生");
  expect(new URLSearchParams(page.url().split("#/survey?")[1]).get("category")).toBe("environment");
  // 问题页往返（取消）后仍在实际所选分类；业务 ID 不变。
  await survey.getByRole("button", { name: "不得分", exact: true }).click();
  const issue = page.locator('[data-page="issue"]');
  await expect(issue).toBeVisible();
  await issue.getByRole("button", { name: "取消", exact: true }).click();
  await expect(survey).toBeVisible();
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("环境卫生");
  const after = new URLSearchParams(page.url().split("#/survey?")[1]);
  expect(after.get("category")).toBe("environment");
  expect(after.get("assignmentId")).toBe(world.assignmentId);
  // 刷新保持；草稿/作答进度不受影响（三题完成度不变）。
  await page.reload();
  await expect(survey).toBeVisible();
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("环境卫生");
  await expect(survey).toContainText("已完成 3 / 3 题");
});
