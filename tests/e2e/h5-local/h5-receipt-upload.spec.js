// H5 消费小票上传浏览器回归（真实 API + 真实 junde_test + 真实本地磁盘存储，保险丝同 shared.mjs）：
// 2026-10 修复回归——ReceiptFileMetaSchema 在 init/complete 都强制 64-hex sha256，且服务端 complete
// 用它对账存储对象实测摘要。DishesPage 必须在 init 之前对选中 File 真实字节算摘要，并以同一字符串
// 贯穿 init→直传→complete；File 缺失/不可读时本地失败、不发任何网络请求。
// 覆盖：
//   1) 首张选图即成功：init/complete 携带同一 64-hex 真实摘要（与 node:crypto 对账），
//      完成后 readyCount>0，DB 行 ready 且 sha256 一致，落盘字节与原图逐字节相同；
//   2) 两张串行上传：complete(cf1) 先于 init(cf2) 严格不交错，各自携带真实摘要；
//   3) 直传失败 → 重试复用同一 clientFileId 与已算摘要成功（无重复附件行、不重发 init）；
//      再次失败后移除重选走通整链；
//   4) 整页刷新后 File 缓存失效：重试本地快速失败（可读文案引导重选），零网络请求；
//   5) SPA 重挂载（File 仍在模块缓存）：重试跨重挂载成功（摘要持久化复用 + init 幂等重放）；
//   6) receipt_required 任务带真实小票提交成功，管理端提交详情真实预览缩略图（字节可解码）。
// 隔离口径：每个用例自建任务（campaign/assignment/attempt/答案），互不依赖服务端共享状态——
// Playwright 在用例失败后会回收 worker 并重跑 beforeAll（TRUNCATE+重播种），共享 attempt 会失效。
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import pg from "pg";
import { createPasswordService } from "../../../apps/api/src/auth/passwords.js";
import { encrypt, hmac, normalizePhone } from "../../../apps/api/src/auth/crypto.js";
import { uuidv7 } from "../../../apps/api/src/ids.js";
import { seedRbac } from "../../../db/seeds/rbac.mjs";
import {
  ADMIN_PASSWORD, ADMIN_USERNAME, H5_TEST_AUTH_KEY, H5_TEST_PHONE_KEY,
  INSPECTOR_PASSWORD, INSPECTOR_USERNAME, testDatabaseUrl,
} from "./shared.mjs";

assertTestDatabase();

function assertTestDatabase() {
  // 直接复用 shared 的保险丝逻辑（连接前先失败关闭）：只允许回环地址上的 junde_test。
  testDatabaseUrl();
}

// 真实可解码 1x1 PNG（与 admin.spec 高亮预览同源字节）：服务端内容魔数闸与浏览器解码双通过。
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
// 其余文件各自独占一份字节（服务端对同一 attempt 内同 sha256 小票按 RECEIPT_DUPLICATE 拒绝）。
const uniqueBytes = (filler, size) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(size, filler)]);
const uniqueJpegBytes = (filler, size) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, filler)]);
const JPEG_BYTES = uniqueJpegBytes(0x33, 800);
const PNG2_BYTES = uniqueBytes(0x22, 900);
const PNG_FLAKY_BYTES = uniqueBytes(0x44, 1000);
const PNG_RESELECT_BYTES = uniqueBytes(0x55, 1100);
const PNG_ORPHAN_BYTES = uniqueBytes(0x66, 1200);
const JPEG_REMOUNT_BYTES = uniqueJpegBytes(0x77, 1300);
const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

const config = {
  NODE_ENV: "test",
  AUTH_TOKEN_HMAC_KEY: H5_TEST_AUTH_KEY,
  PHONE_ENCRYPTION_KEY_BASE64: H5_TEST_PHONE_KEY,
};

let pool;
let world;
let api;
let attemptSequence = 0;

