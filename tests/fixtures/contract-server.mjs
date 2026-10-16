import { createServer } from "node:http";

const port = Number(process.env.CONTRACT_PORT || 8787);
const adminOrigin = process.env.ADMIN_ORIGIN || "http://127.0.0.1:4174";
const cors = { "Access-Control-Allow-Origin": adminOrigin, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token, Idempotency-Key", "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS" };
const roles = { super: "super_admin", ops: "operations_admin", reviewer: "reviewer", store: "store_manager" };
// 与生产 rbac 种子一致的权限集合（operations_admin 不含 audit:read）
const opsPermissions = ["registration:review", "user:disable", "user:manage", "store:manage", "campaign:manage", "questionnaire:manage", "submission:read", "evidence:read", "export:create", "checkin:exempt", "stats:read"];
const rolePermissions = { super_admin: [...opsPermissions, "audit:read"], operations_admin: opsPermissions, reviewer: opsPermissions, store_manager: ["store:manage", "submission:read"] };
const permissionsFor = (role) => rolePermissions[role] || opsPermissions;
const miniSession = { accessToken: "test-access-token", user: { id: "user-inspector-one", displayName: "周雨晴", status: "approved_active" } };
const miniQuestions = Array.from({ length: 50 }, (_, index) => ({
  id: `question-${index + 1}`,
  number: index + 1,
  score: 2,
  category: index < 20 ? "environment" : index < 42 ? "service" : "product",
  text: `第 ${index + 1} 题检查内容`,
  evidence: { evidenceRequired: index === 1, imageRequired: index === 1, audioRequired: false },
}));
const miniAnswers = Object.fromEntries(miniQuestions.map((question) => [question.id, {
  answer: question.id === "question-2" ? "unscored" : "scored",
  remark: question.id === "question-2" ? "入口地面有少量水渍" : "",
  attachments: question.id === "question-2" ? [{ id: "evidence-one", type: "image", status: "active", previewUrl: "fixture://evidence-one" }] : [],
  revision: 1,
}]));
const miniAssignment = {
  id: "assignment-one", name: "夏季门店服务品质暗访", storeName: "静安嘉里中心店", taskType: "secret", status: "in_progress",
  startsAt: "2026-07-24T09:00:00+08:00", dueAt: "2026-07-24T22:00:00+08:00", budgetLimit: 500, revision: 3,
  address: "南京西路 1515 号", windowLabel: "今天 09:00–22:00", budgetLabel: "不超过 500 元", statusLabel: "进行中", cancelReason: null,
  commonInstruction: "请保持自然就餐，重点观察高峰期服务。", specialInstruction: "关注迎宾与巡台服务。", receiptRequired: true,
  questionnaireVersion: { id: "version-one", name: "暗访问卷", versionLabel: "2026 夏季版", questionCount: 12 },
  attempt: { id: "attempt-one", status: "in_progress", revision: 4 },
  dishRequirements: [
    { id: "requirement-one", plannedName: "招牌烤鸭", quantity: 1, required: true, allowSubstitution: false, instruction: "记录温度和口感" },
    { id: "requirement-two", plannedName: "蟹粉豆腐", quantity: 1, required: false, allowSubstitution: true, instruction: "记录替代原因" },
    { id: "requirement-three", plannedName: "桂花糖藕", quantity: 1, required: false, allowSubstitution: false, instruction: "如售罄请记录原因" },
    { id: "requirement-four", plannedName: "时令蔬菜", quantity: 1, required: false, allowSubstitution: false, instruction: "可按现场情况选择" },
  ],
};
const miniDraft = {
  assignment: miniAssignment,
  attempt: miniAssignment.attempt,
  questionnaireVersion: miniAssignment.questionnaireVersion,
  questions: miniQuestions,
  answers: miniAnswers,
  dishRequirements: miniAssignment.dishRequirements,
  dishes: [
    { id: "dish-one", requirementId: "requirement-one", plannedName: "招牌烤鸭", actualName: "招牌烤鸭", quantity: 1, unitPriceCents: 26800, lineTotalCents: 26800, fulfillmentStatus: "ordered", evaluation: "温度适宜，口感良好", fullySatisfied: true, required: true, allowSubstitution: false, source: "ocr", manuallyModified: false, priceDerived: false, reviewFields: [] },
    { id: "dish-two", requirementId: "requirement-two", plannedName: "蟹粉豆腐", actualName: "菌菇豆腐", quantity: 1, unitPriceCents: 6800, lineTotalCents: 6800, fulfillmentStatus: "substituted", substitutionReason: "蟹粉当日缺货", evaluation: "口感清淡", fullySatisfied: false, required: false, allowSubstitution: true, source: "manual", manuallyModified: true, priceDerived: false, reviewFields: [] },
    { id: "dish-three", requirementId: "requirement-three", plannedName: "桂花糖藕", actualName: "", quantity: 1, unitPriceCents: null, lineTotalCents: null, fulfillmentStatus: "unavailable", unavailableReason: "晚市已售罄", evaluation: "", fullySatisfied: false, required: false, allowSubstitution: false, source: "manual", manuallyModified: false, priceDerived: false, reviewFields: [] },
    { id: "dish-four", requirementId: "requirement-four", plannedName: "时令蔬菜", actualName: "", quantity: 1, unitPriceCents: null, lineTotalCents: null, fulfillmentStatus: "skipped", unavailableReason: "", evaluation: "", fullySatisfied: false, required: false, allowSubstitution: false, source: "manual", manuallyModified: false, priceDerived: false, reviewFields: [] },
    { id: "dish-five", requirementId: null, plannedName: null, actualName: "酒酿圆子", quantity: 1, unitPriceCents: 3800, lineTotalCents: 3800, fulfillmentStatus: "extra", evaluation: "甜度适中", fullySatisfied: true, required: false, allowSubstitution: false, source: "ocr", manuallyModified: true, priceDerived: false, reviewFields: [] },
  ],
  otherRecords: { highlight: "员工主动巡台并及时补充餐具", suggestion: "高峰期增加入口引导" },
};

// 单份问卷导出任务：详情页发起的 submissionId 导出走固定任务号，前两次轮询返回排队/生成中，之后成功
const singleExportJobId = "55555555-5555-5555-8555-555555555555";
let singleExportPolls = 0;
let receiptRevision = 4;
let receiptSequence = 1;
let receiptAttachments = [
  { id: "receipt-one", displayOrder: 1, previewUrl: "https://images.example.test/receipt-one.jpg", status: "ready", progressPercent: 100, failureKind: null, canRetry: false, canDelete: true, dishImpact: "mixed", appliedDishCount: 2 },
  { id: "receipt-failed", displayOrder: 2, previewUrl: null, status: "failed", progressPercent: 18, failureKind: "upload_interrupted", canRetry: true, canDelete: true, dishImpact: "none", appliedDishCount: 0 },
];
const receiptJobs = new Map();
const appliedJobs = new Map();
let questionnaireVersionSequence = 0;
const questionnaireVersions = [
  { id: "version-one", name: "暗访问卷", versionLabel: "2026 夏季版", enabledQuestionCount: 50, numberingValid: true, status: "published", createdAt: "2026-07-01T08:00:00Z", revision: 1 },
  { id: "version-draft", name: "秋季暗访问卷", versionLabel: "2026 秋季草稿版", enabledQuestionCount: 3, numberingValid: true, status: "draft", createdAt: "2026-08-01T08:00:00Z", revision: 0 },
  { id: "version-check-fail", name: "发布检查未过草稿", versionLabel: "V3", enabledQuestionCount: 2, numberingValid: true, status: "draft", createdAt: "2026-08-05T08:00:00Z", revision: 0 },
];

function receiptDishResult(partial = false) {
  return [
    { ...miniDraft.dishes[0], source: "ocr", reviewFields: [] },
    { ...miniDraft.dishes[1], actualName: "蟹粉豆腐", fulfillmentStatus: "ordered", substitutionReason: "", source: "ocr", manuallyModified: false, unitPriceCents: 6800, lineTotalCents: 6800, reviewFields: partial ? ["unitPriceCents"] : [] },
    { id: "dish-ocr-extra", requirementId: null, plannedName: null, actualName: "酒酿圆子", quantity: 1, unitPriceCents: 3800, lineTotalCents: 3800, fulfillmentStatus: "extra", substitutionReason: "", unavailableReason: "", evaluation: "", fullySatisfied: true, required: false, allowSubstitution: false, source: "ocr", manuallyModified: false, priceDerived: false, reviewFields: [] },
    ...miniDraft.dishes.slice(2, 4),
  ];
}
const adminReceiptComparison = {
  receipts: [
    { id: "receipt-one", displayOrder: 1, thumbnailUrl: "https://placehold.co/320x220/f2eee9/7b7068?text=Receipt+1", previewUrl: "https://placehold.co/1200x1600/f2eee9/554c46?text=Receipt+Original", previewStatus: "ready", restoreExpiresAt: null },
    { id: "receipt-two", displayOrder: 2, thumbnailUrl: "https://placehold.co/320x220/f2eee9/7b7068?text=Receipt+2", previewUrl: null, previewStatus: "unavailable", restoreExpiresAt: null },
  ],
  ocrCandidates: [
    { id: "candidate-one", name: "招牌烤鸭", quantity: 1, unitPriceCents: 26800, lineTotalCents: 26800, source: "ocr", manuallyModified: false, priceDerived: false, removed: false, reviewFields: [] },
    { id: "candidate-two", name: "蟹黄豆腐", quantity: 1, unitPriceCents: 6600, lineTotalCents: 6600, source: "ocr", manuallyModified: false, priceDerived: false, removed: true, reviewFields: ["actualName"] },
    { id: "candidate-three", name: "酒酿圆子", quantity: 1, unitPriceCents: null, lineTotalCents: 3800, source: "ocr", manuallyModified: false, priceDerived: true, removed: false, reviewFields: ["unitPriceCents"] },
  ],
  finalDishes: [
    { id: "final-one", name: "招牌烤鸭", quantity: 1, unitPriceCents: 26800, lineTotalCents: 26800, source: "ocr", manuallyModified: false, priceDerived: false, removed: false, reviewFields: [] },
    { id: "final-two", name: "蟹粉豆腐", quantity: 1, unitPriceCents: 6800, lineTotalCents: 6800, source: "ocr", manuallyModified: true, priceDerived: false, removed: false, reviewFields: [] },
    { id: "final-three", name: "酒酿圆子", quantity: 1, unitPriceCents: 3800, lineTotalCents: 3800, source: "ocr", manuallyModified: true, priceDerived: false, removed: false, reviewFields: [] },
    { id: "final-four", name: "时令水果", quantity: 1, unitPriceCents: 2800, lineTotalCents: 2800, source: "manual", manuallyModified: true, priceDerived: false, removed: false, reviewFields: [] },
  ],
  receiptTotals: { recognizedCents: 37200, finalCents: 40200, differenceCents: 3000 },
  differences: [
    { kind: "name_changed", label: "菜名已校正", candidateName: "蟹黄豆腐", finalName: "蟹粉豆腐", amountDifferenceCents: 200 },
    { kind: "manual_added", label: "人工新增菜品", candidateName: null, finalName: "时令水果", amountDifferenceCents: 2800 },
    { kind: "manual_modified", label: "价格已人工核对", candidateName: "酒酿圆子", finalName: "酒酿圆子", amountDifferenceCents: 0 },
  ],
};

function send(response, status, body, headers = {}) { response.writeHead(status, { ...cors, "Content-Type": "application/json; charset=utf-8", ...headers }); response.end(body === null ? "" : JSON.stringify(body)); }
function readBody(request) { return new Promise((resolve) => { let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => resolve(body ? JSON.parse(body) : {})); }); }
function session(request) { const match = request.headers.cookie?.match(/adminRole=([^;]+)/); return match?.[1] || ""; }
function list(items) { return { items }; }
// 游标分页（与后端契约一致）：limit 默认 20 上限 100；cursor=上一页最后一条 id，定位其后；
// order asc|desc 按 id 字典序模拟时间序，缺省 asc（与后端 listOrder「默认 asc 保持既有行为」一致）；
// 多取一条探测到底，本页不足一页时 nextCursor=null。exports/audit-logs 由调用方固定 desc。
function paged(url, items, forcedOrder) {
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Math.min(Number.isFinite(limitRaw) && limitRaw >= 1 ? limitRaw : 20, 100);
  const order = forcedOrder || (url.searchParams.get("order") === "desc" ? "desc" : "asc");
  const sorted = [...items].sort((a, b) => (order === "asc" ? 1 : -1) * String(a.id).localeCompare(String(b.id)));
  const cursor = url.searchParams.get("cursor");
  const start = cursor ? sorted.findIndex((item) => item.id === cursor) + 1 : 0;
  const window = sorted.slice(Math.max(start, 0), Math.max(start, 0) + limit + 1);
  const hasMore = window.length > limit;
  return { items: window.slice(0, limit), nextCursor: hasMore ? window[limit - 1].id : null };
}

