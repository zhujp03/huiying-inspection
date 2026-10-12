// HomePage — home 首页（tab，inventory §1.3；rules R94 下一任务与草稿进度 / R89 兜底文案）。
// 语义真源：apps/miniapp/miniprogram/pages/home/index.js（74 行）逐函数移植。
// PM 钉定 Web 适配点 1：onShow ≈ hash 路由进入本页时组件挂载（R02 守卫由 App 壳承担）。
// PM 钉定 Web 适配点 6：kind=session 的 BusinessError → redirectToLogin()（运输层 401 已清会话，R05）。
import React, { useEffect, useRef, useState } from "react";
import {
  Button, Card, EmptyState, ErrorBar, ErrorState, Muted, SectionHeading, Skeleton, StatusBadge,
} from "../design/components.jsx";
import { useApp } from "./app-context.jsx";
import { getMyAssignments } from "../services/assignments.js";
import { getDraft } from "../store/survey.js";
import { projectAssignmentForDisplay } from "../utils/presentation.js";

// 本地草稿答题进度（R94）：hasAttempt/attempt/questionnaireVersion 任一缺失 → 空串；
// 只统计与当前 revision 匹配的草稿；读取失败静默忽略，不影响首页展示。
function draftProgressOf(assignment) {
  if (!assignment?.hasAttempt || !assignment?.attempt || !assignment?.questionnaireVersion) return "";
  try {
    const draft = getDraft({
      assignmentId: assignment.id,
      attemptId: assignment.attempt.id,
      questionnaireVersionId: assignment.questionnaireVersion.id,
      revision: assignment.attempt.revision,
    });
    const answered = draft?.answers ? Object.keys(draft.answers).length : 0;
    if (answered <= 0) return "";
    const total = Number(assignment.questionnaireVersion.questionCount) || 0;
    return total > 0 ? `已完成 ${Math.min(answered, total)} / ${total} 题` : `已答 ${answered} 题`;
  } catch { return ""; }
}

// 下一项可执行任务（R94）：仅 assigned/in_progress；in_progress 优先；同级按 dueAt 升序；
// overdue/submitted/cancelled 不作为「下一项」。
function pickNextExecutable(items) {
  const executable = items
    .filter((item) => ["assigned", "in_progress"].includes(item.status))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "in_progress" ? -1 : 1;
      return new Date(a.dueAt) - new Date(b.dueAt);
    });
  if (!executable[0]) return null;
  const task = projectAssignmentForDisplay(executable[0]);
  const draftProgressText = draftProgressOf(executable[0]);
  return draftProgressText ? { ...task, draftProgressText } : task;
}

