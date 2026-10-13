import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { CaretDown, Plus, WarningCircle } from "@phosphor-icons/react";
import { API, AdminUserOptionSchema, AssignmentUpsertSchema, BrandRowSchema, CampaignDetailSchema, CampaignWriteSchema, QuestionnaireVersionRowSchema, StoreRowSchema, listSchema } from "../../../../packages/contracts/index.js";
import { request } from "../api/client.js";
import { useAdminAuth } from "../auth/AdminAuth.jsx";
import { useNavigationGuard } from "../router.jsx";
import { brandGroups, businessNoOptions, cascadeFromStore, storeOptions } from "../utils/store-cascade.js";

// 游标分页 schema 派生：zod 默认 strip 未知字段，需显式声明 nextCursor 才能读到「加载更多」游标
// （不改 packages/contracts，在本文件内联派生）。cursor 是不透明定位串，用 z.string() 而非 z.uuid()。
const NEXT_CURSOR_FIELD = { nextCursor: z.string().nullable().optional() };
const WIZARD_STORES_SCHEMA = listSchema(StoreRowSchema, NEXT_CURSOR_FIELD);
const WIZARD_USERS_SCHEMA = listSchema(AdminUserOptionSchema, NEXT_CURSOR_FIELD);
const WIZARD_VERSIONS_SCHEMA = listSchema(QuestionnaireVersionRowSchema, NEXT_CURSOR_FIELD);
// 加载更多请求按数据源固定首屏参数，仅追加 cursor。
const WIZARD_SOURCES = {
  stores: { path: `${API.admin.stores}?limit=100`, schema: WIZARD_STORES_SCHEMA },
  users: { path: `${API.admin.users}?kind=inspector&limit=100&order=desc`, schema: WIZARD_USERS_SCHEMA },
  versions: { path: `${API.admin.questionnaireVersions}?limit=100&order=desc`, schema: WIZARD_VERSIONS_SCHEMA },
};
// 选择器检索：对已加载选项按展示字段做客户端包含匹配（空关键字 = 全部）。
function matchOption(query, ...fields) {
  const keyword = query.trim().toLowerCase();
  return !keyword || fields.some((field) => String(field ?? "").toLowerCase().includes(keyword));
}

// 探店任务三步向导：任务信息 → 指派探店员 → 确认并发布。
// 创建与编辑草稿共用同一条路径：离开第 1 步即落库为草稿（后续指派需要 campaignId），
// 离开第 2 步批量保存指派；后端每创建/修改/删除一条指派都会令任务 revision+1，
// 因此保存序列内用本地计数器同步递增，最后拉取详情对齐权威状态。
function localValue(value) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString();
}
function localInput(value) { return localValue(value).slice(0, 16); }
function blankDish() { return { plannedName: "", quantity: 1, required: true, allowSubstitution: false }; }

const STEPS = [
  { n: 1, label: "任务信息" },
  { n: 2, label: "指派探店员" },
  { n: 3, label: "确认并发布" },
];

// 行业务字段的稳定序列化：作为「已保存基线」参与脏比较（改动后改回原值即视为干净，保存也只挑真变更行）。
function rowBusinessJson(row) {
  return JSON.stringify({
    inspectorId: row.inspectorId, questionnaireVersionId: row.questionnaireVersionId, taskType: row.taskType,
    startsAt: row.startsAt, dueAt: row.dueAt, budgetLimit: row.budgetLimit, receiptRequired: row.receiptRequired,
    specialInstruction: row.specialInstruction,
    dishRequirements: row.dishRequirements.map((dish) => ({ plannedName: dish.plannedName, quantity: Number(dish.quantity), required: Boolean(dish.required), allowSubstitution: Boolean(dish.allowSubstitution) })),
  });
}

function seedRows(detail) {
  return (detail.assignments || []).map((assignment) => ({
    key: assignment.id, id: assignment.id, inspectorId: assignment.inspectorId || "", questionnaireVersionId: assignment.questionnaireVersionId || "",
    taskType: assignment.taskType || "secret", startsAt: localInput(assignment.startsAt), dueAt: localInput(assignment.dueAt),
    budgetLimit: assignment.budgetLimit ?? 0, receiptRequired: Boolean(assignment.receiptRequired), specialInstruction: assignment.specialInstruction || "",
    dishRequirements: (assignment.dishRequirements || []).map((dish) => ({ plannedName: dish.plannedName, quantity: dish.quantity, required: Boolean(dish.required), allowSubstitution: Boolean(dish.allowSubstitution) })),
    status: assignment.status, revision: assignment.revision, dirty: false, expanded: false,
  })).map((row) => ({ ...row, baseline: rowBusinessJson(row) }));
}

