// 「微信开发者工具模拟器 + 真实 API + 真实库」对齐验收环境搭建（S 组产物，R/Q 组复用）。
//
// 拓扑：小程序（开发者工具模拟器，临时项目副本）
//        │ apiBase = http://127.0.0.1:3100（同时是签名直传 uploadTarget 的 origin）
//        ▼
//      故障注入代理 :3100（tests/e2e/parity/fault-proxy.mjs）
//        ▼
//      真实 API :3000（NODE_ENV=development + AUTH_PROVIDER_MODE=sandbox + STORAGE_PROVIDER=local）
//        ▼
//      PostgreSQL :5433 / 库 junde_realapi（每次 bootstrap 删库重建 + 全量迁移 + seedRbac）
//
// 直传走代理的方案：给 API 进程注入 PUBLIC_API_ORIGIN=http://127.0.0.1:3100，本地存储
// Provider 的 createPostTarget 用它拼 uploadTarget.url（签名只覆盖 formData 字段、不覆盖
// URL），因此签名直传天然经过代理，无需拦截改写、不改任何业务代码。
// 打卡处理方式：不走管理员接口、不直接改库——用真实 HTTP 打卡（门店坐标）拿到 accepted，
// 再 POST /start 创建 attempt（与小程序真实链路完全一致）。
// 安全边界：只连回环地址；数据库只经 deriveRealApiTestDatabaseUrl 派生的 junde_realapi；
// 日志不输出 token/密码（测试账号密码只在本文件内用于真实接口，不打印）。
import assert from "node:assert/strict";
import { execSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import pg from "pg";
import { createPasswordService } from "../../../apps/api/src/auth/passwords.js";
import { uuidv7 } from "../../../apps/api/src/ids.js";
import { seedRbac } from "../../../db/seeds/rbac.mjs";
import { deriveRealApiTestDatabaseUrl, loadRootEnvFile, postgresAdminUrl } from "../real-api-database.mjs";
import { startFaultProxy } from "./fault-proxy.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

// 小程序运行时注入约定（R/Q 组直接用这两个常量，勿手写）。
export const SESSION_STORAGE_KEY = "junde:session";
export const PARITY_PUBLIC_CONFIG = { features: { receiptOcr: false, dishRecords: true } };

const API_PORT = Number(process.env.PARITY_API_PORT || 3000);
const PROXY_PORT = Number(process.env.PARITY_PROXY_PORT || 3100);
const FIXED_CODE = "246810";
const INSPECTOR_USERNAME = "parityinspector1";
const INSPECTOR_PASSWORD = "Parity.Inspect1";
const INSPECTOR_PHONE = "13800138000";
const ADMIN_USERNAME = "ParityAdmin";
const ADMIN_PASSWORD = "ParityAdmin1";
const STORE_COORDS = { latitude: 31.2304, longitude: 121.4737 };
const QUESTION_COUNT = 4; // ≥3 道题、分属 2 个分类（environment×2 + service×2）

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const json = async (url, options = {}) => {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  return { status: response.status, body, headers: response.headers };
};

let state = null; // 进程内单例：null = 未 bootstrap；否则复用（fresh 只新建 attempt）。

// ---- 对外入口：setupParityEnv({ fresh }) ----
// fresh=false（默认）：首次调用做完整 bootstrap；已存在则原样复用（同一 attempt）。
// fresh=true：已存在时只新建「campaign+assignment+打卡+attempt」（同一探员/问卷/门店，
// 场景间互不影响；堆栈不重建）；未 bootstrap 时等价于首次调用。
export async function setupParityEnv({ fresh = false } = {}) {
  if (!state) {
    state = await bootstrap();
    return view(state);
  }
  if (fresh) {
    state.assignment = await createAssignmentAttempt(state);
  }
  return view(state);
}

function view(current) {
  return {
    apiBase: current.proxyBase, // 小程序/测试统一从这里走（代理）
    proxyBase: current.proxyBase,
    upstreamBase: current.apiBase, // 真实 API 直连地址（绕过代理，健康检查用）
    uploadTargetOrigin: current.proxyBase, // 签名直传 uploadTarget.url 的 origin（经代理）
    inspector: { id: current.inspectorId, username: current.inspectorUsername, session: current.session },
    assignment: current.assignment,
    proxy: current.proxy,
    pool: current.pool,
    localStorageDir: current.localStorageDir,
    async teardown() {
      if (current.torndown) return;
      current.torndown = true;
      try { await current.proxy.close(); } catch { /* 已关闭 */ }
      current.apiProcess.kill("SIGTERM");
      await current.pool.end();
      if (state === current) state = null;
    },
  };
}

// ---- 1. 数据库：派生隔离库 → 删库重建 → 全量迁移 → seedRbac → 管理员 ----
async function bootstrapDatabase() {
  loadRootEnvFile(join(projectRoot, ".env"));
  const dbUrl = deriveRealApiTestDatabaseUrl({
    databaseUrl: process.env.REAL_API_DATABASE_URL || process.env.DATABASE_URL,
    adminDatabaseUrl: process.env.REAL_API_ADMIN_DATABASE_URL || process.env.DATABASE_URL,
  });
  const adminPool = new pg.Pool({ connectionString: postgresAdminUrl(process.env.REAL_API_ADMIN_DATABASE_URL || process.env.DATABASE_URL), max: 1 });
  await adminPool.query("DROP DATABASE IF EXISTS junde_realapi");
  await adminPool.query("CREATE DATABASE junde_realapi");
  await adminPool.end();

  const pool = new pg.Pool({ connectionString: dbUrl, max: 5 });
  const { readdir, readFile } = await import("node:fs/promises");
  const migrations = (await readdir(join(projectRoot, "db/migrations"))).filter((name) => name.endsWith(".sql")).sort();
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const name of migrations) {
    const sql = await readFile(join(projectRoot, "db/migrations", name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const exists = await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]);
    if (exists.rowCount) continue;
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1,$2)", [name, checksum]);
  }
  await client.query("COMMIT");
  client.release();
  await seedRbac(pool);

  const adminId = uuidv7();
  await pool.query(
    "INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status) VALUES ($1,'ParityAdmin','parityadmin','对齐管理员','cipher','lookup',now(),$2,'approved_active')",
    [adminId, await createPasswordService().hash(ADMIN_PASSWORD)],
  );
  const role = await pool.query("SELECT id FROM roles WHERE code='super_admin'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), adminId, role.rows[0].id]);
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
  return { pool, adminId, dbUrl };
}

