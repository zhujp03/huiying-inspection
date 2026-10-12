import { loadConfig } from "../../api/src/config.js";
import { createPool } from "../../api/src/db/pool.js";
import { uuidv7 } from "../../api/src/ids.js";
import { advanceCampaignOverdue, selectOverdueCampaigns } from "../../api/src/campaign-state.js";
import { createStorageProvider } from "../../api/src/storage/index.js";
import { runObjectCleanupJobs } from "./object-cleanup.js";
import { createOcrClient } from "./ocr-client.js";
import { runReceiptOcrJobs } from "./receipt-ocr.js";
import { recoverStaleSubmissions } from "./submission-recovery.js";
import { expireExportJobs, runExportJobs } from "./export-jobs.js";
import { runArchiveRestoreJobs } from "./archive-restores.js";
import { runRetention } from "./retention.js";
import { runObjectReconciliation } from "./object-reconciliation.js";

const config = loadConfig();
const pool = createPool({ ...config, DATABASE_POOL_MAX: 5 });
const cos = createStorageProvider(config);
const ocr = createOcrClient(config);
if (!pool) throw new Error("Worker requires DATABASE_URL; it never uses in-memory queues");
await pool.query("SELECT 1");
const recordJobRun = async (job, detail = null) => {
  await pool.query("INSERT INTO system_job_runs (id, job, status, completed_at, heartbeat_at, detail_json) VALUES ($1, $2, 'completed', now(), now(), $3)", [uuidv7(), job, detail ? JSON.stringify(detail) : null]);
};
let ticking = false;
async function advanceOverdueCampaigns() {
  if (ticking) return;
  ticking = true;
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const campaigns = await selectOverdueCampaigns(client);
      for (const campaign of campaigns) await advanceCampaignOverdue(client, campaign);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  } finally { ticking = false; }
}
async function tick() {
  await advanceOverdueCampaigns();
  if (cos.configured) await runObjectCleanupJobs({ pool, cos });
  if (cos.configured) await runArchiveRestoreJobs({ pool, cos });
  if (cos.exportConfigured) {
    await expireExportJobs({ pool, cos });
    await runExportJobs({ pool, cos });
  }
  await recoverStaleSubmissions({ pool });
  await runRetention({ pool, policyVersion: config.RETENTION_POLICY_VERSION });
  if (cos.configured) await runObjectReconciliation({ pool, cos, policyVersion: config.RETENTION_POLICY_VERSION, sampleSize: config.OBJECT_RECONCILIATION_SAMPLE_SIZE });
}
// OCR 小票识别使用独立、可配置的轮询间隔与有界并发；间隔和并发都有安全上下界
// （见 config.js OCR_WORKER_*）。单轮最多领取 claimLimit 个 job，同时最多
// maxConcurrency 个 job 并行，不展开无界 Promise。
let ocrTicking = false;
async function ocrTick() {
  // OCR 功能关闭（provider=none → configured=false）或 COS 未配置时静默早退，
  // 避免每个轮询间隔都产生 OCR 未配置报错。
  if (ocrTicking || !cos.configured || !ocr.configured) return;
  ocrTicking = true;
  try {
    const outcome = await runReceiptOcrJobs({
      pool, cos, ocr,
      leaseSeconds: config.OCR_JOB_LEASE_SECONDS,
      limit: config.OCR_WORKER_CLAIM_LIMIT,
      maxConcurrency: config.OCR_WORKER_MAX_CONCURRENCY,
    });
    if (outcome.claimed > 0 || outcome.queuedCount > 0) console.log("receipt OCR poll", JSON.stringify(outcome));
  } catch (error) { console.error("receipt OCR poll failed", { code: error.code }); }
  finally { ocrTicking = false; }
}
const timer = setInterval(() => tick().catch((error) => console.error("worker tick failed", { code: error.code })), 60_000);
const ocrTimer = setInterval(() => ocrTick().catch((error) => console.error("ocr tick failed", { code: error.code })), config.OCR_WORKER_POLL_INTERVAL_MS);
await tick();
await ocrTick();
// 心跳与告警数据源：metrics 的 worker_heartbeat_age_seconds 依赖该行。
await recordJobRun("worker_heartbeat");
setInterval(() => recordJobRun("worker_heartbeat").catch(() => {}), 60_000);
process.on("SIGTERM", async () => { clearInterval(timer); clearInterval(ocrTimer); await pool.end(); process.exit(0); });
process.on("SIGINT", async () => { clearInterval(timer); clearInterval(ocrTimer); await pool.end(); process.exit(0); });
console.log(`worker connected; overdue advancement, object cleanup, archive restores, exports, submission recovery, and retention run every minute; receipt OCR polls every ${config.OCR_WORKER_POLL_INTERVAL_MS}ms with concurrency ${config.OCR_WORKER_MAX_CONCURRENCY}`);
