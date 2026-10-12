import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { encrypt, hmac, normalizePhone } from "../../apps/api/src/auth/crypto.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";
import { uuidv7 } from "../../apps/api/src/ids.js";
import { advanceCampaignOverdue, selectOverdueCampaigns } from "../../apps/api/src/campaign-state.js";

import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

// 集成测试会清空业务表：误指向开发库时立即失败而不是清空数据。
assertIntegrationTestDatabase();

const connectionString = process.env.DATABASE_URL;
const test = connectionString ? it : it.skip;
const pool = connectionString ? new pg.Pool({ connectionString, max: 10 }) : null;
let databaseLock = null;

const HOUR = 3_600_000;

async function seedSelectionWorld() {
  // audit_campaigns / audit_assignments 的 FK 最小上游：用户、regions、store、问卷模板+版本。
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash("A-secure-pass");
  const encryptionKey = Buffer.from(Buffer.alloc(32, 7).toString("base64"), "base64");
  const userId = uuidv7();
  await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,'WorkerBot','workerbot','测试用户',$2,$3,now(),$4,'approved_active')`,
    [userId, encrypt(encryptionKey, normalizePhone("13700000000")), hmac(Buffer.alloc(32, 7).toString("base64"), normalizePhone("13700000000")), passwordHash]);
  const provinceId = uuidv7(); const cityId = uuidv7(); const regionId = uuidv7(); const storeId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'静安区','310106',$2,3)", [regionId, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-WORKER','选择测试门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, userId]);
  const templateId = uuidv7(); const versionId = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'选择测试问卷','secret',$2)", [templateId, userId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_by,published_at) VALUES ($1,$2,1,'published',$3,$3,now())", [versionId, templateId, userId]);
  return { userId, storeId, versionId };
}

async function seedCampaignWithAssignment(world, { index, createdAtMs, campaignStatus, assignmentStatus, questionnaireDeadlineAt }) {
  // uuidv7 时间有序：createdAtMs 各差 1ms 保证 id 全序确定，占位组在前、需推进者在最后。
  const campaignId = uuidv7(createdAtMs);
  const assignmentId = uuidv7(createdAtMs);
  await pool.query(`INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,status,created_by)
    VALUES ($1,$2,'选择场景任务',$3,now()-interval '2 hours',now()-interval '1 hour',$4,$5)`,
    [campaignId, `WC-C-${index}`, world.storeId, campaignStatus, world.userId]);
  await pool.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,status,created_by,questionnaire_deadline_at,started_at)
    VALUES ($1,$2,$3,$4,$5,'secret',now()-interval '2 hours',now()-interval '1 hour',0,$6,$7,$8,$9)`,
    [assignmentId, `WC-A-${index}`, campaignId, world.userId, world.versionId, assignmentStatus, world.userId,
      questionnaireDeadlineAt, assignmentStatus === "in_progress" ? new Date() : null]);
  return campaignId;
}

// 占位组：探店已超 due_at 但问卷窗口未关（in_progress + questionnaire_deadline_at 在未来）——
// worker 选择 SQL 会命中它们，advanceCampaignOverdue 却对它们无任何状态变更（空转）。
async function seedSelectionScenario({ placeholders }) {
  const world = await seedSelectionWorld();
  const baseMs = Date.now() - 600_000;
  const placeholderIds = [];
  for (let i = 0; i < placeholders; i++) {
    placeholderIds.push(await seedCampaignWithAssignment(world, {
      index: i, createdAtMs: baseMs + i, campaignStatus: "in_progress", assignmentStatus: "in_progress",
      questionnaireDeadlineAt: new Date(Date.now() + HOUR),
    }));
  }
  // 需推进者：assigned + due_at 已过，id 时间戳最晚（排序垫底）。
  const needyId = await seedCampaignWithAssignment(world, {
    index: 900_000, createdAtMs: Date.now(), campaignStatus: "published", assignmentStatus: "assigned",
    questionnaireDeadlineAt: null,
  });
  return { ...world, placeholderIds, needyId };
}

async function runWorkerSelectionSql(limit = 100) {
  const client = await pool.connect();
  try { return await selectOverdueCampaigns(client, limit); }
  finally { client.release(); }
}

describe.sequential("worker overdue selection", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-worker-overdue-selection-tests'))");
    await pool.query("TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users, questionnaire_templates, questionnaire_versions, questions, question_evidence_requirements, regions, stores, audit_campaigns, audit_assignments, survey_attempts, question_evidence_attachments, question_answer_edit_sessions RESTART IDENTITY CASCADE");
    await seedRbac(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-worker-overdue-selection-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("large batch: a due assigned campaign must be selected despite 100 in-flight placeholder campaigns ahead of it", async () => {
    const { needyId } = await seedSelectionScenario({ placeholders: 100 });
    const selectedIds = await runWorkerSelectionSql();
    expect(selectedIds).toContain(needyId);
  });

  test("修复取证：问卷窗口未关的占位组不得霸占选中名额，选中集合恰好只含需推进者", async () => {
    const { needyId, placeholderIds } = await seedSelectionScenario({ placeholders: 100 });
    const selectedIds = await runWorkerSelectionSql();
    // 占位组（in_progress + 问卷窗口未关）一个都不允许命中；名额归还给真正需推进的 campaign。
    expect(selectedIds.some((id) => placeholderIds.includes(id))).toBe(false);
    expect(selectedIds).toEqual([needyId]);
  });

  test("small batch: with only 2 placeholder campaigns, the due assigned campaign is selected", async () => {
    const { needyId } = await seedSelectionScenario({ placeholders: 2 });
    const selectedIds = await runWorkerSelectionSql();
    expect(selectedIds).toContain(needyId);
  });

  test("the starved campaign would advance if selected: advanceCampaignOverdue marks assignment overdue and campaign in_progress", async () => {
    const { needyId } = await seedSelectionScenario({ placeholders: 2 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await advanceCampaignOverdue(client, needyId);
      await client.query("COMMIT");
      expect(result.assignments).toHaveLength(1);
      expect(result.assignments[0].status).toBe("overdue");
      expect(result.assignments[0].overdueAdvanced).toBe(true);
      expect(result.campaign.status).toBe("in_progress");
      const persisted = await pool.query("SELECT a.status AS assignment_status, c.status AS campaign_status FROM audit_assignments a JOIN audit_campaigns c ON c.id=a.campaign_id WHERE c.id=$1", [needyId]);
      expect(persisted.rows[0].assignment_status).toBe("overdue");
      expect(persisted.rows[0].campaign_status).toBe("in_progress");
    } finally { client.release(); }
  });
});