export function CampaignWizard({ campaign, step: stepProp = 1, returnTo = "list", onClose, onStepChange, onCampaignCreated, setToast }) {
  const { expire } = useAdminAuth();
  // editing 以已落库的 campaignState.id 为准：创建成功后立即翻转为编辑态（URL 已同步 replace）。
  const editing = Boolean(campaign?.id);
  const [step, setStep] = useState(stepProp);
  // URL 查询串驱动向导步：返回/前进带来的 step 变化同步进来（组件保持挂载，未保存输入不丢）。
  useEffect(() => { setStep(stepProp); }, [stepProp]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [options, setOptions] = useState({ stores: [], users: [], versions: [], brands: [] });
  // 各数据源游标：null = 已到底（隐藏加载更多）；search 为选择器客户端检索关键字。
  const [cursors, setCursors] = useState({ stores: null, users: null, versions: null });
  const [loadingMore, setLoadingMore] = useState({ stores: false, users: false, versions: false });
  const [search, setSearch] = useState({ stores: "", users: "", versions: "" });
  const [loading, setLoading] = useState(true);
  const [campaignState, setCampaignState] = useState({ id: campaign?.id || null, revision: campaign?.revision ?? null });
  const [form, setForm] = useState({
    name: campaign?.name || "", storeId: campaign?.storeId || "",
    visitStartDate: localValue(campaign?.startsAt).slice(0, 10), visitEndDate: localValue(campaign?.dueAt).slice(0, 10), visitStartTime: localValue(campaign?.startsAt).slice(11, 16), visitEndTime: localValue(campaign?.dueAt).slice(11, 16),
    questionnaireDeadlineAt: campaign?.questionnaireDeadlineAt ? localInput(campaign.questionnaireDeadlineAt) : "",
    commonInstruction: campaign?.commonInstruction || "",
  });
  const [rows, setRows] = useState(() => (editing ? seedRows(campaign) : []));
  const [removedRows, setRemovedRows] = useState([]); // 已落库、待在第 2 步保存时删除的指派
  const UNBRANDED = "__unbranded__"; // 级联里"未分品牌"组的哨兵值（组 brandId 为 null）
  const [brandValue, setBrandValue] = useState(""); // 第 1 步门店级联：品牌（提交真值仍是 form.storeId）
  const [businessNoValue, setBusinessNoValue] = useState(""); // 第 1 步门店级联：店号
  // 未保存修改守卫：与挂载/保存后的快照比较（第 1 步表单 + 指派行各有一份基线）。
  // 改动后改回原值即不脏；新增行（未落库）与删除已保存行视为脏；保存成功后对应基线推进。
  const formRef = useRef(form);
  formRef.current = form;
  const formBaselineRef = useRef(form);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const removedRowsRef = useRef(removedRows);
  removedRowsRef.current = removedRows;
  const rowsChanged = () => removedRowsRef.current.length > 0 || rowsRef.current.some((row) => !row.id || rowBusinessJson(row) !== row.baseline);
  useNavigationGuard(useCallback(() => JSON.stringify(formRef.current) !== JSON.stringify(formBaselineRef.current) || rowsChanged(), []));

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      request(`${API.admin.stores}?limit=100`, { signal: controller.signal, schema: WIZARD_STORES_SCHEMA }),
      request(`${API.admin.users}?kind=inspector&limit=100&order=desc`, { signal: controller.signal, schema: WIZARD_USERS_SCHEMA }),
      request(`${API.admin.questionnaireVersions}?limit=100&order=desc`, { signal: controller.signal, schema: WIZARD_VERSIONS_SCHEMA }),
      request(`${API.admin.brands}?limit=100`, { signal: controller.signal, schema: listSchema(BrandRowSchema) }),
    ]).then(([stores, users, versions, brands]) => {
      setOptions({ stores: stores.items, users: users.items, versions: versions.items, brands: brands.items });
      setCursors({ stores: stores.nextCursor ?? null, users: users.nextCursor ?? null, versions: versions.nextCursor ?? null });
    }).catch((loadError) => {
      if (controller.signal.aborted) return;
      // 会话失效：回登录页（保留当前向导 URL，登录后回到原步）；其余失败就地报错可重试。
      if (loadError.kind === "session") { expire(); return; }
      setError(loadError.message);
    })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  // 加载更多：cursor 累积追加（按 id 去重），到底后游标置 null 隐藏按钮。
  const loadMore = async (source) => {
    const target = WIZARD_SOURCES[source];
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
    } catch (loadError) { setToast(loadError.message, "error"); }
    finally { setLoadingMore((current) => ({ ...current, [source]: false })); }
  };

  // 编辑/复制回填：门店列表加载完成后用 storeId 反查级联值，只回填一次（避免覆盖用户手动清空后的选择）；
  // 反查未命中（门店不在 active 列表）时级联保持空，form.storeId 原值保留由摘要区 campaign?.storeName 兜底。
  const cascadeHydratedRef = useRef(false);
  useEffect(() => {
    if (cascadeHydratedRef.current || loading || !campaign?.storeId) return;
    cascadeHydratedRef.current = true;
    const cascade = cascadeFromStore(options.stores, campaign.storeId);
    if (cascade) { setBrandValue(cascade.brandId ?? UNBRANDED); setBusinessNoValue(cascade.businessNo); }
  }, [campaign, options.stores, loading]);

  const patch = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  // 已加载原始选项 → 业务过滤（active/已启用/已发布）→ 检索过滤；级联与下拉一律从最终集合派生。
  const activeStores = useMemo(() => options.stores.filter((store) => store.active), [options.stores]);
  const activeUsers = useMemo(() => options.users.filter((user) => user.status === "approved_active"), [options.users]);
  const activeVersions = useMemo(() => options.versions.filter((version) => version.status === "published"), [options.versions]);
  const activeBrands = useMemo(() => options.brands.filter((brand) => brand.active), [options.brands]);
  const searchedStores = useMemo(() => activeStores.filter((store) => matchOption(search.stores, store.name, store.businessNo, store.regionName)), [activeStores, search.stores]);
  const searchedUsers = useMemo(() => activeUsers.filter((user) => matchOption(search.users, user.displayName)), [activeUsers, search.users]);
  const searchedVersions = useMemo(() => activeVersions.filter((version) => matchOption(search.versions, version.name, version.versionLabel)), [activeVersions, search.versions]);
  // 检索过滤后仍保证「当前已选值」的下拉选项在场，避免已选值显示丢失。
  const withSelected = (list, all, selectedId) => (!selectedId || list.some((item) => item.id === selectedId) ? list : [all.find((item) => item.id === selectedId), ...list].filter(Boolean));
  // 第 1 步门店三级级联（品牌 → 店号 → 店名）的派生选项与联动（选项从检索后的累积门店集派生）
  const resolvedBrandId = brandValue === UNBRANDED ? null : brandValue;
  const brandOptions = brandGroups(searchedStores, activeBrands);
  const noOptions = businessNoOptions(searchedStores, resolvedBrandId);
  const nameOptions = storeOptions(searchedStores, resolvedBrandId, businessNoValue);
  const selectBrand = (value) => { setBrandValue(value); setBusinessNoValue(""); patch("storeId", ""); };
  const selectBusinessNo = (value) => {
    setBusinessNoValue(value);
    const matches = storeOptions(searchedStores, resolvedBrandId, value);
    patch("storeId", matches.length === 1 ? matches[0].id : ""); // 组+店号唯一命中时自动选中店名
  };
  const campaignWindow = () => ({
    start: form.visitStartDate && form.visitStartTime ? new Date(`${form.visitStartDate}T${form.visitStartTime}`) : null,
    due: form.visitEndDate && form.visitEndTime ? new Date(`${form.visitEndDate}T${form.visitEndTime}`) : null,
  });
  const patchRow = (key, patchValue) => setRows((current) => current.map((row) => row.key === key ? { ...row, ...patchValue, dirty: true } : row));
  const patchDish = (key, index, dishPatch) => setRows((current) => current.map((row) => row.key === key ? { ...row, dirty: true, dishRequirements: row.dishRequirements.map((dish, dishIndex) => dishIndex === index ? { ...dish, ...dishPatch } : dish) } : row));
  const addRow = () => {
    const window = campaignWindow();
    setRows((current) => [...current, {
      key: `new-${current.length + 1}-${Date.now()}`, id: null, inspectorId: "", questionnaireVersionId: activeVersions[0]?.id || "",
      taskType: "secret",
      startsAt: window.start && !Number.isNaN(window.start.getTime()) ? localInput(window.start.toISOString()) : "",
      dueAt: window.due && !Number.isNaN(window.due.getTime()) ? localInput(window.due.toISOString()) : "",
      budgetLimit: 0, receiptRequired: false, specialInstruction: "", dishRequirements: [blankDish()],
      status: null, revision: 0, dirty: true, expanded: true,
    }]);
  };
  const removeRow = (key) => {
    const row = rows.find((item) => item.key === key);
    if (row?.id) setRemovedRows((current) => [...current, row]);
    setRows((current) => current.filter((item) => item.key !== key));
  };

  // —— 第 1 步：校验并落库任务基本信息 ——
  const buildCampaignPayload = () => {
    if (!form.visitStartDate || !form.visitEndDate || !form.visitStartTime || !form.visitEndTime) return { error: "请填写探店日期和探店时间段" };
    const window = campaignWindow();
    if (window.start >= window.due) return { error: "探店结束必须晚于探店开始" };
    if (!form.questionnaireDeadlineAt) return { error: "请选择问卷最终截止时间" };
    const payload = {
      name: form.name.trim(), storeId: form.storeId,
      startsAt: window.start.toISOString(),
      dueAt: window.due.toISOString(),
      questionnaireDeadlineAt: new Date(form.questionnaireDeadlineAt).toISOString(),
      commonInstruction: form.commonInstruction,
      ...(editing ? { revision: campaignState.revision } : {}),
    };
    const parsed = CampaignWriteSchema.safeParse(payload);
    return parsed.success ? { payload: parsed.data } : { error: parsed.error.issues[0].message };
  };
  const saveCampaignInfo = async () => {
    const built = buildCampaignPayload();
    if (built.error) return setError(built.error);
    setError("");
    setBusy(true);
    try {
      if (campaignState.id) {
        const result = await request(API.admin.campaign(campaignState.id), { method: "PATCH", body: built.payload });
        setCampaignState((current) => ({ ...current, revision: result.campaign.revision }));
        formBaselineRef.current = { ...formRef.current }; // 第 1 步保存成功：任务信息基线推进
        goStep(2);
      } else {
        const result = await request(API.admin.campaigns, { method: "POST", body: built.payload });
        setCampaignState({ id: result.campaign.id, revision: result.campaign.revision });
        formBaselineRef.current = { ...formRef.current };
        setStep(2);
        // 首次创建：URL replace 为已保存草稿的编辑地址（step=2），刷新落到持久化数据，不会重复 POST。
        onCampaignCreated?.(result.campaign.id, result.campaign.revision);
        setToast("任务草稿已创建，请继续指派探店员");
      }
    } catch (saveError) { setError(saveError.message); }
    finally { setBusy(false); }
  };

  // —— 第 2 步：批量保存指派（删除 → 更新 → 新建），同步递增任务 revision ——
  const validateRows = () => {
    const window = campaignWindow();
    const seen = new Set();
    for (const [index, row] of rows.entries()) {
      const label = `第 ${index + 1} 位探店员`;
      if (!row.inspectorId) return `${label}：请选择探店员`;
      if (seen.has(row.inspectorId)) return `${label}：同一位探店员在任务中只能指派一次`;
      seen.add(row.inspectorId);
      if (!row.questionnaireVersionId) return `${label}：请选择问卷版本`;
      if (!row.startsAt || !row.dueAt) return `${label}：请填写个人执行时间`;
      if (new Date(row.dueAt) <= new Date(row.startsAt)) return `${label}：个人截止时间必须晚于开始时间`;
      if (window.start && new Date(row.startsAt) < window.start) return `${label}：个人开始时间早于探店任务开始时间`;
      if (window.due && new Date(row.dueAt) > window.due) return `${label}：个人截止时间晚于探店任务截止时间`;
    }
    return "";
  };
  const putDishes = async (assignmentId, assignmentRevision, dishes) => {
    const items = dishes.filter((dish) => dish.plannedName.trim()).map((dish) => ({ plannedName: dish.plannedName.trim(), quantity: Number(dish.quantity) || 1, required: Boolean(dish.required), allowSubstitution: Boolean(dish.allowSubstitution) }));
    await request(API.admin.dishRequirements(assignmentId), { method: "PUT", body: { revision: assignmentRevision, items } });
  };
  const assignmentPayload = (row, campaignRevision) => ({
    inspectorId: row.inspectorId, questionnaireVersionId: row.questionnaireVersionId, taskType: row.taskType,
    startsAt: new Date(row.startsAt).toISOString(), dueAt: new Date(row.dueAt).toISOString(),
    budgetLimit: Number(row.budgetLimit) || 0, receiptRequired: row.receiptRequired, specialInstruction: row.specialInstruction.trim(),
    campaignRevision, ...(row.id ? { revision: row.revision } : {}),
  });
  const saveRows = async () => {
    const invalid = validateRows();
    if (invalid) return setError(invalid);
    setError("");
    setBusy(true);
    try {
      let revision = campaignState.revision;
      for (const row of removedRows) {
        await request(API.admin.assignment(row.id), { method: "DELETE", body: { revision: row.revision } });
        revision += 1;
      }
      for (const row of rows) {
        // 只保存真变更行：改回基线的行不再提交（row.dirty 仅用于「已保存草稿」标记显示）。
        if (row.id && rowBusinessJson(row) === row.baseline) continue;
        const payload = AssignmentUpsertSchema.parse(assignmentPayload(row, revision));
        const saved = row.id
          ? await request(API.admin.assignment(row.id), { method: "PATCH", body: payload })
          : await request(API.admin.campaignAssignments(campaignState.id), { method: "POST", body: payload });
        revision += 1;
        await putDishes(saved.id, saved.revision, row.dishRequirements);
      }
      // 拉取权威详情：对齐任务 revision 与指派列表，避免向导内乐观锁漂移
      const fresh = await request(API.admin.campaign(campaignState.id), { schema: CampaignDetailSchema });
      setCampaignState({ id: fresh.id, revision: fresh.revision });
      setRows(seedRows(fresh));
      setRemovedRows([]);
      goStep(3);
    } catch (saveError) { setError(saveError.message); }
    finally { setBusy(false); }
  };

  // —— 第 3 步：确认并发布（发布后指派立即出现在探店员小程序日程） ——
  const publishBlockers = () => {
    const blockers = [];
    if (rows.length === 0) blockers.push("尚未添加任何探店员指派");
    const overtCount = rows.filter((row) => row.taskType === "overt").length;
    if (overtCount > 0) blockers.push(`${overtCount} 位明察指派：发布仅支持暗访，请改为暗访或先保存草稿`);
    if (campaign?.locationVerified === false) blockers.push("门店位置未校准，请先到门店管理校准位置");
    return blockers;
  };
  const publish = async () => {
    setError("");
    setBusy(true);
    try {
      await request(API.admin.publishCampaign(campaignState.id), { method: "POST", body: { revision: campaignState.revision } });
      // 发布成功：任务与指派全部落库，基线整体推进。
      formBaselineRef.current = { ...formRef.current };
      setRows((current) => current.map((row) => ({ ...row, baseline: rowBusinessJson(row) })));
      setRemovedRows([]);
      setToast("任务已发布，指派已同步到探店员日程");
      onClose(true);
    } catch (publishError) { setError(publishError.message); }
    finally { setBusy(false); }
  };
  // 步骤切换 = 站内导航（push）：URL 携带 step，返回/前进可回到对应步；组件不卸载，输入保留。
  const goStep = (target) => { setError(""); setStep(target); onStepChange?.(target); };
  const cancel = () => {
    if (!editing && campaignState.id && rows.length === 0) setToast("任务草稿已保存在任务列表，可继续编辑或删除");
    onClose(false);
  };

  const blockers = publishBlockers();
  const stepBody = step === 1 ? (
    <section className="panel editor-form">
      <div className="field-grid">
        <label className="admin-field"><span>任务名称</span><input value={form.name} onChange={(event) => patch("name", event.target.value)} placeholder="例如：XX 门店 8 月暗访" /></label>
        <label className="admin-field"><span>品牌</span><select value={brandValue} disabled={loading} onChange={(event) => selectBrand(event.target.value)}><option value="">{loading ? "正在加载品牌…" : "请选择品牌"}</option>{brandOptions.map((group) => <option key={group.brandId ?? UNBRANDED} value={group.brandId ?? UNBRANDED}>{group.label}</option>)}</select></label>
        <label className="admin-field"><span>店号</span><select value={businessNoValue} disabled={loading || !brandValue} onChange={(event) => selectBusinessNo(event.target.value)}><option value="">{!brandValue ? "请先选择品牌" : "请选择店号"}</option>{noOptions.map((businessNo) => <option key={businessNo} value={businessNo}>{businessNo}</option>)}</select></label>
        <label className="admin-field"><span>店名</span><select value={form.storeId} disabled={loading || !businessNoValue} onChange={(event) => patch("storeId", event.target.value)}><option value="">{!businessNoValue ? "请先选择店号" : "请选择门店"}</option>{nameOptions.map((store) => <option key={store.id} value={store.id}>{store.name} · {store.regionName}</option>)}</select></label>
        <label className="admin-field"><span>探店开始日期</span><input type="date" value={form.visitStartDate} onChange={(event) => patch("visitStartDate", event.target.value)} /></label>
        <label className="admin-field"><span>探店结束日期</span><input type="date" value={form.visitEndDate} onChange={(event) => patch("visitEndDate", event.target.value)} /></label>
        <label className="admin-field"><span>探店时间段</span><span className="time-range"><input type="time" aria-label="探店开始时间" value={form.visitStartTime} onChange={(event) => patch("visitStartTime", event.target.value)} /> 至 <input type="time" aria-label="探店结束时间" value={form.visitEndTime} onChange={(event) => patch("visitEndTime", event.target.value)} /></span></label>
        <label className="admin-field"><span>问卷最终截止</span><input type="datetime-local" value={form.questionnaireDeadlineAt} onChange={(event) => patch("questionnaireDeadlineAt", event.target.value)} /></label>
      </div>
      <div className="picker-toolbar">
        <label className="admin-field"><span>检索门店</span><input value={search.stores} onChange={(event) => setSearch((current) => ({ ...current, stores: event.target.value }))} placeholder="按名称 / 店号 / 区域过滤已加载门店" /></label>
        {cursors.stores && <button type="button" className="admin-secondary" onClick={() => loadMore("stores")} disabled={loadingMore.stores}>{loadingMore.stores ? "正在加载…" : `加载更多门店（已加载 ${activeStores.length} 家）`}</button>}
      </div>
      <label className="admin-field"><span>共用说明</span><textarea rows="5" value={form.commonInstruction} onChange={(event) => patch("commonInstruction", event.target.value)} placeholder="保密提示、到店时间要求和共同观察重点" /></label>
      {error && <p className="form-message" role="alert">{error}</p>}
      <div className="editor-footer">
        <button className="admin-secondary" onClick={cancel}>取消</button>
        <button className="admin-primary" onClick={saveCampaignInfo} disabled={busy}>{busy ? "正在保存…" : "下一步：指派探店员"}</button>
      </div>
    </section>
  ) : step === 2 ? (
    <section className="panel editor-form">
      <div className="wizard-row-head">
        <p className="wizard-hint">可一次添加多位探店员；个人时间默认为任务探店窗口，可单独调整。同店多人各自使用相互隔离的独立问卷。</p>
        <button className="admin-secondary" onClick={addRow} disabled={loading}><Plus size={15} /> 添加探店员</button>
      </div>
      <div className="picker-toolbar">
        <label className="admin-field"><span>检索探店员</span><input value={search.users} onChange={(event) => setSearch((current) => ({ ...current, users: event.target.value }))} placeholder="按姓名过滤已加载探店员" /></label>
        {cursors.users && <button type="button" className="admin-secondary" onClick={() => loadMore("users")} disabled={loadingMore.users}>{loadingMore.users ? "正在加载…" : `加载更多探店员（已加载 ${activeUsers.length} 位）`}</button>}
        <label className="admin-field"><span>检索问卷版本</span><input value={search.versions} onChange={(event) => setSearch((current) => ({ ...current, versions: event.target.value }))} placeholder="按名称 / 版本号过滤已发布问卷" /></label>
        {cursors.versions && <button type="button" className="admin-secondary" onClick={() => loadMore("versions")} disabled={loadingMore.versions}>{loadingMore.versions ? "正在加载…" : `加载更多问卷（已加载 ${activeVersions.length} 个）`}</button>}
      </div>
      <div className="wizard-rows">
        {rows.map((row, index) => (
          <article className="wizard-row" key={row.key}>
            <div className="wizard-row-title">
              <strong>探店员 {index + 1}{row.inspectorId ? ` · ${activeUsers.find((user) => user.id === row.inspectorId)?.displayName || ""}` : ""}{row.status && !row.dirty ? <em className="wizard-row-tag">{row.status === "draft" ? "已保存草稿" : ""}</em> : null}</strong>
              <button className="link-danger" onClick={() => removeRow(row.key)}>移除</button>
            </div>
            <div className="wizard-row-fields">
              <label className="admin-field"><span>探店员</span><select value={row.inspectorId} onChange={(event) => patchRow(row.key, { inspectorId: event.target.value })}><option value="">请选择已启用探店员</option>{withSelected(searchedUsers, activeUsers, row.inspectorId).map((user) => <option key={user.id} value={user.id}>{user.displayName}{user.regionName ? ` · ${user.regionName}` : ""}</option>)}</select></label>
              <label className="admin-field"><span>任务类型</span><select value={row.taskType} onChange={(event) => patchRow(row.key, { taskType: event.target.value })}><option value="secret">暗访</option><option value="overt">明察（仅可保存草稿）</option></select></label>
              <label className="admin-field"><span>已发布问卷版本</span><select value={row.questionnaireVersionId} onChange={(event) => patchRow(row.key, { questionnaireVersionId: event.target.value })}><option value="">请选择问卷版本</option>{withSelected(searchedVersions, activeVersions, row.questionnaireVersionId).map((version) => <option key={version.id} value={version.id}>{version.name} · {version.versionLabel}</option>)}</select></label>
              <label className="admin-field"><span>个人执行时间</span><span className="time-range"><input type="datetime-local" aria-label="个人开始时间" value={row.startsAt} onChange={(event) => patchRow(row.key, { startsAt: event.target.value })} /> 至 <input type="datetime-local" aria-label="个人截止时间" value={row.dueAt} onChange={(event) => patchRow(row.key, { dueAt: event.target.value })} /></span></label>
            </div>
            <button className="wizard-row-more" onClick={() => patchRow(row.key, { expanded: !row.expanded })}>{row.expanded ? "收起详细设置" : "预算 / 小票 / 特别说明 / 菜品要求"}<CaretDown size={13} className={row.expanded ? "is-flipped" : ""} /></button>
            {row.expanded && (
              <div className="wizard-row-extra">
                <div className="field-grid">
                  <label className="admin-field"><span>预算上限（元）</span><input type="number" min="0" step="0.01" value={row.budgetLimit} onChange={(event) => patchRow(row.key, { budgetLimit: event.target.value })} /></label>
                  <label className="check-field wizard-receipt"><input type="checkbox" checked={row.receiptRequired} onChange={(event) => patchRow(row.key, { receiptRequired: event.target.checked })} /><span>要求上传消费小票</span></label>
                </div>
                <label className="admin-field"><span>个人特别说明</span><textarea rows="3" value={row.specialInstruction} onChange={(event) => patchRow(row.key, { specialInstruction: event.target.value })} /></label>
                <div className="dish-requirement-editor">
                  <div className="wizard-dish-head"><strong>菜品要求</strong><button className="admin-secondary" onClick={() => patchRow(row.key, { dishRequirements: [...row.dishRequirements, blankDish()] })}>添加菜品</button></div>
                  {row.dishRequirements.map((dish, dishIndex) => (
                    <div className="dish-requirement-row" key={dishIndex}>
                      <label className="admin-field"><span>菜品名称</span><input value={dish.plannedName} onChange={(event) => patchDish(row.key, dishIndex, { plannedName: event.target.value })} /></label>
                      <label className="admin-field compact"><span>数量</span><input type="number" min="1" value={dish.quantity} onChange={(event) => patchDish(row.key, dishIndex, { quantity: event.target.value })} /></label>
                      <label className="check-field"><input type="checkbox" checked={dish.required} onChange={(event) => patchDish(row.key, dishIndex, { required: event.target.checked })} /><span>必点</span></label>
                      <label className="check-field"><input type="checkbox" checked={dish.allowSubstitution} onChange={(event) => patchDish(row.key, dishIndex, { allowSubstitution: event.target.checked })} /><span>允许替代</span></label>
                      <button className="link-danger" onClick={() => patchRow(row.key, { dishRequirements: row.dishRequirements.filter((_, itemIndex) => itemIndex !== dishIndex) })}>删除</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {row.taskType === "overt" && <p className="business-notice">明察任务只能保存草稿，发布时系统会拒绝。</p>}
          </article>
        ))}
        {rows.length === 0 && <div className="empty-business"><strong>还没有指派探店员</strong><p>点击右上角「添加探店员」，可连续添加多位。</p></div>}
      </div>
      {error && <p className="form-message" role="alert">{error}</p>}
      <div className="editor-footer">
        <button className="admin-secondary" onClick={() => goStep(1)} disabled={busy}>上一步</button>
        <button className="admin-primary" onClick={saveRows} disabled={busy}>{busy ? "正在保存指派…" : "下一步：确认并发布"}</button>
      </div>
    </section>
  ) : (
    <section className="panel editor-form wizard-review">
      <div className="wizard-summary">
        <h2>任务信息</h2>
        <dl>
          <div><dt>任务名称</dt><dd>{form.name || "—"}</dd></div>
          <div><dt>门店</dt><dd>{activeStores.find((store) => store.id === form.storeId)?.name || campaign?.storeName || "—"}</dd></div>
          <div><dt>探店窗口</dt><dd>{form.visitStartDate} {form.visitStartTime} 至 {form.visitEndDate} {form.visitEndTime}</dd></div>
          <div><dt>问卷最终截止</dt><dd>{form.questionnaireDeadlineAt.replace("T", " ") || "—"}</dd></div>
          {form.commonInstruction && <div><dt>共用说明</dt><dd>{form.commonInstruction}</dd></div>}
        </dl>
      </div>
      <div className="wizard-summary">
        <h2>指派明细（{rows.length} 人）</h2>
        <table className="data-table">
          <thead><tr><th>探店员</th><th>类型</th><th>问卷版本</th><th>个人时间</th></tr></thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.key}>
                <td><strong>{activeUsers.find((user) => user.id === row.inspectorId)?.displayName || `第 ${index + 1} 位`}</strong></td>
                <td>{row.taskType === "secret" ? "暗访" : "明察"}</td>
                <td>{activeVersions.find((version) => version.id === row.questionnaireVersionId)?.name || "—"}</td>
                <td>{row.startsAt.replace("T", " ")} 至 {row.dueAt.replace("T", " ")}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan="4">尚未指派探店员</td></tr>}
          </tbody>
        </table>
      </div>
      {blockers.length > 0 && <div className="wizard-blockers" role="alert"><WarningCircle size={17} /><div><strong>发布前需要处理：</strong><ul>{blockers.map((item) => <li key={item}>{item}</li>)}</ul></div></div>}
      {error && <p className="form-message" role="alert">{error}</p>}
      <div className="editor-footer">
        <button className="admin-secondary" onClick={() => goStep(2)} disabled={busy}>上一步</button>
        <span className="wizard-footer-actions">
          <button className="admin-secondary" onClick={cancel} disabled={busy}>仅存草稿</button>
          <button className="admin-primary" onClick={publish} disabled={busy || blockers.length > 0}>{busy ? "正在发布…" : "确认并发布"}</button>
        </span>
      </div>
    </section>
  );

  return (
    <>
      <button className="back-link" onClick={cancel}>{returnTo === "detail" ? "返回任务详情" : "返回任务列表"}</button>
      <div className="page-heading"><div><span>探店任务</span><h1>{editing ? "编辑探店任务" : "新建探店任务"}</h1></div></div>
      <nav className="wizard-steps" aria-label="创建进度">
        {STEPS.map(({ n, label }) => (
          <button
            key={n}
            className={`wizard-step${step === n ? " is-active" : ""}${step > n ? " is-done" : ""}`}
            disabled={step <= n}
            onClick={() => goStep(n)}
          >
            <span className="wizard-step-index">{step > n ? "✓" : n}</span>{label}
          </button>
        ))}
      </nav>
      {stepBody}
    </>
  );
}
