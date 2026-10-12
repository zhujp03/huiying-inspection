// H5 本地全流程浏览器回归（真实 API + 真实 junde_test + 真实本地磁盘文件）：
// 覆盖修复迭代 1 的三个问题——
//   问题2：证据上传 complete 后 attempt revision 就地前移，save()（PATCH→confirm）不再用旧 revision 409；
//          打开页面时采用服务端最新 revision 而非 URL 携带的过期值（本测试故意把 URL revision 传成 999）。
//   问题3：同一浏览器上下文里既登录 Admin（junde_admin_session cookie 落在 127.0.0.1:/api）又以
//          bearer 使用 H5——H5 请求必须显式 credentials:"omit"，否则服务端 AUTH_AMBIGUOUS 拒绝。
//   问题1（旁证）：上传走真实 /api/local-storage/objects 签名直传，落盘文件真实存在（本地存储回归）。
// 只允许 junde_test（shared.testDatabaseUrl 保险丝）。
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
  // 直接复用 shared 的保险丝逻辑（连接前先失败关闭）。
  testDatabaseUrl();
}

const PNG_BYTES = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(512, 0x42)]);
const config = {
  NODE_ENV: "test",
  AUTH_TOKEN_HMAC_KEY: H5_TEST_AUTH_KEY,
  PHONE_ENCRYPTION_KEY_BASE64: H5_TEST_PHONE_KEY,
};

let pool;
let world;

async function seedWorld() {
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
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-H5','H5测试门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, adminId]);
  const templateId = uuidv7(); const versionId = uuidv7(); const questionOne = uuidv7(); const questionTwo = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'H5本地浏览器回归问卷','secret',$2)", [templateId, adminId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_by,published_at) VALUES ($1,$2,1,'published',$3,$3,now())", [versionId, templateId, adminId]);
  await pool.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,sort_order) VALUES
    ($1,$2,'q1',1,'environment','浏览器证据题',2,true,1),($3,$2,'q2',2,'environment','普通题',3,true,2)`, [questionOne, versionId, questionTwo]);
  await pool.query(`INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count,image_max_count,audio_max_duration_seconds)
    VALUES ($1,true,true,false,1,0,3,10),($2,false,false,false,0,0,3,10)`, [questionOne, questionTwo]);
  const campaignId = uuidv7(); const assignmentId = uuidv7();
  const startsAt = new Date(Date.now() - 60_000); const dueAt = new Date(Date.now() + 3_600_000);
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,'C-H5','H5浏览器回归任务',$2,$3,$4,$5,'published',$6)", [campaignId, storeId, startsAt, dueAt, new Date(Date.now() + 7_200_000), adminId]);
  await pool.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,receipt_required,status,created_by)
    VALUES ($1,'A-H5',$2,$3,$4,'secret',$5,$6,0,false,'assigned',$7)`, [assignmentId, campaignId, inspectorId, versionId, startsAt, dueAt, adminId]);
  return { adminId, inspectorId, questionOne, questionTwo, assignmentId, questionnaireVersionId: versionId };
}

// 独立 cookie 隔离的 API 上下文：直接对 API（经 5199 反代）做种子/校验调用，互不污染浏览器 cookie。
let api;

