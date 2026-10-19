// H5 本地全流程浏览器回归：问题页往返后的问卷滚动/分类/展开恢复（真实 API + 真实 junde_test）。
//
// 背景：问卷与问题页在 App 中互斥挂载（survey ⇄ issue），保存确认/取消/浏览器后退都会
// 重挂载 SurveyPage——此前滚动位置与题干展开态全部丢失、落回页顶。本回归以真实几何断言
// 钉定：从长问卷深处进入问题页（确认/取消/原生后退三种返回路径），返回后锚点题卡恢复到
// 离开时的视口偏移（±容差），当前分类与展开态保持；且恢复恰好一次——其后的作答、分类
// 切换、整页重进不再被旧锚点劫持。
// 每个用例独立种子（beforeEach 重建世界）；证据截图输出到仓库外
// /private/tmp/junde-survey-scroll-20261018/evidence。只允许 junde_test（shared 保险丝）。
import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import pg from "pg";
import { createPasswordService } from "../../../apps/api/src/auth/passwords.js";
import { encrypt, hmac, normalizePhone } from "../../../apps/api/src/auth/crypto.js";
import { uuidv7 } from "../../../apps/api/src/ids.js";
import { seedRbac } from "../../../db/seeds/rbac.mjs";
import {
  H5_TEST_AUTH_KEY, H5_TEST_PHONE_KEY,
  INSPECTOR_PASSWORD, INSPECTOR_USERNAME, testDatabaseUrl,
} from "./shared.mjs";

const EVIDENCE_DIR = "/private/tmp/junde-survey-scroll-20261018/evidence";
mkdirSync(EVIDENCE_DIR, { recursive: true });
testDatabaseUrl();

const config = {
  AUTH_TOKEN_HMAC_KEY: H5_TEST_AUTH_KEY,
  PHONE_ENCRYPTION_KEY_BASE64: H5_TEST_PHONE_KEY,
};

// 锚点恢复是「近似还原」：按题卡元素相对定位，容差覆盖亚像素取整与字体度量抖动。
const TOLERANCE_PX = 24;
// 锚点题（environment 第 8 题）停在视口顶部以下 160px 处再离开。
const ANCHOR_VIEWPORT_OFFSET = 160;
// 展开文本长度以「确认按钮完整落在视口内」为界：过长会触发 Playwright 点击自动滚动，
// 破坏受控的离开偏移（题目过短则整页不足一屏，无恢复意义）。
const longText = (n) => `这是第${n}题的环境类长题干，专门用于滚动位置恢复回归，内容足够长以撑开题卡。`.repeat(10);

let pool;
let world;
let api;

// 长问卷：environment 8 题（第 8 题为锚点，页面纵向远超一屏）+ service/product 各 1 题
// （分类保持断言的切换落点）。
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
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-SCROLL','滚动回归门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, inspectorId]);
  const templateId = uuidv7(); const versionId = uuidv7();
  const envIds = Array.from({ length: 8 }, () => uuidv7());
  const serviceId = uuidv7(); const productId = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'滚动回归问卷','secret',$2)", [templateId, inspectorId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_by,published_at) VALUES ($1,$2,1,'published',$3,$3,now())", [versionId, templateId, inspectorId]);
  const questionRows = [];
  const evidenceRows = [];
  envIds.forEach((id, index) => {
    questionRows.push(`('${id}','${versionId}','env-${index + 1}',${index + 1},'environment','${longText(index + 1)}',2,true,false,${index + 1})`);
    evidenceRows.push(`('${id}',false,false,false,0,0,4,10)`);
  });
  questionRows.push(`('${serviceId}','${versionId}','svc-1',9,'service','服务普通题',5,true,false,9)`);
  questionRows.push(`('${productId}','${versionId}','prd-1',10,'product','产品零分题',0,true,false,10)`);
  evidenceRows.push(`('${serviceId}',false,false,false,0,0,4,10)`);
  evidenceRows.push(`('${productId}',false,false,false,0,0,4,10)`);
  await pool.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,is_score_wipe,sort_order) VALUES ${questionRows.join(",")}`);
  await pool.query(`INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count,image_max_count,audio_max_duration_seconds) VALUES ${evidenceRows.join(",")}`);
  const campaignId = uuidv7(); const assignmentId = uuidv7();
  const startsAt = new Date(Date.now() - 60_000); const dueAt = new Date(Date.now() + 3_600_000);
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,'C-SCROLL','滚动回归任务',$2,$3,$4,$5,'published',$6)", [campaignId, storeId, startsAt, dueAt, new Date(Date.now() + 7_200_000), inspectorId]);
  await pool.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,receipt_required,status,created_by)
    VALUES ($1,'A-SCROLL',$2,$3,$4,'secret',$5,$6,0,false,'assigned',$7)`, [assignmentId, campaignId, inspectorId, versionId, startsAt, dueAt, inspectorId]);
  return { inspectorId, anchorQuestionId: envIds[7], scoredQuestionId: envIds[6], assignmentId, questionnaireVersionId: versionId };
}

