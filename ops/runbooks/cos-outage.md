# Runbook: COS unavailable（对象存储不可用）

影响：上传初始化/complete、预览、导出、备份全部失败；凭据续期失败返回 503 `COS_CREDENTIAL_REFRESH_FAILED`（旧凭证仍有效时请求继续，见 `apps/api/src/storage/cos.js`）。

## 检测
- 告警：COS 拒绝/签名失败异常增加、`backup_age_seconds` > 26 小时。
- 查看 COS 控制台 bucket 状态、密钥权限与子账号策略。

## 处置
1. 若为临时故障：请求侧已返回可重试 503，无需人工操作；观察 5 分钟。
2. 若为凭据/权限问题：检查 `COS_ROLE_ARN` 对应 CAM 角色策略（evidence/export/backup 三个桶的最小权限）；按 key-rotation.md 轮换 `COS_ASSUME_ROLE_SECRET_*`。
3. 上传中断不影响已入 `ready` 的证据与已提交快照；草稿附件写失败保留在 `failed`，用户可重试。
4. 备份失败按 backup-recovery.md 处理，先保证数据库备份可恢复。

## 验证
- 演练：把 STS 凭证设为即将过期并并发发起请求 → 只发生一次受控刷新且请求继续（`tests/unit/cos-renewal.test.js` 覆盖该语义）；再演练撤销角色 → 返回 503 且无泄漏。

## 禁止
- 禁止退化为公有读桶；禁止把永久 SecretId/SecretKey 下发到客户端。
