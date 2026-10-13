// TaskPage — task 任务详情（inventory §1.6；rules R25-R30 定位采集/签到判定/阶段机/不可开始态/继续填写/加载）。
// 语义真源：apps/miniapp/miniprogram/pages/task/index.js（110 行）逐函数移植。
// PM 钉定 Web 适配点：
// 1) onLoad ≈ 组件挂载时解析 hash 路由查询参数 assignmentId；onUnload ≈ useEffect cleanup（unloaded 防护）。
// 2) 定位采集经 adapters/location.getCurrentLocation()（浏览器 geolocation → GCJ02，R25 语义不变，
//    capturedAt 在页面侧以新 ISO 时间组装）。
// 4) wx.showModal 确认类 → window.confirm；wx.openSetting → 浏览器站点设置引导 toast（适配点 5）。
// 6) kind=session 的 BusinessError → redirectToLogin()（PM 适配点 6）。
import React, { useEffect, useRef, useState } from "react";
import {
  Button, Card, ErrorState, Muted, PageNav, SectionHeading, Skeleton, StatusBadge,
} from "../design/components.jsx";
import { useApp } from "./app-context.jsx";
import { checkIn, getAssignment, startAssignment } from "../services/assignments.js";
import { getCurrentLocation } from "../adapters/location.js";
import { navEntryIsPage, sanitizeTaskSource } from "../router/nav-history.js";
import {
  formatBudgetLabel, formatSubmittedAt, formatTimeRange, mapAssignmentStatus,
} from "../utils/presentation.js";

// 开始流程阶段文案（等价 miniapp PHASE_TEXT，js:4-9）。
const PHASE_TEXT = {
  locating: "正在获取现场位置…",
  checking_in: "正在核对是否到达门店…",
  starting: "位置已通过，正在创建问卷…",
  navigating: "问卷已准备好，正在打开…",
};
// 活动阶段（R27）：四阶段内禁止重入开始。
const ACTIVE_PHASES = ["locating", "checking_in", "starting", "navigating"];

// 签到结果文案映射（R26，六态逐字对齐 miniapp js:12-20；判定在服务端，客户端不计算半径）。
function checkinMessage(result) {
  return ({
    accepted: "现场位置已通过",
    outside_radius: "当前距离门店较远，请到店后重试",
    stale: "定位结果已过期，请重新定位",
    low_accuracy: "定位精度不足，请移动到较开阔位置后重试",
    rejected: "当前位置未通过，请重新定位",
  })[result] || "暂时无法确认位置，请稍后重试";
}

