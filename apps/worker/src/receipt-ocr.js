import { uuidv7 } from "../../api/src/ids.js";
import { parseReceiptLines } from "./receipt-parser.js";

const RETRY_DELAY_SECONDS = 60;

const normalizeLines = (lines) => {
  if (!Array.isArray(lines) || lines.length > 2000) {
    const error = new Error("OCR response is invalid");
    error.code = "OCR_RESPONSE_INVALID";
    throw error;
  }
  return lines.map((line) => {
    const text = String(line?.text || "").trim();
    if (!text || text.length > 2000) {
      const error = new Error("OCR response is invalid");
      error.code = "OCR_RESPONSE_INVALID";
      throw error;
    }
    const confidence = Number(line.confidence);
    return {
      text,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      boundingBox: Array.isArray(line.boundingBox) ? line.boundingBox : [],
    };
  });
};

async function claimJobs(pool, workerId, leaseSeconds, limit) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(`WITH candidates AS (
      SELECT id FROM receipt_ocr_jobs
      WHERE (status='queued' AND next_attempt_at<=now())
         OR (status='processing' AND lease_expires_at<=now())
      ORDER BY next_attempt_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT $1
    ) UPDATE receipt_ocr_jobs job SET status='processing',locked_by=$2,locked_at=now(),
      lease_expires_at=now()+($3::text || ' seconds')::interval,heartbeat_at=now(),
      started_at=COALESCE(started_at,now()),attempt_count=attempt_count+1
      FROM candidates WHERE job.id=candidates.id RETURNING job.*`, [limit, workerId, leaseSeconds]);
    await client.query("COMMIT");
    return claimed.rows;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function heartbeat(pool, jobId, workerId, leaseSeconds) {
  const result = await pool.query(`UPDATE receipt_ocr_jobs SET heartbeat_at=now(),lease_expires_at=now()+($3::text || ' seconds')::interval
    WHERE id=$1 AND status='processing' AND locked_by=$2`, [jobId, workerId, leaseSeconds]);
  return result.rowCount === 1;
}

