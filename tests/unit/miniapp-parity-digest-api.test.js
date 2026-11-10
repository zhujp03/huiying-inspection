import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { hasSha256Hex, sha256HexOfFile, sha256HexOfArrayBuffer } from "../../apps/miniapp/miniprogram/utils/digest.js";
import { BusinessError, presentError } from "../../apps/miniapp/miniprogram/services/api.js";

function sha256OfBytes(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function deterministicBytes(length) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + 17) & 0xff;
  return bytes;
}

describe("miniapp digest sha256HexOfArrayBuffer（与 node:crypto 标准答案逐例对比）", () => {
  it("空 buffer / \"abc\" / 55-56-63-64-65 字节块边界均与标准答案一致", () => {
    const cases = [deterministicBytes(0), deterministicBytes(3), deterministicBytes(55), deterministicBytes(56), deterministicBytes(63), deterministicBytes(64), deterministicBytes(65)];
    for (const bytes of cases) {
      const expected = sha256OfBytes(bytes);
      const actual = sha256HexOfArrayBuffer(bytes.buffer);
      expect(actual).toBe(expected);
      expect(actual).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(sha256HexOfArrayBuffer(deterministicBytes(0).buffer)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256HexOfArrayBuffer(new Uint8Array([97, 98, 99]).buffer)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("随机 1MB 与标准答案一致", () => {
    const bytes = new Uint8Array(randomBytes(1024 * 1024));
    expect(sha256HexOfArrayBuffer(bytes.slice().buffer)).toBe(sha256OfBytes(bytes));
  });

  it("同时接受 Uint8Array 输入（与 ArrayBuffer 等价）", () => {
    const bytes = deterministicBytes(100);
    expect(sha256HexOfArrayBuffer(bytes)).toBe(sha256OfBytes(bytes));
  });
});

describe("miniapp digest hasSha256Hex", () => {
  it("64 位十六进制（含大写）为正例", () => {
    expect(hasSha256Hex("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")).toBe(true);
    expect(hasSha256Hex("0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF")).toBe(true);
    expect(hasSha256Hex("a".repeat(64))).toBe(true);
  });

  it("空串、长度不对、含非 hex 字符、非字符串均为反例", () => {
    expect(hasSha256Hex("")).toBe(false);
    expect(hasSha256Hex("a".repeat(63))).toBe(false);
    expect(hasSha256Hex("a".repeat(65))).toBe(false);
    expect(hasSha256Hex(`${"g".repeat(64)}`)).toBe(false);
    expect(hasSha256Hex(`${"a".repeat(64)}x`)).toBe(false);
    expect(hasSha256Hex(null)).toBe(false);
    expect(hasSha256Hex(123)).toBe(false);
    expect(hasSha256Hex(undefined)).toBe(false);
  });
});

describe("miniapp digest sha256HexOfFile（mock wx.getFileSystemManager）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("成功：readFile 不传 encoding，读出 ArrayBuffer 后与标准答案一致", async () => {
    const bytes = deterministicBytes(777);
    let capturedOptions = null;
    vi.stubGlobal("wx", {
      getFileSystemManager: () => ({
        readFile(options) {
          capturedOptions = options;
          options.success({ data: bytes.slice().buffer });
        },
      }),
    });
    const hex = await sha256HexOfFile("wxfile://tmp/receipt.jpg");
    expect(hex).toBe(sha256OfBytes(bytes));
    expect(capturedOptions?.filePath).toBe("wxfile://tmp/receipt.jpg");
    expect("encoding" in capturedOptions).toBe(false);
  });

  it("失败：reject 的中文文案逐字一致", async () => {
    vi.stubGlobal("wx", {
      getFileSystemManager: () => ({
        readFile(options) {
          options.fail({ errMsg: "readFile:fail no such file or directory" });
        },
      }),
    });
    const error = await sha256HexOfFile("wxfile://tmp/missing.jpg").then((value) => value, (err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("图片文件已失效，请删除这张小票后重新选择上传");
  });
});

describe("miniapp presentError（与 H5 errors.js 对齐）", () => {
  it("409 带出 retryable 与 requiresNewToken，文案透传后端 message", () => {
    const retryableError = presentError(409, { error: { code: "SUBMIT_PROCESSING", message: "提交处理中，请稍后查看结果", retryable: true } });
    expect(retryableError).toBeInstanceOf(BusinessError);
    expect(retryableError.kind).toBe("conflict");
    expect(retryableError.message).toBe("提交处理中，请稍后查看结果");
    expect(retryableError.retryable).toBe(true);
    expect(retryableError.requiresNewToken).toBe(false);

    const tokenError = presentError(409, { error: { code: "TASK_OVERDUE", message: "任务已超时", requiresNewToken: true } });
    expect(tokenError.kind).toBe("conflict");
    expect(tokenError.requiresNewToken).toBe(true);
    expect(tokenError.retryable).toBe(false);
  });

  it("任意错误都带出 code：有业务码透传服务端原始码，无业务码为 null", () => {
    expect(presentError(404, { error: { code: "RECEIPT_NOT_FOUND", message: "小票不存在" } }).code).toBe("RECEIPT_NOT_FOUND");
    expect(presentError(409, { error: { code: "QUESTIONNAIRE_SUBMITTED" } }).code).toBe("QUESTIONNAIRE_SUBMITTED");
    expect(presentError(500, null).code).toBeNull();
    expect(presentError(400, { error: { message: "仅 message 无 code" } }).code).toBeNull();
    expect(presentError(400, undefined).code).toBeNull();
  });

  it("回归：除 409 外各分支 kind 与文案一字不改（码判断先于状态码）", () => {
    expect(presentError(401, { error: { code: "SMS_CODE_INVALIDATED" } })).toMatchObject({ kind: "sms_invalidated", message: "验证码已失效，请重新发送并完成人机验证" });
    expect(presentError(400, { error: { code: "SMS_CODE_ATTEMPTS_EXHAUSTED" } })).toMatchObject({ kind: "sms_invalidated", message: "验证码已失效，请重新发送并完成人机验证" });
    expect(presentError(409, { error: { code: "QUESTIONNAIRE_SUBMITTED" } })).toMatchObject({ kind: "questionnaire_submitted", message: "任务已提交，小票不可再查看或修改" });
    expect(presentError(400, { error: { code: "CAPTCHA_EXPIRED" } })).toMatchObject({ kind: "captcha_rejected", message: "验证已过期，请重新验证" });
    expect(presentError(400, { error: { code: "CAPTCHA_REJECTED" } })).toMatchObject({ kind: "captcha_rejected", message: "验证未通过，请重新验证" });
    expect(presentError(400, { error: { code: "CAPTCHA_CANCELLED" } })).toMatchObject({ kind: "captcha_rejected", message: "验证未通过，请重新验证" });
    expect(presentError(401, {})).toMatchObject({ kind: "session", message: "登录已失效，请重新登录" });
    expect(presentError(403, {})).toMatchObject({ kind: "forbidden", message: "你没有权限进行此操作" });
    expect(presentError(409, {})).toMatchObject({ kind: "conflict", message: "内容已更新，请刷新后重试" });
    expect(presentError(500, {})).toMatchObject({ kind: "service", message: "服务暂时不可用，请稍后重试", retryable: true });
    expect(presentError(503, null)).toMatchObject({ kind: "service", message: "服务暂时不可用，请稍后重试" });
    expect(presentError(400, { error: { code: "RECEIPT_LIMIT_EXCEEDED" } })).toMatchObject({ kind: "validation", message: "最多只能上传 9 张消费小票" });
    expect(presentError(400, { error: { code: "RECEIPT_FILE_INVALID" } })).toMatchObject({ kind: "validation", message: "请选择 10MB 以内的图片" });
    expect(presentError(404, {})).toMatchObject({ kind: "validation", message: "操作未完成，请检查填写内容" });
  });
});
