// dishes 页 H5 对齐（任务 E）：小票 SHA-256 贯穿 init/complete、失败重试一律重新 init、
// 忙碌结束自动续传（runQueuedUploads）、移除待传项同步服务端、pendingReceipts 兜底恢复、
// publicConfig 晚到补拉。services/api.js 整体 vi.mock 做行为测试；digest/survey store 走
// 真实实现（mock wx 文件系统与本地存储），与 tests/unit/miniapp-page-fixes.test.js 同风格。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getAssignment: vi.fn(),
  getDraft: vi.fn(),
  initializeReceiptUpload: vi.fn(),
  completeReceiptUpload: vi.fn(),
  deleteReceiptAttachment: vi.fn(),
  listReceiptAttachments: vi.fn(),
  uploadToSignedTarget: vi.fn(),
  saveDishes: vi.fn(),
  saveOtherRecords: vi.fn(),
  createReceiptOcrJob: vi.fn(),
  getReceiptOcrJob: vi.fn(),
  applyReceiptOcrJob: vi.fn(),
  initHighlightPhotoUpload: vi.fn(),
  completeHighlightPhotoUpload: vi.fn(),
  deleteHighlightPhoto: vi.fn(),
}));
vi.mock("../../apps/miniapp/miniprogram/services/api.js", () => apiMocks);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const SHA = "a".repeat(64);
const SESSION = { accessToken: "token", user: { id: "user-1" } };
const DRAFT_KEY = "junde:survey:user-1:assignment-1:attempt-1:qv-1";

function deterministicBytes(length) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + 17) & 0xff;
  return bytes;
}
function sha256OfBytes(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}
const pendingFixture = (overrides = {}) => ({ clientFileId: "client-1", localPath: "wxfile://tmp/r.jpg", sizeBytes: 100, mimeType: "image/jpeg", fileName: "r.jpg", status: "local_selected", progressPercent: 0, message: "等待上传", ...overrides });
const metaFixture = (overrides = {}) => ({ assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: 7, ...overrides });
const targetFixture = (url) => ({ method: "POST", url, fileFieldName: "file", formData: { key: "x" }, expiresAt: "2030-01-01T00:00:00Z" });

// 给一条 local_selected 待传项配好会成功的 init→直传→complete 链路。
function givenUploadChain({ attachmentId = "att-1", target = targetFixture("https://cos.test/new") } = {}) {
  apiMocks.initializeReceiptUpload.mockImplementation(async (attemptId, meta, revision) => ({
    revision: revision + 1,
    attachment: { id: attachmentId, displayOrder: 1, status: "uploading", progressPercent: 0 },
    uploadTarget: target,
  }));
  apiMocks.uploadToSignedTarget.mockResolvedValue({ etag: "etag-1" });
  apiMocks.completeReceiptUpload.mockImplementation(async (attemptId, attachment, meta, revision) => ({
    revision: revision + 1,
    attachment: { id: attachment, displayOrder: 1, status: "ready", progressPercent: 100, previewUrl: "https://cdn.test/p.jpg" },
    items: [{ id: attachment, displayOrder: 1, status: "ready", progressPercent: 100, previewUrl: "https://cdn.test/p.jpg" }],
  }));
}

function installWx({ files = {}, storage = {} } = {}) {
  const fileMap = new Map(Object.entries(files));
  const storeMap = new Map(Object.entries({ "junde:session": SESSION, ...storage }));
  const chooseMediaHandlers = [];
  globalThis.wx = {
    getStorageSync: (key) => (storeMap.has(key) ? storeMap.get(key) : ""),
    setStorageSync: (key, value) => { storeMap.set(key, value); },
    removeStorageSync: (key) => { storeMap.delete(key); },
    getFileSystemManager: () => ({
      readFile(options) {
        const bytes = fileMap.get(options.filePath);
        if (bytes) options.success({ data: bytes.slice().buffer });
        else options.fail({ errMsg: "readFile:fail no such file or directory" });
      },
    }),
    getImageInfo: (options) => options.success({ type: "jpeg" }),
    chooseMedia: (options) => { chooseMediaHandlers.push(options); },
    getRandomValues: (bytes) => { for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + 3) & 0xff; return bytes; },
    showToast: vi.fn(),
    showModal: vi.fn(),
    showActionSheet: vi.fn(),
    pageScrollTo: vi.fn(),
    previewImage: vi.fn(),
    navigateTo: vi.fn(),
    navigateBack: vi.fn(),
    redirectTo: vi.fn(),
    reLaunch: vi.fn(),
  };
  return { chooseMediaHandlers };
}

