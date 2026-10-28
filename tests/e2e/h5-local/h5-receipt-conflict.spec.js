// H5 消费小票删除/重传冲突浏览器回归（真实 API + 真实 junde_test + 真实本地磁盘存储，保险丝同 shared.mjs）：
// 2026-10-28 修复回归——
//   1) UI 删除 ready 小票（修复前被 CHECK ready↔verified_at 拒绝 500）成功，历史元数据保留，槽位复用；
//   2) 已知服务端附件（attachmentId）的待传项移除：先授权软删释放槽位再清本地，无幽灵配额；
//   3) 移除的 DELETE 失败：待传项保留（可读文案可重试），不伪造删除成功、不丢 File；
//   4) 删中间留缺口由新上传补位（最小空闲槽）；
//   5) 删除→重传后 receipt_required 任务真实提交 + 管理端提交详情预览 ready（API 载荷 + 字节回读）。
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

// 真实可解码 1x1 PNG + 每文件独占字节（服务端对同 attempt 内同 sha256 按 RECEIPT_DUPLICATE 拒绝）。
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const uniqueBytes = (filler, size) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(size, filler)]);
const PNG_A_BYTES = uniqueBytes(0x44, 1000);
const PNG_B_BYTES = uniqueBytes(0x55, 1100);
const PNG_C_BYTES = uniqueBytes(0x66, 1200);
const PNG_D_BYTES = uniqueBytes(0x77, 1300);
const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

const config = {
  NODE_ENV: "test",
  AUTH_TOKEN_HMAC_KEY: H5_TEST_AUTH_KEY,
  PHONE_ENCRYPTION_KEY_BASE64: H5_TEST_PHONE_KEY,
};

let pool;
let world;
let api;

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
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-H5C','H5小票冲突回归门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, adminId]);
  const templateId = uuidv7(); const versionId = uuidv7(); const questionOne = uuidv7(); const questionTwo = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'H5小票冲突回归问卷','secret',$2)", [templateId, adminId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_by,published_at) VALUES ($1,$2,1,'published',$3,$3,now())", [versionId, templateId, adminId]);
  await pool.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,sort_order) VALUES
    ($1,$2,'q1',1,'environment','冲突回归题一',2,true,1),($3,$2,'q2',2,'environment','冲突回归题二',3,true,2)`, [questionOne, versionId, questionTwo]);
  return { adminId, inspectorId, questionnaireVersionId: versionId, storeId };
}

// 每个用例独立任务（receipt_required=true），进菜品页前全题置已答（R40 守卫）。
async function startAttempt() {
  const campaignId = uuidv7(); const assignmentId = uuidv7();
  const startsAt = new Date(Date.now() - 60_000); const dueAt = new Date(Date.now() + 3_600_000);
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,$2,'H5小票冲突回归任务',$3,$4,$5,$6,'published',$7)", [campaignId, `C-H5C-${Date.now()}-${campaignId.slice(0, 4)}`, world.storeId, startsAt, dueAt, new Date(Date.now() + 7_200_000), world.adminId]);
  await pool.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,receipt_required,status,created_by)
    VALUES ($1,$2,$3,$4,$5,'secret',$6,$7,0,true,'assigned',$8)`, [assignmentId, `A-H5C-${Date.now()}-${assignmentId.slice(0, 4)}`, campaignId, world.inspectorId, world.questionnaireVersionId, startsAt, dueAt, world.adminId]);
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

// 小票网格卡片定位器：排除页面级 Card（receipt-section/highlight-section/dish-list），
// 仅命中服务端小票卡与待传卡（两张 className="card"）。
const receiptCards = (page, hasText) => {
  const base = page.locator('[data-page="dishes"] .card:not(.receipt-section):not(.highlight-section):not(.dish-list)');
  return hasText ? base.filter({ hasText }) : base;
};

// 流量观察：init/complete 携带 fileMeta、DELETE 小票附件端点、存储直传 POST。
async function observeReceiptTraffic(page, log) {
  await page.route("**/receipt-attachments/uploads", async (route) => {
    log.requests.push({ kind: "init", body: route.request().postDataJSON()?.fileMeta || null });
    await route.fallback();
  });
  await page.route("**/receipt-attachments/*/complete", async (route) => {
    log.requests.push({ kind: "complete", body: route.request().postDataJSON()?.fileMeta || null });
    await route.fallback();
  });
  await page.route("**/receipt-attachments/*", async (route) => {
    if (route.request().method() === "DELETE") log.requests.push({ kind: "delete", url: route.request().url() });
    await route.fallback();
  });
  await page.route("**/api/local-storage/objects", async (route) => {
    if (route.request().method() === "POST") log.requests.push({ kind: "storage" });
    await route.fallback();
  });
}

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

