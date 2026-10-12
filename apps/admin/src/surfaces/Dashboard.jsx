import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DownloadSimple, Funnel } from "@phosphor-icons/react";
import { ADMIN_LIST_SCHEMAS, API, DashboardStatsSchema, ExportRowSchema, RegionRowSchema, listSchema } from "../../../../packages/contracts/index.js";
import { request } from "../api/client.js";
import { PageHeader } from "../components/BusinessUI.jsx";

// 数据看板：点查询模式（筛选后点「查询」再渲染），与 Submissions 的 query()/reset() 同一交互模式。
const REPORTS = [
  { id: "trend", label: "得分趋势" },
  { id: "storeTrend", label: "门店得分展示" },
  { id: "storeBar", label: "门店单月得分展示" },
  { id: "storeCategory", label: "门店大项得分率对比" },
  { id: "questions", label: "考核点整体得分率展示" },
];
const MONTH_COLORS = ["#0f766e", "#2563eb", "#10b981", "#f59e0b", "#8b5cf6", "#e11d48", "#0891b2", "#ca8a04"];
const PAGE_SIZE = 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shanghaiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
const emptyFilters = () => ({ from: `${shanghaiToday().slice(0, 7)}-01`, to: shanghaiToday(), brandId: "", cityRegionId: "", regionId: "", storeId: "" });
const lowClass = (value) => (typeof value === "number" && value < 80 ? "cell-low" : "");
const deltaClass = (value) => (typeof value !== "number" ? "" : value > 0 ? "cell-up" : value < 0 ? "cell-down" : "");

function useSorted(rows, initialKey, initialDir = "desc") {
  const [sort, setSort] = useState({ key: initialKey, dir: initialDir });
  const sorted = useMemo(() => [...rows].sort((left, right) => {
    const a = left[sort.key];
    const b = right[sort.key];
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    const outcome = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "zh-CN");
    return sort.dir === "asc" ? outcome : -outcome;
  }), [rows, sort]);
  const toggle = (key) => setSort((current) => ({ key, dir: current.key === key && current.dir === "desc" ? "asc" : "desc" }));
  return { sorted, sort, toggle };
}

function SortTh({ label, sortKey, sort, onToggle }) {
  return <th className="sortable" onClick={() => onToggle(sortKey)}>{label}{sort.key === sortKey ? (sort.dir === "desc" ? " ↓" : " ↑") : ""}</th>;
}

function Pager({ total, page, onPage }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return <div className="pager"><span>共 {total} 条</span><button disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button><span>{page} / {pages}</span><button disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</button></div>;
}