function installApp({ publicConfig } = {}) {
  const app = { globalData: { apiBase: "https://api.test", publicConfig: publicConfig ?? null } };
  globalThis.getApp = () => app;
  return app;
}

let pageConfig;
async function loadPage(tag) {
  globalThis.Page = (config) => { pageConfig = config; };
  if (tag === "upload-sha") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-upload-sha");
  else if (tag === "upload-sha-missing") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-upload-sha-missing");
  else if (tag === "retry-reinit") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-retry-reinit");
  else if (tag === "queue-serial") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-queue-serial");
  else if (tag === "queue-after-delete") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-queue-after-delete");
  else if (tag === "queue-choose") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-queue-choose");
  else if (tag === "queue-unloaded") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-queue-unloaded");
  else if (tag === "remove-local") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-remove-local");
  else if (tag === "remove-server") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-remove-server");
  else if (tag === "remove-replay") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-remove-replay");
  else if (tag === "remove-notfound") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-remove-notfound");
  else if (tag === "remove-notfound-listfail") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-remove-notfound-listfail");
  else if (tag === "remove-fail") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-remove-fail");
  else if (tag === "remove-busy") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-remove-busy");
  else if (tag === "load-peek") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-load-peek");
  else if (tag === "onload-config-late") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-onload-config-late");
  else if (tag === "onload-config-ready") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-onload-config-ready");
  else if (tag === "onload-config-unload") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-onload-config-unload");
  else if (tag === "onload-config-parallel") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-onload-config-parallel");
  else if (tag === "onload-config-gate-loading") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-onload-config-gate-loading");
  else if (tag === "onload-config-fail") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-onload-config-fail");
  else if (tag === "persist-sha") await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?parity-dishes-persist-sha");
  else throw new Error(`unknown page tag: ${tag}`);
  return pageConfig;
}

function makeContext(overrides = {}, extras = {}) {
  const data = { ...JSON.parse(JSON.stringify(pageConfig.data)), ...overrides };
  return { ...pageConfig, data, setData(patch) { Object.assign(this.data, patch); }, ...extras };
}

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; });

