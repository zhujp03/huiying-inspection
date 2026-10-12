// store/survey-merge.js（module-contracts §4.4；小程序 store/survey-merge.js:1-26 同名同语义）
//
// 问卷草稿加载合并规则（纯函数，R35 四条规则）：
// 1. 本地无未同步草稿 → 使用服务端 answers。
// 2. 本地 synced=false 且 revision 与服务端一致 → 保留本地字段并逐题覆盖服务端
//    同题结果（服务端空 {} 不能覆盖本地待同步答案），随后由调用方逐项补发。
// 3. 本地 synced=false 且服务端 revision 已前进 → 停止静默合并，返回冲突。
// 4. 本地 synced=false 且本地 revision 更新 → 以本地为准。
// 不实现第一阶段范围外的完整离线多设备合并。

export function mergeSurveyAnswers({ serverAnswers = {}, serverRevision, rawLocal }) {
  if (!rawLocal || rawLocal.synced !== false) return { answers: serverAnswers, conflict: false, pendingResync: [] };
  const localAnswers = rawLocal.answers && typeof rawLocal.answers === "object" ? rawLocal.answers : {};
  if (serverRevision === rawLocal.revision) {
    const merged = { ...serverAnswers, ...localAnswers };
    const pendingResync = Object.entries(localAnswers)
      .filter(([id, answer]) => answer?.answer === "scored" && !sameAnswer(serverAnswers[id], answer))
      .map(([id]) => id);
    return { answers: merged, conflict: false, pendingResync };
  }
  if (serverRevision > rawLocal.revision) return { answers: serverAnswers, conflict: true, pendingResync: [] };
  return { answers: { ...serverAnswers, ...localAnswers }, conflict: false, pendingResync: [] };
}

const sameAnswer = (server, local) => {
  if (!server && !local) return true;
  if (!server || !local) return false;
  return server.answer === local.answer && (server.remark || "") === (local.remark || "");
};
