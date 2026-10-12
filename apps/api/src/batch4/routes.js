import { createHash } from "node:crypto";
import { DishSaveRequestSchema, OtherRecordSaveRequestSchema, ReceiptCompleteRequestSchema, ReceiptDeleteRequestSchema, ReceiptOcrApplyRequestSchema, ReceiptOcrCreateRequestSchema, ReceiptUploadInitRequestSchema, SecureUuidSchema } from "../../../../packages/contracts/index.js";
import { validateDishes } from "../../../../packages/domain/index.js";
import { uuidv7 } from "../ids.js";
import { writeAudit } from "../audit.js";

// 小票关联的 OCR 带入菜品统计：removable=本小票 OCR 带入且未被人工修改的额外菜品行（可随小票删除）；
// protected=菜品要求行与被人工修改过的行（不允许自动删除）。来源标记为 dish_records.receipt_ocr_candidate_id，
// 存量 OCR 行若无该标记则不计入（保守返回 none），不会误报可删除。
const dishImpactFor = async (db, attemptId, attachmentId) => {
  const counted = await db.query(`SELECT
      count(*) FILTER (WHERE d.requirement_id IS NULL AND NOT d.manually_modified)::int AS removable_count,
      count(*) FILTER (WHERE d.requirement_id IS NOT NULL OR d.manually_modified)::int AS protected_count
    FROM dish_records d
    JOIN receipt_ocr_candidates c ON c.id = d.receipt_ocr_candidate_id
    JOIN receipt_ocr_jobs j ON j.id = c.job_id
    JOIN receipt_ocr_job_attachments ja ON ja.job_id = j.id
    WHERE d.attempt_id = $1 AND d.source = 'ocr' AND ja.attachment_id = $2`, [attemptId, attachmentId]);
  const removable = Number(counted.rows[0]?.removable_count || 0);
  const protectedCount = Number(counted.rows[0]?.protected_count || 0);
  return {
    dishImpact: removable + protectedCount === 0 ? "none" : protectedCount === 0 ? "removable_auto_rows" : removable === 0 ? "protected_rows" : "mixed",
    appliedDishCount: removable + protectedCount,
  };
};

const attachmentView = async (cos, attachment, db) => {
  const ready = attachment.status === "ready";
  const preview = ready ? await cos.createPreviewUrl(attachment.storage_key) : null;
  const impact = attachment.status === "deleted" ? { dishImpact: "none", appliedDishCount: 0 } : await dishImpactFor(db, attachment.attempt_id, attachment.id);
  return {
    id: attachment.id, displayOrder: Number(attachment.display_order), previewUrl: preview?.url || null, status: attachment.status,
    progressPercent: ready ? 100 : 0, failureKind: attachment.failure_code || null, canRetry: attachment.status === "failed",
    canDelete: attachment.status !== "deleted", ...impact,
  };
};

const dishView = (dish) => ({
  id: dish.id, requirementId: dish.requirement_id, plannedName: dish.planned_name, actualName: dish.actual_name,
  quantity: Number(dish.quantity || dish.planned_quantity || 1), unitPriceCents: dish.unit_price_cents, lineTotalCents: dish.line_total_cents,
  fulfillmentStatus: dish.fulfillment_status, substitutionReason: dish.substitution_reason, unavailableReason: dish.unavailable_reason,
  evaluation: dish.evaluation, fullySatisfied: dish.fully_satisfied, source: dish.source, manuallyModified: dish.manually_modified,
  priceDerived: dish.price_derived, reviewFields: dish.review_fields || [], required: dish.required_snapshot, allowSubstitution: dish.allow_substitution_snapshot,
});
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const jobView = (job, candidates = []) => ({
  id: job.id, status: job.status, recognizedDishCount: candidates.length,
  reviewFieldCount: candidates.reduce((count, candidate) => count + (candidate.quantity === null || candidate.unit_price_cents === null || candidate.line_total_cents === null ? 1 : 0), 0),
  userMessage: ({ queued: "小票已排队识别", processing: "正在识别小票", succeeded: "识别完成，请核对菜品", partial: "部分内容需要人工核对", failed: "识别未完成，可继续手工填写", cancelled: "识别已取消" })[job.status],
});

