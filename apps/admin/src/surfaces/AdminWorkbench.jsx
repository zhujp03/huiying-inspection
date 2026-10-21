import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  Buildings, CalendarBlank, CaretDown, CaretRight, CaretUp, ChartLine, CheckCircle, ClipboardText, DownloadSimple,
  Export, FileText, Gauge, MapPin, Plus, SignOut, Storefront, Users,
  WarningCircle, ClockCounterClockwise,
} from "@phosphor-icons/react";
import {
  ADMIN_LIST_SCHEMAS, API, AdminQuestionListSchema, AdminQuestionRowSchema, AdminUserOptionSchema, ArchiveRestoreStatusSchema, BrandRowSchema, CampaignDetailSchema,
  CampaignRowSchema, ExportRowSchema, QuestionnaireVersionCreateSchema, QuestionnaireVersionRowSchema, RegionRowSchema, RegistrationRowSchema,
  StoreRowSchema, StoreWriteSchema, SubmissionDetailSchema, SubmissionRowSchema, UserCreateSchema, UserRowSchema, UserUpdateSchema, listSchema, toStatusLabel,
} from "../../../../packages/contracts/index.js";
import { request } from "../api/client.js";
import { useAdminAuth } from "../auth/AdminAuth.jsx";
import { adminPaths, listSearchOf, resolveRoute } from "../routes.js";
import { cancelLeave, confirmLeave, forceNavigate, navigate, navigationBlocked, setNavigationConfirm, useAdminLocation, useNavigationGuard, useRootRedirect } from "../router.jsx";
import { Modal, FormDialog, StatusBadge, Toast, PageHeader } from "../components/BusinessUI.jsx";
import { AssignmentEditor } from "../components/AssignmentEditor.jsx";
import { ReceiptComparison } from "../components/ReceiptComparison.jsx";
import { CampaignWizard } from "../components/CampaignWizard.jsx";
import { CampaignCleanupDialog } from "../components/CampaignCleanupDialog.jsx";
import { TencentStoreMap } from "../components/TencentStoreMap.jsx";
import { Dashboard } from "./Dashboard.jsx";

// 菜单按权限显隐（session.user.permissions 为用户全部角色的权限并集）：
// audit:read 仅 super_admin / auditor / 勾选「允许查看操作审计」的管理员持有，普通管理员看不到操作审计。
const NAV = [
  { id: "overview", label: "运营概览", icon: Gauge, permission: null },
  { id: "dashboard", label: "数据看板", icon: ChartLine, permission: "stats:read" },
  { id: "campaigns", label: "探店任务", icon: CalendarBlank, permission: "campaign:manage" },
  { id: "users", label: "用户管理", icon: Users, permission: "user:manage" },
  { id: "stores", label: "门店管理", icon: Storefront, permission: "store:manage" },
  { id: "questionnaires", label: "问卷题库", icon: ClipboardText, permission: "questionnaire:manage" },
  { id: "submissions", label: "提交记录", icon: FileText, permission: "submission:read" },
  { id: "exports", label: "导出中心", icon: Export, permission: "export:create" },
  { id: "audits", label: "操作审计", icon: ClockCounterClockwise, permission: "audit:read" },
];

const ENDPOINTS = {
  overview: null,
  dashboard: null,
  // 列表端点支持 limit/order/cursor：首屏一次取 100 条，超出部分「加载更多」游标追加（order=desc 最新优先）。
  // 探店任务列表另带 sort=dueAt：服务端按执行窗口截止时间全局倒序（截止晚的在前，多日窗口取最终截止），
  // 游标跨页追加仍延续同一全局序，前端不做页面内重排；概览统计/筛选下拉等其他消费者不带 sort，不受影响。
  campaigns: `${API.admin.campaigns}?limit=100&order=desc&sort=dueAt`,
  users: null, // 用户管理三个 tab 各自独立游标，由组件自行请求
  stores: null, // 门店列表带服务端筛选（brandId/cityRegionId），由组件自行请求
  questionnaires: `${API.admin.questionnaireVersions}?limit=100&order=desc`,
  submissions: null, // 提交记录自带筛选与游标分页，由组件自行请求
  exports: `${API.admin.exports}?limit=100`,
  audits: null, // 操作审计自带筛选与游标分页，由组件自行请求
};

const PAGE_SIZE = 100;
// zod object 默认 strip 未知字段：ADMIN_LIST_SCHEMAS 只声明 { items }（个别带 total/nextCursor），
// 这里派生补齐 nextCursor/total 字段（不改 packages/contracts，契约文件归其他批次所有）。
// cursor 是服务端返回的不透明定位串（同行的 id 用宽松 IdSchema），因此用 z.string() 而非 z.uuid()。
const NEXT_CURSOR_FIELD = { nextCursor: z.string().nullable().optional() };
const PAGED_LIST_SCHEMAS = {
  campaigns: listSchema(CampaignRowSchema, NEXT_CURSOR_FIELD),
  registrations: listSchema(RegistrationRowSchema, NEXT_CURSOR_FIELD),
  users: listSchema(UserRowSchema, NEXT_CURSOR_FIELD),
  stores: listSchema(StoreRowSchema, NEXT_CURSOR_FIELD),
  questionnaires: listSchema(QuestionnaireVersionRowSchema, NEXT_CURSOR_FIELD),
  exports: listSchema(ExportRowSchema, NEXT_CURSOR_FIELD),
  submissions: listSchema(SubmissionRowSchema, { ...NEXT_CURSOR_FIELD, total: z.number().int().nonnegative().optional() }),
  inspectorOptions: listSchema(AdminUserOptionSchema, NEXT_CURSOR_FIELD),
};

// 确认弹窗错误态允许原位「重试」的稳定业务码：这些失败要么发生在任何业务写入之前
// （限流/认证未配置/CSRF），要么事务已整体回滚（数据库繁忙/序列化冲突），重试不会造成重复写入。
// 其余失败（含网络超时后的未知结果）只提供「返回修改」，不盲目重放 POST。
const SAFE_RETRY_CODES = new Set(["CSRF_INVALID", "RATE_LIMITED", "AUTH_BUSY", "AUTH_NOT_CONFIGURED", "DATABASE_BUSY"]);

export function AdminWorkbench() {
  const { session, logout, expire } = useAdminAuth();
  const role = session.user.role;
  const permissions = useMemo(() => new Set(session.user.permissions || []), [session.user.permissions]);
  const allowedNav = useMemo(() => NAV.filter((item) => !item.permission || permissions.has(item.permission)), [permissions]);
  // 页面由真实 pathname 驱动（/admin/...）：菜单/概览卡片跳转走 pushState 客户端导航，
  // 刷新/直接打开由 routes.js 解析恢复；根入口（/、/admin/）replace 规整到 /admin/overview。
  const location = useAdminLocation();
  useRootRedirect(location);
  const route = useMemo(() => resolveRoute(location), [location]);
  const page = route?.page || null;
  const [toast, setToastState] = useState(null);
  const [confirm, setConfirm] = useState(null);
  // 表单确认弹窗：需要填写原因/时间的操作统一走这里（替代原生 window.prompt），
  // 表单本身即确认步骤，提交后直接执行业务请求。
  const [formDialog, setFormDialog] = useState(null);
  // 未保存修改确认弹窗：router 层（浏览器返回/前进、受守卫导航）与退出登录共用同一裁决。
  // 弹窗打开期间的新目标以最近一次为准（router 内 pending 覆盖），不存在过期跳转。
  const [leaveConfirm, setLeaveConfirm] = useState(null);
  useEffect(() => {
    setNavigationConfirm((payload) => setLeaveConfirm(payload));
    return () => { setNavigationConfirm(null); cancelLeave(); };
  }, []);
  // 统一通知：成功默认对勾，错误用警告图标；调用方传 type="error" 表示错误。
  const notify = useCallback((text, type = "success") => setToastState({ text, type }), []);
  const [refreshKey, setRefreshKey] = useState(0);
  // 列表数据只给「已授权页面的列表屏」拉：无权限路由零请求（前端权限校验先于任何受保护请求），
  // 详情/编辑屏按 ID 自取数据，不依赖无关列表。
  const listAllowed = Boolean(route && (!route.permission || permissions.has(route.permission)));
  const needsList = route?.screen === "list";
  const listPage = usePagedRemote({ path: needsList && listAllowed ? ENDPOINTS[page] : null, schema: PAGED_LIST_SCHEMAS[page], refreshKey, expire });

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  // 确认弹窗统一动作执行：失败不再「一错就关」——
  //   会话过期：弹窗保持打开（含上下文），切换到登录遮罩，重登后可原位重试；
  //   明确安全的失败（限流/库繁忙/CSRF 刷新等，均发生在业务写入前或已回滚）：就地提供「重试」；
  //   其余错误：弹窗展示服务端原因，「返回修改」回到可编辑表单，输入一律不丢。
  // 重试安全性：仅对「单请求动作」（path/method 形态，401/安全码均发生在写入前）或显式声明
  // 检查点安全（retryableExecute，execute 内部只续跑未完成步骤）的复合动作提供原位重试；
  // 任意复合 execute 盲目重跑可能带旧 revision 重放已完成的第一段写入，一律只给「返回修改」。
  const run = useCallback(({ title, description, danger = false, path, method = "POST", body, execute, success, onSuccess, retryableExecute = false }) => {
    const canRetry = Boolean(path) || Boolean(retryableExecute);
    const action = async () => {
      setConfirm((current) => (current ? { ...current, pending: true, error: "", retryable: false } : current));
      try {
        if (execute) await execute();
        else await request(path, { method, body });
        setConfirm(null);
        notify(success);
        refresh();
        onSuccess?.();
      } catch (actionError) {
        if (actionError.kind === "session") {
          setConfirm((current) => (current ? { ...current, pending: false, error: "登录已过期，请重新登录后再试", retryable: canRetry } : null));
          expire();
          return;
        }
        const retryable = canRetry && SAFE_RETRY_CODES.has(actionError.code);
        setConfirm((current) => (current ? { ...current, pending: false, error: actionError.message, retryable } : null));
      }
    };
    setConfirm({ title, description, danger, pending: false, error: "", retryable: false, action });
  }, [expire, notify, refresh]);

  const ask = useCallback((config) => setFormDialog({ ...config, pending: false, error: "" }), []);
  const submitFormDialog = async (values) => {
    const config = formDialog;
    if (!config || config.pending) return;
    setFormDialog({ ...config, pending: true, error: "" });
    try {
      const body = typeof config.build === "function" ? config.build(values) : config.body;
      if (config.execute) await config.execute(values);
      else await request(config.path, { method: config.method || "POST", body });
      setFormDialog(null);
      notify(config.success);
      // skipRefresh：调用方正在编辑器内（如门店表单快捷新建品牌），全局刷新会把编辑器卸载回列表，只走 onSuccess 局部刷新。
      if (!config.skipRefresh) refresh();
      config.onSuccess?.();
    } catch (actionError) {
      // 会话过期弹窗保持打开：切到登录遮罩，重登（同账号）后已填内容仍在，可直接重试。
      if (actionError.kind === "session") { setFormDialog({ ...config, pending: false, error: "登录已过期，请重新登录后再试" }); expire(); }
      // 失败：弹窗保持，已填内容与保护不丢，后端错误就地展示（FormDialog 的 error 槽）。
      else setFormDialog({ ...config, pending: false, error: actionError.message });
    }
  };
  // 有未保存修改时的主动动作（菜单跳转由 navigate 内部裁决；这里覆盖退出登录等非导航动作）。
  const guardedAction = useCallback((action) => {
    if (navigationBlocked()) setLeaveConfirm({ kind: "action", action });
    else action();
  }, []);
  // 确认弹窗裁决：确认离开时连带丢弃页面上打开的对话框/执行确认（同属未保存内容），
  // 不让旧路由的弹窗带着过期回调存活到新路由；取消则全部保持原状。
  const resolveLeave = (leave) => {
    const payload = leaveConfirm;
    setLeaveConfirm(null);
    if (!payload) return;
    if (!leave) { cancelLeave(); return; }
    if (payload.kind === "action") { payload.action(); return; }
    setFormDialog(null);
    setConfirm(null);
    confirmLeave();
  };

  // —— 路由屏渲染：列表屏吃 workbench 级分页数据；详情/编辑屏按 URL 参数自行拉取权威数据 ——
  const renderScreen = () => {
    if (!route) return <RouteNotFound onBack={() => navigate(adminPaths.page("overview"))} />;
    // 手动输入无权限路径：先做前端权限校验（服务端 RBAC 仍是最终防线），给出可恢复的无权限页。
    if (route.permission && !permissions.has(route.permission)) return <NoPermission action={<button className="admin-primary" onClick={() => navigate(adminPaths.page(allowedNav[0]?.id || "overview"))}>返回首页</button>} />;
    const { page: pageId, screen, params, query } = route;
    if (pageId === "overview") return <Overview setPage={(target) => navigate(adminPaths.page(target))} />;
    if (pageId === "dashboard") return <Dashboard setToast={notify} />;
    if (screen === "list") {
      if (listPage.loading) return <StatePanel title="正在加载业务数据…" />;
      if (listPage.error) return <StatePanel title={listPage.error} action={<button className="admin-primary" onClick={refresh}>重新加载</button>} />;
      if (pageId === "users") return <UsersPage tab={query.get("tab")} onTab={(tab) => navigate(adminPaths.users(tab))} onNew={(kind) => navigate(adminPaths.userNew(kind))} onEdit={(row) => navigate(adminPaths.userEdit(row.id))} run={run} ask={ask} setToast={notify} />;
      if (pageId === "stores") return <Stores query={query} onFiltersChange={(next) => navigate(adminPaths.stores(next))} onNew={() => navigate(adminPaths.storeNew(query.toString()))} onEdit={(storeId) => navigate(adminPaths.storeEdit(storeId, query.toString()))} run={run} ask={ask} />;
      if (pageId === "campaigns") return <Campaigns data={listPage.data} onOpen={(row) => navigate(adminPaths.campaignDetail(row.id))} onEdit={(row) => navigate(adminPaths.campaignEdit(row.id, undefined, "list"))} onNew={() => navigate(adminPaths.campaignNew())} run={run} ask={ask} pager={listPage} canCleanup={role === "super_admin"} refresh={refresh} setToast={notify} />;
      if (pageId === "questionnaires") return <Questionnaires data={listPage.data} onOpen={(row) => navigate(adminPaths.questionnaireDetail(row.id))} onNew={() => navigate(adminPaths.questionnaireNew())} run={run} ask={ask} refresh={refresh} setToast={notify} pager={listPage} />;
      if (pageId === "submissions") return <Submissions appliedQuery={query} onApply={(next) => navigate(adminPaths.submissions(next))} onOpen={(row) => navigate(adminPaths.submissionDetail(row.id, query.toString()))} run={run} setToast={notify} />;
      if (pageId === "exports") return <Exports data={listPage.data} run={run} pager={listPage} />;
      if (pageId === "audits") return <Audits />;
      return <NoPermission />;
    }
    if (pageId === "users") {
      if (screen === "user-new") {
        const kind = query.get("kind") === "admin" ? "admin" : "inspector";
        return <UserEditor mode="new" kind={kind} onBack={() => navigate(adminPaths.users(kind))} run={run} reload={refresh} setToast={notify} />;
      }
      return <UserEditorRoute userId={params.id} onBackForKind={(kind) => navigate(adminPaths.users(kind))} run={run} reload={refresh} setToast={notify} />;
    }
    if (pageId === "stores") return <StoreEditorRoute storeId={screen === "store-new" ? null : params.id} onBack={() => navigate(`/admin/stores${listSearchOf("stores", query.get("list"))}`)} onCreated={(createdId) => forceNavigate(adminPaths.storeEdit(createdId, query.toString()), { replace: true })} ask={ask} notify={notify} />;
    if (pageId === "campaigns") {
      // closeWizard：from=list（列表进入/新建）关闭回列表并刷新；from=detail（详情进入）回任务详情（详情路由重查）。
      const closeWizard = (wizardId, from) => {
        if (from === "list" || !wizardId) { navigate(adminPaths.campaigns()); refresh(); }
        else navigate(adminPaths.campaignDetail(wizardId));
      };
      if (screen === "campaign-new") return <CampaignWizardRoute campaignId={null} step={1} from="list" setToast={notify} onClose={closeWizard} />;
      if (screen === "campaign-edit") return <CampaignWizardRoute campaignId={params.id} step={wizardStep(query)} from={query.get("from") === "list" ? "list" : "detail"} setToast={notify} onClose={closeWizard} />;
      if (screen === "campaign-detail") return <CampaignDetailRoute campaignId={params.id} onBack={() => { navigate(adminPaths.campaigns()); refresh(); }} run={run} ask={ask} setToast={notify} />;
      if (screen === "assignment-edit") return <AssignmentEditorRoute campaignId={params.id} assignmentId={params.assignmentId} onBack={() => navigate(adminPaths.campaignDetail(params.id))} run={run} />;
    }
    if (pageId === "questionnaires") {
      if (screen === "questionnaire-new") return <QuestionnaireEditorRoute onBack={() => { navigate(adminPaths.questionnaires()); refresh(); }} run={run} setToast={notify} />;
      if (screen === "questionnaire-version") return <QuestionnaireDetailRoute versionId={params.id} query={query} run={run} ask={ask} setToast={notify} />;
    }
    if (pageId === "submissions" && screen === "submission-detail") return <SubmissionDetailRoute submissionId={params.id} parentList={query.get("list") || ""} run={run} setToast={notify} />;
    return <NoPermission />;
  };

  return <div className="admin-shell"><aside className="admin-sidebar"><div className="admin-logo"><span>汇</span><div><strong>汇盈探店</strong><small>运营管理中心</small></div></div><nav>{allowedNav.map(({ id, label, icon: Icon }) => <button key={id} className={page === id ? "is-active" : ""} onClick={() => navigate(adminPaths.page(id))}><Icon size={19} weight={page === id ? "fill" : "regular"} /><span>{label}</span></button>)}</nav><div className="admin-user"><div>{session.user.displayName.slice(0, 1)}</div><span><strong>{session.user.displayName}</strong><small>{roleLabel(role)}</small>{session.user.scopeLabel ? <small className="user-scope">{session.user.scopeLabel}</small> : null}</span><button aria-label="退出登录" onClick={() => guardedAction(logout)}><SignOut size={18} /></button></div></aside><section className="admin-main"><main className="admin-content">{renderScreen()}</main></section><Toast toast={toast} onClose={() => setToastState(null)} /><Modal open={Boolean(confirm)} title={confirm?.title} description={confirm?.description} danger={confirm?.danger} error={confirm?.error} confirmLabel={confirm?.pending ? "处理中…" : confirm?.error ? (confirm.retryable ? "重试" : "返回修改") : "确认"} cancelLabel={confirm?.error ? "关闭" : "取消"} onCancel={() => !confirm?.pending && setConfirm(null)} onConfirm={confirm?.pending ? undefined : confirm?.error && !confirm.retryable ? () => setConfirm(null) : confirm?.action} /><FormDialog open={Boolean(formDialog)} title={formDialog?.title} description={formDialog?.description} danger={formDialog?.danger} fields={formDialog?.fields} initialValues={formDialog?.initialValues} pending={formDialog?.pending} error={formDialog?.error} confirmLabel={formDialog?.confirmLabel} onConfirm={submitFormDialog} onCancel={() => !formDialog?.pending && setFormDialog(null)} />{/* 离开确认始终最上层：脏态弹窗/编辑器之上仍可点按 */}<Modal open={Boolean(leaveConfirm)} title="有未保存的修改" description="离开当前页面将丢失未保存的内容。" danger confirmLabel="放弃并离开" cancelLabel="留在本页" onCancel={() => resolveLeave(false)} onConfirm={() => resolveLeave(true)} /></div>;
}

// 任务向导 step 查询串（详情页「添加探店员」直达 ?step=2）；非法值安全回退第 1 步。
function wizardStep(query) {
  const value = Number(query.get("step"));
  return [1, 2, 3].includes(value) ? value : 1;
}

