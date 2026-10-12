// C 类纯逻辑测试：utils/errors.js（module-contracts §5.3；语义来源 api.js:10-28、rules.md R84/R86）。
// 契约：export class BusinessError + export function presentError(statusCode, payload)。
// presentError 完整映射 11 分支见 module-contracts §5.3 表（按表序自上而下命中即返回；api.js:14-28 行序一致）：
// SMS 码 → QUESTIONNAIRE_SUBMITTED → CAPTCHA_EXPIRED → CAPTCHA_REJECTED/CANCELLED → 401 → 403 → 409
// → statusCode >= 500 → RECEIPT_LIMIT_EXCEEDED → RECEIPT_FILE_INVALID → 兜底。
// 注意：仅前四组业务码先于全部状态码判断（R86 边界例：SMS 码以 409/422 返回仍映射 sms_invalidated）；
// RECEIPT_* 两码排在 ≥500 之后——任意 5xx 一律 service，不落 RECEIPT 分支。
//
// TDD 红灯基线：apps/web/src/utils/errors.js 尚未实现，本文件全部用例预期因模块不存在而失败。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { loadSrc } from "../helpers/contract-paths.js";

// 按 R86 断言一个分支的完整产物：kind、文案、retryable/requiresNewToken（除 5xx 与 409 外均为 false）。
const assertBranch = (error, kind, message, { retryable = false, requiresNewToken = false } = {}) => {
  assert.ok(error instanceof Error, "应返回 Error 实例");
  assert.equal(error.name, "BusinessError");
  assert.equal(error.kind, kind);
  assert.equal(error.message, message);
  assert.equal(error.retryable, retryable, `retryable 应为 ${retryable}`);
  assert.equal(error.requiresNewToken, requiresNewToken, `requiresNewToken 应为 ${requiresNewToken}`);
};

describe("utils/errors.js BusinessError 构造语义（api.js:10-12）", () => {
  it("name=BusinessError，kind/message 字段直传，details 缺省时 retryable/requiresNewToken 为 false", async () => {
    const { BusinessError } = await loadSrc("utils/errors.js");
    const error = new BusinessError("validation", "操作未完成，请检查填写内容");
    assert.ok(error instanceof Error);
    assert.ok(error instanceof BusinessError);
    assert.equal(error.name, "BusinessError");
    assert.equal(error.kind, "validation");
    assert.equal(error.message, "操作未完成，请检查填写内容");
    assert.equal(error.retryable, false);
    assert.equal(error.requiresNewToken, false);
  });

  it("details 的 retryable/requiresNewToken 经 Boolean 布尔化：真值 → true", async () => {
    const { BusinessError } = await loadSrc("utils/errors.js");
    const error = new BusinessError("service", "服务暂时不可用，请稍后重试", { retryable: "yes", requiresNewToken: 1 });
    assert.equal(error.retryable, true);
    assert.equal(error.requiresNewToken, true);
  });

  it("details 的 retryable/requiresNewToken 经 Boolean 布尔化：假值与缺失 → false", async () => {
    const { BusinessError } = await loadSrc("utils/errors.js");
    const falsy = new BusinessError("conflict", "内容已更新，请刷新后重试", { retryable: 0, requiresNewToken: "" });
    assert.equal(falsy.retryable, false);
    assert.equal(falsy.requiresNewToken, false);
    const absent = new BusinessError("conflict", "内容已更新，请刷新后重试", {});
    assert.equal(absent.retryable, false);
    assert.equal(absent.requiresNewToken, false);
  });
});