// 压测数据：门店/探员各超 100 条，验证列表与选择器跨页游标加载。
// 门店 id 用 store-z1xx（asc/desc 都排在既有字母 id 之后）、探员 id 用 user-inspector-1xx（desc 排在
// user-inspector-one/two 之后），保证既有用例依赖的原始数据始终落在首屏前 100 条。
const REGION_JINGAN = "33333333-3333-4333-8333-333333333333";
const REGION_PUDONG = "44444444-4444-4444-8444-444444444444";
const REGION_CITY = "22222222-2222-4222-8222-222222222222";
const bulkStores = Array.from({ length: 127 }, (_, index) => ({
  id: `store-z${101 + index}`,
  name: `压测门店 ${101 + index} 号店`,
  businessNo: `JD-SH-${101 + index}`,
  brandId: null,
  brandName: null,
  cityRegionId: REGION_CITY,
  cityName: "上海市市辖区",
  regionId: index % 2 === 0 ? REGION_JINGAN : REGION_PUDONG,
  regionName: index % 2 === 0 ? "静安区" : "浦东新区",
  address: "静安区南京西路 1515 号",
  active: true,
  locationVerified: true,
  radiusMeters: 300,
  latitudeGcj02: 31.2265,
  longitudeGcj02: 121.4452,
  accuracyAllowanceMaxMeters: 150,
  revision: 2,
}));
const adminStores = [
  { id: "store-one", name: "静安嘉里中心店", businessNo: "JD-SH-001", brandId: "1a6fd7a0-1111-4111-8111-000000000001", brandName: "建新园", cityRegionId: REGION_CITY, cityName: "上海市市辖区", regionId: REGION_JINGAN, regionName: "静安区", address: "静安区南京西路 1515 号", active: true, locationVerified: true, radiusMeters: 300, latitudeGcj02: 31.2265, longitudeGcj02: 121.4452, accuracyAllowanceMaxMeters: 150, revision: 2 },
  { id: "store-three", name: "静安大融城店", businessNo: "JD-SH-001", brandId: "1a6fd7a0-1111-4111-8111-000000000001", brandName: "建新园", cityRegionId: REGION_CITY, cityName: "上海市市辖区", regionId: REGION_JINGAN, regionName: "静安区", address: "静安区南京西路 1515 号", active: true, locationVerified: true, radiusMeters: 300, latitudeGcj02: 31.2265, longitudeGcj02: 121.4452, accuracyAllowanceMaxMeters: 150, revision: 2 },
  { id: "store-two", name: "浦东世纪公园店", businessNo: "JD-SH-002", brandId: null, brandName: null, cityRegionId: REGION_CITY, cityName: "上海市市辖区", regionId: REGION_JINGAN, regionName: "静安区", address: "静安区南京西路 1515 号", active: true, locationVerified: true, radiusMeters: 300, latitudeGcj02: 31.2265, longitudeGcj02: 121.4452, accuracyAllowanceMaxMeters: 150, revision: 2 },
  ...bulkStores,
];
const adminAdminUsers = [{ id: "admin-one", username: "admin", displayName: "管理员", maskedPhone: "138****0000", roleCode: "admin", scopeType: "all", scopeLabel: "全部", regionId: null, storeId: null, source: "manual", status: "approved_active", revision: 1 }];
const adminInspectors = [
  { id: "user-inspector-one", username: "zhoushu", displayName: "周雨晴", maskedPhone: "136****7719", roleCode: "inspector", scopeType: null, scopeLabel: null, regionId: null, storeId: null, source: "registration", status: "approved_active", revision: 1 },
  { id: "user-inspector-two", username: "linxiao", displayName: "林晓峰", maskedPhone: "137****2210", roleCode: "inspector", scopeType: null, scopeLabel: null, regionId: null, storeId: null, source: "registration", status: "approved_active", revision: 1 },
  ...Array.from({ length: 128 }, (_, index) => ({
    id: `user-inspector-${101 + index}`,
    username: `stress${101 + index}`,
    displayName: `压测探员 ${101 + index} 号`,
    maskedPhone: `137****${String(2210 + index).slice(-4)}`,
    roleCode: "inspector",
    scopeType: null,
    scopeLabel: null,
    regionId: null,
    storeId: null,
    source: "manual",
    status: "approved_active",
    revision: 1,
  })),
];
const adminRegistrations = [
  { id: "registration-one", displayName: "周雨晴", username: "zhouyuqing", maskedPhone: "138****1208", appliedAt: "2026-07-19T08:00:00Z", status: "pending_approval", revision: 1 },
  { id: "registration-two", userId: "user-two", displayName: "陈一帆", username: "chenyifan", maskedPhone: "139****2331", appliedAt: "2026-07-18T08:00:00Z", status: "approved_active", revision: 2 },
  { id: "registration-three", displayName: "孙可欣", username: "sunkeixin", maskedPhone: "137****8802", appliedAt: "2026-07-17T08:00:00Z", status: "rejected", revision: 3 },
  { id: "registration-four", userId: "user-four", displayName: "赵书瑞", username: "zhaoshurui", maskedPhone: "136****7719", appliedAt: "2026-07-16T08:00:00Z", status: "disabled", revision: 4 },
];
// 已取消的测试任务（super_admin 清理流程用）：无任何提交/作业，可安全清理。
const cleanupCampaign = { id: "campaign-clean", name: "已取消的测试任务", businessNo: "JD-CLEAN-001", storeName: "静安嘉里中心店", startsAt: "2026-07-01T10:00:00Z", dueAt: "2026-07-02T14:00:00Z", assignmentCount: 2, overdueCount: 0, status: "cancelled", revision: 4 };
let cleanupUsed = false; // 清理完成后列表行移除（幂等预览仍可回放，供断言）