// 游标分页 hook：首屏（path 已含 limit/filters，不带 cursor）整体替换；
// loadMore 带 cursor=已加载最后一条 id，结果按 id 去重后追加。
// 服务端筛选变化 = path 变化 = 自动重置游标重查；refreshKey 变化同样整表重置。
// 追加失败保留已加载行，错误经 moreError 展示在 pager 上可重试（再次点击加载更多即重试）。
function usePagedRemote({ path, schema, refreshKey = 0, expire }) {
  const [rows, setRows] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [total, setTotal] = useState(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [moreError, setMoreError] = useState("");
  const pathRef = useRef(path);
  const rowsRef = useRef(rows);
  const cursorRef = useRef(null);
  pathRef.current = path;
  rowsRef.current = rows;

  useEffect(() => {
    if (!path) {
      setRows([]); setNextCursor(null); setTotal(null); setError(""); setMoreError(""); setLoading(false); cursorRef.current = null;
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true); setError(""); setMoreError("");
    request(path, { signal: controller.signal, schema }).then((result) => {
      if (controller.signal.aborted) return;
      const nextRows = items(result);
      setRows(nextRows);
      setNextCursor(result?.nextCursor ?? null);
      setTotal(result?.total ?? null);
      cursorRef.current = nextRows.length ? nextRows.at(-1).id : null;
      setLoading(false);
    }).catch((loadError) => {
      if (controller.signal.aborted || (loadError.kind === "timeout" && controller.signal.aborted)) return;
      // 会话过期：列表呈现可重试的错误态（登录遮罩之上重登后点「重新加载」即可恢复），不留死 loading
      setError(loadError.message);
      setRows([]); setNextCursor(null); setTotal(null); cursorRef.current = null;
      setLoading(false);
      if (loadError.kind === "session") expire();
    });
    return () => controller.abort();
  }, [path, schema, refreshKey, expire]);

  const loadMore = useCallback(async () => {
    const basePath = pathRef.current;
    const cursor = cursorRef.current;
    if (!basePath || !cursor || loadingMore) return;
    setLoadingMore(true); setMoreError("");
    try {
      const joiner = basePath.includes("?") ? "&" : "?";
      const result = await request(`${basePath}${joiner}cursor=${encodeURIComponent(cursor)}`, { schema });
      if (pathRef.current !== basePath) return; // 筛选已切换：丢弃过期追加
      const seen = new Set(rowsRef.current.map((row) => row.id));
      const merged = [...rowsRef.current, ...items(result).filter((row) => !seen.has(row.id))];
      setRows(merged);
      setNextCursor(result?.nextCursor ?? null);
      if (result?.total != null) setTotal(result.total);
      cursorRef.current = merged.length ? merged.at(-1).id : null;
    } catch (loadError) {
      if (loadError.kind === "session") expire();
      else setMoreError(`${loadError.message}（已保留已加载内容）`);
    } finally { setLoadingMore(false); }
  }, [schema, expire, loadingMore]);

  const data = useMemo(() => (path ? { items: rows, nextCursor, total } : null), [path, rows, nextCursor, total]);
  return { data, rows, total, loading, loadingMore, error, moreError, hasMore: Boolean(nextCursor), loadMore };
}

// 列表尾部的「加载更多」：nextCursor 为 null（到底）时整体隐藏；按钮文案携带已加载条数。
function LoadMorePager({ rows, hasMore, loadingMore, moreError, onLoadMore, unit = "条" }) {
  if (!hasMore && !moreError) return null;
  return <div className="pager"><span>已加载 {rows.length} {unit}</span>{moreError ? <span className="form-message" role="alert">{moreError}</span> : null}<button className="admin-secondary" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? "正在加载…" : "加载更多"}</button></div>;
}

function Overview({ setPage }) {
  // 数据看板：按当前角色与可见范围统计；任一接口无权限或失败时对应卡片显示「—」，不影响其他卡片。
  const [stats, setStats] = useState(null);
  // 功能开关只读展示：来自公开 client-config（features.receiptOcr 由部署配置 OCR_PROVIDER 决定）。
  // 仅展示，不提供修改入口；获取失败显示「状态未知」，不影响概览其他内容。
  const [ocrFlag, setOcrFlag] = useState(null);
  useEffect(() => {
    let active = true;
    request(API.public.clientConfig)
      .then((payload) => { if (active) setOcrFlag(Boolean(payload?.features?.receiptOcr)); })
      .catch(() => { if (active) setOcrFlag("error"); });
    Promise.allSettled([
      request(`${API.admin.registrations}?limit=100`, { schema: PAGED_LIST_SCHEMAS.registrations }),
      request(`${API.admin.campaigns}?limit=100&order=desc`, { schema: PAGED_LIST_SCHEMAS.campaigns }),
      request(`${API.admin.questionnaireVersions}?limit=100&order=desc`, { schema: PAGED_LIST_SCHEMAS.questionnaires }),
      request(`${API.admin.stores}?limit=100`, { schema: PAGED_LIST_SCHEMAS.stores }),
      request(`${API.admin.submissions}?limit=100&order=desc`, { schema: PAGED_LIST_SCHEMAS.submissions }),
    ]).then(([registrations, campaigns, versions, stores, submissions]) => {
      if (!active) return;
      // 统计口径：仅首页 100 条的端点无法得出全量精确值——submissions 用后端 total，
      // 其余显示「N+」（nextCursor 非空表示至少还有一页）。
      const count = (result, pick) => {
        if (result.status !== "fulfilled") return null;
        const value = pick(result.value.items, result.value);
        return result.value.nextCursor ? `${value}+` : value;
      };
      setStats({
        pendingRegistrations: count(registrations, (items) => items.filter((item) => item.status === "pending_approval").length),
        draftCampaigns: count(campaigns, (items) => items.filter((item) => item.status === "draft").length),
        inProgressCampaigns: count(campaigns, (items) => items.filter((item) => item.status === "in_progress").length),
        overdueAssignments: count(campaigns, (items) => items.reduce((sum, item) => sum + (item.overdueCount || 0), 0)),
        publishedVersions: count(versions, (items) => items.filter((item) => item.status === "published").length),
        storeCount: count(stores, (items) => items.length),
        submissions: submissions.status === "fulfilled" ? (submissions.value.total ?? submissions.value.items.length) : null,
        recentSubmissions: submissions.status === "fulfilled" ? submissions.value.items.slice(0, 5) : null,
      });
    });
    return () => { active = false; };
  }, []);
  const cards = [
    { label: "待审核申请", value: stats?.pendingRegistrations, icon: Users, page: "users" },
    { label: "待发布任务", value: stats?.draftCampaigns, icon: CalendarBlank, page: "campaigns" },
    { label: "进行中任务", value: stats?.inProgressCampaigns, icon: CalendarBlank, page: "campaigns" },
    { label: "逾期指派", value: stats?.overdueAssignments, icon: WarningCircle, page: "campaigns" },
    { label: "已发布问卷", value: stats?.publishedVersions, icon: ClipboardText, page: "questionnaires" },
    { label: "门店", value: stats?.storeCount, icon: Storefront, page: "stores" },
    { label: "累计提交", value: stats?.submissions, icon: FileText, page: "submissions" },
  ];
  return <><PageHeader eyebrow="运营概览" title="暗访执行工作台" description="以下数字按你的角色和可见范围实时统计，点击卡片可直接进入对应功能。" /><section className="metric-grid">{cards.map(({ label, value, icon: Icon, page }) => <button key={label} className="metric-card" onClick={() => setPage(page)}><Icon size={20} /><strong>{value ?? "—"}</strong><span>{label}</span></button>)}</section><section className="overview-grid"><div className="panel panel--wide"><div className="panel-heading"><div><h2>最近提交</h2></div><button className="admin-secondary" onClick={() => setPage("submissions")}>查看全部</button></div>{stats?.recentSubmissions?.length ? <div className="recent-submissions">{stats.recentSubmissions.map((row) => <div key={row.id}><span className="rs-name">{row.inspectorName}</span><span className="rs-task">{row.taskName}</span><span className="rs-score">{row.scoreRate}</span><span className="rs-time">{formatTime(row.submittedAt)}</span></div>)}</div> : <div className="empty-business"><strong>{stats ? "还没有提交记录" : "正在加载…"}</strong></div>}</div><div className="panel"><div className="panel-heading"><div><h2>功能开关</h2></div></div><div className="feature-flags"><div className="feature-flag"><span>小票识别（OCR）</span><StatusBadge tone={ocrFlag === true ? "success" : "neutral"}>{ocrFlag === null ? "读取中…" : ocrFlag === "error" ? "状态未知" : ocrFlag ? "已开启" : "未开启"}</StatusBadge></div><p className="feature-flag-hint">开启后探店员可在菜品页识别小票并带入菜品；本开关由服务端部署配置 OCR_PROVIDER 控制，修改 .env 并重启服务后立即生效，无需小程序发版。</p></div></div></section></>;
}

function UsersPage({ tab: tabParam, onTab, onNew, onEdit, run, ask, setToast }) {
  const { session, expire } = useAdminAuth();
  const currentUserId = session.user.id;
  // tab 由 URL 查询串驱动（?tab=inspector|admin|registrations），非法值安全回退探员 tab。
  const tab = ["inspector", "admin", "registrations"].includes(tabParam) ? tabParam : "inspector";
  const setTab = (value) => onTab(value);
  const [version, setVersion] = useState(0);
  // 三个数据源各自独立游标，tab 间互不影响；任一操作成功后 reload 让三源整体重置回首页。
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const regsPage = usePagedRemote({ path: `${API.admin.registrations}?limit=${PAGE_SIZE}&order=desc`, schema: PAGED_LIST_SCHEMAS.registrations, refreshKey: version, expire });
  const inspectorsPage = usePagedRemote({ path: `${API.admin.users}?kind=inspector&limit=${PAGE_SIZE}&order=desc`, schema: PAGED_LIST_SCHEMAS.users, refreshKey: version, expire });
  const adminsPage = usePagedRemote({ path: `${API.admin.users}?kind=admin&limit=${PAGE_SIZE}&order=desc`, schema: PAGED_LIST_SCHEMAS.users, refreshKey: version, expire });
  const registrations = regsPage.rows;
  const inspectors = inspectorsPage.rows;
  const admins = adminsPage.rows;
  const error = regsPage.error || inspectorsPage.error || adminsPage.error;
  const isRegistrationTab = tab === "registrations";
  const isInspectorTab = tab === "inspector";
  const rows = isInspectorTab ? inspectors : admins;
  const activePager = isRegistrationTab ? regsPage : isInspectorTab ? inspectorsPage : adminsPage;
  // 行内自我保护标记：当前登录账号不可停用/删除（后端同样拦截），避免误删自己
  const selfRow = (row) => row.id === currentUserId;
  return <><PageHeader eyebrow="人员管理" title="用户管理" description="管理员手动创建账号并控制账号设置；小程序注册的探员需审批后生效。" action={isRegistrationTab ? null : <button className="admin-primary" onClick={() => onNew(isInspectorTab ? "inspector" : "admin")}><Plus size={17} /> {isInspectorTab ? "新建探员" : "新建管理员"}</button>} />{error ? <p className="form-message" role="alert">{error}</p> : null}<div className="status-tabs" role="tablist"><button className={isInspectorTab ? "is-active" : ""} onClick={() => setTab("inspector")}>探员账号<span>{inspectors.length}{inspectorsPage.hasMore ? "+" : ""}</span></button><button className={tab === "admin" ? "is-active" : ""} onClick={() => setTab("admin")}>管理员账号<span>{admins.length}{adminsPage.hasMore ? "+" : ""}</span></button><button className={isRegistrationTab ? "is-active" : ""} onClick={() => setTab("registrations")}>注册审批<span>{registrations.filter((row) => row.status === "pending_approval").length}{regsPage.hasMore ? "+" : ""}</span></button></div>{isRegistrationTab ? <RegistrationPanel rows={registrations} run={run} ask={ask} reload={reload} pager={regsPage} /> : <DataPanel empty={`当前没有${isInspectorTab ? "探员" : "管理员"}账号`}><table className="data-table"><thead><tr>{isInspectorTab ? <><th>探员</th><th>手机号</th><th>来源</th><th>状态</th><th>操作</th></> : <><th>管理员</th><th>手机号</th><th>可见范围</th><th>状态</th><th>操作</th></>}</tr></thead><tbody>{rows.map((row) => { const self = selfRow(row); return <tr key={row.id} className={self ? "row-current-user" : ""}><td><strong>{row.displayName}</strong>{self && <StatusBadge tone="success">当前登录</StatusBadge>}<small>{row.username}{isInspectorTab ? "" : ` · ${roleLabel(row.roleCode)}`}</small></td><td>{row.maskedPhone}</td><td>{isInspectorTab ? (row.source === "registration" ? "注册" : "手动创建") : row.scopeLabel || "—"}</td><td><StatusBadge>{toStatusLabel(row.status)}</StatusBadge></td><td><div className="table-actions"><button onClick={() => onEdit(row)}>编辑</button>{row.status === "approved_active" && <button className="link-danger" disabled={self} title={self ? "不能停用当前登录的账号" : undefined} onClick={() => askReason(ask, { title: `停用这名${isInspectorTab ? "探员" : "管理员"}？`, description: "停用后该账号将立即无法登录。", danger: true, reasonLabel: "停用原因", confirmLabel: "确认停用", path: API.admin.disableUser(row.id), body: { revision: row.revision }, success: "账号已停用", onSuccess: reload })}>停用</button>}{row.status === "disabled" && <button onClick={() => askReason(ask, { title: `启用这名${isInspectorTab ? "探员" : "管理员"}？`, description: "启用后该账号可立即登录。", reasonLabel: "启用原因", confirmLabel: "确认启用", path: API.admin.enableUser(row.id), body: { revision: row.revision }, success: "账号已启用", onSuccess: reload })}>启用</button>}<button className="link-danger" disabled={self} title={self ? "不能删除当前登录的账号" : undefined} onClick={() => run({ title: "删除这个账号？", description: "账号若关联探店任务、提交记录或注册申请将无法删除（可改为停用）；删除后其创建的业务记录将移交给当前操作者，审计历史保留。", danger: true, path: API.admin.deleteUser(row.id), method: "DELETE", body: { revision: row.revision }, success: "账号已删除", onSuccess: reload })}>删除</button></div></td></tr>; })}</tbody></table></DataPanel>}{!isRegistrationTab && <LoadMorePager rows={rows} hasMore={activePager.hasMore} loadingMore={activePager.loadingMore} moreError={activePager.moreError} onLoadMore={activePager.loadMore} unit="个账号" />}</>;
}

function RegistrationPanel({ rows, run, ask, reload, pager }) {
  const [status, setStatus] = useState("pending_approval");
  const visibleRows = rows.filter((row) => row.status === status);
  const filters = [["pending_approval", "待审核"], ["approved_active", "已批准"], ["rejected", "未通过"], ["disabled", "已停用"]];
  return <section className="panel registration-panel"><div className="panel-heading"><div><h2>注册审批</h2></div></div><div className="status-tabs" role="tablist">{filters.map(([value, label]) => <button key={value} className={status === value ? "is-active" : ""} onClick={() => setStatus(value)}>{label}<span>{rows.filter((row) => row.status === value).length}</span></button>)}</div><DataPanel empty={`当前没有${filters.find(([value]) => value === status)?.[1] || "对应状态"}申请`}><table className="data-table"><thead><tr><th>申请人</th><th>用户名</th><th>手机号</th><th>申请时间</th><th>状态</th><th>操作</th></tr></thead><tbody>{visibleRows.map((row) => <tr key={row.id}><td><strong>{row.displayName}</strong></td><td>{row.username}</td><td>{row.maskedPhone}</td><td>{formatTime(row.appliedAt)}</td><td><StatusBadge>{toStatusLabel(row.status)}</StatusBadge></td><td><div className="table-actions">{row.status === "pending_approval" && <><button onClick={() => run({ title: "批准这名探店员？", description: "批准后可以登录并接受新的暗访任务。", path: API.admin.approveRegistration(row.id), body: { revision: row.revision }, success: "申请已批准", onSuccess: reload })}>批准</button><button className="link-danger" onClick={() => askReason(ask, { title: "不批准这次申请？", description: "未通过的探店员会看到原因，可重新提交注册信息。", danger: true, reasonLabel: "不批准原因", confirmLabel: "确认不批准", path: API.admin.rejectRegistration(row.id), body: { revision: row.revision }, success: "申请已更新为未通过", onSuccess: reload })}>不批准</button></>}{row.status === "rejected" && <button onClick={() => askReason(ask, { title: "重新打开申请？", description: "申请将回到待审核，仍需重新审批。", reasonLabel: "重新打开原因", confirmLabel: "重新打开", path: API.admin.reopenRegistration(row.id), body: { revision: row.revision }, success: "申请已重新打开", onSuccess: reload })}>重新打开</button>}{row.userId && row.status === "approved_active" && <button className="link-danger" onClick={() => askReason(ask, { title: "停用这名探店员？", description: "停用后该账号将无法登录小程序。", danger: true, reasonLabel: "停用原因", confirmLabel: "确认停用", path: API.admin.disableUser(row.userId), body: {}, success: "账号已停用", onSuccess: reload })}>停用</button>}{row.userId && row.status === "disabled" && <button onClick={() => askReason(ask, { title: "启用这名探店员？", description: "启用后可重新登录并接受任务。", reasonLabel: "启用原因", confirmLabel: "确认启用", path: API.admin.enableUser(row.userId), body: {}, success: "账号已启用", onSuccess: reload })}>启用</button>}</div></td></tr>)}</tbody></table></DataPanel>{pager && <LoadMorePager rows={rows} hasMore={pager.hasMore} loadingMore={pager.loadingMore} moreError={pager.moreError} onLoadMore={pager.loadMore} unit="份申请" />}</section>;
}