export function HomePage() {
  const { navigate, toast, redirectToLogin } = useApp();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [task, setTask] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [counts, setCounts] = useState({ assigned: 0, inProgress: 0, overdue: 0 });
  // 异步闭包内读取最新值（等价 miniapp this.data）；卸载后不再写状态。
  const taskRef = useRef(null);
  const refreshingRef = useRef(false);
  const navigatingRef = useRef(false);
  const unloadedRef = useRef(false);

  // StrictMode 双挂载：重挂载恢复 false；真实卸载仍由 cleanup 置 true。
  useEffect(() => { unloadedRef.current = false; return () => { unloadedRef.current = true; }; }, []);

  const putTask = (value) => {
    taskRef.current = value;
    setTask(value);
  };

  const load = async () => {
    // 首次加载显示骨架；已有内容时后台刷新不清空页面（R94）。
    if (!unloadedRef.current) {
      setLoading(!taskRef.current);
      setError("");
    }
    try {
      const items = await getMyAssignments();
      if (unloadedRef.current) return;
      putTask(pickNextExecutable(items));
      setCounts({
        assigned: items.filter((item) => item.status === "assigned").length,
        inProgress: items.filter((item) => item.status === "in_progress").length,
        overdue: items.filter((item) => item.status === "overdue").length,
      });
    } catch (loadError) {
      if (unloadedRef.current) return;
      // PM 适配点 6：401（kind=session）统一跳登录；业务/网络错误自带中文文案，
      // 无 kind 的未预期前端异常换兜底文案，不把英文开发错误展示给探店员（R89）。
      if (loadError?.kind === "session") {
        toast(loadError.message);
        redirectToLogin();
        return;
      }
      setError(loadError?.kind ? loadError.message : "暂时无法加载任务，请重试");
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

  const retry = () => {
    if (refreshingRef.current) return; // 防重
    refreshingRef.current = true;
    setRefreshing(true);
    load();
  };

  const goTask = () => {
    if (navigatingRef.current || !taskRef.current) return; // 防重复跳转
    navigatingRef.current = true;
    setNavigating(true);
    navigate(`/task?assignmentId=${encodeURIComponent(taskRef.current.id)}`); // 成功即整页切换（组件卸载，navigating 随之消亡）
  };

  const goSchedule = () => navigate("/schedule");

  const viewState = loading ? "loading" : error && !task ? "error" : task ? "ready" : "empty";

  return (
    <div className="app-page" data-page="home" data-state={viewState}>
      {/* 主色 Hero 标题区（§1.3 a.1） */}
      <div className="card" style={{ background: "#26272a", color: "#fff", display: "flex", flexDirection: "column", justifyContent: "center", minHeight: 90, padding: "20px 16px" }}>
        <span style={{ fontSize: 20, fontWeight: 700 }}>汇盈探店</span>
        <span style={{ marginTop: 4, fontSize: 12, color: "#c8c9cc" }}>探店员工作台</span>
      </div>

      {/* 错误且无内容 → 完整错误卡；首载 → 骨架；空任务 → 空态卡；有任务 → 大卡（§1.3 a.2-4） */}
      {error && !task ? (
        <Card>
          <ErrorState title="暂时无法加载任务" message={error} onRetry={retry} />
        </Card>
      ) : loading ? (
        <Card>
          <Skeleton variant="tag" />
          <Skeleton variant="line short" />
          <Skeleton variant="line mid" />
          <Skeleton variant="line" />
          <Skeleton variant="btn" />
        </Card>
      ) : !task ? (
        <Card>
          <EmptyState title="当前没有待执行任务" action={<Button variant="outline" onClick={goSchedule}>查看全部日程</Button>} />
        </Card>
      ) : (
        <Card onClick={goTask} style={{ cursor: "pointer" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <StatusBadge tone={task.statusTone}>{task.statusText}</StatusBadge>
            <Muted>{task.taskTypeText}</Muted>
          </div>
          <div style={{ marginTop: 8, fontSize: 16, fontWeight: 700 }}>{task.storeName}</div>
          <div style={{ marginTop: 2, fontSize: 13, color: "#70747b" }}>{task.name}</div>
          <div style={{ marginTop: 8, fontSize: 13 }}>{task.displayDate} {task.displayTime}</div>
          {task.draftProgressText ? <div style={{ marginTop: 4, fontSize: 13, color: "#f25f42" }}>{task.draftProgressText}</div> : null}
          <div style={{ marginTop: 12 }}>
            <Button small disabled={navigating} onClick={goTask}>{navigating ? "正在打开…" : task.actionText}</Button>
          </div>
        </Card>
      )}

      {/* 刷新失败但已有内容 → 非阻塞错误条（§1.3 a.6） */}
      {error && task ? <ErrorBar message={error} onRetry={retry} /> : null}

      {/* 执行提醒卡（§1.3 a.7，文案对齐小程序 wxml:50-54） */}
      <Card>
        <SectionHeading>执行提醒</SectionHeading>
        <div style={{ display: "grid", gap: 2, marginTop: 6 }}>
          <Muted>保持普通顾客身份</Muted>
          <Muted>到店后重新定位</Muted>
        </div>
      </Card>

      {/* 三格只读统计（§1.3 a.8，标签对齐小程序 wxml:57-61） */}
      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", textAlign: "center" }}>
          <div><div style={{ fontSize: 20, fontWeight: 700 }}>{counts.assigned}</div><Muted>待开始</Muted></div>
          <div><div style={{ fontSize: 20, fontWeight: 700 }}>{counts.inProgress}</div><Muted>进行中</Muted></div>
          <div><div style={{ fontSize: 20, fontWeight: 700 }}>{counts.overdue}</div><Muted>逾期</Muted></div>
        </div>
      </Card>
    </div>
  );
}