const receiptRows = (attemptId) => pool.query("SELECT id,client_file_id,status,sha256,display_order,storage_key,verified_at,deleted_at,original_file_name FROM receipt_attachments WHERE attempt_id=$1 ORDER BY created_at,id", [attemptId]).then((result) => result.rows);

test.beforeAll(async ({ playwright, baseURL }) => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
  await pool.query("SELECT 1 FROM users LIMIT 1");
  await pool.query(`TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users, questionnaire_templates, questionnaire_versions, questions, question_evidence_requirements, regions, stores, audit_campaigns, audit_assignments, survey_attempts, question_evidence_attachments, question_answer_edit_sessions, question_answer_edit_session_removals, receipt_attachments, receipt_ocr_jobs, receipt_ocr_job_attachments, receipt_ocr_candidates, receipt_ocr_applications, export_jobs, object_cleanup_jobs, submission_versions, submission_question_scores, audit_logs, idempotency_keys, dish_records, other_records, audit_checkins, checkin_exemptions RESTART IDENTITY CASCADE`);
  await seedRbac(pool);
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

test("deleting a ready receipt from the UI succeeds, retains history, and the next upload reuses slot 1", async ({ page }) => {
  const attempt = await startAttempt();
  const pageRoot = await openDishes(page, attempt);
  // deleteReceipt 走 window.confirm：自动接受。
  page.on("dialog", (dialog) => dialog.accept());

  await page.setInputFiles('input[type="file"]', [
    { name: "receipt-a.png", mimeType: "image/png", buffer: PNG_A_BYTES },
    { name: "receipt-b.png", mimeType: "image/png", buffer: PNG_B_BYTES },
  ]);
  await expect(pageRoot).toContainText("2 张已完成");
  const rowsBefore = await receiptRows(attempt.attemptId);
  expect(rowsBefore.map((row) => Number(row.display_order)).sort()).toEqual([1, 2]);

  // 删除第一张（修复前：CHECK ready↔verified_at 违反 → 500）。
  await receiptCards(page).first().getByLabel("删除第1张消费小票").click();
  await expect(pageRoot).toContainText("1 张已完成");
  const rowsAfter = await receiptRows(attempt.attemptId);
  expect(rowsAfter.filter((row) => row.status === "deleted")).toHaveLength(1);
  const deletedRow = rowsAfter.find((row) => row.status === "deleted");
  // 历史元数据保留：verified_at/sha256/storage_key/display_order 原样。
  expect(deletedRow.verified_at).toBeTruthy();
  expect(deletedRow.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(deletedRow.storage_key).toBe(rowsBefore.find((row) => row.id === deletedRow.id).storage_key);
  expect(Number(deletedRow.display_order)).toBe(1);

  // 槽位复用：新上传落最小空闲位 1（修复前 count+1=3 撞唯一约束 500）。
  await page.setInputFiles('input[type="file"]', { name: "receipt-c.png", mimeType: "image/png", buffer: PNG_C_BYTES });
  await expect(pageRoot).toContainText("2 张已完成");
  const rowsFinal = await receiptRows(attempt.attemptId);
  expect(rowsFinal.filter((row) => row.status === "ready" && row.original_file_name === "receipt-c.png").map((row) => Number(row.display_order))).toEqual([1]);
});

test("pending removal with a known server attachment performs the authorized delete before clearing local state", async ({ page }) => {
  const attempt = await startAttempt();
  const pageRoot = await openDishes(page, attempt);
  const log = { requests: [], blocked: 0 };
  await observeReceiptTraffic(page, log);
  const blocker = await installStorageBlock(page, log);

  await page.setInputFiles('input[type="file"]', { name: "receipt-orphan.png", mimeType: "image/png", buffer: PNG_D_BYTES });
  const failedCard = receiptCards(page, "暂时无法上传小票");
  await expect(failedCard).toContainText("上传失败");
  const orphanRows = (await receiptRows(attempt.attemptId)).filter((row) => row.original_file_name === "receipt-orphan.png");
  expect(orphanRows.map((row) => row.status)).toEqual(["uploading"]); // init 已建服务端行

  blocker.active = false;
  await failedCard.getByLabel("移除待上传消费小票").click();
  // 授权软删先行：DELETE 发出、行置 deleted、本地项消失（无幽灵槽位）。
  await expect(failedCard).toHaveCount(0);
  expect(log.requests.filter((item) => item.kind === "delete")).toHaveLength(1);
  expect((await receiptRows(attempt.attemptId)).filter((row) => row.original_file_name === "receipt-orphan.png").map((row) => row.status)).toEqual(["deleted"]);

  // 槽位已释放：重选一张补位 1（修复前幽灵行占位、列表残留「上传中」）。
  await page.setInputFiles('input[type="file"]', { name: "receipt-refill.png", mimeType: "image/png", buffer: PNG_A_BYTES });
  await expect(pageRoot).toContainText("1 张已完成");
  expect((await receiptRows(attempt.attemptId)).filter((row) => row.original_file_name === "receipt-refill.png").map((row) => Number(row.display_order))).toEqual([1]);
});

test("failed removal keeps the pending item recoverable, then a retried removal completes the delete", async ({ page }) => {
  const attempt = await startAttempt();
  const pageRoot = await openDishes(page, attempt);
  const log = { requests: [], blocked: 0 };
  await observeReceiptTraffic(page, log);
  const blocker = await installStorageBlock(page, log);

  await page.setInputFiles('input[type="file"]', { name: "receipt-stuck.png", mimeType: "image/png", buffer: PNG_B_BYTES });
  const failedCard = receiptCards(page, "暂时无法上传小票");
  await expect(failedCard).toContainText("上传失败");
  blocker.active = false;

  // DELETE 网络失败：项保留为 failed（可读文案），不伪造删除成功、File/缓存不丢。
  let deleteAttempts = 0;
  await page.route("**/receipt-attachments/*", async (route) => {
    if (route.request().method() === "DELETE" && deleteAttempts === 0) {
      deleteAttempts += 1;
      await route.abort("connectionrefused");
      return;
    }
    await route.fallback();
  });
  await failedCard.getByLabel("移除待上传消费小票").click();
  const stuckCard = receiptCards(page, "暂时无法");
  await expect(stuckCard).toContainText("上传失败");
  expect((await receiptRows(attempt.attemptId)).filter((row) => row.original_file_name === "receipt-stuck.png").map((row) => row.status)).toEqual(["uploading"]);

  // 重试移除成功：服务端行 deleted、本地项消失（本用例无 ready 小票，卡片应清空）。
  // 第一次 DELETE 被客户端拦断（未达观察器），仅第二次成功请求被记录。
  await stuckCard.getByLabel("移除待上传消费小票").click();
  await expect(receiptCards(page)).toHaveCount(0);
  expect(deleteAttempts).toBe(1);
  expect(log.requests.filter((item) => item.kind === "delete")).toHaveLength(1);
  expect((await receiptRows(attempt.attemptId)).filter((row) => row.original_file_name === "receipt-stuck.png").map((row) => row.status)).toEqual(["deleted"]);
});

test("lost init response is reconciled by idempotent replay: removal soft-deletes the orphan row and frees quota", async ({ page }) => {
  const attempt = await startAttempt();
  const pageRoot = await openDishes(page, attempt);
  const log = { requests: [], blocked: 0 };
  await observeReceiptTraffic(page, log);
  // 首次 init 真实转发到 API（服务端事务已提交），响应以 504 网关超时形态丢失——
  // 页面收不到 attachmentId（生产形态：代理超时而上游已提交）。
  let initLost = false;
  await page.route("**/receipt-attachments/uploads", async (route) => {
    if (!initLost) {
      initLost = true;
      await route.fetch(); // 服务端事务已提交
      await route.fulfill({ status: 504, contentType: "text/plain", body: "gateway timeout" });
      return;
    }
    await route.fallback();
  });

  await page.setInputFiles('input[type="file"]', { name: "receipt-lost.png", mimeType: "image/png", buffer: PNG_A_BYTES });
  await expect(pageRoot).toContainText("服务暂时不可用");
  const orphanRows = (await receiptRows(attempt.attemptId)).filter((row) => row.original_file_name === "receipt-lost.png");
  expect(orphanRows.map((row) => row.status)).toEqual(["uploading"]); // init 已在服务端提交
  expect(log.requests.filter((item) => item.kind === "init")).toHaveLength(0); // 被拦响应未进观察器（真实请求数 1）

  // 整页刷新后移除（持久化 fileMeta+sha256 仍在，File 缓存已清）——恢复链路不得依赖 File 字节。
  await page.reload();
  await expect(page.locator('[data-page="dishes"]')).toHaveAttribute("data-state", "ready");
  const recoveredCard = receiptCards(page, "服务暂时不可用");
  await expect(recoveredCard).toContainText("上传失败");

  await recoveredCard.getByLabel("移除待上传消费小票").click();
  // 幂等重放找回同一行（不产生重复行）→ 授权软删 → 本地清理。
  await expect.poll(async () => (await receiptRows(attempt.attemptId)).filter((row) => row.original_file_name === "receipt-lost.png").map((row) => row.status)).toEqual(["deleted"]);
  const finalRows = await receiptRows(attempt.attemptId);
  expect(finalRows.filter((row) => row.original_file_name === "receipt-lost.png")).toHaveLength(1);
  await expect(receiptCards(page)).toHaveCount(0);
  expect((await receiptRows(attempt.attemptId)).filter((row) => row.status !== "deleted")).toHaveLength(0); // 无隐藏配额

  // 释放的槽位可立即复用并走完整链路。
  await page.setInputFiles('input[type="file"]', { name: "receipt-after-lost.png", mimeType: "image/png", buffer: PNG_B_BYTES });
  await expect(pageRoot).toContainText("1 张已完成");
  expect((await receiptRows(attempt.attemptId)).filter((row) => row.original_file_name === "receipt-after-lost.png").map((row) => Number(row.display_order))).toEqual([1]);
});

test("non-receipt 404 on removal preserves the pending item, its File preview and the server row", async ({ page }) => {
  const attempt = await startAttempt();
  const pageRoot = await openDishes(page, attempt);
  const log = { requests: [], blocked: 0 };
  await observeReceiptTraffic(page, log);
  const blocker = await installStorageBlock(page, log);

  await page.setInputFiles('input[type="file"]', { name: "receipt-keep.png", mimeType: "image/png", buffer: PNG_C_BYTES });
  const failedCard = receiptCards(page, "暂时无法上传小票");
  await expect(failedCard).toContainText("上传失败");
  blocker.active = false;

  // DELETE 返回与删除无关的 404（如 QUESTIONNAIRE_NOT_FOUND）：仅凭 validation kind 不得判定行已删。
  let preserveAttempts = 0;
  await page.route("**/receipt-attachments/*", async (route) => {
    if (route.request().method() === "DELETE" && preserveAttempts === 0) {
      preserveAttempts += 1;
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "QUESTIONNAIRE_NOT_FOUND", message: "问卷不存在" } }) });
      return;
    }
    await route.fallback();
  });
  await failedCard.getByLabel("移除待上传消费小票").click();
  // 待传项保留：File/blob 预览仍在（缓存未丢）、失败可读、服务端行原样。
  const keptCard = receiptCards(page, "上传失败");
  await expect(keptCard).toBeVisible();
  await expect(keptCard.locator('img[src^="blob:"]')).toHaveCount(1);
  expect((await receiptRows(attempt.attemptId)).filter((row) => row.original_file_name === "receipt-keep.png").map((row) => row.status)).toEqual(["uploading"]);

  // 重试移除（放行真实 DELETE）：成功清理，槽位释放可复用。
  await keptCard.getByLabel("移除待上传消费小票").click();
  await expect(receiptCards(page)).toHaveCount(0);
  expect(log.requests.filter((item) => item.kind === "delete")).toHaveLength(1);
  expect((await receiptRows(attempt.attemptId)).filter((row) => row.original_file_name === "receipt-keep.png").map((row) => row.status)).toEqual(["deleted"]);
  await page.setInputFiles('input[type="file"]', { name: "receipt-after-404.png", mimeType: "image/png", buffer: PNG_D_BYTES });
  await expect(pageRoot).toContainText("1 张已完成");
});