function UserEditor({ mode, kind, row, onBack, run, reload, setToast }) {
  const isNew = mode === "new";
  const [form, setForm] = useState(isNew
    ? { kind, username: "", displayName: "", phone: "", password: "", scopeType: "all", regionId: "", storeId: "" }
    : { kind: kind, displayName: row.displayName, status: row.status, password: "", scopeType: row.scopeType || "all", regionId: row.regionId || "", storeId: row.storeId || "" });
  // 未保存修改守卫：与挂载时的表单快照比较（异步加载区域/门店选项不算编辑；改动后改回原值即不脏）。
  const formRef = useRef(form);
  formRef.current = form;
  const formBaselineRef = useRef(form);
  useNavigationGuard(useCallback(() => JSON.stringify(formRef.current) !== JSON.stringify(formBaselineRef.current), []));
  const [regions, setRegions] = useState([]);
  const [stores, setStores] = useState([]);
  const [provinceId, setProvinceId] = useState("");
  const [cityId, setCityId] = useState("");
  useEffect(() => {
    let active = true;
    Promise.all([
      request(API.admin.regions, { schema: listSchema(RegionRowSchema) }).catch(() => ({ items: [] })),
      request(`${API.admin.stores}?limit=100`, { schema: ADMIN_LIST_SCHEMAS.stores }).catch(() => ({ items: [] })),
    ]).then(([regionResult, storeResult]) => {
      if (!active) return;
      setRegions(regionResult.items);
      setStores(storeResult.items);
      if (form.regionId) {
        const selected = regionResult.items.find((region) => region.id === form.regionId);
        if (selected?.parentId) {
          const city = regionResult.items.find((region) => region.id === selected.parentId);
          setCityId(city?.id || "");
          setProvinceId(city?.parentId || "");
        }
      }
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const patch = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const provinces = regions.filter((region) => region.level === 1);
  const cities = regions.filter((region) => region.level === 2 && region.parentId === provinceId);
  const districts = regions.filter((region) => region.level === 3 && region.parentId === cityId);
  const save = () => {
    const body = isNew
      ? { kind: form.kind, username: form.username.trim(), displayName: form.displayName.trim(), phone: form.phone.trim(), password: form.password, ...(form.kind !== "inspector" ? { scopeType: form.scopeType, regionId: form.scopeType === "region" ? form.regionId : null, storeId: form.scopeType === "store" ? form.storeId : null } : {}) }
      : { displayName: form.displayName.trim(), status: form.status, kind: form.kind, ...(form.password ? { password: form.password } : {}), ...(form.kind !== "inspector" ? { scopeType: form.scopeType, regionId: form.scopeType === "region" ? form.regionId : null, storeId: form.scopeType === "store" ? form.storeId : null } : {}) };
    const parsed = (isNew ? UserCreateSchema : UserUpdateSchema).safeParse(body);
    if (!parsed.success) { setToast(parsed.error.issues.map((issue) => issue.message).join("；"), "error"); return; }
    run({ title: isNew ? "创建这个账号？" : "保存账号设置？", description: isNew ? "创建后账号立即可用（探员直接激活，管理员可登录后台）。" : "重置密码后该用户所有会话将立即失效。", execute: async () => { await request(isNew ? API.admin.createUser : API.admin.user(row.id), { method: isNew ? "POST" : "PATCH", body }); formBaselineRef.current = { ...formRef.current }; }, success: isNew ? "账号已创建" : "账号设置已保存", onSuccess: reload });
  };
  const required = isNew ? Boolean(form.username.trim() && form.displayName.trim() && form.phone.trim() && form.password) : true;
  const scopeInvalid = form.kind !== "inspector" && form.scopeType === "region" && !form.regionId || form.kind !== "inspector" && form.scopeType === "store" && !form.storeId;
  const kindLabel = { admin: "管理员", auditor: "审计员", inspector: "探员" };
  return <><button className="back-link" onClick={onBack}><CaretRight size={15} /> 返回用户列表</button><PageHeader eyebrow="人员管理" title={isNew ? `新建${kindLabel[form.kind] || "账号"}` : "编辑账号"} description="账号密码由管理员设置，创建后立即可用。" /><section className="panel"><div className="field-grid">{isNew && <label className="admin-field"><span>用户名</span><input value={form.username} onChange={(event) => patch("username", event.target.value)} /></label>}<label className="admin-field"><span>姓名</span><input value={form.displayName} onChange={(event) => patch("displayName", event.target.value)} /></label>{isNew && <label className="admin-field"><span>手机号</span><input value={form.phone} onChange={(event) => patch("phone", event.target.value)} /></label>}<label className="admin-field"><span>账号类型</span><select value={form.kind} onChange={(event) => patch("kind", event.target.value)}><option value="inspector">探员</option><option value="admin">管理员</option><option value="auditor">审计员（查看全部内容与操作审计）</option></select></label>{!isNew && <label className="admin-field"><span>状态</span><select value={form.status} onChange={(event) => patch("status", event.target.value)}><option value="approved_active">启用</option><option value="disabled">停用</option></select></label>}<label className="admin-field"><span>{isNew ? "初始密码" : "重置密码（留空不修改）"}</span><input type="password" value={form.password} onChange={(event) => patch("password", event.target.value)} /></label>{form.kind !== "inspector" && <><label className="admin-field"><span>可见范围</span><select value={form.scopeType} onChange={(event) => patch("scopeType", event.target.value)}><option value="all">全部</option><option value="region">按区域</option><option value="store">按门店</option></select></label>{form.scopeType === "region" && <><label className="admin-field"><span>省份</span><select value={provinceId} onChange={(event) => { setProvinceId(event.target.value); setCityId(""); patch("regionId", ""); }}><option value="" disabled>请选择省份</option>{provinces.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select></label><label className="admin-field"><span>城市</span><select value={cityId} disabled={!provinceId} onChange={(event) => { setCityId(event.target.value); patch("regionId", ""); }}><option value="" disabled>请选择城市</option>{cities.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select></label><label className="admin-field"><span>区县</span><select value={form.regionId} disabled={!cityId} onChange={(event) => patch("regionId", event.target.value)}><option value="" disabled>请选择区县</option>{districts.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select></label></>}{form.scopeType === "store" && <label className="admin-field"><span>门店</span><select value={form.storeId} onChange={(event) => patch("storeId", event.target.value)}><option value="" disabled>请选择门店</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>}</>}</div><div className="editor-footer"><button className="admin-primary" onClick={save} disabled={!required || scopeInvalid}>保存</button></div></section></>;
}

function Stores({ query, onFiltersChange, onNew, onEdit, run, ask }) {
  // 品牌列表不可用（如权限或服务异常）时收起品牌面板，门店列表本身不受影响。
  const [brands, setBrands] = useState(null);
  const loadBrands = useCallback(() => {
    request(API.admin.brands, { schema: ADMIN_LIST_SCHEMAS.brands }).then((result) => setBrands(result.items)).catch(() => setBrands(null));
  }, []);
  useEffect(() => { loadBrands(); }, [loadBrands]);
  const brandList = brands || [];
  // 城市选项改从 regions 全量端点取（市级 level=2）：不再从已加载门店行派生，避免未加载到的城市缺失。
  const [cities, setCities] = useState([]);
  useEffect(() => {
    let active = true;
    request(API.admin.regions, { schema: listSchema(RegionRowSchema) }).then((result) => { if (active) setCities(result.items.filter((region) => region.level === 2)); }).catch(() => { if (active) setCities([]); });
    return () => { active = false; };
  }, []);
  // 「城市 x 品牌」筛选升级为服务端参数（brandId/cityRegionId）：条件变化即换 path，usePagedRemote 自动重置游标重查。
  // 筛选以列表 URL 查询串为准（白名单键）：进入编辑器再返回（站内返回或浏览器返回）筛选与行集保持；
  // 刷新/书签同样恢复；请求契约（limit/cityRegionId/brandId）不变。
  const filters = { cityRegionId: query.get("cityRegionId") || "", brandId: query.get("brandId") || "" };
  const patchFilter = (field, value) => onFiltersChange({ ...filters, [field]: value });
  const [retryKey, setRetryKey] = useState(0);
  const reloadStores = useCallback(() => setRetryKey((value) => value + 1), []);
  const storesPath = useMemo(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (filters.cityRegionId) params.set("cityRegionId", filters.cityRegionId);
    if (filters.brandId) params.set("brandId", filters.brandId);
    return `${API.admin.stores}?${params}`;
  }, [filters]);
  const storesPage = usePagedRemote({ path: storesPath, schema: PAGED_LIST_SCHEMAS.stores, refreshKey: retryKey });
  const rows = storesPage.rows;
  const afterBrandChange = () => { loadBrands(); reloadStores(); };
  const askCreateBrand = () => ask({
    title: "新建品牌", description: "品牌用于按「城市 → 品牌」组织门店，创建后可在新建门店时选择。",
    fields: [{ name: "name", label: "品牌名称", required: true, placeholder: "例如：肯德基" }],
    build: (values) => ({ name: values.name.trim(), active: true }), path: API.admin.createBrand, success: "品牌已创建", onSuccess: afterBrandChange,
  });
  const askRenameBrand = (brand) => ask({
    title: `重命名品牌「${brand.name}」`,
    fields: [{ name: "name", label: "品牌名称", required: true }], initialValues: { name: brand.name },
    build: (values) => ({ name: values.name.trim(), active: brand.active, revision: brand.revision }), path: API.admin.brand(brand.id), method: "PATCH", success: "品牌已更新", onSuccess: afterBrandChange,
  });
  const cityOptions = cities.map((region) => [region.id, region.name]);
  const hasFilter = Boolean(filters.cityRegionId || filters.brandId);
  if (storesPage.loading) return <StatePanel title="正在加载业务数据…" />;
  if (storesPage.error) return <StatePanel title={storesPage.error} action={<button className="admin-primary" onClick={reloadStores}>重新加载</button>} />;
  return <><PageHeader eyebrow="门店管理" title="门店与打卡范围" description="门店按「城市 → 品牌」组织；打卡是否通过由系统最终判断。" action={<button className="admin-primary" onClick={onNew}><Plus size={17} /> 新建门店</button>} />
    {brands !== null && <section className="panel brand-panel"><div className="panel-heading"><div><h2>品牌</h2></div><button className="admin-secondary" onClick={askCreateBrand}><Plus size={15} /> 新建品牌</button></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>品牌</th><th>关联门店</th><th>状态</th><th>操作</th></tr></thead><tbody>{brandList.map((brand) => <tr key={brand.id}><td><strong>{brand.name}</strong></td><td>{brand.storeCount ?? 0} 家</td><td><StatusBadge>{brand.active ? "已启用" : "已停用"}</StatusBadge></td><td><div className="table-actions"><button onClick={() => askRenameBrand(brand)}>重命名</button>{brand.active && <button className="link-danger" onClick={() => run({ title: `停用品牌「${brand.name}」？`, description: "停用后新建门店不能再选择该品牌，已有门店不受影响。", danger: true, path: API.admin.brand(brand.id), method: "PATCH", body: { name: brand.name, active: false, revision: brand.revision }, success: "品牌已停用", onSuccess: afterBrandChange })}>停用</button>}{!brand.active && <button onClick={() => run({ title: `启用品牌「${brand.name}」？`, description: "启用后新建门店可重新选择该品牌。", path: API.admin.brand(brand.id), method: "PATCH", body: { name: brand.name, active: true, revision: brand.revision }, success: "品牌已启用", onSuccess: afterBrandChange })}>启用</button>}<button className="link-danger" onClick={() => run({ title: `删除品牌「${brand.name}」？`, description: "仅当品牌没有关联门店时才能删除；已关联时请改为停用。", danger: true, path: API.admin.deleteBrand(brand.id), method: "DELETE", body: { revision: brand.revision }, success: "品牌已删除", onSuccess: afterBrandChange })}>删除</button></div></td></tr>)}</tbody></table></div></section>}
    <section className="panel"><div className="filter-grid"><label className="admin-field"><span>城市</span><select aria-label="门店城市筛选" value={filters.cityRegionId} disabled={cityOptions.length === 0} onChange={(event) => patchFilter("cityRegionId", event.target.value)}><option value="">全部城市</option>{cityOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label className="admin-field"><span>品牌</span><select aria-label="门店品牌筛选" value={filters.brandId} disabled={brandList.length === 0} onChange={(event) => patchFilter("brandId", event.target.value)}><option value="">全部品牌</option>{brandList.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></label>{hasFilter && <div className="admin-field filter-clear"><span>&nbsp;</span><button className="admin-secondary" onClick={() => onFiltersChange({ cityRegionId: "", brandId: "" })}>清除筛选</button></div>}</div></section>
    <DataPanel empty="当前授权范围内没有门店"><table className="data-table"><thead><tr><th>门店</th><th>品牌</th><th>区域</th><th>状态</th><th>打卡半径</th><th>操作</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><strong>{row.name}</strong><small>{row.businessNo}</small></td><td>{row.brandName || "—"}</td><td>{row.regionName}<small>{row.cityName || ""}</small></td><td><StatusBadge>{row.active ? "已启用" : "已停用"}</StatusBadge></td><td>{row.radiusMeters} 米</td><td><div className="table-actions"><button onClick={() => onEdit(row.id)}>编辑范围</button><button className="link-danger" onClick={() => run({ title: "删除这家门店？", description: "仅当门店未被任何探店任务引用时才能删除；被引用时请改为停用。", danger: true, path: API.admin.deleteStore(row.id), method: "DELETE", body: { revision: row.revision }, success: "门店已删除", onSuccess: reloadStores })}>删除</button></div></td></tr>)}</tbody></table></DataPanel>
    <LoadMorePager rows={rows} hasMore={storesPage.hasMore} loadingMore={storesPage.loadingMore} moreError={storesPage.moreError} onLoadMore={storesPage.loadMore} unit="家门店" /></>;
}

// 门店表单校验：本地友好提示先行（对齐 StoreWriteSchema 的业务约束），再用契约 schema 兜底；
// STORE_FIELD_ORDER 决定「聚焦第一个错误字段」的顺序。
const STORE_FIELD_ORDER = ["businessNo", "name", "brandId", "regionId", "address", "coordinate", "radiusMeters", "accuracyAllowanceMaxMeters"];
const storeFieldId = (field) => `store-field-${field}`;
const hasStoreCoordinate = (form) => form.latitude !== null && form.latitude !== undefined && form.latitude !== "" && form.longitude !== null && form.longitude !== undefined && form.longitude !== "";

function storeBodyOf(form) {
  return {
    name: String(form.name || "").trim(),
    businessNo: String(form.businessNo || "").trim(),
    brandId: form.brandId || undefined,
    regionId: form.regionId || undefined,
    address: String(form.address || "").trim(),
    latitudeGcj02: hasStoreCoordinate(form) ? Number(form.latitude) : undefined,
    longitudeGcj02: hasStoreCoordinate(form) ? Number(form.longitude) : undefined,
    providerPoiId: form.providerPoiId || null,
    coordinateSource: form.coordinateSource || "manual_adjusted",
    radiusMeters: Number(form.radiusMeters),
    accuracyAllowanceMaxMeters: Number(form.accuracyAllowanceMaxMeters),
    // 坐标只能通过地图选点产生：保存时带有效坐标即视为管理员已完成位置校准。
    locationVerified: hasStoreCoordinate(form),
    active: Boolean(form.active),
  };
}

function validateStoreForm(form) {
  const errors = {};
  const businessNo = String(form.businessNo || "").trim();
  const name = String(form.name || "").trim();
  const address = String(form.address || "").trim();
  if (!businessNo) errors.businessNo = "请填写门店编号";
  else if (businessNo.length > 64) errors.businessNo = "门店编号最多 64 个字符";
  if (!name) errors.name = "请填写门店名称";
  else if (name.length > 200) errors.name = "门店名称最多 200 个字符";
  if (!form.brandId) errors.brandId = "请选择品牌";
  if (!form.regionId) errors.regionId = "请选择省市区县";
  if (!address) errors.address = "请填写详细地址";
  else if (address.length > 500) errors.address = "地址最多 500 个字符";
  if (!hasStoreCoordinate(form)) errors.coordinate = "请在地图上搜索并选择门店位置";
  const radius = Number(form.radiusMeters);
  if (!Number.isInteger(radius) || radius < 100 || radius > 1000) errors.radiusMeters = "打卡半径须为 100–1000 米之间的整数";
  const accuracy = Number(form.accuracyAllowanceMaxMeters);
  if (!Number.isInteger(accuracy) || accuracy < 0 || accuracy > 200) errors.accuracyAllowanceMaxMeters = "允许定位误差须为 0–200 米之间的整数";
  const parsed = StoreWriteSchema.safeParse(storeBodyOf(form));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] || "");
      const field = key === "latitudeGcj02" || key === "longitudeGcj02" ? "coordinate" : key;
      if (STORE_FIELD_ORDER.includes(field) && !errors[field]) errors[field] = issue.message;
    }
  }
  return { errors };
}

function StoreEditor({ store, onBack, onCreated, ask, notify, brands }) {
  const { expire } = useAdminAuth();
  const [form, setForm] = useState({ active: true, ...store });
  // 权威快照：保存成功后推进（id/revision/规范化字段），下一次保存基于新 revision，
  // 不会 409，也不会因「新建后再次保存」重复创建。
  const [serverStore, setServerStore] = useState(store);
  // 未保存修改守卫：表单快照比较（输入与地图选点都算编辑；改回原值即不脏；保存成功后基准推进）。
  const formRef = useRef(form);
  formRef.current = form;
  const formBaselineRef = useRef(form);
  useNavigationGuard(useCallback(() => JSON.stringify(formRef.current) !== JSON.stringify(formBaselineRef.current), []));
  const [fieldErrors, setFieldErrors] = useState({});
  // 保存确认弹窗状态机：pending 提交中；error 非空展示原因（retryable 提供原位重试）；
  // 会话过期时弹窗保持现场，登录遮罩之上重登后可直接重试。
  const [saveState, setSaveState] = useState(null);
  // 乐观锁冲突：保存期间内容被他人更新——展示服务器最新字段供对照，用户选择保留谁的内容。
  const [conflict, setConflict] = useState(null);
  // 新建时的真实编号撞车：服务器上同编号是内容不同的他人门店——保留全部输入，绝不采纳/改写。
  const [duplicateStore, setDuplicateStore] = useState(null);
  // 区域列表：加载/失败/空态严格区分；失败给可重试错误态（含会话过期），重试不影响任何已填内容，
  // 省市联动的已选值在重试成功后按已保存的 regionId 恢复。
  const [regionsState, setRegionsState] = useState({ status: "loading", regions: [], error: "" });
  const [regionAttempt, setRegionAttempt] = useState(0);
  const [provinceId, setProvinceId] = useState("");
  const [cityId, setCityId] = useState("");
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setRegionsState((current) => ({ ...current, status: "loading", error: "" }));
    request(API.admin.regions, { schema: listSchema(RegionRowSchema), signal: controller.signal }).then((result) => {
      if (!active) return;
      setRegionsState({ status: "ready", regions: result.items, error: "" });
      const selected = result.items.find((region) => region.id === form.regionId);
      if (selected?.parentId) {
        const city = result.items.find((region) => region.id === selected.parentId);
        setCityId(city?.id || "");
        setProvinceId(city?.parentId || "");
      }
    }).catch((loadError) => {
      if (!active || controller.signal.aborted) return;
      setRegionsState({ status: "error", regions: [], error: loadError.kind === "session" ? "登录已失效，请重新登录后再试" : loadError.message });
      if (loadError.kind === "session") expire();
    });
    return () => { active = false; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionAttempt, expire]);
  const regions = regionsState.regions;
  const patch = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
    const related = field === "latitude" || field === "longitude" ? "coordinate" : field;
    setFieldErrors((current) => (current[related] ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== related)) : current));
  };
  // 地图选点回调：合并坐标/地址，并按 POI 区县名称自动匹配三级联动；
  // 匹配不到（如区县不在库）时只填地址，区域留给用户手动选。
  const applyPoi = (location) => {
    setForm((current) => ({ ...current, ...location }));
    setFieldErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== "coordinate")));
    if (location.district) {
      const district = regions.find((region) => region.level === 3 && region.name === location.district);
      if (district) {
        const city = regions.find((region) => region.id === district.parentId);
        setCityId(city?.id || "");
        setProvinceId(city?.parentId || "");
        setForm((current) => ({ ...current, regionId: district.id }));
        setFieldErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== "regionId")));
      }
    }
  };
  const provinces = regions.filter((region) => region.level === 1);
  const cities = regions.filter((region) => region.level === 2 && region.parentId === provinceId);
  const districts = regions.filter((region) => region.level === 3 && region.parentId === cityId);
  // 品牌选项：启用中的品牌 + 当前已选品牌（停用也保留显示并标注，后端保存时要求启用中的品牌）。
  const brandList = brands.brands || [];
  const selectedBrand = brandList.find((brand) => brand.id === form.brandId) || null;
  const brandOptions = form.brandId
    ? [selectedBrand
        ? { ...selectedBrand, inactive: !selectedBrand.active }
        : { id: form.brandId, name: `${serverStore.brandName || "所选品牌"}（未出现在品牌列表，请重试加载）`, inactive: true },
      ...brandList.filter((brand) => brand.active && brand.id !== form.brandId)]
    : brandList.filter((brand) => brand.active);
  const selectedInactive = Boolean(selectedBrand && !selectedBrand.active);
  // 表单内快捷新建品牌：创建成功后自动选为当前门店的品牌，并重载权威品牌列表，无需退回列表页。
  const askInlineBrand = () => ask({
    title: "新建品牌", description: "创建成功后将自动选为当前门店的品牌。",
    fields: [{ name: "name", label: "品牌名称", required: true, placeholder: "例如：肯德基" }],
    execute: async (values) => {
      const result = await request(API.admin.createBrand, { method: "POST", body: { name: values.name.trim(), active: true } });
      patch("brandId", result.brand.id);
    },
    success: "品牌已创建", skipRefresh: true, onSuccess: () => brands.reload(),
  });
  const adoptAuthoritative = (row) => {
    const authoritative = mapStoreRow(row);
    setServerStore(authoritative);
    setForm(authoritative);
    formBaselineRef.current = authoritative;
    setFieldErrors({});
    return authoritative;
  };
  const focusField = (field) => {
    const host = document.getElementById(storeFieldId(field));
    if (!host) return;
    host.scrollIntoView({ behavior: "smooth", block: "center" });
    host.querySelector("input, select, textarea, button")?.focus({ preventScroll: true });
  };
  // 新建保存结果的对账：以「发起请求那一刻的请求体快照」为准，而不是等待期间可能被继续编辑的表单。
  // 仅当服务器上同编号记录与本次提交的全部可编辑字段一致（数值按数字比较）时，才认定「上次保存
  // 已成功（响应丢失/不可用）」并自动切换为编辑该记录；编号相同但内容不同的门店是他人的记录，
  // 绝不自动采纳或改写——保留全部输入，弹窗说明并给出「修改编号 / 核对现有门店」的明确出路。
  const storeSnapshotsMatch = (row, attempted) => (
    row.businessNo === attempted.businessNo
    && row.name === attempted.name
    && (row.brandId || null) === (attempted.brandId || null)
    && (row.regionId || null) === (attempted.regionId || null)
    && row.address === attempted.address
    && Number(row.latitudeGcj02) === Number(attempted.latitudeGcj02)
    && Number(row.longitudeGcj02) === Number(attempted.longitudeGcj02)
    && Number(row.radiusMeters) === Number(attempted.radiusMeters)
    && Number(row.accuracyAllowanceMaxMeters ?? 200) === Number(attempted.accuracyAllowanceMaxMeters)
    && Boolean(row.active) === Boolean(attempted.active)
  );
  const reconcileExistingStore = async (attempted) => {
    const businessNo = attempted.businessNo;
    if (!businessNo) return false;
    let row = null;
    try {
      const result = await request(`${API.admin.stores}?limit=10&businessNo=${encodeURIComponent(businessNo)}`, { schema: PAGED_LIST_SCHEMAS.stores });
      row = result.items.find((item) => item.businessNo === businessNo) || null;
    } catch { return false; } // 对账查询失败：按原始保存错误处理
    if (!row) return false;
    if (storeSnapshotsMatch(row, attempted)) {
      // 等待对账期间表单又有新的本地修改：绝不静默覆盖，转为可读的不确定态交由用户处理。
      if (JSON.stringify(storeBodyOf(formRef.current)) !== JSON.stringify(attempted)) {
        setSaveState({ pending: false, error: "上一次保存可能已成功（服务器上已存在编号与内容一致的门店），但表单在此之后又有新的修改。请返回核对后再保存。", retryable: false });
        return true;
      }
      const authoritative = adoptAuthoritative(row);
      setSaveState(null);
      notify("该门店编号已存在且内容一致：上一次保存已成功，已切换为编辑现有门店");
      onCreated?.(authoritative.id);
      return true;
    }
    setDuplicateStore({ row });
    setSaveState(null);
    return true;
  };
  const openConflict = async (base) => {
    try {
      const result = await request(API.admin.storeDetail(base.id), { schema: z.object({ store: StoreRowSchema }) });
      setSaveState(null);
      setConflict(result.store);
    } catch (fetchError) {
      if (fetchError.kind === "session") {
        setSaveState({ pending: false, error: "登录已过期，请重新登录后再试", retryable: true });
        expire();
        return;
      }
      setSaveState({ pending: false, error: `无法获取服务器最新内容：${fetchError.message}`, retryable: false });
    }
  };
  const performSave = async (base = serverStore) => {
    setSaveState((current) => (current ? { ...current, pending: true, error: "", retryable: false } : { pending: true, error: "", retryable: false }));
    const editing = Boolean(base.id);
    const body = { ...storeBodyOf(formRef.current), ...(editing ? { revision: Number(base.revision) } : {}) };
    const attempted = { ...body }; // 发起请求时的快照：后续对账/采纳只看它，不受等待期间表单继续编辑的影响
    try {
      const result = await request(editing ? API.admin.store(base.id) : API.admin.stores, { method: editing ? "PATCH" : "POST", schema: z.object({ store: StoreRowSchema }), body });
      adoptAuthoritative(result.store);
      setSaveState(null);
      notify(editing ? "门店范围已保存" : "门店已创建");
      if (!editing) onCreated?.(result.store.id);
    } catch (saveError) {
      // 旧身份的迟到响应（认证代际已切换）：只就地展示，不触发过期遮罩、不进入任何恢复流。
      if (saveError.stale) { setSaveState({ pending: false, error: saveError.message, retryable: false }); return; }
      if (saveError.kind === "session") {
        // 弹窗保持现场：登录遮罩之上重登（同账号）后可直接重试，输入不丢。
        setSaveState({ pending: false, error: "登录已过期，请重新登录后再试", retryable: true });
        expire();
        return;
      }
      if (editing && saveError.code === "REVISION_CONFLICT") { await openConflict(base); return; }
      // 新建结果不确定（编号冲突/超时/网络中断/响应不可用）：先按唯一编号对账。
      if (!editing && (saveError.code === "STORE_CONFLICT" || ["timeout", "network", "contract"].includes(saveError.kind))) {
        if (await reconcileExistingStore(attempted)) return;
      }
      setSaveState({ pending: false, error: saveError.message, retryable: SAFE_RETRY_CODES.has(saveError.code) });
    }
  };
  const beginSave = () => {
    const { errors } = validateStoreForm(formRef.current);
    setFieldErrors(errors);
    const firstInvalid = STORE_FIELD_ORDER.find((field) => errors[field]);
    if (firstInvalid) { focusField(firstInvalid); return; }
    setSaveState({ pending: false, error: "", retryable: false });
  };
  const saveWithServerRevision = () => {
    if (!conflict) return;
    const base = conflict;
    setServerStore(mapStoreRow(base));
    setConflict(null);
    setSaveState({ pending: false, error: "", retryable: false });
    performSave(base);
  };
  const adoptServerVersion = () => {
    if (!conflict) return;
    adoptAuthoritative(conflict);
    setConflict(null);
    notify("已采用服务器上的最新内容");
  };
  return <><button className="back-link" onClick={onBack}><CaretRight size={15} /> 返回门店列表</button><PageHeader eyebrow="门店管理" title={store.id ? "编辑门店和范围" : "新建门店"} description="搜索地点后拖动地图微调，以地图中心作为门店坐标。" /><section className="panel"><div className="field-grid"><label className="admin-field" id={storeFieldId("businessNo")}><span>门店编号</span><input value={form.businessNo} onChange={(event) => patch("businessNo", event.target.value)} />{fieldErrors.businessNo && <p className="form-message" role="alert">{fieldErrors.businessNo}</p>}</label><label className="admin-field" id={storeFieldId("name")}><span>门店名称</span><input value={form.name} onChange={(event) => patch("name", event.target.value)} />{fieldErrors.name && <p className="form-message" role="alert">{fieldErrors.name}</p>}</label><label className="admin-field" id={storeFieldId("brandId")}><span>品牌</span><div className="field-with-action">{brands.error ? <span className="form-message">品牌列表加载失败：{brands.error}</span> : !brands.brands ? <span>正在加载品牌…</span> : <select value={form.brandId || ""} onChange={(event) => patch("brandId", event.target.value)}><option value="" disabled>请选择品牌</option>{brandOptions.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}{brand.inactive ? "（已停用）" : ""}</option>)}</select>}<button type="button" className="admin-secondary" onClick={askInlineBrand}><Plus size={14} /> 新建品牌</button>{brands.error && <button type="button" className="admin-secondary" onClick={brands.reload}>重试</button>}</div>{fieldErrors.brandId ? <p className="form-message" role="alert">{fieldErrors.brandId}</p> : selectedInactive ? <p className="form-message">当前品牌已停用：需先在「门店管理 → 品牌」中启用后才能保存（服务端保存时同样校验）。</p> : null}</label>{regionsState.status !== "ready" ? (regionsState.status === "error" ? <div className="admin-field" id={storeFieldId("regionId")}><span>区域</span><span className="form-message">区域列表加载失败：{regionsState.error}</span><div className="table-actions"><button type="button" className="admin-secondary" onClick={() => setRegionAttempt((value) => value + 1)}>重试</button></div></div> : <label className="admin-field" id={storeFieldId("regionId")}><span>区域</span><span>正在加载区域…</span></label>) : regions.length === 0 ? <label className="admin-field" id={storeFieldId("regionId")}><span>区域</span><span className="form-message">暂无可用区域；请先创建区域</span></label> : <><label className="admin-field"><span>省份</span><select value={provinceId} onChange={(event) => { setProvinceId(event.target.value); setCityId(""); patch("regionId", ""); }}><option value="" disabled>请选择省份</option>{provinces.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select></label><label className="admin-field"><span>城市</span><select value={cityId} disabled={!provinceId} onChange={(event) => { setCityId(event.target.value); patch("regionId", ""); }}><option value="" disabled>请选择城市</option>{cities.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select></label><label className="admin-field" id={storeFieldId("regionId")}><span>区县</span><select value={form.regionId || ""} disabled={!cityId} onChange={(event) => patch("regionId", event.target.value)}><option value="" disabled>请选择区县</option>{districts.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select>{fieldErrors.regionId && <p className="form-message" role="alert">{fieldErrors.regionId}</p>}</label></>}<label className="admin-field" id={storeFieldId("address")}><span>地址</span><input value={form.address || ""} onChange={(event) => patch("address", event.target.value)} />{fieldErrors.address && <p className="form-message" role="alert">{fieldErrors.address}</p>}</label><label className="admin-field" id={storeFieldId("radiusMeters")}><span>打卡半径（米）</span><input type="number" min="100" max="1000" value={form.radiusMeters} onChange={(event) => patch("radiusMeters", event.target.value)} />{fieldErrors.radiusMeters && <p className="form-message" role="alert">{fieldErrors.radiusMeters}</p>}</label><label className="admin-field" id={storeFieldId("accuracyAllowanceMaxMeters")}><span>允许定位误差（米）</span><input type="number" min="0" max="200" value={form.accuracyAllowanceMaxMeters} onChange={(event) => patch("accuracyAllowanceMaxMeters", event.target.value)} />{fieldErrors.accuracyAllowanceMaxMeters && <p className="form-message" role="alert">{fieldErrors.accuracyAllowanceMaxMeters}</p>}</label><label className="check-field store-active-field"><input type="checkbox" checked={form.active} onChange={(event) => patch("active", event.target.checked)} /><span>门店启用，可创建新任务</span></label></div><div id={storeFieldId("coordinate")}><TencentStoreMap value={form} radiusMeters={Number(form.radiusMeters)} onChange={applyPoi} />{fieldErrors.coordinate && <p className="form-message" role="alert">{fieldErrors.coordinate}</p>}</div><div className="editor-footer"><button className="admin-primary" onClick={beginSave} disabled={Boolean(saveState?.pending)}>{saveState?.pending ? "正在保存…" : "保存门店"}</button></div></section><Modal open={Boolean(saveState)} title="保存门店和打卡范围？" description="系统将检查门店坐标、100–1000 米打卡半径和允许定位误差。" danger={Boolean(saveState?.error)} error={saveState?.error} confirmLabel={saveState?.pending ? "保存中…" : saveState?.error ? (saveState.retryable ? "重试" : "返回修改") : "确认保存"} cancelLabel={saveState?.error ? "关闭" : "取消"} onCancel={() => !saveState?.pending && setSaveState(null)} onConfirm={saveState?.pending ? undefined : saveState?.error && !saveState.retryable ? () => setSaveState(null) : () => performSave()} />{duplicateStore && <div className="modal-backdrop" role="presentation" onMouseDown={() => setDuplicateStore(null)}><section className="modal-card modal-card--form" role="dialog" aria-modal="true" aria-labelledby="store-duplicate-title" onMouseDown={(event) => event.stopPropagation()}><h2 id="store-duplicate-title">门店编号已被其他门店使用</h2><p>编号「{duplicateStore.row.businessNo}」已属于现有门店「{duplicateStore.row.name}」（{duplicateStore.row.regionName || "未知区域"} · {duplicateStore.row.address}），内容与你正在新建的门店不同，因此没有自动关联或覆盖。</p><p>你填写的内容全部保留：可修改门店编号后重新保存；也可先核对现有门店再决定（核对会离开本页，未保存内容需确认放弃）。</p><div className="modal-actions"><button className="button button--ghost" onClick={() => setDuplicateStore(null)}>返回修改</button><button className="button button--danger" onClick={() => { const target = duplicateStore.row.id; setDuplicateStore(null); navigate(adminPaths.storeEdit(target)); }}>查看现有门店</button><button className="button button--primary" onClick={() => { setDuplicateStore(null); focusField("businessNo"); }}>修改门店编号</button></div></section></div>}{conflict && <div className="modal-backdrop" role="presentation" onMouseDown={() => setConflict(null)}><section className="modal-card modal-card--form" role="dialog" aria-modal="true" aria-labelledby="store-conflict-title" onMouseDown={(event) => event.stopPropagation()}><h2 id="store-conflict-title">门店已被他人更新</h2><p>保存时内容已被其他人修改。以下是服务器最新内容；你的修改仍保留在表单中，可选择保留谁的内容。</p><div className="conflict-server-fields"><div><span>门店编号</span><strong>{conflict.businessNo}</strong></div><div><span>门店名称</span><strong>{conflict.name}</strong></div><div><span>品牌</span><strong>{conflict.brandName || "—"}</strong></div><div><span>区域</span><strong>{conflict.regionName}</strong></div><div><span>地址</span><strong>{conflict.address}</strong></div><div><span>打卡半径</span><strong>{conflict.radiusMeters} 米</strong></div><div><span>允许定位误差</span><strong>{conflict.accuracyAllowanceMaxMeters ?? 200} 米</strong></div><div><span>启用状态</span><strong>{conflict.active ? "已启用" : "已停用"}</strong></div></div><div className="modal-actions"><button className="button button--ghost" onClick={() => setConflict(null)}>返回修改</button><button className="button button--danger" onClick={adoptServerVersion}>采用服务器内容</button><button className="button button--primary" onClick={saveWithServerRevision}>以我的修改为准保存</button></div></section></div>}</>;
}

function Campaigns({ data, onOpen, onEdit, onNew, run, ask, refresh, pager, canCleanup = false, setToast }) {
  const rows = items(data);
  // 测试任务数据清理（仅 super_admin、仅已整体取消的任务）：先预览计数与阻断原因，再输名称确认。
  const [cleanupTarget, setCleanupTarget] = useState(null);
  // 详情/向导改由路由承载：列表行点击 → /admin/campaigns/:id；编辑 → /admin/campaigns/:id/edit。
  return <><PageHeader eyebrow="探店任务" title="探店任务与指派" description="同店多人始终使用相互隔离的独立问卷。点击任务行查看指派明细。" action={<button className="admin-primary" onClick={onNew}><Plus size={17} /> 新建探店任务</button>} /><DataPanel empty="当前没有探店任务"><table className="data-table"><thead><tr><th>任务</th><th>门店</th><th>执行窗口</th><th>指派</th><th>逾期</th><th>状态</th><th>操作</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="row-link" onClick={() => onOpen(row)}><td><strong>{row.name}</strong><small>{row.businessNo}</small></td><td>{row.storeName}</td><td>{formatTime(row.startsAt)} 至 {formatTime(row.dueAt)}</td><td>{row.assignmentCount} 人</td><td>{row.overdueCount || 0}</td><td><StatusBadge>{toStatusLabel(row.status)}</StatusBadge></td><td onClick={(event) => event.stopPropagation()}><div className="table-actions"><button onClick={() => onOpen(row)}>查看指派</button>{row.status === "draft" && <><button onClick={() => onEdit(row)}>编辑</button><button onClick={() => run({ title: "发布这个任务？", description: "系统将检查门店位置、问卷版本、人员状态和所有指派。", path: API.admin.publishCampaign(row.id), body: { revision: row.revision }, success: "任务已发布", onSuccess: refresh })}>发布</button><button className="link-danger" onClick={() => run({ title: "删除这个任务？", description: "仅待发布任务可删除，其下未发布的指派将一并删除；已发布任务请用整体取消。", danger: true, path: API.admin.deleteCampaign(row.id), method: "DELETE", body: { revision: row.revision }, success: "任务已删除", onSuccess: refresh })}>删除</button></>}{!["completed", "cancelled"].includes(row.status) && <button className="link-danger" onClick={() => askReason(ask, { title: "整体取消任务？", description: "该任务下所有未提交的指派都会取消，探店员将在小程序中看到取消原因。", danger: true, reasonLabel: "整体取消原因", confirmLabel: "确认取消任务", path: API.admin.cancelCampaign(row.id), body: { revision: row.revision }, success: "任务已取消", onSuccess: refresh })}>整体取消</button>}{canCleanup && row.status === "cancelled" && <button className="link-danger" onClick={() => setCleanupTarget(row)}>清理测试数据</button>}</div></td></tr>)}</tbody></table></DataPanel><LoadMorePager rows={rows} hasMore={pager?.hasMore} loadingMore={pager?.loadingMore} moreError={pager?.moreError} onLoadMore={pager?.loadMore} unit="个任务" />{cleanupTarget && <CampaignCleanupDialog campaign={cleanupTarget} onClose={() => setCleanupTarget(null)} onDone={() => { setCleanupTarget(null); refresh(); setToast("任务测试数据已清理"); }} setToast={setToast} />}</>;
}

