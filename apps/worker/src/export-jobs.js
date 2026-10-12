import { uuidv7 } from "../../api/src/ids.js";
import { buildSubmissionExportFilterConditions, DashboardFilterSchema } from "../../../packages/contracts/index.js";
import { fetchDashboardStats } from "../../api/src/stats/queries.js";
import { buildDashboardWorkbook, XLSX_CONTENT_TYPE } from "./dashboard-export.js";

const MAX_EXPORT_ROWS = 10_000;
const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const csv = (rows) => [
  ["提交时间", "任务", "门店编号", "门店", "区域", "探店员", "总分", "满分", "得分率", "不得分数"],
  ...rows.map((row) => [row.submitted_at.toISOString(), row.task_name, row.business_no, row.store_name, row.region_name, row.inspector_name, row.total_score, row.max_score, `${Math.round(Number(row.total_score) / Number(row.max_score) * 100)}%`, row.issue_count]),
].map((line) => line.map(csvCell).join(",")).join("\r\n");

async function claimJobs(pool, workerId, leaseSeconds, limit) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(`WITH candidates AS (
      SELECT id FROM export_jobs WHERE (status='queued' AND expires_at>now()) OR (status='processing' AND lease_expires_at<=now() AND expires_at>now())
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $1
    ) UPDATE export_jobs job SET status='processing',locked_by=$2,lease_expires_at=now()+($3::text || ' seconds')::interval,failure_code=NULL
      FROM candidates WHERE job.id=candidates.id RETURNING job.*`, [limit, workerId, leaseSeconds]);
    await client.query("COMMIT");
    return claimed.rows;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function submissionRows(pool, job) {
  const request = job.filters_json || {};
  const filters = request.filters || {};
  // 过渡期兼容：存量 filters_json 及 reexport 原样复制的旧键 issueCountAtLeast 与 maxIssueCount 同义取 <=；
  // 导出任务 7 天过期、存量任务清空后可移除该兜底（2026-10-11 方向反转修正）。
  const conditions = buildSubmissionExportFilterConditions({ ...filters, maxIssueCount: filters.maxIssueCount ?? filters.issueCountAtLeast });
  // 比较方向以 contracts 的 SUBMISSION_EXPORT_FILTER_RULES 为唯一事实源，此处不硬编码比较符；
  // 参数仅出现在「列 op $N」位置，类型由 PostgreSQL 按列推断，无需显式 cast。
  const params = [JSON.stringify(job.scope_snapshot_json || []), request.submissionId || null];
  const filterSql = conditions.map(({ column, op, value }) => { params.push(value); return `${column} ${op} $${params.length}`; });
  const rows = await pool.query(`SELECT submission.submitted_at,campaign.name task_name,assignment.business_no,store.name store_name,region.name region_name,
      inspector.display_name inspector_name,submission.total_score,submission.max_score,submission.issue_count
    FROM submission_versions submission JOIN audit_assignments assignment ON assignment.id=submission.assignment_id
    JOIN audit_campaigns campaign ON campaign.id=submission.campaign_id JOIN stores store ON store.id=campaign.store_id
    JOIN regions region ON region.id=store.region_id JOIN users inspector ON inspector.id=submission.submitted_by
    WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS scope(scope_type text,region_id uuid,store_id uuid)
      WHERE scope.scope_type='all' OR (scope.scope_type='region' AND scope.region_id=region.id) OR (scope.scope_type='store' AND scope.store_id=store.id))
      AND ($2::uuid IS NULL OR submission.id=$2)${filterSql.length ? ` AND ${filterSql.join(" AND ")}` : ""}
    ORDER BY submission.submitted_at DESC LIMIT $${params.length + 1}`, [...params, MAX_EXPORT_ROWS + 1]);
  if (rows.rows.length > MAX_EXPORT_ROWS) throw Object.assign(new Error("导出记录过多，请缩小筛选范围"), { code: "EXPORT_TOO_LARGE" });
  return rows.rows;
}