describe("utils/errors.js presentError 11 分支逐条（module-contracts §5.3 表，api.js:14-28 逐字）", () => {
  it("分支 1：code=SMS_CODE_INVALIDATED → sms_invalidated「验证码已失效，请重新发送并完成人机验证」", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(
      presentError(422, { error: { code: "SMS_CODE_INVALIDATED" } }),
      "sms_invalidated",
      "验证码已失效，请重新发送并完成人机验证",
    );
  });

  it("分支 1：code=SMS_CODE_ATTEMPTS_EXHAUSTED → sms_invalidated「验证码已失效，请重新发送并完成人机验证」", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(
      presentError(422, { error: { code: "SMS_CODE_ATTEMPTS_EXHAUSTED" } }),
      "sms_invalidated",
      "验证码已失效，请重新发送并完成人机验证",
    );
  });

  it("分支 2：code=QUESTIONNAIRE_SUBMITTED → questionnaire_submitted「任务已提交，小票不可再查看或修改」", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(
      presentError(400, { error: { code: "QUESTIONNAIRE_SUBMITTED" } }),
      "questionnaire_submitted",
      "任务已提交，小票不可再查看或修改",
    );
  });

  it("分支 3：code=CAPTCHA_EXPIRED → captcha_rejected「验证已过期，请重新验证」", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(
      presentError(400, { error: { code: "CAPTCHA_EXPIRED" } }),
      "captcha_rejected",
      "验证已过期，请重新验证",
    );
  });

  it("分支 4：code=CAPTCHA_REJECTED → captcha_rejected「验证未通过，请重新验证」", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(
      presentError(400, { error: { code: "CAPTCHA_REJECTED" } }),
      "captcha_rejected",
      "验证未通过，请重新验证",
    );
  });

  it("分支 4：code=CAPTCHA_CANCELLED → captcha_rejected「验证未通过，请重新验证」", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(
      presentError(400, { error: { code: "CAPTCHA_CANCELLED" } }),
      "captcha_rejected",
      "验证未通过，请重新验证",
    );
  });

  it("分支 5：statusCode=401 → session「登录已失效，请重新登录」（触发清会话+清缓存+跳登录，R05）", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(presentError(401, { error: { code: "TOKEN_EXPIRED" } }), "session", "登录已失效，请重新登录");
  });

  it("分支 6：statusCode=403 → forbidden「你没有权限进行此操作」", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(presentError(403, {}), "forbidden", "你没有权限进行此操作");
  });

  it("分支 7：statusCode=409 → conflict，文案透传 payload.error.message（R84）", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(
      presentError(409, { error: { message: "任务已逾期，请等待管理员延期后刷新任务" } }),
      "conflict",
      "任务已逾期，请等待管理员延期后刷新任务",
    );
  });

  it("分支 7：statusCode=409 且无 message → conflict 兜底文案「内容已更新，请刷新后重试」", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(presentError(409, { error: {} }), "conflict", "内容已更新，请刷新后重试");
  });

  it("分支 7：409 的 requiresNewToken 从 payload.error.requiresNewToken 布尔透传（真值 true / 缺失 false）", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    const withToken = presentError(409, { error: { message: "内容已更新", requiresNewToken: true } });
    assert.equal(withToken.kind, "conflict");
    assert.equal(withToken.requiresNewToken, true);
    assert.equal(withToken.retryable, false);
    const withoutToken = presentError(409, { error: {} });
    assert.equal(withoutToken.requiresNewToken, false);
  });

  it("分支 7：409 的 retryable 从 payload.error.retryable 布尔透传（SUBMIT_PROCESSING → 页面保 token 同 token 续试，T2 修订 2026-10-11）", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    const error = presentError(409, { error: { code: "SUBMIT_PROCESSING", message: "提交正在处理中，请稍后重试", retryable: true } });
    assert.equal(error.kind, "conflict");
    assert.equal(error.retryable, true, "409 通道必须布尔透传 retryable，页面据此进 retryable_failed 保 token 续试");
    assert.equal(error.requiresNewToken, false, "SUBMIT_PROCESSING 不带 requiresNewToken，透传必须为 false");
  });

  it("分支 8：statusCode >= 500（500/503/599）→ service「服务暂时不可用，请稍后重试」retryable=true", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    for (const statusCode of [500, 503, 599]) {
      assertBranch(presentError(statusCode, {}), "service", "服务暂时不可用，请稍后重试", { retryable: true });
    }
  });

  it("分支 9：code=RECEIPT_LIMIT_EXCEEDED → validation「最多只能上传 9 张消费小票」", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(
      presentError(400, { error: { code: "RECEIPT_LIMIT_EXCEEDED" } }),
      "validation",
      "最多只能上传 9 张消费小票",
    );
  });

  it("分支 10：code=RECEIPT_FILE_INVALID → validation「请选择 10MB 以内的图片」", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(
      presentError(400, { error: { code: "RECEIPT_FILE_INVALID" } }),
      "validation",
      "请选择 10MB 以内的图片",
    );
  });

  it("分支 11：兜底（未知 code/纯状态码/payload 为 null）→ validation「操作未完成，请检查填写内容」", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(presentError(422, { error: { code: "SOMETHING_ELSE" } }), "validation", "操作未完成，请检查填写内容");
    assertBranch(presentError(400, {}), "validation", "操作未完成，请检查填写内容");
    assertBranch(presentError(400, null), "validation", "操作未完成，请检查填写内容");
  });
});

describe("utils/errors.js presentError 优先级：按 §5.3 表序命中即返回（api.js:14-28 行序）", () => {
  it("statusCode=409 + code=QUESTIONNAIRE_SUBMITTED → questionnaire_submitted（QUESTIONNAIRE 码先于 409，不是 conflict）", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(
      presentError(409, { error: { code: "QUESTIONNAIRE_SUBMITTED", message: "任意透传文案" } }),
      "questionnaire_submitted",
      "任务已提交，小票不可再查看或修改",
    );
  });

  it("statusCode=500 + code=RECEIPT_LIMIT_EXCEEDED → service「服务暂时不可用，请稍后重试」retryable=true（≥500 先于 RECEIPT 码，api.js:24 vs :25）", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(
      presentError(500, { error: { code: "RECEIPT_LIMIT_EXCEEDED" } }),
      "service",
      "服务暂时不可用，请稍后重试",
      { retryable: true },
    );
  });

  it("statusCode=503 + code=RECEIPT_FILE_INVALID → service（同口径：≥500 先于 RECEIPT_FILE_INVALID）", async () => {
    const { presentError } = await loadSrc("utils/errors.js");
    assertBranch(
      presentError(503, { error: { code: "RECEIPT_FILE_INVALID" } }),
      "service",
      "服务暂时不可用，请稍后重试",
      { retryable: true },
    );
  });
});