function CampaignDetail({ campaign, onBack, onEdit, onAddInspector, onEditAssignment, reload, run, ask, setToast }) {
  // 指派编辑器改由路由承载（/admin/campaigns/:campaignId/assignments/:assignmentId/edit）；
  // 豁免记录、延期弹窗是对话框，保持组件内状态。
  const [exemptionView, setExemptionView] = useState(null);
  // 延期弹窗：双窗口（执行截止/问卷最终截止，均可选但至少一项）+ 原因必填，
  // 独立于通用 FormDialog——失败时弹窗保持并就地展示后端错误，已填内容不丢。
  const [extendTarget, setExtendTarget] = useState(null);
  const [statusFilter, setStatusFilter] = useState("");
  const assignmentRows = campaign.assignments || [];
  const inspectExemptions = async (assignment) => {
    setExemptionView({ assignment, loading: true, error: "", items: [] });
    try { const result = await request(API.admin.exemptions(assignment.id)); setExemptionView({ assignment, loading: false, error: "", items: items(result) }); }
    catch (error) { setExemptionView({ assignment, loading: false, error: error.message, items: [] }); }
  };
  const actions = campaign.status === "draft" ? <div className="page-actions"><button className="admin-secondary" onClick={onEdit}>编辑探店任务</button><button className="admin-primary" onClick={() => run({ title: "发布这个任务？", description: "所有指派将分别出现在对应探店员日程。第一阶段不发送通知。", path: API.admin.publishCampaign(campaign.id), body: { revision: campaign.revision }, success: "任务已发布", onSuccess: reload })}>发布任务</button></div> : null;
  // 指派表状态筛选：只显示出现的的状态，降低扫视负担。
  const statusCounts = {};
  for (const row of assignmentRows) statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
  const filterChips = [{ value: "", label: "全部", count: assignmentRows.length }, ...Object.keys(statusCounts).filter((value) => value && statusCounts[value] > 0).map((value) => ({ value, label: toStatusLabel(value), count: statusCounts[value] }))];
  const visibleAssignments = statusFilter ? assignmentRows.filter((row) => row.status === statusFilter) : assignmentRows;
  // 每行一个主按钮（按状态智能选择）+ “更多”菜单收拢低频与危险操作。
  const mainActionOf = (row) => {
    if (row.status === "draft") return { label: "编辑要求", onClick: () => onEditAssignment(row) };
    if (["assigned", "in_progress", "overdue"].includes(row.status)) return { label: "延期", onClick: () => setExtendTarget(row) };
    return null;
  };
  const menuItemsOf = (row) => [
    row.status === "assigned" && { label: "编辑要求", onClick: () => onEditAssignment(row) },
    ["assigned", "in_progress"].includes(row.status) && { label: "豁免记录", onClick: () => inspectExemptions(row) },
    row.activeExemption ? { label: "撤销豁免", onClick: () => askRevokeExemption(ask, row) } : row.status === "assigned" ? { label: "打卡豁免", onClick: () => askExemption(ask, row) } : null,
    row.status === "draft" && { label: "删除", danger: true, onClick: () => run({ title: "删除这条未发布指派？", description: "仅当尚未建立问卷或外部引用时才能删除。", danger: true, path: API.admin.assignment(row.id), method: "DELETE", body: { revision: row.revision }, success: "未发布指派已删除", onSuccess: reload }) },
    !["draft", "submitted", "cancelled"].includes(row.status) && { label: "取消指派", danger: true, onClick: () => askReason(ask, { title: "取消这条指派？", description: "探店员将在小程序中看到取消原因。", danger: true, reasonLabel: "取消原因", confirmLabel: "确认取消", path: API.admin.cancelAssignment(row.id), body: { revision: row.revision }, success: "指派已取消", onSuccess: reload }) },
  ].filter(Boolean);
  return <><button className="back-link" onClick={onBack}><CaretRight size={15} /> 返回任务列表</button><PageHeader eyebrow="任务详情" title={campaign.name} description={`${campaign.storeName} · ${formatTime(campaign.startsAt)} 至 ${formatTime(campaign.dueAt)}`} action={actions} /><section className="campaign-summary"><div><span>任务状态</span><strong>{toStatusLabel(campaign.status)}</strong></div><div><span>指派人数</span><strong>{assignmentRows.length} 人</strong></div><div><span>逾期任务</span><strong>{campaign.overdueCount || 0} 项</strong></div></section>{campaign.commonInstruction && <section className="panel compact-panel"><strong>共用说明</strong><p>{campaign.commonInstruction}</p></section>}<section className="panel"><div className="panel-heading"><div><h2>探店员指派表</h2></div>{campaign.status === "draft" && <button className="admin-secondary" onClick={onAddInspector}><Plus size={16} /> 添加探店员</button>}</div><div className="status-tabs" role="tablist">{filterChips.map(({ value, label, count }) => <button key={value} className={statusFilter === value ? "is-active" : ""} onClick={() => setStatusFilter(value)}>{label}<span>{count}</span></button>)}</div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>探店员</th><th>任务类型</th><th>问卷版本</th><th>个人时间</th><th>状态</th><th>操作</th></tr></thead><tbody>{visibleAssignments.map((row) => { const main = mainActionOf(row); const menuItems = menuItemsOf(row); return <tr key={row.id}><td><strong>{row.inspectorName}</strong></td><td>{row.taskType === "secret" ? "暗访" : "明察"}</td><td>{row.questionnaireName}</td><td>{formatTime(row.startsAt)} 至 {formatTime(row.dueAt)}</td><td><StatusBadge>{toStatusLabel(row.status)}</StatusBadge></td><td><div className="table-actions">{main && <button onClick={main.onClick}>{main.label}</button>}<RowMenu items={menuItems} /></div></td></tr>; })}</tbody></table></div></section>{exemptionView && <ExemptionPanel state={exemptionView} onClose={() => setExemptionView(null)} onRevoke={(exemption) => askReason(ask, { title: "撤销这次打卡豁免？", description: "撤销后探店员需重新完成到店打卡。", danger: true, reasonLabel: "撤销原因", confirmLabel: "撤销豁免", path: API.admin.revokeExemption(exemptionView.assignment.id, exemption.id), body: { revision: exemption.revision }, success: "打卡豁免已撤销", onSuccess: () => inspectExemptions(exemptionView.assignment) })} />}{extendTarget && <ExtendDialog assignment={extendTarget} onClose={() => setExtendTarget(null)} onDone={() => { setExtendTarget(null); reload(); }} setToast={setToast} />}</>;
}

function ExemptionPanel({ state, onClose, onRevoke }) {
  return <section className="panel exemption-panel"><div className="panel-heading"><div><h2>{state.assignment.inspectorName} 的打卡豁免</h2></div><button className="admin-secondary" onClick={onClose}>关闭</button></div>{state.loading ? <p>正在加载豁免记录…</p> : state.error ? <p className="form-message">{state.error}</p> : state.items.length === 0 ? <p>当前没有打卡豁免记录</p> : <div className="exemption-list">{state.items.map((item) => <article key={item.id}><span><strong>{exemptionStatusLabel(item.status)}</strong><small>{item.validUntil ? `有效至 ${formatTime(item.validUntil)}` : formatTime(item.grantedAt)}</small></span><p>{item.reason || "未填写原因"}</p>{item.status === "active" && <button className="link-danger" onClick={() => onRevoke(item)}>撤销豁免</button>}</article>)}</div>}</section>;
}

