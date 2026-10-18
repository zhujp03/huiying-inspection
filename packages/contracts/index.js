import { z } from "zod";
import { apiPaths } from "./endpoint-registry.js";

export const USER_STATUS = Object.freeze({
  PENDING: "pending_approval",
  APPROVED: "approved_active",
  REJECTED: "rejected",
  DISABLED: "disabled",
});

export const ASSIGNMENT_STATUS = Object.freeze({
  DRAFT: "draft",
  ASSIGNED: "assigned",
  IN_PROGRESS: "in_progress",
  SUBMITTED: "submitted",
  OVERDUE: "overdue",
  CANCELLED: "cancelled",
});

export const ADMIN_ROLES = Object.freeze({
  ADMIN: "admin",
  SUPER_ADMIN: "super_admin",
  OPERATIONS_ADMIN: "operations_admin",
  REVIEWER: "reviewer",
  STORE_MANAGER: "store_manager",
  // 审计员：第三种后台角色，可查看全部内容与操作审计（普通管理员默认无审计权限）
  AUDITOR: "auditor",
});

export const API = Object.freeze(apiPaths());

// 自助路径（注册/找回密码）密码策略：8-15 位，必须包含大写字母和英文符号；
// 管理员后台创建/重置账号豁免（UserCreateSchema/UserUpdateSchema 用宽松校验）。
export const PasswordSchema = z.string().min(8, "密码至少需要 8 个字符").max(15, "密码最多 15 个字符").regex(/[A-Z]/, "密码必须包含大写字母").regex(/[^A-Za-z0-9]/, "密码必须包含英文符号");
export const UsernameSchema = z.string().trim().min(4, "用户名至少需要 4 个字符").max(32, "用户名最多 32 个字符").regex(/^[\p{L}\p{N}_]+$/u, "用户名只能包含文字、数字或下划线");
export const PhoneSchema = z.string().regex(/^1\d{10}$/, "请输入正确的手机号");
export const IdSchema = z.string().min(1);
export const SecureUuidSchema = z.uuid("必须使用安全 UUID");
export const RevisionSchema = z.number().int().nonnegative();
// 管理列表游标分页查询：order 控制排序方向（如最新记录优先的 order=desc）
export const CursorPageSchema = z.object({ cursor: z.uuid().nullable().optional(), limit: z.coerce.number().int().min(1).max(100).default(20), order: z.enum(["asc", "desc"]).optional() });

