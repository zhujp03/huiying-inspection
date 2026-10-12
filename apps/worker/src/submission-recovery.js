export async function recoverStaleSubmissions({ pool, limit = 100 }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const stale = await client.query(`SELECT key.id,key.attempt_id FROM idempotency_keys key
      WHERE key.scope='questionnaire_submit' AND key.status='processing' AND key.lease_expires_at<=now()
      ORDER BY key.lease_expires_at,key.id FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]);
    let recovered = 0;
    for (const key of stale.rows) {
      const submission = await client.query("SELECT submitted_at FROM submission_versions WHERE attempt_id=$1", [key.attempt_id]);
      if (submission.rows[0]) {
        const response = { status: "submitted", submittedAt: submission.rows[0].submitted_at.toISOString() };
        await client.query(`UPDATE idempotency_keys SET status='succeeded',response_status=200,response_body_json=$2,
          locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1`, [key.id, JSON.stringify(response)]);
      } else {
        await client.query(`UPDATE survey_attempts SET status='failed',submit_token=NULL,submitting_since=NULL
          WHERE id=$1 AND status='submitting' AND submitting_since<=now()-INTERVAL '60 seconds'`, [key.attempt_id]);
        await client.query(`UPDATE idempotency_keys SET status='retryable_failed',locked_by=NULL,locked_at=NULL,
          lease_expires_at=NULL,failure_code='SUBMIT_RECOVERY_REQUIRED',updated_at=now() WHERE id=$1`, [key.id]);
      }
      recovered += 1;
    }
    await client.query("COMMIT");
    return recovered;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