// 问卷列表页：版本/分类管理与入口；版本详情与新建问卷由路由承载
// （/admin/questionnaires/:versionId、/admin/questionnaires/new）。
function Questionnaires({ data, onOpen, onNew, run, ask, refresh, setToast, pager }) {
  const rows = items(data);
  // 评估分类管理：管理员可新增/重命名/停用/删除（被题目引用时删除被拒）。加载失败时收起面板，不影响题库本身。
  const [categories, setCategories] = useState(null);
  const loadCategories = useCallback(() => {
    request(API.admin.questionCategories, { schema: ADMIN_LIST_SCHEMAS.questionCategories }).then((result) => setCategories(result.items)).catch(() => setCategories(null));
  }, []);
  useEffect(() => { loadCategories(); }, [loadCategories]);
  const categoryList = categories || [];
  const afterCategoryChange = () => { loadCategories(); refresh(); };
  const askCreateCategory = () => ask({
    title: "新建评估分类", description: "新建后可在问卷题目中使用；小程序答题页将按排序展示为标签页。",
    fields: [{ name: "name", label: "分类名称", required: true, placeholder: "例如：口味" }],
    build: (values) => ({ name: values.name.trim(), active: true }), path: API.admin.createQuestionCategory, success: "评估分类已创建", onSuccess: afterCategoryChange,
  });
  const askRenameCategory = (category) => ask({
    title: `重命名分类「${category.name}」`, description: "重命名只改展示名称，已有题目引用不受影响。",
    fields: [{ name: "name", label: "分类名称", required: true }], initialValues: { name: category.name },
    build: (values) => ({ name: values.name.trim(), active: category.active, revision: category.revision }), path: API.admin.questionCategory(category.id), method: "PATCH", success: "评估分类已更新", onSuccess: afterCategoryChange,
  });
  return <><PageHeader eyebrow="问卷题库" title="题库版本与证据配置" description="新建问卷草稿后可编辑题目与证据要求；已发布版本不可修改，调整必须复制为新草稿。" action={<button className="admin-primary" onClick={onNew}><Plus size={17} /> 新建问卷</button>} />
    {categories !== null && <CollapsiblePanel title="评估分类" description="小程序答题页与得分统计按此分类展示" count={categoryList.length} action={<button className="admin-secondary" onClick={askCreateCategory}><Plus size={15} /> 新建分类</button>}><div className="data-table-wrap"><table className="data-table"><thead><tr><th>分类</th><th>关联题目</th><th>状态</th><th>操作</th></tr></thead><tbody>{categoryList.map((category) => <tr key={category.id}><td><strong>{category.name}</strong></td><td>{category.questionCount ?? 0} 题</td><td><StatusBadge>{category.active ? "已启用" : "已停用"}</StatusBadge></td><td><div className="table-actions"><button onClick={() => askRenameCategory(category)}>重命名</button>{category.active && <button className="link-danger" onClick={() => run({ title: `停用分类「${category.name}」？`, description: "停用后新建问卷不能再选择该分类，已引用它的题目与发布校验不受影响。", danger: true, path: API.admin.questionCategory(category.id), method: "PATCH", body: { name: category.name, active: false, revision: category.revision }, success: "评估分类已停用", onSuccess: afterCategoryChange })}>停用</button>}{!category.active && <button onClick={() => run({ title: `启用分类「${category.name}」？`, description: "启用后新建问卷可重新选择该分类。", path: API.admin.questionCategory(category.id), method: "PATCH", body: { name: category.name, active: true, revision: category.revision }, success: "评估分类已启用", onSuccess: afterCategoryChange })}>启用</button>}<button className="link-danger" onClick={() => run({ title: `删除分类「${category.name}」？`, description: "仅当分类没有被任何题目引用时才能删除；已引用时请改为停用。", danger: true, path: API.admin.deleteQuestionCategory(category.id), method: "DELETE", body: { revision: category.revision }, success: "评估分类已删除", onSuccess: afterCategoryChange })}>删除</button></div></td></tr>)}</tbody></table></div></CollapsiblePanel>}
    <CollapsiblePanel title="问卷版本" count={rows.length}>{rows.length === 0 ? <p className="collapsible-empty">当前没有问卷版本</p> : <div className="data-table-wrap"><table className="data-table"><thead><tr><th>问卷版本</th><th>题目检查</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><strong>{row.name}</strong><small>{row.versionLabel}</small></td><td>{row.numberingValid ? `${row.enabledQuestionCount} 题完整` : "发布检查未通过"}</td><td><StatusBadge>{row.status === "published" ? "已发布" : row.status === "draft" ? "草稿" : toStatusLabel(row.status)}</StatusBadge></td><td>{formatTime(row.createdAt)}</td><td><div className="table-actions"><button onClick={() => onOpen(row)}>查看题目</button>{row.status === "published" && <button onClick={() => run({ title: "复制为新草稿？", description: "题目、分值和证据要求将完整复制，源版本保持不可修改。", path: API.admin.copyQuestionnaireVersion(row.id), body: {}, success: "新草稿已创建" })}>复制为新草稿</button>}{row.status === "draft" && <><button onClick={() => onOpen(row)}>完成检查并发布</button><button className="link-danger" onClick={() => run({ title: "删除这个问卷版本？", description: "仅草稿版本可删除，且未被任何指派引用；已发布版本请复制新草稿后废弃。", danger: true, path: API.admin.deleteQuestionnaireVersion(row.id), method: "DELETE", body: { revision: row.revision }, success: "问卷版本已删除", onSuccess: refresh })}>删除</button></>}</div></td></tr>)}</tbody></table></div>}<LoadMorePager rows={rows} hasMore={pager?.hasMore} loadingMore={pager?.loadingMore} moreError={pager?.moreError} onLoadMore={pager?.loadMore} unit="个版本" /></CollapsiblePanel></>;
}

// 问卷版本详情路由：按 URL 的 versionId 拉取版本元数据与题目列表（深链接/刷新不依赖列表内存状态），
// 选中题目（?question=）与分类筛选（?category=）由查询串驱动——切换题目是导航，脏态由题目编辑器守卫拦截。
// reload 为后台权威刷新（版本元数据 + 题目一并更新，乐观锁/发布状态保持新鲜），不进 loading 门、
// 不卸载编辑器：其他题目上未保存的本地草稿不会因结构性变更丢失。
function QuestionnaireDetailRoute({ versionId, query, run, ask, setToast }) {
  const { expire } = useAdminAuth();
  const [state, setState] = useState({ loading: true, error: "", version: null, questionRows: [], categories: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, error: "", version: null, questionRows: [], categories: null });
    Promise.all([
      request(API.admin.questionnaireVersion(versionId), { schema: z.object({ version: QuestionnaireVersionRowSchema }), signal: controller.signal }),
      request(API.admin.questions(versionId), { schema: AdminQuestionListSchema, signal: controller.signal }),
      request(API.admin.questionCategories, { schema: ADMIN_LIST_SCHEMAS.questionCategories }).catch(() => null),
    ]).then(([versionResult, questionsResult, categoriesResult]) => {
      if (controller.signal.aborted) return;
      setState({ loading: false, error: "", version: versionResult.version, questionRows: items(questionsResult), categories: categoriesResult?.items || null });
    }).catch((loadError) => {
      if (controller.signal.aborted) return;
      setState({ loading: false, error: loadError.message, version: null, questionRows: [], categories: null }); // 会话过期也呈现可重试错误态
      if (loadError.kind === "session") expire();
    });
    return () => controller.abort();
  }, [versionId, attempt, expire]);
  // 后台刷新：结构性变更（增删移动启停）与发布后统一走这里，题目与版本元数据同步保持权威。
  // 控制器被保留：versionId 变更或卸载时中止在途刷新，旧版本的迟到响应不得覆盖新 URL 的数据。
  const reloadAbortRef = useRef(null);
  useEffect(() => () => reloadAbortRef.current?.abort(), [versionId]);
  const reload = useCallback(() => {
    reloadAbortRef.current?.abort();
    const controller = new AbortController();
    reloadAbortRef.current = controller;
    Promise.all([
      request(API.admin.questionnaireVersion(versionId), { schema: z.object({ version: QuestionnaireVersionRowSchema }), signal: controller.signal }),
      request(API.admin.questions(versionId), { schema: AdminQuestionListSchema, signal: controller.signal }),
    ]).then(([versionResult, questionsResult]) => {
      if (controller.signal.aborted) return;
      setState((current) => ({ ...current, version: versionResult.version, questionRows: items(questionsResult) }));
    }).catch((loadError) => {
      if (controller.signal.aborted || loadError?.name === "AbortError") return;
      if (loadError.kind === "session") { expire(); return; }
      setToast(loadError.message, "error");
    });
  }, [versionId, expire, setToast]);
  if (state.loading) return <><button className="back-link" onClick={() => navigate(adminPaths.questionnaires())}><CaretRight size={15} /> 返回版本列表</button><StatePanel title="正在加载题目…" /></>;
  if (state.error) return <><button className="back-link" onClick={() => navigate(adminPaths.questionnaires())}><CaretRight size={15} /> 返回版本列表</button><StatePanel title={state.error} action={<button className="admin-primary" onClick={() => setAttempt((value) => value + 1)}>重新加载</button>} /></>;
  const questionFilter = query.get("category") || "";
  const selected = state.questionRows.find((row) => row.id === query.get("question")) || null;
  const goVersion = (questionId, category) => navigate(adminPaths.questionnaireDetail(versionId, { question: questionId || undefined, category: category || undefined }));
  const setQuestionRows = (updater) => setState((current) => ({ ...current, questionRows: typeof updater === "function" ? updater(current.questionRows) : updater }));
  return <QuestionnaireDetail
    version={state.version}
    questionRows={state.questionRows}
    setQuestionRows={setQuestionRows}
    categories={state.categories}
    questionFilter={questionFilter}
    selected={selected}
    onBack={() => navigate(adminPaths.questionnaires())}
    onSelectQuestion={(question) => goVersion(question.id, questionFilter)}
    onCategoryFilter={(code) => goVersion(query.get("question"), code)}
    reload={reload}
    run={run} ask={ask} setToast={setToast} />;
}

function QuestionnaireDetail({ version, questionRows, setQuestionRows, categories, questionFilter, selected, onBack, onSelectQuestion, onCategoryFilter, reload, run, ask, setToast }) {
  const checks = questionnaireChecks(questionRows);
  const canPublish = Object.values(checks).every(Boolean);
  const draftEditable = version.status === "draft";
  // 题目草稿未保存时禁止发布：发布以服务端已保存值为准，带着未保存草稿发布会静默丢弃修改
  // 并把编辑器锁进旧值；这里直接禁用发布入口并给出提示（零发布请求），保存或放弃后恢复。
  const [editorDirty, setEditorDirty] = useState(false);
  const publishBlocked = editorDirty;
  // 左侧题目列表按评估分类筛选；分类选项直接从题目行派生（含 categoryName），分类接口异常也不影响筛选。
  const filterOptions = [];
  for (const question of questionRows) {
    if (!filterOptions.some((option) => option.code === question.category)) filterOptions.push({ code: question.category, name: question.categoryName || categoryLabel(question.category) });
  }
  const visibleQuestions = questionFilter ? questionRows.filter((question) => question.category === questionFilter) : questionRows;
  const enabledCount = questionRows.filter((question) => question.enabled).length;
  // 结构性变更后：路由层后台刷新版本元数据与题目（题号/数量/乐观锁保持权威），不打断其他未保存输入。
  const reloadQuestions = () => reload();
  const askMoveQuestion = (question, direction) => run({ title: `${direction === "up" ? "上移" : "下移"}第 ${question.number} 题？`, description: "将与同分类的上/下一道题交换位置，题号自动重排。", path: API.admin.moveQuestion(version.id, question.id), body: { revision: question.revision, direction }, success: `题目已${direction === "up" ? "上移" : "下移"}`, onSuccess: reloadQuestions });
  const askToggleQuestion = (question) => run({ title: `${question.enabled ? "停用" : "启用"}第 ${question.number} 题？`, description: question.enabled ? "停用后小程序答题页不再显示该题，发布校验也不计入；题号保持不变。" : "启用后该题重新计入发布校验。", path: API.admin.question(version.id, question.id), method: "PATCH", body: { revision: question.revision, enabled: !question.enabled }, success: `题目已${question.enabled ? "停用" : "启用"}`, onSuccess: reloadQuestions });
  const askDeleteQuestion = (question) => run({ title: `删除第 ${question.number} 题？`, description: "删除后其余题目自动重排题号；已有作答记录的题目无法删除，请改为停用。", danger: true, path: API.admin.deleteQuestion(version.id, question.id), method: "DELETE", body: { revision: question.revision }, success: "题目已删除", onSuccess: reloadQuestions });
  const askAddQuestion = () => {
    const activeChoices = (categories || []).filter((category) => category.active).map((category) => ({ value: category.code, label: category.name }));
    const choices = activeChoices.length > 0 ? activeChoices : filterOptions.map((option) => ({ value: option.code, label: option.name }));
    ask({ title: "添加题目", description: "新题将插入到所选分类最后一题之后，题号自动重排。", fields: [{ name: "category", label: "题目分类", required: true, type: "select", options: choices }, { name: "text", label: "题目内容", required: true, type: "textarea", placeholder: "例如：地面是否干净无杂物" }, { name: "maxScore", label: "分值", type: "number", placeholder: "默认 2" }], initialValues: { maxScore: 2, ...(questionFilter ? { category: questionFilter } : {}) }, build: (values) => ({ category: values.category, text: values.text.trim(), maxScore: Number(values.maxScore || 2) }), path: API.admin.createQuestion(version.id), success: "题目已添加", onSuccess: reloadQuestions });
  };
  // 发布成功后立即后台刷新：版本状态/乐观锁翻转为已发布，界面即刻只读。
  const publishVersion = () => run({ title: "发布这个问卷版本？", description: "题目、题号连续性和证据配置已通过前端检查，系统将再次检查。", path: API.admin.publishQuestionnaireVersion(version.id), body: { revision: version.revision }, success: "问卷版本已发布", onSuccess: reload });
  const passedCount = Object.values(checks).filter(Boolean).length;
  const failedLabels = [["启用题数量", "questionCount"], ["题号连续", "numbersValid"], ["证据配置", "evidenceValid"], ["清零题数量", "scoreWipeValid"]].filter(([, key]) => !checks[key]).map(([label]) => label);
  const action = draftEditable ? <div className="table-actions"><button className="admin-secondary" onClick={askAddQuestion}><Plus size={16} /> 添加题目</button><button className="admin-primary" disabled={!canPublish || publishBlocked} title={publishBlocked ? "请先保存或放弃当前题目的修改" : undefined} onClick={publishVersion}>发布版本</button></div> : null;
  return <><button className="back-link" onClick={onBack}><CaretRight size={15} /> 返回版本列表</button><PageHeader eyebrow="问卷题库" title={`${version.name} · ${version.versionLabel}`} description={version.status === "published" ? "已发布版本不可修改。如需调整，请先复制为新草稿。" : "选择题目配置证据要求；可添加、删除、排序和停用题目。"} action={action} /><QuestionnaireChecks checks={checks} /><section className="questionnaire-editor"><aside><div className="questionnaire-version"><span>{toStatusLabel(version.status)}</span><strong>{version.versionLabel}</strong><small>启用 {enabledCount} / 共 {questionRows.length} 题</small></div><div className="question-filter-row">{[{ code: "", name: "全部" }, ...filterOptions].map((option) => <button key={option.code || "all"} className={questionFilter === option.code ? "is-active" : ""} onClick={() => onCategoryFilter(option.code)}>{option.name}</button>)}</div><div className="question-pick-list">{visibleQuestions.map((question) => <div key={question.id} className={`question-pick-item${selected?.id === question.id ? " is-active" : ""}${question.enabled ? "" : " is-off"}`}><button className="question-pick-main" onClick={() => onSelectQuestion(question)}><span>{question.number}</span><p>{question.text}{!question.enabled && <em className="question-off-tag">已停用</em>}</p><CaretRight size={14} /></button>{draftEditable && <div className="question-pick-actions"><button aria-label={`上移第 ${question.number} 题`} title="上移" onClick={() => askMoveQuestion(question, "up")}><CaretUp size={13} /></button><button aria-label={`下移第 ${question.number} 题`} title="下移" onClick={() => askMoveQuestion(question, "down")}><CaretDown size={13} /></button><button onClick={() => askToggleQuestion(question)}>{question.enabled ? "停用" : "启用"}</button><button className="link-danger" onClick={() => askDeleteQuestion(question)}>删除</button></div>}</div>)}{visibleQuestions.length === 0 && <p className="question-pick-empty">该分类暂无题目，可点击右上角「添加题目」。</p>}</div></aside>{selected && <QuestionEvidenceEditor key={selected.id} version={version} question={selected} onSaved={(row) => setQuestionRows((current) => current.map((item) => item.id === row.id ? row : item))} onDirtyChange={setEditorDirty} run={run} setToast={setToast} />}{draftEditable && <footer className="questionnaire-action-bar">{publishBlocked ? <span className="form-message" role="alert">当前题目有未保存的修改，保存或放弃后才能发布</span> : <span className={canPublish ? "is-passed" : "is-failed"}>检查 {passedCount}/4 通过{canPublish ? "" : `（未过：${failedLabels.join("、")}）`}</span>}<button className="admin-primary" disabled={!canPublish || publishBlocked} title={publishBlocked ? "请先保存或放弃当前题目的修改" : undefined} onClick={publishVersion}>发布版本</button></footer>}</section></>;
}
// 分类接口不可用时的兜底选项（与内置种子一致），保证编辑器始终可渲染。
const FALLBACK_QUESTION_CATEGORIES = [{ code: "environment", name: "环境卫生" }, { code: "service", name: "为客服务" }, { code: "product", name: "产品品质" }];

// 新建问卷路由：分类选项由路由屏自行加载（列表页分类面板不再承载编辑器数据源）。
function QuestionnaireEditorRoute({ onBack, run, setToast }) {
  const { expire } = useAdminAuth();
  const [categories, setCategories] = useState(null);
  useEffect(() => {
    let active = true;
    request(API.admin.questionCategories, { schema: ADMIN_LIST_SCHEMAS.questionCategories })
      .then((result) => { if (active) setCategories(result.items); })
      .catch((loadError) => {
        if (!active) return;
        // 会话失效：切登录遮罩（保留当前 URL，登录后回到新建问卷），其余失败按分类面板降级。
        setCategories(null);
        if (loadError.kind === "session") expire();
      });
    return () => { active = false; };
  }, [expire]);
  return <QuestionnaireEditor onBack={onBack} run={run} setToast={setToast} categories={categories || []} />;
}

