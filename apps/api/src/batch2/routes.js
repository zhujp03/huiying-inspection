import { writeAudit } from "../audit.js";
import { assertRegionCovered, assertStoreCovered, hasFullScope, storeScopeFilter } from "../auth/authorization.js";
import { AssignmentExtendSchema, AssignmentUpsertSchema, BrandWriteSchema, CampaignWriteSchema, CheckinExemptionCreateSchema, CheckinExemptionRevokeSchema, CursorPageSchema, DishRequirementsReplaceSchema, LocationSampleSchema, QuestionCategoryWriteSchema, QuestionCreateSchema, QuestionDeleteSchema, QuestionEvidencePatchSchema, QuestionMoveSchema, QuestionPatchSchema, QuestionnaireVersionCreateSchema, RegionWriteSchema, RevisionActionSchema, RevisionReasonSchema, SecureUuidSchema, StoreListQuerySchema, StoreWriteSchema } from "../../../../packages/contracts/index.js";
import { randomUUID } from "node:crypto";
import { uuidv7 } from "../ids.js";
import { evaluateCheckin } from "../location.js";
import { advanceCampaignOverdue } from "../campaign-state.js";

const row = (store) => ({
  id: store.id,
  name: store.name,
  businessNo: store.business_no,
  brandId: store.brand_id,
  brandName: store.brand_name,
  cityRegionId: store.city_region_id,
  cityName: store.city_name,
  regionId: store.region_id,
  regionName: store.region_name,
  address: store.address,
  active: store.active,
  locationVerified: Boolean(store.location_verified_at),
  radiusMeters: store.checkin_radius_meters,
  latitudeGcj02: store.latitude_gcj02,
  longitudeGcj02: store.longitude_gcj02,
  accuracyAllowanceMaxMeters: store.accuracy_allowance_max_meters,
  providerPoiId: store.provider_poi_id,
  coordinateSource: store.coordinate_source,
  revision: Number(store.revision),
});

const brandRow = (brand) => ({
  id: brand.id,
  name: brand.name,
  active: brand.active,
  storeCount: brand.store_count === undefined ? undefined : Number(brand.store_count),
  revision: Number(brand.revision),
});

const regionRow = (region) => ({
  id: region.id,
  name: region.name,
  code: region.code,
  parentId: region.parent_id,
  level: Number(region.level),
  active: region.active,
  revision: Number(region.revision),
});

const levelFor = (code, parentLevel) => {
  if (!parentLevel) return /^[1-9]\d0000$/.test(code) ? 1 : 2;
  if (parentLevel === 1) return 2;
  return 3;
};

const versionRow = (version) => ({
  id: version.id,
  name: version.name,
  versionLabel: `V${version.version_number}`,
  status: version.status,
  revision: Number(version.revision),
  enabledQuestionCount: Number(version.enabled_question_count),
  numberingValid: Number(version.enabled_question_count) >= 1 && Number(version.distinct_question_count) === Number(version.enabled_question_count) && Number(version.minimum_question_number) === 1 && Number(version.maximum_question_number) === Number(version.enabled_question_count),
  createdAt: version.created_at.toISOString(),
});

const questionRow = (question) => ({
  id: question.id,
  number: question.question_number,
  category: question.category,
  categoryName: question.category_name,
  text: question.text,
  maxScore: Number(question.max_score ?? 0),
  enabled: Boolean(question.enabled),
  scoreWipe: Boolean(question.is_score_wipe),
  revision: Number(question.revision),
  evidence: {
    evidenceRequired: Boolean(question.evidence_required),
    imageRequired: Boolean(question.image_required),
    audioRequired: Boolean(question.audio_required),
    imageMaxCount: Number(question.image_max_count ?? 3),
    audioMaxDurationSeconds: Number(question.audio_max_duration_seconds ?? 10),
  },
});

const categoryRow = (category) => ({
  id: category.id,
  code: category.code,
  name: category.name,
  sortOrder: Number(category.sort_order),
  active: category.active,
  questionCount: category.question_count === undefined ? undefined : Number(category.question_count),
  revision: Number(category.revision),
});

const selectVersions = `SELECT v.id,v.version_number,v.status,v.revision,v.created_at,t.name,
  count(q.id) FILTER (WHERE q.enabled) enabled_question_count,
  count(DISTINCT q.question_number) FILTER (WHERE q.enabled) distinct_question_count,
  min(q.question_number) FILTER (WHERE q.enabled) minimum_question_number,
  max(q.question_number) FILTER (WHERE q.enabled) maximum_question_number
  FROM questionnaire_versions v JOIN questionnaire_templates t ON t.id=v.template_id
  LEFT JOIN questions q ON q.version_id=v.id`;
const questionsForVersion = `SELECT q.*,COALESCE(e.evidence_required,false) evidence_required,COALESCE(e.image_required,false) image_required,COALESCE(e.audio_required,false) audio_required,
  COALESCE(e.image_max_count,3) image_max_count,COALESCE(e.audio_max_duration_seconds,10) audio_max_duration_seconds,qc.name category_name
  FROM questions q LEFT JOIN question_evidence_requirements e ON e.question_id=q.id LEFT JOIN question_categories qc ON qc.code=q.category WHERE q.version_id=$1 ORDER BY q.question_number`;

function publishCheck(questions, activeCategoryCodes) {
  // 题目数量不设上限（≥1 即可）；题号必须 1..N 连续；分类必须是启用中的动态分类；证据父子配置有效；
  // 分数清零题：启用题中同一分类至多一道（未带 is_score_wipe 字段视为 false，停用题不参与冲突检测）。
  const enabled = questions.filter((question) => question.enabled);
  const numberingValid = enabled.length >= 1 && enabled.every((question, index) => Number(question.question_number) === index + 1);
  const categoriesValid = enabled.every((question) => activeCategoryCodes.has(question.category));
  const evidenceValid = enabled.every((question) => !question.evidence_required || question.image_required || question.audio_required);
  const seenWipeCategories = new Set();
  const scoreWipeConflicts = [];
  for (const question of enabled) {
    if (!question.is_score_wipe) continue;
    if (seenWipeCategories.has(question.category)) {
      // 冲突分类输出展示名（category_name 可能为 null，回退分类 code），供发布失败消息直接拼接。
      const categoryName = question.category_name || question.category;
      if (!scoreWipeConflicts.includes(categoryName)) scoreWipeConflicts.push(categoryName);
    } else {
      seenWipeCategories.add(question.category);
    }
  }
  const scoreWipeValid = scoreWipeConflicts.length === 0;
  return { valid: numberingValid && categoriesValid && evidenceValid && scoreWipeValid, numberingValid, categoriesValid, evidenceValid, scoreWipeValid, scoreWipeConflicts };
}

const campaignRow = (campaign) => ({
  id: campaign.id,
  name: campaign.name,
  businessNo: campaign.business_no,
  storeName: campaign.store_name,
  startsAt: campaign.starts_at.toISOString(),
  dueAt: campaign.due_at.toISOString(),
  questionnaireDeadlineAt: campaign.questionnaire_deadline_at ? campaign.questionnaire_deadline_at.toISOString() : null,
  status: campaign.status,
  revision: Number(campaign.revision),
  assignmentCount: Number(campaign.assignment_count || 0),
  overdueCount: Number(campaign.overdue_count || 0),
});

const centsFor = (value) => {
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents) || cents < 0 || Math.abs(Number(value) * 100 - cents) > 1e-8) throw Object.assign(new Error("预算金额必须精确到分"), { code: "BUDGET_INVALID", statusCode: 422 });
  return cents;
};