async function seedBase() {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash(INSPECTOR_PASSWORD);
  const adminPasswordHash = await passwords.hash(ADMIN_PASSWORD);
  const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const adminId = uuidv7();
  const inspectorId = uuidv7();
  await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,'AdminOne','adminone','管理员',$2,$3,now(),$4,'approved_active'),($5,'InspectorOne','inspectorone','探员',$6,$7,now(),$8,'approved_active')`,
    [adminId, encrypt(encryptionKey, normalizePhone("13600000000")), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13600000000")), adminPasswordHash,
      inspectorId, encrypt(encryptionKey, normalizePhone("13800000000")), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13800000000")), passwordHash]);
  const adminRole = await pool.query("SELECT id FROM roles WHERE code='admin'");
  const inspectorRole = await pool.query("SELECT id FROM roles WHERE code='inspector'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), adminId, adminRole.rows[0].id]);
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), inspectorId, inspectorRole.rows[0].id]);
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
  const provinceId = uuidv7(); const cityId = uuidv7(); const regionId = uuidv7(); const storeId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'静安区','310106',$2,3)", [regionId, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-H5R','H5小票回归门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, adminId]);
  const templateId = uuidv7(); const versionId = uuidv7(); const questionOne = uuidv7(); const questionTwo = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'H5小票上传回归问卷','secret',$2)", [templateId, adminId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_by,published_at) VALUES ($1,$2,1,'published',$3,$3,now())", [versionId, templateId, adminId]);
  await pool.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,sort_order) VALUES
    ($1,$2,'q1',1,'environment','小票回归题一',2,true,1),($3,$2,'q2',2,'environment','小票回归题二',3,true,2)`, [questionOne, versionId, questionTwo]);
  return { adminId, inspectorId, questionnaireVersionId: versionId, storeId };
}

// 每个用例独立任务：新 campaign + assignment（receipt_required）→ check-in → start → 全题置已答。
// 菜品页 R40 全题守卫要求进页前全部启用题已作答，否则深链会被弹回问卷。
async function startAttempt(receiptRequired = true) {
  const campaignId = uuidv7(); const assignmentId = uuidv7();
  const startsAt = new Date(Date.now() - 60_000); const dueAt = new Date(Date.now() + 3_600_000);
  // business_no 全库唯一（uuidv7 前缀是毫秒时间戳，同 49 天窗口内切片相同，必须用自增序号）。
  attemptSequence += 1;
  const sequenceTag = `${Date.now()}-${attemptSequence}`;
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,$2,'H5小票回归任务',$3,$4,$5,$6,'published',$7)", [campaignId, `C-H5R-${sequenceTag}`, world.storeId, startsAt, dueAt, new Date(Date.now() + 7_200_000), world.adminId]);
  await pool.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,receipt_required,status,created_by)
    VALUES ($1,$2,$3,$4,$5,'secret',$6,$7,0,$8,'assigned',$9)`, [assignmentId, `A-H5R-${sequenceTag}`, campaignId, world.inspectorId, world.questionnaireVersionId, startsAt, dueAt, receiptRequired, world.adminId]);
  const checkin = await api.post(`/api/assignments/${assignmentId}/check-in`, { headers: { authorization: `Bearer ${world.accessToken}` }, data: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
  expect(checkin.ok(), await checkin.text()).toBeTruthy();
  const started = await api.post(`/api/assignments/${assignmentId}/start`, { headers: { authorization: `Bearer ${world.accessToken}` } });
  expect(started.ok(), await started.text()).toBeTruthy();
  const attemptId = (await started.json()).attempt.id;
  const questions = (await pool.query("SELECT id,max_score FROM questions WHERE version_id=$1 ORDER BY question_number", [world.questionnaireVersionId])).rows;
  for (const question of questions) {
    await pool.query("INSERT INTO question_answers (attempt_id,question_id,answer,awarded_score,issue_remark) VALUES ($1,$2,'scored',$3,'')", [attemptId, question.id, question.max_score]);
  }
  return { assignmentId, attemptId };
}

// 植入探员会话并深链打开菜品页（revision 故意传 999 过期值：页面必须以服务端草稿 revision 为准）。
async function openDishes(page, attempt) {
  const inspectorLogin = await page.request.post("/api/auth/login", { data: { username: INSPECTOR_USERNAME, password: INSPECTOR_PASSWORD } });
  expect(inspectorLogin.ok(), await inspectorLogin.text()).toBeTruthy();
  const session = await inspectorLogin.json();
  await page.addInitScript(([key, value]) => { window.localStorage.setItem(key, value); }, ["junde:session", JSON.stringify(session)]);
  await page.goto(`/#/dishes?assignmentId=${attempt.assignmentId}&attemptId=${attempt.attemptId}&questionnaireVersionId=${world.questionnaireVersionId}&revision=999`);
  const pageRoot = page.locator('[data-page="dishes"]');
  await expect(pageRoot).toHaveAttribute("data-state", "ready");
  return pageRoot;
}

