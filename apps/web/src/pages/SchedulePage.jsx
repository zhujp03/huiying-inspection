// SchedulePage — schedule 日程（tab，inventory §1.4；rules R95 筛选与加载降级 / R09 force 缓存）。
// 语义真源：apps/miniapp/miniprogram/pages/schedule/index.js（72 行）逐函数移植。
// PM 钉定 Web 适配点 1：onShow ≈ hash 路由进入本页时组件挂载（R02 守卫由 App 壳承担）。
// 小程序下拉刷新（onPullDownRefresh + stopPullDownRefresh）无 Web 对应物：
// 其 force 语义由「重新加载」重试按钮完全承接（getMyAssignments({ force: true }) 绕过 15s 缓存）。
import React, { useEffect, useRef, useState } from "react";
import {
  Button, Card, EmptyState, ErrorBar, ErrorState, Muted, Skeleton, StatusBadge,
} from "../design/components.jsx";
import { useApp } from "./app-context.jsx";
import { getMyAssignments } from "../services/assignments.js";
import { groupAssignmentsByDate } from "../utils/presentation.js";

// 状态筛选（承接原问卷入口页的分段视图）：全部 chip 固定出现，四种状态 chip 仅 count>0 时出现。
const STATUS_FILTERS = [
  { value: "assigned", label: "待开始" },
  { value: "in_progress", label: "进行中" },
  { value: "overdue", label: "已逾期" },
  { value: "submitted", label: "已提交" },
];

