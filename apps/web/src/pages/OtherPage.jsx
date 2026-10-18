// OtherPage — other 其他记录与提交·第三步（inventory §1.10；rules R31/R32/R76-R85）。
// 语义真源：apps/miniapp/miniprogram/pages/other/index.js 逐函数移植。
// 2026-10 变更：闪光点编辑移至第二步（dishes 其他照片页），本页只保留「其他建议」与提交；
// 提交前的不可逆确认改为应用内自定义弹窗（不再 window.confirm），展示当前问卷得分百分比
// 与「问卷提交后无法再次修改」警示；取消关闭弹窗并保留全部编辑。
// 区块 ↔ inventory §1.10 a 对照：自定义导航（保存并回菜品，submitted 时隐藏）/ 三步流程条（第三步 active）/
// 加载中 / 成功页（✓+提交时间+锁定文案+确定）/ 表单区（建议选填+消息区[重新加载/重试提交]）/
// 提交确认弹窗 / 提交/上一步按钮。
// PM 钉定 Web 适配点（本页）：
// 4) wx.showModal 确认 → ConfirmModal（应用内弹窗，含得分预览）；wx.switchTab → context.navigate（日程 Tab）；
//    wx.navigateBack/redirectTo → context.back(fallback)/replace（§4.3 返回栈兜底）；
//    bindkeyboardheightchange → Web 无键盘高度事件，keyboardOpen 底部留白不适配（省略，不影响语义）。
// 5) 401：捕获 kind=session → toast + redirectToLogin()。
import React, { useEffect, useRef, useState } from "react";
import { Button, Card, ConfirmModal, Field, FlowSteps, Muted, PageNav, TextArea } from "../design/components.jsx";
import { useApp } from "./app-context.jsx";
import { getAssignment } from "../services/assignments.js";
import { getDraft, saveOtherRecords, submitQuestionnaire } from "../services/drafts.js";
import { clearDraft, getDraft as getLocalDraft, markDraftSynced, saveDraft } from "../store/survey.js";
import { computeSurveyScore, secureUuid } from "../utils/business.js";
import { formatSubmittedAt } from "../utils/presentation.js";
import { navEntryIsPage, sanitizeTaskSource } from "../router/nav-history.js";