export const LoginRequestSchema = z.object({ username: UsernameSchema, password: z.string().min(1).max(64) });
export const AdminLoginRequestSchema = z.object({ username: z.string().trim().min(1), password: z.string().min(1) });
export const PhoneCodeRequestSchema = z.object({
  phone: PhoneSchema,
  captchaTicket: z.string().trim().min(1),
  // 小程序插件 2.1.4 的 verify 事件只提供 ticket（DescribeCaptchaMiniResult 不接收
  // Randstr）；randstr 仅 Web 场景需要，这里保持可选。
  captchaRandstr: z.string().trim().max(64).optional().default(""),
  deviceFingerprint: z.string().trim().min(8).max(256).optional(),
});
export const PhoneCodeVerifyRequestSchema = z.object({ phoneChallengeId: SecureUuidSchema, smsCode: z.string().regex(/^\d{4,8}$/) });
export const RegistrationResubmitSchema = PhoneCodeVerifyRequestSchema;
export const PasswordResetCompleteRequestSchema = z.object({ resetToken: z.string().min(32), password: PasswordSchema, confirmPassword: PasswordSchema }).superRefine((value, context) => {
  if (value.password !== value.confirmPassword) context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmPassword"], message: "两次输入的密码不一致" });
});
export const RegistrationDecisionSchema = z.object({ revision: RevisionSchema, reason: z.string().trim().min(1).max(1000).optional() });
export const IdempotencyKeySchema = z.string().uuid();
export const StoreWriteSchema = z.object({
  businessNo: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  brandId: SecureUuidSchema,
  regionId: SecureUuidSchema,
  address: z.string().trim().min(1).max(500),
  latitudeGcj02: z.number().min(-90).max(90),
  longitudeGcj02: z.number().min(-180).max(180),
  providerPoiId: z.string().trim().min(1).max(200).nullable().optional(),
  coordinateSource: z.enum(["poi", "manual_adjusted"]),
  radiusMeters: z.number().int().min(100).max(1000).default(300),
  accuracyAllowanceMaxMeters: z.number().int().min(0).max(200).default(200),
  locationVerified: z.boolean(),
  active: z.boolean().default(true),
  revision: RevisionSchema.optional(),
});
// 品牌：门店的品牌归属（城市/区域仍由 stores.region_id 表达）
export const BrandWriteSchema = z.object({
  name: z.string().trim().min(1, "品牌名称不能为空").max(64),
  active: z.boolean().default(true),
  revision: RevisionSchema.optional(),
});
export const BrandRowSchema = z.object({ id: IdSchema, name: z.string(), active: z.boolean(), storeCount: z.number().optional(), revision: RevisionSchema });
// 门店列表筛选：品牌 + 城市（区县的上级地级市区域）+ 门店编号精确匹配（新建冲突后对账复用）
export const StoreListQuerySchema = CursorPageSchema.extend({
  brandId: SecureUuidSchema.optional(),
  cityRegionId: SecureUuidSchema.optional(),
  businessNo: z.string().trim().min(1).max(64).optional(),
});
export const EvidenceRequirementWriteSchema = z.object({
  evidenceRequired: z.boolean(),
  imageRequired: z.boolean(),
  audioRequired: z.boolean(),
  // 每题照片上限（1-9，默认 4——不得分照片已全面改为选填，默认上限从 3 放宽到 4）
  // 与录音时长上限（1-60 秒，默认 10）
  imageMaxCount: z.number().int().min(1).max(9).default(4),
  audioMaxDurationSeconds: z.number().int().min(1).max(60).default(10),
}).superRefine((value, context) => {
  if (!value.evidenceRequired && (value.imageRequired || value.audioRequired)) context.addIssue({ code: z.ZodIssueCode.custom, message: "未要求证据时不能单独要求图片或音频" });
  if (value.evidenceRequired && !value.imageRequired && !value.audioRequired) context.addIssue({ code: z.ZodIssueCode.custom, message: "要求证据时至少选择图片或音频" });
  if (value.imageRequired && !value.imageMaxCount) context.addIssue({ code: z.ZodIssueCode.custom, message: "需要图片时必须设置照片上限" });
  if (value.audioRequired && !value.audioMaxDurationSeconds) context.addIssue({ code: z.ZodIssueCode.custom, message: "需要录音时必须设置录音时长上限" });
});
// 题目编辑：草稿状态下允许改文字/分值/启停/分数清零标记（evidence 结构保持不变）
export const QuestionPatchSchema = z.object({
  revision: RevisionSchema,
  text: z.string().trim().min(1, "题目内容不能为空").max(500).optional(),
  maxScore: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
  // 分数清零题标记，true=该题不得分时所在分类全部计 0 分
  scoreWipe: z.boolean().optional(),
  evidence: EvidenceRequirementWriteSchema.optional(),
}).refine((value) => value.text !== undefined || value.maxScore !== undefined || value.enabled !== undefined || value.scoreWipe !== undefined || value.evidence !== undefined, { message: "没有可更新的内容" });
// 题目新增/删除/移动：仅草稿版本；题号由服务端按展示顺序重排为 1..N，question_key 保持不变
export const QuestionCreateSchema = z.object({
  category: z.string().trim().min(1, "请选择题目分类").max(64),
  text: z.string().trim().min(1).max(500),
  maxScore: z.number().int().min(0).default(2),
  riskLevel: z.enum(["normal", "high"]).optional(),
  scoreWipe: z.boolean().optional(),
  evidence: EvidenceRequirementWriteSchema.optional(),
});
export const QuestionDeleteSchema = z.object({ revision: RevisionSchema });
export const QuestionMoveSchema = z.object({ revision: RevisionSchema, direction: z.enum(["up", "down"]) });
export const QuestionnaireQuestionWriteSchema = z.object({
  number: z.number().int().min(1),
  // 分类为管理员可扩展的动态集合（question_categories.code），由服务端校验存在且启用
  category: z.string().trim().min(1, "请选择题目分类").max(64),
  text: z.string().trim().min(1).max(500),
  maxScore: z.number().int().min(0).default(2),
  riskLevel: z.enum(["normal", "high"]).optional(),
  scoreWipe: z.boolean().optional(),
  evidence: EvidenceRequirementWriteSchema.optional(),
});
export const QuestionnaireVersionCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  questions: z.array(QuestionnaireQuestionWriteSchema).min(1),
}).superRefine((value, context) => {
  const numbers = value.questions.map((question) => question.number);
  if (new Set(numbers).size !== numbers.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "题目编号不能重复" });
});
export const QuestionEvidencePatchSchema = z.object({ revision: RevisionSchema, evidence: EvidenceRequirementWriteSchema });
export const RevisionActionSchema = z.object({ revision: RevisionSchema });
export const CampaignWriteSchema = z.object({
  name: z.string().trim().min(1, "请填写任务名称"),
  storeId: IdSchema,
  startsAt: z.string("请选择整体开始时间").min(1, "请选择整体开始时间"),
  dueAt: z.string("请选择整体截止时间").min(1, "请选择整体截止时间"),
  questionnaireDeadlineAt: z.string("请选择问卷最终截止时间").min(1, "请选择问卷最终截止时间"),
  commonInstruction: z.string().trim().max(2000),
  revision: RevisionSchema.optional(),
}).superRefine((value, context) => {
  if (new Date(value.dueAt) <= new Date(value.startsAt)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["dueAt"], message: "整体截止时间必须晚于开始时间" });
  if (new Date(value.questionnaireDeadlineAt) < new Date(value.dueAt)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["questionnaireDeadlineAt"], message: "问卷最终截止时间不能早于整体截止时间" });
});
export const DishRequirementWriteSchema = z.object({
  id: IdSchema.optional(),
  plannedName: z.string().trim().min(1, "请填写菜品名称"),
  quantity: z.number().int().min(1, "数量至少为 1"),
  required: z.boolean(),
  allowSubstitution: z.boolean(),
});
export const DishRequirementRecordSchema = DishRequirementWriteSchema.extend({ recordId: IdSchema });
export const DishRequirementsReplaceSchema = z.object({ revision: RevisionSchema, items: z.array(DishRequirementWriteSchema).max(100) });
export const CheckinExemptionCreateSchema = z.object({ assignmentRevision: RevisionSchema, reason: z.string().trim().min(1).max(1000), validForMinutes: z.number().int().min(1).max(30) });
export const CheckinExemptionRevokeSchema = z.object({ revision: RevisionSchema, reason: z.string().trim().min(1).max(1000) });
export const RevisionReasonSchema = z.object({ revision: RevisionSchema, reason: z.string().trim().min(1).max(1000) });
// 测试任务数据清理（super_admin 专用）：预览返回各业务行数与阻断原因；确认需逐字输入任务名称 + revision。
export const CampaignCleanupPreviewSchema = z.object({
  campaign: z.object({ id: IdSchema, name: z.string(), businessNo: z.string(), status: z.string(), storeName: z.string(), revision: RevisionSchema, cancelReason: z.string().nullable().optional() }),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  blockers: z.array(z.object({ code: z.string(), message: z.string() })),
  cleanupAllowed: z.boolean(),
});
export const CampaignCleanupConfirmSchema = z.object({ revision: RevisionSchema, confirmName: z.string().trim().min(1).max(200) });
export const CampaignCleanupResultSchema = z.object({ deleted: z.literal(true), counts: z.record(z.string(), z.number().int().nonnegative()) });
// 延期双窗口：dueAt=执行截止，questionnaireDeadlineAt=问卷最终截止；至少填一项，允许只延其一。
export const AssignmentExtendSchema = RevisionReasonSchema.extend({ dueAt: z.string().datetime().optional(), questionnaireDeadlineAt: z.string().datetime().optional() })
  .refine((value) => value.dueAt !== undefined || value.questionnaireDeadlineAt !== undefined, { message: "请至少填写一项延期时间" });