// ---- 2. 进程：清理端口残留 → 起 API（本地磁盘存储 + 直传 origin 指向代理）→ 起代理 ----
function freePort(port) {
  try { execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`); } catch { /* 无 lsof 或无占用 */ }
}

async function startApi(dbUrl, localStorageDir) {
  freePort(API_PORT);
  freePort(PROXY_PORT);
  await sleep(1000);
  const env = {
    ...process.env,
    NODE_ENV: "development", HOST: "127.0.0.1", PORT: String(API_PORT),
    DATABASE_URL: dbUrl,
    AUTH_TOKEN_HMAC_KEY: "parity-test-key-parity-test-key-1234",
    PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 9).toString("base64"),
    AUTH_PROVIDER_MODE: "sandbox",
    SMS_SANDBOX_WHITELIST_PHONES: "+8613800138000",
    SMS_SANDBOX_FIXED_CODE: FIXED_CODE,
    ADMIN_ORIGIN: "http://127.0.0.1:4184",
    STORAGE_PROVIDER: "local",
    LOCAL_STORAGE_DIR: localStorageDir,
    PUBLIC_API_ORIGIN: `http://127.0.0.1:${PROXY_PORT}`, // 直传 uploadTarget.url 指向代理
  };
  const apiLogRef = { text: "" };
  const apiProcess = spawn(process.execPath, [join(projectRoot, "apps/api/src/server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  apiProcess.stdout.on("data", (chunk) => { apiLogRef.text += chunk; });
  apiProcess.stderr.on("data", (chunk) => { apiLogRef.text += chunk; });
  const apiBase = `http://127.0.0.1:${API_PORT}`;
  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
    try {
      const health = await json(`${apiBase}/health/ready`);
      ready = health.status === 200;
    } catch { /* 未就绪 */ }
    if (!ready) await sleep(500);
  }
  assert.ok(ready, `parity API did not become ready:\n${apiLogRef.text.slice(-800)}`);
  return { apiProcess, apiBase, apiLogRef };
}

// ---- 3. 造数：全部走真实 HTTP（且统一经代理，代理 hits 可观测每一步） ----
async function adminLogin(base) {
  const login = await json(`${base}/api/admin/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200, `admin login failed: ${JSON.stringify(login.body)}`);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const csrfToken = login.body.csrfToken;
  return {
    cookie,
    // 每次调用生成新 idempotency-key：避免跨场景复用同键导致幂等重放旧响应。
    headers() {
      return { cookie, "x-csrf-token": csrfToken, "idempotency-key": uuidv7(), "content-type": "application/json" };
    },
  };
}

async function ensureStore(base, adminAuth, pool) {
  const existing = await json(`${base}/api/admin/stores`, { headers: adminAuth.headers() });
  assert.equal(existing.status, 200);
  const found = (existing.body.items || []).find((item) => item.name === "对齐验收门店");
  if (found) return found.id;
  const provinceId = uuidv7();
  const cityId = uuidv7();
  const regionId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','sh-parity',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,level,parent_id) VALUES ($1,'上海市直辖园区','sh-parity-city',2,$2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,level,parent_id) VALUES ($1,'浦东测试区','sh-parity-pudong',3,$2)", [regionId, cityId]);
  const brand = await json(`${base}/api/admin/brands`, { method: "POST", headers: adminAuth.headers(), body: JSON.stringify({ name: "对齐验收品牌", active: true }) });
  assert.equal(brand.status, 201, `create brand failed: ${JSON.stringify(brand.body)}`);
  const brandId = brand.body.brand?.id || brand.body.id;
  const created = await json(`${base}/api/admin/stores`, {
    method: "POST", headers: adminAuth.headers(),
    body: JSON.stringify({ name: "对齐验收门店", businessNo: "S-PARITY", brandId, regionId, address: "上海市测试路1号", latitudeGcj02: STORE_COORDS.latitude, longitudeGcj02: STORE_COORDS.longitude, providerPoiId: null, coordinateSource: "manual_adjusted", radiusMeters: 300, accuracyAllowanceMaxMeters: 200, locationVerified: true, active: true }),
  });
  assert.equal(created.status, 201, `create store failed: ${JSON.stringify(created.body)}`);
  return created.body.store?.id || created.body.id;
}

async function createQuestionnaire(base, adminAuth, adminId, pool) {
  const templateId = uuidv7();
  const versionId = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'对齐验收题库','secret',$2)", [templateId, adminId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by) VALUES ($1,$2,1,'draft',$3)", [versionId, templateId, adminId]);
  for (let number = 1; number <= QUESTION_COUNT; number += 1) {
    const id = uuidv7();
    const category = number <= 2 ? "environment" : "service";
    await pool.query("INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,sort_order) VALUES ($1,$2,$3,$4,$5,$6,2,$4)", [id, versionId, `q-${number}`, number, category, `第 ${number} 题`]);
    await pool.query("INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count) VALUES ($1,false,false,false,0,0)", [id]);
  }
  const published = await json(`${base}/api/admin/questionnaire-versions/${versionId}/publish`, { method: "POST", headers: adminAuth.headers(), body: JSON.stringify({ revision: 0 }) });
  assert.equal(published.status, 200, `publish questionnaire failed: ${JSON.stringify(published.body)}`);
  return versionId;
}

async function createApprovedInspector(base, adminAuth, pool) {
  const code = await json(`${base}/api/auth/register/phone-code`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: INSPECTOR_PHONE, captchaTicket: "sandbox-parity-ticket", captchaRandstr: "parity-randstr", deviceFingerprint: "parity-device-fingerprint" }),
  });
  assert.equal(code.status, 200, `register phone-code failed: ${JSON.stringify(code.body)}`);
  const registered = await json(`${base}/api/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: INSPECTOR_USERNAME, phone: INSPECTOR_PHONE, password: INSPECTOR_PASSWORD, confirmPassword: INSPECTOR_PASSWORD, phoneChallengeId: code.body.phoneChallengeId, smsCode: FIXED_CODE }),
  });
  assert.equal(registered.status, 201, `register failed: ${JSON.stringify(registered.body)}`);
  const list = await json(`${base}/api/admin/inspector-registrations`, { headers: adminAuth.headers() });
  const pending = (list.body.items || []).find((item) => item.username === INSPECTOR_USERNAME);
  assert.ok(pending, "pending registration not listed");
  const approved = await json(`${base}/api/admin/inspector-registrations/${pending.id}/approve`, { method: "POST", headers: adminAuth.headers(), body: JSON.stringify({ revision: pending.revision }) });
  assert.equal(approved.status, 200, `approve failed: ${JSON.stringify(approved.body)}`);
  const inspectorId = (await pool.query("SELECT id FROM users WHERE username_normalized=$1", [INSPECTOR_USERNAME])).rows[0].id;
  return inspectorId;
}