async function cancelIfNeeded(pool, jobId, workerId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const state = await client.query(`SELECT job.*,attempt.status attempt_status FROM receipt_ocr_jobs job
      JOIN survey_attempts attempt ON attempt.id=job.attempt_id WHERE job.id=$1 FOR UPDATE OF job`, [jobId]);
    const job = state.rows[0];
    if (!job || job.status !== "processing" || job.locked_by !== workerId) { await client.query("COMMIT"); return true; }
    if (!job.cancellation_requested_at && job.attempt_status === "draft") { await client.query("COMMIT"); return false; }
    await client.query(`UPDATE receipt_ocr_jobs SET status='cancelled',locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,
      heartbeat_at=now(),completed_at=now(),failure_code=NULL,failure_detail_redacted=NULL WHERE id=$1`, [jobId]);
    await client.query("COMMIT");
    return true;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function retryOrFail(pool, job, workerId, error) {
  const code = String(error?.code || "OCR_FAILED").slice(0, 100);
  const permanent = code === "OCR_RESPONSE_INVALID" || code === "OCR_OBJECT_INVALID";
  const exhausted = permanent || Number(job.attempt_count) >= Number(job.max_attempts);
  await pool.query(`UPDATE receipt_ocr_jobs SET status=$3,locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,heartbeat_at=now(),
    next_attempt_at=CASE WHEN $4 THEN now() ELSE now()+($5::text || ' seconds')::interval END,
    completed_at=CASE WHEN $4 THEN now() ELSE NULL END,failure_code=$6,failure_detail_redacted=NULL
    WHERE id=$1 AND status='processing' AND locked_by=$2`, [job.id, workerId, exhausted ? "failed" : "queued", exhausted, RETRY_DELAY_SECONDS, code]);
}

async function persistResult(pool, job, workerId, attachmentResults) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const state = await client.query(`SELECT job.*,attempt.status attempt_status FROM receipt_ocr_jobs job
      JOIN survey_attempts attempt ON attempt.id=job.attempt_id WHERE job.id=$1 FOR UPDATE OF job`, [job.id]);
    const current = state.rows[0];
    if (!current || current.status !== "processing" || current.locked_by !== workerId) { await client.query("COMMIT"); return false; }
    if (current.cancellation_requested_at || current.attempt_status !== "draft") {
      await client.query("UPDATE receipt_ocr_jobs SET status='cancelled',locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,heartbeat_at=now(),completed_at=now() WHERE id=$1", [job.id]);
      await client.query("COMMIT");
      return false;
    }
    let candidateCount = 0;
    let candidateOrder = 1;
    for (const attachment of attachmentResults) {
      for (const [index, line] of attachment.lines.entries()) await client.query(`INSERT INTO receipt_ocr_lines
        (id,job_id,attachment_id,line_order,text,confidence,bounding_box_json) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv7(), job.id, attachment.attachmentId, index + 1, line.text, line.confidence, JSON.stringify(line.boundingBox)]);
      for (const candidate of attachment.candidates) {
        await client.query(`INSERT INTO receipt_ocr_candidates
          (id,job_id,attachment_id,raw_name,normalized_name,quantity,unit_price_cents,line_total_cents,name_confidence,quantity_confidence,unit_price_confidence,line_total_confidence,source_text,source_bounding_box,sort_order,status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9,$9,$10,$11,$12,'proposed')`,
        [uuidv7(), job.id, attachment.attachmentId, candidate.rawName, candidate.normalizedName, candidate.quantity, candidate.unitPriceCents, candidate.lineTotalCents, candidate.confidence, candidate.sourceText, JSON.stringify(candidate.boundingBox), candidateOrder++]);
        candidateCount += 1;
      }
    }
    await client.query(`UPDATE receipt_ocr_jobs SET status=$2,locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,heartbeat_at=now(),completed_at=now(),failure_code=NULL,failure_detail_redacted=NULL
      WHERE id=$1`, [job.id, candidateCount > 0 ? "succeeded" : "partial"]);
    await client.query("COMMIT");
    return true;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function runJob({ pool, cos, ocr, job, workerId, leaseSeconds }) {
  if (await cancelIfNeeded(pool, job.id, workerId)) return { cancelled: 1 };
  const inputs = await pool.query(`SELECT input.attachment_id,attachment.storage_key,attachment.status,attachment.sha256,input.sha256_snapshot
    FROM receipt_ocr_job_attachments input JOIN receipt_attachments attachment ON attachment.id=input.attachment_id
    WHERE input.job_id=$1 ORDER BY input.display_order`, [job.id]);
  const results = [];
  for (const input of inputs.rows) {
    if (input.status !== "ready" || input.sha256 !== input.sha256_snapshot) {
      const error = new Error("OCR input is no longer valid"); error.code = "OCR_OBJECT_INVALID"; throw error;
    }
    if (!await heartbeat(pool, job.id, workerId, leaseSeconds)) return { lostLease: 1 };
    const bytes = await cos.readObject(input.storage_key);
    const lines = normalizeLines(await ocr.recognize(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)));
    results.push({ attachmentId: input.attachment_id, lines, candidates: parseReceiptLines(lines) });
  }
  return (await persistResult(pool, job, workerId, results)) ? { completed: 1 } : { lostLease: 1 };
}

export async function runReceiptOcrJobs({ pool, cos, ocr, leaseSeconds = 300, limit = 1, maxConcurrency = 1 }) {
  const workerId = uuidv7();
  const claimLimit = Math.max(1, Math.min(64, Number(limit) || 1));
  const concurrency = Math.max(1, Math.min(8, Number(maxConcurrency) || 1));
  const jobs = await claimJobs(pool, workerId, leaseSeconds, claimLimit);
  const result = { claimed: jobs.length, completed: 0, cancelled: 0, retried: 0, failed: 0, lostLease: 0 };
  // 有界并行：同一时间最多 concurrency 个 job 并行处理（单 job 内附件仍串行），
  // 不会因 Promise 无界展开导致 OOM。
  let cursor = 0;
  const processOne = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor];
      cursor += 1;
      try {
        const outcome = await runJob({ pool, cos, ocr, job, workerId, leaseSeconds });
        for (const [key, value] of Object.entries(outcome)) result[key] = (result[key] || 0) + value;
      } catch (error) {
        await retryOrFail(pool, job, workerId, error);
        if (Number(job.attempt_count) >= Number(job.max_attempts) || ["OCR_RESPONSE_INVALID", "OCR_OBJECT_INVALID"].includes(error?.code)) result.failed += 1;
        else result.retried += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => processOne()));
  const queue = await pool.query(`SELECT count(*)::int count, COALESCE(max(now()-created_at), interval '0') oldest FROM receipt_ocr_jobs WHERE status IN ('queued','processing')`);
  result.queuedCount = queue.rows[0].count;
  result.oldestQueuedAgeSeconds = Math.max(0, Math.round(Number(queue.rows[0].oldest) / 1000));
  return result;
}
