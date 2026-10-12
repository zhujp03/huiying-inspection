// C 类纯逻辑测试：utils/upload-queue.js（module-contracts §5.6；语义来源 pages/dishes/index.js:235-243、rules.md R64）。
// 契约：createCancelledUploads() → { has(id), add(id), delete(id), size }——已取消上传 id 集合。
// 语义：add(id) 后 has(id) 恒为 true、size 计数（dishes js:213,220,223 回填前检查）；
// 显式重试是唯一复活通道——retryUpload 先 delete(id) 再重传（dishes/index.js:235 this.cancelledUploads?.delete(id)）；
// delete 后 has(id) 恢复 false、size 减一；delete 未知 id 无害。
//
// TDD 红灯基线：apps/web/src/utils/upload-queue.js 尚未实现，本文件全部用例预期因模块不存在而失败。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { loadSrc } from "../helpers/contract-paths.js";

describe("utils/upload-queue.js createCancelledUploads（R64 小票上传取消语义）", () => {
  it("导出面为 { has, add, delete, size }，初始态：任意 id 均未取消、size 为 0", async () => {
    const { createCancelledUploads } = await loadSrc("utils/upload-queue.js");
    const cancelled = createCancelledUploads();
    assert.equal(typeof cancelled.has, "function");
    assert.equal(typeof cancelled.add, "function");
    assert.equal(typeof cancelled.delete, "function");
    assert.equal(typeof cancelled.size, "number");
    assert.equal(cancelled.size, 0);
    assert.equal(cancelled.has("u1"), false);
    assert.equal(cancelled.has("u2"), false);
  });

  it("add(id) 后 has(id) 为 true、size 计数 +1（回填前检查命中即放弃回填）", async () => {
    const { createCancelledUploads } = await loadSrc("utils/upload-queue.js");
    const cancelled = createCancelledUploads();
    cancelled.add("u1");
    assert.equal(cancelled.has("u1"), true);
    assert.equal(cancelled.size, 1);
  });

  it("多次 add 累计计数：add u1 与 u2 后 size 为 2，且互不影响", async () => {
    const { createCancelledUploads } = await loadSrc("utils/upload-queue.js");
    const cancelled = createCancelledUploads();
    cancelled.add("u1");
    cancelled.add("u2");
    assert.equal(cancelled.size, 2);
    assert.equal(cancelled.has("u1"), true);
    assert.equal(cancelled.has("u2"), true);
  });

  it("delete(id) 后 has(id) 恢复 false、size 减一——显式重试是唯一复活通道（dishes/index.js:235）", async () => {
    const { createCancelledUploads } = await loadSrc("utils/upload-queue.js");
    const cancelled = createCancelledUploads();
    cancelled.add("u1");
    cancelled.add("u2");
    cancelled.delete("u1");
    assert.equal(cancelled.has("u1"), false);
    assert.equal(cancelled.has("u2"), true, "未删除的 id 不受影响");
    assert.equal(cancelled.size, 1);
  });

  it("delete 未知 id 无害：size 不变、不抛错", async () => {
    const { createCancelledUploads } = await loadSrc("utils/upload-queue.js");
    const cancelled = createCancelledUploads();
    cancelled.add("u1");
    cancelled.delete("u9");
    assert.equal(cancelled.size, 1);
    assert.equal(cancelled.has("u1"), true);
  });
});