async function finishJob(pool, job, workerId, storageKey, fileName) {
  const result = await pool.query(`UPDATE export_jobs SET status='succeeded',storage_key=$3,file_name=$4,completed_at=now(),
    locked_by=NULL,lease_expires_at=NULL,failure_code=NULL WHERE id=$1 AND status='processing' AND locked_by=$2`, [job.id, workerId, storageKey, fileName]);
  return result.rowCount === 1;
}

async function failJob(pool, job, workerId, error) {
  await pool.query(`UPDATE export_jobs SET status='failed',locked_by=NULL,lease_expires_at=NULL,failure_code=$3
    WHERE id=$1 AND status='processing' AND locked_by=$2`, [job.id, workerId, String(error?.code || "EXPORT_FAILED").slice(0, 100)]);
}

export async function expireExportJobs({ pool, cos, limit = 100 }) {
  const expired = await pool.query(`UPDATE export_jobs SET status='expired' WHERE status IN ('queued','failed') AND expires_at<=now() RETURNING id`);
  const complete = await pool.query("SELECT id,storage_key FROM export_jobs WHERE status='succeeded' AND expires_at<=now() ORDER BY expires_at,id LIMIT $1", [limit]);
  // succeeded→expired：先删 COS 对象再落库 expired，保留文件字段作审计痕迹（0032 单向约束下合法）。
  // 逐 job try/catch：单 job COS 失败只记 failed 计数不中断循环，该行保持 succeeded 由下轮重试，
  // 避免一个 job 失败冒泡中断整个 worker tick。返回对象扩展 failed 字段不破坏既有消费方
  // （worker.js 仅调用不读返回值，已 grep 确认）。
  let expiredCount = expired.rowCount;
  let failed = 0;
  for (const job of complete.rows) {
    try {
      await cos.deleteExportObject(job.storage_key);
      await pool.query("UPDATE export_jobs SET status='expired' WHERE id=$1 AND status='succeeded'", [job.id]);
      expiredCount += 1;
    } catch (error) {
      failed += 1;
      console.error(`expireExportJobs: export job ${job.id} COS 删除失败，保持 succeeded 待下轮重试`, { code: error?.code, message: error?.message });
    }
  }
  return { expired: expiredCount, failed };
}

export async function runExportJobs({ pool, cos, leaseSeconds = 300, limit = 1 }) {
  const workerId = uuidv7();
  const jobs = await claimJobs(pool, workerId, leaseSeconds, limit);
  const result = { claimed: jobs.length, completed: 0, failed: 0, lostLease: 0 };
  for (const job of jobs) {
    const isDashboard = job.job_kind === "dashboard";
    const storageKey = `exports/${job.id}/${workerId}${isDashboard ? ".xlsx" : ".csv"}`;
    try {
      let body;
      let fileName;
      let contentType = "text/csv; charset=utf-8";
      if (isDashboard) {
        // 看板导出按请求人当时的 user_data_scopes 过滤（fetchDashboardStats 内置 scope EXISTS）。
        const filter = DashboardFilterSchema.parse(job.filters_json?.dashboardFilters || {});
        const stats = await fetchDashboardStats(pool, filter, job.requested_by);
        body = Buffer.from(await buildDashboardWorkbook(stats));
        fileName = `数据看板导出_${stats.range.from}_${stats.range.to}.xlsx`;
        contentType = XLSX_CONTENT_TYPE;
      } else {
        body = Buffer.from(`\ufeff${csv(await submissionRows(pool, job))}`, "utf8");
        fileName = "提交记录导出.csv";
      }
      await cos.putExportObject({ key: storageKey, body, contentType });
      if (await finishJob(pool, job, workerId, storageKey, fileName)) result.completed += 1;
      else { await cos.deleteExportObject(storageKey); result.lostLease += 1; }
    } catch (error) {
      await failJob(pool, job, workerId, error);
      result.failed += 1;
    }
  }
  return result;
}