function QuestionnaireEditor({ onBack, run, setToast, categories }) {
  const activeCategories = categories && categories.length > 0 ? categories.filter((category) => category.active) : FALLBACK_QUESTION_CATEGORIES;
  const defaultCategory = activeCategories[0]?.code || "environment";
  const [name, setName] = useState("");
  const [questions, setQuestions] = useState(Array.from({ length: 3 }, (_, index) => ({ number: index + 1, category: defaultCategory, text: "", maxScore: 2, scoreWipe: false, imageRequired: false, imageMaxCount: 3, audioRequired: false, audioMaxDurationSeconds: 10 })));
  // 未保存修改守卫：与挂载时快照比较（名称/题目改动后改回原值即不脏）；保存成功后基准推进。
  const draftRef = useRef({ name, questions });
  draftRef.current = { name, questions };
  const draftBaselineRef = useRef({ name, questions });
  useNavigationGuard(useCallback(() => JSON.stringify(draftRef.current) !== JSON.stringify(draftBaselineRef.current), []));
  const patchQuestion = (number, field, value) => setQuestions((current) => current.map((question) => question.number === number ? { ...question, [field]: value } : question));
  const addQuestion = () => setQuestions((current) => [...current, { number: current.length + 1, category: defaultCategory, text: "", maxScore: 2, scoreWipe: false, imageRequired: false, imageMaxCount: 3, audioRequired: false, audioMaxDurationSeconds: 10 }]);
  const removeQuestion = (number) => setQuestions((current) => current.length <= 1 ? current : current.filter((question) => question.number !== number).map((question, index) => ({ ...question, number: index + 1 })));
  // 行 DOM 按原始 question.number 全量渲染，rowRefs 以原始行号为 key，供「创建并发布」失败时滚动定位。
  const rowRefs = useRef({});
  const filledRows = questions.filter((question) => question.text.trim());
  const wipeConflicts = new Set(Object.entries(filledRows.reduce((counts, question) => { if (question.scoreWipe) counts[question.category] = (counts[question.category] || 0) + 1; return counts; }, {})).filter(([, count]) => count >= 2).map(([category]) => category));
  // 行内红字与「创建并发布」的失败定位共用同一判定，保证提示文案与滚动目标一致。
  const rowCheckError = (question, conflicts) => {
    const requiresEvidence = question.imageRequired || question.audioRequired;
    if (requiresEvidence && !question.imageRequired && !question.audioRequired) return "要求上传证据时需勾选照片或录音";
    if (question.scoreWipe && conflicts.has(question.category)) return "该分类已有多道分数清零题，每分类至多一道";
    return "";
  };
  // 保存与创建并发布共用的前置校验：通过返回 { filled, parsed }，失败 toast 并返回 null。
  const validateDraft = () => {
    const filled = questions.filter((question) => question.text.trim());
    if (!name.trim()) { setToast("请填写问卷名称", "error"); return null; }
    if (filled.length === 0) { setToast("请至少填写一道题目", "error"); return null; }
    const parsed = QuestionnaireVersionCreateSchema.safeParse({ name: name.trim(), questions: filled.map((question) => {
      const base = { number: question.number, category: question.category, text: question.text.trim(), maxScore: question.maxScore, scoreWipe: Boolean(question.scoreWipe) };
      const requiresEvidence = question.imageRequired || question.audioRequired;
      return requiresEvidence ? { ...base, evidence: { evidenceRequired: true, imageRequired: question.imageRequired, audioRequired: question.audioRequired, imageMaxCount: question.imageMaxCount, audioMaxDurationSeconds: question.audioMaxDurationSeconds } } : base;
    }) });
    if (!parsed.success) { setToast(parsed.error.issues.map((issue) => issue.message).join("；"), "error"); return null; }
    return { filled, parsed };
  };
  const save = () => {
    const draft = validateDraft();
    if (!draft) return;
    run({ title: "创建这个问卷版本？", description: `将创建草稿版本（${draft.filled.length} 道题），可继续编辑题目或配置证据后发布。`, execute: async () => { await request(API.admin.createQuestionnaireVersion, { method: "POST", body: draft.parsed.data }); draftBaselineRef.current = { ...draftRef.current }; }, success: "问卷草稿已创建", onSuccess: onBack });
  };
  const saveAndPublish = () => {
    const draft = validateDraft();
    if (!draft) return;
    const rows = draft.filled.map((q, index) => ({ ...q, number: index + 1, enabled: true, scoreWipe: Boolean(q.scoreWipe), evidence: (q.imageRequired || q.audioRequired) ? { evidenceRequired: true, imageRequired: q.imageRequired, audioRequired: q.audioRequired } : undefined }));
    const checks = questionnaireChecks(rows);
    if (!Object.values(checks).every(Boolean)) {
      const badRow = draft.filled[rows.findIndex((row) => rowCheckError(row, wipeConflicts))];
      if (badRow) { rowRefs.current[badRow.number]?.scrollIntoView({ behavior: "smooth", block: "center" }); setToast(`发布检查未通过：第 ${badRow.number} 题，${rowCheckError(badRow, wipeConflicts)}`, "error"); }
      return;
    }
    run({ title: "创建并发布这个问卷版本？", description: `将创建并发布 V1，共 ${draft.filled.length} 道题。若发布失败，草稿会保留，可回列表继续处理。`, execute: async () => { const created = await request(API.admin.createQuestionnaireVersion, { method: "POST", body: draft.parsed.data }); await request(API.admin.publishQuestionnaireVersion(created.version.id), { method: "POST", body: { revision: created.version.revision } }); draftBaselineRef.current = { ...draftRef.current }; }, success: "问卷已发布", onSuccess: onBack });
  };
  return <><button className="back-link" onClick={onBack}><CaretRight size={15} /> 返回版本列表</button><PageHeader eyebrow="问卷题库" title="新建问卷" description="填写问卷名称和题目（题号自动 1–N，数量不限）。" /><section className="panel"><div className="field-grid"><label className="admin-field"><span>问卷名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：暗访问卷 2026 夏季版" /></label></div><div className="questionnaire-editor"><aside><div className="questionnaire-version"><span>草稿</span><strong>新建版本</strong><small>{questions.filter((question) => question.text.trim()).length} / {questions.length} 道已填写</small></div></aside><div className="questionnaire-write-main"><div className="question-write-list">{questions.map((question) => <div key={question.number} className="question-write-row" ref={(el) => { rowRefs.current[question.number] = el; }}><span className="question-write-number">{question.number}</span><select value={question.category} onChange={(event) => patchQuestion(question.number, "category", event.target.value)}>{activeCategories.map((category) => <option key={category.code} value={category.code}>{category.name}</option>)}</select><input value={question.text} onChange={(event) => patchQuestion(question.number, "text", event.target.value)} placeholder={`第 ${question.number} 题内容`} /><input className="question-write-score" type="number" min="0" max="10" value={question.maxScore} onChange={(event) => patchQuestion(question.number, "maxScore", Number(event.target.value))} /><label className="qw-evidence"><input type="checkbox" checked={question.imageRequired} onChange={(event) => patchQuestion(question.number, "imageRequired", event.target.checked)} />照片</label>{question.imageRequired && <input className="question-write-score" type="number" min="1" max="9" title="照片最多张数" value={question.imageMaxCount} onChange={(event) => patchQuestion(question.number, "imageMaxCount", Number(event.target.value))} />}<label className="qw-evidence"><input type="checkbox" checked={question.audioRequired} onChange={(event) => patchQuestion(question.number, "audioRequired", event.target.checked)} />录音</label>{question.audioRequired && <input className="question-write-score" type="number" min="1" max="60" title="录音最长秒数" value={question.audioMaxDurationSeconds} onChange={(event) => patchQuestion(question.number, "audioMaxDurationSeconds", Number(event.target.value))} />}<label className="qw-evidence"><input type="checkbox" checked={question.scoreWipe} onChange={(event) => patchQuestion(question.number, "scoreWipe", event.target.checked)} />分数清零题</label>{question.text.trim() && rowCheckError(question, wipeConflicts) && <em className="qw-error">{rowCheckError(question, wipeConflicts)}</em>}<button className="qw-remove" disabled={questions.length <= 1} onClick={() => removeQuestion(question.number)} aria-label={`删除第 ${question.number} 题`}>−</button></div>)}</div><div className="question-write-toolbar"><button className="admin-secondary" onClick={addQuestion}><Plus size={15} /> 添加题目（{questions.length} 道）</button></div></div></div><div className="editor-footer"><button className="admin-secondary" onClick={save}>保存草稿</button><button className="admin-primary" onClick={saveAndPublish}>创建并发布</button></div></section></>;
}

function questionnaireChecks(questions) {
  // 发布只看启用题：启用题须至少 1 道且题号 1..M 连续（停用题编号排在启用题之后，不参与校验）。
  const enabledQuestions = questions.filter((question) => question.enabled);
  const questionCount = enabledQuestions.length >= 1;
  const numbersValid = enabledQuestions.every((question, index) => question.number === index + 1);
  const evidenceValid = enabledQuestions.every((question) => !question.evidence?.evidenceRequired || question.evidence.imageRequired || question.evidence.audioRequired);
  const scoreWipeValid = enabledQuestions.every((question) => !question.scoreWipe || enabledQuestions.filter((other) => other.category === question.category && other.scoreWipe).length === 1);
  return { questionCount, numbersValid, evidenceValid, scoreWipeValid };
}

function QuestionnaireChecks({ checks }) {
  const rows = [["启用题数量", checks.questionCount, "至少 1 道启用题，数量不限"], ["题号连续", checks.numbersValid, "启用题号必须从 1 连续编号"], ["证据配置", checks.evidenceValid, "开启证据时至少需要图片或录音"], ["清零题数量", checks.scoreWipeValid, "每个分类至多一道分数清零题"]];
  return <section className="questionnaire-checks">{rows.map(([label, passed, description]) => <div key={label} className={passed ? "is-passed" : "is-failed"}><CheckCircle size={20} weight="fill" /><span><strong>{label}：{passed ? "通过" : "未通过"}</strong><small>{description}</small></span></div>)}</section>;
}

function QuestionEvidenceEditor({ version, question, onSaved, onDirtyChange, run, setToast }) {
  const defaultEvidence = { evidenceRequired: false, imageRequired: false, audioRequired: false, imageMaxCount: 3, audioMaxDurationSeconds: 10 };
  const evidenceOf = (row) => row.evidence || defaultEvidence;
  // 本地草稿模型：题目文本/分值/清零标记/证据配置的全部编辑都留在草稿里，不即时写回共享题目行；
  // 保存成功后才把服务端返回的权威行（含新 revision）提交给父级，脏态基准同步推进到权威快照。
  // 确认丢弃/换题后重进本编辑器（key=question.id 重挂），看到的是服务端已保存值。
  const snapshotOf = (row) => ({ text: row.text, maxScore: Number(row.maxScore), scoreWipe: Boolean(row.scoreWipe), evidence: { ...evidenceOf(row) } });
  const [draft, setDraft] = useState(() => snapshotOf(question));
  const initialRef = useRef(snapshotOf(question));
  const dirty = draft.text !== initialRef.current.text || Number(draft.maxScore) !== Number(initialRef.current.maxScore)
    || Boolean(draft.scoreWipe) !== Boolean(initialRef.current.scoreWipe)
    || JSON.stringify(draft.evidence) !== JSON.stringify(initialRef.current.evidence);
  useNavigationGuard(useCallback(() => dirty, [dirty]));
  // 脏态上报父级：发布入口在草稿未保存时禁用（避免带着旧服务端值静默发布/锁定编辑器）。
  // 卸载（放弃草稿/取消选中/切换版本）时必须回报 false：父级不残留上一题的脏态——
  // 否则确认丢弃后没有编辑器可「保存或放弃」，发布入口会被永久禁用。
  // StrictMode 双调用安全：mount→cleanup(false)→mount(dirty) 收敛回真实值。
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const patchDraft = (part) => setDraft((current) => ({ ...current, ...part }));
  const patchEvidence = (evidencePatch) => setDraft((current) => ({ ...current, evidence: { ...current.evidence, ...evidencePatch } }));
  const { text, maxScore, scoreWipe, evidence } = draft;
  const disabled = version.status === "published";
  const invalid = evidence.evidenceRequired && !evidence.imageRequired && !evidence.audioRequired;
  const save = () => {
    if (!text.trim()) { setToast("题目内容不能为空", "error"); return; }
    let savedRow = null;
    run({ title: "保存题目设置？", description: "系统将检查题目内容、分值和证据要求。", execute: async () => {
      const result = await request(API.admin.question(version.id, question.id), { method: "PATCH", schema: z.object({ question: AdminQuestionRowSchema }), body: { revision: question.revision, text: text.trim(), maxScore: Number(maxScore), scoreWipe: Boolean(scoreWipe), evidence } });
      savedRow = result.question;
      // 以权威行同时推进「基线」与「本地草稿」（服务端会做规范化，如去首尾空格）：
      // 输入框立即回显保存后的值，脏态干净解除，不会因本地残留旧格式而误报未保存。
      initialRef.current = snapshotOf(savedRow);
      setDraft(snapshotOf(savedRow));
    }, success: "题目配置已保存", onSuccess: () => { if (savedRow) onSaved(savedRow); } });
  };
  return <div className="question-editor-panel"><div className="editor-heading"><div><span>{question.categoryName || categoryLabel(question.category)} · 第 {question.number} 题</span><h2>题目设置</h2></div><StatusBadge>{disabled ? "已发布" : "草稿可编辑"}</StatusBadge></div><label className="admin-field"><span>题目内容</span><textarea value={text} readOnly={disabled} rows="4" onChange={(event) => patchDraft({ text: event.target.value })} /></label><label className="admin-field"><span>分值</span><input type="number" min="0" max="10" disabled={disabled} value={maxScore} onChange={(event) => patchDraft({ maxScore: Number(event.target.value) })} /></label><label className="toggle-row"><span><strong>分数清零题</strong><small>勾选后，探员对该题选“是”时，该分类全部题目按 0 分计</small></span><input type="checkbox" disabled={disabled} checked={Boolean(scoreWipe)} onChange={(event) => patchDraft({ scoreWipe: event.target.checked })} /><i /></label><section className="evidence-settings"><div><h3>不得分证据要求</h3><small className="muted">现行探员端策略：问题照片对所有题目开放且为选填、每次最多 4 张（此处历史“需要图片”配置不再作为强制要求，已保存的旧照片全部保留）；录音要求仍按下方配置执行。</small></div><label className="toggle-row"><span><strong>不得分时要求上传证据</strong></span><input type="checkbox" disabled={disabled} checked={evidence.evidenceRequired} onChange={(event) => patchEvidence({ evidenceRequired: event.target.checked, imageRequired: event.target.checked ? evidence.imageRequired : false, audioRequired: event.target.checked ? evidence.audioRequired : false })} /><i /></label>{evidence.evidenceRequired && <div className="evidence-checks"><label><input type="checkbox" disabled={disabled} checked={evidence.imageRequired} onChange={(event) => patchEvidence({ imageRequired: event.target.checked })} /><span><strong>需要图片</strong></span></label><label><input type="checkbox" disabled={disabled} checked={evidence.audioRequired} onChange={(event) => patchEvidence({ audioRequired: event.target.checked })} /><span><strong>需要音频</strong></span></label></div>}{evidence.imageRequired && <label className="admin-field"><span>照片最多（张）</span><input type="number" min="1" max="9" disabled={disabled} value={evidence.imageMaxCount} onChange={(event) => patchEvidence({ imageMaxCount: Number(event.target.value) })} /></label>}{evidence.audioRequired && <label className="admin-field"><span>录音最长（秒）</span><input type="number" min="1" max="60" disabled={disabled} value={evidence.audioMaxDurationSeconds} onChange={(event) => patchEvidence({ audioMaxDurationSeconds: Number(event.target.value) })} /></label>}{invalid && <p className="form-message">请至少选择一种证据类型</p>}</section>{!disabled && <div className="editor-footer"><button className="admin-primary" disabled={invalid} onClick={save}>保存题目设置</button></div>}</div>;
}

