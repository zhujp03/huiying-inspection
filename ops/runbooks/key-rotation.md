# Runbook: Credential rotation（密钥轮换）

原则：`SESSION_PEPPER_KEY_ID`/`PHONE_ENCRYPTION_KEY_ID`/`BLIND_INDEX_KEY_ID` 支持双 key 过渡；数据库 HMAC/加密密钥轮换必须分批迁移存量数据；COS/SMS 长凭据每 90 天轮换。

## 步骤
1. 先在 staging 演练：为新 key 生成新版本，旧 key 保留为 `*_KEY_ID` 的旧版本引用。
2. 会话/CSRF：切换签发密钥后旧会话在双 key 窗口内仍可验证，窗口结束后旧会话自然过期（或按 session_version 批量撤销）。
3. 手机号信封加密/盲索引：轮换需要全量重加密脚本（dry-run → 分批 → 校验 `phone_lookup_hmac` 唯一性 → 删旧密文）。
4. COS：更换 `COS_ASSUME_ROLE_SECRET_ID/KEY`（角色本身不换，避免对象权限变更）；先验证 `cos.assertReady()` 与一次上传/预览。
5. SMS/CAPTCHA：更换 `SMS_SECRET_*`、`CAPTCHA_SECRET_*` 后，用白名单手机号完成一次注册与找回密码。
6. 所有轮换写入审计，新值只进密钥管理，不落 Git/聊天。

## 验证
- 轮换后运行：`npm run verify:release`（本地部分）、登录/注册 E2E、`tests/unit/cos-renewal.test.js` 语义。
- 确认旧凭据失效：撤销旧 key 后对应调用返回 503/401，且没有日志泄漏新值。