const adminCampaigns = [{ id: "campaign-one", name: "夏季门店服务品质暗访", businessNo: "JD-20260719-018", storeName: "静安嘉里中心店", startsAt: "2026-07-19T10:00:00Z", dueAt: "2026-07-19T14:00:00Z", assignmentCount: 3, overdueCount: 0, status: "draft", revision: 3 }, cleanupCampaign];
// campaign-one 指派表：assignment-extend 为延期用例专用行（既有用例不断言其截止时间），
// extend 端点把新截止写进 extendState，GET 详情时合并回显（进程内共享，测试间依次生效）。
const campaignAssignments = [
  { id: "assignment-one", inspectorId: "user-inspector-one", inspectorName: "周雨晴", questionnaireVersionId: "version-one", taskType: "secret", questionnaireName: "暗访问卷 2026 夏季版", startsAt: "2026-07-19T10:00:00Z", dueAt: "2026-07-19T14:00:00Z", budgetLimit: 500, receiptRequired: true, specialInstruction: "关注迎宾与巡台", dishRequirements: [{ id: "requirement-one", recordId: "requirement-one", plannedName: "招牌烤鸭", quantity: 1, required: true, allowSubstitution: false }], status: "assigned", revision: 1 },
  { id: "assignment-extend", inspectorId: "user-inspector-101", inspectorName: "压测探员 101 号", questionnaireVersionId: "version-one", taskType: "secret", questionnaireName: "暗访问卷 2026 夏季版", startsAt: "2026-07-19T10:00:00Z", dueAt: "2026-07-19T13:30:00Z", questionnaireDeadlineAt: "2026-07-19T20:00:00Z", budgetLimit: 400, receiptRequired: false, specialInstruction: "重点观察收银流程", dishRequirements: [], status: "assigned", revision: 1 },
];
const extendState = new Map();
// 题库有状态存储（GET 返回当前数组，PATCH 乐观锁递增 revision；发布后冻结）——
// 供「同一编辑器连续两次保存取最新 revision」「发布后只读」「丢弃编辑恢复服务端值」等路由回归使用。
const questionSets = {
  "version-one": Array.from({ length: 50 }, (_, index) => ({ id: `question-${index + 1}`, number: index + 1, category: index < 20 ? "environment" : index < 42 ? "service" : "product", text: `第 ${index + 1} 题检查内容`, maxScore: 2, enabled: true, scoreWipe: false, revision: 1, evidence: { evidenceRequired: index === 1, imageRequired: index === 1, audioRequired: false } })),
  "version-draft": [
    { id: "draft-question-1", number: 1, category: "environment", categoryName: "环境卫生", text: "门店门头是否整洁", maxScore: 2, enabled: true, scoreWipe: false, revision: 1, evidence: { evidenceRequired: false, imageRequired: false, audioRequired: false } },
    { id: "draft-question-2", number: 2, category: "environment", categoryName: "环境卫生", text: "地面是否干净无杂物", maxScore: 2, enabled: true, scoreWipe: false, revision: 1, evidence: { evidenceRequired: false, imageRequired: false, audioRequired: false } },
    { id: "draft-question-3", number: 3, category: "service", categoryName: "为客服务", text: "迎宾是否主动招呼", maxScore: 2, enabled: true, scoreWipe: false, revision: 1, evidence: { evidenceRequired: false, imageRequired: false, audioRequired: false } },
  ],
  "version-check-fail": [
    { id: "check-fail-question-1", number: 1, category: "environment", categoryName: "环境卫生", text: "门店门头是否整洁", maxScore: 2, enabled: true, scoreWipe: true, revision: 1, evidence: { evidenceRequired: false, imageRequired: false, audioRequired: false } },
    { id: "check-fail-question-2", number: 2, category: "environment", categoryName: "环境卫生", text: "地面是否干净无杂物", maxScore: 2, enabled: true, scoreWipe: true, revision: 1, evidence: { evidenceRequired: false, imageRequired: false, audioRequired: false } },
  ],
};
const questionSetsPublished = new Set();
// 新建问卷（POST 创建的 version-created-N）的题目快照：详情路由深链接/刷新可回读。
const createdQuestionSets = new Map();
// campaign-two 的指派存储：POST 创建的指派落入详情，供向导 ?step=3 刷新后回读。
const campaignTwoAssignments = [];
const mergeAssignment = (row) => {
  const extended = extendState.get(row.id);
  return extended
    ? { ...row, ...(extended.dueAt ? { dueAt: extended.dueAt } : {}), ...(extended.questionnaireDeadlineAt ? { questionnaireDeadlineAt: extended.questionnaireDeadlineAt } : {}), revision: extended.revision }
    : row;
};
const adminSubmissions = [{ id: "submission-one", taskName: "夏季门店服务品质暗访", businessNo: "JD-20260719-018", storeName: "静安嘉里中心店", regionName: "静安区", inspectorName: "周雨晴", status: "submitted", submittedAt: "2026-07-19T13:20:00Z", scoreRate: "94%", issueCount: 3, highRiskCount: 1 }];
const adminAudits = [{ id: "audit-one", createdAt: "2026-07-19T09:00:00Z", actorName: "测试管理员", actionLabel: "批准注册申请", subjectLabel: "探店员 周雨晴", resultLabel: "已完成" }];

// —— 有状态门店/品牌（编辑器恢复流程用）：创建落入列表与详情、PATCH 乐观锁推进 revision ——
const fixtureBrands = [
  { id: "1a6fd7a0-1111-4111-8111-000000000001", name: "建新园", active: true, storeCount: 1, revision: 1 },
  { id: "1a6fd7a0-1111-4111-8111-000000000002", name: "停用示例品牌", active: false, storeCount: 0, revision: 1 },
];
let brandSeq = 0;
let storeSeq = 0;
const createdStores = [];
// 初始快照：/__test/reset 恢复被用例改写的门店/品牌（跨用例互不污染）
const initialStoresSnapshot = JSON.parse(JSON.stringify(adminStores));
const initialBrandsSnapshot = JSON.parse(JSON.stringify(fixtureBrands));
const allStores = () => [...adminStores, ...createdStores];
const storeRowFrom = (body, id, revision) => ({
  id,
  name: body.name,
  businessNo: body.businessNo,
  brandId: body.brandId || null,
  brandName: fixtureBrands.find((brand) => brand.id === body.brandId)?.name || null,
  cityRegionId: REGION_CITY,
  cityName: "上海市市辖区",
  regionId: body.regionId || REGION_JINGAN,
  regionName: "静安区",
  address: body.address,
  active: body.active !== false,
  locationVerified: Boolean(body.locationVerified),
  radiusMeters: body.radiusMeters ?? 300,
  latitudeGcj02: body.latitudeGcj02 ?? null,
  longitudeGcj02: body.longitudeGcj02 ?? null,
  accuracyAllowanceMaxMeters: body.accuracyAllowanceMaxMeters ?? 200,
  providerPoiId: body.providerPoiId ?? null,
  coordinateSource: body.coordinateSource ?? null,
  revision,
});

// 完整复位：故障计数 + 清理用例状态（测试进程可能复用同一固件服务）
const resetFixtureState = () => {
  resetTestControl();
  cleanupUsed = false;
  const index = adminCampaigns.findIndex((row) => row.id === "campaign-clean");
  if (index === -1) adminCampaigns.push(cleanupCampaign);
  adminStores.splice(0, adminStores.length, ...JSON.parse(JSON.stringify(initialStoresSnapshot)));
  createdStores.length = 0;
  storeSeq = 0;
  fixtureBrands.splice(0, fixtureBrands.length, ...JSON.parse(JSON.stringify(initialBrandsSnapshot)));
  brandSeq = 0;
};

// —— 可注入故障/场景控制（仅测试固件）：POST /__test/control 设置计数器，/__test/reset 复位 ——
// 计数器语义：每命中一次递减，归零后恢复正常行为，供「失败一次后重试成功」类断言使用。
const testControl = {
  meFailures: 0, // /api/me 返回 503（初始恢复失败 → 重试页）
  expireOnMe: 0, // /api/me 返回 401（编辑中会话过期 → 登录遮罩）
  csrfRejects: 0, // 管理端变更请求 403 CSRF_INVALID（客户端刷新令牌后单次重试）
  storeSaveConflicts: 0, // 门店保存 409 REVISION_CONFLICT（冲突对照流程）
  storeSaveUnauthorized: 0, // 门店保存 401（保存中过期 → 原位重登）
  storeSaveServiceFailures: 0, // 门店保存 503 DATABASE_BUSY（服务失败保留输入 + 原位重试）
  storeSaveUnauthorized: 0, // 门店保存 401（保存中过期 → 原位重登）
  storeSaveUnauthorizedDelayMs: 0, // 门店保存 401 前的延迟（跨标签重认证竞态用例）
  csrfRejectsDelayMs: 0, // CSRF 403 前的延迟（跨标签重认证竞态用例）
  cleanupPreviewUnauthorized: 0, // 清理预览 401（预览过期 → 重登 → 手动重试）
  regionsUnauthorized: 0, // 区域列表 401（门店编辑器区域加载过期）
  regionsFailures: 0, // 区域列表 503（区域加载失败 → 重试）
  storeCreateInvalidResponse: 0, // 新建门店已落库但响应不可用（结果对账：内容一致才自动切换）
  dishRequirementsUnauthorized: 0, // 指派菜品步骤 401（第一段已保存：重试按检查点续跑）
  logoutDelayMs: 0, // 登出响应延迟（被取代的迟到的登出用例）
  storeCreateNetworkDrops: 0, // >0 期间新建门店请求一律断连（跨登录迟到的网络失败用例）
  storeCreateNetworkDropDelayMs: 0, // 断连前的延迟毫秒
  meDelayMs: 0, // /api/me 延迟毫秒（配合 meDelayRequests 使用）
  meDelayRequests: 0, // /api/me 延迟响应的剩余请求数（迟到的成功恢复跨登录竞态用例）
  showCleanupCampaign: 0, // 任务列表包含「已取消的测试任务」行（清理流程用例）
};
const resetTestControl = () => {
  for (const key of Object.keys(testControl)) testControl[key] = 0;
};