function Submissions({ appliedQuery, onApply, onOpen, run, setToast }) {
  const { expire } = useAdminAuth();
  // 提交详情改由路由承载（/admin/submissions/:id）。「已应用筛选」以列表 URL 查询串为准
  // （白名单键）：进入详情再返回（站内/浏览器返回）筛选与结果保持，刷新/书签同样恢复；
  // 草稿输入初值取自已应用筛选，请求契约（键名与取值）不变。
  const emptyFilters = { brandId: "", storeName: "", regionName: "", campaignName: "", businessNo: "", inspectorName: "", status: "", submittedFrom: "", submittedTo: "", minScoreRate: "", maxIssueCount: "" };
  const applied = useMemo(() => {
    const next = { ...emptyFilters };
    for (const key of Object.keys(emptyFilters)) {
      const value = appliedQuery.get(key);
      if (value) next[key] = value;
    }
    return next;
  }, [appliedQuery]);
  const [filters, setFilters] = useState(applied); // 草稿输入：进页时以已应用筛选为初值
  const [showAdvanced, setShowAdvanced] = useState(() => Boolean(applied.campaignName || applied.businessNo || applied.minScoreRate || applied.maxIssueCount));
  // 列表查询走 usePagedRemote：首屏与「应用筛选」都会换 path → 游标重置从第一页取 100 条；
  // order=desc 按实际提交时间倒序（最新在前，服务端以 submitted_at 全局排序）；「共 X 条」使用后端 total。
  const submissionsPath = useMemo(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), order: "desc" });
    for (const [key, value] of Object.entries(applied)) if (value !== "") params.set(key, value);
    return `${API.admin.submissions}?${params}`;
  }, [applied]);
  const listPage = usePagedRemote({ path: submissionsPath, schema: PAGED_LIST_SCHEMAS.submissions, expire });
  const rows = listPage.rows;
  // 筛选选项来源：区域从 regions 全量端点取（区县级 level=3），探店员从 users?kind=inspector 游标累积（带加载更多）；
  // 门店/任务选项维持首屏 100 条。
  const [options, setOptions] = useState({ brands: [], stores: [], regions: [], campaigns: [] });
  const [optionsError, setOptionsError] = useState("");
  const inspectorsPage = usePagedRemote({ path: `${API.admin.users}?kind=inspector&limit=${PAGE_SIZE}&order=desc`, schema: PAGED_LIST_SCHEMAS.inspectorOptions, expire });
  const inspectorOptions = inspectorsPage.rows.map((user) => user.displayName);
  useEffect(() => {
    let active = true;
    Promise.allSettled([
      request(`${API.admin.stores}?limit=${PAGE_SIZE}`, { schema: ADMIN_LIST_SCHEMAS.stores }),
      request(`${API.admin.campaigns}?limit=${PAGE_SIZE}&order=desc`, { schema: ADMIN_LIST_SCHEMAS.campaigns }),
      request(`${API.admin.brands}?limit=${PAGE_SIZE}`, { schema: listSchema(BrandRowSchema) }),
      request(API.admin.regions, { schema: listSchema(RegionRowSchema) }),
    ]).then(([storesResult, campaignsResult, brandsResult, regionsResult]) => {
      if (!active) return;
      const namesOf = (result, pick) => (result.status === "fulfilled" ? result.value.items.map(pick).filter(Boolean) : []);
      setOptions({
        brands: brandsResult.status === "fulfilled" ? brandsResult.value.items.map((brand) => ({ id: brand.id, name: brand.name })) : [],
        stores: namesOf(storesResult, (item) => item.name),
        regions: regionsResult.status === "fulfilled" ? regionsResult.value.items.filter((region) => region.level === 3).map((region) => region.name) : [],
        campaigns: namesOf(campaignsResult, (item) => item.name),
      });
      if ([storesResult, campaignsResult, brandsResult, regionsResult].some((result) => result.status === "rejected")) setOptionsError("部分筛选选项加载失败，请刷新后重试");
    });
    return () => { active = false; };
  }, []);
  const patchFilter = (field, value) => setFilters((current) => ({ ...current, [field]: value }));
  // 导出请求体的 filters 为 strict 白名单（campaignId/storeId/inspectorId/时间/至多不得分数 maxIssueCount），
  // 门店、区域、任务名等文本类筛选无法下发给导出，这里只映射导出支持的键且仅在有值时携带。
  const exportFiltersOf = (source) => {
    const mapped = {};
    if (source.submittedFrom) mapped.submittedAfter = new Date(source.submittedFrom).toISOString();
    if (source.submittedTo) mapped.submittedBefore = new Date(source.submittedTo).toISOString();
    if (source.maxIssueCount !== "") mapped.maxIssueCount = Number(source.maxIssueCount);
    return mapped;
  };
  // 文本类筛选（含状态、品牌）不进导出请求，导出前需要向用户说明
  const hasTextFilter = Boolean(filters.brandId || filters.storeName || filters.regionName || filters.campaignName || filters.businessNo || filters.inspectorName || filters.status);
  // 应用筛选/重置都写入列表 URL：path 变化让 usePagedRemote 自动重置游标重查第一页。
  const query = (nextFilters = filters) => onApply(nextFilters);
  const reset = () => { setFilters(emptyFilters); onApply(emptyFilters); };
  const hasFilter = Object.values(filters).some((value) => value !== "");
  const exportResult = () => run({ title: "导出当前结果？", description: hasTextFilter ? "导出仅支持时间范围和不得分数筛选；门店、区域、探店员等文本类筛选将被忽略。" : "将按当前筛选条件生成 Excel 文件，下载链接有时效。", path: API.admin.exports, body: { filters: exportFiltersOf(filters) }, success: "筛选结果导出已创建" });
  return <div className="submissions-page"><PageHeader eyebrow="运营管理" title="提交记录" description="查看探店员提交的完整问卷、现场证据、菜品记录和评分结果。" /><section className="panel submission-filters"><div className="filter-card-heading"><h2>筛选条件</h2></div><div className="filter-grid"><label className="admin-field"><span>品牌</span><select aria-label="品牌筛选" value={filters.brandId} disabled={options.brands.length === 0} onChange={(event) => patchFilter("brandId", event.target.value)}><option value="">全部品牌</option>{options.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></label><label className="admin-field"><span>门店</span><select aria-label="门店筛选" value={filters.storeName} disabled={options.stores.length === 0} onChange={(event) => patchFilter("storeName", event.target.value)}><option value="">全部门店</option>{options.stores.map((name, index) => <option key={`${name}-${index}`} value={name}>{name}</option>)}</select></label><label className="admin-field"><span>区域</span><select aria-label="区域筛选" value={filters.regionName} disabled={options.regions.length === 0} onChange={(event) => patchFilter("regionName", event.target.value)}><option value="">全部区域</option>{options.regions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label className="admin-field"><span>探店员</span><select aria-label="探店员筛选" value={filters.inspectorName} disabled={inspectorOptions.length === 0} onChange={(event) => patchFilter("inspectorName", event.target.value)}><option value="">全部探店员</option>{inspectorOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label className="admin-field"><span>问卷状态</span><select aria-label="问卷状态筛选" value={filters.status} onChange={(event) => patchFilter("status", event.target.value)}><option value="">全部状态</option><option value="submitted">已提交</option></select></label></div><div className="filter-grid"><div className="admin-field filter-range"><span>提交时间</span><span className="time-range"><input type="datetime-local" aria-label="提交开始时间" value={filters.submittedFrom} onChange={(event) => patchFilter("submittedFrom", event.target.value)} /> 至 <input type="datetime-local" aria-label="提交截止时间" value={filters.submittedTo} onChange={(event) => patchFilter("submittedTo", event.target.value)} /></span></div></div>{showAdvanced && <div className="filter-grid"><label className="admin-field"><span>任务</span><select aria-label="任务筛选" value={filters.campaignName} disabled={options.campaigns.length === 0} onChange={(event) => patchFilter("campaignName", event.target.value)}><option value="">全部任务</option>{options.campaigns.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label className="admin-field"><span>任务编号</span><input value={filters.businessNo} onChange={(event) => patchFilter("businessNo", event.target.value)} /></label><label className="admin-field"><span>最低得分率</span><input type="number" min="0" max="100" value={filters.minScoreRate} onChange={(event) => patchFilter("minScoreRate", event.target.value)} /></label><label className="admin-field"><span>最多不得分数</span><input type="number" min="0" value={filters.maxIssueCount} onChange={(event) => patchFilter("maxIssueCount", event.target.value)} /></label></div>}<div className="filter-actions"><button className="admin-secondary filter-toggle" onClick={() => setShowAdvanced((value) => !value)}>{showAdvanced ? <>收起高级筛选<CaretUp size={14} /></> : <>更多筛选<CaretDown size={14} /></>}</button><span className="filter-action-group"><button className="admin-secondary" onClick={reset} disabled={listPage.loading}>重置</button><button className="admin-primary" onClick={() => query()} disabled={listPage.loading}>{listPage.loading ? "正在查询…" : "应用筛选"}</button></span></div>{(listPage.error || optionsError) && <p className="form-message" role="alert">{listPage.error || optionsError}</p>}{inspectorsPage.hasMore && <div className="pager"><span>已加载 {inspectorOptions.length} 位探店员</span><button className="admin-secondary" onClick={inspectorsPage.loadMore} disabled={inspectorsPage.loadingMore}>{inspectorsPage.loadingMore ? "正在加载…" : "加载更多探店员"}</button></div>}</section><div className="results-header"><div><h2>提交结果</h2><span className="result-count">共 {listPage.data?.total ?? rows.length} 条</span>{hasTextFilter && hasFilter && <span className="result-hint">导出将忽略文本类筛选</span>}</div><button className="admin-secondary" onClick={exportResult}><DownloadSimple size={16} /> {hasFilter ? "导出当前结果" : "导出结果"}</button></div>{rows.length === 0 ? <section className="panel submission-empty"><WarningCircle size={30} weight="duotone" /><strong>{hasFilter ? "暂无匹配结果" : "暂无提交记录"}</strong><p>{hasFilter ? "尝试调整或清除当前筛选条件。" : "探店员完成并提交问卷后，记录将显示在这里。"}</p>{hasFilter && <button className="admin-secondary" onClick={reset}>清除筛选</button>}</section> : <section className="panel"><div className="data-table-wrap"><table className="data-table"><thead><tr><th>提交记录</th><th>门店/区域</th><th>探店员</th><th>提交时间</th><th>得分率</th><th>不得分</th><th>操作</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="row-link" onClick={() => onOpen(row)}><td><strong>{row.taskName}</strong><small>{row.businessNo}</small></td><td>{row.storeName}<small>{row.regionName}</small></td><td>{row.inspectorName}</td><td>{formatTime(row.submittedAt)}</td><td>{row.scoreRate}</td><td>{row.issueCount}</td><td onClick={(event) => event.stopPropagation()}><button onClick={() => onOpen(row)}>查看详情</button></td></tr>)}</tbody></table></div><LoadMorePager rows={rows} hasMore={listPage.hasMore} loadingMore={listPage.loadingMore} moreError={listPage.moreError} onLoadMore={listPage.loadMore} unit="条记录" /></section>}</div>;
}

function SubmissionDetail({ detail, submissionId, reload, setToast }) {
  const questions = detail.questions || [];
  // 结构化闪光点（新提交带照片预览）；历史提交无结构化条目时按旧单条 highlight 兜底为一条。
  const highlightEntries = detail.highlights?.length
    ? detail.highlights
    : (detail.highlight ? [{ id: "legacy-highlight", text: detail.highlight, photos: [] }] : []);
  const [restorePending, setRestorePending] = useState(false);
  const archivedReceipts = (detail.receiptComparison?.receipts || []).filter((receipt) => receipt.previewStatus !== "ready");
  const restoreReceipt = async (receiptId) => {
    setRestorePending(true);
    try {
      const job = await request(API.admin.restoreAttachment(submissionId, receiptId), { method: "POST", schema: ArchiveRestoreStatusSchema });
      setToast(job.status === "ready" ? "小票原图已就绪" : "已请求恢复，归档恢复中");
      await reload?.();
    } catch (error) { setToast(error.message, "error"); }
    finally { setRestorePending(false); }
  };
  return <><section className="campaign-summary"><div><span>问卷</span><strong>{detail.questionnaireName}</strong></div><div><span>总分</span><strong>{detail.totalScore}</strong></div><div><span>得分率</span><strong>{detail.scoreRate}</strong></div><div><span>不得分</span><strong>{detail.issueCount} 题</strong></div></section>{detail.categoryScores?.length > 0 && <section className="category-score-grid">{detail.categoryScores.map((item) => <div key={item.category}><span>{item.categoryName || categoryLabel(item.category)}</span><strong>{item.scoreRate}</strong></div>)}</section>}{archivedReceipts.length > 0 && <section className="panel"><div className="panel-heading"><div><h2>小票原图归档</h2></div></div>{archivedReceipts.map((receipt) => <div key={receipt.id} className="table-actions"><span>第 {(detail.receiptComparison?.receipts || []).indexOf(receipt) + 1} 张小票</span>{receipt.previewStatus === "restoring" ? <span className="muted">归档恢复中，完成后刷新可查看</span> : <><span className="muted">原图在归档冷存储</span><button className="admin-secondary" disabled={restorePending} onClick={() => restoreReceipt(receipt.id)}>{restorePending ? "正在请求恢复…" : "恢复原图"}</button></>}</div>)}</section>}<ReceiptComparison comparison={detail.receiptComparison} /><section className="panel"><div className="panel-heading"><div><h2>完整题目</h2></div></div><div className="submission-question-list">{questions.map((question) => <article key={question.id}><span>第 {question.number} 题</span><strong>{question.text}</strong><p>{question.answer === "scored" ? "得分" : "不得分"}{question.issueRemark ? ` · ${question.issueRemark}` : ""}</p><div className="evidence-preview-list">{question.attachments?.map((attachment) => attachment.type === "image" ? <a key={attachment.id} href={attachment.previewUrl} target="_blank" rel="noreferrer"><img src={attachment.previewUrl} alt={`第 ${question.number} 题证据`} /></a> : <div key={attachment.id}><audio controls preload="none" src={attachment.previewUrl} /><small>{attachment.durationSeconds ? `${attachment.durationSeconds} 秒` : "音频证据"}</small></div>)}{question.previewUrls?.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">查看证据</a>)}</div></article>)}</div></section><section className="panel"><div className="panel-heading"><div><h2>菜品记录</h2></div></div>{detail.dishes?.length ? <div className="dish-result-list">{detail.dishes.map((dish) => <article key={dish.id}><strong>{dish.actualName || dish.plannedName || "未命名菜品"}</strong><span>{dishStatusLabel(dish.fulfillmentStatus)} · {dish.quantity} 份</span><p>{dish.fullySatisfied ? "已满意" : dish.evaluation || "未填写评价"}</p></article>)}</div> : <p>本次提交没有菜品记录</p>}</section><section className="panel"><div className="panel-heading"><div><h2>其他记录</h2></div></div>{highlightEntries.length === 0 ? <p className="muted">本次提交未填写闪光点</p> : <div className="highlight-result-list">{highlightEntries.map((entry, index) => <article key={entry.id}><strong>闪光点 {index + 1}</strong><p>{entry.text || "（未填写文字）"}</p>{entry.photos?.length > 0 && <div className="evidence-preview-list">{entry.photos.map((photo) => photo.previewUrl ? <a key={photo.id} href={photo.previewUrl} target="_blank" rel="noreferrer"><img src={photo.previewUrl} alt={`闪光点 ${index + 1} 照片`} /></a> : <span key={photo.id} className="muted">照片暂不可预览</span>)}</div>}</article>)}</div>}<p><strong>其他建议：</strong>{detail.suggestion || "未填写"}</p></section>{detail.auditLogs?.length > 0 && <section className="panel"><div className="panel-heading"><div><h2>提交审计记录</h2></div></div><div className="audit-timeline">{detail.auditLogs.map((log) => <div key={log.id}><span>{formatTime(log.createdAt)}</span><strong>{log.actionLabel}</strong><small>{log.actorName}</small></div>)}</div></section>}</>;
}

function Exports({ data, run, pager }) {
  const rows = items(data);
  // 重新导出：按原任务的类型与筛选条件再建一个新任务
  const reexport = (row) => run({ title: "重新导出？", description: "将按这份记录当时的导出内容和筛选条件，重新生成一个可下载的新任务。", path: API.admin.reexportExport(row.id), success: "重新导出任务已创建" });
  return <><PageHeader eyebrow="数据导出" title="导出中心" description="展示历史导出任务与结果；新的导出在「数据看板」页（当前筛选）或「提交记录」页（单份/汇总）发起。" />
    <div className="results-header"><div><h2>导出记录</h2><span className="result-count">{pager?.hasMore ? `已加载 ${rows.length}+ 条` : `共 ${rows.length} 条`}</span></div></div>
    <DataPanel empty="还没有导出记录——在「数据看板」页点击「导出 Excel」，或在「提交记录」页导出当前结果"><table className="data-table"><thead><tr><th>文件</th><th>类型</th><th>创建人</th><th>创建时间</th><th>状态</th><th>操作</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><strong>{row.fileName}</strong></td><td>{exportKindLabel(row.kind)}</td><td>{row.createdByName}</td><td>{formatTime(row.createdAt)}</td><td><StatusBadge>{toStatusLabel(row.status)}</StatusBadge></td><td><div className="table-actions">{row.downloadUrl ? <a href={row.downloadUrl}>下载</a> : <span className="muted">{row.status === "failed" ? exportFailureHint(row.failureCode) : row.status === "expired" ? "—" : "生成中"}</span>}<button onClick={() => reexport(row)}>重新导出</button></div></td></tr>)}</tbody></table></DataPanel>
    <LoadMorePager rows={rows} hasMore={pager?.hasMore} loadingMore={pager?.loadingMore} moreError={pager?.moreError} onLoadMore={pager?.loadMore} unit="条记录" /></>;
}

// 审计动作类别分组（与服务端 AUDIT_GROUPS 一一对应）；时间范围映射到接口的 days 参数。
const AUDIT_GROUP_OPTIONS = [
  { value: "", label: "全部类别" },
  { value: "account", label: "账号与权限" },
  { value: "campaigns", label: "探店任务" },
  { value: "execution", label: "探店执行（探员端）" },
  { value: "questionnaire", label: "问卷题库" },
  { value: "stores", label: "门店与品牌" },
  { value: "exports", label: "导出与归档" },
];
const AUDIT_RANGE_OPTIONS = [{ value: 7, label: "近 7 天" }, { value: 30, label: "近 30 天" }, { value: 90, label: "近 90 天" }, { value: 365, label: "近一年" }];
const AUDIT_PAGE_SIZE = 50;

function Audits() {
  // 自带筛选与游标分页：筛选条件「应用」后生效，加载更多沿用当前条件拼接 cursor。
  const [filters, setFilters] = useState({ days: 30, group: "", actor: "" });
  const [applied, setApplied] = useState({ days: 30, group: "", actor: "" });
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const fetchPage = useCallback(async (query, mode, pageCursor) => {
    const params = new URLSearchParams({ days: String(query.days), limit: String(AUDIT_PAGE_SIZE) });
    if (query.group) params.set("group", query.group);
    if (query.actor.trim()) params.set("actor", query.actor.trim());
    if (pageCursor) params.set("cursor", pageCursor);
    const result = await request(`${API.admin.audits}?${params}`, { schema: ADMIN_LIST_SCHEMAS.audits });
    setRows((current) => mode === "more" ? [...current, ...result.items] : result.items);
    setCursor(result.items.length ? result.items.at(-1).id : null);
    setHasMore(Boolean(result.nextCursor));
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    fetchPage(applied, "replace").catch((loadError) => { if (active) setError(loadError.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [applied, fetchPage]);

  const loadMore = async () => {
    setLoadingMore(true);
    try { await fetchPage(applied, "more", cursor); } catch (loadError) { setError(loadError.message); }
    finally { setLoadingMore(false); }
  };
  const patch = (field, value) => setFilters((current) => ({ ...current, [field]: value }));
  const apply = () => setApplied({ ...filters, actor: filters.actor.trim() });
  const reset = () => { const fresh = { days: 30, group: "", actor: "" }; setFilters(fresh); setApplied(fresh); };

  return <><PageHeader eyebrow="安全与审计" title="操作审计" description="展示管理后台与探店员小程序的业务动作与结果；可按时间范围、动作类别和操作人筛选。" />
    <section className="panel audit-filters">
      <div className="filter-grid">
        <label className="admin-field"><span>时间范围</span><select aria-label="审计时间范围" value={filters.days} onChange={(event) => patch("days", Number(event.target.value))}>{AUDIT_RANGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="admin-field"><span>动作类别</span><select aria-label="审计动作类别" value={filters.group} onChange={(event) => patch("group", event.target.value)}>{AUDIT_GROUP_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="admin-field"><span>操作人</span><input aria-label="审计操作人筛选" value={filters.actor} placeholder="姓名或账号，支持模糊匹配" onChange={(event) => patch("actor", event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") apply(); }} /></label>
      </div>
      <div className="filter-actions">
        <button className="admin-secondary" onClick={reset} disabled={loading}>重置</button>
        <button className="admin-primary" onClick={apply} disabled={loading}>{loading ? "正在查询…" : "应用筛选"}</button>
      </div>
    </section>
    {error && <p className="form-message" role="alert">{error}</p>}
    {loading ? <StatePanel title="正在加载审计记录…" /> : rows.length === 0 ? <StatePanel title="当前筛选条件下没有审计记录" /> : <section className="panel"><div className="data-table-wrap"><table className="data-table audit-table"><thead><tr><th>时间</th><th>操作人</th><th>业务动作</th><th>对象</th><th>结果</th><th>操作详情</th></tr></thead><tbody>{rows.map((row) => {
      const isError = row.level === "error";
      const detailKeys = Object.keys(row.details || {});
      return <tr key={row.id} className={isError ? "audit-row--error" : ""}><td>{formatTimePrecise(row.createdAt)}</td><td><strong>{row.actorName}</strong>{row.actorUsername && <small>{row.actorUsername}</small>}</td><td className="audit-action">{isError && <WarningCircle size={15} weight="fill" />}<span>{row.actionLabel}</span></td><td>{row.subjectType === "user" && row.details?.username ? `账号 ${row.details.username}` : row.subjectLabel}</td><td>{row.resultLabel}</td><td className="audit-details-cell">{detailKeys.length ? <details className="audit-details"><summary>查看详情</summary><pre>{JSON.stringify(row.details, null, 2)}</pre></details> : <span className="muted">—</span>}</td></tr>;
    })}</tbody></table></div>{hasMore && <div className="pager"><span>已显示 {rows.length} 条</span><button className="admin-secondary" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "正在加载…" : "加载更多"}</button></div>}</section>}</>;
}

function CollapsiblePanel({ title, description, count, action, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = () => setOpen((value) => !value);
  return (
    <section className={`panel collapsible-panel${open ? "" : " is-collapsed"}`}>
      <div
        className="panel-heading collapsible-heading"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } }}
      >
        <div>
          <h2>{title}{Number.isFinite(count) && <span className="collapsible-count">{count}</span>}</h2>
          {description && <small className="collapsible-description">{description}</small>}
        </div>
        <div className="collapsible-actions" onClick={(event) => event.stopPropagation()}>
          {action}
          <button type="button" className="collapsible-toggle" aria-label={open ? `收起${title}` : `展开${title}`} title={open ? "收起" : "展开"} onClick={toggle}><CaretDown size={14} /></button>
        </div>
      </div>
      {open && children}
    </section>
  );
}

function DataPanel({ children, empty }) {
  const body = children?.props?.children?.[1]?.props?.children;
  if (Array.isArray(body) && body.length === 0) return <StatePanel title={empty} />;
  return <section className="panel"><div className="data-table-wrap">{children}</div></section>;
}

function StatePanel({ title, action }) { return <section className="panel empty-business"><WarningCircle size={30} weight="duotone" /><strong>{title}</strong>{action}</section>; }
function NoPermission({ action }) { return <StatePanel title="你没有权限访问此页面" action={action} />; }
// 未知/畸形路径的友好 404 页：提供返回入口，不白屏、不无限加载。
function RouteNotFound({ onBack }) {
  return <StatePanel title="页面不存在或链接有误" action={<button className="admin-primary" onClick={onBack}>返回运营概览</button>} />;
}

// —— 以下为详情/编辑路由屏：按 URL 参数拉取权威数据（深链接/刷新不依赖列表内存状态），
// 请求随路由切换取消（AbortController），失败给出可重试、可返回的恢复界面。——

// 用户编辑路由：按 id 拉取账号（GET /api/admin/users/:id，与列表同权限 user:manage），
// 账号类型从主角色推导（与列表 tab 语义一致）；账号不存在/无权限时给出可返回的错误态。
function UserEditorRoute({ userId, onBackForKind, run, reload, setToast }) {
  const { expire } = useAdminAuth();
  const [state, setState] = useState({ loading: true, error: "", row: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, error: "", row: null });
    request(API.admin.userDetail(userId), { schema: z.object({ user: UserRowSchema }), signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setState({ loading: false, error: "", row: result.user }); })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        if (loadError.kind === "session") { expire(); return; } // 会话失效：切登录遮罩，登录后同路由继续
        setState({ loading: false, error: loadError.message, row: null });
      });
    return () => controller.abort();
  }, [userId, attempt, expire]);
  const backLink = <button className="back-link" onClick={() => onBackForKind(state.row?.roleCode === "inspector" ? "inspector" : "admin")}><CaretRight size={15} /> 返回用户列表</button>;
  if (state.loading) return <>{backLink}<StatePanel title="正在加载账号数据…" /></>;
  if (state.error) return <>{backLink}<StatePanel title={state.error} action={<button className="admin-primary" onClick={() => setAttempt((value) => value + 1)}>重新加载</button>} /></>;
  const kind = state.row.roleCode === "inspector" ? "inspector" : "admin";
  return <UserEditor mode="edit" kind={kind} row={state.row} onBack={() => onBackForKind(kind)} run={run} reload={reload} setToast={setToast} />;
}

// 门店编辑路由：新建直接渲染空白表单；编辑按 id 拉取门店（GET /api/admin/stores/:id，
// 与列表同权限 store:manage 且同样受数据范围约束），坐标字段映射与列表行入口一致。
// 品牌选项由路由屏自行加载（权威品牌列表），加载失败可在表单内重试、不影响已填内容。
const BLANK_STORE = { name: "", businessNo: "", brandId: "", regionName: "", address: "", latitude: null, longitude: null, radiusMeters: 300, accuracyAllowanceMaxMeters: 200 };
const mapStoreRow = (row) => ({ ...row, latitude: row.latitudeGcj02, longitude: row.longitudeGcj02, accuracyAllowanceMaxMeters: row.accuracyAllowanceMaxMeters || 200 });
function StoreEditorRoute({ storeId, onBack, onCreated, ask, notify }) {
  const { expire } = useAdminAuth();
  const [state, setState] = useState({ loading: Boolean(storeId), error: "", store: storeId ? null : BLANK_STORE });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!storeId) return undefined;
    const controller = new AbortController();
    setState({ loading: true, error: "", store: null });
    request(API.admin.storeDetail(storeId), { schema: z.object({ store: StoreRowSchema }), signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setState({ loading: false, error: "", store: mapStoreRow(result.store) });
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setState({ loading: false, error: loadError.message, store: null }); // 会话过期也给出可重试错误态，重登后可重新加载
        if (loadError.kind === "session") expire();
      });
    return () => controller.abort();
  }, [storeId, attempt, expire]);
  const brands = useAdminBrands({ expire });
  const backLink = <button className="back-link" onClick={onBack}><CaretRight size={15} /> 返回门店列表</button>;
  if (state.loading) return <>{backLink}<StatePanel title="正在加载门店数据…" /></>;
  if (state.error) return <>{backLink}<StatePanel title={state.error} action={<button className="admin-primary" onClick={() => setAttempt((value) => value + 1)}>重新加载</button>} /></>;
  return <StoreEditor store={state.store} onBack={onBack} onCreated={onCreated} ask={ask} notify={notify} brands={brands} />;
}

// 权威品牌列表（编辑/新建路由独立加载，不再依赖列表页内存状态）：
// 失败给出可重试错误（表单输入不受影响）；expire 交由会话层切登录遮罩。
function useAdminBrands({ expire }) {
  const [state, setState] = useState({ brands: null, error: "" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    request(API.admin.brands, { schema: ADMIN_LIST_SCHEMAS.brands, signal: controller.signal })
      .then((result) => { if (active) setState({ brands: result.items, error: "" }); })
      .catch((loadError) => {
        if (!active || controller.signal.aborted) return;
        setState({ brands: null, error: loadError.message }); // 会话过期同样落到错误态（表单内重试可恢复）
        if (loadError.kind === "session") expire();
      });
    return () => { active = false; controller.abort(); };
  }, [attempt, expire]);
  return { brands: state.brands, error: state.error, reload: () => setAttempt((value) => value + 1) };
}

// 任务详情路由：按 id 拉取完整详情（含指派表），随 campaignId 切换取消过期请求。
function CampaignDetailRoute({ campaignId, onBack, run, ask, setToast }) {
  const { expire } = useAdminAuth();
  const [state, setState] = useState({ loading: true, error: "", campaign: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, error: "", campaign: null });
    request(API.admin.campaign(campaignId), { schema: CampaignDetailSchema, signal: controller.signal })
      .then((campaign) => { if (!controller.signal.aborted) setState({ loading: false, error: "", campaign }); })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setState({ loading: false, error: loadError.message, campaign: null }); // 会话过期也呈现可重试错误态
        if (loadError.kind === "session") expire();
      });
    return () => controller.abort();
  }, [campaignId, attempt, expire]);
  const backLink = <button className="back-link" onClick={onBack}><CaretRight size={15} /> 返回任务列表</button>;
  if (state.loading) return <>{backLink}<StatePanel title="正在加载指派人数…" /></>;
  if (state.error) return <>{backLink}<StatePanel title={state.error} action={<button className="admin-primary" onClick={() => setAttempt((value) => value + 1)}>重新加载</button>} /></>;
  const reload = () => setAttempt((value) => value + 1);
  return <CampaignDetail campaign={state.campaign} onBack={onBack}
    onEdit={() => navigate(adminPaths.campaignEdit(campaignId))}
    onAddInspector={() => navigate(adminPaths.campaignEdit(campaignId, 2))}
    onEditAssignment={(row) => navigate(adminPaths.assignmentEdit(campaignId, row.id))}
    reload={reload} run={run} ask={ask} setToast={setToast} />;
}