async function inspectorLogin(base) {
  const login = await json(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: INSPECTOR_USERNAME, password: INSPECTOR_PASSWORD }),
  });
  assert.equal(login.status, 200, `inspector login failed: ${JSON.stringify(login.body)}`);
  // 小程序 junde:session 存储同构：{ accessToken, user: { id, displayName, status } }
  assert.ok(login.body.accessToken && login.body.user?.id, "login response missing accessToken/user");
  return { accessToken: login.body.accessToken, user: login.body.user };
}

// 一个完整任务场景：campaign+assignment(receiptRequired) 发布 → 真实 HTTP 打卡（门店坐标）
// → /start 创建 attempt。fresh=true 每次走这里，得到互不影响的新 attempt。
async function createAssignmentAttempt(current) {
  const base = current.proxyBase;
  const startsAt = new Date(Date.now() - 60_000).toISOString();
  const dueAt = new Date(Date.now() + 3_600_000).toISOString();
  const campaign = await json(`${base}/api/admin/campaigns`, {
    method: "POST", headers: current.adminAuth.headers(),
    body: JSON.stringify({ name: `对齐验收任务-${Date.now()}`, storeId: current.storeId, startsAt, dueAt, questionnaireDeadlineAt: new Date(Date.now() + 7_200_000).toISOString(), commonInstruction: "对齐验收" }),
  });
  assert.equal(campaign.status, 201, `create campaign failed: ${JSON.stringify(campaign.body)}`);
  const created = await json(`${base}/api/admin/campaigns/${campaign.body.campaign.id}/assignments`, {
    method: "POST", headers: current.adminAuth.headers(),
    body: JSON.stringify({ inspectorId: current.inspectorId, questionnaireVersionId: current.questionnaireVersionId, taskType: "secret", startsAt, dueAt, budgetLimit: 0, receiptRequired: true, specialInstruction: "", dishRequirements: [], campaignRevision: 0 }),
  });
  assert.equal(created.status, 201, `create assignment failed: ${JSON.stringify(created.body)}`);
  const assignmentId = created.body.id;
  const publish = await json(`${base}/api/admin/campaigns/${campaign.body.campaign.id}/publish`, { method: "POST", headers: current.adminAuth.headers(), body: JSON.stringify({ revision: 1 }) });
  assert.equal(publish.status, 200, `publish campaign failed: ${JSON.stringify(publish.body)}`);

  const inspectorAuth = { authorization: `Bearer ${current.session.accessToken}`, "content-type": "application/json" };
  const checkin = await json(`${base}/api/assignments/${assignmentId}/check-in`, {
    method: "POST", headers: inspectorAuth,
    body: JSON.stringify({ latitude: STORE_COORDS.latitude, longitude: STORE_COORDS.longitude, accuracy: 10, capturedAt: new Date().toISOString() }),
  });
  assert.equal(checkin.body?.result, "accepted", `check-in not accepted: ${JSON.stringify(checkin.body)}`);
  const start = await json(`${base}/api/assignments/${assignmentId}/start`, { method: "POST", headers: { authorization: `Bearer ${current.session.accessToken}` } });
  assert.ok(start.body?.attempt?.id, `start failed: ${JSON.stringify(start.body)}`);
  return {
    assignmentId,
    attemptId: start.body.attempt.id,
    questionnaireVersionId: current.questionnaireVersionId,
    revision: Number(start.body.attempt.revision),
    campaignId: campaign.body.campaign.id,
    storeId: current.storeId,
    attemptStatus: start.body.attempt.status,
  };
}

