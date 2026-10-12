-- captcha_verification_id 允许为空：只保存腾讯 RequestId（脱敏），
-- 供应商未返回 RequestId 时（如沙箱/测试注入）不强制填充。
ALTER TABLE phone_verification_challenges ALTER COLUMN captcha_verification_id DROP NOT NULL;
