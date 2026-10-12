# Runbook: Accidental object deletion recovery（误删对象恢复）

前提：证据/导出/备份桶开启版本控制（第 12.4 节强制）；删除只应由 retention worker 在无 legal hold 时执行。

## 检测
- `object_reconciliation` 报告对象缺失或 versionId 不一致；审计中出现非预期删除记录。

## 处置
1. 确认版本控制开启：COS 控制台查看目标 key 的版本列表。
2. 从上一有效 versionId 恢复：用 COS SDK/控制台把 `x-cos-version-id` 指定的版本复制回当前版本。
3. 对照数据库 `storage_version_id` 与 `sha256` 校验恢复对象（`ops/backup-database.mjs` 的 head/校验模式可复用）；不匹配时按 cos-reconciliation.md 进入人工对账。
4. 若对象已超过版本生命周期：从最近数据库备份的引用清单重建对象，或走归档恢复（`archive_restore_jobs`）。
5. 全程保留恢复审计，不修改数据库删除时间戳。

## 验证
- 演练：staging 删除一个证据对象 → 从版本历史恢复 → `verifyStoredObject` 校验大小与 sha256 通过 → 管理员短时预览可访问。
