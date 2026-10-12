import { createHash } from "node:crypto";
import { AnswerSaveSchema, EditSessionConfirmSchema, EditSessionCreateSchema, EditSessionPatchSchema, EvidenceUploadCompleteSchema, EvidenceUploadInitSchema, QuestionnaireSubmitRequestSchema, SecureUuidSchema } from "../../../../packages/contracts/index.js";
import { applyScoreWipe, validateDishes } from "../../../../packages/domain/index.js";
import { uuidv7 } from "../ids.js";
import { advanceCampaignOverdue } from "../campaign-state.js";
import { writeAudit } from "../audit.js";

const attemptRow = (attempt) => ({ id: attempt.id, status: attempt.status, revision: Number(attempt.revision) });
const versionRow = (version) => ({ id: version.id, name: version.template_name, versionLabel: `V${version.version_number}` });
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function registerBatch3Routes(app, { pool, cos }) {
  const requireInspector = async (request) => {
    if (!app.jundeAuth.configured) throw app.jundeAuth.businessError("AUTH_NOT_CONFIGURED", "认证服务暂未配置", 503, { retryable: true });
    const session = await app.jundeAuth.sessionFor(request, false);
    if (session.kind !== "inspector" || session.user_status !== "approved_active") throw app.jundeAuth.businessError("FORBIDDEN", "你没有权限进行此操作", 403);
    return session;
  };
  const assignmentReference = async (assignmentId, userId) => {
    const result = await pool.query("SELECT id,campaign_id FROM audit_assignments WHERE id=$1 AND inspector_id=$2", [assignmentId, userId]);
    if (!result.rows[0]) throw app.jundeAuth.businessError("ASSIGNMENT_NOT_FOUND", "任务不存在", 404);
    return result.rows[0];
  };
  const versionForAssignment = async (client, assignment) => {
    const result = await client.query(`SELECT v.id,v.version_number,t.name template_name FROM questionnaire_versions v
      JOIN questionnaire_templates t ON t.id=v.template_id WHERE v.id=$1`, [assignment.questionnaire_version_id]);
    if (!result.rows[0]) throw app.jundeAuth.businessError("QUESTIONNAIRE_VERSION_NOT_FOUND", "问卷版本不存在", 409);
    return result.rows[0];
  };
  const attemptForOwner = async (client, attemptId, userId, lock = false) => {
    const result = await client.query(`SELECT sa.*,a.campaign_id,a.inspector_id,a.status assignment_status,a.questionnaire_version_id assignment_version_id,a.task_type,
      v.version_number,t.name template_name FROM survey_attempts sa JOIN audit_assignments a ON a.id=sa.assignment_id
      JOIN questionnaire_versions v ON v.id=sa.questionnaire_version_id JOIN questionnaire_templates t ON t.id=v.template_id
      WHERE sa.id=$1 AND a.inspector_id=$2${lock ? " FOR UPDATE OF sa" : ""}`, [attemptId, userId]);
    if (!result.rows[0]) throw app.jundeAuth.businessError("QUESTIONNAIRE_NOT_FOUND", "问卷不存在", 404);
    return result.rows[0];
  };
  const questionnaire = async (client, attempt) => {
    const questions = await client.query(`SELECT q.id,q.question_number,q.category,q.text,q.max_score,q.is_score_wipe,COALESCE(e.image_required,false) image_required,COALESCE(e.audio_required,false) audio_required,
      COALESCE(e.image_max_count,3) image_max_count,COALESCE(e.audio_max_duration_seconds,10) audio_max_duration_seconds
      FROM questions q LEFT JOIN question_evidence_requirements e ON e.question_id=q.id WHERE q.version_id=$1 AND q.enabled ORDER BY q.question_number`, [attempt.questionnaire_version_id]);
    const answers = await client.query("SELECT * FROM question_answers WHERE attempt_id=$1", [attempt.id]);
    const attachments = await client.query("SELECT question_id,id,type,mime_type,size_bytes,duration_seconds,storage_key FROM question_evidence_attachments WHERE attempt_id=$1 AND status='active' ORDER BY created_at", [attempt.id]);
    const attachmentsByQuestion = new Map();
    for (const item of attachments.rows) {
      const list = attachmentsByQuestion.get(item.question_id) || [];
      list.push(item);
      attachmentsByQuestion.set(item.question_id, list);
    }
    const previewsByQuestion = new Map();
    for (const [questionId, items] of attachmentsByQuestion) {
      previewsByQuestion.set(questionId, await Promise.all(items.map(async (item) => {
        const preview = await cos.createPreviewUrl(item.storage_key);
        return { id: item.id, type: item.type, mimeType: item.mime_type, sizeBytes: Number(item.size_bytes), durationSeconds: item.duration_seconds, status: "active", previewUrl: preview.url, previewExpiresAt: preview.expiresAt };
      })));
    }
    const dishes = await client.query(`SELECT id,requirement_id,planned_name,actual_name,quantity,planned_quantity,unit_price_cents,line_total_cents,fulfillment_status,substitution_reason,unavailable_reason,evaluation,fully_satisfied,source,manually_modified,price_derived,review_fields,required_snapshot,allow_substitution_snapshot
      FROM dish_records WHERE attempt_id=$1 ORDER BY sort_order,id`, [attempt.id]);
    const other = await client.query("SELECT highlight,suggestion FROM other_records WHERE attempt_id=$1", [attempt.id]);
    // 分类标签页 = 本问卷版本中存在启用题目的分类聚合：分类行即使 active=false 也纳入（名称仍可查，FK 保证 code 不删），
    // 避免发布后管理员停用分类导致题目不可达而提交仍要求作答的死锁；无启用题目的分类不出现，按 sort_order 稳定排序
    const categories = await client.query(`SELECT qc.code, qc.name FROM question_categories qc
      WHERE qc.code IN (SELECT DISTINCT category FROM questions WHERE version_id=$1 AND enabled)
      ORDER BY qc.sort_order, qc.created_at`, [attempt.questionnaire_version_id]);
    return {
      attempt: attemptRow(attempt), questionnaireVersion: versionRow({ id: attempt.questionnaire_version_id, template_name: attempt.template_name, version_number: attempt.version_number }),
      categories: categories.rows.map((item) => ({ id: item.code, label: item.name })),
      questions: questions.rows.map((item) => ({ id: item.id, number: item.question_number, category: item.category, text: item.text, score: item.max_score, isScoreWipe: Boolean(item.is_score_wipe), evidence: { imageRequired: item.image_required, audioRequired: item.audio_required, imageMaxCount: Number(item.image_max_count), audioMaxDurationSeconds: Number(item.audio_max_duration_seconds) } })),
      answers: Object.fromEntries(answers.rows.map((item) => [item.question_id, { answer: item.answer, awardedScore: item.awarded_score, remark: item.issue_remark, attachments: previewsByQuestion.get(item.question_id) || [], revision: Number(item.revision) }])),
      dishes: dishes.rows.map((item) => ({ id: item.id, requirementId: item.requirement_id, plannedName: item.planned_name, actualName: item.actual_name, quantity: Number(item.quantity || item.planned_quantity || 1), unitPriceCents: item.unit_price_cents, lineTotalCents: item.line_total_cents, fulfillmentStatus: item.fulfillment_status, substitutionReason: item.substitution_reason, unavailableReason: item.unavailable_reason, evaluation: item.evaluation, fullySatisfied: item.fully_satisfied, source: item.source, manuallyModified: item.manually_modified, priceDerived: item.price_derived, reviewFields: item.review_fields || [], required: item.required_snapshot, allowSubstitution: item.allow_substitution_snapshot })),
      otherRecords: other.rows[0] ? { highlight: other.rows[0].highlight, suggestion: other.rows[0].suggestion } : { highlight: "", suggestion: "" },
    };
  };

  app.post("/api/assignments/:id/start", async (request) => {
    const session = await requireInspector(request);
    const assignmentId = SecureUuidSchema.parse(request.params.id);
    const reference = await assignmentReference(assignmentId, session.user_id);
    return app.jundeAuth.transaction(async (client) => {
      const state = await advanceCampaignOverdue(client, reference.campaign_id);
      const assignment = state.assignments.find((item) => item.id === assignmentId && item.inspector_id === session.user_id);
      if (!assignment) throw app.jundeAuth.businessError("ASSIGNMENT_NOT_FOUND", "任务不存在", 404);
      const existing = await client.query("SELECT * FROM survey_attempts WHERE assignment_id=$1 FOR UPDATE", [assignmentId]);
      if (existing.rows[0]) return { attempt: attemptRow(existing.rows[0]), questionnaireVersion: versionRow(await versionForAssignment(client, assignment)) };
      if (assignment.status === "overdue") throw app.jundeAuth.businessError("TASK_OVERDUE", "任务已逾期，请等待管理员延期后刷新任务", 409, { requiresNewToken: true });
      if (assignment.status !== "assigned") throw app.jundeAuth.businessError("ASSIGNMENT_NOT_AVAILABLE", "任务已开始或状态已变化，请刷新后重试", 409);
      if (new Date(assignment.starts_at) > new Date()) throw app.jundeAuth.businessError("ASSIGNMENT_NOT_STARTED", "还没到探店开始时间，请稍后再试", 409);
      const checkin = await client.query("SELECT id FROM audit_checkins WHERE assignment_id=$1 AND result='accepted' AND consumed_at IS NULL AND valid_until>now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [assignmentId]);
      const exemption = checkin.rows[0] ? null : await client.query("SELECT id FROM checkin_exemptions WHERE assignment_id=$1 AND status='active' AND valid_until>now() FOR UPDATE", [assignmentId]);
      if (!checkin.rows[0] && !exemption.rows[0]) throw app.jundeAuth.businessError("CHECKIN_REQUIRED", "请先完成现场打卡后再开始", 409);
      const id = uuidv7();
      const created = await client.query("INSERT INTO survey_attempts (id,assignment_id,questionnaire_version_id,mode,status) VALUES ($1,$2,$3,$4,'draft') RETURNING *", [id, assignmentId, assignment.questionnaire_version_id, assignment.task_type]);
      // 审计：探员开始填写问卷
      await client.query("INSERT INTO audit_logs (id,actor_id,actor_name,actor_username,action,subject_type,subject_id,data_json) VALUES ($1,$2,$3,$4,'attempt_started','assignment',$5,'{}'::jsonb)", [uuidv7(), session.user_id, session.display_name, session.username_display, assignmentId]);
      await client.query(`INSERT INTO dish_records (id,attempt_id,assignment_id,requirement_id,sort_order,planned_name,planned_quantity,quantity,required_snapshot,allow_substitution_snapshot,max_unit_price_cents_snapshot,instruction_snapshot,fulfillment_status,fully_satisfied,source)
        SELECT gen_random_uuid(),$1,assignment_id,id,sort_order,planned_name,quantity,quantity,required,allow_substitution,max_unit_price_cents,instruction,'unavailable',false,'manual'
        FROM assignment_dish_requirements WHERE assignment_id=$2 ORDER BY sort_order`, [id, assignmentId]);
      if (checkin.rows[0]) await client.query("UPDATE audit_checkins SET consumed_at=now() WHERE id=$1", [checkin.rows[0].id]);
      else await client.query("UPDATE checkin_exemptions SET status='used',used_at=now(),used_by_attempt_id=$2,revision=revision+1 WHERE id=$1", [exemption.rows[0].id, id]);
      await client.query("UPDATE audit_assignments SET status='in_progress',started_at=now(),checked_in_at=now(),checkin_id=$2,revision=revision+1,updated_at=now() WHERE id=$1", [assignmentId, checkin.rows[0]?.id || null]);
      await client.query("UPDATE audit_campaigns SET status='in_progress',revision=revision+1,updated_at=now() WHERE id=$1", [reference.campaign_id]);
      return { attempt: attemptRow(created.rows[0]), questionnaireVersion: versionRow(await versionForAssignment(client, assignment)) };
    });
  });

  app.get("/api/assignments/:id/questionnaire", async (request) => {
    const session = await requireInspector(request);
    const assignmentId = SecureUuidSchema.parse(request.params.id);
    await assignmentReference(assignmentId, session.user_id);
    const attempt = await pool.query("SELECT id FROM survey_attempts WHERE assignment_id=$1", [assignmentId]);
    if (!attempt.rows[0]) throw app.jundeAuth.businessError("QUESTIONNAIRE_NOT_STARTED", "请先开始任务", 409);
    const found = await attemptForOwner(pool, attempt.rows[0].id, session.user_id);
    if (found.status === "submitted") throw app.jundeAuth.businessError("QUESTIONNAIRE_SUBMITTED", "该任务已提交，不能回看问卷内容", 409);
    return questionnaire(pool, found);
  });

  app.get("/api/questionnaires/secret/drafts/:id", async (request) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    // failed 不是终局：worker 租约过期会把 submitting 置为 failed，而提交接口只认 draft；
    // 探员打开草稿时在同一事务内把 failed 重置回 draft（清空提交租约、revision+1、写审计），否则任务会永久卡死。
    const attempt = await app.jundeAuth.transaction(async (client) => {
      const found = await attemptForOwner(client, attemptId, session.user_id, true);
      if (found.status === "submitted") throw app.jundeAuth.businessError("QUESTIONNAIRE_SUBMITTED", "该任务已提交，不能回看问卷内容", 409);
      if (found.status !== "failed") return found;
      const recovered = await client.query("UPDATE survey_attempts SET status='draft',submit_token=NULL,submitting_since=NULL,revision=revision+1 WHERE id=$1 AND status='failed' RETURNING revision", [attemptId]);
      await writeAudit(client, session, "attempt_recovered", "assignment", found.assignment_id, { attemptId });
      return { ...found, status: "draft", revision: recovered.rows[0]?.revision ?? Number(found.revision) + 1 };
    });
    return questionnaire(pool, attempt);
  });

  app.post("/api/questionnaires/secret/:id/submit", async (request) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const body = QuestionnaireSubmitRequestSchema.parse(request.body);
    const requestHash = hash({ actorId: session.user_id, attemptId, assignmentRevision: body.assignmentRevision, confirmation: body.confirmation, contractVersion: 1 });
    const reference = await assignmentReference((await pool.query("SELECT assignment_id FROM survey_attempts WHERE id=$1", [attemptId])).rows[0]?.assignment_id, session.user_id);
    let lease = null;
    try {
      const acquired = await app.jundeAuth.transaction(async (client) => {
        const existing = await client.query("SELECT * FROM idempotency_keys WHERE actor_id=$1 AND scope='questionnaire_submit' AND idempotency_key=$2 FOR UPDATE", [session.user_id, body.submitToken]);
        const record = existing.rows[0];
        if (record) {
          if (record.request_hash !== requestHash) throw app.jundeAuth.businessError("IDEMPOTENCY_CONFLICT", "本次提交与之前的确认内容不一致", 409);
          if (record.status === "succeeded") return { response: record.response_body_json };
          if (record.status === "terminal_failed") throw app.jundeAuth.businessError(record.failure_code || "SUBMIT_REJECTED", "当前内容尚不能提交", 409);
          if (record.status === "processing" && new Date(record.lease_expires_at) > new Date()) throw app.jundeAuth.businessError("SUBMIT_PROCESSING", "提交正在处理中，请稍后重试", 409, { retryable: true });
          const lockedBy = uuidv7();
          await client.query("UPDATE idempotency_keys SET status='processing',locked_by=$2,locked_at=now(),lease_expires_at=now()+INTERVAL '30 seconds',attempt_count=attempt_count+1,failure_code=NULL,updated_at=now() WHERE id=$1", [record.id, lockedBy]);
          return { keyId: record.id, lockedBy };
        }
        const keyId = uuidv7(); const lockedBy = uuidv7();
        try {
          await client.query(`INSERT INTO idempotency_keys (id,actor_id,scope,idempotency_key,request_hash,attempt_id,status,locked_by,locked_at,lease_expires_at,attempt_count)
            VALUES ($1,$2,'questionnaire_submit',$3,$4,$5,'processing',$6,now(),now()+INTERVAL '30 seconds',1)`, [keyId, session.user_id, body.submitToken, requestHash, attemptId, lockedBy]);
        } catch (error) {
          if (error?.code === "23505") throw app.jundeAuth.businessError("SUBMIT_PROCESSING", "提交正在处理中，请稍后重试", 409, { retryable: true });
          throw error;
        }
        return { keyId, lockedBy };
      });
      if (acquired.response) return acquired.response;
      lease = acquired;
      const occupied = await app.jundeAuth.transaction(async (client) => {
        const campaign = await client.query("SELECT id FROM audit_campaigns WHERE id=$1 FOR UPDATE", [reference.campaign_id]);
        if (!campaign.rows[0]) throw app.jundeAuth.businessError("QUESTIONNAIRE_NOT_FOUND", "问卷不存在", 404);
        const assignment = await client.query("SELECT * FROM audit_assignments WHERE id=$1 AND campaign_id=$2 AND inspector_id=$3 FOR UPDATE", [reference.id, reference.campaign_id, session.user_id]);
        const attempt = await client.query("SELECT * FROM survey_attempts WHERE id=$1 AND assignment_id=$2 FOR UPDATE", [attemptId, reference.id]);
        const assignmentRow = assignment.rows[0]; const attemptRow = attempt.rows[0];
        if (!assignmentRow || !attemptRow) throw app.jundeAuth.businessError("QUESTIONNAIRE_NOT_FOUND", "问卷不存在", 404);
        if (attemptRow.status === "submitted") {
          const submission = await client.query("SELECT submitted_at FROM submission_versions WHERE attempt_id=$1", [attemptId]);
          if (attemptRow.submit_token === body.submitToken && submission.rows[0]) return { response: { status: "submitted", submittedAt: submission.rows[0].submitted_at.toISOString() } };
          throw app.jundeAuth.businessError("QUESTIONNAIRE_SUBMITTED", "该任务已经提交", 409);
        }
        // failed（提交恢复后的残留态）视同 draft：允许重新发起提交（与草稿打开时的重置互为双保险）。
        if (!["draft", "failed"].includes(attemptRow.status) || assignmentRow.status !== "in_progress" || Number(assignmentRow.revision) !== body.assignmentRevision) throw app.jundeAuth.businessError("SUBMIT_STATE_INVALID", "任务状态已更新，请刷新后重试", 409);
        const submitDeadline = assignmentRow.questionnaire_deadline_at || assignmentRow.due_at;
        if (new Date(submitDeadline) <= new Date()) throw app.jundeAuth.businessError("TASK_OVERDUE", "问卷已过最终截止时间，请等待管理员延期后刷新任务", 409, { requiresNewToken: true });
        const questions = await client.query(`SELECT q.id,q.question_key,q.question_number,q.category,q.text,q.max_score,q.is_score_wipe,COALESCE(r.image_required,false) image_required,COALESCE(r.audio_required,false) audio_required,
          COALESCE(r.image_max_count,3) image_max_count,COALESCE(r.audio_max_duration_seconds,10) audio_max_duration_seconds
          FROM questions q LEFT JOIN question_evidence_requirements r ON r.question_id=q.id WHERE q.version_id=$1 AND q.enabled ORDER BY q.question_number FOR UPDATE OF q`, [attemptRow.questionnaire_version_id]);
        const answers = await client.query("SELECT * FROM question_answers WHERE attempt_id=$1 ORDER BY question_id FOR UPDATE", [attemptId]);
        // 启用题必须每题都有作答；答题期间被管理员停用的题留下的多余答案不阻断提交。
        const enabledQuestionIds = new Set(questions.rows.map((question) => question.id));
        const answeredEnabledCount = answers.rows.filter((answer) => enabledQuestionIds.has(answer.question_id)).length;
        if (questions.rows.length < 1 || answeredEnabledCount !== questions.rows.length) throw app.jundeAuth.businessError("SUBMIT_INCOMPLETE", "请完成全部问卷题目后再提交", 422);
        const answerByQuestion = new Map(answers.rows.map((item) => [item.question_id, item]));
        for (const question of questions.rows) {
          const answer = answerByQuestion.get(question.id);
          if (!answer) throw app.jundeAuth.businessError("SUBMIT_INCOMPLETE", "请完成全部问卷题目后再提交", 422);
          if (answer.answer === "unscored") {
            if (!String(answer.issue_remark ?? "").trim()) throw app.jundeAuth.businessError("ISSUE_REMARK_REQUIRED", "不得分说明不能为空", 422);
            const evidenceForQuestion = await client.query("SELECT type,duration_seconds FROM question_evidence_attachments WHERE attempt_id=$1 AND question_id=$2 AND status='active'", [attemptId, question.id]);
            const imageCount = evidenceForQuestion.rows.filter((item) => item.type === "image").length;
            const audioRows = evidenceForQuestion.rows.filter((item) => item.type === "audio");
            if ((question.image_required && imageCount < 1) || (question.audio_required && audioRows.length < 1)) throw app.jundeAuth.businessError("EVIDENCE_REQUIRED", "不得分题目缺少必要证据", 422);
            if (imageCount > Number(question.image_max_count)) throw app.jundeAuth.businessError("EVIDENCE_LIMIT_EXCEEDED", "不得分题目的照片数量超出上限", 422);
            if (audioRows.some((item) => Number(item.duration_seconds) > Number(question.audio_max_duration_seconds))) throw app.jundeAuth.businessError("EVIDENCE_LIMIT_EXCEEDED", "不得分题目的录音时长超出上限", 422);
          }
        }
        const dishes = await client.query("SELECT * FROM dish_records WHERE attempt_id=$1 ORDER BY sort_order,id FOR UPDATE", [attemptId]);
        const dishErrors = validateDishes(dishes.rows.map((dish) => ({ ...dish, requirementId: dish.requirement_id, fulfillmentStatus: dish.fulfillment_status, actualName: dish.actual_name, substitutionReason: dish.substitution_reason, unavailableReason: dish.unavailable_reason, fullySatisfied: dish.fully_satisfied, evaluation: dish.evaluation, required: dish.required_snapshot, allowSubstitution: dish.allow_substitution_snapshot })));
        if (dishErrors.length) throw app.jundeAuth.businessError("DISH_INVALID", dishErrors[0].message, 422);
        const other = await client.query("SELECT * FROM other_records WHERE attempt_id=$1 FOR UPDATE", [attemptId]);
        if (!other.rows[0]?.highlight?.trim()) throw app.jundeAuth.businessError("OTHER_RECORD_REQUIRED", "请填写本次探店亮点", 422);
        const receipts = await client.query("SELECT * FROM receipt_attachments WHERE attempt_id=$1 AND status='ready' ORDER BY display_order FOR UPDATE", [attemptId]);
        if (assignmentRow.receipt_required && !receipts.rows.length) throw app.jundeAuth.businessError("RECEIPT_REQUIRED", "请至少上传一张已完成校验的消费小票", 422);
        const evidence = await client.query("SELECT * FROM question_evidence_attachments WHERE attempt_id=$1 AND status='active' ORDER BY question_id,id", [attemptId]);
        const ocr = await client.query("SELECT candidate.* FROM receipt_ocr_candidates candidate JOIN receipt_ocr_jobs job ON job.id=candidate.job_id WHERE job.attempt_id=$1 ORDER BY candidate.sort_order,candidate.id", [attemptId]);
        await client.query("UPDATE survey_attempts SET status='submitting',submit_token=$2,submitting_since=now() WHERE id=$1", [attemptId, body.submitToken]);
        return { assignment: assignmentRow, attempt: attemptRow, questions: questions.rows, answers: answers.rows, dishes: dishes.rows, other: other.rows[0], evidence: evidence.rows, receipts: receipts.rows, ocr: ocr.rows };
      });
      if (occupied.response) {
        await app.jundeAuth.transaction(async (client) => {
          await client.query("UPDATE idempotency_keys SET status='succeeded',response_status=200,response_body_json=$2,locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND locked_by=$3", [lease.keyId, JSON.stringify(occupied.response), lease.lockedBy]);
        });
        return occupied.response;
      }
      const result = await app.jundeAuth.transaction(async (client) => {
        const campaign = await client.query("SELECT id FROM audit_campaigns WHERE id=$1 FOR UPDATE", [occupied.assignment.campaign_id]);
        const assignment = await client.query("SELECT * FROM audit_assignments WHERE id=$1 AND campaign_id=$2 FOR UPDATE", [occupied.assignment.id, campaign.rows[0]?.id]);
        const attempt = await client.query("SELECT * FROM survey_attempts WHERE id=$1 AND assignment_id=$2 FOR UPDATE", [attemptId, occupied.assignment.id]);
        const key = await client.query("SELECT * FROM idempotency_keys WHERE id=$1 FOR UPDATE", [lease.keyId]);
        if (!campaign.rows[0] || !assignment.rows[0] || !attempt.rows[0] || key.rows[0]?.locked_by !== lease.lockedBy || attempt.rows[0].status !== "submitting" || attempt.rows[0].submit_token !== body.submitToken) throw app.jundeAuth.businessError("SUBMIT_RECOVERY_REQUIRED", "提交状态已变化，请刷新后重试", 409, { retryable: true });
        // 最终写入前复核：重锁 assignment 后状态可能已被管理员取消改变；取消竞态以取消方胜出，提交整体回滚。
        if (assignment.rows[0].status !== "in_progress") throw app.jundeAuth.businessError("ASSIGNMENT_CANCELLED", "任务已被管理员取消，本次提交未生效", 409);
        const snapshot = { answers: occupied.answers, dishes: occupied.dishes, other: occupied.other, evidence: occupied.evidence, receipts: occupied.receipts, ocr: occupied.ocr };
        // 分数清零计分：分类内清零题作答 unscored 时该分类启用题全部计 0，停用题残留作答照常计入（口径同 domain.applyScoreWipe）。
        const wipe = applyScoreWipe(occupied.questions.map((question) => ({ id: question.id, category: question.category, maxScore: Number(question.max_score), scoreWipe: Boolean(question.is_score_wipe) })), occupied.answers.map((answer) => ({ questionId: answer.question_id, answer: answer.answer, awardedScore: Number(answer.awarded_score) })));
        const totalScore = wipe.totalScore;
        const maxScore = occupied.questions.reduce((sum, question) => sum + Number(question.max_score), 0);
        const submissionId = uuidv7();
        const inserted = await client.query(`INSERT INTO submission_versions (id,attempt_id,assignment_id,campaign_id,questionnaire_version_id,submitted_by,submitted_at,total_score,max_score,issue_count,answer_snapshot_json,dish_snapshot_json,other_snapshot_json,evidence_snapshot_json,receipt_snapshot_json,ocr_snapshot_json,integrity_hash)
          VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING submitted_at`, [submissionId, attemptId, occupied.assignment.id, occupied.assignment.campaign_id, occupied.attempt.questionnaire_version_id, session.user_id, totalScore, maxScore, occupied.answers.filter((item) => item.answer === "unscored").length, JSON.stringify(occupied.answers), JSON.stringify(occupied.dishes), JSON.stringify(occupied.other), JSON.stringify(occupied.evidence), JSON.stringify(occupied.receipts), JSON.stringify(occupied.ocr), hash(snapshot)]);
        // 数据看板逐题得分明细：与 maxScore 同口径（仅启用题），供月度/门店/分类/考核点聚合。
        const answerByQuestionId = new Map(occupied.answers.map((answer) => [answer.question_id, answer]));
        for (const question of occupied.questions) {
          const answer = answerByQuestionId.get(question.id);
          if (!answer) continue;
          await client.query(`INSERT INTO submission_question_scores (id,submission_id,question_id,question_key,question_number,question_text,category,answer,awarded_score,max_score)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (submission_id,question_id) DO NOTHING`,
            [uuidv7(), submissionId, question.id, question.question_key, question.question_number, question.text, question.category, answer.answer, wipe.awardedFor(question), Number(question.max_score)]);
        }
        const response = { status: "submitted", submittedAt: inserted.rows[0].submitted_at.toISOString() };
        await client.query("UPDATE receipt_ocr_jobs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,cancellation_requested_at=CASE WHEN status='processing' THEN now() ELSE cancellation_requested_at END WHERE attempt_id=$1 AND status IN ('queued','processing')", [attemptId]);
        await client.query("UPDATE survey_attempts SET status='submitted',submitting_since=NULL,submitted_at=now(),revision=revision+1 WHERE id=$1", [attemptId]);
        await client.query("UPDATE audit_assignments SET status='submitted',submitted_at=now(),revision=revision+1,updated_at=now() WHERE id=$1", [occupied.assignment.id]);
        await client.query("UPDATE audit_campaigns SET status=CASE WHEN NOT EXISTS (SELECT 1 FROM audit_assignments WHERE campaign_id=$1 AND status NOT IN ('submitted','cancelled')) THEN 'completed' ELSE 'in_progress' END,revision=revision+1,updated_at=now() WHERE id=$1", [occupied.assignment.campaign_id]);
        await client.query("INSERT INTO audit_logs (id,actor_id,actor_name,actor_username,action,subject_type,subject_id,data_json) VALUES ($1,$2,$3,$4,'questionnaire_submitted','submission',$5,$6)", [uuidv7(), session.user_id, session.display_name, session.username_display, submissionId, JSON.stringify({ totalScore, maxScore })]);
        await client.query("UPDATE idempotency_keys SET status='succeeded',response_status=200,response_body_json=$2,locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1", [lease.keyId, JSON.stringify(response)]);
        return response;
      });
      return result;
    } catch (error) {
      if (lease) await app.jundeAuth.transaction(async (client) => {
        const terminal = error?.code === "TASK_OVERDUE";
        const assignment = await client.query("SELECT id,campaign_id FROM audit_assignments WHERE id=$1", [reference.id]);
        if (assignment.rows[0]) {
          await client.query("SELECT id FROM audit_campaigns WHERE id=$1 FOR UPDATE", [assignment.rows[0].campaign_id]);
          await client.query("SELECT id FROM audit_assignments WHERE id=$1 FOR UPDATE", [assignment.rows[0].id]);
          if (terminal) await client.query("UPDATE audit_assignments SET status='overdue',revision=revision+1,updated_at=now() WHERE id=$1 AND status IN ('assigned','in_progress')", [assignment.rows[0].id]);
        }
        if (!terminal) await client.query("UPDATE survey_attempts SET status='draft',submit_token=NULL,submitting_since=NULL WHERE id=$1 AND status='submitting' AND submit_token=$2", [attemptId, body.submitToken]);
        await client.query("UPDATE idempotency_keys SET status=$2,failure_code=$3,locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND locked_by=$4", [lease.keyId, terminal ? "terminal_failed" : "retryable_failed", terminal ? "TASK_OVERDUE" : (error?.code || "SUBMIT_RETRY_REQUIRED"), lease.lockedBy]);
      });
      throw error;
    }
  });

  app.put("/api/questionnaires/secret/drafts/:id/answers/:questionId", async (request) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const questionId = SecureUuidSchema.parse(request.params.questionId);
    const body = AnswerSaveSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const attempt = await attemptForOwner(client, attemptId, session.user_id, true);
      if (attempt.status !== "draft" || attempt.assignment_status !== "in_progress") throw app.jundeAuth.businessError("QUESTIONNAIRE_LOCKED", "当前问卷不能修改", 409);
      if (Number(attempt.revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      const question = await client.query("SELECT max_score FROM questions WHERE id=$1 AND version_id=$2", [questionId, attempt.questionnaire_version_id]);
      if (!question.rows[0]) throw app.jundeAuth.businessError("QUESTION_NOT_FOUND", "题目不存在", 404);
      await client.query(`INSERT INTO question_answers (attempt_id,question_id,answer,awarded_score,issue_remark) VALUES ($1,$2,'scored',$3,'')
        ON CONFLICT (attempt_id,question_id) DO UPDATE SET answer='scored',awarded_score=EXCLUDED.awarded_score,issue_remark='',revision=question_answers.revision+1,updated_at=now()`, [attemptId, questionId, question.rows[0].max_score]);
      const updated = await client.query("UPDATE survey_attempts SET revision=revision+1,last_saved_at=now() WHERE id=$1 RETURNING revision", [attemptId]);
      await writeAudit(client, session, "attempt_draft_saved", "assignment", attempt.assignment_id, { attemptId, questionId });
      return { revision: Number(updated.rows[0].revision) };
    });
  });

  const lockedQuestion = async (client, attempt, questionId) => {
    const question = await client.query(`SELECT q.*,COALESCE(e.evidence_required,false) evidence_required,
      COALESCE(e.image_required,false) image_required,COALESCE(e.audio_required,false) audio_required,
      COALESCE(e.image_min_count,0) image_min_count,COALESCE(e.audio_min_count,0) audio_min_count,
      COALESCE(e.image_max_count,3) image_max_count,COALESCE(e.audio_max_duration_seconds,10) audio_max_duration_seconds FROM questions q
      LEFT JOIN question_evidence_requirements e ON e.question_id=q.id WHERE q.id=$1 AND q.version_id=$2`, [questionId, attempt.questionnaire_version_id]);
    if (!question.rows[0]) throw app.jundeAuth.businessError("QUESTION_NOT_FOUND", "题目不存在", 404);
    return question.rows[0];
  };
  const lockedSession = async (client, attemptId, questionId, sessionId) => {
    const result = await client.query("SELECT * FROM question_answer_edit_sessions WHERE id=$1 AND attempt_id=$2 AND question_id=$3 FOR UPDATE", [sessionId, attemptId, questionId]);
    if (!result.rows[0]) throw app.jundeAuth.businessError("EDIT_SESSION_NOT_FOUND", "编辑会话不存在", 404);
    return result.rows[0];
  };
  const enqueueCleanup = async (client, attachments) => {
    for (const attachment of attachments) await client.query(`INSERT INTO object_cleanup_jobs (id,attachment_id,storage_key,status)
      VALUES ($1,$2,$3,'queued') ON CONFLICT (attachment_id) DO NOTHING`, [uuidv7(), attachment.id, attachment.storage_key]);
  };
  const discardStagedEvidence = async (client, editSessionId) => {
    const discarded = await client.query(`UPDATE question_evidence_attachments
      SET status='deleted',cleanup_after=now()+INTERVAL '24 hours',verification_locked_by=NULL,verification_lease_expires_at=NULL,updated_at=now()
      WHERE edit_session_id=$1 AND status IN ('staged_uploading','staged_ready','failed') RETURNING id,storage_key`, [editSessionId]);
    await enqueueCleanup(client, discarded.rows);
    return discarded.rows;
  };

  app.post("/api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions", async (request) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const questionId = SecureUuidSchema.parse(request.params.questionId);
    const body = EditSessionCreateSchema.parse(request.body);
    const createOnce = () => app.jundeAuth.transaction(async (client) => {
      const attempt = await attemptForOwner(client, attemptId, session.user_id, true);
      if (attempt.status !== "draft" || attempt.assignment_status !== "in_progress") throw app.jundeAuth.businessError("QUESTIONNAIRE_LOCKED", "当前问卷不能修改", 409);
      await lockedQuestion(client, attempt, questionId);
      const expired = await client.query("UPDATE question_answer_edit_sessions SET status='expired' WHERE attempt_id=$1 AND question_id=$2 AND status='open' AND expires_at<=now() RETURNING id", [attemptId, questionId]);
      for (const item of expired.rows) await discardStagedEvidence(client, item.id);
      const answer = await client.query("SELECT revision,issue_remark FROM question_answers WHERE attempt_id=$1 AND question_id=$2 FOR UPDATE", [attemptId, questionId]);
      const actualRevision = Number(answer.rows[0]?.revision || 0);
      if (actualRevision !== body.baseAnswerRevision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      try {
        const created = await client.query("INSERT INTO question_answer_edit_sessions (id,attempt_id,question_id,base_answer_revision,status,draft_issue_remark,expires_at) VALUES ($1,$2,$3,$4,'open',$5,now()+INTERVAL '30 minutes') RETURNING *", [uuidv7(), attemptId, questionId, body.baseAnswerRevision, answer.rows[0]?.issue_remark || ""]);
        const activeAttachments = await client.query("SELECT id,type,mime_type,size_bytes,duration_seconds,sha256,storage_key FROM question_evidence_attachments WHERE attempt_id=$1 AND question_id=$2 AND status='active' ORDER BY created_at", [attemptId, questionId]);
        const attachments = await Promise.all(activeAttachments.rows.map(async (item) => {
          const preview = await cos.createPreviewUrl(item.storage_key);
          return { id: item.id, type: item.type, mimeType: item.mime_type, sizeBytes: Number(item.size_bytes), durationSeconds: item.duration_seconds, status: "active", previewUrl: preview.url, previewExpiresAt: preview.expiresAt };
        }));
        return { id: created.rows[0].id, status: created.rows[0].status, draftIssueRemark: created.rows[0].draft_issue_remark, activeAttachments: attachments };
      } catch (error) {
        if (error.code === "23505") throw app.jundeAuth.businessError("EDIT_SESSION_EXISTS", "该题正在编辑中，请先完成或取消当前编辑", 409);
        throw error;
      }
    });
    try {
      return await createOnce();
    } catch (error) {
      if (error?.code !== "EDIT_SESSION_EXISTS") throw error;
      // 恢复语义：撞 (attempt_id,question_id) open 唯一索引说明存在本人未过期的编辑会话
      // （attempt 属主已由 createOnce 内 attemptForOwner 校验），直接恢复返回而非 409 锁死——
      // 否则刷新/返回后 30 分钟内无法重进同题。INSERT 失败时事务已中止，恢复必须开新事务；
      // 恢复路径不复核 baseAnswerRevision（既有会话自带 base，PATCH/confirm 仍有 revision 校验兜底）。
      for (let attempts = 0; attempts < 3; attempts += 1) {
        const recovered = await app.jundeAuth.transaction(async (client) => {
          const existing = await client.query("SELECT * FROM question_answer_edit_sessions WHERE attempt_id=$1 AND question_id=$2 AND status='open' AND expires_at>now() FOR UPDATE", [attemptId, questionId]);
          if (!existing.rows[0]) return null;
          const activeAttachments = await client.query("SELECT id,type,mime_type,size_bytes,duration_seconds,storage_key FROM question_evidence_attachments WHERE attempt_id=$1 AND question_id=$2 AND status='active' ORDER BY created_at", [attemptId, questionId]);
          return { found: existing.rows[0], attachments: activeAttachments.rows };
        });
        if (recovered) {
          // 凭证刷新可能走网络：预签名放在事务外（cos.js 约定：持锁事务内禁止外部网络调用）。
          const attachments = await Promise.all(recovered.attachments.map(async (item) => {
            const preview = await cos.createPreviewUrl(item.storage_key);
            return { id: item.id, type: item.type, mimeType: item.mime_type, sizeBytes: Number(item.size_bytes), durationSeconds: item.duration_seconds, status: "active", previewUrl: preview.url, previewExpiresAt: preview.expiresAt };
          }));
          return { id: recovered.found.id, status: recovered.found.status, draftIssueRemark: recovered.found.draft_issue_remark, activeAttachments: attachments };
        }
        // 竞态：会话刚被取消/过期清扫 → 重试创建一次；再撞 23505 则回到恢复查询。
        try {
          return await createOnce();
        } catch (retryError) {
          if (retryError?.code !== "EDIT_SESSION_EXISTS") throw retryError;
        }
      }
      throw app.jundeAuth.businessError("EDIT_SESSION_EXISTS", "该题正在编辑中，请先完成或取消当前编辑", 409);
    }
  });

  app.patch("/api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId", async (request) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const questionId = SecureUuidSchema.parse(request.params.questionId);
    const editSessionId = SecureUuidSchema.parse(request.params.editSessionId);
    const body = EditSessionPatchSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const attempt = await attemptForOwner(client, attemptId, session.user_id, true);
      if (attempt.status !== "draft" || Number(attempt.revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      const edit = await lockedSession(client, attemptId, questionId, editSessionId);
      if (edit.status !== "open" || new Date(edit.expires_at) <= new Date()) throw app.jundeAuth.businessError("EDIT_SESSION_EXPIRED", "编辑会话已过期，请重新打开", 409);
      await client.query("UPDATE question_answer_edit_sessions SET draft_issue_remark=$2 WHERE id=$1", [editSessionId, body.draftIssueRemark]);
      return { id: editSessionId, status: "open", draftIssueRemark: body.draftIssueRemark };
    });
  });

  app.post("/api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/confirm", async (request) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const questionId = SecureUuidSchema.parse(request.params.questionId);
    const editSessionId = SecureUuidSchema.parse(request.params.editSessionId);
    const body = EditSessionConfirmSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const attempt = await attemptForOwner(client, attemptId, session.user_id, true);
      if (attempt.status !== "draft" || Number(attempt.revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      const question = await lockedQuestion(client, attempt, questionId);
      const edit = await lockedSession(client, attemptId, questionId, editSessionId);
      if (edit.status !== "open" || new Date(edit.expires_at) <= new Date()) throw app.jundeAuth.businessError("EDIT_SESSION_EXPIRED", "编辑会话已过期，请重新打开", 409);
      const evidence = question.evidence_required ? await client.query(`SELECT attachment.type,count(*)::int count
        FROM question_evidence_attachments attachment
        WHERE attachment.attempt_id=$1 AND attachment.question_id=$2 AND (
          (attachment.status='active' AND NOT EXISTS (SELECT 1 FROM question_answer_edit_session_removals removal WHERE removal.edit_session_id=$3 AND removal.attachment_id=attachment.id))
          OR (attachment.status='staged_ready' AND attachment.edit_session_id=$3)
        ) GROUP BY attachment.type`, [attemptId, questionId, editSessionId]) : { rows: [] };
      const evidenceCounts = Object.fromEntries(evidence.rows.map((item) => [item.type, item.count]));
      const evidenceMaxDuration = await client.query("SELECT COALESCE(max(duration_seconds),0)::int max_duration FROM question_evidence_attachments WHERE attempt_id=$1 AND question_id=$2 AND type='audio' AND status='active'", [attemptId, questionId]);
      if (body.answer === "unscored" && (!edit.draft_issue_remark.trim() || evidenceCounts.image < question.image_min_count || evidenceCounts.audio < question.audio_min_count)) throw app.jundeAuth.businessError(!edit.draft_issue_remark.trim() ? "ISSUE_REMARK_REQUIRED" : "EVIDENCE_REQUIRED", !edit.draft_issue_remark.trim() ? "不得分说明不能为空" : "该题需要上传所需证据后才能确认", 422);
      if (body.answer === "unscored" && (Number(evidenceCounts.image || 0) > Number(question.image_max_count) || Number(evidenceMaxDuration.rows[0].max_duration) > Number(question.audio_max_duration_seconds))) throw app.jundeAuth.businessError("EVIDENCE_LIMIT_EXCEEDED", "该题照片数量或录音时长超出上限", 422);
      const current = await client.query("SELECT revision FROM question_answers WHERE attempt_id=$1 AND question_id=$2 FOR UPDATE", [attemptId, questionId]);
      if (Number(current.rows[0]?.revision || 0) !== Number(edit.base_answer_revision)) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      if (body.answer === "scored") {
        const discarded = await client.query(`UPDATE question_evidence_attachments SET status='deleted',cleanup_after=now()+INTERVAL '24 hours',verification_locked_by=NULL,verification_lease_expires_at=NULL,updated_at=now()
          WHERE attempt_id=$1 AND question_id=$2 AND status IN ('active','staged_uploading','staged_ready','failed') RETURNING id,storage_key`, [attemptId, questionId]);
        await enqueueCleanup(client, discarded.rows);
      } else {
        const discarded = await client.query("UPDATE question_evidence_attachments SET status='deleted',cleanup_after=now()+INTERVAL '24 hours',updated_at=now() WHERE attempt_id=$1 AND question_id=$2 AND status='active' AND id IN (SELECT attachment_id FROM question_answer_edit_session_removals WHERE edit_session_id=$3) RETURNING id,storage_key", [attemptId, questionId, editSessionId]);
        await enqueueCleanup(client, discarded.rows);
        await client.query("UPDATE question_evidence_attachments SET status='active',updated_at=now() WHERE edit_session_id=$1 AND status='staged_ready'", [editSessionId]);
        await discardStagedEvidence(client, editSessionId);
      }
      await client.query(`INSERT INTO question_answers (attempt_id,question_id,answer,awarded_score,issue_remark) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (attempt_id,question_id) DO UPDATE SET answer=EXCLUDED.answer,awarded_score=EXCLUDED.awarded_score,issue_remark=EXCLUDED.issue_remark,revision=question_answers.revision+1,updated_at=now()`, [attemptId, questionId, body.answer, body.answer === "scored" ? question.max_score : 0, body.answer === "scored" ? "" : edit.draft_issue_remark]);
      await client.query("UPDATE question_answer_edit_sessions SET status='confirmed',confirmed_at=now() WHERE id=$1", [editSessionId]);
      const updated = await client.query("UPDATE survey_attempts SET revision=revision+1,last_saved_at=now() WHERE id=$1 RETURNING revision", [attemptId]);
      await writeAudit(client, session, "issue_edit_confirmed", "assignment", attempt.assignment_id, { attemptId, questionId, answer: body.answer });
      return { revision: Number(updated.rows[0].revision) };
    });
  });

  app.post("/api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/cancel", async (request) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const questionId = SecureUuidSchema.parse(request.params.questionId);
    const editSessionId = SecureUuidSchema.parse(request.params.editSessionId);
    return app.jundeAuth.transaction(async (client) => {
      const attempt = await attemptForOwner(client, attemptId, session.user_id, true);
      if (attempt.status !== "draft") throw app.jundeAuth.businessError("QUESTIONNAIRE_LOCKED", "当前问卷不能修改", 409);
      const edit = await lockedSession(client, attemptId, questionId, editSessionId);
      if (edit.status !== "open") throw app.jundeAuth.businessError("EDIT_SESSION_CLOSED", "编辑会话已关闭", 409);
      await client.query("UPDATE question_answer_edit_sessions SET status='cancelled',cancelled_at=now() WHERE id=$1", [editSessionId]);
      await discardStagedEvidence(client, editSessionId);
      await writeAudit(client, session, "issue_edit_cancelled", "assignment", attempt.assignment_id, { attemptId, questionId });
      return { status: "cancelled" };
    });
  });

  app.delete("/api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/evidence/:attachmentId", async (request) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const questionId = SecureUuidSchema.parse(request.params.questionId);
    const editSessionId = SecureUuidSchema.parse(request.params.editSessionId);
    const attachmentId = SecureUuidSchema.parse(request.params.attachmentId);
    return app.jundeAuth.transaction(async (client) => {
      const attempt = await attemptForOwner(client, attemptId, session.user_id, true);
      if (attempt.status !== "draft" || attempt.assignment_status !== "in_progress") throw app.jundeAuth.businessError("QUESTIONNAIRE_LOCKED", "当前问卷不能修改", 409);
      const edit = await lockedSession(client, attemptId, questionId, editSessionId);
      if (edit.status !== "open" || new Date(edit.expires_at) <= new Date()) throw app.jundeAuth.businessError("EDIT_SESSION_EXPIRED", "编辑会话已过期，请重新打开", 409);
      const found = await client.query("SELECT * FROM question_evidence_attachments WHERE id=$1 AND attempt_id=$2 AND question_id=$3 FOR UPDATE", [attachmentId, attemptId, questionId]);
      const attachment = found.rows[0];
      if (!attachment || !["active", "staged_uploading", "staged_ready", "failed"].includes(attachment.status)) throw app.jundeAuth.businessError("EVIDENCE_NOT_FOUND", "附件不存在或已删除", 404);
      if (attachment.status === "active") {
        await client.query("INSERT INTO question_answer_edit_session_removals (edit_session_id,attachment_id,attempt_id,question_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [editSessionId, attachmentId, attemptId, questionId]);
        await writeAudit(client, session, "evidence_removed", "assignment", attempt.assignment_id, { attemptId, questionId, attachmentId, stage: "pending_removal" });
        return { id: attachmentId, status: "pending_removal" };
      }
      if (attachment.edit_session_id !== editSessionId) throw app.jundeAuth.businessError("EVIDENCE_NOT_FOUND", "附件不存在或已删除", 404);
      const discarded = await client.query("UPDATE question_evidence_attachments SET status='deleted',cleanup_after=now()+INTERVAL '24 hours',verification_locked_by=NULL,verification_lease_expires_at=NULL,updated_at=now() WHERE id=$1 RETURNING id,storage_key", [attachmentId]);
      await enqueueCleanup(client, discarded.rows);
      await writeAudit(client, session, "evidence_removed", "assignment", attempt.assignment_id, { attemptId, questionId, attachmentId, type: attachment.type });
      return { id: attachmentId, status: "deleted" };
    });
  });

  app.post("/api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/evidence-uploads", async (request, reply) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const questionId = SecureUuidSchema.parse(request.params.questionId);
    const editSessionId = SecureUuidSchema.parse(request.params.editSessionId);
    const body = EvidenceUploadInitSchema.parse(request.body);
    // 白名单按 base mime 归一化匹配（容忍 ";codecs=..." 后缀）；audio/webm 为 Chrome/Android MediaRecorder 默认容器。
    const baseMime = String(body.mimeType).split(";")[0].trim().toLowerCase();
    const validMime = body.type === "image" ? ["image/jpeg", "image/png"] : ["audio/mpeg", "audio/aac", "audio/mp4", "audio/x-m4a", "audio/webm"];
    if (!validMime.includes(baseMime) || (body.type === "audio" && !body.durationSeconds)) throw app.jundeAuth.businessError("EVIDENCE_FILE_INVALID", "附件格式或时长不符合要求", 422);
    // 凭证刷新（可能的网络调用）必须先于数据库事务，事务内只做纯本地签名。
    // 测试注入的 storage 替身可以只实现业务方法，此时跳过该预检。
    if (typeof cos.assertReady === "function") await cos.assertReady();
    const initialized = await app.jundeAuth.transaction(async (client) => {
      const attempt = await attemptForOwner(client, attemptId, session.user_id, true);
      if (attempt.status !== "draft" || attempt.assignment_status !== "in_progress") throw app.jundeAuth.businessError("QUESTIONNAIRE_LOCKED", "当前问卷不能修改", 409);
      const question = await lockedQuestion(client, attempt, questionId);
      if (!question.evidence_required) throw app.jundeAuth.businessError("EVIDENCE_NOT_REQUIRED", "该题无需上传证据", 409);
      const edit = await lockedSession(client, attemptId, questionId, editSessionId);
      if (edit.status !== "open" || new Date(edit.expires_at) <= new Date()) throw app.jundeAuth.businessError("EDIT_SESSION_EXPIRED", "编辑会话已过期，请重新打开", 409);
      const existing = await client.query("SELECT * FROM question_evidence_attachments WHERE edit_session_id=$1 AND client_file_id=$2 FOR UPDATE", [editSessionId, body.clientFileId]);
      const attachment = existing.rows[0] || (await client.query(`INSERT INTO question_evidence_attachments (id,attempt_id,question_id,type,storage_key,edit_session_id,status,client_file_id,upload_nonce,declared_content_type,declared_size_bytes,duration_seconds)
        VALUES ($1,$2,$3,$4,$5,$6,'staged_uploading',$7,$8,$9,$10,$11) RETURNING *`, [uuidv7(), attemptId, questionId, body.type, `attempts/${attemptId}/question-evidence/${uuidv7()}/${cos.newObjectSuffix()}`, editSessionId, body.clientFileId, uuidv7(), body.mimeType, body.sizeBytes, body.durationSeconds || null])).rows[0];
      if (attachment.type !== body.type || Number(attachment.declared_size_bytes) !== body.sizeBytes || attachment.declared_content_type !== body.mimeType) throw app.jundeAuth.businessError("EVIDENCE_UPLOAD_CONFLICT", "同一文件标识的上传内容不一致", 409);
      if (body.type === "audio" && Number(body.durationSeconds) > Number(question.audio_max_duration_seconds)) throw app.jundeAuth.businessError("EVIDENCE_LIMIT_EXCEEDED", `录音时长不能超过 ${question.audio_max_duration_seconds} 秒`, 422);
      const maxCount = body.type === "image" ? Number(question.image_max_count) : 3;
      const count = await client.query("SELECT count(*)::int count FROM question_evidence_attachments WHERE attempt_id=$1 AND question_id=$2 AND type=$3 AND status IN ('staged_uploading','staged_ready','active')", [attemptId, questionId, body.type]);
      if (count.rows[0].count > maxCount) throw app.jundeAuth.businessError("EVIDENCE_LIMIT_EXCEEDED", body.type === "image" ? `该题最多上传 ${maxCount} 张照片` : "该题音频数量已达上限", 422);
      const target = cos.createPostTarget({ key: attachment.storage_key, sizeBytes: attachment.declared_size_bytes, uploadNonce: attachment.upload_nonce, contentType: attachment.declared_content_type });
      await client.query("UPDATE question_evidence_attachments SET upload_target_expires_at=$2,updated_at=now() WHERE id=$1", [attachment.id, target.expiresAt]);
      return { statusCode: existing.rows[0] ? 200 : 201, body: { attachmentId: attachment.id, uploadToken: attachment.upload_nonce, status: attachment.status, uploadTarget: target } };
    });
    return reply.code(initialized.statusCode).send(initialized.body);
  });

  app.post("/api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/evidence-uploads/:attachmentId/complete", async (request, reply) => {
    const session = await requireInspector(request);
    const attemptId = SecureUuidSchema.parse(request.params.id);
    const questionId = SecureUuidSchema.parse(request.params.questionId);
    const editSessionId = SecureUuidSchema.parse(request.params.editSessionId);
    const attachmentId = SecureUuidSchema.parse(request.params.attachmentId);
    const body = EvidenceUploadCompleteSchema.parse(request.body);
    const leaseOwner = uuidv7();
    const reservation = await app.jundeAuth.transaction(async (client) => {
      const attempt = await attemptForOwner(client, attemptId, session.user_id, true);
      if (attempt.status !== "draft" || attempt.assignment_status !== "in_progress") throw app.jundeAuth.businessError("QUESTIONNAIRE_LOCKED", "当前问卷不能修改", 409);
      const edit = await lockedSession(client, attemptId, questionId, editSessionId);
      if (edit.status !== "open" || new Date(edit.expires_at) <= new Date()) throw app.jundeAuth.businessError("EDIT_SESSION_EXPIRED", "编辑会话已过期，请重新打开", 409);
      const found = await client.query("SELECT * FROM question_evidence_attachments WHERE id=$1 AND attempt_id=$2 AND question_id=$3 AND edit_session_id=$4 FOR UPDATE", [attachmentId, attemptId, questionId, editSessionId]);
      const attachment = found.rows[0];
      if (!attachment || attachment.upload_nonce !== body.uploadToken) throw app.jundeAuth.businessError("EVIDENCE_UPLOAD_INVALID", "上传凭据无效", 409);
      if (attachment.status === "staged_ready") return { ready: true, attachment };
      if (attachment.status !== "staged_uploading" || Number(attachment.declared_size_bytes) !== body.sizeBytes || (attachment.type === "audio" && Number(attachment.duration_seconds) !== body.durationSeconds)) throw app.jundeAuth.businessError("EVIDENCE_UPLOAD_INVALID", "上传内容不一致", 409);
      if (attachment.verification_lease_expires_at && new Date(attachment.verification_lease_expires_at) > new Date()) return { pending: true };
      await client.query("UPDATE question_evidence_attachments SET verification_locked_by=$2,verification_lease_expires_at=now()+INTERVAL '60 seconds',updated_at=now() WHERE id=$1", [attachmentId, leaseOwner]);
      return { attachment };
    });
    if (reservation.ready) return { id: reservation.attachment.id, status: "staged_ready" };
    if (reservation.pending) return reply.header("Retry-After", "1").code(202).send({ id: attachmentId, status: "verifying" });
    let verified;
    try {
      // cos.js 魔数闸不含 webm 且该文件红线外，故 batch3 内做等价最小校验（nonce 头复核不可用，以 policy 签名链为准）。
      const declaredBase = String(reservation.attachment.declared_content_type).split(";")[0].trim().toLowerCase();
      if (reservation.attachment.type === "audio" && declaredBase === "audio/webm") {
        const objectBody = await cos.readObject(reservation.attachment.storage_key);
        const expectedSizeBytes = Number(reservation.attachment.declared_size_bytes);
        const isEbml = Buffer.isBuffer(objectBody) && objectBody.length >= 4 && objectBody[0] === 0x1a && objectBody[1] === 0x45 && objectBody[2] === 0xdf && objectBody[3] === 0xa3;
        if (!isEbml || objectBody.length !== expectedSizeBytes) throw app.jundeAuth.businessError("EVIDENCE_FILE_INVALID", "文件内容与声明类型不符", 422);
        verified = { sizeBytes: objectBody.length, mimeType: reservation.attachment.declared_content_type, sha256: createHash("sha256").update(objectBody).digest("hex"), storageVersionId: null, durationSeconds: null };
      } else {
        verified = await cos.verifyObject({ key: reservation.attachment.storage_key, uploadNonce: reservation.attachment.upload_nonce, expectedSizeBytes: reservation.attachment.declared_size_bytes, type: reservation.attachment.type, declaredContentType: reservation.attachment.declared_content_type });
      }
    } catch (error) {
      await app.jundeAuth.transaction(async (client) => client.query("UPDATE question_evidence_attachments SET status='failed',verification_locked_by=NULL,verification_lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND verification_locked_by=$2", [attachmentId, leaseOwner]));
      if (error.statusCode) throw error;
      throw app.jundeAuth.businessError("EVIDENCE_VERIFY_FAILED", "附件校验失败，请重新上传", 422);
    }
    return app.jundeAuth.transaction(async (client) => {
      const attempt = await attemptForOwner(client, attemptId, session.user_id, true);
      const edit = await lockedSession(client, attemptId, questionId, editSessionId);
      const found = await client.query("SELECT * FROM question_evidence_attachments WHERE id=$1 AND attempt_id=$2 AND question_id=$3 AND edit_session_id=$4 FOR UPDATE", [attachmentId, attemptId, questionId, editSessionId]);
      const attachment = found.rows[0];
      if (!attachment || attachment.verification_locked_by !== leaseOwner || attachment.upload_nonce !== body.uploadToken) throw app.jundeAuth.businessError("EVIDENCE_VERIFY_STALE", "附件校验已失效，请重新上传", 409);
      if (attempt.status !== "draft" || attempt.assignment_status !== "in_progress" || edit.status !== "open") {
        await client.query("UPDATE question_evidence_attachments SET status='failed',verification_locked_by=NULL,verification_lease_expires_at=NULL,updated_at=now() WHERE id=$1", [attachmentId]);
        throw app.jundeAuth.businessError("QUESTIONNAIRE_LOCKED", "当前问卷不能修改", 409);
      }
      const finalized = await client.query("UPDATE question_evidence_attachments SET status='staged_ready',size_bytes=$2,mime_type=$3,sha256=$4,storage_version_id=$5,duration_seconds=COALESCE($6,duration_seconds),verification_locked_by=NULL,verification_lease_expires_at=NULL,updated_at=now() WHERE id=$1 RETURNING *", [attachmentId, verified.sizeBytes, verified.mimeType, verified.sha256, verified.storageVersionId, verified.durationSeconds]);
      const updated = await client.query("UPDATE survey_attempts SET revision=revision+1,last_saved_at=now() WHERE id=$1 RETURNING revision", [attemptId]);
      await writeAudit(client, session, "evidence_uploaded", "assignment", attempt.assignment_id, { attemptId, questionId, attachmentId, type: attachment.type, sizeBytes: verified.sizeBytes });
      return { id: finalized.rows[0].id, status: finalized.rows[0].status, revision: Number(updated.rows[0].revision) };
    });
  });
}