export function Dashboard({ setToast }) {
  const [filters, setFilters] = useState(emptyFilters);
  const [applied, setApplied] = useState(() => emptyFilters());
  const [result, setResult] = useState(null);
  const [querying, setQuerying] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState("trend");
  const [brands, setBrands] = useState([]);
  const [regions, setRegions] = useState([]);
  const [stores, setStores] = useState([]);
  const [exportState, setExportState] = useState({ pending: false, jobId: null, status: "", downloadUrl: null });

  const patch = (key, value) => setFilters((current) => ({ ...current, [key]: value }));
  const cities = regions.filter((region) => Number(region.level) === 2);
  const districts = regions.filter((region) => Number(region.level) === 3 && region.parentId === filters.cityRegionId);

  const buildParams = (source) => {
    const params = new URLSearchParams({ from: source.from, to: source.to });
    for (const key of ["brandId", "cityRegionId", "regionId", "storeId"]) if (source[key]) params.set(key, source[key]);
    return params;
  };
  const query = async (source = filters) => {
    setQuerying(true);
    setError("");
    try {
      const data = await request(`${API.admin.dashboardStats}?${buildParams(source)}`, { schema: DashboardStatsSchema });
      setResult(data);
      setApplied(source);
    } catch (queryError) { setError(queryError.message); }
    finally { setQuerying(false); }
  };
  const reset = () => { const fresh = emptyFilters(); setFilters(fresh); query(fresh); };

  const exportStats = async () => {
    if (exportState.pending) return;
    setExportState({ pending: true, jobId: null, status: "正在创建导出任务…", downloadUrl: null });
    try {
      const source = applied;
      const dashboardFilters = { from: source.from, to: source.to };
      for (const key of ["brandId", "cityRegionId", "regionId", "storeId"]) if (source[key]) dashboardFilters[key] = source[key];
      const created = await request(API.admin.exports, { method: "POST", body: { kind: "dashboard", dashboardFilters } });
      setExportState({ pending: true, jobId: created.id, status: "生成中…", downloadUrl: null });
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await sleep(2000);
        const job = await request(API.admin.export(created.id), { schema: ExportRowSchema });
        if (job.status === "succeeded" && job.downloadUrl) {
          setExportState({ pending: false, jobId: created.id, status: "已生成", downloadUrl: job.downloadUrl });
          setToast("统计表已生成，已开始下载");
          window.open(job.downloadUrl, "_blank", "noopener");
          return;
        }
        if (job.status === "failed" || job.status === "expired") {
          setExportState({ pending: false, jobId: created.id, status: "导出失败", downloadUrl: null });
          setToast("导出失败，请调整筛选后重试", "error");
          return;
        }
      }
      setExportState({ pending: false, jobId: created.id, status: "仍在生成，可点击「刷新导出状态」重试", downloadUrl: null });
      setToast("导出任务仍在处理，请稍后点击「刷新导出状态」", "error");
    } catch (exportError) {
      setExportState({ pending: false, jobId: null, status: "", downloadUrl: null });
      setToast(exportError.message, "error");
    }
  };
  const recheckExport = async () => {
    if (!exportState.jobId || exportState.pending) return;
    setExportState((current) => ({ ...current, pending: true }));
    try {
      const job = await request(API.admin.export(exportState.jobId), { schema: ExportRowSchema });
      if (job.status === "succeeded" && job.downloadUrl) {
        setExportState({ pending: false, jobId: exportState.jobId, status: "已生成", downloadUrl: job.downloadUrl });
        window.open(job.downloadUrl, "_blank", "noopener");
        return;
      }
      setExportState({ pending: false, jobId: exportState.jobId, status: job.status === "failed" ? "导出失败" : "仍在生成，请稍后再试", downloadUrl: null });
    } catch (recheckError) { setToast(recheckError.message, "error"); setExportState((current) => ({ ...current, pending: false })); }
  };

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      request(API.admin.brands, { schema: ADMIN_LIST_SCHEMAS.brands }),
      request(API.admin.regions, { schema: listSchema(RegionRowSchema) }),
      request(`${API.admin.stores}?limit=100`, { schema: ADMIN_LIST_SCHEMAS.stores }),
    ]).then(([brandList, regionList, storeList]) => {
      if (!active) return;
      setBrands(brandList.status === "fulfilled" ? brandList.value.items : []);
      setRegions(regionList.status === "fulfilled" ? regionList.value.items.filter((region) => region.active && Number(region.level) >= 2) : []);
      setStores(storeList.status === "fulfilled" ? storeList.value.items : []);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => { query(); /* 初始加载：本月 */ }, []);

  const months = result?.months || [];
  const categories = result?.categories || [];
  const storeRows = useMemo(() => (result?.stores || []).map((row) => ({ storeId: row.storeId, name: row.storeName, overall: row.overall, submissions: row.submissions, ...Object.fromEntries(row.monthly.map((point) => [point.month, point.score])) })), [result]);
  const storeSort = useSorted(storeRows, "overall");
  const chartRows = useMemo(() => storeSort.sorted.map((row) => ({ name: row.storeName, overall: row.overall, ...Object.fromEntries(months.map((month) => [month, row[month]])) })), [storeSort.sorted, months]);
  const overallAverage = useMemo(() => {
    const scored = result?.stores?.filter((row) => row.submissions > 0) || [];
    return scored.length ? Math.round((scored.reduce((sum, row) => sum + row.overall, 0) / scored.length) * 100) / 100 : 0;
  }, [result]);
  const categoryRows = useMemo(() => (result?.storeCategories || []).map((row) => ({ storeId: row.storeId, name: row.storeName, overallRate: row.overallRate, ...Object.fromEntries(row.rates.map((cell) => [cell.category, cell.rate])) })), [result]);
  const categorySort = useSorted(categoryRows, "overallRate");
  const [categoryPage, setCategoryPage] = useState(1);
  const categoryPageRows = categorySort.sorted.slice((categoryPage - 1) * PAGE_SIZE, categoryPage * PAGE_SIZE);
  useEffect(() => { setCategoryPage(1); }, [result]);
  const questionRows = useMemo(() => (result?.questions || []).map((row) => ({ key: row.key, number: row.number, text: row.text, overallRate: row.overallRate, delta: row.delta, ...Object.fromEntries(row.monthly.map((point) => [point.month, point.rate])) })), [result]);
  const questionSort = useSorted(questionRows, "overallRate", "asc");
  const axisProps = { interval: 0, angle: -32, textAnchor: "end", height: 72, tick: { fontSize: 11 } };

  return <><PageHeader eyebrow="数据看板" title="数据看板" description="按提交时间统计已提交问卷的得分、门店与考核点表现；导出为 Excel 统计表。" action={
    <div className="table-actions">
      {exportState.downloadUrl && <a className="admin-secondary download-link" href={exportState.downloadUrl} target="_blank" rel="noopener">查看下载</a>}
      {/* 轮询超时后任务可能已完成：提供手动复查入口，复用 recheckExport 查询任务状态 */}
      {exportState.jobId && !exportState.pending && !exportState.downloadUrl && <button className="admin-secondary" onClick={recheckExport}>刷新导出状态</button>}
      <button className="admin-primary" disabled={exportState.pending || !result} onClick={exportStats}><DownloadSimple size={16} /> 导出 Excel{exportState.status ? `（${exportState.status}）` : ""}</button>
    </div>
  } />
    <section className="panel compact-panel dashboard-filters">
      <div className="filter-grid">
        <label className="admin-field"><span>开始日期</span><input type="date" value={filters.from} onChange={(event) => patch("from", event.target.value)} /></label>
        <label className="admin-field"><span>结束日期</span><input type="date" value={filters.to} onChange={(event) => patch("to", event.target.value)} /></label>
        <label className="admin-field"><span>品牌</span><select value={filters.brandId} onChange={(event) => patch("brandId", event.target.value)}><option value="">全部品牌</option>{brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></label>
        <label className="admin-field"><span>门店城市</span><select value={filters.cityRegionId} onChange={(event) => { patch("cityRegionId", event.target.value); patch("regionId", ""); }}><option value="">全部城市</option>{cities.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select></label>
        <label className="admin-field"><span>区域</span><select value={filters.regionId} disabled={!filters.cityRegionId} onChange={(event) => patch("regionId", event.target.value)}><option value="">全部区域</option>{districts.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select></label>
        <label className="admin-field"><span>门店</span><select value={filters.storeId} onChange={(event) => patch("storeId", event.target.value)}><option value="">全部门店</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
      </div>
      <div className="filter-actions">
        <button className="admin-primary" disabled={querying} onClick={() => query()}><Funnel size={15} /> 查询</button>
        <button className="admin-secondary" disabled={querying} onClick={reset}>清空筛选条件</button>
        {error && <span className="form-message">{error}</span>}
      </div>
    </section>
    <div className="dashboard-layout">
      <aside className="report-nav">{REPORTS.map((item) => <button key={item.id} className={report === item.id ? "is-active" : ""} onClick={() => setReport(item.id)}>{item.label}</button>)}</aside>
      <section className="report-main">
        {!result && !querying && !error && <StatePanel title="选择筛选条件后点击「查询」查看统计数据" />}
        {querying && <StatePanel title="正在统计…" />}
        {result && !querying && report === "trend" && <ReportCard title="得分趋势" subtitle={`${result.range.from} 至 ${result.range.to} · 按提交时间自然月`}>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={result.trend} margin={{ top: 24, right: 24, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="month" /><YAxis domain={[0, 100]} /><Tooltip /><Legend />
              <Line type="monotone" dataKey="score" name="得分" stroke="#0f766e" strokeWidth={2} dot={{ r: 4 }}><LabelList dataKey="score" position="top" /></Line>
            </LineChart>
          </ResponsiveContainer>
          <table className="data-table"><thead><tr><th>序号</th><th>时间维度</th><th>提交数</th><th>得分</th></tr></thead><tbody>
            {result.trend.map((point, index) => <tr key={point.month}><td>{index + 1}</td><td>{point.month}月</td><td>{point.submissions}</td><td className={lowClass(point.score)}>{point.score}</td></tr>)}
            {result.trend.length === 0 && <tr><td colSpan={4}>所选时间范围内没有提交记录</td></tr>}
          </tbody></table>
        </ReportCard>}
        {result && !querying && (report === "storeTrend" || report === "storeBar") && <ReportCard title={report === "storeTrend" ? "门店得分展示" : "门店单月得分展示"} subtitle={`${months.length} 个月 · ${storeRows.length} 家门店 · 红色虚线为总平均分`}>
          <ResponsiveContainer width="100%" height={360}>
            {report === "storeTrend"
              ? <LineChart data={chartRows} margin={{ top: 12, right: 24, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" {...axisProps} /><YAxis domain={[0, 100]} /><Tooltip /><Legend />
                {months.map((month, index) => <Line key={month} type="monotone" dataKey={month} name={`${month}月`} stroke={MONTH_COLORS[index % MONTH_COLORS.length]} dot={{ r: 2 }} />)}
                <ReferenceLine y={overallAverage} stroke="#dc2626" strokeDasharray="6 4" label={{ value: `总平均 ${overallAverage}`, position: "insideTopRight", fill: "#dc2626", fontSize: 12 }} />
              </LineChart>
              : <BarChart data={chartRows} margin={{ top: 12, right: 24, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" {...axisProps} /><YAxis domain={[0, 100]} /><Tooltip /><Legend />
                {months.map((month, index) => <Bar key={month} dataKey={month} name={`${month}月`} fill={MONTH_COLORS[index % MONTH_COLORS.length]} />)}
                <ReferenceLine y={overallAverage} stroke="#dc2626" strokeDasharray="6 4" />
              </BarChart>}
          </ResponsiveContainer>
          <table className="data-table"><thead><tr><th>序号</th><SortTh label="门店名称" sortKey="name" sort={storeSort.sort} onToggle={storeSort.toggle} /><SortTh label="提交数" sortKey="submissions" sort={storeSort.sort} onToggle={storeSort.toggle} /><SortTh label="平均得分" sortKey="overall" sort={storeSort.sort} onToggle={storeSort.toggle} />{months.map((month) => <SortTh key={month} label={`${month}月`} sortKey={month} sort={storeSort.sort} onToggle={storeSort.toggle} />)}</tr></thead><tbody>
            {storeSort.sorted.map((row, index) => <tr key={row.storeId}><td>{index + 1}</td><td>{row.name}</td><td>{row.submissions}</td><td>{row.overall}</td>{months.map((month) => <td key={month} className={lowClass(row[month])}>{row[month] ?? "—"}</td>)}</tr>)}
            {storeSort.sorted.length === 0 && <tr><td colSpan={4 + months.length}>所选时间范围内没有提交记录</td></tr>}
          </tbody></table>
        </ReportCard>}
        {result && !querying && report === "storeCategory" && <ReportCard title="门店大项得分率对比" subtitle={`${result.range.from} 至 ${result.range.to} · 列头点击排序 · 低于 80% 标红`}>
          <table className="data-table"><thead><tr><th>序号</th><SortTh label="门店名称" sortKey="name" sort={categorySort.sort} onToggle={categorySort.toggle} /><SortTh label="平均得分率" sortKey="overallRate" sort={categorySort.sort} onToggle={categorySort.toggle} />{categories.map((category) => <SortTh key={category.code} label={category.name} sortKey={category.code} sort={categorySort.sort} onToggle={categorySort.toggle} />)}</tr></thead><tbody>
            {categoryPageRows.map((row, index) => <tr key={row.storeId}><td>{(categoryPage - 1) * PAGE_SIZE + index + 1}</td><td>{row.name}</td><td>{row.overallRate}%</td>{categories.map((category) => <td key={category.code} className={lowClass(row[category.code])}>{row[category.code] == null ? "—" : `${row[category.code]}%`}</td>)}</tr>)}
            {categorySort.sorted.length === 0 && <tr><td colSpan={3 + categories.length}>所选时间范围内没有提交记录</td></tr>}
          </tbody></table>
          <Pager total={categorySort.sorted.length} page={categoryPage} onPage={setCategoryPage} />
        </ReportCard>}
        {result && !querying && report === "questions" && <ReportCard title="考核点整体得分率展示" subtitle={`${result.range.from} 至 ${result.range.to} · 按平均得分率升序（薄弱考核点优先）`}>
          <table className="data-table"><thead><tr><th>序号</th><SortTh label="考核点" sortKey="text" sort={questionSort.sort} onToggle={questionSort.toggle} /><th>考核点序号</th><SortTh label="平均得分率" sortKey="overallRate" sort={questionSort.sort} onToggle={questionSort.toggle} />{months.map((month) => <SortTh key={month} label={`${month}月`} sortKey={month} sort={questionSort.sort} onToggle={questionSort.toggle} />)}<SortTh label="差值" sortKey="delta" sort={questionSort.sort} onToggle={questionSort.toggle} /></tr></thead><tbody>
            {questionSort.sorted.map((row, index) => <tr key={`${row.number}|${row.text}`}><td>{index + 1}</td><td className="question-text-cell">{row.text}</td><td>{row.key}</td><td>{row.overallRate}%</td>{months.map((month) => <td key={month}>{row[month] == null ? "—" : `${row[month]}%`}</td>)}<td className={deltaClass(row.delta)}>{row.delta == null ? "—" : `${row.delta > 0 ? "+" : ""}${row.delta}%`}</td></tr>)}
            {questionSort.sorted.length === 0 && <tr><td colSpan={5 + months.length}>所选时间范围内没有提交记录</td></tr>}
          </tbody></table>
        </ReportCard>}
      </section>
    </div></>;
}

function ReportCard({ title, subtitle, children }) {
  return <section className="panel report-card"><div className="panel-heading"><div><h2>{title}</h2><small>{subtitle}</small></div></div>{children}</section>;
}

function StatePanel({ title }) {
  return <section className="panel empty-business"><strong>{title}</strong></section>;
}