// hash 路由查询参数（Web 适配：页面自读，等价 miniapp onLoad(options)）。
function routeQuery() {
  const raw = String((typeof window !== "undefined" ? window.location.hash : "") || "").replace(/^#/, "");
  return new URLSearchParams(raw.split("?")[1] || "");
}

export function TaskPage() {
  const { back, navigate, toast, redirectToLogin } = useApp();
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadSlow, setLoadSlow] = useState(false);
  const [error, setError] = useState("");
  const [errorBlocking, setErrorBlocking] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [phase, setPhase] = useState("idle");
  const [phaseText, setPhaseText] = useState("开始时将重新定位");
  const [startFailed, setStartFailed] = useState("");
  const [navigating, setNavigating] = useState(false);
  // 异步闭包内读取最新值（phase/task 用同步镜像 ref）；unloaded 后异步回调不再写状态（R30）。
  const assignmentIdRef = useRef("");
  // 返回起点（?source=，白名单 home/schedule；缺省/非法 → schedule）：
  // 从首页进入返回首页、从日程进入返回日程，刷新后随 URL 保留。
  const sourceRef = useRef("schedule");
  const [originLabel, setOriginLabel] = useState("返回日程");
  const taskRef = useRef(null);
  const phaseRef = useRef("idle");
  const navigatingRef = useRef(false);
  const retryingRef = useRef(false);
  const loadingRef = useRef(true);
  const slowTimerRef = useRef(null);
  const unloadedRef = useRef(false);

  const putPhase = (value) => { phaseRef.current = value; setPhase(value); };

  // 展示字段只在 JS 生成（§1.6 c：新字段归一，js:48-57 逐项对齐）。
  const normalizeTask = (raw) => ({
    ...raw,
    submittedAtLabel: raw.submittedAt ? formatSubmittedAt(raw.submittedAt) : "",
    statusLabel: mapAssignmentStatus(raw.status).statusText,
    address: raw.storeAddress || "",
    windowLabel: formatTimeRange(raw.startsAt, raw.dueAt),
    budgetLabel: formatBudgetLabel(raw.budgetLimitCents),
    dishRequirements: Array.isArray(raw.dishRequirements) ? raw.dishRequirements : [],
    specialInstruction: raw.specialInstruction || "",
  });

  const load = async (id) => {
    if (!unloadedRef.current) {
      setLoading(true);
      loadingRef.current = true;
      setError("");
      setErrorBlocking(false);
      setLoadSlow(false);
    }
    try {
      const raw = await getAssignment(id);
      if (unloadedRef.current) return;
      const normalized = normalizeTask(raw);
      taskRef.current = normalized;
      setTask(normalized);
    } catch (loadError) {
      if (unloadedRef.current) return;
      // PM 适配点 6：401（kind=session）统一跳登录。
      if (loadError?.kind === "session") {
        toast(loadError.message);
        redirectToLogin();
        return;
      }
      setError(loadError?.message || "暂时无法打开任务");
      setErrorBlocking(!taskRef.current); // 有内容 → 非阻塞；无内容 → 阻断错误卡
    } finally {
      if (!unloadedRef.current) {
        setLoading(false);
        loadingRef.current = false;
        setRetrying(false);
        retryingRef.current = false;
      }
    }
  };

  // onLoad 等价：assignmentId 缺失 → 阻断错误「未找到对应任务，请从日程重新进入」（R30）。
  useEffect(() => {
    // StrictMode 双挂载：重挂载恢复 false；真实卸载仍由 cleanup 置 true。
    unloadedRef.current = false;
    const params = routeQuery();
    const id = params.get("assignmentId") || "";
    // 来源白名单化：非法值落回日程，绝不把用户带出应用。
    const source = sanitizeTaskSource(params.get("source") || "");
    sourceRef.current = source;
    setOriginLabel(source === "home" ? "返回首页" : "返回日程");
    if (!id) {
      setLoading(false);
      loadingRef.current = false;
      setError("未找到对应任务，请从日程重新进入");
      setErrorBlocking(true);
      return () => { unloadedRef.current = true; };
    }
    assignmentIdRef.current = id;
    // 加载超过 800ms 才提示，避免瞬间闪烁（R30 慢加载提示）。
    slowTimerRef.current = setTimeout(() => {
      if (!unloadedRef.current && loadingRef.current) setLoadSlow(true);
    }, 800);
    load(id);
    return () => {
      // onUnload 等价：卸载后异步回调不再 setState（R27/R30）。
      unloadedRef.current = true;
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current);
        slowTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retry = () => {
    if (retryingRef.current || !assignmentIdRef.current) return; // 防重；无 id 不发无效请求
    retryingRef.current = true;
    setRetrying(true);
    load(assignmentIdRef.current);
  };

  // 返回业务起点（首页或日程，随 ?source=）：上一条应用内历史确为该起点才原生后退
  // （不产生 bounce 条目，浏览器后退链保持 home→task→home 一致）；否则 replace 兜底。
  const backToOrigin = () => {
    const originPath = sourceRef.current === "home" ? "/home" : "/schedule";
    back(originPath, (previous) => navEntryIsPage(previous, originPath));
  };

  // openSurvey（等价 miniapp navigateTo，4 参 + source）：压栈保留任务为问卷的父页
  // （replace 会抹掉任务条目，浏览器后退会跳过任务详情）。source 不参与草稿身份与 API 契约。
  const openSurvey = (meta) => {
    navigate(`/survey?assignmentId=${encodeURIComponent(meta.assignmentId)}&attemptId=${encodeURIComponent(meta.attemptId)}&questionnaireVersionId=${encodeURIComponent(meta.questionnaireVersionId)}&revision=${meta.revision}&source=${sourceRef.current}`);
  };

  // 继续填写（R29）：有 attempt 直接带参进问卷，跳过打卡；navigating 防重。
  // 聚合状态滞后窗口：attempt 已 submitted 时不导航，toast 后单次重拉聚合显示终态卡（无轮询）。
  const continueDraft = () => {
    const current = taskRef.current;
    if (!current?.attempt?.id || navigatingRef.current) return;
    if (current.attempt?.status === "submitted") {
      toast("该任务已提交");
      load(assignmentIdRef.current);
      return;
    }
    navigatingRef.current = true;
    setNavigating(true);
    openSurvey({
      assignmentId: assignmentIdRef.current,
      attemptId: current.attempt.id,
      questionnaireVersionId: current.questionnaireVersion.id,
      revision: current.attempt.revision,
    });
  };

  // 开始流程（R25/R26/R27/R28）：阶段严格 locating → checking_in → starting → navigating；
  // 每阶段只有一次活动请求；submitted/overdue/cancelled 直接返回不发起定位。
  const start = async () => {
    // phaseRef/taskRef 为同步镜像：同帧连点也走不到重入分支（R27）。
    if (ACTIVE_PHASES.includes(phaseRef.current) || navigatingRef.current) return;
    if (["submitted", "overdue", "cancelled"].includes(taskRef.current?.status)) return;
    putPhase("locating");
    setPhaseText(PHASE_TEXT.locating);
    setStartFailed("");
    // 阶段 1：定位采集（失败 → failed + 「需要位置权限」确认 + 浏览器站点设置引导）。
    let location;
    try {
      location = await getCurrentLocation();
    } catch {
      if (unloadedRef.current) return;
      putPhase("failed");
      setStartFailed("未能获取位置，请检查定位权限后重试");
      // PM 适配点 4/5：wx.showModal 确认 → window.confirm；打开设置 → 站点设置引导 toast。
      if (typeof window !== "undefined" && window.confirm("需要位置权限\n\n你仍可查看任务说明，但开始探店需要获取最新位置。")) {
        toast("请在浏览器地址栏旁的站点设置中重新允许定位，然后返回重试。");
      }
      return;
    }
    if (unloadedRef.current) return;
    // 阶段 2：check-in（capturedAt = 新 ISO 时间，R25；判定在服务端，R26）。
    putPhase("checking_in");
    setPhaseText(PHASE_TEXT.checking_in);
    try {
      const observation = {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy,
        capturedAt: new Date().toISOString(),
      };
      const result = await checkIn(assignmentIdRef.current, observation);
      if (unloadedRef.current) return;
      if (result.result !== "accepted") {
        putPhase("failed");
        setStartFailed(checkinMessage(result.result));
        return;
      }
      // 阶段 3：start。
      putPhase("starting");
      setPhaseText(PHASE_TEXT.starting);
      const started = await startAssignment(assignmentIdRef.current);
      if (unloadedRef.current) return;
      // 阶段 4：navigating → redirectTo 问卷（attempt 来自 start 响应）。
      putPhase("navigating");
      setPhaseText(PHASE_TEXT.navigating);
      openSurvey({
        assignmentId: assignmentIdRef.current,
        attemptId: started.attempt.id,
        questionnaireVersionId: started.questionnaireVersion.id,
        revision: started.attempt.revision,
      });
    } catch (startError) {
      if (unloadedRef.current) return;
      if (startError?.kind === "session") {
        toast(startError.message);
        redirectToLogin();
        return;
      }
      putPhase("failed");
      setStartFailed(startError?.message || "暂时无法确认位置，请稍后重试");
      toast(startError?.message || "暂时无法确认位置，请稍后重试");
    }
  };

  const viewState = loading ? "loading" : errorBlocking ? "error" : task ? "ready" : "loading";
  const activeStart = phase !== "idle" && phase !== "failed";

  return (
    <div className="app-page app-page--flat" data-page="task" data-state={viewState} data-phase={phase}>
      <PageNav title="任务详情" onBack={backToOrigin} />

      {loading ? (
        /* 首载骨架 + 800ms 慢提示（§1.6 a.1 / R30） */
        <>
          <Card><Skeleton variant="line short" /><Skeleton variant="line mid" /><Skeleton variant="line" /></Card>
          <Card><Skeleton variant="line short" /><Skeleton variant="line" /><Skeleton variant="line mid" /></Card>
          {loadSlow ? <div style={{ marginTop: 8, textAlign: "center", fontSize: 13, color: "#70747b" }}>正在读取任务详情…</div> : null}
        </>
      ) : errorBlocking ? (
        /* 加载错误（无内容，§1.6 a.2） */
        <Card>
          <ErrorState
            title="暂时无法打开任务"
            message={error}
            onRetry={retry}
            retryLabel="重新加载"
            secondary={<Button variant="link" onClick={backToOrigin}>{originLabel}</Button>}
          />
        </Card>
      ) : task ? (
        <>
          <TaskDetailBody task={task} />

          {/* 门控分支互斥，优先级 submitted > cancelled > overdue > overt > 开始区（R28） */}
          {task.status === "submitted" ? (
            <Card>
              <div style={{ fontWeight: 700 }}>任务已提交</div>
              <div style={{ marginTop: 6 }}><Muted>提交时间：{task.submittedAtLabel}</Muted></div>
              <div style={{ marginTop: 2 }}><Muted>提交后不能回看答案、菜品、说明或证据。</Muted></div>
            </Card>
          ) : task.status === "cancelled" ? (
            <Card>
              <div style={{ fontWeight: 700 }}>任务已取消</div>
              {task.cancelReason ? (
                <div style={{ marginTop: 6 }}><Muted>取消原因：{task.cancelReason}</Muted></div>
              ) : (
                <div style={{ marginTop: 6 }}><Muted>如需恢复执行，请联系管理员。</Muted></div>
              )}
              <div style={{ marginTop: 12 }}>
                <Button variant="outline" block onClick={backToOrigin}>{originLabel}</Button>
              </div>
            </Card>
          ) : task.status === "overdue" ? (
            <Card>
              <div style={{ fontWeight: 700 }}>任务已逾期</div>
              <div style={{ marginTop: 12 }}>
                <Button variant="outline" block onClick={backToOrigin}>{originLabel}</Button>
              </div>
            </Card>
          ) : task.taskType === "overt" ? (
            <Card><Muted>明察任务暂未启用，当前不能开始。</Muted></Card>
          ) : (
            /* 开始流程区（§1.6 a.11 / R27） */
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ fontSize: 13, color: phase === "failed" ? "#d0452f" : "#70747b" }}>
                {phase === "failed" ? startFailed : phaseText}
              </div>
              {task.attempt ? (
                <Button block variant="secondary" disabled={navigating} onClick={continueDraft}>
                  {navigating ? "正在打开…" : "继续填写"}
                </Button>
              ) : null}
              <Button block disabled={activeStart || navigating} onClick={start}>
                {phase === "failed" ? "重新尝试开始" : phase === "idle" ? "开始探店" : phaseText}
              </Button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

// 任务 Hero + 本次要求 + 菜品要求 + 特别提示（§1.6 a.3-6，所有状态共用）。
function TaskDetailBody({ task }) {
  const badgeTone = task.status === "overdue"
    ? "warning"
    : task.status === "submitted"
      ? "neutral"
      : task.status === "cancelled"
        ? "muted"
        : "primary";
  return (
    <>
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StatusBadge tone={badgeTone}>{task.statusLabel}</StatusBadge>
          {/* 文案对齐小程序 wxml:30：secret → 暗访，其余 → 明察 */}
          <Muted>{task.taskType === "secret" ? "暗访" : "明察"}</Muted>
        </div>
        <div style={{ marginTop: 8, fontSize: 17, fontWeight: 700 }}>{task.storeName}</div>
        {task.address ? <div style={{ marginTop: 4, fontSize: 13, color: "#70747b" }}>{task.address}</div> : null}
        <div style={{ marginTop: 8, fontSize: 13 }}>{task.windowLabel}</div>
      </Card>
      <Card>
        <SectionHeading>本次要求</SectionHeading>
        <div style={{ display: "grid", gap: 4, marginTop: 6, fontSize: 13 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <Muted>问卷</Muted><span>{task.questionnaireVersion?.name || ""}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <Muted>预算</Muted><span>{task.budgetLabel}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <Muted>任务状态</Muted><span>{task.statusLabel}</span>
          </div>
        </div>
      </Card>
      <Card>
        <SectionHeading>菜品要求</SectionHeading>
        {task.dishRequirements.length === 0 ? (
          <div style={{ marginTop: 6 }}><Muted>本次没有指定菜品。</Muted></div>
        ) : (
          <ul style={{ margin: "6px 0 0", paddingInlineStart: 18, fontSize: 13, lineHeight: 2 }}>
            {task.dishRequirements.map((dish, index) => (
              <li key={dish.id ?? index}>
                {dish.plannedName} × {dish.quantity}（{dish.required ? "必点" : "建议"}）
              </li>
            ))}
          </ul>
        )}
      </Card>
      {task.specialInstruction ? <div className="notice-bar">{task.specialInstruction}</div> : null}
    </>
  );
}
