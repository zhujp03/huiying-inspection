import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { encrypt, hmac, normalizePhone } from "../../apps/api/src/auth/crypto.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";
import { uuidv7 } from "../../apps/api/src/ids.js";
import { loadSubmissionExportModel, buildSubmissionExportModel, buildSubmissionWorkbook } from "../../apps/worker/src/submission-export.js";

import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

// 集成测试会清空业务表：误指向开发库时立即失败而不是清空数据。
assertIntegrationTestDatabase();

// 2026-10 问卷 UX 六项变更的焦点集成回归：
//   1) 无闪光点 / 无菜品 / 不得分无照片 的提交不再被任何旧必填配置阻断；
//   2) 不得分照片默认上限 4（第 5 张 init 拒绝）；历史 >4 张的照片保留可确认可提交、只禁新增；
//   3) 多条闪光点（文字+照片）保存/重载/提交快照/管理端详情/单份导出全链路；历史单条 highlight 兜底；
//   4) 越权（他人条目/他人问卷）与提交后写入全部拒绝。
// 存储替身与 evidence-limits.postgres.test.js 同构（createPostTarget/verifyObject/newObjectSuffix）。

const connectionString = process.env.DATABASE_URL;
const test = connectionString ? it : it.skip;
const pool = connectionString ? new pg.Pool({ connectionString, max: 10 }) : null;
let databaseLock = null;
const config = {
  NODE_ENV: "test", AUTH_HASH_MAX_CONCURRENCY: 2, AUTH_HASH_MAX_QUEUE: 8,
  AUTH_TOKEN_HMAC_KEY: "auth-test-key-auth-test-key-auth-test-key", PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
};
const providers = { verifyCaptcha: async () => true, sendSms: async () => ({ messageId: "test-message" }) };
const storage = {
  exportConfigured: true,
  newObjectSuffix: () => "test-object",
  createPostTarget: ({ key }) => ({ method: "POST", url: "https://private.example.test", fileFieldName: "file", formData: { key }, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  verifyObject: async ({ key, expectedSizeBytes }) => ({ sizeBytes: expectedSizeBytes, mimeType: "image/jpeg", sha256: createHash("sha256").update(String(key)).digest("hex"), storageVersionId: "version-one", durationSeconds: null }),
  createPreviewUrl: async (key) => ({ url: `https://preview.example.test/${encodeURIComponent(key)}?sig=1`, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  verifyStoredObject: async () => true,
};

const receiptMeta = (clientFileId, overrides = {}) => ({ clientFileId, fileName: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 2048, ...overrides });
const stageImage = async (app, headers, attemptId, questionId, sessionId, clientFileId) => {
  const init = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${sessionId}/evidence-uploads`, headers, payload: { clientFileId, type: "image", mimeType: "image/jpeg", sizeBytes: 2048 } });
  expect(init.statusCode, init.body).toBe(201);
  const complete = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${sessionId}/evidence-uploads/${init.json().attachmentId}/complete`, headers, payload: { uploadToken: init.json().uploadToken, sizeBytes: 2048 } });
  expect(complete.statusCode, complete.body).toBe(200);
  return complete.json();
};

async function seedWorld() {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash("A-secure-pass");
  const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const adminId = uuidv7();
  const inspectorId = uuidv7();
  const strangerId = uuidv7();
  const phone = (suffix) => normalizePhone(`13800000${suffix}`);
  await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,'AdminOne','adminone','管理员',$2,$3,now(),$4,'approved_active'),
      ($5,'InspectorOne','inspectorone','探员一',$6,$7,now(),$4,'approved_active'),
      ($8,'InspectorTwo','inspectortwo','探员二',$9,$10,now(),$4,'approved_active')`,
    [adminId, encrypt(encryptionKey, phone("000")), hmac(config.AUTH_TOKEN_HMAC_KEY, phone("000")), passwordHash,
      inspectorId, encrypt(encryptionKey, phone("100")), hmac(config.AUTH_TOKEN_HMAC_KEY, phone("100")),
      strangerId, encrypt(encryptionKey, phone("200")), hmac(config.AUTH_TOKEN_HMAC_KEY, phone("200"))]);
  const adminRole = await pool.query("SELECT id FROM roles WHERE code='super_admin'");
  const inspectorRole = await pool.query("SELECT id FROM roles WHERE code='inspector'");
  for (const [userId, roleId] of [[adminId, adminRole.rows[0].id], [inspectorId, inspectorRole.rows[0].id], [strangerId, inspectorRole.rows[0].id]]) {
    await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), userId, roleId]);
  }
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
  const provinceId = uuidv7(); const cityId = uuidv7(); const regionId = uuidv7(); const storeId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'静安区','310106',$2,3)", [regionId, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-HL','焦点集成门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, adminId]);
  // 问卷：q1=不得分题（历史强制照片配置：image_required=true + image_min_count=1 + 上限 4），q2=普通题
  const templateId = uuidv7(); const versionId = uuidv7(); const questionOne = uuidv7(); const questionTwo = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'焦点集成问卷','secret',$2)", [templateId, adminId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_by,published_at) VALUES ($1,$2,1,'published',$3,$3,now())", [versionId, templateId, adminId]);
  await pool.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,sort_order) VALUES
    ($1,$2,'q1',1,'environment','不得分证据题',2,true,1),($3,$2,'q2',2,'environment','普通题',3,true,2)`, [questionOne, versionId, questionTwo]);
  await pool.query(`INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count,image_max_count,audio_max_duration_seconds)
    VALUES ($1,true,true,false,1,0,4,10),($2,false,false,false,0,0,4,10)`, [questionOne, questionTwo]);
  // 同一任务（campaign）下每探员仅一条指派（UNIQUE）：三条指派分属三个任务。
  const campaignOne = uuidv7(); const campaignTwo = uuidv7(); const campaignThree = uuidv7();
  const assignmentOne = uuidv7(); const assignmentTwo = uuidv7(); const assignmentThree = uuidv7();
  const startsAt = new Date(Date.now() - 60_000); const dueAt = new Date(Date.now() + 3_600_000);
  await pool.query(`INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES
    ($1,'C-HL1','焦点集成任务一',$4,$6,$7,$8,'published',$5),($2,'C-HL2','焦点集成任务二',$4,$6,$7,$8,'published',$5),($3,'C-HL3','焦点集成任务三',$4,$6,$7,$8,'published',$5)`,
    [campaignOne, campaignTwo, campaignThree, storeId, adminId, startsAt, dueAt, new Date(Date.now() + 7_200_000)]);
  // assignmentOne 挂必点菜品要求（开卷后自动落 dish_records 行，flag 默认关闭时不得阻断提交）
  await pool.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,status,created_by) VALUES
    ($1,'A-HL1',$2,$5,$4,'secret',$6,$7,0,'assigned',$8),($9,'A-HL2',$3,$5,$4,'secret',$6,$7,0,'assigned',$8),($10,'A-HL3',$11,$12,$4,'secret',$6,$7,0,'assigned',$8)`,
    [assignmentOne, campaignOne, campaignTwo, versionId, inspectorId, startsAt, dueAt, adminId, assignmentTwo, assignmentThree, campaignThree, strangerId]);
  await pool.query(`INSERT INTO assignment_dish_requirements (id,assignment_id,planned_name,quantity,required,allow_substitution,sort_order)
    VALUES ($1,$2,'必点招牌菜',1,true,false,1)`, [uuidv7(), assignmentOne]);
  return { adminId, inspectorId, strangerId, questionOne, questionTwo, assignmentOne, assignmentTwo, assignmentThree, versionId, campaignOne, campaignTwo, campaignThree };
}

async function loginInspector(app, username) {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "A-secure-pass" } });
  expect(login.statusCode).toBe(200);
  return { authorization: `Bearer ${login.json().accessToken}` };
}

async function openAttempt(app, headers, assignmentId) {
  expect((await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } })).statusCode).toBe(200);
  const started = await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers });
  expect(started.statusCode).toBe(200);
  const attemptId = started.json().attempt.id;
  const revision = Number((await pool.query("SELECT revision FROM audit_assignments WHERE id=$1", [assignmentId])).rows[0].revision);
  return { attemptId, assignmentRevision: revision };
}

// 全部启用题作答直插（awarded_score=作答原始值），复用 score-wipe 测试的既有口径。
async function answerAll(attemptId, questions) {
  for (const [questionId, answer] of questions) {
    await pool.query("INSERT INTO question_answers (attempt_id,question_id,answer,awarded_score,issue_remark) VALUES ($1,$2,$3,$4,$5)", [attemptId, questionId, answer.answer, answer.awarded, answer.remark ?? ""]);
  }
}

const submitBody = (assignmentRevision) => ({ submitToken: uuidv7(), assignmentRevision, confirmation: true });
// app.inject 的轻量封装（GET/通用动词），供用例内直接取 JSON。
const apiGet = async (app, headers, url) => {
  const response = await app.inject({ method: "GET", url, headers });
  expect(response.statusCode, response.body).toBe(200);
  return { json: () => response.json() };
};

describe.sequential("highlight photo flow (2026-10 survey UX)", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-highlight-photo-tests'))");
    await pool.query(`TRUNCATE submission_question_scores, submission_versions, receipt_ocr_candidates, receipt_ocr_jobs, receipt_ocr_job_attachments,
      receipt_ocr_applications, receipt_ocr_summaries, receipt_ocr_lines, receipt_attachments, object_cleanup_jobs, dish_records, other_record_highlight_photos,
      other_record_highlights, other_records, idempotency_keys, audit_logs, question_answer_edit_session_removals, question_evidence_attachments,
      question_answer_edit_sessions, question_answers, survey_attempts, checkin_exemptions, audit_checkins, assignment_dish_requirements,
      audit_assignments, audit_campaigns, question_evidence_requirements, questions, questionnaire_versions, questionnaire_templates,
      question_categories, brands, stores, regions, auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets,
      inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users RESTART IDENTITY CASCADE`);
    await seedRbac(pool);
    await pool.query("INSERT INTO question_categories (id,code,name,sort_order) VALUES ($1,'environment','环境卫生',1),($2,'service','为客服务',2)", [uuidv7(), uuidv7()]);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-highlight-photo-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("无闪光点/隐藏菜品/不得分无照片均可提交（历史必填配置不再阻断）", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = await loginInspector(app, "InspectorOne");
    const { attemptId, assignmentRevision } = await openAttempt(app, headers, world.assignmentOne);
    // 不得分题只写说明（无照片）；普通题得分；闪光点零条；菜品要求行保持开卷初始
    // 'unavailable'（无售罄原因）的未完成状态——开关默认关闭时全部不得阻断提交。
    await answerAll(attemptId, [[world.questionOne, { answer: "unscored", awarded: 0, remark: "现场发现说明" }], [world.questionTwo, { answer: "scored", awarded: 3 }]]);
    const dishRows = await pool.query("SELECT fulfillment_status FROM dish_records WHERE attempt_id=$1", [attemptId]);
    expect(dishRows.rows.length).toBe(1); // 开卷自动落行的必点要求菜品仍在（绝不删除历史数据）
    const submit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers, payload: submitBody(assignmentRevision) });
    expect(submit.statusCode, submit.body).toBe(200);
    const snapshot = (await pool.query("SELECT other_snapshot_json,dish_snapshot_json,total_score,max_score FROM submission_versions WHERE attempt_id=$1", [attemptId])).rows[0];
    expect(snapshot.other_snapshot_json.highlights).toEqual([]);
    expect(JSON.parse(JSON.stringify(snapshot.dish_snapshot_json)).length).toBe(1); // 隐藏菜品照常冻结进快照
    expect(Number(snapshot.total_score)).toBe(3);
    expect(Number(snapshot.max_score)).toBe(5);
  });

  test("不得分照片默认上限 4：第 5 张 init 拒绝；历史 >4 张保留可确认可提交", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = await loginInspector(app, "InspectorOne");
    const { attemptId, assignmentRevision } = await openAttempt(app, headers, world.assignmentOne);
    const session = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions`, headers, payload: { baseAnswerRevision: 0, targetAnswer: "unscored" } });
    expect(session.statusCode, session.body).toBe(200);
    const sessionId = session.json().id;
    for (let index = 0; index < 4; index += 1) await stageImage(app, headers, attemptId, world.questionOne, sessionId, uuidv7());
    const fifth = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${sessionId}/evidence-uploads`, headers, payload: { clientFileId: uuidv7(), type: "image", mimeType: "image/jpeg", sizeBytes: 2048 } });
    expect(fifth.statusCode).toBe(422);
    expect(fifth.json().error.code).toBe("EVIDENCE_LIMIT_EXCEEDED");
    // 4 张（选填）+ 说明 → confirm 通过（无 image_min_count 强制）
    await app.inject({ method: "PATCH", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${sessionId}`, headers, payload: { draftIssueRemark: "四张照片与说明", revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision) } }).then((patched) => expect(patched.statusCode, patched.body).toBe(200));
    const confirm = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${sessionId}/confirm`, headers, payload: { answer: "unscored", revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision) } });
    expect(confirm.statusCode, confirm.body).toBe(200);

    // 历史超限：另一问卷先开编辑会话，再直接落 5 张 active（模拟旧配置 image_max_count=3 时代遗留）
    const attemptTwo = await openAttempt(app, headers, world.assignmentTwo);
    const legacySession = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptTwo.attemptId}/questions/${world.questionOne}/edit-sessions`, headers, payload: { baseAnswerRevision: 0, targetAnswer: "unscored" } });
    expect(legacySession.statusCode, legacySession.body).toBe(200);
    await pool.query(`INSERT INTO question_evidence_attachments (id,attempt_id,question_id,edit_session_id,type,storage_key,status,declared_content_type,declared_size_bytes,size_bytes,mime_type,sha256,upload_nonce)
      SELECT gen_random_uuid(),$1,$2,$4,'image','legacy/' || n,'active','image/jpeg',2048,2048,'image/jpeg',$3,gen_random_uuid() FROM generate_series(1,5) n`, [attemptTwo.attemptId, world.questionOne, "b".repeat(64), legacySession.json().id]);
    await answerAll(attemptTwo.attemptId, [[world.questionOne, { answer: "unscored", awarded: 0, remark: "历史超限" }], [world.questionTwo, { answer: "scored", awarded: 3 }]]);
    // 新增第 6 张被拒（存量 5 > 上限 4 → init 一律拒绝）
    const sixth = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptTwo.attemptId}/questions/${world.questionOne}/edit-sessions/${legacySession.json().id}/evidence-uploads`, headers, payload: { clientFileId: uuidv7(), type: "image", mimeType: "image/jpeg", sizeBytes: 2048 } });
    expect(sixth.statusCode).toBe(422);
    expect(sixth.json().error.code).toBe("EVIDENCE_LIMIT_EXCEEDED");
    // 但确认与提交必须放行（保留/展示，禁止新增）
    await app.inject({ method: "PATCH", url: `/api/questionnaires/secret/drafts/${attemptTwo.attemptId}/questions/${world.questionOne}/edit-sessions/${legacySession.json().id}`, headers, payload: { draftIssueRemark: "历史照片保留", revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptTwo.attemptId])).rows[0].revision) } }).then((patched) => expect(patched.statusCode, patched.body).toBe(200));
    const confirmTwo = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptTwo.attemptId}/questions/${world.questionOne}/edit-sessions/${legacySession.json().id}/confirm`, headers, payload: { answer: "unscored", revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptTwo.attemptId])).rows[0].revision) } });
    expect(confirmTwo.statusCode, confirmTwo.body).toBe(200);
    const submit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptTwo.attemptId}/submit`, headers, payload: submitBody(attemptTwo.assignmentRevision) });
    expect(submit.statusCode, submit.body).toBe(200);
    const kept = await pool.query("SELECT count(*)::int n FROM question_evidence_attachments WHERE attempt_id=$1 AND status='active'", [attemptTwo.attemptId]);
    expect(kept.rows[0].n).toBe(5); // 历史照片全部保留
  });

  test("多条闪光点（文字+照片）：保存/重载/提交快照/管理端详情/单份导出全链路 + 历史单条兜底", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = await loginInspector(app, "InspectorOne");
    const { attemptId, assignmentRevision } = await openAttempt(app, headers, world.assignmentOne);
    const highlightOne = uuidv7();
    const highlightTwo = uuidv7();
    // 客户端常规保存过滤空白条目：只发非空条目 → 仅 1 行落库
    const saved = await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers, payload: {
      highlights: [{ id: highlightOne, text: "服务主动加汤两次" }],
      revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision),
    } });
    expect(saved.statusCode, saved.body).toBe(200);
    const rows = await pool.query("SELECT id,text FROM other_record_highlights WHERE attempt_id=$1 ORDER BY sort_order", [attemptId]);
    expect(rows.rows.map((row) => [row.id, row.text])).toEqual([[highlightOne, "服务主动加汤两次"]]);
    // 传图前强制落库语义：显式送来的空白条目保留（照片必须挂到已存在条目）
    await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers, payload: {
      highlights: [{ id: highlightOne, text: "服务主动加汤两次" }, { id: highlightTwo, text: "" }],
      revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision),
    } }).then((res) => expect(res.statusCode, res.body).toBe(200));
    expect((await pool.query("SELECT count(*)::int n FROM other_record_highlights WHERE attempt_id=$1", [attemptId])).rows[0].n).toBe(2);
    // 客户端下一次过滤保存（不带空白条目）→ 空白行被清走（replace-all 语义）
    await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers, payload: {
      highlights: [{ id: highlightOne, text: "服务主动加汤两次" }],
      revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision),
    } }).then((res) => expect(res.statusCode, res.body).toBe(200));
    expect((await pool.query("SELECT count(*)::int n FROM other_record_highlights WHERE attempt_id=$1", [attemptId])).rows[0].n).toBe(1);
    // 历史单条列同步写入（管理端/导出兜底可读）
    const legacy = (await pool.query("SELECT highlight FROM other_records WHERE attempt_id=$1", [attemptId])).rows[0];
    expect(legacy.highlight).toBe("服务主动加汤两次");

    // 照片三步直传：init（revision 推进）→ complete（不带 sha256，服务端校验为唯一事实源）
    const firstPhotoMeta = receiptMeta(uuidv7());
    const photoInit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightOne}/photo-uploads`, headers, payload: { fileMeta: firstPhotoMeta, revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision) } });
    expect(photoInit.statusCode, photoInit.body).toBe(201);
    const photoInitBody = photoInit.json();
    const photoComplete = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightOne}/photo-uploads/${photoInitBody.attachmentId}/complete`, headers, payload: { fileMeta: firstPhotoMeta, revision: photoInitBody.revision } });
    expect(photoComplete.statusCode, photoComplete.body).toBe(200);
    expect(photoComplete.json().photo.status).toBe("ready");
    expect(photoComplete.json().photo.previewUrl).toContain("https://preview.example.test/");
    // 每条上限 4 张：连传 4 张后第 5 张 init 拒绝
    for (let index = 0; index < 3; index += 1) {
      const init = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightOne}/photo-uploads`, headers, payload: { fileMeta: receiptMeta(uuidv7()), revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision) } });
      expect(init.statusCode, init.body).toBe(201);
    }
    const fifth = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightOne}/photo-uploads`, headers, payload: { fileMeta: receiptMeta(uuidv7()), revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision) } });
    expect(fifth.statusCode).toBe(422);
    expect(fifth.json().error.code).toBe("HIGHLIGHT_PHOTO_LIMIT_EXCEEDED");
    // photo-only 条目：传图前的强制落库（文字为空、无照片也要保留），补文字前不可提交（可恢复校验）
    const photoOnlyId = uuidv7();
    const savedTwo = await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers, payload: {
      highlights: [{ id: highlightOne, text: "服务主动加汤两次" }, { id: photoOnlyId, text: "" }],
      revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision),
    } });
    expect(savedTwo.statusCode, savedTwo.body).toBe(200);
    const photoOnlyRow = await pool.query("SELECT text FROM other_record_highlights WHERE id=$1", [photoOnlyId]);
    expect(photoOnlyRow.rows.length).toBe(1); // 传图前落库的空白条目保留（客户端常规保存会过滤掉它）
    await pool.query("INSERT INTO other_record_highlight_photos (id,attempt_id,assignment_id,highlight_id,client_file_id,display_order,storage_key,upload_nonce,declared_content_type,declared_size_bytes,original_file_name,status,created_by,verified_at,mime_type,size_bytes,sha256) VALUES ($1,$2,$3,$4,gen_random_uuid(),1,'hl/x','00000000-0000-4000-8000-000000000001','image/jpeg',10,'p.jpg','ready',$5,now(),'image/jpeg',10,$6)", [uuidv7(), attemptId, (await pool.query("SELECT assignment_id FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].assignment_id, photoOnlyId, (await pool.query("SELECT inspector_id FROM audit_assignments WHERE id=$1", [world.assignmentOne])).rows[0].inspector_id, "c".repeat(64)]);
    await answerAll(attemptId, [[world.questionOne, { answer: "scored", awarded: 2 }], [world.questionTwo, { answer: "scored", awarded: 3 }]]);
    const blocked = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers, payload: submitBody(assignmentRevision) });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe("OTHER_HIGHLIGHT_TEXT_REQUIRED");
    // 补文字后可提交；快照含全部文字与照片引用
    await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers, payload: {
      highlights: [{ id: highlightOne, text: "服务主动加汤两次" }, { id: photoOnlyId, text: "环境一尘不染" }],
      revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision),
    } }).then((res) => expect(res.statusCode, res.body).toBe(200));
    const submit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers, payload: submitBody(assignmentRevision) });
    expect(submit.statusCode, submit.body).toBe(200);
    const snapshot = (await pool.query("SELECT other_snapshot_json FROM submission_versions WHERE attempt_id=$1", [attemptId])).rows[0];
    expect(snapshot.other_snapshot_json.highlights.map((item) => item.text)).toEqual(["服务主动加汤两次", "环境一尘不染"]);
    expect(snapshot.other_snapshot_json.highlights[1].photos.length).toBe(1);

    // 草稿重载（提交前形态已锁，这里直接验证 DTO 组装函数行为已由 admin detail 覆盖）
    // 管理端详情：结构化条目 + 照片签名预览
    const adminLogin = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "AdminOne", password: "A-secure-pass" } });
    const adminHeaders = { cookie: adminLogin.headers["set-cookie"], "x-csrf-token": adminLogin.json().csrfToken };
    const submissionId = (await pool.query("SELECT id FROM submission_versions WHERE attempt_id=$1", [attemptId])).rows[0].id;
    const detail = await app.inject({ method: "GET", url: `/api/admin/submissions/${submissionId}`, headers: adminHeaders });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().highlights.map((item) => ({ text: item.text, photos: item.photos.length }))).toEqual([
      { text: "服务主动加汤两次", photos: 1 },
      { text: "环境一尘不染", photos: 1 },
    ]);
    expect(detail.json().highlights[0].photos[0].previewUrl).toContain("https://preview.example.test/");

    // 单份导出：模型含全部文字+照片引用，工作簿可生成
    const model = await loadSubmissionExportModel(pool, { filters_json: { submissionId }, scope_snapshot_json: [{ scope_type: "all" }] });
    expect(model.highlights.map((item) => item.text)).toEqual(["服务主动加汤两次", "环境一尘不染"]);
    expect(model.highlights[1].photos.length).toBe(1);
    const workbook = await buildSubmissionWorkbook(model);
    expect(workbook.byteLength).toBeGreaterThan(1000);

    // 历史提交兜底：无结构化条目时管理端详情/导出按旧单条 highlight 展示
    const legacyAttempt = await openAttempt(app, await loginInspector(app, "InspectorTwo"), world.assignmentThree);
    await answerAll(legacyAttempt.attemptId, [[world.questionOne, { answer: "scored", awarded: 2 }], [world.questionTwo, { answer: "scored", awarded: 3 }]]);
    await pool.query("INSERT INTO other_records (attempt_id,highlight) VALUES ($1,'旧版单条亮点')", [legacyAttempt.attemptId]);
    const legacySubmit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${legacyAttempt.attemptId}/submit`, headers: await loginInspector(app, "InspectorTwo"), payload: submitBody(legacyAttempt.assignmentRevision) });
    expect(legacySubmit.statusCode, legacySubmit.body).toBe(200);
    const legacySubmissionId = (await pool.query("SELECT id FROM submission_versions WHERE attempt_id=$1", [legacyAttempt.attemptId])).rows[0].id;
    const legacyDetail = await app.inject({ method: "GET", url: `/api/admin/submissions/${legacySubmissionId}`, headers: adminHeaders });
    expect(legacyDetail.statusCode, legacyDetail.body).toBe(200);
    expect(legacyDetail.json().highlights).toEqual([{ id: legacySubmissionId, text: "旧版单条亮点", photos: [] }]);
    const legacyModel = await loadSubmissionExportModel(pool, { filters_json: { submissionId: legacySubmissionId }, scope_snapshot_json: [{ scope_type: "all" }] });
    expect(legacyModel.highlights).toEqual([{ index: 1, text: "旧版单条亮点", photos: [] }]);
    expect(legacyModel.highlight).toBe("旧版单条亮点");
  });

  test("越权与提交后写入全部拒绝", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const ownerHeaders = await loginInspector(app, "InspectorOne");
    const strangerHeaders = await loginInspector(app, "InspectorTwo");
    const { attemptId, assignmentRevision } = await openAttempt(app, ownerHeaders, world.assignmentOne);
    const highlightId = uuidv7();
    await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers: ownerHeaders, payload: { highlights: [{ id: highlightId, text: "本人闪光点" }], revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision) } }).then((res) => expect(res.statusCode, res.body).toBe(200));
    // 他人对自己的问卷携带他人 highlight id → 404（绝不跨记录改写）
    const strangerAttempt = await openAttempt(app, strangerHeaders, world.assignmentThree);
    const hijack = await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${strangerAttempt.attemptId}/other-records`, headers: strangerHeaders, payload: { highlights: [{ id: highlightId, text: "劫持" }], revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [strangerAttempt.attemptId])).rows[0].revision) } });
    expect(hijack.statusCode).toBe(404);
    expect(hijack.json().error.code).toBe("HIGHLIGHT_NOT_FOUND");
    // 他人对他人 attempt 上传照片 → 404（attempt 属主校验在前）
    const foreignPhoto = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightId}/photo-uploads`, headers: strangerHeaders, payload: { fileMeta: receiptMeta(uuidv7()), revision: 0 } });
    expect(foreignPhoto.statusCode).toBe(404);
    // 他人读草稿 → 404
    const foreignDraft = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: strangerHeaders });
    expect(foreignDraft.statusCode).toBe(404);
    // 提交后：保存闪光点/上传照片/删照片/写建议全部 409 锁定
    await answerAll(attemptId, [[world.questionOne, { answer: "scored", awarded: 2 }], [world.questionTwo, { answer: "scored", awarded: 3 }]]);
    const submit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers: ownerHeaders, payload: submitBody(assignmentRevision) });
    expect(submit.statusCode, submit.body).toBe(200);
    const afterSubmitSave = await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers: ownerHeaders, payload: { highlights: [{ id: highlightId, text: "提交后改" }], revision: 0 } });
    expect(afterSubmitSave.statusCode).toBe(409);
    const afterSubmitPhoto = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightId}/photo-uploads`, headers: ownerHeaders, payload: { fileMeta: receiptMeta(uuidv7()), revision: 0 } });
    expect(afterSubmitPhoto.statusCode).toBe(409);
    const afterSubmitSuggestion = await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers: ownerHeaders, payload: { suggestion: "提交后建议", revision: 0 } });
    expect(afterSubmitSuggestion.statusCode).toBe(409);
  });
  test("照片生命周期：ready 硬删+清理入队+槽位复用；删条目连带删 ready/uploading 照片；兄弟行不受影响", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = await loginInspector(app, "InspectorOne");
    const { attemptId } = await openAttempt(app, headers, world.assignmentOne);
    const revisionNow = async () => Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision);
    const highlightOne = uuidv7();
    const highlightTwo = uuidv7();
    await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers, payload: { highlights: [{ id: highlightOne, text: "条目一" }, { id: highlightTwo, text: "条目二" }], revision: await revisionNow() } }).then((res) => expect(res.statusCode, res.body).toBe(200));
    // 条目一传满 4 张（占槽 1-4）
    const metas = [];
    for (let index = 0; index < 4; index += 1) {
      const meta = receiptMeta(uuidv7());
      metas.push(meta);
      const init = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightOne}/photo-uploads`, headers, payload: { fileMeta: meta, revision: await revisionNow() } });
      expect(init.statusCode, init.body).toBe(201);
      expect(init.json().photo.displayOrder).toBe(index + 1);
      const completed = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightOne}/photo-uploads/${init.json().attachmentId}/complete`, headers, payload: { fileMeta: meta, revision: init.json().revision } });
      expect(completed.statusCode, completed.body).toBe(200);
    }
    // 删除第 2 张（ready）→ 行硬删、对象清理入队、槽位 2 释放
    const slotTwoId = (await pool.query("SELECT id FROM other_record_highlight_photos WHERE highlight_id=$1 AND display_order=2", [highlightOne])).rows[0].id;
    await app.inject({ method: "DELETE", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightOne}/photo-uploads/${slotTwoId}`, headers, payload: { revision: await revisionNow() } }).then((res) => expect(res.statusCode, res.body).toBe(200));
    expect((await pool.query("SELECT count(*)::int n FROM other_record_highlight_photos WHERE highlight_id=$1", [highlightOne])).rows[0].n).toBe(3);
    expect((await pool.query("SELECT count(*)::int n FROM object_cleanup_jobs WHERE attachment_id=$1", [slotTwoId])).rows[0].n).toBe(1);
    // 删中间后补传：新槽位 = 最小空槽 2（绝不落到 5）
    const replaceMeta = receiptMeta(uuidv7());
    const replaceInit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightOne}/photo-uploads`, headers, payload: { fileMeta: replaceMeta, revision: await revisionNow() } });
    expect(replaceInit.statusCode, replaceInit.body).toBe(201);
    expect(replaceInit.json().photo.displayOrder).toBe(2);
    // 满员（4 张活行）再传 → 422
    const fifth = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightOne}/photo-uploads`, headers, payload: { fileMeta: receiptMeta(uuidv7()), revision: await revisionNow() } });
    expect(fifth.statusCode).toBe(422);
    // 兄弟条目不受影响
    expect((await pool.query("SELECT count(*)::int n FROM other_record_highlights WHERE attempt_id=$1", [attemptId])).rows[0].n).toBe(2);
    // 删除条目二：先给一条 ready + 一条 uploading（SQL 直插），删条目必须连带清理两者
    await pool.query(`INSERT INTO other_record_highlight_photos (id,attempt_id,assignment_id,highlight_id,client_file_id,display_order,storage_key,upload_nonce,declared_content_type,declared_size_bytes,original_file_name,status,created_by,verified_at,mime_type,size_bytes,sha256)
      VALUES ($1,$2,$3,$4,gen_random_uuid(),1,'hl/two-ready',gen_random_uuid(),'image/jpeg',10,'p.jpg','ready',$5,now(),'image/jpeg',10,$6),
        ($7,$2,$3,$4,gen_random_uuid(),2,'hl/two-uploading',gen_random_uuid(),'image/jpeg',10,'q.jpg','uploading',$5,NULL,NULL,NULL,NULL)`,
      [uuidv7(), attemptId, (await pool.query("SELECT assignment_id FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].assignment_id, highlightTwo, world.inspectorId, "d".repeat(64), uuidv7()]);
    await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers, payload: { highlights: [{ id: highlightOne, text: "条目一" }], revision: await revisionNow() } }).then((res) => expect(res.statusCode, res.body).toBe(200));
    expect((await pool.query("SELECT count(*)::int n FROM other_record_highlights WHERE attempt_id=$1", [attemptId])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int n FROM other_record_highlight_photos WHERE attempt_id=$1", [attemptId])).rows[0].n).toBe(4); // 条目一的 4 张保留
    expect((await pool.query("SELECT count(*)::int n FROM object_cleanup_jobs WHERE attachment_id IN (SELECT id FROM other_record_highlight_photos WHERE attempt_id=$1)", [attemptId])).rows[0].n).toBe(0);
    const cleanupCount = await pool.query("SELECT count(*)::int n FROM object_cleanup_jobs");
    expect(Number(cleanupCount.rows[0].n)).toBeGreaterThanOrEqual(2); // 条目二 ready+uploading 均入队
  });

  test("上传恢复：verify 失败→failed 复位重试成功；租约占用 202→ready；ready 幂等重放（旧 revision）", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = await loginInspector(app, "InspectorOne");
    const { attemptId } = await openAttempt(app, headers, world.assignmentOne);
    const revisionNow = async () => Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision);
    const highlightId = uuidv7();
    await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers, payload: { highlights: [{ id: highlightId, text: "恢复链路" }], revision: await revisionNow() } }).then((res) => expect(res.statusCode, res.body).toBe(200));
    // 1) verifyObject 抛错 → complete 422 + status failed
    const failingStorage = { ...storage, verifyObject: async () => { throw Object.assign(new Error("corrupt"), { code: "BAD_OBJECT" }); } };
    const failingApp = buildApp({ config, pool, logger: false, providers, storage: failingStorage });
    const meta = receiptMeta(uuidv7());
    const init = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightId}/photo-uploads`, headers, payload: { fileMeta: meta, revision: await revisionNow() } });
    expect(init.statusCode, init.body).toBe(201);
    const completeFail = await failingApp.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightId}/photo-uploads/${init.json().attachmentId}/complete`, headers, payload: { fileMeta: meta, revision: init.json().revision } });
    expect(completeFail.statusCode).toBe(422);
    expect((await pool.query("SELECT status FROM other_record_highlight_photos WHERE id=$1", [init.json().attachmentId])).rows[0].status).toBe("failed");
    // 2) 同 client_file_id 重新 init：failed 复位为 uploading 并重发凭据（真正的重试路径）
    const retryInit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightId}/photo-uploads`, headers, payload: { fileMeta: meta, revision: await revisionNow() } });
    expect(retryInit.statusCode, retryInit.body).toBe(200);
    expect(retryInit.json().photo.status).toBe("uploading");
    expect(retryInit.json().uploadTarget).toBeTruthy();
    // 坏元数据（size 不一致）→ 409 冲突
    const badMeta = { ...meta, sizeBytes: meta.sizeBytes + 1 };
    const badInit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightId}/photo-uploads`, headers, payload: { fileMeta: badMeta, revision: await revisionNow() } });
    expect(badInit.statusCode).toBe(409);
    // 3) 租约占用 → complete 202 verifying（可用响应体，客户端可重试）
    await pool.query("UPDATE other_record_highlight_photos SET verification_lease_expires_at=now()+INTERVAL '30 seconds',verification_locked_by=gen_random_uuid() WHERE id=$1", [init.json().attachmentId]);
    const pendingComplete = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightId}/photo-uploads/${init.json().attachmentId}/complete`, headers, payload: { fileMeta: meta, revision: retryInit.json().revision } });
    expect(pendingComplete.statusCode).toBe(202);
    expect(pendingComplete.json()).toMatchObject({ id: init.json().attachmentId, status: "verifying" });
    // 4) 租约清除后 complete → ready
    await pool.query("UPDATE other_record_highlight_photos SET verification_lease_expires_at=NULL,verification_locked_by=NULL WHERE id=$1", [init.json().attachmentId]);
    const readyComplete = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightId}/photo-uploads/${init.json().attachmentId}/complete`, headers, payload: { fileMeta: meta, revision: retryInit.json().revision } });
    expect(readyComplete.statusCode, readyComplete.body).toBe(200);
    expect(readyComplete.json().photo.status).toBe("ready");
    const revisionAfterReady = await revisionNow();
    // 5) ready 幂等重放：故意用过期 revision（模拟丢响应后的重试）→ 200 + 当前 revision，绝不 409
    const replay = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightId}/photo-uploads/${init.json().attachmentId}/complete`, headers, payload: { fileMeta: meta, revision: Math.max(0, revisionAfterReady - 3) } });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().photo.status).toBe("ready");
    expect(replay.json().revision).toBe(revisionAfterReady);
    // ready 重放 init：不发上传凭据（uploadTarget=null），绝不覆盖已校验对象
    const readyInit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightId}/photo-uploads`, headers, payload: { fileMeta: meta, revision: await revisionNow() } });
    expect(readyInit.statusCode).toBe(200);
    expect(readyInit.json().uploadTarget).toBeNull();
    expect(readyInit.json().photo.status).toBe("ready");
  });

  test("现行照片上限=4 不受存量配置影响：image_max_count=3 与 9 均按 4 执行；DTO 固定下发 4", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = await loginInspector(app, "InspectorOne");
    // 同一任务下每探员仅一条指派：两种存量配置分别用 assignmentOne/assignmentTwo（同一探员）。
    for (const [storedLimit, assignmentId] of [[3, world.assignmentOne], [9, world.assignmentTwo]]) {
      const { attemptId } = await openAttempt(app, headers, assignmentId);
      // 存量配置改写为旧默认 3 / 老配置 9（仅测试库种子，生产数据不动）
      await pool.query("UPDATE question_evidence_requirements SET image_max_count=$2 WHERE question_id=$1", [world.questionOne, storedLimit]);
      const draft = await (await apiGet(app, headers, `/api/questionnaires/secret/drafts/${attemptId}`)).json();
      expect(draft.questions.find((question) => question.id === world.questionOne).evidence.imageMaxCount).toBe(4);
      const session = await (await apiGet(app, headers, `/api/questionnaires/secret/drafts/${attemptId}`, null)).json();
      void session;
      const editSession = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions`, headers, payload: { baseAnswerRevision: 0, targetAnswer: "unscored" } });
      expect(editSession.statusCode, editSession.body).toBe(200);
      for (let index = 0; index < 4; index += 1) await stageImage(app, headers, attemptId, world.questionOne, editSession.json().id, uuidv7());
      const fifth = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${editSession.json().id}/evidence-uploads`, headers, payload: { clientFileId: uuidv7(), type: "image", mimeType: "image/jpeg", sizeBytes: 2048 } });
      expect(fifth.statusCode).toBe(422);
      expect(fifth.json().error.code).toBe("EVIDENCE_LIMIT_EXCEEDED");
      // 确认编辑会话：staged_ready → active（与真实流程一致）
      let currentRevision = Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision);
      await app.inject({ method: "PATCH", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${editSession.json().id}`, headers, payload: { draftIssueRemark: "存量超限", revision: currentRevision } }).then((patched) => expect(patched.statusCode, patched.body).toBe(200));
      await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${editSession.json().id}/confirm`, headers, payload: { answer: "unscored", revision: currentRevision } }).then((confirmed) => expect(confirmed.statusCode, confirmed.body).toBe(200));
      // 存量 >4（5 张 active）保留可见可提交：第 5 张 SQL 直插后确认+提交放行、新增被拒
      const attemptRevision = Number((await pool.query("SELECT revision FROM audit_assignments WHERE id=$1", [assignmentId])).rows[0].revision);
      await pool.query(`INSERT INTO question_evidence_attachments (id,attempt_id,question_id,edit_session_id,type,storage_key,status,declared_content_type,declared_size_bytes,size_bytes,mime_type,sha256,upload_nonce)
        VALUES (gen_random_uuid(),$1,$2,$3,'image','extra-legacy/' || $4::text,'active','image/jpeg',2048,2048,'image/jpeg',$5,gen_random_uuid())`, [attemptId, world.questionOne, editSession.json().id, uuidv7(), "e".repeat(64)]);
      // q1 已由 confirm 落库（unscored+说明），这里只补 q2 得分
      await answerAll(attemptId, [[world.questionTwo, { answer: "scored", awarded: 3 }]]);
      await pool.query("INSERT INTO other_records (attempt_id,highlight) VALUES ($1,'存量提交') ON CONFLICT (attempt_id) DO UPDATE SET highlight=EXCLUDED.highlight", [attemptId]);
      const submit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers, payload: submitBody(attemptRevision) });
      expect(submit.statusCode, submit.body).toBe(200);
      expect((await pool.query("SELECT count(*)::int n FROM question_evidence_attachments WHERE attempt_id=$1 AND status='active'", [attemptId])).rows[0].n).toBe(5);
    }
  });

  test("旧单条客户端兼容：highlight+suggestion 原样落库；建议单独保存不覆盖结构化条目与历史列", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = await loginInspector(app, "InspectorOne");
    const { attemptId } = await openAttempt(app, headers, world.assignmentOne);
    const revisionNow = async () => Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision);
    // 旧客户端形态：{ highlight, suggestion, revision }
    await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers, payload: { highlight: "旧客户端亮点", suggestion: "旧客户端建议", revision: await revisionNow() } }).then((res) => expect(res.statusCode, res.body).toBe(200));
    expect((await pool.query("SELECT highlight,suggestion FROM other_records WHERE attempt_id=$1", [attemptId])).rows[0]).toMatchObject({ highlight: "旧客户端亮点", suggestion: "旧客户端建议" });
    // 升级到结构化：两条闪光点（历史列被同步改写为新口径）
    const hlOne = uuidv7();
    const hlTwo = uuidv7();
    await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers, payload: { highlights: [{ id: hlOne, text: "条目一" }, { id: hlTwo, text: "条目二" }], revision: await revisionNow() } }).then((res) => expect(res.statusCode, res.body).toBe(200));
    // 第三步只存建议：结构化条目与历史列都必须原样保留
    await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers, payload: { suggestion: "只有建议", revision: await revisionNow() } }).then((res) => expect(res.statusCode, res.body).toBe(200));
    const row = (await pool.query("SELECT highlight,suggestion FROM other_records WHERE attempt_id=$1", [attemptId])).rows[0];
    expect(row.suggestion).toBe("只有建议");
    expect(row.highlight).toContain("条目一");
    expect((await pool.query("SELECT count(*)::int n FROM other_record_highlights WHERE attempt_id=$1", [attemptId])).rows[0].n).toBe(2);
    // 草稿 DTO：结构化条目 + 历史单条同时可见
    const draft = await (await apiGet(app, headers, `/api/questionnaires/secret/drafts/${attemptId}`)).json();
    expect(draft.otherRecords.highlights.map((item) => item.text)).toEqual(["条目一", "条目二"]);
    expect(draft.otherRecords.highlight).toContain("条目一");
  });
  test("不得分照片删1补1：init 计数扣除本会话标记删除；取消会话原照片保留且不释放配额", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = await loginInspector(app, "InspectorOne");
    const { attemptId } = await openAttempt(app, headers, world.assignmentOne);
    const activeCount = async () => Number((await pool.query("SELECT count(*)::int n FROM question_evidence_attachments WHERE attempt_id=$1 AND question_id=$2 AND status='active'", [attemptId, world.questionOne])).rows[0].n);
    // 会话 A：传满 4 张并确认（4 active）
    const sessionA = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions`, headers, payload: { baseAnswerRevision: 0, targetAnswer: "unscored" } });
    expect(sessionA.statusCode, sessionA.body).toBe(200);
    await app.inject({ method: "PATCH", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${sessionA.json().id}`, headers, payload: { draftIssueRemark: "满 4 张", revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision) } }).then((patched) => expect(patched.statusCode, patched.body).toBe(200));
    for (let index = 0; index < 4; index += 1) await stageImage(app, headers, attemptId, world.questionOne, sessionA.json().id, uuidv7());
    const confirmedA = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${sessionA.json().id}/confirm`, headers, payload: { answer: "unscored", revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision) } });
    expect(confirmedA.statusCode, confirmedA.body).toBe(200);
    expect(await activeCount()).toBe(4);
    // 会话 B：删除 1 张（staged removal）→ 补传 1 张必须放行（旧计数会把 4+1=5 误拒）
    const answerRevisionB = Number((await pool.query("SELECT revision FROM question_answers WHERE attempt_id=$1 AND question_id=$2", [attemptId, world.questionOne])).rows[0].revision);
    const sessionB = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions`, headers, payload: { baseAnswerRevision: answerRevisionB, targetAnswer: "unscored" } });
    expect(sessionB.statusCode, sessionB.body).toBe(200);
    const firstActive = (await pool.query("SELECT id FROM question_evidence_attachments WHERE attempt_id=$1 AND question_id=$2 AND status='active' ORDER BY created_at LIMIT 1", [attemptId, world.questionOne])).rows[0].id;
    const removal = await app.inject({ method: "DELETE", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${sessionB.json().id}/evidence/${firstActive}`, headers });
    expect(removal.statusCode, removal.body).toBe(200);
    expect(removal.json().status).toBe("pending_removal");
    const replacementMeta = { clientFileId: uuidv7(), fileName: "replacement.png", mimeType: "image/png", sizeBytes: 4096 };
    const replacementInit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${sessionB.json().id}/evidence-uploads`, headers, payload: { clientFileId: replacementMeta.clientFileId, type: "image", mimeType: replacementMeta.mimeType, sizeBytes: replacementMeta.sizeBytes } });
    expect(replacementInit.statusCode, replacementInit.body).toBe(201);
    await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${sessionB.json().id}/evidence-uploads/${replacementInit.json().attachmentId}/complete`, headers, payload: { uploadToken: replacementInit.json().uploadToken, sizeBytes: replacementMeta.sizeBytes } }).then((completed) => expect(completed.statusCode, completed.body).toBe(200));
    // 会话 B 确认：staged 升 active、被删 active 落删除 → 最终恰 4 张
    await app.inject({ method: "PATCH", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${sessionB.json().id}`, headers, payload: { draftIssueRemark: "删1补1", revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision) } }).then((patched) => expect(patched.statusCode, patched.body).toBe(200));
    const confirmedB = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${sessionB.json().id}/confirm`, headers, payload: { answer: "unscored", revision: Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision) } });
    expect(confirmedB.statusCode, confirmedB.body).toBe(200);
    expect(await activeCount()).toBe(4);
    expect((await pool.query("SELECT id FROM question_evidence_attachments WHERE id=$1 AND status='active'", [firstActive])).rows.length).toBe(0);
    // 取消分支：会话 C 删除 1 张后取消 → 原 4 张全保留；被取消会话的 removal 不释放配额（新会话补传被拒）
    const answerRevisionC = Number((await pool.query("SELECT revision FROM question_answers WHERE attempt_id=$1 AND question_id=$2", [attemptId, world.questionOne])).rows[0].revision);
    const sessionC = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions`, headers, payload: { baseAnswerRevision: answerRevisionC, targetAnswer: "unscored" } });
    expect(sessionC.statusCode, sessionC.body).toBe(200);
    const anotherActive = (await pool.query("SELECT id FROM question_evidence_attachments WHERE attempt_id=$1 AND question_id=$2 AND status='active' ORDER BY created_at LIMIT 1", [attemptId, world.questionOne])).rows[0].id;
    await app.inject({ method: "DELETE", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${sessionC.json().id}/evidence/${anotherActive}`, headers }).then((res) => expect(res.statusCode, res.body).toBe(200));
    const cancelled = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${sessionC.json().id}/cancel`, headers });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(await activeCount()).toBe(4);
    const sessionD = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions`, headers, payload: { baseAnswerRevision: Number((await pool.query("SELECT revision FROM question_answers WHERE attempt_id=$1 AND question_id=$2", [attemptId, world.questionOne])).rows[0].revision), targetAnswer: "unscored" } });
    expect(sessionD.statusCode, sessionD.body).toBe(200);
    const overInit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${sessionD.json().id}/evidence-uploads`, headers, payload: { clientFileId: uuidv7(), type: "image", mimeType: "image/jpeg", sizeBytes: 2048 } });
    expect(overInit.statusCode).toBe(422);
    expect(overInit.json().error.code).toBe("EVIDENCE_LIMIT_EXCEEDED");
  });
  test("init 租约安全：verify 租约存续时拒绝新可写目标；到期后放行；ready 返回无目标 ACK", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = await loginInspector(app, "InspectorOne");
    const { attemptId } = await openAttempt(app, headers, world.assignmentOne);
    const revisionNow = async () => Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision);
    const highlightId = uuidv7();
    await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers, payload: { highlights: [{ id: highlightId, text: "租约安全" }], revision: await revisionNow() } }).then((res) => expect(res.statusCode, res.body).toBe(200));
    const meta = receiptMeta(uuidv7());
    const init = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightId}/photo-uploads`, headers, payload: { fileMeta: meta, revision: await revisionNow() } });
    expect(init.statusCode, init.body).toBe(201);
    const attachmentId = init.json().attachmentId;
    // 模拟 complete 已进入 verify 租约（ reservation 持有中，complete 请求尚未返回/丢失）
    await pool.query("UPDATE other_record_highlight_photos SET verification_lease_expires_at=now()+INTERVAL '40 seconds',verification_locked_by=gen_random_uuid() WHERE id=$1", [attachmentId]);
    // 租约存续：init 绝不发新可写目标（防重试直传覆盖被校验对象）
    const blockedInit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightId}/photo-uploads`, headers, payload: { fileMeta: meta, revision: await revisionNow() } });
    expect(blockedInit.statusCode).toBe(409);
    expect(blockedInit.json().error.code).toBe("HIGHLIGHT_VERIFY_PENDING");
    expect(blockedInit.json().error.retryable).toBe(true);
    // 租约到期：init 恢复可签发（200，uploading 重发目标）
    await pool.query("UPDATE other_record_highlight_photos SET verification_lease_expires_at=now()-INTERVAL '1 second',verification_locked_by=NULL WHERE id=$1", [attachmentId]);
    const recoveredInit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightId}/photo-uploads`, headers, payload: { fileMeta: meta, revision: init.json().revision } });
    expect(recoveredInit.statusCode, recoveredInit.body).toBe(200);
    expect(recoveredInit.json().uploadTarget).toBeTruthy();
    // complete → ready；随后 init 幂等重放 = 无目标 ACK
    await pool.query("UPDATE other_record_highlight_photos SET verification_lease_expires_at=NULL,verification_locked_by=NULL WHERE id=$1", [attachmentId]);
    const completed = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightId}/photo-uploads/${attachmentId}/complete`, headers, payload: { fileMeta: meta, revision: recoveredInit.json().revision } });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json().photo.status).toBe("ready");
    const readyAck = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/highlights/${highlightId}/photo-uploads`, headers, payload: { fileMeta: meta, revision: await revisionNow() } });
    expect(readyAck.statusCode).toBe(200);
    expect(readyAck.json().uploadTarget).toBeNull();
    expect(readyAck.json().photo.status).toBe("ready");
  });
});