describe("小票上传：init 前对真实文件计算 SHA-256（对齐 H5 uploadPending）", () => {
  it("新选小票：先进入「正在校验图片」，init 与 complete 携带同一 64 位摘要", async () => {
    const bytes = deterministicBytes(777);
    pageConfig = await loadPage("upload-sha");
    installWx({ files: { "wxfile://tmp/r.jpg": bytes } });
    installApp({ publicConfig: { features: {} } });
    const context = makeContext({ pendingReceipts: [pendingFixture()] }, { routeMeta: metaFixture() });
    // 「正在校验图片」发生在 readFile 被调用的时刻；摘要算完写回后消息恢复为「准备上传」（H5 同款）。
    let messageAtDigest = "";
    const baseFs = globalThis.wx.getFileSystemManager;
    globalThis.wx.getFileSystemManager = () => {
      const fs = baseFs();
      const originalRead = fs.readFile.bind(fs);
      fs.readFile = (options) => {
        messageAtDigest = context.data.pendingReceipts.find((item) => item.clientFileId === "client-1")?.message || "";
        originalRead(options);
      };
      return fs;
    };
    apiMocks.initializeReceiptUpload.mockResolvedValue({ revision: 8, attachment: { id: "att-1", displayOrder: 1, status: "uploading", progressPercent: 0 }, uploadTarget: targetFixture("https://cos.test/u") });
    apiMocks.uploadToSignedTarget.mockResolvedValue({ etag: "etag-1" });
    apiMocks.completeReceiptUpload.mockResolvedValue({ revision: 9, attachment: { id: "att-1", displayOrder: 1, status: "ready", progressPercent: 100 }, items: [{ id: "att-1", displayOrder: 1, status: "ready", progressPercent: 100 }] });
    await pageConfig.uploadPending.call(context, "client-1");
    const expectedSha = sha256OfBytes(bytes);
    expect(messageAtDigest).toBe("正在校验图片");
    expect(apiMocks.initializeReceiptUpload).toHaveBeenCalledTimes(1);
    const initMeta = apiMocks.initializeReceiptUpload.mock.calls[0][1];
    expect(initMeta).toMatchObject({ clientFileId: "client-1", fileName: "r.jpg", mimeType: "image/jpeg", sizeBytes: 100 });
    expect(initMeta.sha256).toBe(expectedSha);
    expect(initMeta.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(apiMocks.completeReceiptUpload).toHaveBeenCalledTimes(1);
    const completeMeta = apiMocks.completeReceiptUpload.mock.calls[0][2];
    expect(completeMeta.sha256).toBe(expectedSha);
    expect(completeMeta.etag).toBe("etag-1");
    expect(context.data.pendingReceipts).toHaveLength(0);
  });

  it("文件读取失败：置 failed 显示 digest 可读文案，且不发出任何网络请求", async () => {
    pageConfig = await loadPage("upload-sha-missing");
    installWx({ files: {} });
    installApp({ publicConfig: { features: {} } });
    const context = makeContext({ pendingReceipts: [pendingFixture({ localPath: "wxfile://tmp/gone.jpg" })] }, { routeMeta: metaFixture() });
    await pageConfig.uploadPending.call(context, "client-1");
    expect(context.data.pendingReceipts).toHaveLength(1);
    expect(context.data.pendingReceipts[0].status).toBe("failed");
    expect(context.data.pendingReceipts[0].message).toBe("图片文件已失效，请删除这张小票后重新选择上传");
    expect(apiMocks.initializeReceiptUpload).not.toHaveBeenCalled();
    expect(apiMocks.uploadToSignedTarget).not.toHaveBeenCalled();
    expect(apiMocks.completeReceiptUpload).not.toHaveBeenCalled();
  });
});

describe("失败重试一律重新 init（对齐 H5 uploadPending base 分支）", () => {
  it("failed 项重试：清空旧 uploadTarget 重新 init，绝不复用旧签名地址", async () => {
    const bytes = deterministicBytes(100);
    const oldTarget = targetFixture("https://cos.test/old");
    const newTarget = targetFixture("https://cos.test/new");
    pageConfig = await loadPage("retry-reinit");
    installWx({ files: { "wxfile://tmp/r.jpg": bytes } });
    installApp({ publicConfig: { features: {} } });
    const context = makeContext({
      pendingReceipts: [pendingFixture({ status: "failed", progressPercent: 1, message: "暂时无法上传小票，请重试", attachmentId: "att-9", uploadTarget: oldTarget, sha256: sha256OfBytes(bytes) })],
    }, { routeMeta: metaFixture() });
    apiMocks.initializeReceiptUpload.mockResolvedValue({ revision: 8, attachment: { id: "att-9", displayOrder: 1, status: "uploading", progressPercent: 0 }, uploadTarget: newTarget });
    apiMocks.uploadToSignedTarget.mockResolvedValue({ etag: "etag-2" });
    apiMocks.completeReceiptUpload.mockResolvedValue({ revision: 9, attachment: { id: "att-9", displayOrder: 1, status: "ready", progressPercent: 100 }, items: [] });
    await pageConfig.uploadPending.call(context, "client-1");
    expect(apiMocks.initializeReceiptUpload).toHaveBeenCalledTimes(1);
    expect(apiMocks.initializeReceiptUpload.mock.calls[0][1].clientFileId).toBe("client-1");
    const uploadedTarget = apiMocks.uploadToSignedTarget.mock.calls[0][0];
    expect(uploadedTarget).toBe(newTarget);
    expect(uploadedTarget).not.toBe(oldTarget);
    expect(apiMocks.completeReceiptUpload.mock.calls[0][1]).toBe("att-9");
    expect(context.data.pendingReceipts).toHaveLength(0);
  });
});

describe("忙碌结束自动续传（对齐 H5 runQueuedUploads/applyReceiptBusy）", () => {
  it("串行上传所有 local_selected 项，重入被实例标志拦下", async () => {
    const bytesA = deterministicBytes(10);
    const bytesB = deterministicBytes(11);
    pageConfig = await loadPage("queue-serial");
    installWx({ files: { "wxfile://tmp/a.jpg": bytesA, "wxfile://tmp/b.jpg": bytesB } });
    installApp({ publicConfig: { features: {} } });
    const context = makeContext({
      pendingReceipts: [
        pendingFixture({ clientFileId: "client-1", localPath: "wxfile://tmp/a.jpg" }),
        pendingFixture({ clientFileId: "client-2", localPath: "wxfile://tmp/b.jpg" }),
      ],
    }, { routeMeta: metaFixture() });
    apiMocks.initializeReceiptUpload.mockImplementation(async (attemptId, meta, revision) => ({
      revision: revision + 1,
      attachment: { id: `att-${meta.clientFileId}`, displayOrder: 1, status: "uploading", progressPercent: 0 },
      uploadTarget: targetFixture(`https://cos.test/${meta.clientFileId}`),
    }));
    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    let uploadCalls = 0;
    apiMocks.uploadToSignedTarget.mockImplementation(() => {
      uploadCalls += 1;
      if (uploadCalls === 1) return gateA.then(() => ({ etag: "etag-1" }));
      return Promise.resolve({ etag: "etag-2" });
    });
    apiMocks.completeReceiptUpload.mockResolvedValue({ revision: 9, attachment: { id: "att-x", displayOrder: 1, status: "ready", progressPercent: 100 }, items: [] });
    const queue = pageConfig.runQueuedUploads.call(context);
    await flush();
    expect(apiMocks.uploadToSignedTarget).toHaveBeenCalledTimes(1);
    await pageConfig.runQueuedUploads.call(context);
    expect(apiMocks.uploadToSignedTarget).toHaveBeenCalledTimes(1);
    releaseA();
    await queue;
    await flush();
    expect(apiMocks.initializeReceiptUpload).toHaveBeenCalledTimes(2);
    expect(apiMocks.uploadToSignedTarget).toHaveBeenCalledTimes(2);
    expect(context.data.pendingReceipts).toHaveLength(0);
  });

  it("confirmDeleteReceipt 释放忙碌后自动续传 local_selected 项", async () => {
    const bytes = deterministicBytes(12);
    pageConfig = await loadPage("queue-after-delete");
    installWx({ files: { "wxfile://tmp/c.jpg": bytes } });
    installApp({ publicConfig: { features: {} } });
    const context = makeContext({
      receipts: [{ id: "att-1", displayOrder: 1, status: "ready", progressPercent: 100, canDelete: true, previewUrl: "https://cdn.test/p.jpg" }],
      pendingReceipts: [pendingFixture({ clientFileId: "client-c", localPath: "wxfile://tmp/c.jpg" })],
    }, { routeMeta: metaFixture() });
    apiMocks.deleteReceiptAttachment.mockResolvedValue({ revision: 6, items: [], dishes: [] });
    givenUploadChain({ attachmentId: "att-c" });
    await pageConfig.confirmDeleteReceipt.call(context, { id: "att-1", canDelete: true, displayOrder: 1 }, "keep_as_manual");
    await flush();
    await flush();
    expect(apiMocks.deleteReceiptAttachment).toHaveBeenCalledTimes(1);
    expect(apiMocks.initializeReceiptUpload).toHaveBeenCalledTimes(1);
    expect(apiMocks.initializeReceiptUpload.mock.calls[0][1].clientFileId).toBe("client-c");
    expect(context.data.pendingReceipts).toHaveLength(0);
  });

  it("忙碌期间新选的图片：忙碌结束后自动开始上传", async () => {
    const bytes = deterministicBytes(13);
    pageConfig = await loadPage("queue-choose");
    const { chooseMediaHandlers } = installWx({ files: { "wxfile://tmp/c.jpg": bytes } });
    installApp({ publicConfig: { features: {} } });
    const context = makeContext({
      receipts: [{ id: "att-1", displayOrder: 1, status: "ready", progressPercent: 100, canDelete: true, previewUrl: "https://cdn.test/p.jpg" }],
      pendingReceipts: [],
    }, { routeMeta: metaFixture() });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    apiMocks.deleteReceiptAttachment.mockImplementation(() => gate.then(() => ({ revision: 6, items: [], dishes: [] })));
    givenUploadChain({ attachmentId: "att-c" });
    pageConfig.chooseReceipts.call(context);
    expect(chooseMediaHandlers).toHaveLength(1);
    const busyOp = pageConfig.confirmDeleteReceipt.call(context, { id: "att-1", canDelete: true, displayOrder: 1 }, "keep_as_manual");
    chooseMediaHandlers[0].success({ tempFiles: [{ tempFilePath: "wxfile://tmp/c.jpg", size: 13 }] });
    await flush();
    expect(context.data.pendingReceipts).toHaveLength(1);
    expect(context.data.pendingReceipts[0].status).toBe("local_selected");
    expect(apiMocks.initializeReceiptUpload).not.toHaveBeenCalled();
    release();
    await busyOp;
    await flush();
    await flush();
    expect(apiMocks.initializeReceiptUpload).toHaveBeenCalledTimes(1);
    expect(apiMocks.completeReceiptUpload).toHaveBeenCalledTimes(1);
    expect(context.data.pendingReceipts).toHaveLength(0);
  });

  it("页面已卸载后不再自动续传（对齐 H5 unloadedRef 守卫）", async () => {
    pageConfig = await loadPage("queue-unloaded");
    installWx({ files: { "wxfile://tmp/c.jpg": deterministicBytes(14) } });
    installApp({ publicConfig: { features: {} } });
    const context = makeContext({
      receipts: [{ id: "att-1", displayOrder: 1, status: "ready", progressPercent: 100, canDelete: true, previewUrl: "https://cdn.test/p.jpg" }],
      pendingReceipts: [pendingFixture({ clientFileId: "client-c" })],
    }, { routeMeta: metaFixture(), unloaded: true });
    apiMocks.deleteReceiptAttachment.mockResolvedValue({ revision: 6, items: [], dishes: [] });
    givenUploadChain({ attachmentId: "att-c" });
    await pageConfig.confirmDeleteReceipt.call(context, { id: "att-1", canDelete: true, displayOrder: 1 }, "keep_as_manual");
    await flush();
    await flush();
    expect(apiMocks.deleteReceiptAttachment).toHaveBeenCalledTimes(1);
    expect(apiMocks.initializeReceiptUpload).not.toHaveBeenCalled();
    expect(context.data.pendingReceipts).toHaveLength(1);
  });
});

describe("移除待传项同步服务端（对齐 H5 removePending/dropPendingLocally）", () => {
  it("无 attachmentId 且无有效 sha256：仅本地移除，不发任何请求", async () => {
    pageConfig = await loadPage("remove-local");
    installWx();
    installApp({ publicConfig: { features: {} } });
    const context = makeContext({ pendingReceipts: [pendingFixture()] }, { routeMeta: metaFixture() });
    await pageConfig.removePending.call(context, { currentTarget: { dataset: { id: "client-1" } } });
    expect(apiMocks.initializeReceiptUpload).not.toHaveBeenCalled();
    expect(apiMocks.deleteReceiptAttachment).not.toHaveBeenCalled();
    expect(context.data.pendingReceipts).toHaveLength(0);
  });

  it("已 init 的待传项移除：deleteReceiptAttachment(keep_as_manual) 成功后采纳 items/dishes 并本地移除", async () => {
    pageConfig = await loadPage("remove-server");
    installWx();
    installApp({ publicConfig: { features: {} } });
    const context = makeContext({
      pendingReceipts: [pendingFixture({ attachmentId: "att-5", sha256: SHA })],
      receipts: [{ id: "att-5", displayOrder: 1, status: "uploading", progressPercent: 0, canDelete: true }],
    }, { routeMeta: metaFixture() });
    apiMocks.deleteReceiptAttachment.mockResolvedValue({
      revision: 12,
      items: [{ id: "att-1", displayOrder: 1, status: "ready", progressPercent: 100, previewUrl: "https://cdn.test/p.jpg" }],
      dishes: [{ id: "dish-1", requirementId: null, plannedName: "", actualName: "红烧肉", quantity: 1, unitPriceCents: null, lineTotalCents: null, fulfillmentStatus: "extra", source: "manual", manuallyModified: false, priceDerived: false, reviewFields: [] }],
    });
    await pageConfig.removePending.call(context, { currentTarget: { dataset: { id: "client-1" } } });
    expect(apiMocks.initializeReceiptUpload).not.toHaveBeenCalled();
    expect(apiMocks.deleteReceiptAttachment).toHaveBeenCalledTimes(1);
    expect(apiMocks.deleteReceiptAttachment.mock.calls[0]).toEqual(["attempt-1", "att-5", "keep_as_manual", 7]);
    expect(context.data.pendingReceipts).toHaveLength(0);
    expect(context.data.receipts.map((item) => item.id)).toEqual(["att-1"]);
    expect(context.data.dishes.map((dish) => dish.actualName)).toEqual(["红烧肉"]);
    expect(context.routeMeta.revision).toBe(12);
  });

  it("attachmentId 未知但 sha256 有效：幂等重放 init 找回服务端行后再删除", async () => {
    pageConfig = await loadPage("remove-replay");
    installWx();
    installApp({ publicConfig: { features: {} } });
    const context = makeContext({ pendingReceipts: [pendingFixture({ sha256: SHA })] }, { routeMeta: metaFixture() });
    apiMocks.initializeReceiptUpload.mockResolvedValue({ revision: 8, attachment: { id: "att-7", displayOrder: 1, status: "uploading", progressPercent: 0 } });
    apiMocks.deleteReceiptAttachment.mockResolvedValue({ revision: 9, items: [], dishes: [] });
    await pageConfig.removePending.call(context, { currentTarget: { dataset: { id: "client-1" } } });
    expect(apiMocks.initializeReceiptUpload).toHaveBeenCalledTimes(1);
    expect(apiMocks.initializeReceiptUpload.mock.calls[0][1]).toMatchObject({ clientFileId: "client-1", sha256: SHA });
    expect(apiMocks.deleteReceiptAttachment).toHaveBeenCalledTimes(1);
    expect(apiMocks.deleteReceiptAttachment.mock.calls[0]).toEqual(["attempt-1", "att-7", "keep_as_manual", 8]);
    expect(context.data.pendingReceipts).toHaveLength(0);
  });

  it("删除返回 RECEIPT_NOT_FOUND：尽力刷新一次列表后按幂等清理本地", async () => {
    pageConfig = await loadPage("remove-notfound");
    installWx();
    installApp({ publicConfig: { features: {} } });
    const context = makeContext({ pendingReceipts: [pendingFixture({ attachmentId: "att-5", sha256: SHA })] }, { routeMeta: metaFixture() });
    apiMocks.deleteReceiptAttachment.mockRejectedValue(Object.assign(new Error("小票不存在"), { code: "RECEIPT_NOT_FOUND" }));
    apiMocks.listReceiptAttachments.mockResolvedValue({ revision: 10, items: [{ id: "att-2", displayOrder: 1, status: "ready", progressPercent: 100, previewUrl: "https://cdn.test/p.jpg" }] });
    await pageConfig.removePending.call(context, { currentTarget: { dataset: { id: "client-1" } } });
    expect(apiMocks.listReceiptAttachments).toHaveBeenCalledTimes(1);
    expect(context.data.pendingReceipts).toHaveLength(0);
    expect(context.data.receipts.map((item) => item.id)).toEqual(["att-2"]);
  });

  it("RECEIPT_NOT_FOUND 且列表刷新也失败：仍按幂等清理本地", async () => {
    pageConfig = await loadPage("remove-notfound-listfail");
    installWx();
    installApp({ publicConfig: { features: {} } });
    const context = makeContext({ pendingReceipts: [pendingFixture({ attachmentId: "att-5", sha256: SHA })] }, { routeMeta: metaFixture() });
    apiMocks.deleteReceiptAttachment.mockRejectedValue(Object.assign(new Error("小票已删除"), { code: "RECEIPT_DELETED" }));
    apiMocks.listReceiptAttachments.mockRejectedValue(new Error("列表刷新失败"));
    await pageConfig.removePending.call(context, { currentTarget: { dataset: { id: "client-1" } } });
    expect(apiMocks.listReceiptAttachments).toHaveBeenCalledTimes(1);
    expect(context.data.pendingReceipts).toHaveLength(0);
  });

  it("其它删除错误：保留待传项置 failed 并显示可读文案，不在本地删掉", async () => {
    pageConfig = await loadPage("remove-fail");
    installWx();
    installApp({ publicConfig: { features: {} } });
    const context = makeContext({ pendingReceipts: [pendingFixture({ attachmentId: "att-5", sha256: SHA })] }, { routeMeta: metaFixture() });
    apiMocks.deleteReceiptAttachment.mockRejectedValue(new Error("删除小票失败"));
    await pageConfig.removePending.call(context, { currentTarget: { dataset: { id: "client-1" } } });
    expect(context.data.pendingReceipts).toHaveLength(1);
    expect(context.data.pendingReceipts[0].status).toBe("failed");
    expect(context.data.pendingReceipts[0].message).toBe("删除小票失败");
  });

  it("忙碌中移除已 init 项：登记取消后直接返回，不发删除请求也不本地删除", async () => {
    pageConfig = await loadPage("remove-busy");
    installWx();
    installApp({ publicConfig: { features: {} } });
    const context = makeContext({ pendingReceipts: [pendingFixture({ attachmentId: "att-5", sha256: SHA })], receiptBusy: true }, { routeMeta: metaFixture() });
    await pageConfig.removePending.call(context, { currentTarget: { dataset: { id: "client-1" } } });
    expect(apiMocks.deleteReceiptAttachment).not.toHaveBeenCalled();
    expect(apiMocks.initializeReceiptUpload).not.toHaveBeenCalled();
    expect(context.data.pendingReceipts).toHaveLength(1);
    expect(context.cancelledUploads.has("client-1")).toBe(true);
  });
});

describe("待传清单兜底恢复（对齐 H5 load 的 peekDraft 分支）", () => {
  it("getLocalDraft.receiptRecovery 为空（revision 已前进）时用 peekDraft 兜底恢复待传清单", async () => {
    pageConfig = await loadPage("load-peek");
    const stalePending = pendingFixture({ clientFileId: "client-9", localPath: "wxfile://tmp/s.jpg", sha256: SHA });
    installWx({ storage: { [DRAFT_KEY]: { revision: 5, synced: false, dishes: [], highlights: [], receiptRecovery: { pendingReceipts: [stalePending], jobId: null, applyKey: null, appliedJobId: null } } } });
    installApp({ publicConfig: { features: {} } });
    apiMocks.getAssignment.mockResolvedValue({ status: "draft", receiptRequired: true });
    apiMocks.getDraft.mockResolvedValue({
      attempt: { id: "attempt-1", status: "draft", revision: 2 },
      questionnaireVersion: { id: "qv-1" },
      questions: [], answers: {}, dishes: [], dishRequirements: [], otherRecords: {},
    });
    apiMocks.listReceiptAttachments.mockResolvedValue({ revision: 2, items: [] });
    const context = makeContext({}, { routeMeta: metaFixture({ revision: 2 }) });
    await pageConfig.load.call(context);
    expect(context.data.loading).toBe(false);
    expect(context.data.pendingReceipts).toHaveLength(1);
    expect(context.data.pendingReceipts[0].clientFileId).toBe("client-9");
    expect(context.data.pendingReceipts[0].origin).toBe("local");
    expect(context.data.pendingReceipts[0].statusLabel).toBe("等待上传");
    expect(apiMocks.listReceiptAttachments).toHaveBeenCalledTimes(1);
  });
});

describe("配置晚到（onLoad publicConfig 兜底补拉）", () => {
  it("onLoad 时 publicConfig 未到达：loadPublicConfig 返回后补跑 syncOcrEntry", async () => {
    pageConfig = await loadPage("onload-config-late");
    const app = installApp({});
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    app.loadPublicConfig = vi.fn(async () => { await gate; app.globalData.publicConfig = { features: { receiptOcr: true } }; });
    apiMocks.getAssignment.mockImplementation(() => new Promise(() => {}));
    const context = makeContext({}, {});
    pageConfig.onLoad.call(context, { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: "2" });
    await flush();
    expect(app.loadPublicConfig).toHaveBeenCalledTimes(1);
    expect(context.data.ocrEnabled).toBe(false);
    release();
    await flush();
    await flush();
    expect(context.data.ocrEnabled).toBe(true);
  });

  it("publicConfig 已就绪时不重复拉配置", async () => {
    pageConfig = await loadPage("onload-config-ready");
    const app = installApp({ publicConfig: { features: { receiptOcr: false } } });
    app.loadPublicConfig = vi.fn();
    installWx();
    apiMocks.getAssignment.mockResolvedValue({ status: "draft", receiptRequired: false });
    apiMocks.getDraft.mockResolvedValue({
      attempt: { id: "attempt-1", status: "draft", revision: 7 },
      questionnaireVersion: { id: "qv-1" },
      questions: [], answers: {}, dishes: [], dishRequirements: [], otherRecords: {},
    });
    apiMocks.listReceiptAttachments.mockResolvedValue({ revision: 7, items: [] });
    const context = makeContext({}, { routeMeta: metaFixture() });
    await pageConfig.onLoad.call(context, { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: "7" });
    expect(app.loadPublicConfig).not.toHaveBeenCalled();
    expect(context.data.loading).toBe(false);
  });

  it("页面已卸载：配置晚到后不再补跑 syncOcrEntry", async () => {
    pageConfig = await loadPage("onload-config-unload");
    const app = installApp({});
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    app.loadPublicConfig = vi.fn(async () => { await gate; app.globalData.publicConfig = { features: { receiptOcr: true } }; });
    apiMocks.getAssignment.mockImplementation(() => new Promise(() => {}));
    const context = makeContext({}, {});
    pageConfig.onLoad.call(context, { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: "2" });
    await flush();
    pageConfig.onUnload.call(context);
    release();
    await flush();
    await flush();
    expect(app.loadPublicConfig).toHaveBeenCalledTimes(1);
    expect(context.data.ocrEnabled).toBe(false);
  });

  it("配置请求在途：getAssignment/getDraft 已并行发出，不被配置阻塞", async () => {
    pageConfig = await loadPage("onload-config-parallel");
    const app = installApp({});
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    app.loadPublicConfig = vi.fn(async () => { await gate; app.globalData.publicConfig = { features: {} }; });
    installWx();
    apiMocks.getAssignment.mockResolvedValue({ status: "draft", receiptRequired: false });
    apiMocks.getDraft.mockResolvedValue({
      attempt: { id: "attempt-1", status: "draft", revision: 7 },
      questionnaireVersion: { id: "qv-1" },
      questions: [], answers: {}, dishes: [], dishRequirements: [], otherRecords: {},
    });
    apiMocks.listReceiptAttachments.mockResolvedValue({ revision: 7, items: [] });
    const context = makeContext({}, { routeMeta: metaFixture() });
    const onLoadPromise = pageConfig.onLoad.call(context, { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: "7" });
    await flush();
    expect(app.loadPublicConfig).toHaveBeenCalledTimes(1);
    expect(apiMocks.getAssignment).toHaveBeenCalledTimes(1);
    expect(apiMocks.getDraft).toHaveBeenCalledTimes(1);
    release();
    await onLoadPromise;
    expect(context.data.loading).toBe(false);
  });

  it("数据已返回而配置未到：loading 保持 true；放行后 loading 置 false 且入口按新配置求值", async () => {
    pageConfig = await loadPage("onload-config-gate-loading");
    const app = installApp({});
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    app.loadPublicConfig = vi.fn(async () => { await gate; app.globalData.publicConfig = { features: { receiptOcr: true, dishRecords: true } }; });
    installWx();
    apiMocks.getAssignment.mockResolvedValue({ status: "draft", receiptRequired: false });
    apiMocks.getDraft.mockResolvedValue({
      attempt: { id: "attempt-1", status: "draft", revision: 7 },
      questionnaireVersion: { id: "qv-1" },
      questions: [], answers: {}, dishes: [], dishRequirements: [], otherRecords: {},
    });
    apiMocks.listReceiptAttachments.mockResolvedValue({ revision: 7, items: [] });
    const context = makeContext({}, { routeMeta: metaFixture() });
    const onLoadPromise = pageConfig.onLoad.call(context, { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: "7" });
    await flush();
    await flush();
    expect(context.data.loading).toBe(true);
    release();
    await onLoadPromise;
    expect(context.data.loading).toBe(false);
    expect(context.data.ocrEnabled).toBe(true);
    expect(context.data.dishEnabled).toBe(true);
  });

  it("loadPublicConfig reject 或返回 null：loading 照常解除，不卡住", async () => {
    pageConfig = await loadPage("onload-config-fail");
    installWx();
    apiMocks.getAssignment.mockResolvedValue({ status: "draft", receiptRequired: false });
    apiMocks.getDraft.mockResolvedValue({
      attempt: { id: "attempt-1", status: "draft", revision: 7 },
      questionnaireVersion: { id: "qv-1" },
      questions: [], answers: {}, dishes: [], dishRequirements: [], otherRecords: {},
    });
    apiMocks.listReceiptAttachments.mockResolvedValue({ revision: 7, items: [] });
    const rejectApp = installApp({});
    rejectApp.loadPublicConfig = vi.fn(async () => { throw new Error("config request failed"); });
    const rejectContext = makeContext({}, { routeMeta: metaFixture() });
    await pageConfig.onLoad.call(rejectContext, { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: "7" });
    expect(rejectContext.data.loading).toBe(false);
    expect(rejectContext.data.error).toBe("");
    apiMocks.getAssignment.mockClear();
    const nullApp = installApp({});
    nullApp.loadPublicConfig = vi.fn(async () => null);
    const nullContext = makeContext({}, { routeMeta: metaFixture() });
    await pageConfig.onLoad.call(nullContext, { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: "7" });
    expect(nullContext.data.loading).toBe(false);
    expect(nullContext.data.error).toBe("");
  });
});

describe("摘要持久化与静态契约", () => {
  it("stripPendingSecrets 保留 sha256、剔除 uploadTarget（恢复与重试可复用摘要）", async () => {
    pageConfig = await loadPage("persist-sha");
    installWx();
    installApp({ publicConfig: { features: {} } });
    const context = makeContext({
      pendingReceipts: [pendingFixture({ status: "failed", attachmentId: "att-5", sha256: SHA, uploadTarget: targetFixture("https://cos.test/old") })],
    }, { routeMeta: metaFixture({ revision: 2 }) });
    context.persistLocal();
    const saved = globalThis.wx.getStorageSync(DRAFT_KEY);
    const stored = saved.receiptRecovery.pendingReceipts[0];
    expect(stored.sha256).toBe(SHA);
    expect(stored.attachmentId).toBe("att-5");
    expect(stored.uploadTarget).toBeUndefined();
  });

  it("页面源码包含摘要/续传/兜底实现，且不引入时间戳业务 ID", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const source = readFileSync(resolve(repoRoot, "apps/miniapp/miniprogram/pages/dishes/index.js"), "utf8");
    expect(source).toContain("hasSha256Hex");
    expect(source).toContain("sha256HexOfFile");
    expect(source).toContain("正在校验图片");
    expect(source).toContain("runQueuedUploads");
    expect(source).toContain("peekDraft");
    expect(source).toContain("loadPublicConfig");
    expect(source).toContain("keep_as_manual");
    expect(source).not.toMatch(/Date\.now/);
  });
});
