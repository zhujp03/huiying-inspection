// H5 本地全流程浏览器回归（2026-10 问卷 UX 六项变更，真实 API + 真实 junde_test + 真实本地磁盘文件）：
//   1) 第二步骤命名：下一步/流程条/页面标题均为「其他照片」；
//   2) 计分选择按钮：初始未选=白底橙红字+橙红边，选中=橙红底白字（含清零 是/否），以真实作答状态渲染；
//   3) 不得分照片选填且全题可见（无必填星）；无照片+说明可确认；真实签名直传；
//   4) 闪光点编辑器在第二步：默认一条空白、可加两条、跨导航/整页刷新保留；
//   5) 提交确认弹窗为应用内 ConfirmModal（含「问卷提交后无法再次修改」+ 当前得分百分比）；
//      取消保留编辑；预览得分（含分类清零）与提交落库权威得分一致；
//   6) 零闪光点/零建议可提交（第三步不再有闪光点必填拦截）；失败路径不虚构 100%。
// 每个用例独立种子（beforeEach 重建世界）：worker 在用例失败后重启会重跑 beforeAll，
// 共享种子会被重置——因此不允许跨用例依赖，任何用例都从全新任务开始。
// 证据截图输出到仓库外 /private/tmp/junde-survey-ux-20261017/evidence（手机+桌面视口）。
// 只允许 junde_test（shared.testDatabaseUrl 保险丝）。
import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import pg from "pg";
import { createPasswordService } from "../../../apps/api/src/auth/passwords.js";
import { encrypt, hmac, normalizePhone } from "../../../apps/api/src/auth/crypto.js";
import { uuidv7 } from "../../../apps/api/src/ids.js";
import { seedRbac } from "../../../db/seeds/rbac.mjs";
import {
  H5_TEST_AUTH_KEY, H5_TEST_PHONE_KEY,
  INSPECTOR_PASSWORD, INSPECTOR_USERNAME, testDatabaseUrl,
} from "./shared.mjs";

const EVIDENCE_DIR = "/private/tmp/junde-survey-ux-20261017/evidence";
mkdirSync(EVIDENCE_DIR, { recursive: true });

testDatabaseUrl();

// 真实可解码 PNG（2x2 灰度，像素字节=fill）：浏览器 img 能真正加载渲染（naturalWidth>0），
// 且不同 fill 生成不同内容字节（服务端按内容 sha256 去重，重复内容会被明确拒绝）。
const PNG_CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBytes = Buffer.alloc(4);
  crcBytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, crcBytes]);
};
const buildPng = (fill) => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); // width
  ihdr.writeUInt32BE(2, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.from([0, fill, fill, 0, (fill + 1) & 0xff, (fill + 1) & 0xff]); // 每行 filter 0 + 2 像素
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
};
const PNG_BYTES = buildPng(0x2a);
const config = {
  NODE_ENV: "test",
  AUTH_TOKEN_HMAC_KEY: H5_TEST_AUTH_KEY,
  PHONE_ENCRYPTION_KEY_BASE64: H5_TEST_PHONE_KEY,
};

let pool;
let world;
let api;

// 问卷四题：环境清零题(2) + 环境普通题(3) + 服务普通题(5) + 产品零分题（菜品页回跳固定
// category=product 的合法落点，且排在最后使「下一步」按钮可见）；清零题带历史强制照片
// 配置（本回归验证其已选填）。清零后总分 = 服务 5/10 = 50%（产品题 0 分不影响对账）。
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
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-UX','UX回归门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, inspectorId]);
  const templateId = uuidv7(); const versionId = uuidv7(); const q1 = uuidv7(); const q2 = uuidv7(); const q3 = uuidv7(); const q4 = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'UX回归问卷','secret',$2)", [templateId, inspectorId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_by,published_at) VALUES ($1,$2,1,'published',$3,$3,now())", [versionId, templateId, inspectorId]);
  await pool.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,is_score_wipe,sort_order) VALUES
    ($1,$2,'q1',1,'environment','清零题',2,true,true,1),($3,$2,'q2',2,'environment','环境普通题',3,true,false,2),
    ($4,$2,'q3',3,'service','服务普通题',5,true,false,3),($5,$2,'q4',4,'product','产品零分题',0,true,false,4)`,
    [q1, versionId, q2, q3, q4]);
  await pool.query(`INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count,image_max_count,audio_max_duration_seconds)
    VALUES ($1,true,true,false,1,0,4,10),($2,false,false,false,0,0,4,10),($3,false,false,false,0,0,4,10),($4,false,false,false,0,0,4,10)`, [q1, q2, q3, q4]);
  const campaignId = uuidv7(); const assignmentId = uuidv7();
  const startsAt = new Date(Date.now() - 60_000); const dueAt = new Date(Date.now() + 3_600_000);
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,'C-UX','UX回归任务',$2,$3,$4,$5,'published',$6)", [campaignId, storeId, startsAt, dueAt, new Date(Date.now() + 7_200_000), inspectorId]);
  await pool.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,receipt_required,status,created_by)
    VALUES ($1,'A-UX',$2,$3,$4,'secret',$5,$6,0,false,'assigned',$7)`, [assignmentId, campaignId, inspectorId, versionId, startsAt, dueAt, inspectorId]);
  return { inspectorId, q1, q2, q3, q4, assignmentId, questionnaireVersionId: versionId };
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