// ---- 4. 完整 bootstrap：库 → API → 代理 → 基础数据 → 首个任务场景 ----
async function bootstrap() {
  const { pool, adminId, dbUrl } = await bootstrapDatabase();
  const localStorageDir = mkdtempSync(join(tmpdir(), "junde-parity-storage-"));
  const { apiProcess, apiBase, apiLogRef } = await startApi(dbUrl, localStorageDir);
  const proxy = await startFaultProxy({ target: apiBase, port: PROXY_PORT });
  const proxyBase = `http://127.0.0.1:${PROXY_PORT}`;
  const current = {
    pool, apiProcess, apiBase, proxyBase, proxy, apiLogRef, localStorageDir, torndown: false,
    adminAuth: null, inspectorId: null, inspectorUsername: INSPECTOR_USERNAME,
    questionnaireVersionId: null, storeId: null, session: null, assignment: null,
  };
  // bootstrap 中途失败立即反序回收（代理/API/连接池），不留孤儿进程与半开环境。
  try {
    current.adminAuth = await adminLogin(proxyBase);
    current.storeId = await ensureStore(proxyBase, current.adminAuth, pool);
    current.questionnaireVersionId = await createQuestionnaire(proxyBase, current.adminAuth, adminId, pool);
    current.inspectorId = await createApprovedInspector(proxyBase, current.adminAuth, pool);
    current.session = await inspectorLogin(proxyBase);
    current.assignment = await createAssignmentAttempt(current);
  } catch (error) {
    try { await proxy.close(); } catch { /* 已关闭 */ }
    apiProcess.kill("SIGTERM");
    await pool.end();
    throw error;
  }
  return current;
}