// 观察器（先注册→链路后段）：记录小票 init/complete/存储直传请求后放行（不改变任何请求）。
async function observeReceiptTraffic(page, log) {
  await page.route("**/receipt-attachments/uploads", async (route) => {
    log.requests.push({ kind: "init", body: route.request().postDataJSON()?.fileMeta || null });
    await route.fallback();
  });
  await page.route("**/receipt-attachments/*/complete", async (route) => {
    log.requests.push({ kind: "complete", body: route.request().postDataJSON()?.fileMeta || null });
    await route.fallback();
  });
  await page.route("**/api/local-storage/objects", async (route) => {
    if (route.request().method() === "POST") log.requests.push({ kind: "storage" });
    await route.fallback();
  });
}

// 存储直传阻断开关：active 期间所有直传 POST 以网络失败告终（init/complete 仍真实到达服务端，
// 与「init 成功后直传失败」的生产形态一致）。返回开关对象供用例切换。
async function installStorageBlock(page, log) {
  const blocker = { active: true };
  await page.route("**/api/local-storage/objects", async (route) => {
    if (route.request().method() === "POST" && blocker.active) {
      log.blocked += 1;
      await route.abort("connectionrefused");
      return;
    }
    await route.fallback();
  });
  return blocker;
}

const receiptRows = (attemptId) => pool.query("SELECT client_file_id,status,sha256,size_bytes,mime_type,original_file_name FROM receipt_attachments WHERE attempt_id=$1 ORDER BY created_at,id", [attemptId]).then((result) => result.rows);

