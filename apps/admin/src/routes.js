// Admin 前端路由表（纯函数，可在 Node 单测中直接运行，不依赖 window/react）。
// canonical 路径固定携带 /admin 前缀：dev（base /，vite SPA 回退）与 /admin/ 构建（Render）
// 使用同一套地址；根入口（/、/admin、/admin/、/admin/index.html）一律规整到 /admin/overview。
// 段字符集限制为字母/数字/下划线/连字符（ID 为服务端 uuid 或 fixture 字符串），
// 保证 render-static 侧能用同一张表做安全的深链接 HTML 回退白名单。
export const OVERVIEW_PATH = "/admin/overview";

const SEGMENT = "[A-Za-z0-9][A-Za-z0-9_-]{0,63}";
const id = (name) => ({ name, pattern: SEGMENT });
// 顺序即匹配优先级：字面段（new）先于同位置的 :id 参数段。
const ROUTE_TABLE = [
  { segments: ["overview"], page: "overview", screen: "list", permission: null },
  { segments: ["dashboard"], page: "dashboard", screen: "list", permission: "stats:read" },
  { segments: ["campaigns"], page: "campaigns", screen: "list", permission: "campaign:manage" },
  { segments: ["campaigns", "new"], page: "campaigns", screen: "campaign-new", permission: "campaign:manage" },
  { segments: ["campaigns", id("id")], page: "campaigns", screen: "campaign-detail", permission: "campaign:manage" },
  { segments: ["campaigns", id("id"), "edit"], page: "campaigns", screen: "campaign-edit", permission: "campaign:manage" },
  { segments: ["campaigns", id("id"), "assignments", id("assignmentId"), "edit"], page: "campaigns", screen: "assignment-edit", permission: "campaign:manage" },
  { segments: ["users"], page: "users", screen: "list", permission: "user:manage" },
  { segments: ["users", "new"], page: "users", screen: "user-new", permission: "user:manage" },
  { segments: ["users", id("id"), "edit"], page: "users", screen: "user-edit", permission: "user:manage" },
  { segments: ["stores"], page: "stores", screen: "list", permission: "store:manage" },
  { segments: ["stores", "new"], page: "stores", screen: "store-new", permission: "store:manage" },
  { segments: ["stores", id("id"), "edit"], page: "stores", screen: "store-edit", permission: "store:manage" },
  { segments: ["questionnaires"], page: "questionnaires", screen: "list", permission: "questionnaire:manage" },
  { segments: ["questionnaires", "new"], page: "questionnaires", screen: "questionnaire-new", permission: "questionnaire:manage" },
  { segments: ["questionnaires", id("id")], page: "questionnaires", screen: "questionnaire-version", permission: "questionnaire:manage" },
  { segments: ["submissions"], page: "submissions", screen: "list", permission: "submission:read" },
  { segments: ["submissions", id("id")], page: "submissions", screen: "submission-detail", permission: "submission:read" },
  { segments: ["exports"], page: "exports", screen: "list", permission: "export:create" },
  { segments: ["audits"], page: "audits", screen: "list", permission: "audit:read" },
];

// 根入口集合：客户端 replace 到 overview（不新增历史记录）；render-static 侧各自有注册路由。
const ROOT_PATHS = new Set(["/", "/admin", "/admin/", "/admin/index.html"]);

// 规整 pathname：根入口 → overview；其余去掉末尾多余斜杠（保留根「/」形态供识别）。
export function canonicalPathname(pathname) {
  const raw = String(pathname || "/");
  if (ROOT_PATHS.has(raw)) return OVERVIEW_PATH;
  return raw.length > 1 && raw.endsWith("/") ? raw.replace(/\/+$/, "") : raw;
}

// 需要 replace 修正的入口：返回目标 href（含规整），无需修正时返回 null。
export function rootReplacement(href) {
  const pathname = String(href || "/").split("?")[0];
  if (!ROOT_PATHS.has(pathname)) return null;
  return OVERVIEW_PATH;
}

// 解析 href（pathname?search）→ { page, screen, params, query, permission } | null（未知路径）。
// 仅接受 /admin 前缀内的路径（根入口先规整为 overview）；前缀外的路径一律视为未知 → 友好 404 页。
export function resolveRoute(href) {
  const [rawPathname, search = ""] = String(href || "/").split("?");
  const pathname = canonicalPathname(rawPathname);
  const prefixed = pathname.replace(/^\/+/, "").split("/");
  if (prefixed[0] !== "admin") return null;
  const segments = prefixed.slice(1).map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  for (const route of ROUTE_TABLE) {
    if (route.segments.length !== segments.length) continue;
    const params = {};
    let matched = true;
    for (const [index, part] of route.segments.entries()) {
      if (typeof part === "string") { if (part !== segments[index]) { matched = false; break; } continue; }
      if (!new RegExp(`^${part.pattern}$`).test(segments[index])) { matched = false; break; }
      params[part.name] = segments[index];
    }
    if (!matched) continue;
    return { ...route, params, query: new URLSearchParams(search) };
  }
  return null;
}