// ---- 冒烟自测：node tests/e2e/parity/env.mjs --smoke ----
// setup → 临时项目副本（副本内 runtime-config 改指代理，保证冷启动请求只打回环）
// → automator 打开问卷页（注入 session/publicConfig）→ 断言 loading=false 且题目数≥3
// → （经代理的签名直传三步真实小票上传，跑在一次性 fresh attempt 上）→ teardown。
// 进度走 stderr（无缓冲），结果与输出原文由运行方 tee 到 /Users/michaelzhu/Documents/agent-reports/miniapp-parity-e2e/。
const withTimeout = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms))]);

// IDE Stable 2.01.2510290 已知回归：`cli auto` 冷启动 IDE 时自动化引擎的 App.* 路由不接线
// （Tool.* 有应答、App.* 永不应答，仓库 miniapp-receipt-native.cjs 同样卡死）；对已运行的 IDE
// 再次执行 `cli auto`（附加模式）即可接通。此函数只影响测试工具链，不改任何业务代码。
const attachAutomationSession = (projectPath, cliPath) => {
  const result = spawnSync(cliPath, ["auto", "--project", projectPath, "--auto-port", "9420", "--trust-project"], { encoding: "utf8", timeout: 90000 });
  const tail = `${result.stdout || ""}${result.stderr || ""}`.split("\n").filter(Boolean).slice(-2).join(" | ");
  console.error(`[smoke] cli auto attach: ${tail}`);
};

