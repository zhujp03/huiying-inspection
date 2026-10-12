import { uuidv7 } from "../../api/src/ids.js";

async function claimJobs(pool, workerId, leaseSeconds, limit) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(`WITH candidates AS (
      SELECT id,status previous_status FROM archive_restore_jobs
      WHERE status='queued' OR (status='restoring' AND lease_expires_at<=now())
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $1
    ) UPDATE archive_restore_jobs job SET status='restoring',locked_by=$2,locked_at=now(),lease_expires_at=now()+($3::text || ' seconds')::interval
      FROM candidates WHERE job.id=candidates.id RETURNING job.*,candidates.previous_status`, [limit, workerId, leaseSeconds]);
    await client.query("COMMIT");
    return claimed.rows;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function finish(pool, job, workerId, state) {
  const ready = state.status === "ready";
  const result = await pool.query(`UPDATE archive_restore_jobs SET status=$3,restore_expires_at=$4,completed_at=CASE WHEN $3='ready' THEN now() ELSE completed_at END,
    failure_code=NULL,locked_by=NULL,locked_at=NULL,lease_expires_at=NULL WHERE id=$1 AND status='restoring' AND locked_by=$2`, [job.id, workerId, state.status, ready ? state.expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000) : null]);
  return result.rowCount === 1;
}

async function fail(pool, job, workerId, error) {
  await pool.query(`UPDATE archive_restore_jobs SET status='failed',failure_code=$3,locked_by=NULL,locked_at=NULL,lease_expires_at=NULL
    WHERE id=$1 AND status='restoring' AND locked_by=$2`, [job.id, workerId, String(error?.code || "ARCHIVE_RESTORE_FAILED").slice(0, 100)]);
}

export async function runArchiveRestoreJobs({ pool, cos, leaseSeconds = 300, limit = 5 }) {
  const workerId = uuidv7();
  const jobs = await claimJobs(pool, workerId, leaseSeconds, limit);
  const result = { claimed: jobs.length, ready: 0, restoring: 0, failed: 0, lostLease: 0 };
  for (const job of jobs) {
    try {
      if (job.previous_status === "queued") await cos.requestArchiveRestore({ key: job.storage_key, storageVersionId: job.storage_version_id });
      const state = await cos.archiveRestoreStatus({ key: job.storage_key, storageVersionId: job.storage_version_id });
      if (await finish(pool, job, workerId, state)) result[state.status] += 1;
      else result.lostLease += 1;
    } catch (error) {
      await fail(pool, job, workerId, error);
      result.failed += 1;
    }
  }
  return result;
}