const assignmentBaseShape = {
  inspectorId: IdSchema,
  questionnaireVersionId: IdSchema,
  taskType: z.enum(["secret", "overt"]),
  startsAt: z.string().min(1, "请选择个人开始时间"),
  dueAt: z.string().min(1, "请选择个人截止时间"),
  budgetLimit: z.number().nonnegative("预算不能为负数"),
  receiptRequired: z.boolean(),
  specialInstruction: z.string().trim().max(2000),
  revision: RevisionSchema.optional(),
  campaignRevision: RevisionSchema,
};
const assignmentWindowRefine = (schema) => schema.superRefine((value, context) => {
  if (new Date(value.dueAt) <= new Date(value.startsAt)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["dueAt"], message: "个人截止时间必须晚于开始时间" });
});
// 创建/编辑分配的线上请求体：菜品要求由 PUT /dish-requirements 单独传输，不在本体内联。
export const AssignmentUpsertSchema = assignmentWindowRefine(z.object(assignmentBaseShape));
export const AssignmentWriteSchema = assignmentWindowRefine(z.object({ ...assignmentBaseShape, dishRequirements: z.array(DishRequirementWriteSchema) }));
export const RegisterRequestSchema = z.object({
  username: UsernameSchema,
  phone: PhoneSchema,
  password: PasswordSchema,
  confirmPassword: PasswordSchema,
  phoneChallengeId: SecureUuidSchema,
  smsCode: z.string().regex(/^\d{4,8}$/, "请输入正确的短信验证码"),
}).superRefine((value, context) => {
  if (value.password !== value.confirmPassword) context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmPassword"], message: "两次输入的密码不一致" });
});

export const LocationSampleSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().positive(),
  capturedAt: z.string().datetime(),
});
export const AnswerSaveSchema = z.object({ answer: z.literal("scored"), revision: RevisionSchema });
export const EditSessionCreateSchema = z.object({ baseAnswerRevision: RevisionSchema, targetAnswer: z.enum(["scored", "unscored"]) });
export const EditSessionPatchSchema = z.object({ draftIssueRemark: z.string().trim().max(4000), revision: RevisionSchema });
export const EditSessionConfirmSchema = z.object({ answer: z.enum(["scored", "unscored"]), revision: RevisionSchema });
export const EvidenceUploadInitSchema = z.object({
  clientFileId: SecureUuidSchema, type: z.enum(["image", "audio"]), mimeType: z.string().trim().min(1).max(100), sizeBytes: z.number().int().min(1).max(10 * 1024 * 1024), durationSeconds: z.number().int().min(1).max(60).optional(),
});
export const EvidenceUploadCompleteSchema = z.object({ uploadToken: SecureUuidSchema, sizeBytes: z.number().int().min(1).max(10 * 1024 * 1024), durationSeconds: z.number().int().min(1).max(60).optional() });

export const QuestionSchema = z.object({
  id: IdSchema,
  number: z.number().int().min(1),
  category: z.string(),
  text: z.string().min(1),
  score: z.number().nonnegative(),
  // 分数清零题标记：探员端据此展示"答不出按整类清零"提示
  isScoreWipe: z.boolean(),
  evidence: z.object({ imageRequired: z.boolean(), audioRequired: z.boolean() }),
});
// 问卷评估分类：管理员可扩展；code 为稳定标识（questions.category 引用），name 为展示名
export const QuestionCategoryRowSchema = z.object({ id: IdSchema, code: z.string(), name: z.string(), sortOrder: z.number().int(), active: z.boolean(), questionCount: z.number().optional(), revision: RevisionSchema });
export const QuestionCategoryWriteSchema = z.object({
  name: z.string().trim().min(1, "分类名称不能为空").max(32),
  active: z.boolean().default(true),
  revision: RevisionSchema.optional(),
});

