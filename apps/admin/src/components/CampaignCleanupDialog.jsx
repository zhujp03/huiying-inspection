import { useCallback, useEffect, useState } from "react";
import { API, CampaignCleanupPreviewSchema, toStatusLabel } from "../../../../packages/contracts/index.js";
import { request } from "../api/client.js";
import { useAdminAuth } from "../auth/AdminAuth.jsx";
import { WarningCircle } from "@phosphor-icons/react";

// 清理行数标签（与服务端 counts 键一一对应；子表行随任务一并删除，全部展示给操作者过目）。
const COUNT_LABELS = [
  ["assignments", "指派"],
  ["dishRequirements", "菜品要求"],
  ["checkins", "打卡记录"],
  ["exemptions", "打卡豁免"],
  ["attempts", "问卷作答"],
  ["answers", "作答答案"],
  ["editSessions", "答案修改会话"],
  ["editSessionRemovals", "答案修改记录"],
  ["evidenceAttachments", "题目证据文件"],
  ["receiptAttachments", "消费小票"],
  ["ocrJobs", "小票识别任务"],
  ["dishes", "菜品记录"],
  ["otherRecords", "闪光点与建议"],
  ["idempotencyKeys", "提交幂等记录"],
];

// 测试任务数据清理（super_admin 专用流程的界面半边）：
// 1) 先拉取预览：任务信息、将被删除的各类数据行数、阻断原因（有正式提交/进行中作业/法务保留等）；
// 2) 无阻断时要求逐字输入任务名称 + revision 乐观锁双重确认后才发起清理；
// 3) 失败（含会话过期）弹窗保持现场，输入与预览不丢；成功后由调用方刷新列表。
export function CampaignCleanupDialog({ campaign, onClose, onDone, setToast }) {
  const { expire } = useAdminAuth();
  const [state, setState] = useState({ loading: true, error: "", preview: null, confirmName: "", pending: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: "" }));
    request(API.admin.campaignCleanupPreview(campaign.id), { schema: CampaignCleanupPreviewSchema, signal: controller.signal })
      .then((preview) => { if (active) setState((current) => ({ ...current, loading: false, error: "", preview })); })
      .catch((loadError) => {
        if (!active || controller.signal.aborted) return;
        // 失败（含会话过期）一律落到可重试错误态：保留已输入的确认名称与上一次安全预览，
        // 重试只重新拉取预览，绝不自动执行清理。会话过期同时切登录遮罩，重登后可原位点「重试」。
        setState((current) => ({ ...current, loading: false, error: loadError.kind === "session" ? "登录已失效，请重新登录后再试" : loadError.message }));
        if (loadError.kind === "session") expire();
      });
    return () => { active = false; controller.abort(); };
  }, [campaign.id, attempt, expire]);
  const confirm = useCallback(async () => {
    const preview = state.preview;
    if (!preview || state.pending) return;
    if (state.confirmName.trim() !== preview.campaign.name) return;
    setState((current) => ({ ...current, pending: true, error: "" }));
    try {
      await request(API.admin.campaignCleanup(campaign.id), { method: "POST", body: { revision: preview.campaign.revision, confirmName: state.confirmName.trim() } });
      onDone();
    } catch (cleanupError) {
      if (cleanupError.kind === "session") {
        setState((current) => ({ ...current, pending: false, error: "登录已过期，请重新登录后再试" }));
        expire();
        return;
      }
      // 版本冲突/状态变化：保持弹窗现场并重新拉取预览，让操作者基于最新状态重新确认；其余错误就地展示。
      setState((current) => ({ ...current, pending: false, error: cleanupError.message }));
      if (cleanupError.code === "REVISION_CONFLICT") { setState((current) => ({ ...current, preview: null })); setAttempt((value) => value + 1); }
    }
  }, [campaign.id, expire, onDone, state.confirmName, state.pending, state.preview]);
  const preview = state.preview;
  const blocked = Boolean(preview && preview.blockers.length > 0);
  const nameMatches = Boolean(preview && state.confirmName === preview.campaign.name);
  const attemptClose = () => { if (!state.pending) onClose(); };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={attemptClose}>
      <section className="modal-card modal-card--form" role="dialog" aria-modal="true" aria-labelledby="campaign-cleanup-title" onMouseDown={(event) => event.stopPropagation()}>
        <h2 id="campaign-cleanup-title">清理这个测试任务的数据？</h2>
        {state.loading ? <p>正在统计将被删除的数据…</p> : null}
        {state.error ? <p className="form-message" role="alert">{state.error}{!state.pending && !state.loading ? <> <button className="admin-secondary" onClick={() => setAttempt((value) => value + 1)}>重试</button></> : null}</p> : null}
        {preview && (
          <>
            <div className="cleanup-count-list">
              <div><strong>{preview.campaign.name}</strong><span>{toStatusLabel(preview.campaign.status)}</span></div>
              <div><span>门店</span><strong>{preview.campaign.storeName}</strong></div>
              <div><span>任务编号</span><strong>{preview.campaign.businessNo}</strong></div>
              {COUNT_LABELS.filter(([key]) => (preview.counts[key] ?? 0) > 0).map(([key, label]) => (
                <div key={key}><span>{label}</span><strong>{preview.counts[key]} 行</strong></div>
              ))}
              {COUNT_LABELS.every(([key]) => (preview.counts[key] ?? 0) === 0) && <div><span>该任务没有可清理的业务数据行</span><strong>—</strong></div>}
            </div>
            {blocked && <div className="cleanup-blockers">{preview.blockers.map((blocker) => <div key={blocker.code}><WarningCircle size={15} weight="fill" /><span>{blocker.message}</span></div>)}</div>}
            {!blocked && (
              <label className="admin-field cleanup-confirm-input">
                <span>请输入任务名称「{preview.campaign.name}」以确认清理（不可恢复）</span>
                <input value={state.confirmName} disabled={state.pending} autoComplete="off" onChange={(event) => setState((current) => ({ ...current, confirmName: event.target.value }))} />
              </label>
            )}
          </>
        )}
        <div className="modal-actions">
          <button className="button button--ghost" disabled={state.pending} onClick={attemptClose}>取消</button>
          <button className="button button--danger" disabled={!preview || blocked || !nameMatches || state.pending} onClick={confirm}>{state.pending ? "清理中…" : "确认清理"}</button>
        </div>
      </section>
    </div>
  );
}