export function SchedulePage() {
  const { navigate, toast, redirectToLogin } = useApp();
  const [groups, setGroups] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [chips, setChips] = useState([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [errorBlocking, setErrorBlocking] = useState(false);
  const [navigatingId, setNavigatingId] = useState("");
  // 异步闭包内读取最新值（等价 miniapp this.data）。
  const groupsRef = useRef([]);
  const statusFilterRef = useRef("");
  const allItemsRef = useRef([]);
  const refreshingRef = useRef(false);
  const navigatingIdRef = useRef("");
  const unloadedRef = useRef(false);

  // StrictMode 双挂载：重挂载恢复 false；真实卸载仍由 cleanup 置 true。
  useEffect(() => { unloadedRef.current = false; return () => { unloadedRef.current = true; }; }, []);

  // 仅按状态过滤本地数据，不重新请求（R95）。
  const applyFilter = (filter) => {
    const items = allItemsRef.current;
    const counts = {};
    for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
    const nextChips = [{ value: "", label: "全部", count: items.length, active: !filter }]
      .concat(
        STATUS_FILTERS
          .filter((entry) => (counts[entry.value] || 0) > 0)
          .map((entry) => ({ ...entry, count: counts[entry.value], active: filter === entry.value })),
      );
    const visible = filter ? items.filter((item) => item.status === filter) : items;
    const nextGroups = groupAssignmentsByDate(visible);
    groupsRef.current = nextGroups;
    setChips(nextChips);
    setGroups(nextGroups);
    setTotalCount(visible.length);
  };

  const load = async ({ force = false } = {}) => {
    // 首次加载才显示骨架；已有内容时后台刷新保留旧内容（R95 加载降级）。
    const hasContent = groupsRef.current.length > 0;
    if (!unloadedRef.current) {
      setLoading(!hasContent);
      setRefreshing(force);
      setError("");
      setErrorBlocking(false);
    }
    try {
      const items = await getMyAssignments({ force });
      if (unloadedRef.current) return;
      allItemsRef.current = items;
      applyFilter(statusFilterRef.current);
    } catch (loadError) {
      if (unloadedRef.current) return;
      // PM 适配点 6：401（kind=session）统一跳登录；无 kind 的未预期异常换兜底文案（R89）。
      if (loadError?.kind === "session") {
        toast(loadError.message);
        redirectToLogin();
        return;
      }
      // 有旧内容 → 非阻塞错误条；无内容 → 完整错误态。
      setError(loadError?.kind ? loadError.message : "暂时无法加载任务，请重试");
      setErrorBlocking(!hasContent);
    } finally {
      if (!unloadedRef.current) {
        setLoading(false);
        setRefreshing(false);
        refreshingRef.current = false;
      }
    }
  };

  // onShow 等价：进入本页即加载。
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 值变化才处理；重复点击当前筛选忽略（纯本地过滤）。
  const filterStatus = (value) => {
    const next = value || "";
    if (next === statusFilterRef.current) return;
    statusFilterRef.current = next;
    setStatusFilter(next);
    applyFilter(next);
  };

  const retry = () => {
    if (refreshingRef.current) return; // 防重
    refreshingRef.current = true;
    load({ force: true }); // 等价下拉刷新：force 绕过 15 秒缓存（R09/R95）
  };

  const goTask = (id) => {
    if (navigatingIdRef.current) return; // 防重复：跳转期间禁止再次触发
    navigatingIdRef.current = id;
    setNavigatingId(id);
    navigate(`/task?assignmentId=${encodeURIComponent(id)}&source=schedule`); // 成功即整页切换（卡片文案「正在打开…」由 navigatingId 驱动）
  };

  const viewState = loading ? "loading" : errorBlocking ? "error" : groups.length === 0 ? "empty" : "ready";

  return (
    <div className="app-page" data-page="schedule" data-state={viewState}>
      {/* 标题 + 总数（§1.4 a.1） */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 20, fontWeight: 700 }}>我的日程</span>
        <Muted>{totalCount} 项任务</Muted>
      </div>

      {/* 状态筛选 chips：仅多于一个 chip 时显示（§1.4 a.2 / R95） */}
      {chips.length > 1 ? (
        <div className="filter-chips">
          {chips.map((chip) => (
            <button
              key={chip.value}
              type="button"
              className={`chip ${chip.active ? "chip--active" : ""}`}
              onClick={() => filterStatus(chip.value)}
            >
              {chip.label} {chip.count}
            </button>
          ))}
        </div>
      ) : null}

      {/* 非阻塞错误条（已有内容时保留内容，§1.4 a.3） */}
      {error && !errorBlocking ? <ErrorBar message={error} onRetry={retry} /> : null}

      {loading ? (
        /* 首载骨架（§1.4 a.4） */
        <>
          <Skeleton variant="date" />
          <Card><Skeleton variant="line short" /><Skeleton variant="line mid" /><Skeleton variant="line" /></Card>
          <Skeleton variant="date" />
          <Card><Skeleton variant="line short" /><Skeleton variant="line mid" /><Skeleton variant="line" /></Card>
        </>
      ) : errorBlocking ? (
        /* 完整错误态（无内容，§1.4 a.5） */
        <Card>
          <ErrorState title="暂时无法加载日程" message={error} onRetry={retry} />
        </Card>
      ) : groups.length === 0 ? (
        /* 空态：区分「当前筛选下没有任务」与「当前没有已分配任务」（R95） */
        <Card>
          <EmptyState title={statusFilter ? "当前筛选下没有任务" : "当前没有已分配任务"} />
          {statusFilter ? (
            <div style={{ marginTop: 12 }}>
              <Button variant="outline" small onClick={() => filterStatus("")}>查看全部任务</Button>
            </div>
          ) : null}
        </Card>
      ) : (
        /* 按日期分组的任务卡列表（§1.4 a.7 / R93 投影字段） */
        groups.map((group) => (
          <section key={group.dateHeading}>
            <span style={{ display: "block", margin: "12px 2px 8px", fontSize: 14, fontWeight: 700 }}>{group.dateHeading}</span>
            {group.items.map((item) => (
              <Card key={item.id} onClick={() => goTask(item.id)} style={{ cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <StatusBadge tone={item.statusTone}>{item.statusText}</StatusBadge>
                  <Muted>{item.taskTypeText}</Muted>
                </div>
                <div style={{ marginTop: 8, fontSize: 16, fontWeight: 700 }}>{item.storeName}</div>
                <div style={{ marginTop: 2, fontSize: 13, color: "#70747b" }}>{item.name}</div>
                <div style={{ marginTop: 8, fontSize: 13 }}>
                  {item.displayDate} {item.displayTime}
                  {item.displayDueDate ? <span> · 截止 {item.displayDueDate}</span> : null}
                </div>
                <div style={{ marginTop: 10, color: "#f25f42", fontSize: 13, fontWeight: 600 }}>
                  {navigatingId === item.id ? "正在打开…" : item.actionText}
                </div>
              </Card>
            ))}
          </section>
        ))
      )}
    </div>
  );
}