export const AssignmentSummarySchema = z.object({
  id: IdSchema,
  businessNo: z.string().min(1),
  name: z.string().min(1),
  storeName: z.string().min(1),
  storeAddress: z.string(),
  budgetLimitCents: z.number().int().nonnegative(),
  specialInstruction: z.string(),
  dishRequirements: z.array(z.object({ id: IdSchema, plannedName: z.string(), quantity: z.number().int(), required: z.boolean() })),
  taskType: z.enum(["secret", "overt"]),
  status: z.enum(Object.values(ASSIGNMENT_STATUS)),
  // 任务乐观锁版本号（audit_assignments.revision），探员端提交时回传做冲突校验。
  revision: RevisionSchema,
  // 是否要求上传小票。
  receiptRequired: z.boolean(),
  // 问卷填写截止时间（可空）。
  questionnaireDeadlineAt: z.string().nullable(),
  startsAt: z.string(),
  dueAt: z.string(),
  submittedAt: z.string().nullable().optional(),
  // 管理员取消指派（单条或整体取消级联）时写入的原因，供探员端展示。
  cancelReason: z.string().nullable().optional(),
  hasAttempt: z.boolean().optional(),
});

export const AssignmentListSchema = z.object({ items: z.array(AssignmentSummarySchema) });
export const SessionSchema = z.object({
  user: z.object({ id: IdSchema, displayName: z.string().min(1), status: z.enum(Object.values(USER_STATUS)) }),
  accessToken: z.string().min(1).optional(),
});

export const AdminSessionSchema = z.object({
  user: z.object({ id: IdSchema, displayName: z.string().min(1), role: z.enum(Object.values(ADMIN_ROLES)), scopeLabel: z.string().min(1), permissions: z.array(z.string()).optional() }),
  csrfToken: z.string().min(32),
});

