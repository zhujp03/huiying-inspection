import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { API, AdminUserOptionSchema, AssignmentWriteSchema, QuestionnaireVersionRowSchema, listSchema } from "../../../../packages/contracts/index.js";
import { request } from "../api/client.js";
import { useAdminAuth } from "../auth/AdminAuth.jsx";
import { useNavigationGuard } from "../router.jsx";

function localValue(value) {
  if (!value) return "";
  const date = new Date(value); const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
function blankDish() { return { plannedName: "", quantity: 1, required: true, allowSubstitution: false }; }

// 游标分页 schema 派生：zod 默认 strip 未知字段，需显式声明 nextCursor 才能读到「加载更多」游标
// （不改 packages/contracts，在本文件内联派生，与 CampaignWizard 各自独立避免循环 import）。
// cursor 是不透明定位串，用 z.string() 而非 z.uuid()。
const NEXT_CURSOR_FIELD = { nextCursor: z.string().nullable().optional() };
const EDITOR_USERS_SCHEMA = listSchema(AdminUserOptionSchema, NEXT_CURSOR_FIELD);
const EDITOR_VERSIONS_SCHEMA = listSchema(QuestionnaireVersionRowSchema, NEXT_CURSOR_FIELD);
const EDITOR_SOURCES = {
  users: { path: `${API.admin.users}?kind=inspector&limit=100&order=desc`, schema: EDITOR_USERS_SCHEMA },
  versions: { path: `${API.admin.questionnaireVersions}?limit=100&order=desc`, schema: EDITOR_VERSIONS_SCHEMA },
};
// 选择器检索：对已加载选项按展示字段做客户端包含匹配（空关键字 = 全部）。
function matchOption(query, ...fields) {
  const keyword = query.trim().toLowerCase();
  return !keyword || fields.some((field) => String(field ?? "").toLowerCase().includes(keyword));
}

export function AssignmentEditor({ campaign, assignment, onCancel, onSaved, run }) {
  const { expire } = useAdminAuth();
  const editing = Boolean(assignment?.id);
  const [options, setOptions] = useState({ users: [], versions: [] });
  // 各数据源游标：null = 已到底（隐藏加载更多）；search 为选择器客户端检索关键字。
  const [cursors, setCursors] = useState({ users: null, versions: null });
  const [loadingMore, setLoadingMore] = useState({ users: false, versions: false });
  const [search, setSearch] = useState({ users: "", versions: "" });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    inspectorId: assignment?.inspectorId || "", questionnaireVersionId: assignment?.questionnaireVersionId || "",
    taskType: assignment?.taskType || "secret", startsAt: localValue(assignment?.startsAt || campaign.startsAt),
    dueAt: localValue(assignment?.dueAt || campaign.dueAt), budgetLimit: assignment?.budgetLimit ?? 0,
    receiptRequired: Boolean(assignment?.receiptRequired), specialInstruction: assignment?.specialInstruction || "",
    dishRequirements: assignment?.dishRequirements?.length ? assignment.dishRequirements : [blankDish()],
  });
  // 未保存修改守卫：与挂载时快照比较（改回原值即不脏）；保存成功后基准推进，失败保留拦截。
  const formRef = useRef(form);
  formRef.current = form;
  const formBaselineRef = useRef(form);
  useNavigationGuard(useCallback(() => JSON.stringify(formRef.current) !== JSON.stringify(formBaselineRef.current), []));

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      request(`${API.admin.users}?kind=inspector&limit=100&order=desc`, { signal: controller.signal, schema: EDITOR_USERS_SCHEMA }),
      request(`${API.admin.questionnaireVersions}?limit=100&order=desc`, { signal: controller.signal, schema: EDITOR_VERSIONS_SCHEMA }),
    ]).then(([users, versions]) => {
      setOptions({ users: users.items, versions: versions.items });
      setCursors({ users: users.nextCursor ?? null, versions: versions.nextCursor ?? null });
    })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        if (loadError.kind === "session") { expire(); return; }
        setMessage(loadError.message);
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  // 加载更多：cursor 累积追加（按 id 去重），到底后游标置 null 隐藏按钮。
  const loadMore = async (source) => {
    const target = EDITOR_SOURCES[source];
    const cursor = cursors[source];
    if (!target || !cursor || loadingMore[source]) return;
    setLoadingMore((current) => ({ ...current, [source]: true }));
    try {
      const result = await request(`${target.path}&cursor=${encodeURIComponent(cursor)}`, { schema: target.schema });
      setOptions((current) => {
        const seen = new Set(current[source].map((item) => item.id));
        return { ...current, [source]: [...current[source], ...result.items.filter((item) => !seen.has(item.id))] };
      });
      setCursors((current) => ({ ...current, [source]: result.nextCursor ?? null }));
    } catch (loadError) { setMessage(loadError.message); }
    finally { setLoadingMore((current) => ({ ...current, [source]: false })); }
  };

  // 已加载原始选项 → 业务过滤（已启用/已发布）→ 检索过滤；检索后仍保证当前已选值的选项在场。
  const activeUsers = useMemo(() => options.users.filter((user) => user.status === "approved_active"), [options.users]);
  const activeVersions = useMemo(() => options.versions.filter((version) => version.status === "published"), [options.versions]);
  const searchedUsers = useMemo(() => activeUsers.filter((user) => matchOption(search.users, user.displayName)), [activeUsers, search.users]);
  const searchedVersions = useMemo(() => activeVersions.filter((version) => matchOption(search.versions, version.name, version.versionLabel)), [activeVersions, search.versions]);
  const withSelected = (list, all, selectedId) => (!selectedId || list.some((item) => item.id === selectedId) ? list : [all.find((item) => item.id === selectedId), ...list].filter(Boolean));
  const userOptions = withSelected(searchedUsers, activeUsers, form.inspectorId);
  const versionOptions = withSelected(searchedVersions, activeVersions, form.questionnaireVersionId);

  const patch = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const patchDish = (index, patchValue) => patch("dishRequirements", form.dishRequirements.map((dish, dishIndex) => dishIndex === index ? { ...dish, ...patchValue } : dish));
  const removeDish = (index) => patch("dishRequirements", form.dishRequirements.filter((_, dishIndex) => dishIndex !== index));
  // 复合保存的检查点：第一段（指派本体 PATCH/POST）成功后记录服务端返回的 id/revision 与请求体指纹。
  // 重试时只续跑未完成的菜品步骤，绝不带旧 revision 重发已成功的第一段；指纹不一致（期间又改了输入）
  // 则以检查点携带的服务端 revision 精确重发第一段（真实冲突由服务端 409 明确报错，输入保留在表单）。
  const assignmentCheckpointRef = useRef(null);
  const save = () => {
    const payload = { ...form, budgetLimit: Number(form.budgetLimit), startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : "", dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : "", dishRequirements: form.dishRequirements.map((dish) => ({ ...dish, quantity: Number(dish.quantity) })), campaignRevision: campaign.revision, ...(editing ? { revision: assignment.revision } : {}) };
    const parsed = AssignmentWriteSchema.safeParse(payload);
    if (!parsed.success) return setMessage(parsed.error.issues[0].message);
    if (new Date(parsed.data.startsAt) < new Date(campaign.startsAt) || new Date(parsed.data.dueAt) > new Date(campaign.dueAt)) return setMessage("个人执行时间必须在探店任务的时间范围内");
    const { dishRequirements, ...assignmentBody } = parsed.data;
    run({
      title: editing ? "保存这条指派？" : "创建这条指派？",
      description: parsed.data.taskType === "overt" ? "明察可保存为草稿，但第一阶段不能发布。" : "探店员、问卷、时间、菜品和预算将独立保存。",
      retryableExecute: true, // execute 按检查点续跑：重试只补未完成的步骤，不会重放已完成写入
      execute: async () => {
        let assignmentId;
        let savedRevision;
        const checkpoint = assignmentCheckpointRef.current;
        if (checkpoint && checkpoint.fingerprint === JSON.stringify(assignmentBody)) {
          // 第一段已成功且输入未变：只续跑菜品步骤
          ({ id: assignmentId, revision: savedRevision } = checkpoint);
        } else {
          const targetId = checkpoint ? checkpoint.id : assignment?.id;
          const body = { ...assignmentBody, revision: checkpoint ? checkpoint.revision : assignment?.revision };
          const saved = await request(targetId ? API.admin.assignment(targetId) : API.admin.campaignAssignments(campaign.id), { method: targetId ? "PATCH" : "POST", body });
          assignmentId = targetId || saved?.id;
          if (!assignmentId) throw new Error("服务返回的分配信息不完整，请刷新后重试");
          savedRevision = saved?.revision ?? checkpoint?.revision ?? assignment?.revision ?? 0;
          assignmentCheckpointRef.current = { id: assignmentId, revision: savedRevision, fingerprint: JSON.stringify(assignmentBody) };
          // 注意：此处绝不推进表单基准——第一段落库不代表两段保存完成；若第二段再次失败，
          // 未保存的菜品/字段改动仍属「未保存修改」，导航守卫必须继续拦截（基准只在两段全部完成后推进）。
        }
        await request(API.admin.dishRequirements(assignmentId), { method: "PUT", body: { revision: savedRevision, items: dishRequirements } });
        assignmentCheckpointRef.current = null; // 两段全部完成
        formBaselineRef.current = { ...formRef.current }; // 保存成功：基准推进（失败时保留拦截）
      },
      success: editing ? "指派已保存" : "指派已创建", onSuccess: onSaved,
    });
  };

  return <><button className="back-link" onClick={onCancel}>返回指派列表</button><div className="page-heading"><div><span>任务指派</span><h1>{editing ? "编辑指派" : "添加探店员指派"}</h1></div></div><section className="panel editor-form"><div className="picker-toolbar"><label className="admin-field"><span>检索探店员</span><input value={search.users} onChange={(event) => setSearch((current) => ({ ...current, users: event.target.value }))} placeholder="按姓名过滤已加载探店员" /></label>{cursors.users && <button type="button" className="admin-secondary" onClick={() => loadMore("users")} disabled={loadingMore.users}>{loadingMore.users ? "正在加载…" : `加载更多探店员（已加载 ${activeUsers.length} 位）`}</button>}<label className="admin-field"><span>检索问卷版本</span><input value={search.versions} onChange={(event) => setSearch((current) => ({ ...current, versions: event.target.value }))} placeholder="按名称 / 版本号过滤已发布问卷" /></label>{cursors.versions && <button type="button" className="admin-secondary" onClick={() => loadMore("versions")} disabled={loadingMore.versions}>{loadingMore.versions ? "正在加载…" : `加载更多问卷（已加载 ${activeVersions.length} 个）`}</button>}</div><div className="field-grid"><label className="admin-field"><span>探店员</span><select value={form.inspectorId} disabled={loading || (editing && assignment.status !== "draft")} onChange={(event) => patch("inspectorId", event.target.value)}><option value="">请选择已启用探店员</option>{userOptions.map((user) => <option key={user.id} value={user.id}>{user.displayName}{user.regionName ? ` · ${user.regionName}` : ""}</option>)}</select></label><label className="admin-field"><span>任务类型</span><select value={form.taskType} disabled={editing && assignment.status !== "draft"} onChange={(event) => patch("taskType", event.target.value)}><option value="secret">暗访</option><option value="overt">明察（仅可保存草稿）</option></select></label><label className="admin-field"><span>已发布问卷版本</span><select value={form.questionnaireVersionId} disabled={loading || (editing && assignment.status !== "draft")} onChange={(event) => patch("questionnaireVersionId", event.target.value)}><option value="">请选择问卷版本</option>{versionOptions.map((version) => <option key={version.id} value={version.id}>{version.name} · {version.versionLabel}</option>)}</select></label><label className="admin-field"><span>预算上限（元）</span><input type="number" min="0" step="0.01" value={form.budgetLimit} onChange={(event) => patch("budgetLimit", event.target.value)} /></label><label className="admin-field"><span>个人开始时间</span><input type="datetime-local" value={form.startsAt} onChange={(event) => patch("startsAt", event.target.value)} /></label><label className="admin-field"><span>个人截止时间</span><input type="datetime-local" value={form.dueAt} onChange={(event) => patch("dueAt", event.target.value)} /></label></div><label className="admin-field"><span>个人特别说明</span><textarea rows="4" value={form.specialInstruction} onChange={(event) => patch("specialInstruction", event.target.value)} /></label><label className="receipt-requirement"><span><strong>要求上传消费小票</strong></span><input type="checkbox" checked={form.receiptRequired} onChange={(event) => patch("receiptRequired", event.target.checked)} /></label><section className="dish-requirement-editor"><div className="panel-heading"><div><h2>菜品要求</h2></div><button className="admin-secondary" onClick={() => patch("dishRequirements", [...form.dishRequirements, blankDish()])}>添加菜品</button></div>{form.dishRequirements.map((dish, index) => <div className="dish-requirement-row" key={dish.id || index}><label className="admin-field"><span>菜品名称</span><input value={dish.plannedName} onChange={(event) => patchDish(index, { plannedName: event.target.value })} /></label><label className="admin-field compact"><span>数量</span><input type="number" min="1" value={dish.quantity} onChange={(event) => patchDish(index, { quantity: event.target.value })} /></label><label className="check-field"><input type="checkbox" checked={dish.required} onChange={(event) => patchDish(index, { required: event.target.checked })} /><span>必点</span></label><label className="check-field"><input type="checkbox" checked={dish.allowSubstitution} onChange={(event) => patchDish(index, { allowSubstitution: event.target.checked })} /><span>允许替代</span></label><button className="link-danger" onClick={() => removeDish(index)}>删除</button></div>)}</section>{form.taskType === "overt" && <p className="business-notice">明察任务只能保存草稿，发布时系统会拒绝。</p>}{message && <p className="form-message" role="alert">{message}</p>}<div className="editor-footer"><button className="admin-secondary" onClick={onCancel}>取消</button><button className="admin-primary" onClick={save} disabled={loading}>保存指派</button></div></section></>;
}
