// C 类纯逻辑测试：utils/digest.js（module-contracts §5.7；2026-10 小票 sha256 修复）。
// 契约：小票 ReceiptFileMetaSchema 在 init/complete 都强制 64-hex sha256，服务端 complete 用它
// 对账存储对象实测摘要——sha256Hex 必须对真实字节算出与服务端 createHash("sha256") 一致的值，
// 失败（File 缺失/不可读、crypto.subtle 不可用）一律抛可读中文错误，绝不返回占位/伪造摘要。
import { describe, it, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadSrc } from "../helpers/contract-paths.js";

// 已知真实字节摘要向量：与 node:crypto 对账（等价服务端 verifyObject 口径）。
const KNOWN_BYTES = "sample-receipt-bytes";
const KNOWN_SHA256 = createHash("sha256").update(KNOWN_BYTES).digest("hex");
const PNG_BYTES = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(512, 0x42)]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("utils/digest.js hasSha256Hex", () => {
  it("64-hex 大小写合法；非法形态（空/短/长/非 hex/非字符串/undefined）一律 false", async () => {
    const { hasSha256Hex, SHA256_HEX_PATTERN } = await loadSrc("utils/digest.js");
    assert.equal(hasSha256Hex(KNOWN_SHA256), true);
    assert.equal(hasSha256Hex(KNOWN_SHA256.toUpperCase()), true);
    assert.equal(hasSha256Hex(""), false);
    assert.equal(hasSha256Hex("a".repeat(63)), false);
    assert.equal(hasSha256Hex("a".repeat(65)), false);
    assert.equal(hasSha256Hex("g".repeat(64)), false);
    assert.equal(hasSha256Hex(null), false);
    assert.equal(hasSha256Hex(undefined), false);
    assert.ok(SHA256_HEX_PATTERN.test(KNOWN_SHA256));
  });
});

describe("utils/digest.js sha256Hex", () => {
  it("对真实字节算出与 node:crypto 一致的 64-hex 摘要（File 与 Blob 输入同值）", async () => {
    const { sha256Hex } = await loadSrc("utils/digest.js");
    const file = new File([KNOWN_BYTES], "sample-receipt.jpg", { type: "image/jpeg" });
    assert.equal(await sha256Hex(file), KNOWN_SHA256);
    assert.equal(await sha256Hex(new Blob([PNG_BYTES])), createHash("sha256").update(PNG_BYTES).digest("hex"));
  });

  it("同一文件重复计算结果稳定（init/complete 携带同一字符串的前提）", async () => {
    const { sha256Hex } = await loadSrc("utils/digest.js");
    const file = new File([KNOWN_BYTES], "sample-receipt.jpg", { type: "image/jpeg" });
    assert.equal(await sha256Hex(file), await sha256Hex(file));
  });

  it("file 缺失/无 arrayBuffer → 可读错误，不产生任何摘要", async () => {
    const { sha256Hex } = await loadSrc("utils/digest.js");
    await assert.rejects(() => sha256Hex(null), /图片文件已失效/);
    await assert.rejects(() => sha256Hex({}), /图片文件已失效/);
    await assert.rejects(() => sha256Hex(undefined), /图片文件已失效/);
  });

  it("crypto.subtle 不可用（非安全上下文）→ 可读错误引导换浏览器", async () => {
    const { sha256Hex } = await loadSrc("utils/digest.js");
    vi.stubGlobal("crypto", undefined);
    const file = new File([KNOWN_BYTES], "sample-receipt.jpg", { type: "image/jpeg" });
    await assert.rejects(() => sha256Hex(file), /不支持文件校验/);
    vi.unstubAllGlobals();
    vi.stubGlobal("crypto", {});
    await assert.rejects(() => sha256Hex(file), /不支持文件校验/);
  });

  it("字节读取失败（arrayBuffer reject）→ 可读错误而非裸 TypeError", async () => {
    const { sha256Hex } = await loadSrc("utils/digest.js");
    const brokenFile = { arrayBuffer: async () => { throw new Error("NotReadableError"); } };
    await assert.rejects(() => sha256Hex(brokenFile), /无法读取图片文件内容/);
  });
});