export const RegistrationRowSchema = z.object({ id: IdSchema, userId: IdSchema.optional(), displayName: z.string(), username: z.string(), maskedPhone: z.string(), appliedAt: z.string(), status: z.enum(Object.values(USER_STATUS)), revision: RevisionSchema });
export const StoreRowSchema = z.object({
  id: IdSchema,
  name: z.string(),
  businessNo: z.string(),
  brandId: IdSchema.nullable().optional(),
  brandName: z.string().nullable().optional(),
  cityRegionId: IdSchema.nullable().optional(),
  cityName: z.string().nullable().optional(),
  regionId: IdSchema,
  regionName: z.string(),
  address: z.string(),
  active: z.boolean(),
  locationVerified: z.boolean(),
  radiusMeters: z.number(),
  latitudeGcj02: z.number().nullable().optional(),
  longitudeGcj02: z.number().nullable().optional(),
  accuracyAllowanceMaxMeters: z.number().nullable().optional(),
  providerPoiId: z.string().nullable().optional(),
  coordinateSource: z.string().nullable().optional(),
  revision: RevisionSchema,
});
export const RegionRowSchema = z.object({ id: IdSchema, name: z.string(), code: z.string(), parentId: IdSchema.nullable().optional(), level: z.number().int().min(1).max(3), active: z.boolean(), revision: RevisionSchema });
// 民政部 6 位行政区划代码；层级由 code 后缀推导（xx0000 省级、xxxx00 地级、xxxxxx 区县），
// 但以显式 level 为准，parent 必须与 level-1 对应。
export const RegionWriteSchema = z.object({
  name: z.string().trim().min(1).max(64),
  code: z.string().trim().regex(/^\d{6}$/, "区域编码必须是 6 位行政区划代码"),
  parentId: SecureUuidSchema.nullable().optional(),
});
export const CampaignRowSchema = z.object({ id: IdSchema, name: z.string(), businessNo: z.string().optional(), storeName: z.string(), startsAt: z.string(), dueAt: z.string(), questionnaireDeadlineAt: z.string().nullable().optional(), status: z.string(), revision: RevisionSchema, assignmentCount: z.number().optional(), overdueCount: z.number().optional() }).passthrough();
export const QuestionnaireVersionRowSchema = z.object({ id: IdSchema, name: z.string(), versionLabel: z.string(), status: z.string(), revision: RevisionSchema, enabledQuestionCount: z.number(), numberingValid: z.boolean(), createdAt: z.string() });
export const AdminUserOptionSchema = z.object({ id: IdSchema, displayName: z.string(), status: z.enum(Object.values(USER_STATUS)), phoneVerified: z.boolean().optional(), regionName: z.string().optional() });
// 用户管理列表行（kind=admin|inspector 由 roleCode 区分；source 表示探员来源）
export const UserRowSchema = z.object({
  id: IdSchema,
  username: z.string(),
  displayName: z.string(),
  maskedPhone: z.string(),
  roleCode: z.string(),
  scopeType: z.enum(["all", "region", "store"]).nullable().optional(),
  scopeLabel: z.string().nullable().optional(),
  regionId: IdSchema.nullable().optional(),
  storeId: IdSchema.nullable().optional(),
  source: z.enum(["manual", "registration"]).optional(),
  status: z.enum(Object.values(USER_STATUS)),
  revision: RevisionSchema,
});
// 管理员后台创建账号：密码豁免策略（仅 1-64 位非空）
export const UserCreateSchema = z.object({
  kind: z.enum(["admin", "auditor", "inspector"]),
  username: UsernameSchema,
  displayName: z.string().trim().min(1).max(64),
  phone: PhoneSchema,
  password: z.string().min(1).max(64),
  scopeType: z.enum(["all", "region", "store"]).optional(),
  regionId: SecureUuidSchema.nullable().optional(),
  storeId: SecureUuidSchema.nullable().optional(),
});
export const UserUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
  status: z.enum(["approved_active", "disabled"]).optional(),
  kind: z.enum(["admin", "auditor", "inspector"]).optional(),
  scopeType: z.enum(["all", "region", "store"]).optional(),
  regionId: SecureUuidSchema.nullable().optional(),
  storeId: SecureUuidSchema.nullable().optional(),
  password: z.string().min(1).max(64).optional(),
});
export const AdminQuestionRowSchema = z.object({ id: IdSchema, number: z.number().int().min(1), category: z.string(), categoryName: z.string().nullable().optional(), text: z.string(), maxScore: z.number().int().min(0), enabled: z.boolean(), scoreWipe: z.boolean(), revision: RevisionSchema, evidence: z.object({ evidenceRequired: z.boolean(), imageRequired: z.boolean(), audioRequired: z.boolean(), imageMaxCount: z.number().int().min(1).max(9).optional(), audioMaxDurationSeconds: z.number().int().min(1).max(60).optional() }) });
export const SubmissionRowSchema = z.object({ id: IdSchema, taskName: z.string(), businessNo: z.string(), storeName: z.string(), regionName: z.string().optional(), inspectorName: z.string(), status: z.string().optional(), submittedAt: z.string(), scoreRate: z.string(), issueCount: z.number(), highRiskCount: z.number().optional() });
// failureCode：导出任务失败时的稳定业务错误码（如 EXPORT_SUBMISSION_SCORES_MISSING），
// 供前端映射成可行动的安全提示；成功/进行中任务为 null。附加可选字段，不破坏既有消费方。
export const ExportRowSchema = z.object({ id: IdSchema, kind: z.string().optional(), fileName: z.string(), createdByName: z.string(), createdAt: z.string(), status: z.string(), downloadUrl: z.string().url().nullable().optional(), failureCode: z.string().nullable().optional() });
// 数据看板筛选：时间为问卷提交时间；月份按 Asia/Shanghai 自然月聚合；得分为得分率×100（0-100），分类/考核点得分为百分数（0-100）
export const DashboardFilterSchema = z.object({
  from: z.string().min(8).max(10), to: z.string().min(8).max(10),
  brandId: IdSchema.optional(), cityRegionId: IdSchema.optional(), regionId: IdSchema.optional(), storeId: IdSchema.optional(),
}).strict().superRefine((value, context) => {
  if (new Date(value.from) > new Date(value.to)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "结束日期不能早于开始日期" });
});
export const DashboardTrendPointSchema = z.object({ month: z.string(), submissions: z.number().int().nonnegative(), score: z.number() });
export const DashboardStoreMonthlyRowSchema = z.object({
  storeId: IdSchema, storeName: z.string(), brandName: z.string().nullable().optional(), cityName: z.string().nullable().optional(),
  overall: z.number(), submissions: z.number().int().nonnegative(),
  monthly: z.array(z.object({ month: z.string(), score: z.number().nullable() })),
});
export const DashboardStoreCategoryRowSchema = z.object({
  storeId: IdSchema, storeName: z.string(), overallRate: z.number(),
  rates: z.array(z.object({ category: z.string(), rate: z.number().nullable() })),
});
export const DashboardQuestionRowSchema = z.object({
  key: z.string(), number: z.number().int(), text: z.string(), overallRate: z.number(),
  monthly: z.array(z.object({ month: z.string(), rate: z.number().nullable() })), delta: z.number().nullable(),
});
export const DashboardStatsSchema = z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  months: z.array(z.string()),
  categories: z.array(z.object({ code: z.string(), name: z.string() })),
  trend: z.array(DashboardTrendPointSchema),
  stores: z.array(DashboardStoreMonthlyRowSchema),
  storeCategories: z.array(DashboardStoreCategoryRowSchema),
  questions: z.array(DashboardQuestionRowSchema),
});
export const AuditRowSchema = z.object({ id: IdSchema, createdAt: z.string(), actorName: z.string(), actorUsername: z.string().nullable().optional(), subjectType: z.string().optional(), actionLabel: z.string(), subjectLabel: z.string(), resultLabel: z.string(), level: z.enum(["info", "error"]).optional(), details: z.record(z.string(), z.unknown()).optional() });
// 审计列表：默认只看近 30 天（days 可调 1-365）；group 为动作类别分组（服务端展开为动作集合），actor 按操作人姓名/账号模糊匹配
export const AuditListQuerySchema = CursorPageSchema.extend({
  days: z.coerce.number().int().min(1).max(365).default(30),
  group: z.enum(["account", "campaigns", "execution", "questionnaire", "stores", "exports"]).optional(),
  actor: z.string().trim().max(50).optional(),
});
// 管理列表统一返回 { items }；个别列表用 extra 扩展可选字段
// （audits 的 nextCursor 供「加载更多」判断，submissions 的 total 供「共 X 条」展示）。
export const listSchema = (itemSchema, extra = {}) => z.object({ items: z.array(itemSchema), ...extra });

