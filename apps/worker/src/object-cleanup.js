import { uuidv7 } from "../../api/src/ids.js";

const retryAt = (attemptCount) => new Date(Date.now() + Math.min(3_600_000, 1_000 * 2 ** Math.min(attemptCount, 10)));

export async function runObjectCleanupJobs({ pool, cos, limit = 20 }) {
  const leaseOwner = uuidv7();
  const client = await pool.connect();
  let jobs;
  try {
    await client.query("BEGIN");
    jobs = await client.query(`WITH candidates AS (
      SELECT id FROM object_cleanup_jobs
      WHERE (status IN ('queued','retryable_failed') AND next_attempt_at<=now())
         OR (status='running' AND lease_expires_at<=now())
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
    ) UPDATE object_cleanup_jobs job SET status='running',locked_by=$2,lease_expires_at=now()+INTERVAL '60 seconds',attempt_count=attempt_count+1,updated_at=now()
      FROM candidates WHERE job.id=candidates.id RETURNING job.*`, [limit, leaseOwner]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  for (const job of jobs.rows) {
    try {
      await cos.deleteObject(job.storage_key);
      await pool.query(`UPDATE object_cleanup_jobs SET status='succeeded',completed_at=now(),locked_by=NULL,lease_expires_at=NULL,last_error_code=NULL,updated_at=now()
        WHERE id=$1 AND locked_by=$2 AND status='running'`, [job.id, leaseOwner]);
    } catch (error) {
      await pool.query(`UPDATE object_cleanup_jobs SET status='retryable_failed',next_attempt_at=$3,locked_by=NULL,lease_expires_at=NULL,last_error_code=$4,updated_at=now()
        WHERE id=$1 AND locked_by=$2 AND status='running'`, [job.id, leaseOwner, retryAt(Number(job.attempt_count)), String(error.code || "OBJECT_DELETE_FAILED").slice(0, 100)]);
    }
  }
  return jobs.rows.length;
}