test("already-deleted server row (RECEIPT_NOT_FOUND) is removed idempotently without a stuck pending card", async ({ page }) => {
  const attempt = await startAttempt();
  const pageRoot = await openDishes(page, attempt);
  const log = { requests: [], blocked: 0 };
  await observeReceiptTraffic(page, log);
  const blocker = await installStorageBlock(page, log);

  await page.setInputFiles('input[type="file"]', { name: "receipt-gone.png", mimeType: "image/png", buffer: PNG_A_BYTES });
  const failedCard = receiptCards(page, "暂时无法上传小票");
  await expect(failedCard).toContainText("上传失败");
  blocker.active = false;

  // 另一会话已完成删除（行已置 deleted）：浏览器 DELETE 真实命中 RECEIPT_NOT_FOUND 404。
  await pool.query("UPDATE receipt_attachments SET status='deleted',deleted_at=now(),updated_at=now() WHERE attempt_id=$1 AND original_file_name='receipt-gone.png'", [attempt.attemptId]);

  await failedCard.getByLabel("移除待上传消费小票").click();
  await expect(receiptCards(page)).toHaveCount(0);
  expect(log.requests.filter((item) => item.kind === "delete")).toHaveLength(1);
  // 本地项已清理且无错误横幅（幂等移除，而非失败滞留）。
  await expect(page.locator('[data-page="dishes"] .error-bar')).toHaveCount(0);
});