// 任务向导路由（URL 为准）：
//   - 新建（campaignId=null）恒为全新上下文：组件跨 new/edit 分支被 React 位置复用，
//     身份切换（含历史跨条目遍历）必须显式清掉旧实体，绝不在 /new 下渲染/提交别的任务。
//   - :id 一律按 ID 拉取持久化数据——包括首次创建后的那次 replace（多一次 GET 换取确定性，
//     POST 仍只发生一次）。不做「刚创建就跳过拉取」的脆弱优化：跨条目返回时易错配实体。
//   - 向导按实体 ID 加 key：同一任务内换步不卸载（输入保留）；换任务/换新建流才重挂。
//   - from=list|detail 记录进入来源（安全的站内枚举值，不充当跳转 URL）：关闭后回列表（带刷新）或回详情。
function CampaignWizardRoute({ campaignId, step, from, onClose, setToast }) {
  const { expire } = useAdminAuth();
  const effectiveFrom = from || (campaignId ? "detail" : "list");
  const [state, setState] = useState({ loading: Boolean(campaignId), error: "", campaign: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!campaignId) {
      setState({ loading: false, error: "", campaign: null });
      return undefined;
    }
    const controller = new AbortController();
    setState({ loading: true, error: "", campaign: null });
    request(API.admin.campaign(campaignId), { schema: CampaignDetailSchema, signal: controller.signal })
      .then((campaign) => { if (!controller.signal.aborted) setState({ loading: false, error: "", campaign }); })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setState({ loading: false, error: loadError.message, campaign: null }); // 会话过期也呈现可重试错误态
        if (loadError.kind === "session") expire();
      });
    return () => controller.abort();
  }, [campaignId, attempt, expire]);
  const backLink = <button className="back-link" onClick={() => onClose(campaignId, effectiveFrom)}>{effectiveFrom === "list" ? "返回任务列表" : "返回任务详情"}</button>;
  if (state.loading) return <>{backLink}<StatePanel title="正在加载任务数据…" /></>;
  if (state.error) return <>{backLink}<StatePanel title={state.error} action={<button className="admin-primary" onClick={() => setAttempt((value) => value + 1)}>重新加载</button>} /></>;
  return <CampaignWizard
    key={campaignId || "new"}
    campaign={state.campaign}
    step={step}
    returnTo={effectiveFrom}
    onClose={() => onClose(campaignId, effectiveFrom)}
    onStepChange={(next) => forceNavigate(adminPaths.campaignEdit(campaignId, next, effectiveFrom))}
    onCampaignCreated={(id) => forceNavigate(adminPaths.campaignEdit(id, 2, "list"), { replace: true })}
    setToast={setToast} />;
}

// 指派编辑路由：任务详情 + 指派行均按 URL 定位；指派不存在（已删除/链接有误）时给出可返回的恢复态。
function AssignmentEditorRoute({ campaignId, assignmentId, onBack, run }) {
  const { expire } = useAdminAuth();
  const [state, setState] = useState({ loading: true, error: "", campaign: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, error: "", campaign: null });
    request(API.admin.campaign(campaignId), { schema: CampaignDetailSchema, signal: controller.signal })
      .then((campaign) => { if (!controller.signal.aborted) setState({ loading: false, error: "", campaign }); })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setState({ loading: false, error: loadError.message, campaign: null }); // 会话过期也呈现可重试错误态
        if (loadError.kind === "session") expire();
      });
    return () => controller.abort();
  }, [campaignId, attempt, expire]);
  const backLink = <button className="back-link" onClick={onBack}><CaretRight size={15} /> 返回指派列表</button>;
  if (state.loading) return <>{backLink}<StatePanel title="正在加载任务数据…" /></>;
  if (state.error) return <>{backLink}<StatePanel title={state.error} action={<button className="admin-primary" onClick={() => setAttempt((value) => value + 1)}>重新加载</button>} /></>;
  const assignment = (state.campaign.assignments || []).find((row) => row.id === assignmentId);
  if (!assignment) return <>{backLink}<StatePanel title="这条指派不存在或已被删除" action={<button className="admin-primary" onClick={onBack}>返回任务详情</button>} /></>;
  return <AssignmentEditor campaign={state.campaign} assignment={assignment} onCancel={onBack} onSaved={onBack} run={run} />;
}

// —— 单份问卷导出：详情页一键导出当前提交（只绑定这一个 submissionId）———
// 完整闭环：确认弹窗 → 创建任务 → 行内有界轮询（2s 间隔、上限 5 分钟）→ 成功出下载链接。
// 生命周期：创建请求与轮询各自持有 AbortController，路由退出（卸载）与会话失效时一并中止，
// 卸载后才返回的创建请求不落状态、不启动轮询；pending 期间主按钮禁用防重复任务；
// 查询失败或轮询窗口用尽不停留在死锁态——保留已创建任务并提供「重新检查」恢复同一任务的轮询；
// 失败/过期提供「重新生成」（重建同 submissionId 的新任务）。
const EXPORT_POLL_INTERVAL_MS = 2000;
const EXPORT_POLL_MAX_MS = 300000;
const EXPORT_PENDING_STATUSES = ["queued", "processing"];
// 失败码 → 安全、可行动的提示（稳定业务码，不含内部细节）；未知码回退通用文案，不误导用户去别处“查看原因”
const EXPORT_FAILURE_MESSAGES = {
  EXPORT_SUBMISSION_SCORES_MISSING: "这份提交缺少可安全导出的逐题得分数据（可能是历史数据不完整），无法生成评估表。",
  EXPORT_SUBMISSION_NOT_FOUND: "提交记录不存在或已超出当前数据范围，任务已终止。",
  EXPORT_SUBMISSION_REQUIRED: "导出任务未绑定提交记录，请重新发起导出。",
  EXPORT_COS_NOT_CONFIGURED: "导出文件服务尚未配置，请联系管理员后再试。",
};
const exportFailureMessage = (code) => EXPORT_FAILURE_MESSAGES[code] || "导出失败，请重新生成；若反复失败请联系管理员处理。";

function SubmissionExport({ submissionId, setToast }) {
  const { expire } = useAdminAuth();
  const [job, setJob] = useState(null);
  const [creating, setCreating] = useState(false);
  const [watching, setWatching] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const createRef = useRef(null);
  const pollRef = useRef(null);
  const stopPolling = useCallback(() => {
    if (!pollRef.current) return;
    window.clearTimeout(pollRef.current.timer);
    pollRef.current.controller.abort();
    pollRef.current = null;
  }, []);
  const cancelCreate = useCallback(() => {
    if (!createRef.current) return;
    createRef.current.controller.abort();
    createRef.current = null;
  }, []);
  // 路由退出/组件卸载：同时中止在途创建请求与轮询
  useEffect(() => () => { cancelCreate(); stopPolling(); }, [cancelCreate, stopPolling]);
  const watch = useCallback((jobId) => {
    stopPolling();
    const controller = new AbortController();
    const state = { controller, timer: null, deadline: Date.now() + EXPORT_POLL_MAX_MS };
    pollRef.current = state;
    setWatching(true);
    setStalled(false);
    const finish = () => { if (pollRef.current === state) pollRef.current = null; setWatching(false); };
    const tick = async () => {
      if (controller.signal.aborted || pollRef.current !== state) return;
      try {
        const row = await request(API.admin.export(jobId), { schema: ExportRowSchema, signal: controller.signal });
        if (controller.signal.aborted || pollRef.current !== state) return;
        setError("");
        setStalled(false);
        // 每次轮询都刷新任务态（queued→processing 的推进即时可见）
        setJob({ id: jobId, status: row.status, downloadUrl: row.downloadUrl || null, fileName: row.fileName, failureCode: row.failureCode || null });
        if (!EXPORT_PENDING_STATUSES.includes(row.status)) { finish(); return; }
        if (Date.now() >= state.deadline) { finish(); setStalled(true); return; }
        state.timer = window.setTimeout(tick, EXPORT_POLL_INTERVAL_MS);
      } catch (pollError) {
        if (controller.signal.aborted || pollRef.current !== state) return;
        if (pollError.kind === "session") { finish(); expire(); return; }
        if (["timeout", "network"].includes(pollError.kind) && Date.now() < state.deadline) {
          state.timer = window.setTimeout(tick, EXPORT_POLL_INTERVAL_MS * 3);
          return;
        }
        // 查询失败：保留已创建任务（绝不自动重复生成），转为可恢复状态
        finish();
        setStalled(true);
        setError(pollError.message);
      }
    };
    state.timer = window.setTimeout(tick, EXPORT_POLL_INTERVAL_MS);
  }, [expire, stopPolling]);
  const create = async () => {
    if (creating || watching) return;
    setConfirming(false);
    setCreating(true);
    setError("");
    setStalled(false);
    const controller = new AbortController();
    const state = { controller };
    createRef.current = state;
    try {
      const created = await request(API.admin.exports, { method: "POST", body: { submissionId }, signal: controller.signal });
      if (controller.signal.aborted || createRef.current !== state) return; // 卸载后才返回：不落状态、不启动轮询
      createRef.current = null;
      setJob({ id: created.id, status: created.status || "queued", downloadUrl: null, fileName: null, failureCode: null });
      setToast("单份问卷导出已创建，正在生成文件");
      setCreating(false);
      watch(created.id);
    } catch (createError) {
      if (controller.signal.aborted || createRef.current !== state) return; // 卸载/会话失效导致的中止：静默
      createRef.current = null;
      setCreating(false);
      if (createError.kind === "session") { expire(); return; }
      setError(createError.message);
    }
  };
  // 恢复入口：复查同一个任务（不新建），从查询失败/暂停态回到轮询
  const recheck = () => {
    if (!job || creating || watching || !EXPORT_PENDING_STATUSES.includes(job.status)) return;
    setError("");
    watch(job.id);
  };
  const pending = Boolean(job && EXPORT_PENDING_STATUSES.includes(job.status));
  const canRegenerate = Boolean(job && ["failed", "expired"].includes(job.status));
  const statusView = () => {
    if (error) return <span className="submission-export__message is-error" role="alert">{error}</span>;
    if (!job) return null;
    if (job.status === "succeeded") return <span className="submission-export__message">Excel 文件已生成；下载链接有时效，请尽快下载：<a href={job.downloadUrl}>下载 Excel</a></span>;
    if (job.status === "failed") return <span className="submission-export__message is-error" role="alert">{exportFailureMessage(job.failureCode)}</span>;
    if (job.status === "expired") return <span className="submission-export__message" role="alert">下载已过期，请重新生成。</span>;
    if (stalled) return <span className="submission-export__message">任务仍在生成中，自动刷新已暂停。</span>;
    return <span className="submission-export__message">{job.status === "processing" ? "正在生成 Excel 文件…" : "导出任务排队中…"}</span>;
  };
  return <div className="submission-export-bar">
    <button className="admin-secondary" disabled={pending || creating} onClick={() => setConfirming(true)}>
      <DownloadSimple size={17} /> {creating ? "正在创建导出任务…" : pending ? "导出进行中…" : "导出这份问卷 Excel"}
    </button>
    {statusView()}
    {pending && !watching && <button className="admin-secondary" disabled={creating} onClick={recheck}>重新检查</button>}
    {canRegenerate && <button className="admin-secondary" disabled={creating} onClick={create}>重新生成</button>}
    <Modal open={confirming} title="导出这份问卷？" description={`将只为这一条提交记录（编号 ${submissionId.slice(0, 8)}）生成 Excel 评估表，下载链接有时效。`} confirmLabel={creating ? "创建中…" : "确认导出"} onCancel={() => !creating && setConfirming(false)} onConfirm={creating ? undefined : create} />
  </div>;
}

// 提交详情路由：按 id 拉取完整提交；页头字段取自详情载荷（生产端点返回任务/门店/时间）。
function SubmissionDetailRoute({ submissionId, parentList, run, setToast }) {
  const { expire } = useAdminAuth();
  const [state, setState] = useState({ loading: true, error: "", detail: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, error: "", detail: null });
    request(API.admin.submission(submissionId), { schema: SubmissionDetailSchema, signal: controller.signal })
      .then((detail) => { if (!controller.signal.aborted) setState({ loading: false, error: "", detail }); })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setState({ loading: false, error: loadError.message, detail: null }); // 会话过期也呈现可重试错误态
        if (loadError.kind === "session") expire();
      });
    return () => controller.abort();
  }, [submissionId, attempt, expire]);
  // 返回链接携带白名单内的父列表筛选（?list= 仅由站内构造），直接书签打开时退化为未过滤列表。
  const backLink = <button className="back-link" onClick={() => navigate(`/admin/submissions${listSearchOf("submissions", parentList)}`)}><CaretRight size={15} /> 返回提交列表</button>;
  if (state.loading) return <>{backLink}<StatePanel title="正在加载完整提交…" /></>;
  if (state.error) return <>{backLink}<StatePanel title={state.error} action={<button className="admin-primary" onClick={() => setAttempt((value) => value + 1)}>重新加载</button>} /></>;
  const detail = state.detail;
  const description = [detail.storeName, detail.submittedAt ? formatTime(detail.submittedAt) : ""].filter(Boolean).join(" · ");
  return <>{backLink}<PageHeader eyebrow="提交详情" title={detail.taskName || "提交详情"} description={description} /><SubmissionExport submissionId={submissionId} setToast={setToast} /><SubmissionDetail detail={detail} submissionId={submissionId} reload={() => setAttempt((value) => value + 1)} setToast={setToast} /></>;
}
function items(data) { return Array.isArray(data) ? data : data?.items || []; }
// 导出任务类型展示名：submission=单份问卷（提交详情发起），dashboard=数据看板，submissions=提交汇总
function exportKindLabel(kind) { return ({ submission: "单份问卷", dashboard: "数据看板", submissions: "提交记录" })[kind] || "提交记录"; }
// 导出失败短提示（列表行内展示；稳定业务码映射，未知码显示通用“导出失败”）
const EXPORT_FAILURE_HINTS = { EXPORT_SUBMISSION_SCORES_MISSING: "缺少可导出的得分数据", EXPORT_SUBMISSION_NOT_FOUND: "提交超出数据范围", EXPORT_SUBMISSION_REQUIRED: "任务未绑定提交", EXPORT_COS_NOT_CONFIGURED: "文件服务未配置" };
function exportFailureHint(code) { return EXPORT_FAILURE_HINTS[code] || "导出失败"; }
function roleLabel(role) { return ({ super_admin: "超级管理员", auditor: "审计员", operations_admin: "运营管理员", reviewer: "复核人员", store_manager: "门店负责人" })[role] || "管理员"; }
function categoryLabel(category) { return ({ environment: "环境卫生", service: "为客服务", product: "产品品质" })[category] || "问卷题目"; }
function dishStatusLabel(status) { return ({ ordered: "已点", substituted: "已替代", unavailable: "已售罄", skipped: "未点", extra: "额外菜品" })[status] || "状态待确认"; }
function exemptionStatusLabel(status) { return ({ active: "有效", consumed: "已使用", revoked: "已撤销", expired: "已过期" })[status] || "状态待确认"; }
function formatTime(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false }); }
// 审计需要秒级精确时间
function formatTimePrecise(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }); }
// —— 表单确认弹窗系列：统一替代 window.prompt，表单本身即确认步骤 ———
function askReason(ask, { title, description, danger = false, reasonLabel = "原因", reasonPlaceholder = "", confirmLabel = "确认", path, method = "POST", body, success, onSuccess }) {
  ask({ title, description, danger, path, method, body, success, onSuccess, confirmLabel, fields: [{ name: "reason", label: reasonLabel, type: "textarea", required: true, placeholder: reasonPlaceholder }], build: (values) => ({ ...(body || {}), reason: values.reason.trim() }) });
}
// 延期弹窗（钉死契约 POST /api/admin/assignments/:id/extend，AssignmentExtendSchema = revision+reason+可选双时间）：
// body 带 assignment.revision（乐观锁，必填）+ reason + 已填时间字段，日期转 UTC ISO；
// 行内校验失败不发请求；提交中禁用按钮；失败弹窗保持、后端 message 就地展示、已填内容不丢；
// 成功关闭弹窗并刷新任务详情，让新截止时间回显到指派表（revision 冲突按后端 409 就地提示）。
function ExtendDialog({ assignment, onClose, onDone, setToast }) {
  const { expire } = useAdminAuth();
  const [dueAt, setDueAt] = useState("");
  const [deadline, setDeadline] = useState("");
  const [reason, setReason] = useState("");
  const [problems, setProblems] = useState([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const extendTitleId = useId();
  // 未保存保护：已填内容与初始（全空）不一致即脏——返回/前进、菜单、刷新、退出登录先经统一确认；
  // 弹窗自身取消/遮罩关闭在脏态下先弹「放弃填写内容」；失败弹窗保持可继续编辑，保护保留。
  const fieldsRef = useRef({ dueAt: "", deadline: "", reason: "" });
  fieldsRef.current = { dueAt, deadline, reason };
  const isDirty = () => Boolean(fieldsRef.current.dueAt || fieldsRef.current.deadline || fieldsRef.current.reason.trim());
  useNavigationGuard(useCallback(() => isDirty(), []));
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const attemptClose = () => {
    if (pending) return;
    if (isDirty()) { setConfirmDiscard(true); return; }
    onClose();
  };
  const submit = async () => {
    if (pending) return;
    const nextProblems = [];
    if (!dueAt && !deadline) nextProblems.push("请至少填写一项延期时间");
    if (!reason.trim()) nextProblems.push("请填写延期原因");
    setProblems(nextProblems);
    if (nextProblems.length) return;
    setPending(true);
    setError("");
    const body = { revision: Number(assignment.revision), reason: reason.trim() };
    if (dueAt) body.dueAt = new Date(dueAt).toISOString();
    if (deadline) body.questionnaireDeadlineAt = new Date(deadline).toISOString();
    try {
      await request(API.admin.extendAssignment(assignment.id), { method: "POST", body });
      setToast("任务已延期");
      onDone();
    } catch (submitError) {
      setPending(false);
      if (submitError.kind === "session") { expire(); return; }
      setError(submitError.message);
    }
  };
  return <>
    <div className="modal-backdrop" role="presentation" onMouseDown={attemptClose}>
    <section className="modal-card modal-card--form" role="dialog" aria-modal="true" aria-labelledby={extendTitleId} onMouseDown={(event) => event.stopPropagation()}>
      <h2 id={extendTitleId}>延期这条指派？</h2>
      <p>两个截止时间至少填写一项；逾期指派延期后将恢复为进行中。</p>
      <div className="extend-current"><span>当前执行截止：{formatTime(assignment.dueAt)}</span><span>当前问卷最终截止：{formatTime(assignment.questionnaireDeadlineAt)}</span></div>
      <div className="form-dialog-fields">
        <label className="admin-field"><span>执行截止 dueAt（可留空）</span><input type="datetime-local" value={dueAt} disabled={pending} onChange={(event) => setDueAt(event.target.value)} /></label>
        <label className="admin-field"><span>问卷最终截止 questionnaireDeadlineAt（可留空）</span><input type="datetime-local" value={deadline} disabled={pending} onChange={(event) => setDeadline(event.target.value)} /></label>
        <label className="admin-field"><span>延期原因 reason（必填）</span><textarea rows="3" value={reason} disabled={pending} placeholder="例如：暴雨导致探店员无法到店" onChange={(event) => setReason(event.target.value)} /></label>
      </div>
      {problems.map((problem) => <p key={problem} className="form-message" role="alert">{problem}</p>)}
      {error ? <p className="form-message" role="alert">{error}</p> : null}
      <div className="modal-actions">
        <button className="button button--ghost" disabled={pending} onClick={attemptClose}>取消</button>
        <button className="button button--primary" disabled={pending} onClick={submit}>{pending ? "处理中…" : "确认延期"}</button>
      </div>
    </section>
    </div>
    {confirmDiscard && (
      <Modal open title="放弃填写的内容？" description="关闭弹窗将丢失已填写但未提交的内容。" danger confirmLabel="放弃内容" cancelLabel="继续填写" onCancel={() => setConfirmDiscard(false)} onConfirm={() => { setConfirmDiscard(false); onClose(); }} />
    )}
  </>;
}
function askExemption(ask, assignment) {
  ask({ title: "创建单次打卡豁免？", description: "豁免最长 30 分钟，并会在首次开始问卷时自动消费。", success: "单次打卡豁免已创建", path: API.admin.exemptions(assignment.id), confirmLabel: "创建豁免", fields: [{ name: "reason", label: "打卡豁免原因", type: "textarea", required: true }], build: (values) => ({ assignmentRevision: assignment.revision, reason: values.reason.trim(), validForMinutes: 30 }) });
}
function askRevokeExemption(ask, assignment) {
  ask({ title: "撤销这次打卡豁免？", description: "撤销后探店员需重新完成到店打卡。", danger: true, success: "打卡豁免已撤销", path: API.admin.revokeExemption(assignment.id, assignment.activeExemption.id), confirmLabel: "撤销豁免", fields: [{ name: "reason", label: "撤销原因", type: "textarea", required: true }], build: (values) => ({ revision: assignment.activeExemption.revision, reason: values.reason.trim() }) });
}
// 表格行“更多”菜单：收拢低频与危险操作，点击行外自动关闭。
function RowMenu({ items }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    // 点击菜单内部不关闭（否则 mousedown 冒泡会先卸载菜单项、onClick 永远不触发），点击行外才关闭。
    const close = (event) => { if (!event.target.closest?.(".row-menu")) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!items.length) return null;
  return <div className="row-menu">
    <button className="row-menu__trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>更多<CaretDown size={13} /></button>
    {open ? <div className="row-menu__list" role="menu">{items.map((item) => <button key={item.label} role="menuitem" className={item.danger ? "is-danger" : ""} onClick={() => { setOpen(false); item.onClick(); }}>{item.label}</button>)}</div> : null}
  </div>;
}