// 每个用例全新世界（TRUNCATE + 种子 + 登录 + 打卡 + 开卷）：不依赖前序用例，
// 也不怕 worker 重启重跑 hook。
test.beforeEach(async () => {
  await pool.query(`TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users, questionnaire_templates, questionnaire_versions, questions, question_evidence_requirements, regions, stores, audit_campaigns, audit_assignments, survey_attempts, question_evidence_attachments, question_answer_edit_sessions, question_answer_edit_session_removals, receipt_attachments, receipt_ocr_jobs, receipt_ocr_job_attachments, receipt_ocr_candidates, receipt_ocr_applications, export_jobs, object_cleanup_jobs, submission_versions, submission_question_scores, audit_logs, idempotency_keys, dish_records, other_records, other_record_highlights, other_record_highlight_photos, audit_checkins, checkin_exemptions RESTART IDENTITY CASCADE`);
  await seedRbac(pool);
  // 评估分类基线自足：其他套件会 TRUNCATE question_categories 并只回种部分行，
  // 这里按 migration 0025 的规范集合补齐（ON CONFLICT 幂等，绝不改动既有行）。
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

async function plantSession(page, context) {
  const inspectorLogin = await context.request.post("/api/auth/login", { data: { username: INSPECTOR_USERNAME, password: INSPECTOR_PASSWORD } });
  const session = await inspectorLogin.json();
  await page.addInitScript(([key, value]) => { window.localStorage.setItem(key, value); }, ["junde:session", JSON.stringify(session)]);
  return session;
}

const surveyUrl = () => `/#/survey?assignmentId=${world.assignmentId}&attemptId=${world.attemptId}&questionnaireVersionId=${world.questionnaireVersionId}&revision=0&source=home`;
const dishesUrl = () => `/#/dishes?assignmentId=${world.assignmentId}&attemptId=${world.attemptId}&questionnaireVersionId=${world.questionnaireVersionId}&revision=0&source=home`;
const otherUrl = () => `/#/other?assignmentId=${world.assignmentId}&attemptId=${world.attemptId}&questionnaireVersionId=${world.questionnaireVersionId}&revision=0&source=home`;

// 控制台错误收集：pageErrors=未捕获异常（任何用例都必须为空）；consoleErrors 含资源加载
// 噪声（blob 失效/预览过期等浏览器网络日志），断言按「过滤资源加载」口径。
function trackConsoleErrors(page, bucket) {
  bucket.pageErrors = [];
  bucket.consoleErrors = [];
  page.on("pageerror", (error) => bucket.pageErrors.push(String(error?.message || error)));
  page.on("console", (message) => { if (message.type() === "error") bucket.consoleErrors.push(message.text()); });
}
const resourceNoise = (texts) => texts.filter((text) => !/Failed to load resource|net::|ERR_/i.test(text));

// API 补答剩余题（逐题以最新 revision 保存），供 dishes/other 用例越过 R40 全题守卫。
async function answerRemaining(questions) {
  let revision = (await (await api.get(`/api/questionnaires/secret/drafts/${world.attemptId}`, { headers: { authorization: `Bearer ${world.accessToken}` } })).json()).attempt.revision;
  for (const questionId of questions) {
    const saved = await api.put(`/api/questionnaires/secret/drafts/${world.attemptId}/answers/${questionId}`, { headers: { authorization: `Bearer ${world.accessToken}` }, data: { answer: "scored", revision } });
    expect(saved.ok(), await saved.text()).toBeTruthy();
    revision = (await saved.json()).revision;
  }
}

// 任意题 API 作答 unscored（编辑会话：create → patch 说明 → confirm；无照片，验证服务端选填）。
async function answerUnscored(questionId, remark = "API 途中的不得分说明") {
  const headers = { authorization: `Bearer ${world.accessToken}` };
  let revision = (await (await api.get(`/api/questionnaires/secret/drafts/${world.attemptId}`, { headers })).json()).attempt.revision;
  const session = await (await api.post(`/api/questionnaires/secret/drafts/${world.attemptId}/questions/${questionId}/edit-sessions`, { headers, data: { baseAnswerRevision: 0, targetAnswer: "unscored" } })).json();
  expect(session.id, JSON.stringify(session)).toBeTruthy();
  const patched = await api.patch(`/api/questionnaires/secret/drafts/${world.attemptId}/questions/${questionId}/edit-sessions/${session.id}`, { headers, data: { draftIssueRemark: remark, revision } });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  // PATCH 只写会话草稿、不推进 attempt revision：confirm 复用同一 revision。
  const confirmed = await api.post(`/api/questionnaires/secret/drafts/${world.attemptId}/questions/${questionId}/edit-sessions/${session.id}/confirm`, { headers, data: { answer: "unscored", revision } });
  expect(confirmed.ok(), await confirmed.text()).toBeTruthy();
}
const answerQ1Unscored = () => answerUnscored(world.q1);

const PRIMARY = "rgb(242, 95, 66)";

test.describe("survey UX 2026-10（手机视口）", () => {
  let errors;

  test.beforeEach(() => { errors = {}; });

  test("步骤命名为其他照片；计分按钮未选白底橙红、选中橙红白底（真实作答状态）", async ({ page }) => {
    trackConsoleErrors(page, errors);
    await plantSession(page, page.context());
    await page.goto(surveyUrl());
    const survey = page.locator('[data-page="survey"]');
    await expect(survey).toHaveAttribute("data-state", "ready");
    // 步骤条第二步=其他照片；下一步按钮=其他照片
    await expect(survey.locator(".flow-steps")).toContainText("其他照片");
    const environment = (await (await api.get(`/api/assignments/${world.assignmentId}/questionnaire`, { headers: { authorization: `Bearer ${world.accessToken}` } })).json()).categories.find((category) => category.id === "environment");
    await survey.locator(".filter-chips .chip", { hasText: environment.label }).click();
    const q1 = survey.locator(".card", { hasText: "清零题" }).first();
    const noButton = q1.getByRole("button", { name: "否", exact: true });
    // 未选：白底 + 橙红字 + 橙红边
    await expect(noButton).toHaveAttribute("data-answer-state", "unselected");
    await expect(noButton).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(noButton).toHaveCSS("color", PRIMARY);
    await expect(noButton).toHaveCSS("border-top-color", PRIMARY);
    await expect(noButton).toHaveAttribute("aria-pressed", "false");
    await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-survey-neutral.png`, fullPage: true });
    // 点「是」（清零）：window.confirm 二次确认后进不得分编辑器（该确认保留既有交互）
    page.once("dialog", (dialog) => dialog.accept());
    await q1.getByRole("button", { name: "是", exact: true }).click();
    const issue = page.locator('[data-page="issue"]');
    await expect(issue).toBeVisible();
    // 问题照片：全题可见、选填（无必填星）；说明保留必填星
    await expect(issue).toContainText("问题照片（选填）");
    expect(await issue.locator(".required").count()).toBe(1);
    // 可选照片：真实上传一张（本地磁盘签名直传），随后带说明确认
    await issue.locator("textarea").fill("UX回归：清零题说明");
    await page.setInputFiles('input[type="file"]', { name: "ux-evidence.png", mimeType: "image/png", buffer: PNG_BYTES });
    await expect(issue).toContainText("上传成功");
    await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-issue-optional-photo.png`, fullPage: true });
    await issue.getByRole("button", { name: "确认", exact: true }).click();
    await expect(survey).toBeVisible();
    // 选中态：橙红底白字（清零题「是」= unscored）
    const yesButton = survey.locator(".card", { hasText: "清零题" }).first().getByRole("button", { name: "是", exact: true });
    await expect(yesButton).toHaveAttribute("data-answer-state", "selected");
    await expect(yesButton).toHaveCSS("background-color", PRIMARY);
    await expect(yesButton).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(yesButton).toHaveAttribute("aria-pressed", "true");
    // 未选的另一题保持白底橙红
    const q2No = survey.locator(".card", { hasText: "环境普通题" }).first().getByRole("button", { name: "不得分", exact: true });
    await expect(q2No).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(q2No).toHaveCSS("color", PRIMARY);
    await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-survey-selected.png`, fullPage: true });
    expect(errors.pageErrors).toEqual([]);
    expect(resourceNoise(errors.consoleErrors)).toEqual([]);
  });

  test("第二步：闪光点两条（文字+照片直传），导航与整页刷新均保留；菜品区块隐藏", async ({ page }) => {
    trackConsoleErrors(page, errors);
    await plantSession(page, page.context());
    await answerQ1Unscored();
    await answerRemaining([world.q2, world.q3, world.q4]);
    await page.goto(dishesUrl());
    const dishes = page.locator('[data-page="dishes"]');
    await expect(dishes).toHaveAttribute("data-state", "ready");
    // 标题与步骤命名
    await expect(dishes.locator(".page-nav__title")).toHaveText("其他照片");
    await expect(dishes.locator(".flow-steps")).toContainText("其他照片");
    // 菜品区块隐藏（开关默认关），消费小票与闪光点区可见
    await expect(dishes).toHaveAttribute("data-dish-records", "disabled");
    await expect(dishes.locator(".dish-list")).toHaveCount(0);
    await expect(dishes.locator(".receipt-section")).toBeVisible();
    await expect(dishes.locator(".highlight-section")).toBeVisible();
    // 默认一条空白编辑器
    await expect(dishes.locator(".highlight-item")).toHaveCount(1);
    // 添加第二条并填文字；第一条附一张真实照片（保存落库 → init → 直传 → complete）
    const entries = dishes.locator(".highlight-item");
    await entries.first().locator("textarea").fill("UX回归闪光点一：上菜很快");
    await dishes.getByRole("button", { name: "+ 添加一条闪光点" }).click();
    await expect(entries).toHaveCount(2);
    await entries.nth(1).locator("textarea").fill("UX回归闪光点二：环境整洁");
    await entries.first().getByRole("button", { name: "为闪光点 1 添加照片" }).click();
    await dishes.locator('.highlight-section input[type="file"]').setInputFiles({ name: "highlight.png", mimeType: "image/png", buffer: PNG_BYTES });
    // 等上传链（init→直传→complete）真正完成：服务端签名 URL 的图出现且真实加载
    //（naturalWidth>0，签名 URL 403/404 会在此暴露）、待传 blob 图消失。
    await expect(entries.first().locator('.highlight-tile img:not([src^="blob"])')).toHaveCount(1);
    await expect(entries.first().locator('.highlight-tile img[src^="blob"]')).toHaveCount(0);
    await expect.poll(async () => entries.first().locator('.highlight-tile img:not([src^="blob"])').first().evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
    // 真实多文件同批直传（串行链路各走完整 init→直传→complete）→ 共 3 张就绪
    await entries.first().getByRole("button", { name: "为闪光点 1 添加照片" }).click();
    // 每张图内容唯一（同一条闪光点内服务端按内容 sha256 去重，重复内容会被明确拒绝）
    await dishes.locator('.highlight-section input[type="file"]').setInputFiles([
      { name: "highlight-b.png", mimeType: "image/png", buffer: buildPng(0x77) },
      { name: "highlight-c.png", mimeType: "image/png", buffer: buildPng(0x88) },
    ]);
    await expect(entries.first().locator('.highlight-tile img:not([src^="blob"])')).toHaveCount(3);
    await expect(entries.first().locator('.highlight-tile img[src^="blob"]')).toHaveCount(0);
    for (const tile of await entries.first().locator('.highlight-tile img:not([src^="blob"])').all()) {
      await expect.poll(async () => tile.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
    }
    // 几何断言：每个就绪预览是真实可见的方块（≥60×60px @420 视口），页面无横向溢出。
    const assertTileGeometry = async () => {
      for (const tile of await entries.first().locator(".highlight-tile").all()) {
        const box = await tile.boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(60);
        expect(box.height).toBeGreaterThanOrEqual(60);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
    };
    await assertTileGeometry();
    await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-highlights-two.png`, fullPage: true });
    // 删除一张服务端就绪照片（释放槽位）→ 再补传 1 张（delete/re-add 全链路）
    await entries.first().locator('.highlight-tile__remove[aria-label^="删除闪光点"]').first().click();
    await expect(entries.first().locator('.highlight-tile img:not([src^="blob"])')).toHaveCount(2);
    await entries.first().getByRole("button", { name: "为闪光点 1 添加照片" }).click();
    await dishes.locator('.highlight-section input[type="file"]').setInputFiles({ name: "highlight-d.png", mimeType: "image/png", buffer: buildPng(0x99) });
    await expect(entries.first().locator('.highlight-tile img:not([src^="blob"])')).toHaveCount(3);
    await expect(entries.first().locator('.highlight-tile img[src^="blob"]')).toHaveCount(0);
    for (const tile of await entries.first().locator('.highlight-tile img:not([src^="blob"])').all()) {
      await expect.poll(async () => tile.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
    }
    // 整页刷新后全部保留（已同步 → 服务端条目+照片重载）
    await page.reload();
    await expect(dishes).toHaveAttribute("data-state", "ready");
    await expect(dishes.locator(".highlight-item")).toHaveCount(2);
    await expect(dishes.locator(".highlight-item").first().locator("textarea")).toHaveValue("UX回归闪光点一：上菜很快");
    await expect(dishes.locator(".highlight-item").nth(1).locator("textarea")).toHaveValue("UX回归闪光点二：环境整洁");
    await expect(dishes.locator(".highlight-item").first().locator('.highlight-tile img:not([src^="blob"])')).toHaveCount(3);
    for (const tile of await dishes.locator(".highlight-item").first().locator('.highlight-tile img:not([src^="blob"])').all()) {
      await expect.poll(async () => tile.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
    }
    // 刷新后几何保持：预览方块仍 ≥60×60 且无横向溢出
    for (const tile of await dishes.locator(".highlight-item").first().locator(".highlight-tile").all()) {
      const box = await tile.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(60);
      expect(box.height).toBeGreaterThanOrEqual(60);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
    // 导航往返：上一步回问卷再进第二步仍在
    await dishes.getByRole("button", { name: "上一步：答题" }).click();
    const survey = page.locator('[data-page="survey"]');
    await expect(survey).toBeVisible();
    await survey.getByRole("button", { name: "下一步：其他照片" }).click();
    await expect(dishes.locator(".highlight-item")).toHaveCount(2);
    await expect(dishes.locator(".highlight-item").first().locator("textarea")).toHaveValue("UX回归闪光点一：上菜很快");
    expect(errors.pageErrors).toEqual([]);
    expect(resourceNoise(errors.consoleErrors)).toEqual([]);
  });

  test("照片 verify 失败→failed：重试走 init 复位与真实直传，最终服务端确认 ready", async ({ page }) => {
    trackConsoleErrors(page, errors);
    await plantSession(page, page.context());
    await answerQ1Unscored();
    await answerRemaining([world.q2, world.q3, world.q4]);
    await page.goto(dishesUrl());
    const dishes = page.locator('[data-page="dishes"]');
    await expect(dishes).toHaveAttribute("data-state", "ready");
    const entries = dishes.locator(".highlight-item");
    await entries.first().locator("textarea").fill("失败重试闪光点");
    // 第一次直传被伪造成功（对象实际未落盘）→ 服务端 verifyObject 失败 → status='failed' → 客户端可重试失败态
    await page.route("**/api/local-storage/objects", (route) => (route.request().method() === "POST" ? route.fulfill({ status: 200, headers: { etag: "fake" }, body: "" }) : route.fallback()));
    await entries.first().getByRole("button", { name: "为闪光点 1 添加照片" }).click();
    await dishes.locator('.highlight-section input[type="file"]').setInputFiles({ name: "retry.png", mimeType: "image/png", buffer: buildPng(0xaa) });
    await expect(entries.first().getByRole("button", { name: "重试", exact: true })).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-highlight-upload-failed.png`, fullPage: true });
    // 解除伪造后点击重试：同一 clientFileId 重新 init（failed 复位 + 重签凭据）→ 真实直传 → complete → ready
    await page.unroute("**/api/local-storage/objects");
    await entries.first().getByRole("button", { name: "重试" }).click();
    await expect(entries.first().locator('.highlight-tile img:not([src^="blob"])')).toHaveCount(1, { timeout: 20_000 });
    await expect(entries.first().locator('.highlight-tile img[src^="blob"]')).toHaveCount(0);
    await expect.poll(async () => entries.first().locator('.highlight-tile img:not([src^="blob"])').first().evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
    // 服务端终态确认：ready 行存在且落盘字节可经预签名取回
    const highlightId = await entries.first().getAttribute("data-highlight-id");
    const photo = (await pool.query("SELECT id,storage_key FROM other_record_highlight_photos WHERE highlight_id=$1 AND status='ready'", [highlightId])).rows[0];
    expect(photo).toBeTruthy();
    const draftJson = await (await api.get(`/api/questionnaires/secret/drafts/${world.attemptId}`, { headers: { authorization: `Bearer ${world.accessToken}` } })).json();
    const photos = draftJson.otherRecords.highlights.find((item) => item.id === highlightId)?.photos || [];
    expect(photos).toHaveLength(1);
    const previewFetch = await api.get(photos[0].previewUrl);
    expect(previewFetch.ok()).toBeTruthy();
    expect((await previewFetch.body()).length).toBeGreaterThan(0);
    await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-highlight-upload-recovered.png`, fullPage: true });
    expect(errors.pageErrors).toEqual([]);
  });

  test("202 确认中→服务端 verify 失败：确定性错误清 verifyPending，重试重 init 恢复 ready；pending 重放不重传", async ({ page }) => {
    trackConsoleErrors(page, errors);
    await plantSession(page, page.context());
    await answerQ1Unscored();
    await answerRemaining([world.q2, world.q3, world.q4]);
    await page.goto(dishesUrl());
    const dishes = page.locator('[data-page="dishes"]');
    await expect(dishes).toHaveAttribute("data-state", "ready");
    const entries = dishes.locator(".highlight-item");
    await entries.first().locator("textarea").fill("202 链路闪光点");
    // 真实直传计数器：pending 重放阶段绝不重新直传（防覆盖被服务端租约校验的对象）。
    let directUploads = 0;
    await page.route("**/api/local-storage/objects", (route) => {
      if (route.request().method() === "POST") directUploads += 1;
      return route.fallback();
    });
    await entries.first().getByRole("button", { name: "为闪光点 1 添加照片" }).click();
    await dishes.locator('.highlight-section input[type="file"]').setInputFiles({ name: "verify202.png", mimeType: "image/png", buffer: buildPng(0x66) });
    await expect(entries.first().locator('.highlight-tile img:not([src^="blob"])')).toHaveCount(1, { timeout: 20_000 });
    const directUploadsAfterFirst = directUploads;
    expect(directUploadsAfterFirst).toBe(1);
    const highlightId = await entries.first().getAttribute("data-highlight-id");
    const rowOf = async () => (await pool.query("SELECT status,storage_key FROM other_record_highlight_photos WHERE highlight_id=$1", [highlightId])).rows[0];
    expect((await rowOf()).status).toBe("ready");

    // 第一次 complete 被伪造为 202 verifying：客户端进入 verifyPending（不重传）；服务端行仍是 uploading
    let complete202Sent = false;
    await page.route("**/photo-uploads/*/complete", (route) => {
      if (route.request().method() !== "POST" || complete202Sent) return route.fallback();
      complete202Sent = true;
      const body = JSON.parse(route.request().postData() || "{}");
      return route.fulfill({ status: 202, headers: { "retry-after": "1" }, contentType: "application/json", body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000000", status: "verifying", revision: body.revision }) });
    });
    // 删掉客户端已确认过的 ready 照片（硬删模型：行直接移除）触发完整链路重走（用 202 版本）
    await entries.first().locator('.highlight-tile__remove[aria-label^="删除闪光点"]').first().click();
    await expect(entries.first().locator('.highlight-tile')).toHaveCount(0);
    expect(((await pool.query("SELECT id FROM other_record_highlight_photos WHERE highlight_id=$1", [highlightId])).rows)).toHaveLength(0);
    await entries.first().getByRole("button", { name: "为闪光点 1 添加照片" }).click();
    await dishes.locator('.highlight-section input[type="file"]').setInputFiles({ name: "verify202b.png", mimeType: "image/png", buffer: buildPng(0xbb) });
    // 伪 202 使链路落入可重试失败态（此之前第二张已完成真实直传）
    await expect(entries.first().getByRole("button", { name: "重试", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await rowOf())?.status).toBe("uploading"); // 服务端尚未完成校验
    expect(directUploads).toBe(2);
    const directUploadsBeforeReplay = directUploads;

    // 服务端校验随后注定失败：删掉已落盘对象（真实 verify 读不到字节）
    const row = await rowOf();
    await rm(resolve(import.meta.dirname, "../../../test-results/h5-local-storage", row.storage_key), { force: true });
    // 重试 #1：verifyPending+已知 attachmentId → 只重放 complete（直传计数不增）→ 服务端 verify 422 确定性失败
    await entries.first().getByRole("button", { name: "重试", exact: true }).click();
    // 重放 complete → 服务端 verify 读不到已删对象 → 422 确定性失败置 failed（等该落库完成）
    await expect.poll(async () => (await rowOf())?.status, { timeout: 20_000 }).toBe("failed");
    expect(directUploads).toBe(directUploadsBeforeReplay); // pending 阶段无重传
    // 确定性失败已清 verifyPending：422 (EVIDENCE_FILE_INVALID) 经 presentError 映射为通用
    // validation 文案，其渲染完成 = catch+finally 已提交（busy 已释放）→ 此后点击恰好落一次。
    await expect(entries.first().getByText("操作未完成，请检查填写内容")).toBeVisible();
    // 重试 #2：恰好一次新 init（failed 复位+重签凭据）→ 真实直传 → ready
    let initCalls = 0;
    await page.route("**/photo-uploads", (route) => {
      if (route.request().method() === "POST") initCalls += 1;
      return route.fallback();
    });
    await entries.first().getByRole("button", { name: "重试", exact: true }).click();
    await expect.poll(async () => (await rowOf())?.status, { timeout: 20_000 }).toBe("ready");
    await expect.poll(async () => (await rowOf())?.status).toBe("ready");
    expect(initCalls).toBe(1); // 恰好一次新 init
    await expect(entries.first().locator('.highlight-tile img[src^="blob"]')).toHaveCount(0);
    await expect.poll(async () => entries.first().locator('.highlight-tile img:not([src^="blob"])').first().evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
    expect(directUploads).toBe(directUploadsBeforeReplay + 1); // 重 init 后恰好一次新直传
    expect((await rowOf()).status).toBe("ready");
    await page.unroute("**/api/local-storage/objects");
    await page.unroute("**/photo-uploads/*/complete");
    expect(errors.pageErrors).toEqual([]);
  });

  test("提交确认弹窗：得分预览含清零、取消保留编辑、确认后与服务端权威得分一致", async ({ page }) => {
    trackConsoleErrors(page, errors);
    await plantSession(page, page.context());
    // 复现完整用户旅程：清零题答「是」（带说明，无照片）→ 其余题得分 → 第二步两条闪光点 → 第三步提交
    await page.goto(surveyUrl());
    const survey = page.locator('[data-page="survey"]');
    await expect(survey).toHaveAttribute("data-state", "ready");
    page.once("dialog", (dialog) => dialog.accept());
    await survey.locator(".card", { hasText: "清零题" }).first().getByRole("button", { name: "是", exact: true }).click();
    const issue = page.locator('[data-page="issue"]');
    await expect(issue).toBeVisible();
    await issue.locator("textarea").fill("UX回归：清零题说明");
    await issue.getByRole("button", { name: "确认", exact: true }).click();
    await expect(survey).toBeVisible();
    await answerRemaining([world.q2, world.q3, world.q4]);
    // 第二步：两条闪光点（第一条附真实照片）
    await page.goto(dishesUrl());
    const dishes = page.locator('[data-page="dishes"]');
    await expect(dishes).toHaveAttribute("data-state", "ready");
    const entries = dishes.locator(".highlight-item");
    await entries.first().locator("textarea").fill("UX回归闪光点一：上菜很快");
    await dishes.getByRole("button", { name: "+ 添加一条闪光点" }).click();
    await expect(entries).toHaveCount(2);
    await entries.nth(1).locator("textarea").fill("UX回归闪光点二：环境整洁");
    await entries.first().getByRole("button", { name: "为闪光点 1 添加照片" }).click();
    await dishes.locator('.highlight-section input[type="file"]').setInputFiles({ name: "highlight.png", mimeType: "image/png", buffer: PNG_BYTES });
    await expect(entries.first().locator('.highlight-tile img:not([src^="blob"])')).toHaveCount(1);
    await expect(entries.first().locator('.highlight-tile img[src^="blob"]')).toHaveCount(0);
    // 第三步：提交确认弹窗
    await page.goto(otherUrl());
    const other = page.locator('[data-page="other"]');
    await expect(other).toHaveAttribute("data-state", "ready");
    await expect(other.locator(".flow-steps")).toContainText("其他照片");
    await other.locator("textarea").fill("UX回归建议：无");
    await other.getByRole("button", { name: "提交问卷" }).click();
    const modal = other.getByRole("dialog", { name: "确认提交问卷" });
    await expect(modal).toBeVisible();
    // 清零口径：环境(2+3)清零 + 服务 5/5 + 产品 0 → 5/10 = 50%
    await expect(modal).toContainText("问卷提交后无法再次修改");
    await expect(modal.locator(".modal-score")).toHaveText("当前得分 50%（5/10 分）");
    await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-modal-open.png`, fullPage: true });
    // 取消：弹窗关闭、编辑保留、可继续修改
    await modal.getByRole("button", { name: "继续编辑" }).click();
    await expect(modal).toBeHidden();
    await expect(other.locator("textarea")).toHaveValue("UX回归建议：无");
    expect(await page.locator('[data-page="task"]').count()).toBe(0);
    await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-modal-cancelled.png`, fullPage: true });
    // 再次提交：确认 → 成功页
    await other.getByRole("button", { name: "提交问卷" }).click();
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "确认提交" }).click();
    await expect(other).toHaveAttribute("data-state", "submitted", { timeout: 30_000 });
    await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-submitted.png`, fullPage: true });
    // 服务端权威得分与预览一致（清零后 5/10）
    const submission = (await pool.query("SELECT total_score,max_score FROM submission_versions WHERE attempt_id=$1", [world.attemptId])).rows[0];
    expect(Number(submission.total_score)).toBe(5);
    expect(Number(submission.max_score)).toBe(10);
    // 快照冻结全部闪光点文字与照片引用
    const snapshot = (await pool.query("SELECT other_snapshot_json FROM submission_versions WHERE attempt_id=$1", [world.attemptId])).rows[0];
    expect(snapshot.other_snapshot_json.highlights.map((item) => item.text)).toEqual(["UX回归闪光点一：上菜很快", "UX回归闪光点二：环境整洁"]);
    expect(snapshot.other_snapshot_json.highlights[0].photos.length).toBe(1);
    expect(errors.pageErrors).toEqual([]);
    expect(resourceNoise(errors.consoleErrors)).toEqual([]);
  });

  test("第三步无闪光点必填拦截；零闪光点/隐藏菜品整卷提交；加载失败可恢复", async ({ page }) => {
    trackConsoleErrors(page, errors);
    await plantSession(page, page.context());
    // UI 层：第三步已无闪光点输入（必填拦截不复存在）
    await page.goto(otherUrl());
    const other = page.locator('[data-page="other"]');
    await expect(other).toHaveAttribute("data-state", "ready");
    expect(await other.locator("#highlight-field").count()).toBe(0);
    // 断网模拟：页面加载失败 → 错误条 + 重新加载；恢复后回到可用态（预览 100% 之类的
    // 虚构分数由「无数据一律显示无法计算」的单元测试与弹窗用例共同覆盖）。
    await page.route("**/api/questionnaires/secret/drafts/*", (route) => route.abort("failed"));
    await page.reload();
    await expect(other.locator(".error-bar").first()).toBeVisible();
    await page.unroute("**/api/questionnaires/secret/drafts/*");
    await other.getByRole("button", { name: "重新加载" }).click();
    await expect(other).toHaveAttribute("data-state", "ready");
    // 零闪光点 + 隐藏菜品（空白默认编辑器从不保存 → 服务端 0 条）整卷提交成功。
    // 全题 0 分（清零 + 服务题不得分）让预览为 0%——真实零分，不是 fabricated 100%。
    await answerUnscored(world.q1, "零闪光点提交：清零题说明");
    await answerUnscored(world.q3, "零闪光点提交：服务题说明");
    await answerRemaining([world.q2, world.q4]);
    await page.goto(dishesUrl());
    const dishes = page.locator('[data-page="dishes"]');
    await expect(dishes).toHaveAttribute("data-state", "ready");
    // 空白默认编辑器直接返回第三步（不落任何条目）
    await dishes.getByRole("button", { name: "下一步：其他记录" }).click();
    await expect(other).toHaveAttribute("data-state", "ready");
    // 弹窗得分拉取失败：确认禁用（绝不虚构 100%/默认分），可恢复重试取回真实得分，取消保留编辑。
    await page.route("**/api/questionnaires/secret/drafts/*", (route) => (route.request().method() === "GET" ? route.abort("failed") : route.fallback()));
    await other.locator("textarea").fill("零闪光点提交建议");
    await other.getByRole("button", { name: "提交问卷" }).click();
    const modal = other.getByRole("dialog", { name: "确认提交问卷" });
    await expect(modal).toBeVisible();
    await expect(modal.locator(".modal-score")).toHaveText("得分率暂时无法计算");
    await expect(modal.getByRole("button", { name: "确认提交" })).toBeDisabled();
    await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-modal-score-unavailable.png`, fullPage: true });
    await page.unroute("**/api/questionnaires/secret/drafts/*");
    await modal.getByRole("button", { name: "重新获取得分" }).click();
    await expect(modal.locator(".modal-score")).toHaveText("当前得分 0%（0/10 分）");
    await expect(modal.getByRole("button", { name: "确认提交" })).toBeEnabled();
    // 取消：弹窗关闭、编辑保留，可再次提交
    await modal.getByRole("button", { name: "继续编辑" }).click();
    await expect(modal).toBeHidden();
    await expect(other.locator("textarea")).toHaveValue("零闪光点提交建议");
    // 最终提交：恰好 1 条提交记录
    await other.getByRole("button", { name: "提交问卷" }).click();
    await expect(modal).toBeVisible();
    await expect(modal.locator(".modal-score")).toHaveText("当前得分 0%（0/10 分）");
    await page.screenshot({ path: `${EVIDENCE_DIR}/mobile-modal-zero-highlights.png`, fullPage: true });
    await modal.getByRole("button", { name: "确认提交" }).click();
    await expect(other).toHaveAttribute("data-state", "submitted", { timeout: 30_000 });
    const submissions = await pool.query("SELECT other_snapshot_json,total_score FROM submission_versions WHERE attempt_id=$1", [world.attemptId]);
    expect(submissions.rows).toHaveLength(1);
    expect(submissions.rows[0].other_snapshot_json.highlights).toEqual([]);
    expect(Number(submissions.rows[0].total_score)).toBe(0);
    // 未捕获异常必须为空；断网用例允许资源加载失败的 console error。
    expect(errors.pageErrors).toEqual([]);
    expect(resourceNoise(errors.consoleErrors)).toEqual([]);
  });
});

test.describe("survey UX 2026-10（桌面视口）", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("桌面视口：步骤命名/按钮未选态证据", async ({ page }) => {
    const errors = {};
    trackConsoleErrors(page, errors);
    await plantSession(page, page.context());
    await page.goto(surveyUrl());
    const survey = page.locator('[data-page="survey"]');
    await expect(survey).toHaveAttribute("data-state", "ready");
    const yesButton = survey.locator(".card", { hasText: "清零题" }).first().getByRole("button", { name: "是", exact: true });
    await expect(yesButton).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(yesButton).toHaveCSS("color", PRIMARY);
    await page.screenshot({ path: `${EVIDENCE_DIR}/desktop-survey-neutral.png`, fullPage: true });
    expect(errors.pageErrors).toEqual([]);
    expect(resourceNoise(errors.consoleErrors)).toEqual([]);
  });
});