export function registerBatch4Routes(app, { pool, cos, config }) {
  const ocrProvider = config.OCR_PROVIDER || "none";
  // input_hash 的 provider 标签：paddle 沿用历史值 "paddleocr"（保持既有 job 幂等去重不变），
  // 切换 provider 时标签随之变化，防止命中旧 provider 的结果缓存。
  const ocrProviderLabel = ocrProvider === "paddle" ? "paddleocr" : ocrProvider;
  const ocrModelVersion = config.OCR_MODEL_VERSION || "PP-OCRv6_small";
  const ocrParserVersion = config.OCR_PARSER_VERSION || "receipt-parser-v1";
  const requireInspector = async (request) => {
    if (!app.jundeAuth.configured) throw app.jundeAuth.businessError("AUTH_NOT_CONFIGURED", "认证服务暂未配置", 503, { retryable: true });
    const session = await app.jundeAuth.sessionFor(request, false);
    if (session.kind !== "inspector" || session.user_status !== "approved_active") throw app.jundeAuth.businessError("FORBIDDEN", "你没有权限进行此操作", 403);
    return session;
  };
  const lockedAttempt = async (client, attemptId, userId) => {
    const found = await client.query(`SELECT sa.*,a.inspector_id,a.status assignment_status,a.id assignment_id FROM survey_attempts sa
      JOIN audit_assignments a ON a.id=sa.assignment_id WHERE sa.id=$1 AND a.inspector_id=$2 FOR UPDATE OF sa`, [attemptId, userId]);
    if (!found.rows[0]) throw app.jundeAuth.businessError("QUESTIONNAIRE_NOT_FOUND", "问卷不存在", 404);
    return found.rows[0];
  };
  const editable = (attempt) => {
    if (attempt.status !== "draft" || attempt.assignment_status !== "in_progress") throw app.jundeAuth.businessError("QUESTIONNAIRE_LOCKED", "当前问卷不能修改", 409);
  };
  const receiptItems = async (client, attemptId) => {
    const rows = await client.query("SELECT * FROM receipt_attachments WHERE attempt_id=$1 AND status<>'deleted' ORDER BY display_order", [attemptId]);
    return Promise.all(rows.rows.map((row) => attachmentView(cos, row, client)));
  };
  const ownedJob = async (client, attemptId, jobId, userId, lock = false) => {
    const result = await client.query(`SELECT job.* FROM receipt_ocr_jobs job JOIN survey_attempts sa ON sa.id=job.attempt_id
      JOIN audit_assignments assignment ON assignment.id=sa.assignment_id WHERE job.id=$1 AND job.attempt_id=$2 AND assignment.inspector_id=$3${lock ? " FOR UPDATE OF job" : ""}`, [jobId, attemptId, userId]);
    if (!result.rows[0]) throw app.jundeAuth.businessError("OCR_JOB_NOT_FOUND", "识别任务不存在", 404);
    return result.rows[0];
  };
  const readJob = async (client, job) => {
    const candidates = await client.query("SELECT * FROM receipt_ocr_candidates WHERE job_id=$1 ORDER BY sort_order,id", [job.id]);
    return jobView(job, candidates.rows);
  };

  app.get("/api/questionnaires/secret/drafts/:id/receipt-attachments", async (request) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const attempt = await pool.query(`SELECT sa.revision,sa.status FROM survey_attempts sa JOIN audit_assignments a ON a.id=sa.assignment_id WHERE sa.id=$1 AND a.inspector_id=$2`, [attemptId, session.user_id]);
    if (!attempt.rows[0]) throw app.jundeAuth.businessError("QUESTIONNAIRE_NOT_FOUND", "问卷不存在", 404);
    // 与草稿读取对齐：任务已提交后小票被快照锁定，不再开放读取/修改入口。
    if (attempt.rows[0].status === "submitted") throw app.jundeAuth.businessError("QUESTIONNAIRE_SUBMITTED", "该任务已提交，小票内容已锁定", 409);
    return { items: await receiptItems(pool, attemptId), revision: Number(attempt.rows[0].revision) };
  });

  app.post("/api/questionnaires/secret/drafts/:id/receipt-attachments/uploads", async (request, reply) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const body = ReceiptUploadInitRequestSchema.parse(request.body);
    // 凭证刷新（可能的网络调用）必须先于数据库事务，事务内只做纯本地签名。
    // 测试注入的 storage 替身可以只实现业务方法，此时跳过该预检。
    if (typeof cos.assertReady === "function") await cos.assertReady();
    const initialized = await app.jundeAuth.transaction(async (client) => {
      const attempt = await lockedAttempt(client, attemptId, session.user_id); editable(attempt);
      const existing = await client.query("SELECT * FROM receipt_attachments WHERE attempt_id=$1 AND client_file_id=$2 FOR UPDATE", [attemptId, body.fileMeta.clientFileId]);
      let attachment = existing.rows[0];
      let revision = Number(attempt.revision);
      if (attachment) {
        if (attachment.original_file_name !== body.fileMeta.fileName || attachment.declared_content_type !== body.fileMeta.mimeType || Number(attachment.declared_size_bytes) !== body.fileMeta.sizeBytes) throw app.jundeAuth.businessError("RECEIPT_UPLOAD_CONFLICT", "同一文件标识的上传内容不一致", 409);
      } else {
        if (revision !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
        const count = await client.query("SELECT count(*)::int count FROM receipt_attachments WHERE attempt_id=$1 AND status<>'deleted'", [attemptId]);
        if (count.rows[0].count >= 9) throw app.jundeAuth.businessError("RECEIPT_LIMIT_EXCEEDED", "最多只能上传 9 张消费小票", 422);
        const inserted = await client.query(`INSERT INTO receipt_attachments (id,attempt_id,client_file_id,display_order,storage_key,upload_nonce,declared_content_type,declared_size_bytes,original_file_name,status,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'uploading',$10) RETURNING *`, [uuidv7(), attemptId, body.fileMeta.clientFileId, count.rows[0].count + 1, `attempts/${attemptId}/receipts/${uuidv7()}/${cos.newObjectSuffix()}`, uuidv7(), body.fileMeta.mimeType, body.fileMeta.sizeBytes, body.fileMeta.fileName, session.user_id]);
        attachment = inserted.rows[0];
        revision = Number((await client.query("UPDATE survey_attempts SET revision=revision+1,last_saved_at=now() WHERE id=$1 RETURNING revision", [attemptId])).rows[0].revision);
      }
      const target = cos.createPostTarget({ key: attachment.storage_key, sizeBytes: Number(attachment.declared_size_bytes), uploadNonce: attachment.upload_nonce, contentType: attachment.declared_content_type });
      await client.query("UPDATE receipt_attachments SET upload_target_expires_at=$2,updated_at=now() WHERE id=$1", [attachment.id, target.expiresAt]);
      return { statusCode: existing.rows[0] ? 200 : 201, body: { attachment: await attachmentView(cos, attachment, client), uploadTarget: target, revision } };
    });
    return reply.code(initialized.statusCode).send(initialized.body);
  });

  app.post("/api/questionnaires/secret/drafts/:id/receipt-attachments/:attachmentId/complete", async (request, reply) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const attachmentId = SecureUuidSchema.parse(request.params.attachmentId);
    const body = ReceiptCompleteRequestSchema.parse(request.body);
    const leaseOwner = uuidv7();
    const reservation = await app.jundeAuth.transaction(async (client) => {
      const attempt = await lockedAttempt(client, attemptId, session.user_id); editable(attempt);
      if (Number(attempt.revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      const found = await client.query("SELECT * FROM receipt_attachments WHERE id=$1 AND attempt_id=$2 FOR UPDATE", [attachmentId, attemptId]);
      const attachment = found.rows[0];
      if (!attachment || attachment.client_file_id !== body.fileMeta.clientFileId || attachment.status === "deleted") throw app.jundeAuth.businessError("RECEIPT_NOT_FOUND", "消费小票不存在", 404);
      if (attachment.status === "ready") return { ready: true, attachment };
      if (attachment.status !== "uploading" || attachment.declared_content_type !== body.fileMeta.mimeType || Number(attachment.declared_size_bytes) !== body.fileMeta.sizeBytes) throw app.jundeAuth.businessError("RECEIPT_FILE_INVALID", "消费小票内容不一致", 422);
      if (attachment.verification_lease_expires_at && new Date(attachment.verification_lease_expires_at) > new Date()) return { pending: true };
      await client.query("UPDATE receipt_attachments SET verification_locked_by=$2,verification_lease_expires_at=now()+INTERVAL '60 seconds',updated_at=now() WHERE id=$1", [attachmentId, leaseOwner]);
      return { attachment };
    });
    if (reservation.ready) return { attachment: await attachmentView(cos, reservation.attachment, pool), revision: body.revision };
    if (reservation.pending) return reply.header("Retry-After", "1").code(202).send({ attachment: await attachmentView(cos, reservation.attachment, pool), revision: body.revision });
    let verified;
    try { verified = await cos.verifyObject({ key: reservation.attachment.storage_key, uploadNonce: reservation.attachment.upload_nonce, expectedSizeBytes: Number(reservation.attachment.declared_size_bytes), type: "image", declaredContentType: reservation.attachment.declared_content_type }); }
    catch (error) {
      await app.jundeAuth.transaction((client) => client.query("UPDATE receipt_attachments SET status='failed',failure_code=$2,verification_locked_by=NULL,verification_lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND verification_locked_by=$3", [attachmentId, String(error.code || "RECEIPT_VERIFY_FAILED").slice(0, 100), leaseOwner]));
      if (error.statusCode) throw error;
      throw app.jundeAuth.businessError("RECEIPT_FILE_INVALID", "消费小票校验失败，请重新上传", 422);
    }
    return app.jundeAuth.transaction(async (client) => {
      const attempt = await lockedAttempt(client, attemptId, session.user_id); editable(attempt);
      const found = await client.query("SELECT * FROM receipt_attachments WHERE id=$1 AND attempt_id=$2 FOR UPDATE", [attachmentId, attemptId]);
      const attachment = found.rows[0];
      if (!attachment || attachment.verification_locked_by !== leaseOwner || attachment.status !== "uploading") throw app.jundeAuth.businessError("RECEIPT_VERIFY_STALE", "消费小票校验已失效，请重新上传", 409);
      if (verified.sha256.toLowerCase() !== body.fileMeta.sha256.toLowerCase()) throw app.jundeAuth.businessError("RECEIPT_HASH_MISMATCH", "消费小票校验和不匹配", 422);
      try {
        const finalized = await client.query("UPDATE receipt_attachments SET status='ready',mime_type=$2,size_bytes=$3,sha256=$4,storage_version_id=$5,verified_at=now(),verification_locked_by=NULL,verification_lease_expires_at=NULL,updated_at=now() WHERE id=$1 RETURNING *", [attachmentId, verified.mimeType, verified.sizeBytes, verified.sha256.toLowerCase(), verified.storageVersionId]);
        const revision = Number((await client.query("UPDATE survey_attempts SET revision=revision+1,last_saved_at=now() WHERE id=$1 RETURNING revision", [attemptId])).rows[0].revision);
        await writeAudit(client, session, "receipt_uploaded", "assignment", attempt.assignment_id, { attemptId, attachmentId, sizeBytes: verified.sizeBytes });
        return { attachment: await attachmentView(cos, finalized.rows[0], client), revision };
      } catch (error) {
        if (error.code === "23505") throw app.jundeAuth.businessError("RECEIPT_DUPLICATE", "该消费小票已上传", 409);
        throw error;
      }
    });
  });

  app.delete("/api/questionnaires/secret/drafts/:id/receipt-attachments/:attachmentId", async (request) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const attachmentId = SecureUuidSchema.parse(request.params.attachmentId);
    const body = ReceiptDeleteRequestSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const attempt = await lockedAttempt(client, attemptId, session.user_id); editable(attempt);
      if (Number(attempt.revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      const deleted = await client.query("UPDATE receipt_attachments SET status='deleted',deleted_at=now(),updated_at=now() WHERE id=$1 AND attempt_id=$2 AND status<>'deleted' RETURNING *", [attachmentId, attemptId]);
      if (!deleted.rows[0]) throw app.jundeAuth.businessError("RECEIPT_NOT_FOUND", "消费小票不存在", 404);
      // dishHandling=remove_unmodified_ocr_rows：删除本小票 OCR 带入且未被人工修改的额外菜品行；
      // 菜品要求行与已人工修改的行一律保留（dishImpact 为 protected_rows/mixed 时前端不会提供该选项）。
      let removedDishCount = 0;
      if (body.dishHandling === "remove_unmodified_ocr_rows") {
        const removed = await client.query(`DELETE FROM dish_records d
          USING receipt_ocr_candidates c, receipt_ocr_jobs j, receipt_ocr_job_attachments ja
          WHERE c.id = d.receipt_ocr_candidate_id AND j.id = c.job_id AND ja.job_id = j.id
            AND d.attempt_id = $1 AND d.source = 'ocr' AND d.requirement_id IS NULL AND NOT d.manually_modified
            AND ja.attachment_id = $2`, [attemptId, attachmentId]);
        removedDishCount = removed.rowCount || 0;
      }
      await client.query(`UPDATE receipt_ocr_jobs job SET cancellation_requested_at=COALESCE(cancellation_requested_at,now())
        FROM receipt_ocr_job_attachments input WHERE input.job_id=job.id AND input.attachment_id=$1
          AND job.status IN ('queued','processing')`, [attachmentId]);
      const revision = Number((await client.query("UPDATE survey_attempts SET revision=revision+1,last_saved_at=now() WHERE id=$1 RETURNING revision", [attemptId])).rows[0].revision);
      await writeAudit(client, session, "receipt_removed", "assignment", attempt.assignment_id, { attemptId, attachmentId, dishHandling: body.dishHandling, removedDishCount });
      const dishes = await client.query("SELECT * FROM dish_records WHERE attempt_id=$1 ORDER BY sort_order,id", [attemptId]);
      return { items: await receiptItems(client, attemptId), dishes: dishes.rows.map(dishView), revision };
    });
  });

  app.post("/api/questionnaires/secret/drafts/:id/receipt-ocr-jobs", async (request, reply) => {
    const session = await requireInspector(request);
    // OCR 功能关闭（provider=none）时失败关闭：入口直接 503 且不可重试，
    // 与 client-config 下发的 features.receiptOcr=false 一致；手工填写流程不受影响。
    if (ocrProvider === "none") throw app.jundeAuth.businessError("OCR_NOT_CONFIGURED", "小票识别功能未开启", 503, { retryable: false });
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const body = ReceiptOcrCreateRequestSchema.parse(request.body);
    const result = await app.jundeAuth.transaction(async (client) => {
      const attempt = await lockedAttempt(client, attemptId, session.user_id); editable(attempt);
      const requestHash = hash({ attachmentIds: body.attachmentIds, revision: body.revision });
      const replay = await client.query("SELECT * FROM receipt_ocr_jobs WHERE attempt_id=$1 AND request_idempotency_key=$2 FOR UPDATE", [attemptId, SecureUuidSchema.parse(body.idempotencyKey)]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw app.jundeAuth.businessError("IDEMPOTENCY_CONFLICT", "本次识别请求与上次不一致", 409);
        return { job: await readJob(client, replay.rows[0]), created: false };
      }
      if (Number(attempt.revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      const attachmentIds = body.attachmentIds.map((id) => SecureUuidSchema.parse(id));
      if (new Set(attachmentIds).size !== attachmentIds.length) throw app.jundeAuth.businessError("OCR_INPUT_INVALID", "消费小票不能重复选择", 422);
      const attachments = await client.query("SELECT * FROM receipt_attachments WHERE attempt_id=$1 AND id = ANY($2::uuid[]) AND status='ready' ORDER BY display_order FOR UPDATE", [attemptId, attachmentIds]);
      if (attachments.rows.length !== attachmentIds.length) throw app.jundeAuth.businessError("OCR_INPUT_INVALID", "请选择已完成上传的消费小票", 422);
      const inputHash = hash({ attachments: attachments.rows.map((item) => ({ id: item.id, sha256: item.sha256 })), provider: ocrProviderLabel, model: ocrModelVersion, parser: ocrParserVersion });
      const sameInput = await client.query("SELECT * FROM receipt_ocr_jobs WHERE attempt_id=$1 AND input_hash=$2 FOR UPDATE", [attemptId, inputHash]);
      if (sameInput.rows[0]) return { job: await readJob(client, sameInput.rows[0]), created: false };
      // 有界队列：排队+处理中超过上限时拒绝新任务，返回可重试 503，不无限堆积。
      const queueDepth = await client.query("SELECT count(*)::int count FROM receipt_ocr_jobs WHERE status IN ('queued','processing')");
      if (queueDepth.rows[0].count >= (config.OCR_MAX_QUEUED_JOBS || 500)) throw app.jundeAuth.businessError("OCR_QUEUE_FULL", "小票识别任务较多，请稍后重试", 503, { retryable: true });
      const job = (await client.query(`INSERT INTO receipt_ocr_jobs (id,attempt_id,status,model_version,parser_version,input_hash,request_idempotency_key,request_hash,max_attempts)
        VALUES ($1,$2,'queued',$3,$4,$5,$6,$7,$8) RETURNING *`, [uuidv7(), attemptId, ocrModelVersion, ocrParserVersion, inputHash, body.idempotencyKey, requestHash, Math.max(1, Math.min(10, config.OCR_JOB_MAX_ATTEMPTS || 3))])).rows[0];
      for (const attachment of attachments.rows) await client.query("INSERT INTO receipt_ocr_job_attachments (job_id,attachment_id,attempt_id,display_order,sha256_snapshot) VALUES ($1,$2,$3,$4,$5)", [job.id, attachment.id, attemptId, attachment.display_order, attachment.sha256]);
      // 幂等重放（created=false）已在上方提前返回，走到这里必然是新创建的任务。
      await writeAudit(client, session, "receipt_ocr_requested", "assignment", attempt.assignment_id, { attemptId, jobId: job.id, attachmentCount: attachments.rows.length });
      return { job: await readJob(client, job), created: true };
    });
    return reply.code(result.created ? 201 : 200).send(result.job);
  });

  app.get("/api/questionnaires/secret/drafts/:id/receipt-ocr-jobs/:jobId", async (request) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const jobId = SecureUuidSchema.parse(request.params.jobId);
    return readJob(pool, await ownedJob(pool, attemptId, jobId, session.user_id));
  });

  app.post("/api/questionnaires/secret/drafts/:id/receipt-ocr-jobs/:jobId/apply", async (request) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const jobId = SecureUuidSchema.parse(request.params.jobId);
    const body = ReceiptOcrApplyRequestSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const attempt = await lockedAttempt(client, attemptId, session.user_id); editable(attempt);
      const job = await ownedJob(client, attemptId, jobId, session.user_id, true);
      const requestHash = hash({ jobId, revision: body.revision });
      const replay = await client.query("SELECT * FROM receipt_ocr_applications WHERE attempt_id=$1 AND idempotency_key=$2 FOR UPDATE", [attemptId, SecureUuidSchema.parse(body.idempotencyKey)]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw app.jundeAuth.businessError("IDEMPOTENCY_CONFLICT", "本次应用请求与上次不一致", 409);
        const dishes = await client.query("SELECT * FROM dish_records WHERE attempt_id=$1 ORDER BY sort_order,id", [attemptId]);
        return { job: await readJob(client, job), dishes: dishes.rows.map(dishView), revision: Number(replay.rows[0].result_revision) };
      }
      if (!['succeeded','partial'].includes(job.status)) throw app.jundeAuth.businessError("OCR_JOB_NOT_READY", "识别尚未完成", 409);
      if (Number(attempt.revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      const candidates = await client.query("SELECT * FROM receipt_ocr_candidates WHERE job_id=$1 AND status='proposed' ORDER BY sort_order,id FOR UPDATE", [jobId]);
      const existing = await client.query("SELECT * FROM dish_records WHERE attempt_id=$1 ORDER BY sort_order,id FOR UPDATE", [attemptId]);
      const byPlannedName = new Map(existing.rows.filter((dish) => dish.requirement_id).map((dish) => [dish.planned_name.trim().toLocaleLowerCase('zh-CN'), dish]));
      let sortOrder = Math.max(0, ...existing.rows.map((dish) => Number(dish.sort_order))) + 1;
      for (const candidate of candidates.rows) {
        const required = byPlannedName.get(candidate.normalized_name.toLocaleLowerCase('zh-CN'));
        const review = [...new Set([...(candidate.quantity ? [] : ['quantity']), ...(candidate.unit_price_cents === null ? ['unitPriceCents'] : []), ...(candidate.line_total_cents === null ? ['lineTotalCents'] : [])])];
        if (required) await client.query(`UPDATE dish_records SET actual_name=$2,quantity=$3,unit_price_cents=$4,line_total_cents=$5,fulfillment_status='ordered',source='ocr',receipt_ocr_candidate_id=$6,manually_modified=false,price_derived=false,review_fields=$7,updated_at=now() WHERE id=$1`, [required.id, candidate.normalized_name, candidate.quantity || required.planned_quantity, candidate.unit_price_cents, candidate.line_total_cents, candidate.id, JSON.stringify(review)]);
        else await client.query(`INSERT INTO dish_records (id,attempt_id,assignment_id,sort_order,actual_name,quantity,unit_price_cents,line_total_cents,fulfillment_status,fully_satisfied,source,receipt_ocr_candidate_id,review_fields)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'extra',false,'ocr',$9,$10)`, [uuidv7(), attemptId, attempt.assignment_id, sortOrder++, candidate.normalized_name, candidate.quantity || 1, candidate.unit_price_cents, candidate.line_total_cents, candidate.id, JSON.stringify(review)]);
        await client.query("UPDATE receipt_ocr_candidates SET status='applied' WHERE id=$1", [candidate.id]);
      }
      const revision = Number((await client.query("UPDATE survey_attempts SET revision=revision+1,last_saved_at=now() WHERE id=$1 RETURNING revision", [attemptId])).rows[0].revision);
      await client.query("INSERT INTO receipt_ocr_applications (id,attempt_id,job_id,idempotency_key,request_hash,base_revision,result_revision,applied_at,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8)", [uuidv7(), attemptId, jobId, body.idempotencyKey, requestHash, body.revision, revision, session.user_id]);
      await writeAudit(client, session, "receipt_ocr_applied", "assignment", attempt.assignment_id, { attemptId, jobId });
      const dishes = await client.query("SELECT * FROM dish_records WHERE attempt_id=$1 ORDER BY sort_order,id", [attemptId]);
      return { job: await readJob(client, job), dishes: dishes.rows.map(dishView), revision };
    });
  });

  app.put("/api/questionnaires/secret/drafts/:id/dishes", async (request) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const body = DishSaveRequestSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const attempt = await lockedAttempt(client, attemptId, session.user_id); editable(attempt);
      if (Number(attempt.revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      const current = await client.query("SELECT * FROM dish_records WHERE attempt_id=$1 ORDER BY sort_order,id FOR UPDATE", [attemptId]);
      const existing = new Map(current.rows.map((row) => [row.id, row]));
      const inputIds = new Set(body.dishes.map((dish) => SecureUuidSchema.parse(dish.id)));
      const missingRequired = current.rows.filter((row) => row.requirement_id && !inputIds.has(row.id));
      if (missingRequired.length) throw app.jundeAuth.businessError("DISH_REQUIREMENT_MISSING", "必点菜品记录不能删除", 422);
      const errors = body.dishes.flatMap((dish, index) => {
        const existingDish = existing.get(dish.id);
        const serverDish = { ...dish, required: existingDish?.required_snapshot || false, allowSubstitution: existingDish?.allow_substitution_snapshot || false };
        return validateDishes([serverDish]).map((item) => ({ ...item, index }));
      });
      if (errors.length) throw app.jundeAuth.businessError("DISH_INVALID", errors[0].message, 422);
      for (const dish of body.dishes) {
        const row = existing.get(dish.id);
        if (row) {
          if (dish.requirementId !== row.requirement_id || dish.plannedName !== row.planned_name) throw app.jundeAuth.businessError("DISH_SNAPSHOT_CONFLICT", "菜品要求已更新，请刷新后重试", 409);
          await client.query(`UPDATE dish_records SET actual_name=$2,quantity=$3,unit_price_cents=$4,line_total_cents=$5,fulfillment_status=$6,substitution_reason=$7,unavailable_reason=$8,evaluation=$9,fully_satisfied=$10,source='manual',manually_modified=manually_modified OR $11,price_derived=$12,review_fields=$13,updated_at=now() WHERE id=$1`, [row.id, dish.actualName, dish.quantity, dish.unitPriceCents, dish.lineTotalCents, dish.fulfillmentStatus, dish.substitutionReason || null, dish.unavailableReason || null, dish.evaluation, dish.fullySatisfied, row.source === "ocr" || dish.manuallyModified, dish.priceDerived, JSON.stringify(dish.reviewFields)]);
        } else {
          if (dish.requirementId || dish.plannedName || dish.source !== "manual") throw app.jundeAuth.businessError("DISH_SNAPSHOT_CONFLICT", "新增菜品只能作为手工额外菜品", 422);
          await client.query(`INSERT INTO dish_records (id,attempt_id,assignment_id,sort_order,actual_name,quantity,unit_price_cents,line_total_cents,fulfillment_status,substitution_reason,unavailable_reason,evaluation,fully_satisfied,source,manually_modified,price_derived,review_fields)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'manual',true,$14,$15)`, [SecureUuidSchema.parse(dish.id), attemptId, attempt.assignment_id, body.dishes.indexOf(dish) + 1, dish.actualName, dish.quantity, dish.unitPriceCents, dish.lineTotalCents, dish.fulfillmentStatus, dish.substitutionReason || null, dish.unavailableReason || null, dish.evaluation, dish.fullySatisfied, dish.priceDerived, JSON.stringify(dish.reviewFields)]);
        }
      }
      await client.query("DELETE FROM dish_records WHERE attempt_id=$1 AND requirement_id IS NULL AND NOT (id = ANY($2::uuid[]))", [attemptId, [...inputIds]]);
      const revision = Number((await client.query("UPDATE survey_attempts SET revision=revision+1,last_saved_at=now() WHERE id=$1 RETURNING revision", [attemptId])).rows[0].revision);
      await writeAudit(client, session, "dishes_saved", "assignment", attempt.assignment_id, { attemptId, dishCount: body.dishes.length });
      const dishes = await client.query("SELECT * FROM dish_records WHERE attempt_id=$1 ORDER BY sort_order,id", [attemptId]);
      return { dishes: dishes.rows.map(dishView), revision };
    });
  });

  app.put("/api/questionnaires/secret/drafts/:id/other-records", async (request) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const body = OtherRecordSaveRequestSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const attempt = await lockedAttempt(client, attemptId, session.user_id); editable(attempt);
      if (Number(attempt.revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      await client.query(`INSERT INTO other_records (attempt_id,highlight,suggestion) VALUES ($1,$2,$3)
        ON CONFLICT (attempt_id) DO UPDATE SET highlight=EXCLUDED.highlight,suggestion=EXCLUDED.suggestion,revision=other_records.revision+1,updated_at=now()`, [attemptId, body.highlight, body.suggestion]);
      const revision = Number((await client.query("UPDATE survey_attempts SET revision=revision+1,last_saved_at=now() WHERE id=$1 RETURNING revision", [attemptId])).rows[0].revision);
      await writeAudit(client, session, "other_records_saved", "assignment", attempt.assignment_id, { attemptId });
      return { revision };
    });
  });
}