export const ADMIN_LIST_SCHEMAS = Object.freeze({
  campaigns: listSchema(CampaignRowSchema), registrations: listSchema(RegistrationRowSchema), stores: listSchema(StoreRowSchema), brands: listSchema(BrandRowSchema), questionCategories: listSchema(QuestionCategoryRowSchema),
  questionnaires: listSchema(QuestionnaireVersionRowSchema), submissions: listSchema(SubmissionRowSchema, { total: z.number().int().nonnegative().optional() }), exports: listSchema(ExportRowSchema), audits: listSchema(AuditRowSchema, { nextCursor: z.uuid().nullable().optional() }),
});

export const CampaignDetailSchema = CampaignRowSchema.extend({
  storeId: IdSchema,
  commonInstruction: z.string().optional(),
  locationVerified: z.boolean(),
  assignments: z.array(z.object({
    id: IdSchema,
    inspectorId: IdSchema.optional(),
    inspectorName: z.string(),
    questionnaireVersionId: IdSchema.optional(),
    questionnaireName: z.string(),
    taskType: z.enum(["secret", "overt"]),
    startsAt: z.string(),
    dueAt: z.string(),
    budgetLimit: z.number().optional(),
    receiptRequired: z.boolean().optional(),
    specialInstruction: z.string().optional(),
    dishRequirements: z.array(DishRequirementRecordSchema).optional(),
    status: z.string(),
    revision: RevisionSchema,
    activeExemption: z.object({ id: IdSchema, revision: RevisionSchema }).nullable().optional(),
  })),
});
export const AdminQuestionListSchema = listSchema(AdminQuestionRowSchema);

export const RECEIPT_ATTACHMENT_STATUS = Object.freeze(["uploading", "ready", "failed"]);
export const RECEIPT_OCR_STATUS = Object.freeze(["queued", "processing", "succeeded", "partial", "failed", "cancelled"]);
export const RECEIPT_DISH_IMPACT = Object.freeze(["none", "removable_auto_rows", "protected_rows", "mixed"]);
export const RECEIPT_DISH_HANDLING = Object.freeze(["remove_unmodified_ocr_rows", "keep_as_manual"]);

export const ReceiptAttachmentSchema = z.object({
  id: IdSchema,
  displayOrder: z.number().int().min(1).max(9),
  previewUrl: z.string().url().nullable(),
  status: z.enum(RECEIPT_ATTACHMENT_STATUS),
  progressPercent: z.number().int().min(0).max(100),
  failureKind: z.string().nullable(),
  canRetry: z.boolean(),
  canDelete: z.boolean(),
  dishImpact: z.enum(RECEIPT_DISH_IMPACT),
  appliedDishCount: z.number().int().nonnegative(),
});
export const ReceiptAttachmentListSchema = z.object({ items: z.array(ReceiptAttachmentSchema).max(9), revision: RevisionSchema });
export const ReceiptFileMetaSchema = z.object({
  clientFileId: SecureUuidSchema, fileName: z.string().min(1), mimeType: z.enum(["image/jpeg", "image/png"]),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/i, "文件校验和格式不正确"), etag: z.string().nullable().optional(),
});
export const ReceiptUploadInitRequestSchema = z.object({ fileMeta: ReceiptFileMetaSchema, revision: RevisionSchema });
export const ReceiptCompleteRequestSchema = z.object({ fileMeta: ReceiptFileMetaSchema, revision: RevisionSchema });
export const ReceiptDeleteRequestSchema = z.object({ dishHandling: z.enum(RECEIPT_DISH_HANDLING), revision: RevisionSchema });
export const ReceiptOcrCreateRequestSchema = z.object({ attachmentIds: z.array(IdSchema).min(1).max(9), idempotencyKey: IdSchema, revision: RevisionSchema });
export const ReceiptOcrApplyRequestSchema = z.object({ idempotencyKey: IdSchema, revision: RevisionSchema });
export const QuestionnaireSubmitRequestSchema = z.object({
  submitToken: SecureUuidSchema,
  assignmentRevision: RevisionSchema,
  confirmation: z.literal(true),
});
export const QuestionnaireSubmitResponseSchema = z.object({ status: z.enum(["processing", "submitted"]), submittedAt: z.string().datetime().nullable().optional() });
// 提交列表/导出共享筛选规范：column 为两侧 SQL 的真实列名，op 为唯一事实源的比较方向，
// 两侧（列表端点与导出 worker）禁止再各自硬编码比较符，防止规则漂移。
export const SUBMISSION_EXPORT_FILTER_RULES = Object.freeze({
  campaignId: { column: "campaign.id", op: "=" },
  storeId: { column: "store.id", op: "=" },
  inspectorId: { column: "inspector.id", op: "=" },
  submittedAfter: { column: "submission.submitted_at", op: ">=" },
  submittedBefore: { column: "submission.submitted_at", op: "<=" },
  // 至多不得分数（<=），与列表查询参数 maxIssueCount 同名同义；修正曾用名 issueCountAtLeast 的方向反转（2026-10-11）
  maxIssueCount: { column: "submission.issue_count", op: "<=" },
});
export function buildSubmissionExportFilterConditions(filters) {
  return Object.keys(SUBMISSION_EXPORT_FILTER_RULES)
    .filter((key) => filters?.[key] !== undefined && filters?.[key] !== null)
    .map((key) => ({ ...SUBMISSION_EXPORT_FILTER_RULES[key], value: filters[key] }));
}
export const ExportRequestSchema = z.object({
  submissionId: SecureUuidSchema.optional(),
  kind: z.enum(["submissions", "dashboard"]).default("submissions"),
  filters: z.object({
    campaignId: SecureUuidSchema.optional(), storeId: SecureUuidSchema.optional(), inspectorId: SecureUuidSchema.optional(),
    submittedAfter: z.string().datetime().optional(), submittedBefore: z.string().datetime().optional(),
    // 至多不得分数（<=），与列表查询参数 maxIssueCount 同名同义；修正曾用名 issueCountAtLeast 的方向反转（2026-10-11）
    maxIssueCount: z.number().int().min(0).optional(),
  }).strict().default({}),
  dashboardFilters: DashboardFilterSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.filters.submittedAfter && value.filters.submittedBefore && new Date(value.filters.submittedAfter) > new Date(value.filters.submittedBefore)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["filters", "submittedBefore"], message: "结束时间不能早于开始时间" });
  if (value.kind === "dashboard" && !value.dashboardFilters) context.addIssue({ code: z.ZodIssueCode.custom, path: ["dashboardFilters"], message: "看板导出需要筛选条件" });
});
export const ReceiptUploadInitSchema = z.object({
  attachment: ReceiptAttachmentSchema,
  uploadTarget: z.object({ url: z.string().url(), method: z.enum(["POST", "PUT"]), fileFieldName: z.string().min(1), formData: z.record(z.string(), z.string()).default({}), expiresAt: z.string().datetime() }),
  revision: RevisionSchema,
});
export const ReceiptAttachmentMutationSchema = z.object({
  attachment: ReceiptAttachmentSchema.optional(),
  items: z.array(ReceiptAttachmentSchema).max(9).optional(),
  dishes: z.array(z.lazy(() => DishRecordSchema)).optional(),
  revision: RevisionSchema,
});
export const ReceiptOcrJobSchema = z.object({
  id: IdSchema,
  status: z.enum(RECEIPT_OCR_STATUS),
  recognizedDishCount: z.number().int().nonnegative(),
  reviewFieldCount: z.number().int().nonnegative(),
  userMessage: z.string(),
});

