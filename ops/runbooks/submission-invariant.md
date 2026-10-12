# Runbook: Submission invariant violation（提交不变量破坏）

不变量：每个 attempt 至多一个提交快照；`submitted` 必有 `submission_versions` 且 `integrity_hash/hmac` 校验通过；幂等记录与问卷状态对账一致；提交后所有写接口拒绝。

## 检测
- 恢复器日志出现 `invariant_violation`；指标 `submissions_total{status=...}` 异常。
- 审计查询：`submission_versions` 与 `survey_attempts` 状态不一致；`integrity_hash` 重算不匹配。

## 处置
1. 立即停止该 attempt 相关自动修复（恢复器对 `invariant_violation` 不自动改状态）。
2. 只读导出证据：快照行、幂等记录、审计日志、附件引用。
3. 人工判定：若快照存在且 hash 校验通过 → 对账为 submitted/succeeded（记录操作者与原因）；若快照缺失 → 保持 submitted 并人工重建快照（禁止直接回滚到 draft）。
4. 若确认代码缺陷 → 先修代码与测试（`tests/integration/batch2.postgres.test.js` 的提交竞争用例），再处理存量数据。

## 验证
- 演练：人为制造 processing 租约过期与快照存在/缺失两种状态 → 恢复器按第 9.8 节对账；确认不会出现永久 processing 或重复快照。