const encode = (value) => encodeURIComponent(String(value));

// 列表筛选的 URL 白名单：list 页把「已应用筛选」编码进查询串（刷新/书签可恢复），
// 子路由用 ?list= 携带父列表上下文以便直接返回——两侧都只接受下列键，其余一律丢弃
//（不充当跳转 URL，杜绝外部注入；仅由本模块构造与解析）。
export const LIST_QUERY_KEYS = {
  stores: ["cityRegionId", "brandId"],
  submissions: ["brandId", "storeName", "regionName", "campaignName", "businessNo", "inspectorName", "status", "submittedFrom", "submittedTo", "minScoreRate", "maxIssueCount"],
};

// 从任意查询串中挑出白名单键，返回规范查询串（"" 表示无筛选）。
export function listSearchOf(kind, search) {
  const params = new URLSearchParams(search || "");
  const out = new URLSearchParams();
  for (const key of LIST_QUERY_KEYS[kind] || []) {
    const value = params.get(key);
    if (value) out.set(key, value);
  }
  const result = out.toString();
  return result ? `?${result}` : "";
}

// 子路由携带父列表上下文：仅透传白名单内的筛选键（先归一化再编码），书签/刷新直接打开时
// 返回链接退化为未过滤列表，不引入任何外部可控跳转目标。
const withListContext = (kind, base, listSearch) => {
  const clean = listSearchOf(kind, listSearch);
  return `${base}${clean ? `?list=${encodeURIComponent(clean.slice(1))}` : ""}`;
};

// —— 路径构造：所有站内跳转统一走这里，避免散落字符串拼接 ——
export const adminPaths = {
  page: (pageId) => `/admin/${pageId}`,
  users: (tab) => (tab && tab !== "inspector" ? `/admin/users?tab=${encode(tab)}` : "/admin/users"),
  userNew: (kind) => `/admin/users/new?kind=${kind === "admin" ? "admin" : "inspector"}`,
  userEdit: (userId) => `/admin/users/${encode(userId)}/edit`,
  stores: (filters) => {
    const params = new URLSearchParams(filters || {});
    const kept = new URLSearchParams();
    for (const key of LIST_QUERY_KEYS.stores) {
      const value = params.get(key);
      if (value) kept.set(key, value);
    }
    const search = kept.toString();
    return `/admin/stores${search ? `?${search}` : ""}`;
  },
  storeNew: (listSearch) => withListContext("stores", "/admin/stores/new", listSearch),
  storeEdit: (storeId, listSearch) => withListContext("stores", `/admin/stores/${encode(storeId)}/edit`, listSearch),
  campaigns: () => "/admin/campaigns",
  campaignNew: () => "/admin/campaigns/new",
  campaignDetail: (campaignId) => `/admin/campaigns/${encode(campaignId)}`,
  // 任务向导：step>1 与返回来源（from=list|detail）以查询串承载——详情页「添加探店员」直达指派步；
  // 列表页编辑进入的向导关闭后回列表，详情页进入的回详情（仅站内枚举值，不充当跳转 URL）。
  campaignEdit: (campaignId, step, from) => {
    const params = new URLSearchParams();
    if (Number(step) > 1) params.set("step", String(Number(step)));
    if (from && from !== "detail") params.set("from", from);
    const search = params.toString();
    return `/admin/campaigns/${encode(campaignId)}/edit${search ? `?${search}` : ""}`;
  },
  assignmentEdit: (campaignId, assignmentId) => `/admin/campaigns/${encode(campaignId)}/assignments/${encode(assignmentId)}/edit`,
  questionnaires: () => "/admin/questionnaires",
  questionnaireNew: () => "/admin/questionnaires/new",
  questionnaireDetail: (versionId, { question, category } = {}) => {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (question) params.set("question", question);
    const search = params.toString();
    return `/admin/questionnaires/${encode(versionId)}${search ? `?${search}` : ""}`;
  },
  submissions: (filters) => {
    const params = new URLSearchParams(filters || {});
    const kept = new URLSearchParams();
    for (const key of LIST_QUERY_KEYS.submissions) {
      const value = params.get(key);
      if (value) kept.set(key, value);
    }
    const search = kept.toString();
    return `/admin/submissions${search ? `?${search}` : ""}`;
  },
  submissionDetail: (submissionId, listSearch) => withListContext("submissions", `/admin/submissions/${encode(submissionId)}`, listSearch),
};