// 闪光点结构化条目（探员端保存请求）：id 为客户端生成的安全 UUID（服务端按 id upsert，
// 归属校验失败显式 404，与 dish_records 的客户端 id 约定一致）；text 可为空串——
// 「只有照片没有文字」的条目允许保存（照片不能被静默丢弃），但提交时会被文字校验拦下。
export const HighlightEntryWriteSchema = z.object({ id: SecureUuidSchema, text: z.string().trim().max(2000) });
// 每次保存最多 5 条闪光点；photos 字段仅为响应 DTO（保存请求不携带照片，照片走独立三步直传）。
export const HIGHLIGHT_ENTRY_LIMIT = 5;
export const HIGHLIGHT_PHOTO_LIMIT = 4;

export const DishRecordSchema = z.object({
  id: IdSchema,
  requirementId: IdSchema.nullable(),
  plannedName: z.string().nullable(),
  actualName: z.string().nullable(),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().min(0).max(999999999).nullable(),
  lineTotalCents: z.number().int().min(0).max(999999999).nullable(),
  fulfillmentStatus: z.enum(["ordered", "substituted", "unavailable", "skipped", "extra"]),
  substitutionReason: z.string().nullable().optional(),
  unavailableReason: z.string().nullable().optional(),
  evaluation: z.string().nullable(),
  fullySatisfied: z.boolean(),
  source: z.enum(["manual", "ocr"]),
  manuallyModified: z.boolean(),
  priceDerived: z.boolean(),
  reviewFields: z.array(z.string()),
  required: z.boolean().optional(),
  allowSubstitution: z.boolean().optional(),
}).passthrough();
export const ReceiptOcrApplySchema = z.object({ job: ReceiptOcrJobSchema, dishes: z.array(DishRecordSchema), revision: RevisionSchema });
export const DishSaveRequestSchema = z.object({ dishes: z.array(DishRecordSchema), revision: RevisionSchema });
// 其他记录保存：suggestion/highlights 键缺省 = 不改动对应维度（探员端第二步只存闪光点、
// 第三步只存建议，互不覆盖）；highlight 为历史单条文字列（只写兼容值，不再作为提交必填）。
// highlights 出现时按数组整体替换（按 id upsert、缺失 id 删除），文字为空且无照片的条目被忽略。
export const OtherRecordSaveRequestSchema = z.object({
  highlight: z.string().trim().max(2000).optional(),
  suggestion: z.string().trim().max(2000).optional(),
  highlights: z.array(HighlightEntryWriteSchema).max(HIGHLIGHT_ENTRY_LIMIT).optional(),
  revision: RevisionSchema,
});
// 闪光点照片三步直传（与消费小票同构）：文件元数据同小票契约，但 sha256 可选——
// 小程序运行时读全文件计算校验和代价高；提供时与服务端 verifyObject 计算值对账，
// 缺失时以服务端对存储对象的实际校验为唯一事实源（init 不带、complete 可带）。
export const HighlightPhotoFileMetaSchema = z.object({
  clientFileId: SecureUuidSchema, fileName: z.string().min(1), mimeType: z.enum(["image/jpeg", "image/png"]),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, "文件校验和格式不正确").optional(),
});
export const HighlightPhotoInitRequestSchema = z.object({ fileMeta: HighlightPhotoFileMetaSchema, revision: RevisionSchema });
export const HighlightPhotoCompleteRequestSchema = z.object({ fileMeta: HighlightPhotoFileMetaSchema, revision: RevisionSchema });
export const HighlightPhotoDeleteRequestSchema = z.object({ revision: RevisionSchema });
// 说明：其他记录/闪光点照片各端点的响应均为轻量 { revision }（照片视图内联于草稿 DTO 的
// otherRecords.highlights，无独立响应 schema）；complete 的 202 中间态返回 { id, status:"verifying", revision }，
// 由客户端校验器按联合形态断言，不在此重复定义死模型。