test("deleting the middle of three leaves a gap the next upload fills; delete+reupload then submit with admin preview", async ({ page, playwright, baseURL }) => {
  const attempt = await startAttempt();
  const pageRoot = await openDishes(page, attempt);
  page.on("dialog", (dialog) => dialog.accept());
  const log = { requests: [] };
  await observeReceiptTraffic(page, log);

  await page.setInputFiles('input[type="file"]', [
    { name: "receipt-m1.png", mimeType: "image/png", buffer: PNG_A_BYTES },
    { name: "receipt-m2.png", mimeType: "image/png", buffer: PNG_B_BYTES },
    { name: "receipt-m3.png", mimeType: "image/png", buffer: PNG_C_BYTES },
  ]);
  await expect(pageRoot).toContainText("3 张已完成");
  const middleRow = (await receiptRows(attempt.attemptId)).find((row) => row.original_file_name === "receipt-m2.png");
  const middleIndex = (await receiptRows(attempt.attemptId)).filter((row) => row.status === "ready").findIndex((row) => row.id === middleRow.id);
  // UI 删除中间那张（第 2 个卡片）。
  await receiptCards(page).nth(middleIndex).getByLabel(`删除第${middleIndex + 1}张消费小票`).click();
  await expect(pageRoot).toContainText("2 张已完成");
  expect((await receiptRows(attempt.attemptId)).filter((row) => row.id === middleRow.id).map((row) => row.status)).toEqual(["deleted"]);

  // 新上传补位 2（缺口复用）。
  await page.setInputFiles('input[type="file"]', { name: "receipt-fill.png", mimeType: "image/png", buffer: PNG_D_BYTES });
  await expect(pageRoot).toContainText("3 张已完成");
  expect((await receiptRows(attempt.attemptId)).filter((row) => row.original_file_name === "receipt-fill.png").map((row) => Number(row.display_order))).toEqual([2]);

  // 删除→重传后真实提交（receipt_required 满足），管理端提交详情预览 ready 且字节可回读。
  await answerAllViaApi(attempt.attemptId);
  const assignmentRevision = Number((await pool.query("SELECT revision FROM audit_assignments WHERE id=$1", [attempt.assignmentId])).rows[0].revision);
  const submit = await api.post(`/api/questionnaires/secret/${attempt.attemptId}/submit`, { headers: { authorization: `Bearer ${world.accessToken}` }, data: { submitToken: uuidv7(), assignmentRevision, confirmation: true } });
  expect(submit.ok(), await submit.text()).toBeTruthy();
  const submissionId = (await pool.query("SELECT id FROM submission_versions WHERE attempt_id=$1", [attempt.attemptId])).rows[0].id;

  const admin = await playwright.request.newContext({ baseURL });
  const adminLogin = await admin.post("/api/admin/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } });
  expect(adminLogin.ok(), await adminLogin.text()).toBeTruthy();
  const detail = await admin.get(`/api/admin/submissions/${submissionId}`);
  expect(detail.ok(), await detail.text()).toBeTruthy();
  const comparisonReceipts = (await detail.json()).receiptComparison?.receipts || [];
  expect(comparisonReceipts).toHaveLength(3);
  expect(comparisonReceipts.every((receipt) => receipt.previewStatus === "ready")).toBe(true);
  const filled = comparisonReceipts.find((receipt) => receipt.displayOrder === 2);
  const thumbnail = await admin.get(filled.thumbnailUrl);
  expect(thumbnail.ok()).toBeTruthy();
  expect((await thumbnail.body()).equals(PNG_D_BYTES)).toBe(true);
  await admin.dispose();
});

async function answerAllViaApi(attemptId) {
  const questions = (await pool.query("SELECT id,max_score FROM questions WHERE version_id=$1 ORDER BY question_number", [world.questionnaireVersionId])).rows;
  for (const question of questions) {
    await pool.query("INSERT INTO question_answers (attempt_id,question_id,answer,awarded_score,issue_remark) VALUES ($1,$2,'scored',$3,'') ON CONFLICT (attempt_id,question_id) DO NOTHING", [attemptId, question.id, question.max_score]);
  }
}