test.beforeAll(async ({ playwright, baseURL }) => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
  await pool.query("SELECT 1 FROM users LIMIT 1"); // schema 未迁移时立即失败
  await pool.query(`TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users, questionnaire_templates, questionnaire_versions, questions, question_evidence_requirements, regions, stores, audit_campaigns, audit_assignments, survey_attempts, question_evidence_attachments, question_answer_edit_sessions, question_answer_edit_session_removals, receipt_attachments, receipt_ocr_jobs, receipt_ocr_job_attachments, receipt_ocr_candidates, receipt_ocr_applications, export_jobs, object_cleanup_jobs, submission_versions, submission_question_scores, audit_logs, idempotency_keys, dish_records, other_records, audit_checkins, checkin_exemptions RESTART IDENTITY CASCADE`);
  await seedRbac(pool);
  // 评估分类基线自足：其他套件会 TRUNCATE question_categories 并只回种部分行，按 0025 规范集合补齐。
  await pool.query(`INSERT INTO question_categories (id,code,name,sort_order) VALUES
    (gen_random_uuid(),'environment','环境卫生',1),(gen_random_uuid(),'service','为客服务',2),(gen_random_uuid(),'product','产品品质',3)
    ON CONFLICT (code) DO NOTHING`);
  world = await seedBase();
  api = await playwright.request.newContext({ baseURL });
  const login = await api.post("/api/auth/login", { data: { username: INSPECTOR_USERNAME, password: INSPECTOR_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  world.accessToken = (await login.json()).accessToken;
});

test.afterAll(async () => {
  await api?.dispose();
  await pool?.end();
});

test("first receipt upload carries the real digest in init and complete and lands ready on server storage", async ({ page }) => {
  const attempt = await startAttempt();
  const pageRoot = await openDishes(page, attempt);
  const log = { requests: [] };
  await observeReceiptTraffic(page, log);

  await page.setInputFiles('input[type="file"]', { name: "receipt-one.png", mimeType: "image/png", buffer: TINY_PNG });
  await expect(pageRoot).toContainText("1 张已完成");

  // init 与 complete 携带同一 64-hex 真实摘要（与 node:crypto 对账）。
  expect(log.requests.filter((item) => item.kind === "init")).toHaveLength(1);
  expect(log.requests.filter((item) => item.kind === "complete")).toHaveLength(1);
  const initMeta = log.requests.find((item) => item.kind === "init").body;
  const completeMeta = log.requests.find((item) => item.kind === "complete").body;
  expect(initMeta.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(initMeta.sha256).toBe(sha256Of(TINY_PNG));
  expect(completeMeta.sha256).toBe(initMeta.sha256);
  expect(completeMeta.clientFileId).toBe(initMeta.clientFileId);
  expect(completeMeta.fileName).toBe(initMeta.fileName);

  // 服务端落库：ready + 同一摘要；预览 URL 取回的字节与原图逐字节一致（真实本地磁盘存储）。
  const rows = await receiptRows(attempt.attemptId);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("ready");
  expect(rows[0].sha256.toLowerCase()).toBe(initMeta.sha256);
  const list = await api.get(`/api/questionnaires/secret/drafts/${attempt.attemptId}/receipt-attachments`, { headers: { authorization: `Bearer ${world.accessToken}` } });
  expect(list.ok(), await list.text()).toBeTruthy();
  const items = (await list.json()).items;
  expect(items).toHaveLength(1);
  const preview = await api.get(items[0].previewUrl);
  expect(preview.ok()).toBeTruthy();
  expect((await preview.body()).equals(TINY_PNG)).toBe(true);
});

test("two receipts upload strictly serially and both land ready with their own digests", async ({ page }) => {
  const attempt = await startAttempt();
  const pageRoot = await openDishes(page, attempt);
  const log = { requests: [] };
  await observeReceiptTraffic(page, log);

  await page.setInputFiles('input[type="file"]', [
    { name: "receipt-two-a.jpg", mimeType: "image/jpeg", buffer: JPEG_BYTES },
    { name: "receipt-two-b.png", mimeType: "image/png", buffer: PNG2_BYTES },
  ]);
  await expect(pageRoot).toContainText("2 张已完成");

  // 串行口径（R63 receiptBusy 互斥）：同一文件 complete 先于下一文件 init，严格不交错。
  const flow = log.requests.filter((item) => item.kind !== "storage").map((item) => `${item.kind}:${item.body.clientFileId}`);
  expect(flow).toHaveLength(4);
  expect(flow[0].startsWith("init:")).toBe(true);
  expect(flow[1]).toBe(`complete:${flow[0].slice("init:".length)}`);
  expect(flow[2].startsWith("init:")).toBe(true);
  expect(flow[3]).toBe(`complete:${flow[2].slice("init:".length)}`);
  expect(flow[1].slice("complete:".length)).not.toBe(flow[3].slice("complete:".length));
  // 每张各自携带真实摘要（jpeg 与 png 各一）。
  const inits = log.requests.filter((item) => item.kind === "init");
  expect(inits[0].body.sha256).toBe(sha256Of(JPEG_BYTES));
  expect(inits[1].body.sha256).toBe(sha256Of(PNG2_BYTES));

  const rows = await receiptRows(attempt.attemptId);
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.status === "ready")).toBe(true);
  expect(rows.map((row) => row.sha256.toLowerCase()).sort()).toEqual([sha256Of(JPEG_BYTES), sha256Of(PNG2_BYTES)].sort());
});

test("storage failure then retry succeeds with the same clientFileId; remove and reselect also succeeds", async ({ page }) => {
  const attempt = await startAttempt();
  const pageRoot = await openDishes(page, attempt);
  const log = { requests: [], blocked: 0 };
  await observeReceiptTraffic(page, log);
  const blocker = await installStorageBlock(page, log);

  // 直传被拦：init 已真实到达服务端（附件行建立），页面呈现失败态 + 可读文案。
  await page.setInputFiles('input[type="file"]', { name: "receipt-flaky.png", mimeType: "image/png", buffer: PNG_FLAKY_BYTES });
  const failedCard = page.locator('[data-page="dishes"] .card:not(.receipt-section)', { hasText: "暂时无法上传小票" });
  await expect(failedCard).toContainText("上传失败");
  expect((await receiptRows(attempt.attemptId)).filter((row) => row.original_file_name === "receipt-flaky.png")).toHaveLength(1);
  expect(log.requests.filter((item) => item.kind === "init" && item.body.fileName === "receipt-flaky.png")).toHaveLength(1);

  // 重试：复用 File 与已算摘要、复用已缓存 uploadTarget（不重发 init）→ 成功；不产生重复附件行。
  blocker.active = false;
  await failedCard.getByRole("button", { name: "重试" }).click();
  await expect(pageRoot).toContainText("1 张已完成");
  expect(log.requests.filter((item) => item.kind === "init" && item.body.fileName === "receipt-flaky.png")).toHaveLength(1);
  const flakyCompletes = log.requests.filter((item) => item.kind === "complete" && item.body.fileName === "receipt-flaky.png");
  expect(flakyCompletes).toHaveLength(1);
  expect(flakyCompletes[0].body.sha256).toBe(sha256Of(PNG_FLAKY_BYTES));
  expect((await receiptRows(attempt.attemptId)).filter((row) => row.original_file_name === "receipt-flaky.png")).toHaveLength(1);

  // 再次失败 → 移除待传项 → 重新选图：新 clientFileId、新摘要，整链重新走通。
  blocker.active = true;
  await page.setInputFiles('input[type="file"]', { name: "receipt-retry-fail.png", mimeType: "image/png", buffer: PNG2_BYTES });
  const failedAgain = page.locator('[data-page="dishes"] .card:not(.receipt-section)', { hasText: "暂时无法上传小票" });
  await expect(failedAgain).toContainText("上传失败");
  blocker.active = false;
  await failedAgain.getByLabel("移除待上传消费小票").click();
  await page.setInputFiles('input[type="file"]', { name: "receipt-reselect.png", mimeType: "image/png", buffer: PNG_RESELECT_BYTES });
  await expect(pageRoot).toContainText("2 张已完成");
  expect((await receiptRows(attempt.attemptId)).filter((row) => row.status === "ready")).toHaveLength(2);
  expect(log.requests.filter((item) => item.kind === "complete" && item.body.fileName === "receipt-reselect.png")[0].body.sha256).toBe(sha256Of(PNG_RESELECT_BYTES));
});

test("after full reload the File cache is gone: retry fails locally with a reselection message and zero network", async ({ page }) => {
  const attempt = await startAttempt();
  const pageRoot = await openDishes(page, attempt);
  const log = { requests: [], blocked: 0 };
  await observeReceiptTraffic(page, log);
  const blocker = await installStorageBlock(page, log);
  await page.setInputFiles('input[type="file"]', { name: "receipt-orphan.png", mimeType: "image/png", buffer: PNG_ORPHAN_BYTES });
  const failedCard = page.locator('[data-page="dishes"] .card:not(.receipt-section)', { hasText: "暂时无法上传小票" });
  await expect(failedCard).toContainText("上传失败");

  // 整页刷新：模块级 File 缓存清空，待传项由本地草稿恢复（sha256/localPath 持久化，File 被脱敏剔除）。
  await page.reload();
  const reloadedRoot = page.locator('[data-page="dishes"]');
  await expect(reloadedRoot).toHaveAttribute("data-state", "ready");
  const recoveredCard = page.locator('[data-page="dishes"] .card:not(.receipt-section)', { hasText: "暂时无法上传小票" });
  await expect(recoveredCard).toContainText("上传失败");

  const networkLog = { requests: [] };
  await observeReceiptTraffic(page, networkLog);
  await recoveredCard.getByRole("button", { name: "重试" }).click();
  // 本地快速失败：可读文案引导重新选择，绝不发任何网络请求（init/complete/存储直传全部为零）。
  await expect(page.locator('[data-page="dishes"] .card:not(.receipt-section)', { hasText: "图片文件已失效" })).toBeVisible();
  expect(networkLog.requests).toHaveLength(0);
  // 服务端无该文件的成功上传（仅 init 建立的 uploading 行，无 ready）。
  expect((await receiptRows(attempt.attemptId)).filter((row) => row.original_file_name === "receipt-orphan.png").map((row) => row.status)).toEqual(["uploading"]);
});

test("spa remount keeps the module File cache: retry after remount succeeds with the persisted digest", async ({ page }) => {
  const attempt = await startAttempt();
  const pageRoot = await openDishes(page, attempt);
  const log = { requests: [], blocked: 0 };
  await observeReceiptTraffic(page, log);
  const blocker = await installStorageBlock(page, log);
  await page.setInputFiles('input[type="file"]', { name: "receipt-remount.png", mimeType: "image/png", buffer: JPEG_REMOUNT_BYTES });
  const failedCard = page.locator('[data-page="dishes"] .card:not(.receipt-section)', { hasText: "暂时无法上传小票" });
  await expect(failedCard).toContainText("上传失败");

  // SPA 内跳走再回来（hash 路由不重载文档）：组件重挂载、模块级 File 缓存仍有效。
  blocker.active = false;
  await page.goto("/#/help");
  await page.goto(`/#/dishes?assignmentId=${attempt.assignmentId}&attemptId=${attempt.attemptId}&questionnaireVersionId=${world.questionnaireVersionId}&revision=999`);
  const remountedRoot = page.locator('[data-page="dishes"]');
  await expect(remountedRoot).toHaveAttribute("data-state", "ready");
  const recoveredCard = page.locator('[data-page="dishes"] .card:not(.receipt-section)', { hasText: "暂时无法上传小票" });
  await expect(recoveredCard).toContainText("上传失败");

  await recoveredCard.getByRole("button", { name: "重试" }).click();
  await expect(remountedRoot).toContainText("1 张已完成");
  // 重挂载重试：uploadTarget 被脱敏剔除 → init 幂等重放（同一 clientFileId），摘要复用持久化值。
  const initsForFile = log.requests.filter((item) => item.kind === "init" && item.body.fileName === "receipt-remount.png");
  expect(initsForFile).toHaveLength(2);
  expect(initsForFile[0].body.sha256).toBe(sha256Of(JPEG_REMOUNT_BYTES));
  expect(initsForFile[1].body.sha256).toBe(sha256Of(JPEG_REMOUNT_BYTES));
  const completesForFile = log.requests.filter((item) => item.kind === "complete" && item.body.fileName === "receipt-remount.png");
  expect(completesForFile).toHaveLength(1);
  expect(completesForFile[0].body.sha256).toBe(sha256Of(JPEG_REMOUNT_BYTES));
  const rows = await receiptRows(attempt.attemptId);
  expect(rows.filter((row) => row.status === "ready")).toHaveLength(1);
});

test("submitted assignment with receipt_required previews the uploaded receipt in admin submission detail", async ({ page, playwright, baseURL }) => {
  const attempt = await startAttempt();
  const pageRoot = await openDishes(page, attempt);
  const log = { requests: [] };
  await observeReceiptTraffic(page, log);
  await page.setInputFiles('input[type="file"]', { name: "receipt-final.png", mimeType: "image/png", buffer: TINY_PNG });
  await expect(pageRoot).toContainText("1 张已完成");
  expect(log.requests.find((item) => item.kind === "init").body.sha256).toBe(sha256Of(TINY_PNG));

  // 真实提交（RECEIPT_REQUIRED 由上面那张真实小票满足）。
  const assignmentRevision = Number((await pool.query("SELECT revision FROM audit_assignments WHERE id=$1", [attempt.assignmentId])).rows[0].revision);
  const submit = await api.post(`/api/questionnaires/secret/${attempt.attemptId}/submit`, { headers: { authorization: `Bearer ${world.accessToken}` }, data: { submitToken: uuidv7(), assignmentRevision, confirmation: true } });
  expect(submit.ok(), await submit.text()).toBeTruthy();
  expect((await submit.json()).status).toBe("submitted");
  const submissionId = (await pool.query("SELECT id FROM submission_versions WHERE attempt_id=$1", [attempt.attemptId])).rows[0].id;
  expect(submissionId).toBeTruthy();

  // 管理员视角：admin 会话（cookie）请求提交详情，receiptComparison 必须给出 ready 缩略图；
  // 缩略图 URL 取回的字节与原图逐字节一致（AdminWorkbench 的 ReceiptComparison 渲染即消费此载荷，
  // 其 DOM 渲染形态已由 tests/e2e/admin.spec.js 以同构载荷覆盖；此处验证真实 API 的预览可用性）。
  const admin = await playwright.request.newContext({ baseURL });
  const adminLogin = await admin.post("/api/admin/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } });
  expect(adminLogin.ok(), await adminLogin.text()).toBeTruthy();
  const detail = await admin.get(`/api/admin/submissions/${submissionId}`);
  expect(detail.ok(), await detail.text()).toBeTruthy();
  const detailJson = await detail.json();
  const comparisonReceipts = detailJson.receiptComparison?.receipts || [];
  expect(comparisonReceipts).toHaveLength(1);
  expect(comparisonReceipts[0].previewStatus).toBe("ready");
  expect(comparisonReceipts[0].thumbnailUrl).toBeTruthy();
  const thumbnail = await admin.get(comparisonReceipts[0].thumbnailUrl);
  expect(thumbnail.ok(), await thumbnail.text()).toBeTruthy();
  expect((await thumbnail.body()).equals(TINY_PNG)).toBe(true);
  await admin.dispose();
});