const ComparisonDishSchema = z.object({
  id: IdSchema.optional(), name: z.string(), quantity: z.number().positive().nullable().optional(),
  unitPriceCents: z.number().int().nonnegative().nullable(), lineTotalCents: z.number().int().nonnegative().nullable(),
  source: z.enum(["manual", "ocr"]).optional(), manuallyModified: z.boolean().optional(), priceDerived: z.boolean().optional(),
  removed: z.boolean().optional(), reviewFields: z.array(z.string()).optional(),
});
export const AdminReceiptComparisonSchema = z.object({
  receipts: z.array(z.object({
    id: IdSchema, displayOrder: z.number().int().positive(), thumbnailUrl: z.string().url().nullable(), previewUrl: z.string().url().nullable(),
    previewStatus: z.enum(["ready", "restoring", "unavailable"]), restoreExpiresAt: z.string().datetime().nullable(),
  })),
  ocrCandidates: z.array(ComparisonDishSchema),
  finalDishes: z.array(ComparisonDishSchema),
  receiptTotals: z.object({ recognizedCents: z.number().int().nonnegative().nullable(), finalCents: z.number().int().nonnegative().nullable(), differenceCents: z.number().int().nullable() }),
  differences: z.array(z.object({ kind: z.enum(["manual_added", "ocr_removed", "price_changed", "quantity_changed", "name_changed", "derived", "manual_modified"]), label: z.string(), candidateName: z.string().nullable().optional(), finalName: z.string().nullable().optional(), amountDifferenceCents: z.number().int().nullable().optional() })),
});
export const ArchiveRestoreStatusSchema = z.object({ id: IdSchema, status: z.enum(["ready", "restoring", "unavailable"]), expiresAt: z.string().datetime().nullable().optional() });
export const SubmissionDetailSchema = z.object({
  taskName: z.string().optional(), storeName: z.string().optional(), inspectorName: z.string().optional(), submittedAt: z.string().optional(),
  questionnaireName: z.string(), versionLabel: z.string().optional(), totalScore: z.number(), scoreRate: z.string(), issueCount: z.number(),
  categoryScores: z.array(z.object({ category: z.string(), categoryName: z.string().optional(), scoreRate: z.string(), score: z.number().optional() })).optional(),
  highlight: z.string(), suggestion: z.string().nullable().optional(),
  // 结构化闪光点（新提交快照携带）；历史提交缺省时调用方按 highlight 单条兜底。
  highlights: z.array(z.object({
    id: IdSchema, text: z.string(),
    photos: z.array(z.object({ id: IdSchema, previewUrl: z.string().url().nullable() })).optional(),
  })).optional(),
  dishes: z.array(DishRecordSchema).optional(),
  receiptComparison: AdminReceiptComparisonSchema.optional(),
  questions: z.array(z.object({ id: IdSchema, number: z.number().int(), text: z.string(), answer: z.enum(["scored", "unscored"]), issueRemark: z.string().optional(), previewUrls: z.array(z.string().url()).optional(), attachments: z.array(z.object({ id: IdSchema, type: z.enum(["image", "audio"]), previewUrl: z.string().url(), durationSeconds: z.number().optional() })).optional() })),
  auditLogs: z.array(z.object({ id: IdSchema, createdAt: z.string(), actorName: z.string(), actionLabel: z.string() })).optional(),
});

export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string().optional(), requestId: z.string().min(1), retryable: z.boolean().optional(), requiresNewToken: z.boolean().optional(), issues: z.array(z.object({ path: z.string(), message: z.string() })).optional() }),
});

export function parseResponse(schema, value) {
  return schema.parse(value);
}

export const STATUS_LABELS = Object.freeze({
  pending_approval: "待审核",
  approved_active: "已启用",
  rejected: "未通过",
  disabled: "已停用",
  draft: "待发布",
  published: "待开始",
  assigned: "待开始",
  in_progress: "进行中",
  submitted: "已提交",
  overdue: "已逾期",
  cancelled: "已取消",
  // 以下为导出任务状态语义（导出中心/看板导出），failed 也按导出语义展示
  queued: "排队中",
  processing: "处理中",
  succeeded: "已生成",
  expired: "已过期",
  failed: "导出失败",
});

export function toStatusLabel(status) {
  return STATUS_LABELS[status] || "状态待确认";
}
