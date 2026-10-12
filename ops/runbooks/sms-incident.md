# Runbook: SMS incident（短信异常）

影响：注册/找回密码验证码无法发送（503 `SMS_UNAVAILABLE`）；供应商明确拒绝（模板未过审、签名不匹配）归类为终态 422。

## 检测
- 告警：短信发送失败率、验证码锁死数（`SMS_CODE_ATTEMPTS_EXHAUSTED`）。
- 查看 `phone_verification_challenges.delivery_status`（pending/sent/send_failed）分布与供应商控制台。

## 处置
1. 供应商侧：检查签名、模板审核状态、余额与频率限制（同一手机号 60 秒 1 次、24 小时 10 次，业务侧限流不得弱于供应商）。
2. 密钥问题：按 key-rotation.md 轮换 `SMS_SECRET_*`。
3. 验证码 challenge 在 send_failed 时已原子失效，用户可稍后重试；不存在账号时不会真正发送（防枚举）。
4. 恢复后先发白名单号码验证，再放开全量。

## 验证
- 演练：把模板 ID 指向不存在模板 → 确认 422 终态拒绝且日志无验证码/完整手机号；恢复模板 → 白名单手机号收到验证码并完成注册。

## 禁止
- 禁止批量发送真实短信；禁止把验证码或完整手机号写入日志。