test.beforeAll(async ({ playwright, baseURL }) => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
  await pool.query("SELECT 1 FROM users LIMIT 1"); // schema 未迁移时立即失败
  await pool.query(`TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users, questionnaire_templates, questionnaire_versions, questions, question_evidence_requirements, regions, stores, audit_campaigns, audit_assignments, survey_attempts, question_evidence_attachments, question_answer_edit_sessions, question_answer_edit_session_removals, receipt_attachments, receipt_ocr_jobs, receipt_ocr_job_attachments, receipt_ocr_candidates, receipt_ocr_applications, export_jobs, object_cleanup_jobs, submission_versions, submission_question_scores, audit_logs, idempotency_keys, dish_records, other_records, audit_checkins, checkin_exemptions RESTART IDENTITY CASCADE`);
  await seedRbac(pool);
  world = await seedWorld();
  api = await playwright.request.newContext({ baseURL });
  const login = await api.post("/api/auth/login", { data: { username: INSPECTOR_USERNAME, password: INSPECTOR_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const { accessToken } = await login.json();
  world.accessToken = accessToken;
  const checkin = await api.post(`/api/assignments/${world.assignmentId}/check-in`, { headers: { authorization: `Bearer ${accessToken}` }, data: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
  expect(checkin.ok(), await checkin.text()).toBeTruthy();
  const started = await api.post(`/api/assignments/${world.assignmentId}/start`, { headers: { authorization: `Bearer ${accessToken}` } });
  expect(started.ok(), await started.text()).toBeTruthy();
  world.attemptId = (await started.json()).attempt.id;
});

test.afterAll(async () => {
  await api?.dispose();
  await pool?.end();
});

test("issue page completes a real image upload and confirms with fresh revision while an Admin cookie is present", async ({ page, context, baseURL }) => {
  // 1) 同一浏览器上下文先登录 Admin：junde_admin_session cookie（host=127.0.0.1, path=/api）落地。
  const adminLogin = await context.request.post("/api/admin/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } });
  expect(adminLogin.ok(), await adminLogin.text()).toBeTruthy();
  // cookies() 不带 URL 过滤：cookie path=/api 与根路径不匹配会被过滤掉，这里只按名找。
  const cookies = await context.cookies();
  const adminCookie = cookies.find((cookie) => cookie.name === "junde_admin_session");
  expect(adminCookie, "admin cookie must be planted for the localhost host").toBeTruthy();
  expect(adminCookie.path).toBe("/api");

  // 2) 植入探员会话（真实 /api/auth/login 返回值），随后 H5 全部请求为 bearer+cookie 并存场景。
  const inspectorLogin = await context.request.post("/api/auth/login", { data: { username: INSPECTOR_USERNAME, password: INSPECTOR_PASSWORD } });
  expect(inspectorLogin.ok()).toBeTruthy();
  const session = await inspectorLogin.json();
  expect(session.accessToken).toBeTruthy();
  await page.addInitScript(([key, value]) => { window.localStorage.setItem(key, value); }, ["junde:session", JSON.stringify(session)]);

  // 3) 深链打开 issue 页（revision 故意传 999 过期值：修复必须以服务端草稿 revision 为准）。
  await page.goto(`/#/issue?assignmentId=${world.assignmentId}&attemptId=${world.attemptId}&questionnaireVersionId=${world.questionnaireVersionId}&questionId=${world.questionOne}&target=unscored&revision=999`);
  const pageRoot = page.locator('[data-page="issue"]');
  await expect(pageRoot).toHaveAttribute("data-state", "ready");
  // 编辑会话已建立（隐含 getQuestionnaire + createEditSession 都在 Admin cookie 同时存在下成功 = 问题3回归）。
  await expect(pageRoot).toContainText("浏览器证据题");

  // 4) 真实文件上传：init → 签名直传（本地磁盘）→ complete → staged_ready（UI 标签「上传成功」）。
  await page.setInputFiles('input[type="file"]', { name: "evidence.png", mimeType: "image/png", buffer: PNG_BYTES });
  await expect(pageRoot).toContainText("上传成功");

  // 5) 填写说明并确认：PATCH → confirm 全链用 latest revision（无 409），成功后返回问卷。
  await page.locator("textarea").fill("浏览器回归：证据与说明一次通过");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(pageRoot).toBeHidden({ timeout: 15_000 }); // goBack 离开 issue 页

  // 6) 服务端结果校验：答案 unscored + 说明入库 + 附件 active（磁盘对象已就位）。
  const draft = await api.get(`/api/questionnaires/secret/drafts/${world.attemptId}`, { headers: { authorization: `Bearer ${world.accessToken}` } });
  expect(draft.ok(), await draft.text()).toBeTruthy();
  const draftJson = await draft.json();
  const answer = draftJson.answers[world.questionOne];
  expect(answer.answer).toBe("unscored");
  expect(answer.remark).toBe("浏览器回归：证据与说明一次通过");
  expect(answer.attachments).toHaveLength(1);
  expect(answer.attachments[0]).toMatchObject({ status: "active", type: "image", mimeType: "image/png" });

  // 7) 附件落盘为真实本地文件（问题1旁证）：预览 URL 可取回上传的原始字节。
  const previewResponse = await api.get(answer.attachments[0].previewUrl);
  expect(previewResponse.ok()).toBeTruthy();
  const stored = await previewResponse.body();
  expect(stored.equals(PNG_BYTES)).toBe(true);
  expect(createHash("sha256").update(stored).digest("hex")).toBe(createHash("sha256").update(PNG_BYTES).digest("hex"));
});

test("upload and confirm still succeed with concurrent out-of-order completions (image + second image)", async ({ page, context }) => {
  const inspectorLogin = await context.request.post("/api/auth/login", { data: { username: INSPECTOR_USERNAME, password: INSPECTOR_PASSWORD } });
  const session = await inspectorLogin.json();
  await page.addInitScript(([key, value]) => { window.localStorage.setItem(key, value); }, ["junde:session", JSON.stringify(session)]);
  await page.goto(`/#/issue?assignmentId=${world.assignmentId}&attemptId=${world.attemptId}&questionnaireVersionId=${world.questionnaireVersionId}&questionId=${world.questionOne}&target=unscored&revision=0`);
  const pageRoot = page.locator('[data-page="issue"]');
  await expect(pageRoot).toHaveAttribute("data-state", "ready");
  // 基线：上一用例确认后留下的 active 附件数（本用例新增 2 张）。
  const baselineDraft = await api.get(`/api/questionnaires/secret/drafts/${world.attemptId}`, { headers: { authorization: `Bearer ${world.accessToken}` } });
  const baselineCount = ((await baselineDraft.json()).answers[world.questionOne]?.attachments || []).length;

  // 两张图并发上传（并发 init 各自授权 + 乱序 complete），随后 PATCH/confirm 必须以最新 revision 成功。
  await page.setInputFiles('input[type="file"]', [
    { name: "one.png", mimeType: "image/png", buffer: PNG_BYTES },
    { name: "two.png", mimeType: "image/png", buffer: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(640, 0x77)]) },
  ]);
  await expect(pageRoot).toContainText("上传成功");
  await page.locator("textarea").fill("并发上传乱序完成回归");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(pageRoot).toBeHidden({ timeout: 15_000 });

  const draft = await api.get(`/api/questionnaires/secret/drafts/${world.attemptId}`, { headers: { authorization: `Bearer ${world.accessToken}` } });
  expect(draft.ok(), await draft.text()).toBeTruthy();
  const answer = (await draft.json()).answers[world.questionOne];
  expect(answer.answer).toBe("unscored");
  expect(answer.remark).toBe("并发上传乱序完成回归");
  expect(answer.attachments).toHaveLength(baselineCount + 2);
});

test("same-browser admin cookie + H5 bearer: default-credentials fetch is rejected, omit-credentials works", async ({ page, context, baseURL }) => {
  // 植入 Admin cookie（127.0.0.1, path=/api）与探员会话。
  const adminLogin = await context.request.post("/api/admin/auth/login", { data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } });
  expect(adminLogin.ok()).toBeTruthy();
  const inspectorLogin = await context.request.post("/api/auth/login", { data: { username: INSPECTOR_USERNAME, password: INSPECTOR_PASSWORD } });
  const session = await inspectorLogin.json();
  await page.addInitScript(([key, value]) => { window.localStorage.setItem(key, value); }, ["junde:session", JSON.stringify(session)]);
  await page.goto("/#/login");
  await page.waitForFunction(() => Boolean(window.localStorage.getItem("junde:session")));

  // 默认 credentials（same-origin → 携带 admin cookie + bearer）：服务端 AUTH_AMBIGUOUS 故意拒绝（行为保留）。
  const ambiguous = await page.evaluate(async (token) => {
    const response = await fetch("/api/assignments/mine", { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
    return { status: response.status, code: (await response.json())?.error?.code };
  }, session.accessToken);
  expect(ambiguous.status).toBe(400);
  expect(ambiguous.code).toBe("AUTH_AMBIGUOUS");

  // H5 适配层的实现方式：credentials:"omit" → 只带 bearer，请求成功（问题3修复的行为证明）。
  const omitted = await page.evaluate(async (token) => {
    const response = await fetch("/api/assignments/mine", { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, credentials: "omit" });
    return { status: response.status, count: (await response.json())?.items?.length };
  }, session.accessToken);
  expect(omitted.status).toBe(200);
  expect(omitted.count).toBeGreaterThan(0);
});