async function runSmoke() {
  const results = [];
  const record = (name, passed, detail = "") => { results.push({ name, passed }); console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
  const requireFromRoot = createRequire(join(projectRoot, "package.json"));
  requireFromRoot("./tests/e2e/automator-compat.cjs");
  const automator = requireFromRoot("miniprogram-automator");
  const { prepareMiniappProjectForFixture, stopDevTools } = requireFromRoot("./tests/e2e/prepare-miniapp-fixture.cjs");
  const cliPath = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";

  let env = null;
  let fixtureProject = null;
  let miniProgram = null;
  const exceptions = [];
  try {
    env = await setupParityEnv();
    const { assignmentId, attemptId, questionnaireVersionId, revision } = env.assignment;
    console.error(`[smoke] env ready: apiBase=${env.apiBase} upstream=${env.upstreamBase} attempt=${attemptId}`);

    // 直传链路真实冒烟：在一次性 fresh attempt 上做 init→multipart 直传→complete 三步，
    // 验证 uploadTarget.url 指向代理且签名跨代理有效；主 attempt 保持 pristine 给下游。
    const throwaway = await setupParityEnv({ fresh: true });
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 7)]);
    const sha256 = createHash("sha256").update(png).digest("hex");
    const fileMeta = { clientFileId: uuidv7(), fileName: "smoke-receipt.png", mimeType: "image/png", sizeBytes: png.length, sha256 };
    const init = await json(`${env.apiBase}/api/questionnaires/secret/drafts/${throwaway.assignment.attemptId}/receipt-attachments/uploads`, {
      method: "POST", headers: { authorization: `Bearer ${env.inspector.session.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ fileMeta, revision: throwaway.assignment.revision }),
    });
    record("receipt upload init via proxy", init.status === 201 && init.body.uploadTarget?.url?.startsWith(env.uploadTargetOrigin), JSON.stringify({ status: init.status, url: init.body.uploadTarget?.url }));
    if (init.body?.uploadTarget?.url) {
      const form = new FormData();
      for (const [key, value] of Object.entries(init.body.uploadTarget.formData)) form.append(key, String(value));
      form.append("file", new Blob([png]), fileMeta.fileName);
      const upload = await fetch(init.body.uploadTarget.url, { method: "POST", body: form });
      record("signed direct upload through proxy", upload.status === 204, `status=${upload.status}`);
      const complete = await json(`${env.apiBase}/api/questionnaires/secret/drafts/${throwaway.assignment.attemptId}/receipt-attachments/${init.body.attachment.id}/complete`, {
        method: "POST", headers: { authorization: `Bearer ${env.inspector.session.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ fileMeta, revision: init.body.revision }),
      });
      record("receipt complete via proxy (object ready)", complete.status === 200 && complete.body.attachment?.status === "ready", JSON.stringify({ status: complete.status, attachmentStatus: complete.body.attachment?.status }));
    }
    const uploadHits = env.proxy.hits({ method: "POST", path: /\/api\/local-storage\/objects/ });
    record("proxy observed direct upload", uploadHits.count >= 1, `hits=${uploadHits.count}`);
    // 一次性 attempt 不需要也不调用 teardown（teardown 作用于整个共享环境）；
    // 场景隔离靠 attempt 本身，残留数据在下次 bootstrap 删库时一并清掉。

    // 开发者工具：临时项目副本 + 会话/配置运行时注入。
    console.error("[smoke] preparing fixture project copy...");
    fixtureProject = await prepareMiniappProjectForFixture();
    // fixture 副本内重写 runtime-config（仓库源文件不动）：apiBase 指向代理。依据：
    // 1) 仓库现值是手写局域网地址（http://192.168.0.172:3000），小程序冷启动 loadPublicConfig
    //    会打到非回环地址，违反「只连回环」边界；
    // 2) 实测该局域网 apiBase 使模拟器首屏崩溃（TypeError: The "path" argument must be of
    //    type string. Received undefined，见冒烟留档），改回环后首屏恢复正常。
    const runtimeConfigPath = join(fixtureProject.projectPath, "miniprogram", "runtime-config.generated.js");
    await writeFile(runtimeConfigPath, `// parity fixture copy: loopback-only apiBase（指向故障注入代理）\nexport const RUNTIME_CONFIG = Object.freeze({ apiBase: ${JSON.stringify(env.apiBase)} });\n`);

    for (let attempt = 1; attempt <= 3 && !miniProgram; attempt += 1) {
      await stopDevTools();
      console.error(`[smoke] devtools launch attempt ${attempt}...`);
      try {
        const launchedSession = await withTimeout(automator.launch({ cliPath, projectPath: fixtureProject.projectPath, trustProject: true, timeout: 300000 }), 340000, "launch");
        console.error(`[smoke] launch returned session=${Boolean(launchedSession)}, attaching fresh automation session...`);
        attachAutomationSession(fixtureProject.projectPath, cliPath);
        try { launchedSession?.disconnect?.(); } catch { /* 已断开 */ }
        // attach 会让 IDE 重启 9420 自动化服务（先拒连、再初始化、约数秒后可用），退避重试连接。
        for (let connectTry = 1; connectTry <= 12 && !miniProgram; connectTry += 1) {
          try {
            const session = await withTimeout(automator.connect({ wsEndpoint: "ws://127.0.0.1:9420" }), 15000, "connect");
            await withTimeout(session.systemInfo(), 20000, "engine probe");
            miniProgram = session;
          } catch {
            try { miniProgram?.disconnect?.(); } catch { /* 未建立 */ }
            miniProgram = null;
            await sleep(2000);
          }
        }
      } catch (error) {
        console.error(`[smoke] attempt ${attempt} failed: ${String(error.message).slice(0, 200)}`);
        try { miniProgram?.disconnect?.(); } catch { /* 未建立 */ }
        miniProgram = null;
        if (attempt < 3) await sleep(10000);
      }
      if (miniProgram) console.error("[smoke] automation engine responds (Tool+App layers)");
    }
    assert.ok(miniProgram, "unable to launch WeChat DevTools for parity smoke");
    miniProgram.on("exception", (entry) => exceptions.push(entry));
    await withTimeout(miniProgram.callWxMethod("setStorageSync", SESSION_STORAGE_KEY, env.inspector.session), 30000, "setStorageSync");
    await withTimeout(miniProgram.evaluate(({ session, publicConfig, storageKey }) => {
      getApp().globalData.session = session || wx.getStorageSync(storageKey);
      getApp().globalData.publicConfig = publicConfig;
    }, { session: null, publicConfig: PARITY_PUBLIC_CONFIG, storageKey: SESSION_STORAGE_KEY }), 30000, "inject globals");

    // 问卷页：等 loading=false 且题目数正确（apiBase 已由 fixture 副本的 runtime-config 指向代理）。
    console.error("[smoke] opening survey page...");
    const route = `/pages/survey/index?assignmentId=${assignmentId}&attemptId=${attemptId}&questionnaireVersionId=${questionnaireVersionId}&revision=${revision}`;
    await withTimeout(miniProgram.reLaunch(route), 30000, "reLaunch");
    const started = Date.now();
    let snapshot = await withTimeout(surveySnapshot(miniProgram), 30000, "snapshot");
    while ((snapshot.route !== "pages/survey/index" || snapshot.loading !== false) && Date.now() - started < 30000) {
      await sleep(300);
      snapshot = await withTimeout(surveySnapshot(miniProgram), 30000, "snapshot");
    }
    record("survey page loaded (loading=false)", snapshot.route === "pages/survey/index" && snapshot.loading === false, JSON.stringify({ route: snapshot.route, loading: snapshot.loading, error: snapshot.error }));
    record("survey error empty", snapshot.error === "", JSON.stringify(snapshot.error));
    record("question count >= 3", (snapshot.questions || []).length >= 3, `count=${(snapshot.questions || []).length}`);
    record("categories >= 2", (snapshot.categories || []).length >= 2, `categories=${JSON.stringify(snapshot.categories)}`);
    record("publicConfig injected (receiptOcr=false)", snapshot.publicConfig?.features?.receiptOcr === false, JSON.stringify(snapshot.publicConfig?.features || null));
    const questionnaireHits = env.proxy.hits({ method: "GET", path: new RegExp(`/api/assignments/${assignmentId}/questionnaire$`) });
    record("questionnaire request went through proxy", questionnaireHits.count >= 1, `hits=${questionnaireHits.count}`);
    record("no miniapp runtime exceptions", exceptions.length === 0, `exceptions=${exceptions.length}`);
    const passed = results.filter((item) => item.passed).length;
    console.log(`\nparity env smoke: ${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
  } catch (error) {
    console.error("parity env smoke FAILED:", error);
    process.exitCode = 1;
  } finally {
    if (miniProgram) { try { miniProgram.disconnect(); } catch { /* 已断开 */ } }
    if (fixtureProject) await fixtureProject.cleanup();
    await stopDevTools();
    if (env) await env.teardown();
  }
}

async function surveySnapshot(miniProgram) {
  return miniProgram.evaluate(() => {
    const page = getCurrentPages().slice(-1)[0];
    return {
      route: page?.route,
      loading: page?.data?.loading,
      error: page?.data?.error || "",
      questions: page?.data?.questions || [],
      categories: page?.data?.categories || [],
      publicConfig: getApp()?.globalData?.publicConfig || null,
    };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--smoke")) {
  await runSmoke();
}
