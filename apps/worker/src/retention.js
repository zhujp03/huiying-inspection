import { uuidv7 } from "../../api/src/ids.js";

export async function runRetention({ pool, policyVersion, leaseSeconds = 900 }) {
  const workerId = uuidv7();
  const client = await pool.connect();
  let advisoryHeld = false;
  try {
    await client.query("BEGIN");
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('junde-retention-run')) acquired");
    if (!lock.rows[0].acquired) { await client.query("COMMIT"); return { skipped: true }; }
    advisoryHeld = true;
    const done = await client.query("SELECT 1 FROM retention_runs WHERE policy_version=$1 AND status='succeeded' AND started_at>=date_trunc('day',now()) LIMIT 1", [policyVersion]);
    if (done.rows[0]) { await client.query("COMMIT"); return { skipped: true }; }
    const stale = await client.query("SELECT id FROM retention_runs WHERE status='running' AND lease_expires_at<=now() ORDER BY started_at FOR UPDATE SKIP LOCKED LIMIT 1");
    const run = stale.rows[0]
      ? (await client.query("UPDATE retention_runs SET locked_by=$2,lease_expires_at=now()+($3::text || ' seconds')::interval,started_at=now(),error_code=NULL WHERE id=$1 RETURNING *", [stale.rows[0].id, workerId, leaseSeconds])).rows[0]
      : (await client.query("INSERT INTO retention_runs (id,policy_version,status,locked_by,lease_expires_at) VALUES ($1,$2,'running',$3,now()+($4::text || ' seconds')::interval) RETURNING *", [uuidv7(), policyVersion, workerId, leaseSeconds])).rows[0];
    await client.query("COMMIT");
    const results = {
      sessions: (await pool.query(`DELETE FROM auth_sessions session
        WHERE session.absolute_expires_at<now()-INTERVAL '30 days' AND NOT EXISTS (
          SELECT 1 FROM legal_holds hold WHERE hold.subject_type='user' AND hold.subject_id=session.user_id
            AND hold.starts_at<=now() AND hold.hold_until>now() AND hold.released_at IS NULL
        ) RETURNING session.id`)).rowCount,
      challenges: (await pool.query("DELETE FROM phone_verification_challenges WHERE created_at<now()-INTERVAL '30 days' AND (expires_at<now() OR consumed_at IS NOT NULL OR invalidated_at IS NOT NULL) RETURNING id")).rowCount,
      resetTokens: (await pool.query(`DELETE FROM password_reset_tokens token
        WHERE token.created_at<now()-INTERVAL '30 days' AND (token.expires_at<now() OR token.consumed_at IS NOT NULL) AND NOT EXISTS (
          SELECT 1 FROM legal_holds hold WHERE hold.subject_type='user' AND hold.subject_id=token.user_id
            AND hold.starts_at<=now() AND hold.hold_until>now() AND hold.released_at IS NULL
        ) RETURNING token.id`)).rowCount,
      rateBuckets: (await pool.query("DELETE FROM rate_limit_buckets WHERE expires_at<now() RETURNING scope")).rowCount,
    };
    const finished = await pool.query("UPDATE retention_runs SET status='succeeded',completed_at=now(),counts_json=$3,lease_expires_at=now() WHERE id=$1 AND status='running' AND locked_by=$2", [run.id, workerId, JSON.stringify(results)]);
    return { skipped: false, ...results, completed: finished.rowCount === 1 };
  } catch (error) {
    await pool.query("UPDATE retention_runs SET status='failed',completed_at=now(),error_code=$2 WHERE status='running' AND locked_by=$1", [workerId, String(error?.code || "RETENTION_FAILED").slice(0, 100)]).catch(() => {});
    throw error;
  } finally {
    if (advisoryHeld) await client.query("SELECT pg_advisory_unlock(hashtext('junde-retention-run'))").catch(() => {});
    client.release();
  }
}