createServer(async (request, response) => {
  if (request.method === "OPTIONS") return send(response, 204, null);
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname === "/api/admin/auth/login" && request.method === "POST") {
    const body = await readBody(request); const role = roles[body.username] || "operations_admin";
    return send(response, 200, { user: { id: `admin-${role}`, displayName: body.username === "store" ? "门店负责人" : "测试管理员", role, scopeLabel: role === "store_manager" ? "静安嘉里中心店" : "华东一区", permissions: permissionsFor(role) }, csrfToken: "fixture-csrf-token-000000000000000000000000000000" }, { "Set-Cookie": `adminRole=${role}; Path=/; SameSite=Lax` });
  }
  if (url.pathname === "/api/admin/auth/logout") {
    if (testControl.logoutDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, testControl.logoutDelayMs));
    return send(response, 204, null, { "Set-Cookie": "adminRole=; Path=/; Max-Age=0" });
  }
  if (url.pathname === "/api/auth/login" && request.method === "POST") return send(response, 200, miniSession);
  const miniAuthorized = request.headers.authorization === `Bearer ${miniSession.accessToken}`;
  if (miniAuthorized && url.pathname === "/api/assignments/mine" && request.method === "GET") return send(response, 200, list([
    miniAssignment,
    { ...miniAssignment, id: "assignment-overdue", name: "逾期任务示例", status: "overdue", statusLabel: "已逾期", attempt: null },
    { ...miniAssignment, id: "assignment-submitted", name: "已提交任务示例", status: "submitted", statusLabel: "已提交", submittedAt: "2026-07-23T20:18:00+08:00", attempt: { id: "attempt-submitted", status: "submitted", revision: 8 } },
  ]));
  if (miniAuthorized && url.pathname === "/api/assignments/assignment-one" && request.method === "GET") return send(response, 200, miniAssignment);
  if (miniAuthorized && url.pathname === "/api/assignments/assignment-one/check-in" && request.method === "POST") return send(response, 200, { result: "accepted" });
  if (miniAuthorized && url.pathname === "/api/assignments/assignment-one/start" && request.method === "POST") return send(response, 200, { attempt: miniAssignment.attempt, questionnaireVersion: miniAssignment.questionnaireVersion });
  if (miniAuthorized && url.pathname === "/api/assignments/assignment-one/questionnaire" && request.method === "GET") return send(response, 200, miniDraft);
  if (miniAuthorized && url.pathname === "/api/questionnaires/secret/drafts/attempt-one" && request.method === "GET") return send(response, 200, miniDraft);
  if (miniAuthorized && url.pathname === "/api/questionnaires/secret/drafts/attempt-one/receipt-attachments" && request.method === "GET") return send(response, 200, { items: receiptAttachments, revision: receiptRevision });
  if (miniAuthorized && url.pathname === "/api/questionnaires/secret/drafts/attempt-one/receipt-attachments/uploads" && request.method === "POST") {
    const body = await readBody(request);
    if (body.revision !== receiptRevision) return send(response, 409, { error: { code: "REVISION_CONFLICT" } });
    if (receiptAttachments.length >= 9) return send(response, 422, { error: { code: "RECEIPT_LIMIT_EXCEEDED" } });
    receiptSequence += 1; receiptRevision += 1;
    const attachment = { id: `receipt-${receiptSequence}`, displayOrder: receiptAttachments.length + 1, previewUrl: null, status: "uploading", progressPercent: 0, failureKind: null, canRetry: false, canDelete: true, dishImpact: "none", appliedDishCount: 0 };
    receiptAttachments = [...receiptAttachments, attachment];
    const failure = body.fileMeta?.fileName?.includes("fail-once") ? "?failure=once" : "";
    return send(response, 201, { attachment, uploadTarget: { url: `http://127.0.0.1:${port}/fixture-upload/${attachment.id}${failure}`, method: "POST", fileFieldName: "file", formData: { "x-fixture-upload": "receipt" }, expiresAt: "2026-12-31T00:00:00.000Z" }, revision: receiptRevision });
  }
  if (url.pathname.startsWith("/fixture-upload/") && request.method === "POST") {
    if (url.searchParams.get("failure") === "once" && !receiptJobs.has(`upload:${url.pathname}`)) { receiptJobs.set(`upload:${url.pathname}`, true); return send(response, 503, { error: { code: "FIXTURE_UPLOAD_RETRY" } }); }
    return send(response, 204, null, { ETag: "fixture-etag" });
  }
  const receiptCompleteMatch = url.pathname.match(/^\/api\/questionnaires\/secret\/drafts\/attempt-one\/receipt-attachments\/([^/]+)\/complete$/);
  if (miniAuthorized && receiptCompleteMatch && request.method === "POST") {
    const body = await readBody(request);
    if (body.revision !== receiptRevision) return send(response, 409, { error: { code: "REVISION_CONFLICT" } });
    const index = receiptAttachments.findIndex((item) => item.id === receiptCompleteMatch[1]);
    if (index < 0) return send(response, 404, { error: { code: "NOT_FOUND" } });
    receiptRevision += 1;
    const attachment = { ...receiptAttachments[index], previewUrl: `https://images.example.test/${receiptAttachments[index].id}.jpg`, status: "ready", progressPercent: 100, failureKind: null, canRetry: false };
    receiptAttachments = receiptAttachments.map((item) => item.id === attachment.id ? attachment : item);
    return send(response, 200, { attachment, revision: receiptRevision });
  }
  const receiptDeleteMatch = url.pathname.match(/^\/api\/questionnaires\/secret\/drafts\/attempt-one\/receipt-attachments\/([^/]+)$/);
  if (miniAuthorized && receiptDeleteMatch && request.method === "DELETE") {
    const body = await readBody(request);
    if (body.revision !== receiptRevision) return send(response, 409, { error: { code: "REVISION_CONFLICT" } });
    if (!["remove_unmodified_ocr_rows", "keep_as_manual"].includes(body.dishHandling)) return send(response, 422, { error: { code: "DISH_HANDLING_REQUIRED" } });
    const attachment = receiptAttachments.find((item) => item.id === receiptDeleteMatch[1]);
    if (!attachment) return send(response, 404, { error: { code: "NOT_FOUND" } });
    receiptAttachments = receiptAttachments.filter((item) => item.id !== attachment.id).map((item, index) => ({ ...item, displayOrder: index + 1 })); receiptRevision += 1;
    const dishes = body.dishHandling === "remove_unmodified_ocr_rows" ? miniDraft.dishes.filter((dish) => dish.source !== "ocr" || dish.manuallyModified || dish.requirementId) : miniDraft.dishes.map((dish) => dish.source === "ocr" ? { ...dish, source: "manual", manuallyModified: true } : dish);
    return send(response, 200, { items: receiptAttachments, dishes, revision: receiptRevision });
  }
  if (miniAuthorized && url.pathname === "/api/questionnaires/secret/drafts/attempt-one/receipt-ocr-jobs" && request.method === "POST") {
    const body = await readBody(request);
    if (body.revision !== receiptRevision) return send(response, 409, { error: { code: "REVISION_CONFLICT" } });
    if (!Array.isArray(body.attachmentIds) || !body.attachmentIds.length || !body.idempotencyKey) return send(response, 422, { error: { code: "OCR_INPUT_INVALID" } });
    const existing = [...receiptJobs.values()].find((item) => item.idempotencyKey === body.idempotencyKey);
    if (existing) return send(response, 200, existing.job);
    const scenario = body.idempotencyKey.includes("partial") ? "partial" : body.idempotencyKey.includes("failed") ? "failed" : "success";
    const id = `ocr-job-${receiptJobs.size + 1}`;
    const job = { id, status: "queued", recognizedDishCount: 0, reviewFieldCount: 0, userMessage: "识别任务已排队" };
    receiptJobs.set(id, { idempotencyKey: body.idempotencyKey, scenario, polls: 0, job });
    return send(response, 201, job);
  }
  const receiptJobMatch = url.pathname.match(/^\/api\/questionnaires\/secret\/drafts\/attempt-one\/receipt-ocr-jobs\/([^/]+)$/);
  if (miniAuthorized && receiptJobMatch && request.method === "GET") {
    const state = receiptJobs.get(receiptJobMatch[1]);
    if (!state) return send(response, 404, { error: { code: "NOT_FOUND" } });
    state.polls += 1;
    if (state.polls === 1) state.job = { ...state.job, status: "processing", userMessage: "正在识别消费小票" };
    else if (state.scenario === "failed") state.job = { ...state.job, status: "failed", userMessage: "暂时无法识别这张小票，您仍可以手动填写菜品" };
    else state.job = { ...state.job, status: state.scenario === "partial" ? "partial" : "succeeded", recognizedDishCount: 3, reviewFieldCount: state.scenario === "partial" ? 1 : 0, userMessage: state.scenario === "partial" ? "已带入菜品，请核对价格" : "菜品已识别" };
    return send(response, 200, state.job);
  }
  const receiptApplyMatch = url.pathname.match(/^\/api\/questionnaires\/secret\/drafts\/attempt-one\/receipt-ocr-jobs\/([^/]+)\/apply$/);
  if (miniAuthorized && receiptApplyMatch && request.method === "POST") {
    const body = await readBody(request); const state = receiptJobs.get(receiptApplyMatch[1]);
    if (!state || !["succeeded", "partial"].includes(state.job.status)) return send(response, 422, { error: { code: "OCR_NOT_READY" } });
    if (appliedJobs.has(body.idempotencyKey)) return send(response, 200, appliedJobs.get(body.idempotencyKey));
    if (body.revision !== receiptRevision || String(body.idempotencyKey).includes("conflict")) return send(response, 409, { error: { code: "REVISION_CONFLICT" } });
    receiptRevision += 1;
    const result = { job: state.job, dishes: receiptDishResult(state.scenario === "partial"), revision: receiptRevision };
    appliedJobs.set(body.idempotencyKey, result);
    return send(response, 200, result);
  }
  if (miniAuthorized && /^\/api\/questionnaires\/secret\/drafts\/attempt-one\/answers\//.test(url.pathname) && request.method === "PUT") return send(response, 200, { revision: 5 });
  if (miniAuthorized && /^\/api\/questionnaires\/secret\/drafts\/attempt-one\/questions\/[^/]+\/edit-sessions$/.test(url.pathname) && request.method === "POST") return send(response, 200, { id: "edit-session-one", activeAttachments: [], draftIssueRemark: "入口地面有少量水渍" });
  if (miniAuthorized && url.pathname.includes("/edit-sessions/edit-session-one") && ["PATCH", "POST", "DELETE"].includes(request.method)) return send(response, 200, { status: "ok", revision: 5 });
  if (miniAuthorized && url.pathname === "/api/questionnaires/secret/drafts/attempt-one/dishes" && request.method === "PUT") { const body = await readBody(request); if (body.revision !== receiptRevision) return send(response, 409, { error: { code: "REVISION_CONFLICT" } }); receiptRevision += 1; return send(response, 200, { revision: receiptRevision }); }
  if (miniAuthorized && url.pathname === "/api/questionnaires/secret/drafts/attempt-one/other-records" && request.method === "PUT") { const body = await readBody(request); if (body.revision !== receiptRevision) return send(response, 409, { error: { code: "REVISION_CONFLICT" } }); receiptRevision += 1; return send(response, 200, { revision: receiptRevision, assignmentRevision: 3 }); }
  if (miniAuthorized && url.pathname === "/api/questionnaires/secret/attempt-one/submit" && request.method === "POST") return send(response, 200, { status: "submitted", submittedAt: "2026-07-24T17:30:00+08:00" });
  const role = session(request);
  // —— 测试控制端点（仅固件）：注入故障场景 / 复位 ——
  if (url.pathname === "/__test/control" && request.method === "POST") {
    const body = await readBody(request);
    for (const [key, value] of Object.entries(body)) if (key in testControl) testControl[key] = Number(value) || 0;
    return send(response, 200, { ok: true, testControl });
  }
  if (url.pathname === "/__test/reset" && request.method === "POST") {
    resetFixtureState();
    return send(response, 200, { ok: true });
  }
  if (url.pathname === "/api/public/client-config") return send(response, 200, { captchaAppId: "2026", tencentMapKey: "fixture-map-key", features: { receiptOcr: true } });
  if (url.pathname === "/api/me") {
    console.log(`[fixture] me arrive delayReq=${testControl.meDelayRequests}`);
    if (testControl.meDelayRequests > 0) { testControl.meDelayRequests -= 1; console.log("[fixture] me delayed"); await new Promise((resolve) => setTimeout(resolve, testControl.meDelayMs || 3000)); }
    if (testControl.meFailures > 0) { testControl.meFailures -= 1; return send(response, 503, { error: { code: "SERVICE_DOWN", message: "服务暂时不可用", requestId: "fixture-request", retryable: true } }); }
    if (testControl.expireOnMe > 0 && role) { testControl.expireOnMe -= 1; return send(response, 401, { error: { code: "SESSION_EXPIRED", requestId: "fixture-request" } }); }
    return role ? send(response, 200, { user: { id: `admin-${role}`, displayName: role === "store_manager" ? "门店负责人" : "测试管理员", role, scopeLabel: role === "store_manager" ? "静安嘉里中心店" : "华东一区", permissions: permissionsFor(role) }, csrfToken: "fixture-csrf-token-000000000000000000000000000000" }) : send(response, 401, { error: { code: "SESSION_EXPIRED", requestId: "fixture-request" } });
  }
  if (!role) return send(response, 401, { error: { code: "SESSION_EXPIRED" } });
  // 管理端变更请求的可注入 CSRF 拒绝：发生在任何业务写入之前（与生产行为一致），客户端应刷新令牌后单次重试。
  if (testControl.csrfRejects > 0 && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    testControl.csrfRejects -= 1;
    if (testControl.csrfRejectsDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, testControl.csrfRejectsDelayMs));
    return send(response, 403, { error: { code: "CSRF_INVALID", message: "操作未完成，请刷新后重试", requestId: "fixture-request" } });
  }
  if (url.pathname === "/api/admin/inspector-registrations" && request.method === "GET") return send(response, 200, paged(url, adminRegistrations));
  if (url.pathname === "/api/admin/brands" && request.method === "GET") return send(response, 200, list(fixtureBrands));
  if (url.pathname === "/api/admin/brands" && request.method === "POST") {
    const body = await readBody(request);
    if (fixtureBrands.some((brand) => brand.name === body.name)) return send(response, 409, { error: { code: "BRAND_CONFLICT", message: "品牌名称已存在", requestId: "fixture-request" } });
    brandSeq += 1;
    const brand = { id: crypto.randomUUID(), name: body.name, active: body.active !== false, storeCount: 0, revision: 0 };
    fixtureBrands.push(brand);
    return send(response, 201, { brand });
  }
  if (url.pathname === "/api/admin/regions" && request.method === "GET") {
    if (testControl.regionsUnauthorized > 0) { testControl.regionsUnauthorized -= 1; return send(response, 401, { error: { code: "SESSION_EXPIRED", requestId: "fixture-request" } }); }
    if (testControl.regionsFailures > 0) { testControl.regionsFailures -= 1; return send(response, 503, { error: { code: "SERVICE_DOWN", message: "服务暂时不可用", requestId: "fixture-request", retryable: true } }); }
    return send(response, 200, list([{ id: "11111111-1111-4111-8111-111111111111", name: "上海市", code: "310000", parentId: null, level: 1, active: true, revision: 1 }, { id: "22222222-2222-4222-8222-222222222222", name: "上海市市辖区", code: "310100", parentId: "11111111-1111-4111-8111-111111111111", level: 2, active: true, revision: 1 }, { id: "33333333-3333-4333-8333-333333333333", name: "静安区", code: "310106", parentId: "22222222-2222-4222-8222-222222222222", level: 3, active: true, revision: 1 }, { id: "44444444-4444-4444-8444-444444444444", name: "浦东新区", code: "310115", parentId: "22222222-2222-4222-8222-222222222222", level: 3, active: true, revision: 1 }]));
  }
  if (url.pathname === "/api/admin/regions" && request.method === "POST") { const body = await readBody(request); return send(response, 201, { region: { id: "region-new", name: body.name, code: body.code, active: true, revision: 1 } }); }
  if (url.pathname === "/api/admin/stores" && request.method === "GET") {
    const brandId = url.searchParams.get("brandId");
    const cityRegionId = url.searchParams.get("cityRegionId");
    const businessNo = url.searchParams.get("businessNo");
    const filtered = allStores().filter((store) => (!brandId || store.brandId === brandId) && (!cityRegionId || store.cityRegionId === cityRegionId) && (!businessNo || store.businessNo === businessNo));
    return send(response, 200, paged(url, filtered));
  }
  // 新建门店（编辑器恢复流程）：可注入 401/断连场景；成功后进入有状态列表，唯一编号可回查（对账复用）。
  if (url.pathname === "/api/admin/stores" && request.method === "POST") {
    const body = await readBody(request);
    if (testControl.storeCreateNetworkDrops > 0) {
      if (testControl.storeCreateNetworkDropDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, testControl.storeCreateNetworkDropDelayMs));
      response.destroy(); // 断连（含浏览器自动重试的每一次尝试）：跨登录的迟到网络失败用例
      return;
    }
    if (testControl.storeSaveUnauthorized > 0) { testControl.storeSaveUnauthorized -= 1; return send(response, 401, { error: { code: "SESSION_EXPIRED", requestId: "fixture-request" } }); }
    if (testControl.storeSaveServiceFailures > 0) { testControl.storeSaveServiceFailures -= 1; return send(response, 503, { error: { code: "DATABASE_BUSY", message: "服务繁忙，请稍后重试", requestId: "fixture-request", retryable: true } }); }
    if (allStores().some((store) => store.businessNo === body.businessNo)) return send(response, 409, { error: { code: "STORE_CONFLICT", message: "门店编号已存在", requestId: "fixture-request" } });
    storeSeq += 1;
    const store = storeRowFrom(body, `store-created-${storeSeq}`, 1);
    createdStores.push(store);
    // 已落库但响应不可用（如网关截断/坏包）：客户端按「结果不确定」走唯一编号对账
    if (testControl.storeCreateInvalidResponse > 0) { testControl.storeCreateInvalidResponse -= 1; return send(response, 201, { unexpected: true }); }
    return send(response, 201, { store });
  }
  // 门店/账号/问卷版本详情（Admin 深链接刷新用）：与生产端点同构（{ store }/{ user }/{ version }），
  // 未命中返回 404 + 业务化 message，供前端「不存在或已被删除」恢复态断言。
  const storeDetailMatch = url.pathname.match(/^\/api\/admin\/stores\/([^/]+)$/);
  if (storeDetailMatch && request.method === "GET") {
    const store = allStores().find((row) => row.id === storeDetailMatch[1]);
    if (!store) return send(response, 404, { error: { code: "STORE_NOT_FOUND", message: "门店不存在或已被删除", requestId: "fixture-request" } });
    return send(response, 200, { store });
  }
  // 门店保存（编辑器恢复流程）：可注入 401/断连/409 冲突；冲突后 GET 仍是服务端最新内容（对照来源），
  // 成功保存推进 revision——同一编辑器再次保存不再 409。
  const storeUpdateMatch = url.pathname.match(/^\/api\/admin\/stores\/([^/]+)$/);
  if (storeUpdateMatch && request.method === "PATCH") {
    const body = await readBody(request);
    if (testControl.storeSaveUnauthorized > 0) {
      testControl.storeSaveUnauthorized -= 1;
      if (testControl.storeSaveUnauthorizedDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, testControl.storeSaveUnauthorizedDelayMs));
      return send(response, 401, { error: { code: "SESSION_EXPIRED", requestId: "fixture-request" } });
    }
    if (testControl.storeSaveServiceFailures > 0) { testControl.storeSaveServiceFailures -= 1; return send(response, 503, { error: { code: "DATABASE_BUSY", message: "服务繁忙，请稍后重试", requestId: "fixture-request", retryable: true } }); }
    const store = allStores().find((row) => row.id === storeUpdateMatch[1]);
    if (!store) return send(response, 404, { error: { code: "STORE_NOT_FOUND", message: "门店不存在或已被删除", requestId: "fixture-request" } });
    if (testControl.storeSaveConflicts > 0 || store.revision !== body.revision) {
      if (testControl.storeSaveConflicts > 0) testControl.storeSaveConflicts -= 1;
      return send(response, 409, { error: { code: "REVISION_CONFLICT", message: "内容已更新，请刷新后重试", requestId: "fixture-request" } });
    }
    Object.assign(store, storeRowFrom(body, store.id, store.revision + 1));
    return send(response, 200, { store });
  }
  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    if (url.searchParams.get("kind") === "admin") return send(response, 200, paged(url, adminAdminUsers));
    return send(response, 200, paged(url, adminInspectors));
  }
  const userDetailMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userDetailMatch && request.method === "GET") {
    const user = [...adminInspectors, ...adminAdminUsers].find((row) => row.id === userDetailMatch[1]);
    if (!user) return send(response, 404, { error: { code: "USER_NOT_FOUND", message: "账号不存在或已被删除", requestId: "fixture-request" } });
    return send(response, 200, { user });
  }
  if (url.pathname === "/api/admin/users" && request.method === "POST") { const body = await readBody(request); return send(response, 201, { user: { id: "user-new", username: body.username, displayName: body.displayName, kind: body.kind } }); }
  if (url.pathname.startsWith("/api/admin/users/") && request.method === "PATCH") { await readBody(request); return send(response, 200, { user: { id: url.pathname.split("/").pop(), kind: "inspector" } }); }
  if (url.pathname === "/api/admin/campaigns" && request.method === "GET") {
    // 清理用例显式开启后才展示「已取消的测试任务」行，避免影响既有任务列表用例的行集断言
    const campaigns = testControl.showCleanupCampaign ? adminCampaigns : adminCampaigns.filter((row) => row.id !== "campaign-clean");
    return send(response, 200, paged(url, campaigns));
  }
  if (url.pathname === "/api/admin/campaigns" && request.method === "POST") { await readBody(request); return send(response, 201, { campaign: { id: "campaign-two", name: "新建探店任务", businessNo: "JD-NEW-001", storeName: "静安嘉里中心店", startsAt: "2026-07-19T10:00:00Z", dueAt: "2026-07-19T14:00:00Z", questionnaireDeadlineAt: "2026-07-19T20:00:00Z", status: "draft", revision: 1, assignmentCount: 0, overdueCount: 0 } }); }
  if (url.pathname === "/api/admin/campaigns/campaign-one" && request.method === "GET") return send(response, 200, { id: "campaign-one", name: "夏季门店服务品质暗访", storeId: "store-one", storeName: "静安嘉里中心店", startsAt: "2026-07-19T10:00:00Z", dueAt: "2026-07-19T14:00:00Z", questionnaireDeadlineAt: "2026-07-19T20:00:00Z", commonInstruction: "请保持自然就餐，重点观察高峰期服务。", status: "draft", revision: 3, locationVerified: true, overdueCount: 0, assignments: campaignAssignments.map(mergeAssignment) });
  // campaign-two（POST 创建的草稿）：详情可回读（向导创建后 URL replace 为 :id/edit，刷新走这里），
  // 指派 POST 落库到 campaignTwoAssignments，供 ?step=3 刷新后回显。
  if (url.pathname === "/api/admin/campaigns/campaign-two" && request.method === "GET") return send(response, 200, { id: "campaign-two", name: "新建探店任务", businessNo: "JD-NEW-001", storeId: "store-one", storeName: "静安嘉里中心店", startsAt: "2026-07-19T10:00:00Z", dueAt: "2026-07-19T14:00:00Z", questionnaireDeadlineAt: "2026-07-19T20:00:00Z", status: "draft", revision: 1, locationVerified: true, overdueCount: 0, assignments: campaignTwoAssignments });
  const campaignTwoAssignmentMatch = url.pathname.match(/^\/api\/admin\/campaigns\/campaign-two\/assignments$/);
  if (campaignTwoAssignmentMatch && request.method === "POST") {
    const body = await readBody(request);
    const inspector = [...adminInspectors].find((row) => row.id === body.inspectorId);
    const version = questionnaireVersions.find((row) => row.id === body.questionnaireVersionId);
    const assignment = { id: `assignment-two-${campaignTwoAssignments.length + 1}`, inspectorId: body.inspectorId, inspectorName: inspector?.displayName || body.inspectorId, questionnaireVersionId: body.questionnaireVersionId, questionnaireName: version ? `${version.name} ${version.versionLabel}` : body.questionnaireVersionId, taskType: body.taskType || "secret", startsAt: body.startsAt, dueAt: body.dueAt, budgetLimit: body.budgetLimit ?? 0, receiptRequired: Boolean(body.receiptRequired), specialInstruction: body.specialInstruction || "", dishRequirements: [], status: "draft", revision: 1 };
    campaignTwoAssignments.push(assignment);
    return send(response, 201, { id: assignment.id, revision: assignment.revision });
  }
  // 测试任务清理（super_admin 固件）：预览返回计数（campaign-clean 可清理、campaign-blocked 有正式提交阻断），
  // 清理校验逐字名称 + revision，成功后把列表行移除（模拟删除）。
  const cleanupPreviewMatch = url.pathname.match(/^\/api\/admin\/campaigns\/([^/]+)\/cleanup-preview$/);
  if (cleanupPreviewMatch && request.method === "GET") {
    if (testControl.cleanupPreviewUnauthorized > 0) { testControl.cleanupPreviewUnauthorized -= 1; return send(response, 401, { error: { code: "SESSION_EXPIRED", requestId: "fixture-request" } }); }
    if (cleanupPreviewMatch[1] === "campaign-blocked") {
      return send(response, 200, {
        campaign: { id: "campaign-blocked", name: "含提交的取消任务", businessNo: "JD-BLOCK-001", status: "cancelled", storeName: "静安嘉里中心店", revision: 1 },
        counts: { assignments: 2, dishRequirements: 2, checkins: 0, exemptions: 0, attempts: 2, answers: 4, editSessions: 0, editSessionRemovals: 0, evidenceAttachments: 1, receiptAttachments: 1, ocrJobs: 1, dishes: 3, otherRecords: 1, idempotencyKeys: 1 },
        blockers: [{ code: "SUBMISSIONS_EXIST", message: "任务下已有 1 条正式提交记录（含完整快照），属于业务数据，不能清理" }],
        cleanupAllowed: false,
      });
    }
    if (cleanupPreviewMatch[1] !== "campaign-clean") return send(response, 404, { error: { code: "CAMPAIGN_NOT_FOUND", message: "探店任务不存在", requestId: "fixture-request" } });
    return send(response, 200, {
      campaign: { id: "campaign-clean", name: cleanupUsed ? "已取消的测试任务" : cleanupCampaign.name, businessNo: "JD-CLEAN-001", status: "cancelled", storeName: "静安嘉里中心店", revision: 4 },
      counts: { assignments: 2, dishRequirements: 2, checkins: 1, exemptions: 1, attempts: 2, answers: 3, editSessions: 1, editSessionRemovals: 0, evidenceAttachments: 2, receiptAttachments: 1, ocrJobs: 1, dishes: 4, otherRecords: 1, idempotencyKeys: 1 },
      blockers: [],
      cleanupAllowed: true,
    });
  }
  const cleanupMatch = url.pathname.match(/^\/api\/admin\/campaigns\/([^/]+)\/cleanup$/);
  if (cleanupMatch && request.method === "POST") {
    const body = await readBody(request);
    if (cleanupMatch[1] !== "campaign-clean") return send(response, 409, { error: { code: "SUBMISSIONS_EXIST", message: "任务下已有正式提交记录，不能清理", requestId: "fixture-request" } });
    if (body.revision !== 4) return send(response, 409, { error: { code: "REVISION_CONFLICT", message: "任务状态已变化，请刷新预览后重新确认", requestId: "fixture-request" } });
    if (body.confirmName !== "已取消的测试任务") return send(response, 422, { error: { code: "CLEANUP_CONFIRM_MISMATCH", message: "输入的确认名称与任务名称不一致", requestId: "fixture-request" } });
    cleanupUsed = true;
    const index = adminCampaigns.findIndex((row) => row.id === "campaign-clean");
    if (index >= 0) adminCampaigns.splice(index, 1);
    return send(response, 200, { deleted: true, counts: { assignments: 2, attempts: 2, receiptAttachments: 1, ocrJobs: 1 } });
  }
  if (/^\/api\/admin\/campaigns\/[^/]+$/.test(url.pathname) && request.method === "PATCH") { await readBody(request); return send(response, 200, { campaign: { id: url.pathname.split("/").pop(), name: "夏季门店服务品质暗访", businessNo: "JD-20260719-018", storeName: "静安嘉里中心店", startsAt: "2026-07-19T10:00:00Z", dueAt: "2026-07-19T14:00:00Z", questionnaireDeadlineAt: "2026-07-19T20:00:00Z", status: "draft", revision: 4, assignmentCount: 3, overdueCount: 0 } }); }
  if (/^\/api\/admin\/campaigns\/[^/]+\/assignments$/.test(url.pathname) && request.method === "POST") { await readBody(request); return send(response, 201, { id: "assignment-two", revision: 1 }); }
  // 钉死契约：POST /api/admin/assignments/:id/extend —— AssignmentExtendSchema =
  // revision(必填，乐观锁) + reason(必填) + { dueAt?, questionnaireDeadlineAt? }；
  // 成功返回 { assignment, campaign }，并把新值合并进后续 GET 详情。
  const extendMatch = url.pathname.match(/^\/api\/admin\/assignments\/([^/]+)\/extend$/);
  if (extendMatch && request.method === "POST") {
    const body = await readBody(request);
    if (typeof body.reason !== "string" || !body.reason.trim()) return send(response, 422, { error: { code: "VALIDATION_FAILED", message: "请填写延期原因", requestId: "fixture-request" } });
    if (body.dueAt === undefined && body.questionnaireDeadlineAt === undefined) return send(response, 422, { error: { code: "VALIDATION_FAILED", message: "请至少填写一项延期时间", requestId: "fixture-request" } });
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) return send(response, 422, { error: { code: "REVISION_REQUIRED", message: "内容已更新，请刷新后重试", requestId: "fixture-request" } });
    const target = campaignAssignments.find((row) => row.id === extendMatch[1]);
    if (!target) return send(response, 404, { error: { code: "NOT_FOUND", requestId: "fixture-request" } });
    const previous = extendState.get(target.id);
    const revision = (previous?.revision ?? target.revision) + 1;
    extendState.set(target.id, { dueAt: body.dueAt ?? previous?.dueAt, questionnaireDeadlineAt: body.questionnaireDeadlineAt ?? previous?.questionnaireDeadlineAt, revision });
    return send(response, 200, { assignment: mergeAssignment(target), campaign: { id: "campaign-one", name: "夏季门店服务品质暗访", businessNo: "JD-20260719-018", storeName: "静安嘉里中心店", startsAt: "2026-07-19T10:00:00Z", dueAt: "2026-07-19T14:00:00Z", questionnaireDeadlineAt: "2026-07-19T20:00:00Z", status: "draft", revision: 3, assignmentCount: campaignAssignments.length, overdueCount: 0 } });
  }
  // 指派本体保存（编辑器检查点用例）：乐观锁推进并回显新 revision
  if (/^\/api\/admin\/assignments\/[^/]+$/.test(url.pathname) && request.method === "PATCH") {
    const body = await readBody(request);
    return send(response, 200, { id: url.pathname.split("/").pop(), revision: (Number(body.revision) || 0) + 1, status: "draft" });
  }
  if (/^\/api\/admin\/assignments\/[^/]+\/dish-requirements$/.test(url.pathname) && request.method === "PUT") {
    const body = await readBody(request);
    if (testControl.dishRequirementsUnauthorized > 0) { testControl.dishRequirementsUnauthorized -= 1; return send(response, 401, { error: { code: "SESSION_EXPIRED", requestId: "fixture-request" } }); }
    return send(response, 200, { id: url.pathname.split("/")[4], revision: Number(body.revision) || 0, status: "draft" });
  }
  if (url.pathname === "/api/admin/assignments/assignment-one/check-in-exemptions" && request.method === "GET") return send(response, 200, list([{ id: "exemption-one", status: "active", reason: "商场室内定位漂移", grantedAt: "2026-07-19T09:50:00Z", validUntil: "2026-07-19T10:20:00Z", revision: 1 }]));
  if (url.pathname === "/api/admin/question-categories" && request.method === "GET") return send(response, 200, list([{ id: "cat-environment", code: "environment", name: "环境卫生", sortOrder: 1, active: true, revision: 1 }, { id: "cat-service", code: "service", name: "为客服务", sortOrder: 2, active: true, revision: 1 }, { id: "cat-product", code: "product", name: "产品品质", sortOrder: 3, active: true, revision: 1 }]));
  if (url.pathname === "/api/admin/stats/dashboard" && request.method === "GET") return send(response, 200, {
    range: { from: "2026-07-01", to: "2026-08-31" },
    months: ["2026-07", "2026-08"],
    categories: [{ code: "environment", name: "环境卫生" }, { code: "service", name: "为客服务" }, { code: "product", name: "产品品质" }],
    trend: [{ month: "2026-07", submissions: 12, score: 76.67 }, { month: "2026-08", submissions: 9, score: 71.13 }],
    stores: [
      { storeId: "11111111-1111-4111-8111-111111111111", storeName: "建新园塘子巷店", brandName: "建新园", cityName: "昆明市", overall: 83.39, submissions: 6, monthly: [{ month: "2026-07", score: 86 }, { month: "2026-08", score: 80.78 }] },
      { storeId: "22222222-2222-4222-8222-222222222222", storeName: "建新园火车站店", brandName: "建新园", cityName: "昆明市", overall: 78, submissions: 4, monthly: [{ month: "2026-07", score: 80 }, { month: "2026-08", score: 76 }] },
    ],
    storeCategories: [
      { storeId: "11111111-1111-4111-8111-111111111111", storeName: "建新园塘子巷店", overallRate: 83.39, rates: [{ category: "environment", rate: 96.15 }, { category: "service", rate: 86.05 }, { category: "product", rate: 68 }] },
      { storeId: "22222222-2222-4222-8222-222222222222", storeName: "建新园火车站店", overallRate: 78, rates: [{ category: "environment", rate: 84.62 }, { category: "service", rate: 77.91 }, { category: "product", rate: 71.43 }] },
    ],
    questions: [
      { key: "k8", number: 8, text: "点餐时是否有向您推荐特色产品？", overallRate: 25.34, monthly: [{ month: "2026-07", rate: 23.08 }, { month: "2026-08", rate: 27.59 }], delta: 4.51 },
      { key: "k15", number: 15, text: "您结束用餐离店时，是否口头欢送您？", overallRate: 30.23, monthly: [{ month: "2026-07", rate: 27.69 }, { month: "2026-08", rate: 32.76 }], delta: 5.07 },
    ],
  });
  if (url.pathname === "/api/admin/exports" && request.method === "POST") {
    const body = await readBody(request);
    if (body?.submissionId) {
      singleExportPolls = 0;
      return send(response, 202, { id: singleExportJobId, fileName: "单份问卷导出（生成中）", createdAt: "2026-09-05T08:00:00Z", status: "queued", downloadUrl: null });
    }
    return send(response, 202, { id: "44444444-4444-4444-8444-444444444444", fileName: "导出任务处理中", createdAt: "2026-09-05T08:00:00Z", status: "queued", downloadUrl: null });
  }
  if (url.pathname === `/api/admin/exports/${singleExportJobId}` && request.method === "GET") {
    singleExportPolls += 1;
    if (singleExportPolls < 2) return send(response, 200, { id: singleExportJobId, fileName: "单份问卷导出（生成中）", createdByName: "测试管理员", createdAt: "2026-09-05T08:00:00Z", status: "processing", downloadUrl: null });
    return send(response, 200, { id: singleExportJobId, fileName: "暗访评估_静安嘉里中心店_周雨晴_20260719_55555555.xlsx", createdByName: "测试管理员", createdAt: "2026-09-05T08:00:00Z", status: "succeeded", downloadUrl: "https://exports.example.cos.test/signed-download" });
  }
  if (url.pathname === "/api/admin/exports/44444444-4444-4444-8444-444444444444" && request.method === "GET") return send(response, 200, { id: "44444444-4444-4444-8444-444444444444", fileName: "数据看板导出_2026-07-01_2026-08-31.xlsx", createdByName: "测试管理员", createdAt: "2026-09-05T08:00:00Z", status: "succeeded", downloadUrl: "https://exports.example.cos.test/signed-download" });
  if (url.pathname === "/api/admin/questionnaire-versions" && request.method === "GET") return send(response, 200, paged(url, questionnaireVersions));
  const versionDetailMatch = url.pathname.match(/^\/api\/admin\/questionnaire-versions\/([^/]+)$/);
  if (versionDetailMatch && request.method === "GET") {
    const version = questionnaireVersions.find((item) => item.id === versionDetailMatch[1]);
    if (!version) return send(response, 404, { error: { code: "QUESTIONNAIRE_VERSION_NOT_FOUND", message: "问卷版本不存在或已被删除", requestId: "fixture-request" } });
    return send(response, 200, { version });
  }
  if (url.pathname === "/api/admin/questionnaire-versions" && request.method === "POST") {
    const body = await readBody(request);
    questionnaireVersionSequence += 1;
    const version = { id: `version-created-${questionnaireVersionSequence}`, name: body.name, versionLabel: "V1", enabledQuestionCount: body.questions.length, numberingValid: true, status: "draft", createdAt: new Date().toISOString(), revision: 0 };
    questionnaireVersions.push(version);
    createdQuestionSets.set(version.id, body.questions.map((question, index) => ({ id: `created-question-${questionnaireVersionSequence}-${index + 1}`, number: index + 1, category: question.category, text: question.text, maxScore: question.maxScore, enabled: true, scoreWipe: Boolean(question.scoreWipe), revision: 0, evidence: { evidenceRequired: false, imageRequired: false, audioRequired: false } })));
    return send(response, 201, { version });
  }
  const publishVersionMatch = url.pathname.match(/^\/api\/admin\/questionnaire-versions\/([^/]+)\/publish$/);
  if (publishVersionMatch && request.method === "POST") {
    const version = questionnaireVersions.find((item) => item.id === publishVersionMatch[1]);
    if (!version) return send(response, 404, { error: { code: "NOT_FOUND" } });
    const body = await readBody(request);
    if (body.revision !== version.revision || version.status !== "draft") return send(response, 409, { error: { code: "REVISION_CONFLICT" } });
    version.status = "published";
    version.revision += 1;
    questionSetsPublished.add(version.id);
    return send(response, 200, { version: { id: version.id, status: version.status, revision: version.revision } });
  }
  const questionSetMatch = url.pathname.match(/^\/api\/admin\/questionnaire-versions\/([^/]+)\/questions$/);
  if (questionSetMatch && request.method === "GET") {
    const set = questionSets[questionSetMatch[1]] || createdQuestionSets.get(questionSetMatch[1]);
    if (!set) return send(response, 404, { error: { code: "NOT_FOUND", message: "问卷版本不存在或已被删除", requestId: "fixture-request" } });
    return send(response, 200, list(set));
  }
  // 题目 PATCH：有状态（revision 乐观锁，成功后 revision+1 并回写权威行），与生产契约一致返回 { question }。
  const questionPatchMatch = url.pathname.match(/^\/api\/admin\/questionnaire-versions\/([^/]+)\/questions\/([^/]+)$/);
  if (questionPatchMatch && request.method === "PATCH") {
    const body = await readBody(request);
    const set = questionSets[questionPatchMatch[1]] || createdQuestionSets.get(questionPatchMatch[1]);
    const question = set?.find((row) => row.id === questionPatchMatch[2]);
    if (!question) return send(response, 404, { error: { code: "QUESTION_NOT_FOUND", message: "题目不存在", requestId: "fixture-request" } });
    if (questionSetsPublished[questionPatchMatch[1]]) return send(response, 409, { error: { code: "QUESTIONNAIRE_VERSION_FROZEN", message: "已发布版本不能修改", requestId: "fixture-request" } });
    if (Number(body.revision) !== question.revision) return send(response, 409, { error: { code: "REVISION_CONFLICT", message: "内容已更新，请刷新后重试", requestId: "fixture-request" } });
    question.revision += 1;
    if (body.text !== undefined) question.text = body.text;
    if (body.maxScore !== undefined) question.maxScore = body.maxScore;
    if (body.scoreWipe !== undefined) question.scoreWipe = Boolean(body.scoreWipe);
    if (body.evidence) question.evidence = { evidenceRequired: body.evidence.evidenceRequired, imageRequired: body.evidence.imageRequired, audioRequired: body.evidence.audioRequired, imageMaxCount: body.evidence.imageMaxCount ?? 3, audioMaxDurationSeconds: body.evidence.audioMaxDurationSeconds ?? 10 };
    return send(response, 200, { question });
  }
  if (url.pathname === "/api/admin/submissions" && request.method === "GET") {
    const query = url.searchParams;
    const contains = (value, field) => { const target = query.get(field); return !target || String(value || "").toLowerCase().includes(target.toLowerCase()); };
    const filtered = adminSubmissions.filter((row) =>
      contains(row.storeName, "storeName") && contains(row.regionName, "regionName") && contains(row.taskName, "campaignName") &&
      contains(row.inspectorName, "inspectorName") && contains(row.businessNo, "businessNo") &&
      (!query.get("brandId") || query.get("brandId") === "1a6fd7a0-1111-4111-8111-000000000001") &&
      (!query.get("status") || row.status === query.get("status")));
    // 仅 submissions 额外带 total（全量计数，供「共 X 条」展示）
    return send(response, 200, { ...paged(url, filtered), total: filtered.length });
  }
  if (url.pathname === "/api/admin/submissions/submission-one") return send(response, 200, { taskName: "夏季门店服务品质暗访", storeName: "静安嘉里中心店", inspectorName: "周雨晴", submittedAt: "2026-07-19T13:20:00Z", questionnaireName: "暗访问卷", versionLabel: "2026 夏季版", totalScore: 94, scoreRate: "94%", issueCount: 3, categoryScores: [{ category: "environment", scoreRate: "95%", score: 19 }, { category: "service", scoreRate: "93%", score: 41 }, { category: "product", scoreRate: "94%", score: 34 }], highlight: "员工主动巡台", suggestion: "高峰期增加引导", dishes: [{ id: "dish-one", requirementId: "requirement-one", plannedName: "招牌烤鸭", actualName: "招牌烤鸭", quantity: 1, unitPriceCents: 26800, lineTotalCents: 26800, fulfillmentStatus: "ordered", evaluation: "温度和口感良好", fullySatisfied: true, source: "ocr", manuallyModified: false, priceDerived: false, reviewFields: [] }], receiptComparison: adminReceiptComparison, auditLogs: [{ id: "submission-audit-one", createdAt: "2026-07-19T13:20:00Z", actorName: "周雨晴", actionLabel: "提交问卷" }], questions: Array.from({ length: 50 }, (_, index) => ({ id: `question-${index + 1}`, number: index + 1, text: `第 ${index + 1} 题检查内容`, answer: index % 17 === 0 ? "unscored" : "scored", issueRemark: index % 17 === 0 ? "现场细节需要改进" : "", previewUrls: [] })) });
  if (url.pathname === "/api/admin/exports" && request.method === "GET") return send(response, 200, paged(url, [], "desc"));
  if (url.pathname === "/api/admin/audit-logs" && request.method === "GET") return send(response, 200, paged(url, adminAudits, "desc"));
  if (request.method === "DELETE" && (url.pathname.startsWith("/api/admin/stores/") || url.pathname.startsWith("/api/admin/users/") || url.pathname.startsWith("/api/admin/campaigns/") || url.pathname.startsWith("/api/admin/questionnaire-versions/"))) return send(response, 200, { deleted: true });
  if (request.method !== "GET") return send(response, 200, { status: "ok", revision: 4 });
  return send(response, 404, { error: { code: "NOT_FOUND", message: "数据不存在或链接有误", requestId: "fixture-request" } });
}).listen(port, "127.0.0.1", () => console.log(`test contract server ready on ${port}`));