test.beforeAll(async ({ playwright }) => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
  await pool.query("SELECT 1 FROM users LIMIT 1");
  api = await playwright.request.newContext({ baseURL: "http://127.0.0.1:5199" });
});

test.afterAll(async () => {
  await api?.dispose();
  await pool?.end();
});

test.beforeEach(async () => {
  await pool.query(`TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users, questionnaire_templates, questionnaire_versions, questions, question_evidence_requirements, regions, stores, audit_campaigns, audit_assignments, survey_attempts, question_evidence_attachments, question_answer_edit_sessions, question_answer_edit_session_removals, receipt_attachments, receipt_ocr_jobs, receipt_ocr_job_attachments, receipt_ocr_candidates, receipt_ocr_applications, export_jobs, object_cleanup_jobs, submission_versions, submission_question_scores, audit_logs, idempotency_keys, dish_records, other_records, other_record_highlights, other_record_highlight_photos, audit_checkins, checkin_exemptions RESTART IDENTITY CASCADE`);
  await seedRbac(pool);
  await pool.query(`INSERT INTO question_categories (id,code,name,sort_order) VALUES
    (gen_random_uuid(),'environment','环境卫生',1),(gen_random_uuid(),'service','为客服务',2),(gen_random_uuid(),'product','产品品质',3)
    ON CONFLICT (code) DO NOTHING`);
  world = await seedWorld();
  const login = await api.post("/api/auth/login", { data: { username: INSPECTOR_USERNAME, password: INSPECTOR_PASSWORD } });
  expect(login.ok(), await login.text()).toBeTruthy();
  const { accessToken } = await login.json();
  world.accessToken = accessToken;
  const checkin = await api.post(`/api/assignments/${world.assignmentId}/check-in`, { headers: { authorization: `Bearer ${accessToken}` }, data: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
  expect(checkin.ok(), await checkin.text()).toBeTruthy();
  const started = await api.post(`/api/assignments/${world.assignmentId}/start`, { headers: { authorization: `Bearer ${accessToken}` } });
  expect(started.ok(), await started.text()).toBeTruthy();
  world.attemptId = (await started.json()).attempt.id;
});

async function plantSession(page) {
  const inspectorLogin = await page.context().request.post("/api/auth/login", { data: { username: INSPECTOR_USERNAME, password: INSPECTOR_PASSWORD } });
  const session = await inspectorLogin.json();
  await page.addInitScript(([key, value]) => { window.localStorage.setItem(key, value); }, ["junde:session", JSON.stringify(session)]);
  return session;
}

const surveyUrl = () => `/#/survey?assignmentId=${world.assignmentId}&attemptId=${world.attemptId}&questionnaireVersionId=${world.questionnaireVersionId}&revision=0&source=home`;
const anchorCard = (page) => page.locator(`[data-question-id="${world.anchorQuestionId}"]`);

// 任意题 API 作答 unscored（编辑会话：create → patch 说明 → confirm），供改分路径用例预置。
async function answerUnscoredViaApi(questionId, remark = "预置的不得分说明") {
  const headers = { authorization: `Bearer ${world.accessToken}` };
  const draft = await (await api.get(`/api/questionnaires/secret/drafts/${world.attemptId}`, { headers })).json();
  const session = await (await api.post(`/api/questionnaires/secret/drafts/${world.attemptId}/questions/${questionId}/edit-sessions`, { headers, data: { baseAnswerRevision: 0, targetAnswer: "unscored" } })).json();
  expect(session.id, JSON.stringify(session)).toBeTruthy();
  const patched = await api.patch(`/api/questionnaires/secret/drafts/${world.attemptId}/questions/${questionId}/edit-sessions/${session.id}`, { headers, data: { draftIssueRemark: remark, revision: draft.attempt.revision } });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  const confirmed = await api.post(`/api/questionnaires/secret/drafts/${world.attemptId}/questions/${questionId}/edit-sessions/${session.id}/confirm`, { headers, data: { answer: "unscored", revision: draft.attempt.revision } });
  expect(confirmed.ok(), await confirmed.text()).toBeTruthy();
}

// 打开问卷 → 展开锚点题干 → 滚动到深处（锚点停视口 160px）→ 记录离开前几何与展开态。
async function openSurveyDeepAtAnchor(page) {
  await plantSession(page);
  await page.goto(surveyUrl());
  const survey = page.locator('[data-page="survey"]');
  await expect(survey).toHaveAttribute("data-state", "ready");
  const card = anchorCard(page);
  await expect(card).toBeVisible();
  // 展开锚点题干（长文本从 3 行钳制变为全量，恢复时必须同样保持展开）
  await card.getByRole("button", { name: "查看全部" }).click();
  await expect(card.getByRole("button", { name: "收起", exact: true })).toBeVisible();
  // 滚动到深处：锚点题卡停在视口顶部以下 160px（整页纵向远超一屏）
  await card.evaluate((el) => { window.scrollTo(0, 0); });
  const anchorTopInDoc = await card.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  await page.evaluate((top) => { window.scrollTo(0, top); }, anchorTopInDoc - ANCHOR_VIEWPORT_OFFSET);
  const before = await card.evaluate((el) => ({
    top: Math.round(el.getBoundingClientRect().top),
    scrollY: Math.round(window.scrollY),
  }));
  expect(before.scrollY).toBeGreaterThan(400, "锚点必须处于深滚动位置（整页可滚动才有恢复意义）");
  // 受控前提：确认按钮必须完整在视口内，否则点击自动滚动会破坏受控偏移（测试自身护栏）。
  const issueButton = await card.getByRole("button", { name: "不得分", exact: true }).boundingBox();
  expect(issueButton).toBeTruthy();
  expect(issueButton.y + issueButton.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
  return { survey, before };
}

// 进入问题页（默认 unscored），可选填写说明。
async function enterIssue(page, { remark = "滚动回归：现场发现的问题说明" } = {}) {
  await anchorCard(page).getByRole("button", { name: "不得分", exact: true }).click();
  const issue = page.locator('[data-page="issue"]');
  await expect(issue).toHaveAttribute("data-state", "ready");
  if (remark) await issue.locator("textarea").fill(remark);
  return issue;
}

// 断言返回后的恢复：锚点题卡回到离开时视口偏移（±容差）、深滚动保持、分类与展开态不变。
// tolerance 可放宽的场合：改分路径确认后锚点卡的「不得分」摘要行被移除（约 28px），页面
// 最大滚动随之收缩——浏览器物理上滚不到更深的位置，属底部钳制而非恢复失准。
async function expectRestored(page, survey, before, label, tolerance = TOLERANCE_PX) {
  await expect(survey).toHaveAttribute("data-state", "ready");
  const card = anchorCard(page);
  // 恢复在列表就绪后的 effect 中应用：以轮询等待几何到位（隐式覆盖异步加载时序）。
  await expect.poll(async () => {
    const geo = await card.evaluate((el) => Math.round(el.getBoundingClientRect().top)).catch(() => Number.NaN);
    return Number.isFinite(geo) ? Math.abs(geo - before.top) : Number.POSITIVE_INFINITY;
  }, { timeout: 5_000, message: `${label}: 锚点题卡未恢复到离开时视口偏移` }).toBeLessThanOrEqual(tolerance);
  const scrollY = await page.evaluate(() => Math.round(window.scrollY));
  expect(scrollY, `${label}: 恢复必须落在深滚动位置`).toBeGreaterThan(400);
  // 分类保持：当前选中分类仍是环境卫生
  await expect(survey.locator(".filter-chips .chip--active")).toHaveText("环境卫生");
  // 展开态保持：锚点题干为全量（收起），其余题干仍为钳制（查看全部）
  await expect(card.getByRole("button", { name: "收起", exact: true })).toBeVisible();
  await expect(page.locator(`[data-question-id="${world.scoredQuestionId}"]`).getByRole("button", { name: "查看全部" })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE_DIR}/${label}.png`, fullPage: false });
  return scrollY;
}

test.describe("问题页往返滚动恢复（手机视口 420×860）", () => {
  test("确认返回：恢复同一题、视口偏移、分类与展开态", async ({ page }) => {
    const { survey, before } = await openSurveyDeepAtAnchor(page);
    await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-before-leave.png`, fullPage: false });
    await enterIssue(page);
    await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-issue.png`, fullPage: false });
    await page.getByRole("button", { name: "确认", exact: true }).click();
    await expectRestored(page, survey, before, "mobile-after-confirm");
  });

  test("取消返回：同样恢复位置、分类与展开态", async ({ page }) => {
    const { survey, before } = await openSurveyDeepAtAnchor(page);
    await enterIssue(page, { remark: "" });
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expectRestored(page, survey, before, "mobile-after-cancel");
  });

  test("浏览器原生后退：同样恢复位置、分类与展开态", async ({ page }) => {
    const { survey, before } = await openSurveyDeepAtAnchor(page);
    await enterIssue(page);
    await page.goBack();
    await expectRestored(page, survey, before, "mobile-after-browser-back");
  });

  test("不得分改得分路径：同样恢复位置、分类与展开态", async ({ page }) => {
    // 预置锚点题已 unscored：按钮「得分」改走编辑会话（target=scored 的确认卡），
    // 与 unscored 直通共用 openIssue 捕获，但往返语义独立成例钉定。
    await answerUnscoredViaApi(world.anchorQuestionId);
    const { survey, before } = await openSurveyDeepAtAnchor(page);
    await anchorCard(page).getByRole("button", { name: "得分", exact: true }).click();
    const issue = page.locator('[data-page="issue"]');
    await expect(issue).toHaveAttribute("data-state", "ready");
    await expect(issue).toHaveAttribute("data-target", "scored");
    await expect(issue).toContainText("改为得分？");
    await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-issue-scored.png`, fullPage: false });
    await page.getByRole("button", { name: "确认", exact: true }).click();
    // 容差放宽至一个摘要行高：见 expectRestored 注释（页面因摘要行移除而变短，底部钳制）。
    await expectRestored(page, survey, before, "mobile-after-rescore", 40);
  });

  test("恢复恰好一次：其后的作答、分类切换、整页重进不再被旧锚点劫持", async ({ page }) => {
    const { survey, before } = await openSurveyDeepAtAnchor(page);
    await enterIssue(page);
    await page.getByRole("button", { name: "确认", exact: true }).click();
    const restoredScrollY = await expectRestored(page, survey, before, "mobile-exactly-once");

    // a) 作答不再触发二次跳转：dispatchEvent 避免点击的自动滚动，锚点上方题「得分」保存后位置不动。
    await page.locator(`[data-question-id="${world.scoredQuestionId}"]`).getByRole("button", { name: "得分", exact: true }).dispatchEvent("click");
    await expect(survey).toContainText("已保存");
    const afterAnswer = await page.evaluate(() => Math.round(window.scrollY));
    expect(Math.abs(afterAnswer - restoredScrollY)).toBeLessThanOrEqual(3, "作答保存不得改变恢复后的位置");

    // b) 分类切换→切回：内容缩短/重建属于用户自主导航，不得被旧锚点拉回深处。
    await survey.locator(".filter-chips .chip", { hasText: "为客服务" }).click();
    await expect(page.locator(`[data-question-id="${world.anchorQuestionId}"]`)).toHaveCount(0);
    await survey.locator(".filter-chips .chip", { hasText: "环境卫生" }).click();
    await expect(anchorCard(page)).toBeVisible();
    const afterSwitchBack = await page.evaluate(() => Math.round(window.scrollY));
    expect(afterSwitchBack).toBeLessThan(80, "分类往返后必须停留在顶部，不得重放旧恢复");

    // c) 整页刷新（真实文档重载）：旧锚点已消费（读后即清），展开态与位置必须从头开始。
    await page.reload();
    await expect(survey).toHaveAttribute("data-state", "ready");
    await expect(anchorCard(page)).toBeVisible();
    const reloadedScrollY = await page.evaluate(() => Math.round(window.scrollY));
    expect(reloadedScrollY).toBeLessThan(80, "刷新后不得重放旧滚动位置");
    await expect(anchorCard(page).getByRole("button", { name: "查看全部" })).toBeVisible();
  });
});

test.describe("问题页往返滚动恢复（桌面视口 1280×800）", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("确认返回：桌面窗口同样恢复同一题与视口偏移", async ({ page }) => {
    const { survey, before } = await openSurveyDeepAtAnchor(page);
    await enterIssue(page);
    await page.getByRole("button", { name: "确认", exact: true }).click();
    await expectRestored(page, survey, before, "desktop-after-confirm");
  });
});
