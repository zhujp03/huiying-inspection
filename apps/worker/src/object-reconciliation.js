import { uuidv7 } from "../../api/src/ids.js";

const reconciliationRows = `SELECT id,storage_key,storage_version_id,size_bytes,sha256 FROM (
  SELECT id,storage_key,storage_version_id,size_bytes,sha256 FROM question_evidence_attachments
  WHERE status='active' AND size_bytes IS NOT NULL AND sha256 IS NOT NULL
  UNION ALL
  SELECT id,storage_key,storage_version_id,size_bytes,sha256 FROM receipt_attachments
  WHERE status='ready' AND size_bytes IS NOT NULL AND sha256 IS NOT NULL
  UNION ALL
  SELECT id,storage_key,storage_version_id,size_bytes,sha256 FROM other_record_highlight_photos
  WHERE status='ready' AND size_bytes IS NOT NULL AND sha256 IS NOT NULL
) objects ORDER BY md5(objects.id::text || current_date::text) LIMIT $1`;

export async function runObjectReconciliation({ pool, cos, policyVersion, sampleSize, leaseSeconds = 900 }) {
  const workerId = uuidv7();
  const client = await pool.connect();
  let advisoryHeld = false;
  let run;
  try {
    await client.query("BEGIN");
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('junde-object-reconciliation-run')) acquired");
    advisoryHeld = lock.rows[0].acquired;
    if (!advisoryHeld) { await client.query("COMMIT"); return { skipped: "locked" }; }
    const done = await client.query("SELECT 1 FROM object_reconciliation_runs WHERE policy_version=$1 AND status='succeeded' AND started_at>=date_trunc('day',now()) LIMIT 1", [policyVersion]);
    if (done.rowCount) { await client.query("COMMIT"); return { skipped: "already_completed" }; }
    const stale = await client.query("SELECT id FROM object_reconciliation_runs WHERE status='running' AND lease_expires_at<=now() ORDER BY started_at FOR UPDATE SKIP LOCKED LIMIT 1");
    run = stale.rowCount
      ? (await client.query("UPDATE object_reconciliation_runs SET policy_version=$2,locked_by=$3,lease_expires_at=now()+($4::text || ' seconds')::interval,started_at=now(),completed_at=NULL,sampled_count=0,matched_count=0,mismatch_count=0,error_code=NULL WHERE id=$1 RETURNING *", [stale.rows[0].id, policyVersion, workerId, leaseSeconds])).rows[0]
      : (await client.query("INSERT INTO object_reconciliation_runs (id,policy_version,status,locked_by,lease_expires_at) VALUES ($1,$2,'running',$3,now()+($4::text || ' seconds')::interval) RETURNING *", [uuidv7(), policyVersion, workerId, leaseSeconds])).rows[0];
    await client.query("COMMIT");
    const objects = await pool.query(reconciliationRows, [sampleSize]);
    let matched = 0;
    let mismatches = 0;
    for (const object of objects.rows) {
      try {
        await cos.verifyStoredObject({ key: object.storage_key, storageVersionId: object.storage_version_id, expectedSizeBytes: Number(object.size_bytes), expectedSha256: object.sha256 });
        matched += 1;
      } catch {
        mismatches += 1;
      }
    }
    const status = mismatches ? "failed" : "succeeded";
    await pool.query(`UPDATE object_reconciliation_runs SET status=$3,completed_at=now(),lease_expires_at=now(),sampled_count=$4,matched_count=$5,mismatch_count=$6,error_code=$7
      WHERE id=$1 AND status='running' AND locked_by=$2`, [run.id, workerId, status, objects.rowCount, matched, mismatches, mismatches ? "OBJECT_RECONCILIATION_MISMATCH" : null]);
    return { sampled: objects.rowCount, matched, mismatches, status };
  } catch (error) {
    if (run) await pool.query("UPDATE object_reconciliation_runs SET status='failed',completed_at=now(),lease_expires_at=now(),error_code=$3 WHERE id=$1 AND status='running' AND locked_by=$2", [run.id, workerId, String(error?.code || "OBJECT_RECONCILIATION_FAILED").slice(0, 100)]).catch(() => {});
    throw error;
  } finally {
    if (advisoryHeld) await client.query("SELECT pg_advisory_unlock(hashtext('junde-object-reconciliation-run'))").catch(() => {});
    client.release();
  }
}