// hash 路由查询参数（Web 适配：页面自读，等价 miniapp onLoad(options)）。
function routeQuery() {
  const raw = String((typeof window !== "undefined" ? window.location.hash : "") || "").replace(/^#/, "");
  return new URLSearchParams(raw.split("?")[1] || "");
}

export function OtherPage() {
  const { navigate, back, replace, toast, redirectToLogin } = useApp();
  const [meta, setMeta] = useState(null);
  const [suggestion, setSuggestion] = useState("");
  const [submitState, setSubmitState] = useState("draft");
  const [message, setMessage] = useState("");
  const [submittedAt, setSubmittedAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // 提交确认弹窗：open=可见；score=保存+拉取后计算的当前得分预览（null=无法计算，绝不虚构 100%）。
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmScore, setConfirmScore] = useState(null);
  // 同步 guard：防 React 状态批量提交完成前的重复「确认提交」点击（提交幂等 token 不变，
  // 但 UI 层也不应重复发起）。openConfirmModal/取消时复位。
  const confirmGuardRef = useRef(false);
  const confirmScoreRef = useRef(null);
  // 异步闭包内读取最新值（等价 miniapp this.data）；卸载后异步回调不再写状态。
  const latestRef = useRef({});
  const routeMetaRef = useRef(null);
  // 任务链来源（?source=，菜品页写入；只读回跳任务详情时原样带回）。
  const sourceRef = useRef("");
  const assignmentRevisionRef = useRef(null);
  const submitTokenRef = useRef(null);
  const pollTimerRef = useRef(null);
  const dirtyRef = useRef(false);
  const unloadedRef = useRef(false);

  latestRef.current = { meta, suggestion, submitState, saving };

  const persistLocal = () => {
    if (!routeMetaRef.current) return;
    try {
      // 只持久化建议：闪光点由第二步编辑与持久化，此处不写避免覆盖其本地草稿。
      saveDraft(routeMetaRef.current, { suggestion: latestRef.current.suggestion });
    } catch { /* 存储异常静默：会话丢失由下一次鉴权请求处理 */ }
  };

  const handleSessionError = (loadError) => {
    if (loadError?.kind !== "session" || unloadedRef.current) return false;
    toast(loadError.message);
    redirectToLogin();
    return true;
  };

  // ---------- 加载（等价 miniapp load） ----------

  const load = async () => {
    setLoading(true);
    setMessage("");
    try {
      const assignment = await getAssignment(routeMetaRef.current.assignmentId);
      if (unloadedRef.current) return;
      // R31：任务已提交终态 → toast + 任务详情（保留任务来源）。
      if (assignment.status === "submitted") {
        toast("该任务已提交");
        replace(`/task?assignmentId=${encodeURIComponent(routeMetaRef.current.assignmentId)}&source=${sourceRef.current}`);
        return;
      }
      const result = await getDraft(routeMetaRef.current.attemptId);
      if (unloadedRef.current) return;
      // R32：attempt/版本与路由不一致。
      if (result.attempt.id !== routeMetaRef.current.attemptId || result.questionnaireVersion.id !== routeMetaRef.current.questionnaireVersionId) {
        throw new Error("问卷信息已更新，请从任务详情重新进入");
      }
      // R76：提交中/已提交终态关闭编辑（按状态区分 toast 文案）。
      if (["submitting", "processing", "submitted"].includes(result.attempt.status)) {
        toast(result.attempt.status === "submitted" ? "该任务已提交" : "问卷正在提交");
        replace(`/task?assignmentId=${encodeURIComponent(routeMetaRef.current.assignmentId)}&source=${sourceRef.current}`);
        return;
      }
      const nextMeta = { ...routeMetaRef.current, revision: result.attempt.revision };
      const local = getLocalDraft(nextMeta);
      // R77：本地未同步优先，否则采用服务端 suggestion 并 markDraftSynced。
      const useLocal = local.synced === false;
      const records = useLocal ? local : (result.otherRecords || {});
      if (!useLocal) {
        saveDraft(nextMeta, { suggestion: records.suggestion || "" });
        markDraftSynced(nextMeta, nextMeta.revision);
      }
      routeMetaRef.current = nextMeta;
      // assignmentRevision 取任务（audit_assignments）revision：提交 409 以它校验；attempt revision 绝不能兜底。
      if (!Number.isInteger(assignment.revision)) throw new Error("任务信息已过期，请刷新后重试");
      assignmentRevisionRef.current = assignment.revision;
      dirtyRef.current = useLocal;
      if (unloadedRef.current) return;
      setMeta(nextMeta);
      setSuggestion(records.suggestion || "");
      // R83：提交状态固定初始化 draft（重开草稿即重置）；failed 给恢复提示但仍可编辑。
      setSubmitState("draft");
      setMessage(result.attempt.status === "failed" ? "上次提交未完成，请检查内容后重新提交" : "");
      setSubmittedAt(result.attempt.submittedAt || "");
      setLoading(false);
    } catch (loadError) {
      if (unloadedRef.current) return;
      if (handleSessionError(loadError)) return;
      setMessage(loadError?.message || "暂时无法加载其他记录，请重试");
      setLoading(false);
    }
  };

  const retryLoad = () => { load(); };

  // ---------- 输入（R78：失败态再编辑弃 token 回 draft） ----------

  const input = (value) => {
    if (["retryable_failed", "terminal_failed"].includes(latestRef.current.submitState)) submitTokenRef.current = null;
    dirtyRef.current = true;
    setSuggestion(value);
    setSubmitState("draft");
    setMessage("");
    persistLocal();
  };

  // ---------- 保存其他记录（等价 miniapp saveRecords；只写建议，闪光点由第二步保存） ----------

  const saveRecords = async () => {
    if (latestRef.current.saving) return null;
    const nextSuggestion = latestRef.current.suggestion.trim();
    setSaving(true);
    setMessage("");
    saveDraft(routeMetaRef.current, { suggestion: nextSuggestion });
    try {
      const saved = await saveOtherRecords(routeMetaRef.current.attemptId, { suggestion: nextSuggestion, revision: routeMetaRef.current.revision });
      if (unloadedRef.current) return null;
      const nextMeta = { ...routeMetaRef.current, revision: saved.revision };
      markDraftSynced(nextMeta, saved.revision);
      routeMetaRef.current = nextMeta;
      assignmentRevisionRef.current = saved.assignmentRevision ?? assignmentRevisionRef.current;
      dirtyRef.current = false;
      setMeta(nextMeta);
      setSuggestion(nextSuggestion);
      return saved;
    } catch (saveError) {
      if (unloadedRef.current) return null;
      if (handleSessionError(saveError)) return null;
      setMessage(`${saveError?.message || "暂时无法保存"}，请重试`);
      toast(saveError?.message || "暂时无法保存");
      return null;
    } finally {
      setSaving(false);
    }
  };

  // ---------- 提交链（R79-R82/R84） ----------

  const complete = (result) => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    // R85：清本地草稿 + 清脏 + 成功终态页。
    clearDraft(routeMetaRef.current);
    dirtyRef.current = false;
    setSubmitState("submitted");
    setSubmittedAt(result?.submittedAt || "");
    setMessage("提交成功");
  };

  // 任务 revision 守卫：非整数绝不发提交请求，也绝不回退问卷 attempt revision（本批次 T2 修订）。
  const requireFreshAssignment = () => {
    if (Number.isInteger(assignmentRevisionRef.current)) return true;
    submitTokenRef.current = null;
    setSubmitState("refresh_required");
    setMessage("任务信息已过期，请刷新后重试");
    return false;
  };

  // 提交错误三态映射（session 已在 handleSessionError 优先处理）。
  // 优先级：已提交终态 > 可重试（保 token）> 需刷新换 token（清 token，手动刷新）> 终态失败（清 token）。
  const handleSubmitError = (submitError) => {
    if (submitError?.kind === "questionnaire_submitted") {
      // 任务其实已提交成功过（不同 token 重放）：清草稿与 token，回任务详情（R31 同跳法），不作为失败展示。
      clearDraft(routeMetaRef.current);
      submitTokenRef.current = null;
      toast("该任务已提交");
      replace(`/task?assignmentId=${encodeURIComponent(routeMetaRef.current.assignmentId)}&source=${sourceRef.current}`);
      return;
    }
    if (submitError?.retryable === true) {
      // R82：可重试失败保留 token，同 token 续试。
      setSubmitState("retryable_failed");
      setMessage(`${submitError.message}，可以重试提交`);
      return;
    }
    if (submitError?.requiresNewToken === true) {
      // R84：任务已逾期/状态已更新，旧 token 作废：清 token，等用户手动点「刷新」（retryLoad 成功后回 draft 重新提交）。
      submitTokenRef.current = null;
      setSubmitState("refresh_required");
      setMessage(submitError.message || "任务信息已更新，请刷新后重试");
      return;
    }
    submitTokenRef.current = null;
    setSubmitState("terminal_failed");
    setMessage(submitError?.message || "提交未完成");
  };

  const submitWithExistingToken = async () => {
    if (!submitTokenRef.current) {
      setSubmitState("draft");
      return;
    }
    if (!requireFreshAssignment()) return;
    setSubmitState("submitting");
    setMessage("正在确认提交结果…");
    try {
      const result = await submitQuestionnaire(routeMetaRef.current.attemptId, {
        submitToken: submitTokenRef.current,
        assignmentRevision: assignmentRevisionRef.current,
        confirmation: true,
      });
      if (unloadedRef.current) return;
      if (result.status === "processing") {
        setSubmitState("processing");
        setMessage("问卷正在处理，请稍候");
        poll();
        return;
      }
      complete(result);
    } catch (submitError) {
      if (unloadedRef.current) return;
      if (handleSessionError(submitError)) return;
      handleSubmitError(submitError);
    }
  };

  const submit = async () => {
    if (locked()) return;
    if (!requireFreshAssignment()) return;
    // R79：无 token 生成一次性提交 token（生成失败中止）。
    if (!submitTokenRef.current) {
      try {
        submitTokenRef.current = secureUuid();
      } catch {
        setMessage("当前环境不支持安全提交");
        return;
      }
    }
    setSubmitState("submitting");
    setMessage("正在安全提交，请勿关闭页面");
    try {
      const result = await submitQuestionnaire(routeMetaRef.current.attemptId, {
        submitToken: submitTokenRef.current,
        assignmentRevision: assignmentRevisionRef.current,
        confirmation: true,
      });
      if (unloadedRef.current) return;
      if (result.status === "processing") {
        // R81：processing → 轮询同 token 直至终态。
        setSubmitState("processing");
        setMessage("问卷正在处理，请稍候");
        poll();
        return;
      }
      complete(result);
    } catch (submitError) {
      if (unloadedRef.current) return;
      if (handleSessionError(submitError)) return;
      handleSubmitError(submitError);
    }
  };

  // R81：2500ms 后同 token 重查提交结果。
  const poll = () => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(() => submitWithExistingToken(), 2500);
  };

  const retrySubmit = () => {
    if (latestRef.current.submitState === "retryable_failed" || latestRef.current.submitState === "processing") submitWithExistingToken();
  };

  // ---------- 返回与提交确认（R80，应用内弹窗 + 得分预览） ----------

  const locked = () => ["submitting", "processing", "submitted"].includes(latestRef.current.submitState);

  const goBackToDishes = async () => {
    if (locked()) return;
    const saved = await saveRecords();
    if (!saved) return;
    // §4.3 返回栈兜底（修订）：仅当上一条应用内路由确为同任务菜品页才 history.back；
    // 外部/无关历史不算证据，此时 replace 到携全量参数与任务来源的规范菜品页。
    back(`${routeUrl("/dishes", routeMetaRef.current)}&source=${sourceRef.current}`, (previous) => navEntryIsPage(previous, "/dishes", {
      assignmentId: routeMetaRef.current.assignmentId,
      attemptId: routeMetaRef.current.attemptId,
    }));
  };

  // 弹窗得分预览：保存同步后重新拉取当前问卷（启用题+作答，含停用题残留），用与服务端
  // 提交落库一致的计分口径（domain.applyScoreWipe：持久化 awardedScore + 清零 + orphan）
  // 计算百分比；拉取失败/0 满分/作答缺失 → null，弹窗如实呈现「暂时无法计算」并禁用确认
  // （绝不虚构 100%），提供可恢复的重新获取。取消后编辑全部保留，可继续修改再次提交。
  const fetchConfirmScore = async () => {
    try {
      const result = await getDraft(routeMetaRef.current.attemptId);
      if (unloadedRef.current) return;
      if (result.attempt.id !== routeMetaRef.current.attemptId) return;
      const score = computeSurveyScore(result.questions, result.answers || {});
      if (!unloadedRef.current) {
        confirmScoreRef.current = score;
        setConfirmScore(score);
      }
    } catch {
      if (!unloadedRef.current) {
        confirmScoreRef.current = null;
        setConfirmScore(null); // 拉取失败保持「无法计算」占位（确认保持禁用）
      }
    }
  };

  const openConfirmModal = async () => {
    if (locked()) return;
    const saved = await saveRecords();
    if (!saved || unloadedRef.current) return;
    confirmGuardRef.current = false;
    confirmScoreRef.current = null;
    setConfirmScore(null);
    setConfirmOpen(true);
    fetchConfirmScore();
  };

  const cancelConfirm = () => {
    if (locked()) return;
    confirmGuardRef.current = false;
    setConfirmOpen(false);
    setConfirmScore(null);
  };

  const confirmSubmit = () => {
    // 同步 guard + 得分必达：无得分/重复点击/已锁定一律不再发起（提交 token 幂等设计不变）。
    if (locked() || confirmGuardRef.current || !confirmScoreRef.current) return;
    confirmGuardRef.current = true;
    setConfirmOpen(false);
    submit();
  };

  const startConfirm = async () => {
    if (locked()) return;
    // 重试路径：有 token 的可重试失败直接重放，跳过确认弹窗。
    if (latestRef.current.submitState === "retryable_failed" && submitTokenRef.current) {
      await submitWithExistingToken();
      return;
    }
    await openConfirmModal();
  };

  // R85：成功页确定 → 日程 Tab。
  const done = () => { navigate("/schedule"); };

  // ---------- 生命周期（onLoad 四参数 / onUnload 清理，PM 适配点 4） ----------

  useEffect(() => {
    // StrictMode 双挂载：重挂载恢复 false；真实卸载仍由 cleanup 置 true。
    unloadedRef.current = false;
    const params = routeQuery();
    const assignmentId = params.get("assignmentId") || "";
    const attemptId = params.get("attemptId") || "";
    const questionnaireVersionId = params.get("questionnaireVersionId") || "";
    if (!assignmentId || !attemptId || !questionnaireVersionId) {
      setLoading(false);
      setMessage("未找到当前问卷，请从任务详情重新进入");
      return () => { unloadedRef.current = true; };
    }
    routeMetaRef.current = {
      assignmentId,
      attemptId,
      questionnaireVersionId,
      revision: Number(params.get("revision") || 0),
    };
    sourceRef.current = sanitizeTaskSource(params.get("source") || "");
    load();
    return () => {
      // onUnload 等价：清轮询定时器；未提交且脏时持久化本地。
      unloadedRef.current = true;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (dirtyRef.current && latestRef.current.submitState !== "submitted") persistLocal();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = saving || ["submitting", "processing"].includes(submitState);
  const viewState = loading ? "loading" : submitState === "submitted" ? "submitted" : "ready";

  return (
    <div className="app-page app-page--flat" data-page="other" data-state={viewState} data-submit-state={submitState}>
      {submitState !== "submitted" ? <PageNav title="其他记录" onBack={goBackToDishes} /> : null}
      {submitState !== "submitted" ? <FlowSteps current="other" /> : null}

      {loading ? (
        <Card><Muted>正在加载其他记录…</Muted></Card>
      ) : submitState === "submitted" ? (
        <Card style={{ textAlign: "center" }}>
          <div style={{ fontSize: 40, color: "#f25f42" }}>✓</div>
          <div style={{ marginTop: 8, fontSize: 18, fontWeight: 700 }}>提交成功</div>
          {/* R85 边注：submittedAt 缺失时不渲染时间行。 */}
          {submittedAt ? <div style={{ marginTop: 6 }}><Muted>提交时间：{formatSubmittedAt(submittedAt)}</Muted></div> : null}
          <div style={{ marginTop: 8 }}><Muted>本次问卷已锁定，不能回看或修改。如需说明，请联系管理员。</Muted></div>
          <div style={{ marginTop: 16 }}><Button onClick={done}>确定</Button></div>
        </Card>
      ) : (
        <>
          <Card>
            <Field label="其他建议">
              <TextArea
                value={suggestion}
                placeholder="请填写问卷中未列出但您认为可以改进的地方"
                aria-label="其他建议，选填"
                onChange={(event) => input(event.target.value)}
              />
            </Field>
          </Card>

          {/* 消息区：加载失败（无 meta）→ 重新加载；可重试失败/处理中 → 重试提交；需刷新换 token → 手动刷新 */}
          {message ? (
            <div className={`error-bar ${submitState === "terminal_failed" ? "error-bar--alert" : ""}`} role="status" style={{ marginTop: 8 }}>
              <span>{message}</span>
              {!meta ? <button type="button" className="error-bar__retry" onClick={retryLoad}>重新加载</button> : null}
              {submitState === "retryable_failed" || submitState === "processing" ? (
                <button type="button" className="error-bar__retry" onClick={retrySubmit}>重试提交</button>
              ) : null}
              {submitState === "refresh_required" ? (
                <button type="button" className="error-bar__retry" onClick={retryLoad}>刷新</button>
              ) : null}
            </div>
          ) : null}

          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            <Button disabled={busy || locked()} onClick={startConfirm}>提交问卷</Button>
            <Button variant="outline" disabled={busy || locked()} onClick={goBackToDishes}>上一步：其他照片</Button>
          </div>

          {/* R80 提交确认：应用内弹窗（非 window.confirm）。显式不可逆警示 + 当前得分百分比；
              确认只提交一次；取消/点遮罩关闭并保留全部编辑，可返回继续修改。 */}
          <ConfirmModal
            open={confirmOpen}
            title="确认提交问卷？"
            confirmLabel="确认提交"
            cancelLabel="继续编辑"
            busy={busy}
            confirmDisabled={!confirmScore}
            onConfirm={confirmSubmit}
            onCancel={cancelConfirm}
          >
            <span className="modal-score" data-confirm-score={confirmScore ? String(confirmScore.percent) : "unavailable"}>
              {confirmScore ? `当前得分 ${confirmScore.percent}%（${confirmScore.totalScore}/${confirmScore.maxScore} 分）` : "得分率暂时无法计算"}
            </span>
            {!confirmScore ? (
              <Button variant="link" small disabled={busy} onClick={fetchConfirmScore}>重新获取得分</Button>
            ) : null}
            <span>问卷提交后无法再次修改，请确认所有内容已经完成。</span>
          </ConfirmModal>
        </>
      )}
    </div>
  );
}

function routeUrl(path, meta) {
  return `${path}?assignmentId=${encodeURIComponent(meta.assignmentId)}&attemptId=${encodeURIComponent(meta.attemptId)}&questionnaireVersionId=${encodeURIComponent(meta.questionnaireVersionId)}&revision=${meta.revision}`;
}