export function registerBatch2Routes(app, { pool, config }) {
  const requireConfigured = () => {
    if (!app.jundeAuth.configured) throw app.jundeAuth.businessError("AUTH_NOT_CONFIGURED", "认证服务暂未配置", 503, { retryable: true });
  };
  const requireStoreAdmin = async (request, write = false) => {
    requireConfigured();
    return write ? app.jundeAuth.adminSession(request, "store:manage") : app.jundeAuth.adminReadSession(request, "store:manage");
  };
  const requireQuestionnaireAdmin = async (request, write = false) => {
    requireConfigured();
    return write ? app.jundeAuth.adminSession(request, "questionnaire:manage") : app.jundeAuth.adminReadSession(request, "questionnaire:manage");
  };
  const requireCampaignAdmin = async (request, write = false) => {
    requireConfigured();
    return write ? app.jundeAuth.adminSession(request, "campaign:manage") : app.jundeAuth.adminReadSession(request, "campaign:manage");
  };
  const requireExemptionAdmin = async (request, write = false) => {
    requireConfigured();
    return write ? app.jundeAuth.adminSession(request, "checkin:exempt") : app.jundeAuth.adminReadSession(request, "checkin:exempt");
  };
  const requireInspector = async (request) => {
    requireConfigured();
    const session = await app.jundeAuth.sessionFor(request, false);
    if (session.kind !== "inspector" || session.user_status !== "approved_active") throw app.jundeAuth.businessError("FORBIDDEN", "你没有权限进行此操作", 403);
    return session;
  };
  // 数据范围外（或目标不存在）统一 403，避免通过错误码差异探测资源存在性
  const scopeForbidden = () => { throw app.jundeAuth.businessError("SCOPE_FORBIDDEN", "该数据不在你的管理范围内", 403); };
  // 门店行附带品牌与所属城市（区县的上级地级区域）；直辖市城市层为「市辖区」，展示时回退省名。
  const selectStore = `SELECT s.*,r.name region_name,pr.id city_region_id,CASE WHEN pr.name IN ('市辖区','县') THEN pp.name ELSE pr.name END city_name,b.name brand_name
    FROM stores s JOIN regions r ON r.id = s.region_id
    LEFT JOIN regions pr ON pr.id = r.parent_id LEFT JOIN regions pp ON pp.id = pr.parent_id
    LEFT JOIN brands b ON b.id = s.brand_id`;

  app.get("/api/admin/regions", async (request) => {
    await requireStoreAdmin(request);
    const result = await pool.query("SELECT * FROM regions WHERE active ORDER BY code");
    return { items: result.rows.map(regionRow) };
  });

  app.post("/api/admin/regions", async (request, reply) => {
    const session = await requireStoreAdmin(request, true);
    const body = RegionWriteSchema.parse(request.body);
    const id = uuidv7();
    let parent = null;
    if (body.parentId) {
      const parentResult = await pool.query("SELECT * FROM regions WHERE id=$1", [body.parentId]);
      parent = parentResult.rows[0];
      if (!parent) throw app.jundeAuth.businessError("REGION_PARENT_NOT_FOUND", "上级区域不存在", 422);
      if (!body.code.startsWith(parent.code.slice(0, parent.level === 1 ? 2 : 4))) throw app.jundeAuth.businessError("REGION_CODE_MISMATCH", "区域编码必须与上级区域对应", 422);
    }
    const level = levelFor(body.code, parent ? Number(parent.level) : null);
    try {
      const result = await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,$2,$3,$4,$5) RETURNING *", [id, body.name, body.code, parent ? parent.id : null, level]);
      await writeAudit(pool, session, "region_created", "region", id, { name: body.name, code: body.code });
      return reply.code(201).send({ region: regionRow(result.rows[0]) });
    } catch (error) {
      if (error.code === "23505") throw app.jundeAuth.businessError("REGION_CONFLICT", "区域编码已存在", 409);
      throw error;
    }
  });

  app.get("/api/admin/brands", async (request) => {
    await requireStoreAdmin(request);
    const result = await pool.query(`SELECT b.*, (SELECT count(*) FROM stores s WHERE s.brand_id = b.id) store_count FROM brands b ORDER BY b.created_at`);
    return { items: result.rows.map(brandRow) };
  });

  app.post("/api/admin/brands", async (request, reply) => {
    const session = await requireStoreAdmin(request, true);
    const body = BrandWriteSchema.parse(request.body);
    try {
      const result = await pool.query("INSERT INTO brands (id,name,active) VALUES ($1,$2,$3) RETURNING *", [uuidv7(), body.name, body.active]);
      await writeAudit(pool, session, "brand_created", "brand", result.rows[0].id, { name: body.name });
      return reply.code(201).send({ brand: brandRow({ ...result.rows[0], store_count: 0 }) });
    } catch (error) {
      if (error.code === "23505") throw app.jundeAuth.businessError("BRAND_CONFLICT", "品牌名称已存在", 409);
      throw error;
    }
  });

  app.patch("/api/admin/brands/:id", async (request) => {
    const session = await requireStoreAdmin(request, true);
    const id = SecureUuidSchema.parse(request.params.id);
    const body = BrandWriteSchema.parse(request.body);
    if (body.revision === undefined) throw app.jundeAuth.businessError("REVISION_REQUIRED", "内容已更新，请刷新后重试", 422);
    try {
      const result = await pool.query("UPDATE brands SET name=$2,active=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$4 RETURNING *", [id, body.name, body.active, body.revision]);
      if (!result.rows[0]) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      await writeAudit(pool, session, "brand_updated", "brand", id, { name: body.name, active: body.active });
      const count = await pool.query("SELECT count(*)::int AS n FROM stores WHERE brand_id=$1", [id]);
      return { brand: brandRow({ ...result.rows[0], store_count: count.rows[0].n }) };
    } catch (error) {
      if (error.code === "23505") throw app.jundeAuth.businessError("BRAND_CONFLICT", "品牌名称已存在", 409);
      throw error;
    }
  });

  app.delete("/api/admin/brands/:id", async (request) => {
    const session = await requireStoreAdmin(request, true);
    const id = SecureUuidSchema.parse(request.params.id);
    const body = RevisionActionSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const brand = await client.query("SELECT revision,name FROM brands WHERE id=$1 FOR UPDATE", [id]);
      if (!brand.rows[0]) throw app.jundeAuth.businessError("BRAND_NOT_FOUND", "品牌不存在", 404);
      if (Number(brand.rows[0].revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      const referenced = await client.query("SELECT 1 FROM stores WHERE brand_id=$1 LIMIT 1", [id]);
      if (referenced.rows[0]) throw app.jundeAuth.businessError("BRAND_DELETE_NOT_ALLOWED", "该品牌已被门店引用，无法删除，可改为停用", 409);
      await client.query("DELETE FROM brands WHERE id=$1", [id]);
      await writeAudit(client, session, "brand_deleted", "brand", id, { name: brand.rows[0].name });
      return { deleted: true };
    });
  });

  // 管理列表排序：order=desc 时按 id 倒序取最新（id 为 uuidv7，时间有序），默认 asc 保持既有行为；未知值按 asc。
  const listOrder = (query) => (query?.order === "desc" ? { sql: "DESC", op: "<" } : { sql: "ASC", op: ">" });

  app.get("/api/admin/stores", async (request) => {
    const session = await requireStoreAdmin(request);
    const query = StoreListQuerySchema.parse(request.query);
    const order = listOrder(request.query);
    const conditions = [`($1::uuid IS NULL OR s.id ${order.op} $1)`];
    const params = [query.cursor || null, query.limit + 1];
    if (query.brandId) { params.push(query.brandId); conditions.push(`s.brand_id = $${params.length}`); }
    if (query.cityRegionId) { params.push(query.cityRegionId); conditions.push(`r.parent_id = $${params.length}`); }
    // 范围受限管理员：列表静默过滤（与 batch5/stats 同构的三层子树 + store 精确）
    if (!hasFullScope(session.scopes)) { params.push(session.user_id); conditions.push(storeScopeFilter({ scopes: session.scopes, storeAlias: "s", regionAlias: "r", userParam: `$${params.length}` })); }
    const result = await pool.query(`${selectStore} WHERE ${conditions.join(" AND ")} ORDER BY s.id ${order.sql} LIMIT $2`, params);
    const items = result.rows.slice(0, query.limit).map(row);
    return { items, nextCursor: result.rows.length > query.limit ? items.at(-1).id : null };
  });

  const requireActiveBrand = async (brandId) => {
    const brand = await pool.query("SELECT id, active FROM brands WHERE id=$1", [brandId]);
    if (!brand.rows[0]) throw app.jundeAuth.businessError("BRAND_NOT_FOUND", "品牌不存在，请先在品牌列表中创建", 422);
    if (!brand.rows[0].active) throw app.jundeAuth.businessError("BRAND_INACTIVE", "品牌已停用，请先启用后再使用", 422);
  };

  app.post("/api/admin/stores", async (request, reply) => {
    const session = await requireStoreAdmin(request, true);
    const body = StoreWriteSchema.parse(request.body);
    // 范围受限管理员：新建门店按 body.regionId 的区域覆盖判定（store 范围管理员不能建新门店）
    if (!hasFullScope(session.scopes)) await assertRegionCovered(pool, session.scopes, body.regionId, scopeForbidden);
    await requireActiveBrand(body.brandId);
    const id = uuidv7();
    try {
      const result = await pool.query(`INSERT INTO stores (id,business_no,name,brand_id,region_id,address,latitude_gcj02,longitude_gcj02,provider_poi_id,coordinate_source,checkin_radius_meters,accuracy_allowance_max_meters,location_verified_at,location_verified_by,active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $13 THEN now() ELSE NULL END,CASE WHEN $13 THEN $14::uuid ELSE NULL END,$15)
        RETURNING *`, [id, body.businessNo, body.name, body.brandId, body.regionId, body.address, body.latitudeGcj02, body.longitudeGcj02, body.providerPoiId || null, body.coordinateSource, body.radiusMeters, body.accuracyAllowanceMaxMeters, body.locationVerified, session.user_id, body.active]);
      const region = await pool.query("SELECT name,level FROM regions WHERE id = $1", [body.regionId]);
      if (!region.rows[0]) throw app.jundeAuth.businessError("REGION_NOT_FOUND", "区域不存在", 422);
      if (Number(region.rows[0].level) !== 3) throw app.jundeAuth.businessError("REGION_LEVEL_INVALID", "门店必须归属到区县级区域", 422);
      const joined = await pool.query(`${selectStore} WHERE s.id = $1`, [id]);
      await writeAudit(pool, session, "store_created", "store", id, { name: body.name, businessNo: body.businessNo });
      return reply.code(201).send({ store: row(joined.rows[0]) });
    } catch (error) {
      if (error.code === "23505") throw app.jundeAuth.businessError("STORE_CONFLICT", "门店编号已存在", 409);
      if (error.code === "23503") throw app.jundeAuth.businessError("REGION_NOT_FOUND", "区域不存在", 422);
      throw error;
    }
  });

  app.patch("/api/admin/stores/:id", async (request) => {
    const session = await requireStoreAdmin(request, true);
    const body = StoreWriteSchema.parse(request.body);
    if (body.revision === undefined) throw app.jundeAuth.businessError("REVISION_REQUIRED", "内容已更新，请刷新后重试", 422);
    // 范围受限管理员：按目标门店现有 region_id 判定覆盖
    if (!hasFullScope(session.scopes)) await assertStoreCovered(pool, session.scopes, request.params.id, scopeForbidden);
    await requireActiveBrand(body.brandId);
    const result = await pool.query(`UPDATE stores SET business_no=$2,name=$3,brand_id=$4,region_id=$5,address=$6,latitude_gcj02=$7,longitude_gcj02=$8,provider_poi_id=$9,coordinate_source=$10,checkin_radius_meters=$11,accuracy_allowance_max_meters=$12,location_verified_at=CASE WHEN $13 THEN now() ELSE NULL END,location_verified_by=CASE WHEN $13 THEN $14::uuid ELSE NULL END,active=$15,revision=revision+1,updated_at=now()
      WHERE id=$1 AND revision=$16 RETURNING *`, [request.params.id, body.businessNo, body.name, body.brandId, body.regionId, body.address, body.latitudeGcj02, body.longitudeGcj02, body.providerPoiId || null, body.coordinateSource, body.radiusMeters, body.accuracyAllowanceMaxMeters, body.locationVerified, session.user_id, body.active, body.revision]);
    if (!result.rows[0]) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
    const region = await pool.query("SELECT name,level FROM regions WHERE id = $1", [body.regionId]);
    if (!region.rows[0]) throw app.jundeAuth.businessError("REGION_NOT_FOUND", "区域不存在", 422);
    if (Number(region.rows[0].level) !== 3) throw app.jundeAuth.businessError("REGION_LEVEL_INVALID", "门店必须归属到区县级区域", 422);
    const joined = await pool.query(`${selectStore} WHERE s.id = $1`, [request.params.id]);
    await writeAudit(pool, session, "store_updated", "store", request.params.id, { name: body.name, businessNo: body.businessNo, active: body.active });
    return { store: row(joined.rows[0]) };
  });

  app.delete("/api/admin/stores/:id", async (request) => {
    const session = await requireStoreAdmin(request, true);
    const id = SecureUuidSchema.parse(request.params.id);
    const body = RevisionActionSchema.parse(request.body);
    if (!hasFullScope(session.scopes)) await assertStoreCovered(pool, session.scopes, id, scopeForbidden);
    return app.jundeAuth.transaction(async (client) => {
      const store = await client.query("SELECT revision,name FROM stores WHERE id=$1 FOR UPDATE", [id]);
      if (!store.rows[0]) throw app.jundeAuth.businessError("STORE_NOT_FOUND", "门店不存在", 404);
      if (Number(store.rows[0].revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      const referenced = await client.query("SELECT 1 FROM audit_campaigns WHERE store_id=$1 LIMIT 1", [id]);
      if (referenced.rows[0]) throw app.jundeAuth.businessError("STORE_DELETE_NOT_ALLOWED", "该门店已被探店任务引用，无法删除，可改为停用", 409);
      try {
        await client.query("DELETE FROM stores WHERE id=$1", [id]);
      } catch (error) {
        if (error.code === "23503") throw app.jundeAuth.businessError("STORE_DELETE_NOT_ALLOWED", "该门店已被业务数据引用，无法删除，可改为停用", 409);
        throw error;
      }
      await writeAudit(client, session, "store_deleted", "store", id, { name: store.rows[0].name });
      return { deleted: true };
    });
  });

  app.get("/api/admin/question-categories", async (request) => {
    await requireQuestionnaireAdmin(request);
    const result = await pool.query(`SELECT c.*, (SELECT count(*) FROM questions q WHERE q.category = c.code) question_count FROM question_categories c ORDER BY c.sort_order, c.created_at`);
    return { items: result.rows.map(categoryRow) };
  });

  app.post("/api/admin/question-categories", async (request, reply) => {
    const session = await requireQuestionnaireAdmin(request, true);
    const body = QuestionCategoryWriteSchema.parse(request.body);
    const sortOrder = await pool.query("SELECT COALESCE(max(sort_order),0)+1 next_order FROM question_categories");
    const code = `cat_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    try {
      const result = await pool.query("INSERT INTO question_categories (id,code,name,sort_order,active) VALUES ($1,$2,$3,$4,$5) RETURNING *", [uuidv7(), code, body.name, sortOrder.rows[0].next_order, body.active]);
      await writeAudit(pool, session, "category_created", "category", result.rows[0].id, { name: body.name, code });
      return reply.code(201).send({ category: categoryRow({ ...result.rows[0], question_count: 0 }) });
    } catch (error) {
      if (error.code === "23505") throw app.jundeAuth.businessError("QUESTION_CATEGORY_CONFLICT", "分类名称已存在", 409);
      throw error;
    }
  });

  app.patch("/api/admin/question-categories/:id", async (request) => {
    const session = await requireQuestionnaireAdmin(request, true);
    const id = SecureUuidSchema.parse(request.params.id);
    const body = QuestionCategoryWriteSchema.parse(request.body);
    if (body.revision === undefined) throw app.jundeAuth.businessError("REVISION_REQUIRED", "内容已更新，请刷新后重试", 422);
    try {
      const result = await pool.query("UPDATE question_categories SET name=$2,active=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$4 RETURNING *", [id, body.name, body.active, body.revision]);
      if (!result.rows[0]) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      await writeAudit(pool, session, "category_updated", "category", id, { name: body.name, active: body.active });
      const count = await pool.query("SELECT count(*)::int AS n FROM questions WHERE category=$1", [result.rows[0].code]);
      return { category: categoryRow({ ...result.rows[0], question_count: count.rows[0].n }) };
    } catch (error) {
      if (error.code === "23505") throw app.jundeAuth.businessError("QUESTION_CATEGORY_CONFLICT", "分类名称已存在", 409);
      throw error;
    }
  });

  app.delete("/api/admin/question-categories/:id", async (request) => {
    const session = await requireQuestionnaireAdmin(request, true);
    const id = SecureUuidSchema.parse(request.params.id);
    const body = RevisionActionSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const category = await client.query("SELECT code, name, revision FROM question_categories WHERE id=$1 FOR UPDATE", [id]);
      if (!category.rows[0]) throw app.jundeAuth.businessError("QUESTION_CATEGORY_NOT_FOUND", "分类不存在", 404);
      if (Number(category.rows[0].revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      const referenced = await client.query("SELECT 1 FROM questions WHERE category=$1 LIMIT 1", [category.rows[0].code]);
      if (referenced.rows[0]) throw app.jundeAuth.businessError("QUESTION_CATEGORY_DELETE_NOT_ALLOWED", "该分类已被题目引用，无法删除，可改为停用", 409);
      await client.query("DELETE FROM question_categories WHERE id=$1", [id]);
      await writeAudit(client, session, "category_deleted", "category", id, { name: category.rows[0].name });
      return { deleted: true };
    });
  });

  app.get("/api/admin/questionnaire-versions", async (request) => {
    await requireQuestionnaireAdmin(request);
    const { cursor, limit } = CursorPageSchema.parse(request.query);
    const order = listOrder(request.query);
    const result = await pool.query(`${selectVersions} WHERE ($1::uuid IS NULL OR v.id ${order.op} $1) GROUP BY v.id,t.name ORDER BY v.id ${order.sql} LIMIT $2`, [cursor || null, limit + 1]);
    const items = result.rows.slice(0, limit).map(versionRow);
    return { items, nextCursor: result.rows.length > limit ? items.at(-1).id : null };
  });

  app.get("/api/admin/questionnaire-versions/:id", async (request) => {
    await requireQuestionnaireAdmin(request);
    const id = SecureUuidSchema.parse(request.params.id);
    const result = await pool.query(`${selectVersions} WHERE v.id=$1 GROUP BY v.id,t.name`, [id]);
    if (!result.rows[0]) throw app.jundeAuth.businessError("QUESTIONNAIRE_VERSION_NOT_FOUND", "问卷版本不存在", 404);
    return { version: versionRow(result.rows[0]) };
  });

  app.get("/api/admin/questionnaire-versions/:id/questions", async (request) => {
    await requireQuestionnaireAdmin(request);
    const id = SecureUuidSchema.parse(request.params.id);
    const result = await pool.query(questionsForVersion, [id]);
    return { items: result.rows.map(questionRow) };
  });

  app.patch("/api/admin/questionnaire-versions/:id/questions/:questionId", async (request) => {
    const session = await requireQuestionnaireAdmin(request, true);
    const versionId = SecureUuidSchema.parse(request.params.id);
    const questionId = SecureUuidSchema.parse(request.params.questionId);
    const body = QuestionPatchSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const version = await client.query("SELECT status FROM questionnaire_versions WHERE id=$1 FOR UPDATE", [versionId]);
      if (!version.rows[0]) throw app.jundeAuth.businessError("QUESTIONNAIRE_VERSION_NOT_FOUND", "问卷版本不存在", 404);
      if (version.rows[0].status !== "draft") throw app.jundeAuth.businessError("QUESTIONNAIRE_VERSION_FROZEN", "已发布版本不能修改", 409);
      const question = await client.query(`UPDATE questions SET revision=revision+1,updated_at=now(),
        text=COALESCE($2,text),max_score=COALESCE($3,max_score),enabled=COALESCE($6,enabled),is_score_wipe=COALESCE($7,is_score_wipe)
        WHERE id=$1 AND version_id=$4 AND revision=$5 RETURNING *`, [questionId, body.text ?? null, body.maxScore ?? null, versionId, body.revision, body.enabled ?? null, body.scoreWipe ?? null]);
      if (!question.rows[0]) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      // 启停会改变「启用题 1..M 连续」的编号归属，重排一次保持不变式。
      if (body.enabled !== undefined) {
        const rows = await orderedQuestionRows(client, versionId);
        await resequenceQuestions(client, versionId, rows.map((row) => row.id));
      }
      if (body.evidence) {
        await client.query(`INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count,image_max_count,audio_max_duration_seconds)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (question_id) DO UPDATE SET evidence_required=EXCLUDED.evidence_required,image_required=EXCLUDED.image_required,audio_required=EXCLUDED.audio_required,image_min_count=EXCLUDED.image_min_count,audio_min_count=EXCLUDED.audio_min_count,image_max_count=EXCLUDED.image_max_count,audio_max_duration_seconds=EXCLUDED.audio_max_duration_seconds`, [questionId, body.evidence.evidenceRequired, body.evidence.imageRequired, body.evidence.audioRequired, body.evidence.imageRequired ? 1 : 0, body.evidence.audioRequired ? 1 : 0, body.evidence.imageMaxCount, body.evidence.audioMaxDurationSeconds]);
      }
      await writeAudit(client, session, "question_updated", "question", questionId, { versionId, number: question.rows[0].question_number, enabled: body.enabled ?? question.rows[0].enabled, evidenceUpdated: Boolean(body.evidence) });
      const evidence = body.evidence || (await client.query("SELECT * FROM question_evidence_requirements WHERE question_id=$1", [questionId])).rows[0] || { evidence_required: false, image_required: false, audio_required: false, image_max_count: 3, audio_max_duration_seconds: 10 };
      return { question: questionRow({ ...question.rows[0], evidence_required: evidence.evidence_required, image_required: evidence.image_required, audio_required: evidence.audio_required, image_max_count: Number(evidence.image_max_count), audio_max_duration_seconds: Number(evidence.audio_max_duration_seconds) }) };
    });
  });

  // 题目结构变更（新增/删除/移动/启停）的通用收尾。题号派生规则：启用题按展示顺序编号 1..M，
  // 停用题排在其后继续编号——保证「启用题号 1..M 连续」这一发布校验与小程序缺号检测依赖的不变式。
  // question_number 受 (version_id, question_number) 唯一约束，先整体加偏移量腾挪，再一次性写回目标值；question_key 保持不变。
  const resequenceQuestions = async (client, versionId, orderedIds) => {
    const enabledIds = new Set((await client.query("SELECT id FROM questions WHERE version_id=$1 AND enabled", [versionId])).rows.map((row) => row.id));
    const ordered = [...orderedIds.filter((id) => enabledIds.has(id)), ...orderedIds.filter((id) => !enabledIds.has(id))];
    await client.query("UPDATE questions SET question_number=question_number+1000000 WHERE version_id=$1", [versionId]);
    if (!ordered.length) return;
    const displayIndex = new Map(orderedIds.map((id, index) => [id, index + 1]));
    const values = ordered.map((_, index) => `($${index * 3 + 1}::uuid,$${index * 3 + 2}::int,$${index * 3 + 3}::int)`).join(",");
    await client.query(`UPDATE questions q SET sort_order=v.display_index,question_number=v.question_number,updated_at=now()
      FROM (VALUES ${values}) AS v(id,display_index,question_number) WHERE q.id=v.id`, ordered.flatMap((id, index) => [id, displayIndex.get(id), index + 1]));
  };
  const orderedQuestionRows = async (client, versionId) => (await client.query("SELECT id,category,enabled,revision FROM questions WHERE version_id=$1 ORDER BY sort_order,id", [versionId])).rows;

  app.post("/api/admin/questionnaire-versions/:id/questions", async (request, reply) => {
    const session = await requireQuestionnaireAdmin(request, true);
    const versionId = SecureUuidSchema.parse(request.params.id);
    const body = QuestionCreateSchema.parse(request.body);
    const questionId = uuidv7();
    await app.jundeAuth.transaction(async (client) => {
      const version = await client.query("SELECT status FROM questionnaire_versions WHERE id=$1 FOR UPDATE", [versionId]);
      if (!version.rows[0]) throw app.jundeAuth.businessError("QUESTIONNAIRE_VERSION_NOT_FOUND", "问卷版本不存在", 404);
      if (version.rows[0].status !== "draft") throw app.jundeAuth.businessError("QUESTIONNAIRE_VERSION_FROZEN", "已发布版本不能修改", 409);
      const activeCategory = await client.query("SELECT 1 FROM question_categories WHERE code=$1 AND active", [body.category]);
      if (!activeCategory.rows[0]) throw app.jundeAuth.businessError("QUESTION_CATEGORY_INVALID", "题目分类无效或已停用，请重新选择", 422);
      const nextOrder = await client.query("SELECT COALESCE(max(sort_order),0)+1 next_order FROM questions WHERE version_id=$1", [versionId]);
      await client.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,risk_level,enabled,is_score_wipe,sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10)`,
        [questionId, versionId, `q_${randomUUID().replaceAll("-", "").slice(0, 12)}`, Number(nextOrder.rows[0].next_order), body.category, body.text, body.maxScore, body.riskLevel || "normal", Boolean(body.scoreWipe), Number(nextOrder.rows[0].next_order)]);
      if (body.evidence) {
        await client.query(`INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count,image_max_count,audio_max_duration_seconds)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [questionId, body.evidence.evidenceRequired, body.evidence.imageRequired, body.evidence.audioRequired, body.evidence.imageRequired ? 1 : 0, body.evidence.audioRequired ? 1 : 0, body.evidence.imageMaxCount, body.evidence.audioMaxDurationSeconds]);
      }
      // 新题插入到同分类最后一题之后；该分类还没有题时排到全局末尾。
      // 新题此刻已在表里（挂在全局末尾），构造展示顺序时必须先剔除它，避免重复出现。
      const others = (await orderedQuestionRows(client, versionId)).filter((row) => row.id !== questionId);
      const orderedIds = others.map((row) => row.id);
      const lastSameCategory = others.map((row) => row.category).lastIndexOf(body.category);
      orderedIds.splice(lastSameCategory === -1 ? orderedIds.length : lastSameCategory + 1, 0, questionId);
      await resequenceQuestions(client, versionId, orderedIds);
      await writeAudit(client, session, "question_created", "question", questionId, { versionId, category: body.category, maxScore: body.maxScore });
    });
    const saved = await pool.query(questionsForVersion, [versionId]);
    return reply.code(201).send({ question: questionRow(saved.rows.find((row) => row.id === questionId)) });
  });

  app.delete("/api/admin/questionnaire-versions/:id/questions/:questionId", async (request) => {
    const session = await requireQuestionnaireAdmin(request, true);
    const versionId = SecureUuidSchema.parse(request.params.id);
    const questionId = SecureUuidSchema.parse(request.params.questionId);
    const body = QuestionDeleteSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const version = await client.query("SELECT status FROM questionnaire_versions WHERE id=$1 FOR UPDATE", [versionId]);
      if (!version.rows[0]) throw app.jundeAuth.businessError("QUESTIONNAIRE_VERSION_NOT_FOUND", "问卷版本不存在", 404);
      if (version.rows[0].status !== "draft") throw app.jundeAuth.businessError("QUESTIONNAIRE_VERSION_FROZEN", "已发布版本不能修改", 409);
      const question = await client.query("SELECT revision FROM questions WHERE id=$1 AND version_id=$2 FOR UPDATE", [questionId, versionId]);
      if (!question.rows[0]) throw app.jundeAuth.businessError("QUESTION_NOT_FOUND", "题目不存在", 404);
      if (Number(question.rows[0].revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      try {
        await client.query("DELETE FROM questions WHERE id=$1", [questionId]);
      } catch (error) {
        // 已有作答或证据附件引用（ON DELETE RESTRICT）时拒绝物理删除，引导管理员改为停用。
        if (error.code === "23503") throw app.jundeAuth.businessError("QUESTION_DELETE_NOT_ALLOWED", "该题目已有作答或证据记录，无法删除，可改为停用", 409);
        throw error;
      }
      const rows = await orderedQuestionRows(client, versionId);
      await resequenceQuestions(client, versionId, rows.map((row) => row.id));
      await writeAudit(client, session, "question_deleted", "question", questionId, { versionId });
      return { deleted: true };
    });
  });

  app.post("/api/admin/questionnaire-versions/:id/questions/:questionId/move", async (request) => {
    const session = await requireQuestionnaireAdmin(request, true);
    const versionId = SecureUuidSchema.parse(request.params.id);
    const questionId = SecureUuidSchema.parse(request.params.questionId);
    const body = QuestionMoveSchema.parse(request.body);
    const moved = await app.jundeAuth.transaction(async (client) => {
      const version = await client.query("SELECT status FROM questionnaire_versions WHERE id=$1 FOR UPDATE", [versionId]);
      if (!version.rows[0]) throw app.jundeAuth.businessError("QUESTIONNAIRE_VERSION_NOT_FOUND", "问卷版本不存在", 404);
      if (version.rows[0].status !== "draft") throw app.jundeAuth.businessError("QUESTIONNAIRE_VERSION_FROZEN", "已发布版本不能修改", 409);
      const rows = await orderedQuestionRows(client, versionId);
      const from = rows.findIndex((row) => row.id === questionId);
      if (from === -1) throw app.jundeAuth.businessError("QUESTION_NOT_FOUND", "题目不存在", 404);
      if (Number(rows[from].revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      // 移动仅在同分类且同启停状态的题内生效：与上/下相邻题交换展示位置；已在边界时原样返回。
      const step = body.direction === "up" ? -1 : 1;
      let to = -1;
      for (let index = from + step; index >= 0 && index < rows.length; index += step) {
        if (rows[index].category === rows[from].category && rows[index].enabled === rows[from].enabled) { to = index; break; }
      }
      if (to !== -1) {
        // 移动语义：把题目从原位取出、插到同分类邻题的位置，中间的题顺次平移。
        const reordered = rows.map((row) => row.id);
        const [movedId] = reordered.splice(from, 1);
        reordered.splice(to, 0, movedId);
        await resequenceQuestions(client, versionId, reordered);
        await client.query("UPDATE questions SET revision=revision+1,updated_at=now() WHERE id = ANY($1)", [[questionId, rows[to].id]]);
      }
      await writeAudit(client, session, "question_moved", "question", questionId, { versionId, direction: body.direction });
      const all = await client.query(questionsForVersion, [versionId]);
      return questionRow(all.rows.find((row) => row.id === questionId));
    });
    return { question: moved };
  });

  app.post("/api/admin/questionnaire-versions", async (request, reply) => {
    const session = await requireQuestionnaireAdmin(request, true);
    const body = QuestionnaireVersionCreateSchema.parse(request.body);
    // 动态分类校验：题目分类必须引用启用中的分类（FK 之外的语义校验）
    const activeCodes = await pool.query("SELECT code FROM question_categories WHERE active");
    const activeSet = new Set(activeCodes.rows.map((row) => row.code));
    const invalidCategory = body.questions.find((question) => !activeSet.has(question.category));
    if (invalidCategory) throw app.jundeAuth.businessError("QUESTION_CATEGORY_INVALID", "题目分类无效或已停用，请重新选择", 422, { details: { questionNumber: invalidCategory.number } });
    const templateId = uuidv7();
    const versionId = uuidv7();
    await app.jundeAuth.transaction(async (client) => {
      await client.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,$2,'secret',$3)", [templateId, body.name, session.user_id]);
      await client.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by) VALUES ($1,$2,1,'draft',$3)", [versionId, templateId, session.user_id]);
      for (const question of body.questions) {
        const questionId = uuidv7();
        await client.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,risk_level,enabled,is_score_wipe,sort_order)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10)`,
          [questionId, versionId, `q${question.number}`, question.number, question.category, question.text, question.maxScore, question.riskLevel || "normal", Boolean(question.scoreWipe), question.number]);
        if (question.evidence) {
          await client.query(`INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count,image_max_count,audio_max_duration_seconds)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [questionId, question.evidence.evidenceRequired, question.evidence.imageRequired, question.evidence.audioRequired, question.evidence.imageRequired ? 1 : 0, question.evidence.audioRequired ? 1 : 0, question.evidence.imageMaxCount, question.evidence.audioMaxDurationSeconds]);
        }
      }
      await writeAudit(client, session, "questionnaire_version_created", "questionnaire_version", versionId, { name: body.name, questionCount: body.questions.length });
    });
    return reply.code(201).send({ version: { id: versionId, templateId, name: body.name, versionLabel: "V1", status: "draft", revision: 0, questionCount: body.questions.length } });
  });

  app.post("/api/admin/questionnaire-versions/:id/publish", async (request) => {
    const session = await requireQuestionnaireAdmin(request, true);
    const versionId = SecureUuidSchema.parse(request.params.id);
    const body = RevisionActionSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const version = await client.query("SELECT * FROM questionnaire_versions WHERE id=$1 FOR UPDATE", [versionId]);
      if (!version.rows[0]) throw app.jundeAuth.businessError("QUESTIONNAIRE_VERSION_NOT_FOUND", "问卷版本不存在", 404);
      if (version.rows[0].status !== "draft" || Number(version.rows[0].revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      const questions = await client.query(questionsForVersion, [versionId]);
      const activeCodes = await client.query("SELECT code FROM question_categories WHERE active");
      const check = publishCheck(questions.rows, new Set(activeCodes.rows.map((row) => row.code)));
      if (!check.valid) throw app.jundeAuth.businessError("QUESTIONNAIRE_PUBLISH_GUARD", `问卷版本尚未满足发布条件${check.scoreWipeConflicts.length ? `；${check.scoreWipeConflicts.join("、")} 已有多道分数清零题` : ""}`, 422, { details: check });
      const published = await client.query("UPDATE questionnaire_versions SET status='published',published_at=now(),published_by=$2,effective_at=now(),revision=revision+1 WHERE id=$1 RETURNING *", [versionId, session.user_id]);
      await writeAudit(client, session, "questionnaire_version_published", "questionnaire_version", versionId, { versionNumber: Number(version.rows[0].version_number), questionCount: questions.rows.length });
      return { version: { id: published.rows[0].id, status: published.rows[0].status, revision: Number(published.rows[0].revision) } };
    });
  });

  app.delete("/api/admin/questionnaire-versions/:id", async (request) => {
    const session = await requireQuestionnaireAdmin(request, true);
    const versionId = SecureUuidSchema.parse(request.params.id);
    const body = RevisionActionSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const version = await client.query("SELECT * FROM questionnaire_versions WHERE id=$1 FOR UPDATE", [versionId]);
      if (!version.rows[0]) throw app.jundeAuth.businessError("QUESTIONNAIRE_VERSION_NOT_FOUND", "问卷版本不存在", 404);
      if (Number(version.rows[0].revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      if (version.rows[0].status !== "draft") throw app.jundeAuth.businessError("QUESTIONNAIRE_DELETE_NOT_ALLOWED", "已发布版本不能删除，请复制为新草稿后废弃", 409);
      const referenced = await client.query("SELECT 1 FROM audit_assignments WHERE questionnaire_version_id=$1 LIMIT 1", [versionId]);
      if (referenced.rows[0]) throw app.jundeAuth.businessError("QUESTIONNAIRE_DELETE_NOT_ALLOWED", "该问卷版本已被指派使用，无法删除", 409);
      const copiedFrom = await client.query("SELECT 1 FROM questionnaire_versions WHERE source_version_id=$1 LIMIT 1", [versionId]);
      if (copiedFrom.rows[0]) throw app.jundeAuth.businessError("QUESTIONNAIRE_DELETE_NOT_ALLOWED", "已有版本从该草稿复制而来，无法删除", 409);
      try {
        await client.query("DELETE FROM questionnaire_versions WHERE id=$1", [versionId]);
      } catch (error) {
        if (error.code === "23503") throw app.jundeAuth.businessError("QUESTIONNAIRE_DELETE_NOT_ALLOWED", "该问卷版本已被业务数据引用，无法删除", 409);
        throw error;
      }
      await writeAudit(client, session, "questionnaire_version_deleted", "questionnaire_version", versionId, { versionNumber: Number(version.rows[0].version_number) });
      return { deleted: true };
    });
  });

  app.post("/api/admin/questionnaire-versions/:id/copy", async (request, reply) => {
    const session = await requireQuestionnaireAdmin(request, true);
    const sourceId = SecureUuidSchema.parse(request.params.id);
    const copied = await app.jundeAuth.transaction(async (client) => {
      const source = await client.query(`SELECT v.*,t.name,t.mode FROM questionnaire_versions v JOIN questionnaire_templates t ON t.id=v.template_id WHERE v.id=$1 FOR UPDATE`, [sourceId]);
      if (!source.rows[0] || source.rows[0].status !== "published") throw app.jundeAuth.businessError("QUESTIONNAIRE_COPY_NOT_ALLOWED", "只能复制已发布版本", 409);
      const nextVersion = await client.query("SELECT COALESCE(max(version_number),0)+1 version_number FROM questionnaire_versions WHERE template_id=$1", [source.rows[0].template_id]);
      const id = uuidv7();
      await client.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,source_version_id,created_by) VALUES ($1,$2,$3,'draft',$4,$5)", [id, source.rows[0].template_id, nextVersion.rows[0].version_number, sourceId, session.user_id]);
      const questions = await client.query(questionsForVersion, [sourceId]);
      for (const sourceQuestion of questions.rows) {
        const questionId = uuidv7();
        await client.query("INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,risk_level,enabled,is_score_wipe,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [questionId, id, sourceQuestion.question_key, sourceQuestion.question_number, sourceQuestion.category, sourceQuestion.text, sourceQuestion.max_score, sourceQuestion.risk_level, sourceQuestion.enabled, sourceQuestion.is_score_wipe, sourceQuestion.sort_order]);
        await client.query("INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count) VALUES ($1,$2,$3,$4,$5,$6)", [questionId, sourceQuestion.evidence_required, sourceQuestion.image_required, sourceQuestion.audio_required, sourceQuestion.image_required ? 1 : 0, sourceQuestion.audio_required ? 1 : 0]);
      }
      await writeAudit(client, session, "questionnaire_version_copied", "questionnaire_version", id, { sourceVersionId: sourceId, name: source.rows[0].name, versionLabel: `V${nextVersion.rows[0].version_number}` });
      return { id, status: "draft", versionLabel: `V${nextVersion.rows[0].version_number}` };
    });
    return reply.code(201).send({ version: copied });
  });

  // JOIN regions r 仅用于范围过滤（storeScopeFilter 引用 r 的三层子树）；不产生额外列，结果集不变
  const campaignSelect = `SELECT c.*,s.name store_name,s.location_verified_at store_location_verified_at,
    count(a.id) assignment_count,count(a.id) FILTER (WHERE a.status='overdue') overdue_count
    FROM audit_campaigns c JOIN stores s ON s.id=c.store_id JOIN regions r ON r.id=s.region_id LEFT JOIN audit_assignments a ON a.campaign_id=c.id`;
  const campaignById = async (client, id, lock = false) => {
    const query = lock
      ? "SELECT c.*,s.name store_name,s.location_verified_at store_location_verified_at FROM audit_campaigns c JOIN stores s ON s.id=c.store_id WHERE c.id=$1 FOR UPDATE OF c"
      : `${campaignSelect} WHERE c.id=$1 GROUP BY c.id,s.name,s.location_verified_at`;
    const result = await client.query(query, [id]);
    return result.rows[0] || null;
  };
  const assignmentResult = (assignment) => ({ id: assignment.id, revision: Number(assignment.revision), status: assignment.status });

  app.get("/api/admin/campaigns", async (request) => {
    const session = await requireCampaignAdmin(request);
    const { cursor, limit } = CursorPageSchema.parse(request.query);
    const order = listOrder(request.query);
    const conditions = [`($1::uuid IS NULL OR c.id${order.op}$1)`];
    const params = [cursor || null, limit + 1];
    // 范围受限管理员：campaign→store→region 静默过滤
    if (!hasFullScope(session.scopes)) { params.push(session.user_id); conditions.push(storeScopeFilter({ scopes: session.scopes, storeAlias: "s", regionAlias: "r", userParam: `$${params.length}` })); }
    const result = await pool.query(`${campaignSelect} WHERE ${conditions.join(" AND ")} GROUP BY c.id,s.name,s.location_verified_at ORDER BY c.id ${order.sql} LIMIT $2`, params);
    const items = result.rows.slice(0, limit).map(campaignRow);
    return { items, nextCursor: result.rows.length > limit ? items.at(-1).id : null };
  });

  app.post("/api/admin/campaigns", async (request, reply) => {
    const session = await requireCampaignAdmin(request, true);
    const body = CampaignWriteSchema.parse(request.body);
    // 范围受限管理员：目标门店必须在覆盖范围内；门店不存在同样由 assertStoreCovered 先抛 403 SCOPE_FORBIDDEN（防探测），存在但范围外 403
    if (!hasFullScope(session.scopes)) await assertStoreCovered(pool, session.scopes, body.storeId, scopeForbidden);
    const id = uuidv7();
    try {
      const store = await pool.query("SELECT name,active FROM stores WHERE id=$1", [body.storeId]);
      if (!store.rows[0] || !store.rows[0].active) throw app.jundeAuth.businessError("STORE_NOT_AVAILABLE", "门店当前不可用于创建任务", 422);
      const created = await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,common_instruction,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9) RETURNING *", [id, `C-${id.replaceAll("-", "").slice(-10).toUpperCase()}`, body.name, body.storeId, body.startsAt, body.dueAt, body.questionnaireDeadlineAt, body.commonInstruction, session.user_id]);
      await writeAudit(pool, session, "campaign_created", "campaign", id, { name: body.name, storeName: store.rows[0].name, startsAt: body.startsAt, dueAt: body.dueAt });
      return reply.code(201).send({ campaign: campaignRow({ ...created.rows[0], store_name: store.rows[0].name, assignment_count: 0, overdue_count: 0 }) });
    } catch (error) {
      if (error.code === "23503") throw app.jundeAuth.businessError("STORE_NOT_AVAILABLE", "门店当前不可用于创建任务", 422);
      throw error;
    }
  });

  app.get("/api/admin/campaigns/:id", async (request) => {
    const session = await requireCampaignAdmin(request);
    const id = SecureUuidSchema.parse(request.params.id);
    const campaign = await campaignById(pool, id);
    if (!campaign) throw app.jundeAuth.businessError("CAMPAIGN_NOT_FOUND", "探店任务不存在", 404);
    // 先存在性（404）后范围（403）
    if (!hasFullScope(session.scopes)) await assertStoreCovered(pool, session.scopes, campaign.store_id, scopeForbidden);
    const assignments = await pool.query(`SELECT a.*,u.display_name inspector_name,v.version_number,t.name questionnaire_name,e.id active_exemption_id,e.revision active_exemption_revision
      FROM audit_assignments a JOIN users u ON u.id=a.inspector_id JOIN questionnaire_versions v ON v.id=a.questionnaire_version_id JOIN questionnaire_templates t ON t.id=v.template_id
      LEFT JOIN checkin_exemptions e ON e.assignment_id=a.id AND e.status='active' WHERE a.campaign_id=$1 ORDER BY a.id`, [id]);
    const requirements = await pool.query("SELECT * FROM assignment_dish_requirements WHERE assignment_id = ANY($1::uuid[]) ORDER BY sort_order", [assignments.rows.map((item) => item.id)]);
    const byAssignment = new Map();
    for (const item of requirements.rows) byAssignment.set(item.assignment_id, [...(byAssignment.get(item.assignment_id) || []), { id: item.id, recordId: item.id, plannedName: item.planned_name, quantity: item.quantity, required: item.required, allowSubstitution: item.allow_substitution }]);
    return {
      ...campaignRow(campaign), storeId: campaign.store_id, commonInstruction: campaign.common_instruction, locationVerified: Boolean(campaign.store_location_verified_at),
      assignments: assignments.rows.map((item) => ({ id: item.id, inspectorId: item.inspector_id, inspectorName: item.inspector_name, questionnaireVersionId: item.questionnaire_version_id, questionnaireName: `${item.questionnaire_name} · V${item.version_number}`, taskType: item.task_type, startsAt: item.starts_at.toISOString(), dueAt: item.due_at.toISOString(), questionnaireDeadlineAt: item.questionnaire_deadline_at ? item.questionnaire_deadline_at.toISOString() : null, budgetLimit: item.budget_limit_cents / 100, receiptRequired: item.receipt_required, specialInstruction: item.special_instruction, dishRequirements: byAssignment.get(item.id) || [], status: item.status, revision: Number(item.revision), activeExemption: item.active_exemption_id ? { id: item.active_exemption_id, revision: Number(item.active_exemption_revision) } : null })),
    };
  });

  app.patch("/api/admin/campaigns/:id", async (request) => {
    const session = await requireCampaignAdmin(request, true);
    const id = SecureUuidSchema.parse(request.params.id);
    const body = CampaignWriteSchema.parse(request.body);
    if (body.revision === undefined) throw app.jundeAuth.businessError("REVISION_REQUIRED", "内容已更新，请刷新后重试", 422);
    return app.jundeAuth.transaction(async (client) => {
      const campaign = await campaignById(client, id, true);
      if (!campaign) throw app.jundeAuth.businessError("CAMPAIGN_NOT_FOUND", "探店任务不存在", 404);
      if (!hasFullScope(session.scopes)) await assertStoreCovered(client, session.scopes, campaign.store_id, scopeForbidden);
      if (campaign.status !== "draft" || Number(campaign.revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      const store = await client.query("SELECT name,active FROM stores WHERE id=$1", [body.storeId]);
      if (!store.rows[0] || !store.rows[0].active) throw app.jundeAuth.businessError("STORE_NOT_AVAILABLE", "门店当前不可用于创建任务", 422);
      const result = await client.query("UPDATE audit_campaigns SET name=$2,store_id=$3,starts_at=$4,due_at=$5,questionnaire_deadline_at=$6,common_instruction=$7,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *", [id, body.name, body.storeId, body.startsAt, body.dueAt, body.questionnaireDeadlineAt, body.commonInstruction]);
      await writeAudit(client, session, "campaign_updated", "campaign", id, { name: body.name, storeName: store.rows[0].name });
      return { campaign: campaignRow({ ...result.rows[0], store_name: store.rows[0].name, assignment_count: campaign.assignment_count, overdue_count: campaign.overdue_count }) };
    });
  });

  app.post("/api/admin/campaigns/:id/assignments", async (request, reply) => {
    const session = await requireCampaignAdmin(request, true);
    const campaignId = SecureUuidSchema.parse(request.params.id);
    const body = AssignmentUpsertSchema.parse(request.body);
    const budgetLimitCents = centsFor(body.budgetLimit);
    const assignment = await app.jundeAuth.transaction(async (client) => {
      const campaign = await campaignById(client, campaignId, true);
      if (!campaign) throw app.jundeAuth.businessError("CAMPAIGN_NOT_FOUND", "探店任务不存在", 404);
      if (!hasFullScope(session.scopes)) await assertStoreCovered(client, session.scopes, campaign.store_id, scopeForbidden);
      if (campaign.status !== "draft" || Number(campaign.revision) !== body.campaignRevision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      if (new Date(body.startsAt) < campaign.starts_at || new Date(body.dueAt) > campaign.due_at) throw app.jundeAuth.businessError("ASSIGNMENT_WINDOW_INVALID", "个人执行时间必须在探店任务的时间范围内", 422);
      const inspector = await client.query("SELECT id,display_name FROM users WHERE id=$1 AND status='approved_active' AND phone_verified_at IS NOT NULL", [body.inspectorId]);
      const version = await client.query("SELECT id FROM questionnaire_versions WHERE id=$1", [body.questionnaireVersionId]);
      if (!inspector.rows[0] || !version.rows[0]) throw app.jundeAuth.businessError("ASSIGNMENT_REFERENCE_INVALID", "探店员或问卷版本不可用", 422);
      const id = uuidv7();
      try {
        const inserted = await client.query("INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,questionnaire_deadline_at,budget_limit_cents,receipt_required,special_instruction,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13) RETURNING *", [id, `A-${id.replaceAll("-", "").slice(-10).toUpperCase()}`, campaignId, body.inspectorId, body.questionnaireVersionId, body.taskType, body.startsAt, body.dueAt, campaign.questionnaire_deadline_at, budgetLimitCents, body.receiptRequired, body.specialInstruction, session.user_id]);
        await client.query("UPDATE audit_campaigns SET revision=revision+1,updated_at=now() WHERE id=$1", [campaignId]);
        await writeAudit(client, session, "assignment_created", "assignment", id, { campaignId, campaignName: campaign.name, inspectorName: inspector.rows[0].display_name, taskType: body.taskType, startsAt: body.startsAt, dueAt: body.dueAt });
        return assignmentResult(inserted.rows[0]);
      } catch (error) {
        if (error.code === "23505") throw app.jundeAuth.businessError("ASSIGNMENT_CONFLICT", "该探店员已在探店任务中被指派", 409);
        throw error;
      }
    });
    return reply.code(201).send(assignment);
  });

  // 指派存在性（404）与范围校验（403）的共享入口：JOIN campaign 带出 store_id 供覆盖断言
  const assignmentReference = async (session, assignmentId) => {
    const reference = await pool.query(`SELECT a.campaign_id, c.store_id FROM audit_assignments a
      JOIN audit_campaigns c ON c.id = a.campaign_id WHERE a.id=$1`, [assignmentId]);
    if (!reference.rows[0]) throw app.jundeAuth.businessError("ASSIGNMENT_NOT_FOUND", "指派不存在", 404);
    if (!hasFullScope(session.scopes)) await assertStoreCovered(pool, session.scopes, reference.rows[0].store_id, scopeForbidden);
    return reference.rows[0];
  };
  const campaignStatusForAssignments = (assignments) => assignments.every((assignment) => ["submitted", "cancelled"].includes(assignment.status)) ? "completed"
    : assignments.every((assignment) => assignment.status === "assigned") ? "published" : "in_progress";
  const persistCampaignAggregate = async (client, campaign, assignments) => {
    const status = campaignStatusForAssignments(assignments);
    const result = await client.query("UPDATE audit_campaigns SET status=$2,completed_at=CASE WHEN $2='completed' THEN now() ELSE completed_at END,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *", [campaign.id, status]);
    return result.rows[0];
  };
  const revisionMatches = (record, revision) => Number(record.revision) === revision || (record.overdueAdvanced && Number(record.revision) - 1 === revision);

  app.patch("/api/admin/assignments/:id", async (request) => {
    const session = await requireCampaignAdmin(request, true);
    const assignmentId = SecureUuidSchema.parse(request.params.id);
    const body = AssignmentUpsertSchema.parse(request.body);
    const reference = await assignmentReference(session, assignmentId);
    const budgetLimitCents = centsFor(body.budgetLimit);
    return app.jundeAuth.transaction(async (client) => {
      const state = await advanceCampaignOverdue(client, reference.campaign_id);
      const assignment = state.assignments.find((item) => item.id === assignmentId);
      if (!assignment || Number(assignment.revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      if (!["draft", "assigned"].includes(assignment.status)) throw app.jundeAuth.businessError("ASSIGNMENT_NOT_EDITABLE", "当前任务不能修改", 409);
      if (new Date(body.startsAt) < state.campaign.starts_at || new Date(body.dueAt) > state.campaign.due_at) throw app.jundeAuth.businessError("ASSIGNMENT_WINDOW_INVALID", "个人执行时间必须在探店任务的时间范围内", 422);
      if (assignment.status === "assigned") {
        if (new Date(assignment.starts_at) <= new Date() || assignment.inspector_id !== body.inspectorId || assignment.questionnaire_version_id !== body.questionnaireVersionId || assignment.task_type !== body.taskType) throw app.jundeAuth.businessError("ASSIGNMENT_NOT_EDITABLE", "已发布任务只能在开始前调整执行要求", 409);
      } else {
        const inspector = await client.query("SELECT id FROM users WHERE id=$1 AND status='approved_active' AND phone_verified_at IS NOT NULL", [body.inspectorId]);
        const version = await client.query("SELECT id FROM questionnaire_versions WHERE id=$1", [body.questionnaireVersionId]);
        if (!inspector.rows[0] || !version.rows[0]) throw app.jundeAuth.businessError("ASSIGNMENT_REFERENCE_INVALID", "探店员或问卷版本不可用", 422);
      }
      const updated = await client.query(`UPDATE audit_assignments SET inspector_id=$2,questionnaire_version_id=$3,task_type=$4,starts_at=$5,due_at=$6,budget_limit_cents=$7,receipt_required=$8,special_instruction=$9,revision=revision+1,updated_at=now()
        WHERE id=$1 RETURNING *`, [assignmentId, body.inspectorId, body.questionnaireVersionId, body.taskType, body.startsAt, body.dueAt, budgetLimitCents, body.receiptRequired, body.specialInstruction]);
      await client.query("UPDATE audit_campaigns SET revision=revision+1,updated_at=now() WHERE id=$1", [reference.campaign_id]);
      await writeAudit(client, session, "assignment_updated", "assignment", assignmentId, { campaignId: reference.campaign_id, taskType: body.taskType, startsAt: body.startsAt, dueAt: body.dueAt, budgetLimit: body.budgetLimit, receiptRequired: body.receiptRequired });
      return assignmentResult(updated.rows[0]);
    });
  });

  app.delete("/api/admin/assignments/:id", async (request) => {
    const session = await requireCampaignAdmin(request, true);
    const assignmentId = SecureUuidSchema.parse(request.params.id);
    const body = RevisionActionSchema.parse(request.body);
    const reference = await assignmentReference(session, assignmentId);
    return app.jundeAuth.transaction(async (client) => {
      const state = await advanceCampaignOverdue(client, reference.campaign_id);
      const assignment = state.assignments.find((item) => item.id === assignmentId);
      if (!assignment || assignment.status !== "draft" || Number(assignment.revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      const references = await client.query("SELECT 1 FROM audit_checkins WHERE assignment_id=$1 LIMIT 1", [assignmentId]);
      if (references.rows[0]) throw app.jundeAuth.businessError("ASSIGNMENT_DELETE_NOT_ALLOWED", "已有外部记录的指派不能删除", 409);
      await client.query("DELETE FROM assignment_dish_requirements WHERE assignment_id=$1", [assignmentId]);
      await client.query("DELETE FROM audit_assignments WHERE id=$1", [assignmentId]);
      await client.query("UPDATE audit_campaigns SET revision=revision+1,updated_at=now() WHERE id=$1", [reference.campaign_id]);
      await writeAudit(client, session, "assignment_deleted", "assignment", assignmentId, { campaignId: reference.campaign_id, businessNo: assignment.business_no });
      return { deleted: true };
    });
  });

  app.put("/api/admin/assignments/:id/dish-requirements", async (request) => {
    const session = await requireCampaignAdmin(request, true);
    const assignmentId = SecureUuidSchema.parse(request.params.id);
    const body = DishRequirementsReplaceSchema.parse(request.body);
    const campaignRef = await assignmentReference(session, assignmentId);
    return app.jundeAuth.transaction(async (client) => {
      const campaign = await campaignById(client, campaignRef.campaign_id, true);
      const assignment = await client.query("SELECT * FROM audit_assignments WHERE id=$1 FOR UPDATE", [assignmentId]);
      if (!assignment.rows[0] || !["draft", "assigned"].includes(assignment.rows[0].status) || Number(assignment.rows[0].revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      await client.query("DELETE FROM assignment_dish_requirements WHERE assignment_id=$1", [assignmentId]);
      for (const [index, item] of body.items.entries()) await client.query("INSERT INTO assignment_dish_requirements (id,assignment_id,planned_name,quantity,required,allow_substitution,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)", [uuidv7(), assignmentId, item.plannedName, item.quantity, item.required, item.allowSubstitution, index + 1]);
      const result = await client.query("UPDATE audit_assignments SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *", [assignmentId]);
      await writeAudit(client, session, "assignment_updated", "assignment", assignmentId, { campaignId: campaignRef.campaign_id, dishesCount: body.items.length, dishNames: body.items.map((item) => item.plannedName) });
      return assignmentResult(result.rows[0]);
    });
  });

  app.post("/api/admin/campaigns/:id/publish", async (request) => {
    const session = await requireCampaignAdmin(request, true);
    const campaignId = SecureUuidSchema.parse(request.params.id);
    const body = RevisionActionSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const campaign = await campaignById(client, campaignId, true);
      if (!campaign) throw app.jundeAuth.businessError("CAMPAIGN_NOT_FOUND", "探店任务不存在", 404);
      if (!hasFullScope(session.scopes)) await assertStoreCovered(client, session.scopes, campaign.store_id, scopeForbidden);
      if (campaign.status !== "draft" || Number(campaign.revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      const store = await client.query("SELECT active,location_verified_at FROM stores WHERE id=$1", [campaign.store_id]);
      const assignments = await client.query("SELECT a.*,u.status user_status,u.phone_verified_at,v.status version_status FROM audit_assignments a JOIN users u ON u.id=a.inspector_id JOIN questionnaire_versions v ON v.id=a.questionnaire_version_id WHERE a.campaign_id=$1 ORDER BY a.id FOR UPDATE", [campaignId]);
      if (!store.rows[0]?.active || !store.rows[0]?.location_verified_at || assignments.rows.length === 0 || assignments.rows.length > config.MAX_ASSIGNMENTS_PER_CAMPAIGN) {
        const reasons = [];
        if (!store.rows[0]?.active) reasons.push("门店已停用");
        if (!store.rows[0]?.location_verified_at) reasons.push("门店位置未校准");
        if (assignments.rows.length === 0) reasons.push("尚未添加任何探店员分配");
        if (assignments.rows.length > config.MAX_ASSIGNMENTS_PER_CAMPAIGN) reasons.push(`指派数量超过上限（${config.MAX_ASSIGNMENTS_PER_CAMPAIGN} 条）`);
        throw app.jundeAuth.businessError("CAMPAIGN_PUBLISH_GUARD", `探店任务尚未满足发布条件：${reasons.join("、")}`, 422);
      }
      for (const assignment of assignments.rows) {
        const issues = [];
        if (assignment.task_type !== "secret") issues.push(`指派 ${assignment.business_no} 为明察任务（发布仅支持暗访）`);
        if (assignment.user_status !== "approved_active") issues.push(`指派 ${assignment.business_no} 的探店员账号未启用`);
        if (!assignment.phone_verified_at) issues.push(`指派 ${assignment.business_no} 的探店员手机未验证`);
        if (assignment.version_status !== "published") issues.push(`指派 ${assignment.business_no} 的问卷版本未发布`);
        if (assignment.starts_at < campaign.starts_at) issues.push(`指派 ${assignment.business_no} 的开始时间早于任务`);
        if (assignment.due_at > campaign.due_at) issues.push(`指派 ${assignment.business_no} 的截止时间晚于任务`);
        if (issues.length) throw app.jundeAuth.businessError("CAMPAIGN_PUBLISH_GUARD", `探店任务尚未满足发布条件：${issues.join("、")}`, 422);
      }
      await client.query("UPDATE audit_assignments SET status='assigned',assigned_at=now(),assigned_by=$2,revision=revision+1,updated_at=now() WHERE campaign_id=$1", [campaignId, session.user_id]);
      const result = await client.query("UPDATE audit_campaigns SET status='published',published_at=now(),published_by=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *", [campaignId, session.user_id]);
      await writeAudit(client, session, "campaign_published", "campaign", campaignId, { name: campaign.name, storeName: campaign.store_name, assignmentCount: assignments.rows.length });
      return { campaign: campaignRow({ ...result.rows[0], store_name: campaign.store_name, assignment_count: assignments.rows.length, overdue_count: 0 }) };
    });
  });

  app.delete("/api/admin/campaigns/:id", async (request) => {
    const session = await requireCampaignAdmin(request, true);
    const campaignId = SecureUuidSchema.parse(request.params.id);
    const body = RevisionActionSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const campaign = await client.query("SELECT status,name,revision,store_id FROM audit_campaigns WHERE id=$1 FOR UPDATE", [campaignId]);
      if (!campaign.rows[0]) throw app.jundeAuth.businessError("CAMPAIGN_NOT_FOUND", "探店任务不存在", 404);
      if (!hasFullScope(session.scopes)) await assertStoreCovered(client, session.scopes, campaign.rows[0].store_id, scopeForbidden);
      if (Number(campaign.rows[0].revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      if (campaign.rows[0].status !== "draft") throw app.jundeAuth.businessError("CAMPAIGN_DELETE_NOT_ALLOWED", "已发布或已取消的任务不能删除，可整体取消", 409);
      // 待发布任务下的分配均为草稿，不存在问卷/打卡等外部记录；防御性校验后级联清理。
      const assignments = await client.query("SELECT id FROM audit_assignments WHERE campaign_id=$1 FOR UPDATE", [campaignId]);
      for (const assignment of assignments.rows) {
        const checkin = await client.query("SELECT 1 FROM audit_checkins WHERE assignment_id=$1 LIMIT 1", [assignment.id]);
        if (checkin.rows[0]) throw app.jundeAuth.businessError("CAMPAIGN_DELETE_NOT_ALLOWED", "任务下存在已打卡的指派，无法删除", 409);
      }
      try {
        await client.query("DELETE FROM assignment_dish_requirements WHERE assignment_id IN (SELECT id FROM audit_assignments WHERE campaign_id=$1)", [campaignId]);
        await client.query("DELETE FROM audit_assignments WHERE campaign_id=$1", [campaignId]);
        await client.query("DELETE FROM audit_campaigns WHERE id=$1", [campaignId]);
      } catch (error) {
        if (error.code === "23503") throw app.jundeAuth.businessError("CAMPAIGN_DELETE_NOT_ALLOWED", "任务已被业务数据引用，无法删除，可整体取消", 409);
        throw error;
      }
      await writeAudit(client, session, "campaign_deleted", "campaign", campaignId, { name: campaign.rows[0].name });
      return { deleted: true };
    });
  });

  app.post("/api/admin/campaigns/:id/cancel", async (request) => {
    const session = await requireCampaignAdmin(request, true);
    const campaignId = SecureUuidSchema.parse(request.params.id);
    const body = RevisionReasonSchema.parse(request.body);
    return app.jundeAuth.transaction(async (client) => {
      const state = await advanceCampaignOverdue(client, campaignId);
      if (!state.campaign) throw app.jundeAuth.businessError("CAMPAIGN_NOT_FOUND", "探店任务不存在", 404);
      if (!hasFullScope(session.scopes)) await assertStoreCovered(client, session.scopes, state.campaign.store_id, scopeForbidden);
      if (["completed", "cancelled"].includes(state.campaign.status) || Number(state.campaign.revision) !== body.revision) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      await client.query("UPDATE audit_assignments SET status='cancelled',cancelled_at=now(),cancelled_by=$2,cancel_reason=$3,revision=revision+1,updated_at=now() WHERE campaign_id=$1 AND status IN ('assigned','in_progress','overdue')", [campaignId, session.user_id, body.reason]);
      const cancelled = await client.query("UPDATE audit_campaigns SET status='cancelled',cancelled_at=now(),cancelled_by=$2,cancel_reason=$3,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *", [campaignId, session.user_id, body.reason]);
      await writeAudit(client, session, "campaign_cancelled", "campaign", campaignId, { name: state.campaign.name, reason: body.reason });
      return { campaign: assignmentResult(cancelled.rows[0]) };
    });
  });

  app.post("/api/admin/assignments/:id/cancel", async (request) => {
    const session = await requireCampaignAdmin(request, true);
    const assignmentId = SecureUuidSchema.parse(request.params.id);
    const body = RevisionReasonSchema.parse(request.body);
    const reference = await assignmentReference(session, assignmentId);
    return app.jundeAuth.transaction(async (client) => {
      const state = await advanceCampaignOverdue(client, reference.campaign_id);
      const assignment = state.assignments.find((item) => item.id === assignmentId);
      if (!assignment || !["assigned", "in_progress", "overdue"].includes(assignment.status) || !revisionMatches(assignment, body.revision)) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      // 提交租约守卫：探员正在提交（有效 submitting 租约）时拒绝取消，避免取消与提交最终化竞态导致状态撕裂。
      const activeSubmit = await client.query(`SELECT 1 FROM idempotency_keys key JOIN survey_attempts sa ON sa.id=key.attempt_id
        WHERE sa.assignment_id=$1 AND key.scope='questionnaire_submit' AND key.status='processing' AND key.lease_expires_at>now() LIMIT 1`, [assignmentId]);
      if (activeSubmit.rows[0]) throw app.jundeAuth.businessError("SUBMIT_IN_PROGRESS", "该任务正在提交中，请稍后重试", 409, { retryable: true });
      const cancelled = await client.query("UPDATE audit_assignments SET status='cancelled',cancelled_at=now(),cancelled_by=$2,cancel_reason=$3,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *", [assignmentId, session.user_id, body.reason]);
      const aggregate = await persistCampaignAggregate(client, state.campaign, state.assignments.map((item) => item.id === assignmentId ? cancelled.rows[0] : item));
      await writeAudit(client, session, "assignment_cancelled", "assignment", assignmentId, { campaignId: reference.campaign_id, campaignName: state.campaign.name, reason: body.reason });
      return { assignment: assignmentResult(cancelled.rows[0]), campaign: assignmentResult(aggregate) };
    });
  });

  app.post("/api/admin/assignments/:id/extend", async (request) => {
    const session = await requireCampaignAdmin(request, true);
    const assignmentId = SecureUuidSchema.parse(request.params.id);
    const body = AssignmentExtendSchema.parse(request.body);
    const reference = await assignmentReference(session, assignmentId);
    return app.jundeAuth.transaction(async (client) => {
      const state = await advanceCampaignOverdue(client, reference.campaign_id);
      const assignment = state.assignments.find((item) => item.id === assignmentId);
      if (!assignment || !["assigned", "in_progress", "overdue"].includes(assignment.status) || !revisionMatches(assignment, body.revision)) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      // 延期双窗口：dueAt=执行截止（受父执行窗口约束）；questionnaireDeadlineAt=问卷最终截止。
      // 问卷截止不设父任务 questionnaire_deadline_at 上界：指派的问卷截止初始值即父值，若设上界则问卷延期永远无效；
      // 探店完成后的问卷收尾允许晚于父问卷截止，这是本设计的默认选择。
      const now = new Date();
      const started = Boolean(assignment.started_at);
      if (body.dueAt !== undefined) {
        const dueAt = new Date(body.dueAt);
        if (dueAt <= now || dueAt > state.campaign.due_at || dueAt <= new Date(assignment.starts_at)) throw app.jundeAuth.businessError("ASSIGNMENT_EXTENSION_INVALID", "新的截止时间必须在父任务窗口内且晚于当前时间", 422);
      }
      if (body.questionnaireDeadlineAt !== undefined) {
        const deadline = new Date(body.questionnaireDeadlineAt);
        if (deadline <= now) throw app.jundeAuth.businessError("ASSIGNMENT_EXTENSION_INVALID", "问卷最终截止时间必须晚于当前时间", 422);
        if (body.dueAt !== undefined && deadline < new Date(body.dueAt)) throw app.jundeAuth.businessError("ASSIGNMENT_EXTENSION_INVALID", "问卷最终截止时间不能早于执行截止时间", 422);
      }
      if (!started) {
        // 未开始任务的恢复以执行窗口为必要条件（assigned 的逾期按 due_at 判定）
        if (body.dueAt === undefined) throw app.jundeAuth.businessError("ASSIGNMENT_EXTENSION_INVALID", "未开始任务须延长执行截止时间", 422);
      } else if (body.questionnaireDeadlineAt === undefined) {
        // 已开始任务的逾期按生效问卷截止（questionnaire_deadline_at||due_at）判定：仅延执行截止无法恢复提交资格
        const effectiveDeadline = assignment.questionnaire_deadline_at || assignment.due_at;
        if (new Date(effectiveDeadline) <= now) throw app.jundeAuth.businessError("ASSIGNMENT_EXTENSION_INVALID", "已开始任务须延长问卷最终截止时间", 422);
      }
      // 恢复条件=恢复后不再被 advanceCampaignOverdue 立即判逾期：上面的窗口校验已保证新窗口晚于当前时间
      const nextStatus = assignment.status === "overdue" ? (started ? "in_progress" : "assigned") : assignment.status;
      const sets = ["status=$2", "last_extended_by=$3", "last_extended_at=now()", "last_extension_reason=$4", "revision=revision+1", "updated_at=now()"];
      const params = [assignmentId, nextStatus, session.user_id, body.reason];
      if (body.dueAt !== undefined) { params.push(body.dueAt); sets.push(`due_at=$${params.length}`); }
      if (body.questionnaireDeadlineAt !== undefined) { params.push(body.questionnaireDeadlineAt); sets.push(`questionnaire_deadline_at=$${params.length}`); }
      const extended = await client.query(`UPDATE audit_assignments SET ${sets.join(",")} WHERE id=$1 RETURNING *`, params);
      const aggregate = await persistCampaignAggregate(client, state.campaign, state.assignments.map((item) => item.id === assignmentId ? extended.rows[0] : item));
      await writeAudit(client, session, "assignment_extended", "assignment", assignmentId, { campaignId: reference.campaign_id, campaignName: state.campaign.name, dueAt: body.dueAt ?? null, questionnaireDeadlineAt: body.questionnaireDeadlineAt ?? null, reason: body.reason, recoveredFromOverdue: assignment.status === "overdue" });
      return { assignment: assignmentResult(extended.rows[0]), campaign: assignmentResult(aggregate) };
    });
  });

  // 任务详情摘要：补齐详情页所需字段——门店地址、预算上限（分）、特别说明、菜品要求（按 sort_order 排序，无则空数组）。
  const assignmentSummary = (assignment) => ({ id: assignment.id, businessNo: assignment.business_no, name: assignment.campaign_name, storeName: assignment.store_name, storeAddress: assignment.store_address || "", budgetLimitCents: Number(assignment.budget_limit_cents || 0), specialInstruction: assignment.special_instruction || "", dishRequirements: assignment.dish_requirements || [], taskType: assignment.task_type, status: assignment.status, revision: Number(assignment.revision), receiptRequired: Boolean(assignment.receipt_required), questionnaireDeadlineAt: assignment.questionnaire_deadline_at ? assignment.questionnaire_deadline_at.toISOString() : null, startsAt: assignment.starts_at.toISOString(), dueAt: assignment.due_at.toISOString(), submittedAt: assignment.submitted_at?.toISOString() || null, cancelReason: assignment.cancel_reason || null, hasAttempt: Boolean(assignment.attempt_id), attempt: assignment.attempt_id ? { id: assignment.attempt_id, status: assignment.attempt_status, revision: Number(assignment.attempt_revision) } : null, questionnaireVersion: assignment.questionnaire_version_id ? { id: assignment.questionnaire_version_id, name: assignment.questionnaire_name, versionLabel: `V${assignment.version_number}`, questionCount: Number(assignment.question_count) || 0 } : null });
  const assignmentWithStore = `SELECT a.*,c.name campaign_name,s.name store_name,s.address store_address,s.latitude_gcj02,s.longitude_gcj02,s.checkin_radius_meters,s.accuracy_allowance_max_meters
    ,sa.id attempt_id,sa.status attempt_status,sa.revision attempt_revision,v.version_number,t.name questionnaire_name
    ,(SELECT count(*) FROM questions q WHERE q.version_id=v.id AND q.enabled) question_count
    ,req.dish_requirements
    FROM audit_assignments a JOIN audit_campaigns c ON c.id=a.campaign_id JOIN stores s ON s.id=c.store_id
    JOIN questionnaire_versions v ON v.id=a.questionnaire_version_id JOIN questionnaire_templates t ON t.id=v.template_id
    LEFT JOIN survey_attempts sa ON sa.assignment_id=a.id
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id', r.id,'plannedName', r.planned_name,'quantity', r.quantity,'required', r.required) ORDER BY r.sort_order) dish_requirements FROM assignment_dish_requirements r WHERE r.assignment_id=a.id) req ON true`;

  app.get("/api/assignments/mine", async (request) => {
    const session = await requireInspector(request);
    const campaigns = await pool.query("SELECT DISTINCT campaign_id FROM audit_assignments WHERE inspector_id=$1 AND status IN ('assigned','in_progress')", [session.user_id]);
    for (const item of campaigns.rows) await app.jundeAuth.transaction((client) => advanceCampaignOverdue(client, item.campaign_id));
    const assignments = await pool.query(`${assignmentWithStore} WHERE a.inspector_id=$1 AND a.status <> 'draft' ORDER BY a.due_at,a.id`, [session.user_id]);
    return { items: assignments.rows.map(assignmentSummary) };
  });

  app.get("/api/assignments/:id", async (request) => {
    const session = await requireInspector(request);
    const assignmentId = SecureUuidSchema.parse(request.params.id);
    const reference = await pool.query("SELECT campaign_id FROM audit_assignments WHERE id=$1 AND inspector_id=$2", [assignmentId, session.user_id]);
    if (!reference.rows[0]) throw app.jundeAuth.businessError("ASSIGNMENT_NOT_FOUND", "任务不存在", 404);
    await app.jundeAuth.transaction((client) => advanceCampaignOverdue(client, reference.rows[0].campaign_id));
    const assignment = await pool.query(`${assignmentWithStore} WHERE a.id=$1 AND a.inspector_id=$2`, [assignmentId, session.user_id]);
    if (!assignment.rows[0]) throw app.jundeAuth.businessError("ASSIGNMENT_NOT_FOUND", "任务不存在", 404);
    return assignmentSummary(assignment.rows[0]);
  });

  app.post("/api/assignments/:id/check-in", async (request) => {
    const session = await requireInspector(request);
    const assignmentId = SecureUuidSchema.parse(request.params.id);
    const sample = LocationSampleSchema.parse(request.body);
    const reference = await pool.query("SELECT campaign_id FROM audit_assignments WHERE id=$1 AND inspector_id=$2", [assignmentId, session.user_id]);
    if (!reference.rows[0]) throw app.jundeAuth.businessError("ASSIGNMENT_NOT_FOUND", "任务不存在", 404);
    const result = await app.jundeAuth.transaction(async (client) => {
      const state = await advanceCampaignOverdue(client, reference.rows[0].campaign_id);
      const assignment = state.assignments.find((item) => item.id === assignmentId && item.inspector_id === session.user_id);
      if (!assignment) return { error: "ASSIGNMENT_NOT_FOUND" };
      if (assignment.status === "overdue") return { error: "TASK_OVERDUE" };
      if (assignment.status !== "assigned" || new Date(assignment.starts_at) > new Date()) return { error: "ASSIGNMENT_NOT_AVAILABLE" };
      const store = await client.query(`SELECT s.latitude_gcj02,s.longitude_gcj02,s.checkin_radius_meters,s.accuracy_allowance_max_meters
        FROM audit_campaigns c JOIN stores s ON s.id=c.store_id WHERE c.id=$1`, [assignment.campaign_id]);
      const evaluation = evaluateCheckin(sample, { latitudeGcj02: store.rows[0].latitude_gcj02, longitudeGcj02: store.rows[0].longitude_gcj02, radiusMeters: store.rows[0].checkin_radius_meters, accuracyAllowanceMaxMeters: store.rows[0].accuracy_allowance_max_meters });
      const validUntil = evaluation.result === "accepted" ? new Date(Date.now() + 5 * 60_000) : null;
      await client.query(`INSERT INTO audit_checkins (id,assignment_id,inspector_id,latitude_gcj02,longitude_gcj02,accuracy_meters,captured_at,store_latitude_snapshot,store_longitude_snapshot,base_radius_snapshot,accuracy_allowance_meters,allowance_max_snapshot,effective_radius_meters,computed_distance_meters,result,failure_code,valid_until)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [uuidv7(), assignmentId, session.user_id, sample.latitude, sample.longitude, sample.accuracy, sample.capturedAt, store.rows[0].latitude_gcj02, store.rows[0].longitude_gcj02, store.rows[0].checkin_radius_meters, evaluation.allowanceMeters, store.rows[0].accuracy_allowance_max_meters, evaluation.effectiveRadiusMeters, evaluation.distanceMeters, evaluation.result, evaluation.failureCode, validUntil]);
      // 审计：打卡结果（成功与未通过都记录，便于排查定位争议）
      await client.query("INSERT INTO audit_logs (id,actor_id,actor_name,actor_username,action,subject_type,subject_id,data_json) VALUES ($1,$2,$3,$4,$5,'assignment',$6,$7)",
        [uuidv7(), session.user_id, session.display_name, session.username_display, evaluation.result === "accepted" ? "checkin_accepted" : "checkin_rejected", assignmentId, JSON.stringify({ distanceMeters: evaluation.distanceMeters, failureCode: evaluation.failureCode || null })]);
      return { result: evaluation.result, validUntil: validUntil?.toISOString() || null };
    });
    if (result.error === "TASK_OVERDUE") throw app.jundeAuth.businessError("TASK_OVERDUE", "任务已逾期，请等待管理员延期后刷新任务", 409, { requiresNewToken: true });
    if (result.error) throw app.jundeAuth.businessError(result.error, "当前任务暂不能打卡", 409);
    return result;
  });

  const expireExemptions = (client, assignmentId) => client.query("UPDATE checkin_exemptions SET status='expired',revision=revision+1 WHERE assignment_id=$1 AND status='active' AND valid_until<=now()", [assignmentId]);
  const exemptionRow = (item) => ({ id: item.id, status: item.status, reason: item.reason, grantedAt: item.granted_at.toISOString(), validUntil: item.valid_until?.toISOString() || null, revision: Number(item.revision) });

  app.get("/api/admin/assignments/:id/check-in-exemptions", async (request) => {
    const session = await requireExemptionAdmin(request);
    const assignmentId = SecureUuidSchema.parse(request.params.id);
    const reference = await assignmentReference(session, assignmentId);
    await app.jundeAuth.transaction(async (client) => {
      const state = await advanceCampaignOverdue(client, reference.campaign_id);
      if (!state.assignments.some((item) => item.id === assignmentId)) throw app.jundeAuth.businessError("ASSIGNMENT_NOT_FOUND", "指派不存在", 404);
      await expireExemptions(client, assignmentId);
    });
    const exemptions = await pool.query("SELECT * FROM checkin_exemptions WHERE assignment_id=$1 ORDER BY granted_at DESC", [assignmentId]);
    return { items: exemptions.rows.map(exemptionRow) };
  });

  app.post("/api/admin/assignments/:id/check-in-exemptions", async (request, reply) => {
    const session = await requireExemptionAdmin(request, true);
    const assignmentId = SecureUuidSchema.parse(request.params.id);
    const body = CheckinExemptionCreateSchema.parse(request.body);
    const reference = await assignmentReference(session, assignmentId);
    const exemption = await app.jundeAuth.transaction(async (client) => {
      const state = await advanceCampaignOverdue(client, reference.campaign_id);
      const assignment = state.assignments.find((item) => item.id === assignmentId);
      if (!assignment || assignment.status !== "assigned" || Number(assignment.revision) !== body.assignmentRevision || new Date(assignment.starts_at) > new Date()) throw app.jundeAuth.businessError("CHECKIN_EXEMPTION_NOT_ALLOWED", "当前任务不能创建打卡豁免", 409);
      await expireExemptions(client, assignmentId);
      try {
        const validUntil = new Date(Date.now() + body.validForMinutes * 60_000);
        const created = await client.query("INSERT INTO checkin_exemptions (id,assignment_id,status,reason,granted_by,valid_until) VALUES ($1,$2,'active',$3,$4,$5) RETURNING *", [uuidv7(), assignmentId, body.reason, session.user_id, validUntil]);
        await writeAudit(client, session, "exemption_created", "assignment", assignmentId, { exemptionId: created.rows[0].id, reason: body.reason, validForMinutes: body.validForMinutes });
        return exemptionRow(created.rows[0]);
      } catch (error) {
        if (error.code === "23505") throw app.jundeAuth.businessError("CHECKIN_EXEMPTION_EXISTS", "当前任务已有有效打卡豁免", 409);
        throw error;
      }
    });
    return reply.code(201).send({ exemption });
  });

  app.post("/api/admin/assignments/:id/check-in-exemptions/:exemptionId/revoke", async (request) => {
    const session = await requireExemptionAdmin(request, true);
    const assignmentId = SecureUuidSchema.parse(request.params.id);
    const exemptionId = SecureUuidSchema.parse(request.params.exemptionId);
    const body = CheckinExemptionRevokeSchema.parse(request.body);
    const reference = await assignmentReference(session, assignmentId);
    return app.jundeAuth.transaction(async (client) => {
      await advanceCampaignOverdue(client, reference.campaign_id);
      await expireExemptions(client, assignmentId);
      const revoked = await client.query("UPDATE checkin_exemptions SET status='revoked',revoked_at=now(),revoked_by=$2,revoke_reason=$3,revision=revision+1 WHERE id=$1 AND assignment_id=$4 AND status='active' AND revision=$5 RETURNING *", [exemptionId, session.user_id, body.reason, assignmentId, body.revision]);
      if (!revoked.rows[0]) throw app.jundeAuth.businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      await writeAudit(client, session, "exemption_revoked", "assignment", assignmentId, { exemptionId, reason: body.reason });
      return { exemption: exemptionRow(revoked.rows[0]) };
    });
  });
}
