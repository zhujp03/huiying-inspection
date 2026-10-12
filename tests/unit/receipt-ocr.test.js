import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyOcrDishesOnce, deriveLineTotal, formatCentsToYuan, nextPollDelay, occupiedReceiptCount,
  parseYuanToCents, readyReceiptCount, receiptDeletionOptions, requiredReviewMessage,
  validateReceiptFiles,
} from "../../apps/miniapp/miniprogram/features/receipt-ocr.js";

const file = (name = "receipt.jpg", size = 1024) => ({ tempFilePath: `/tmp/${name}`, size, fileType: "image" });
const attachment = (id, status = "ready") => ({ id, status, origin: "server" });

describe("receipt selection and readiness", () => {
  it("accepts 0, 1 and 9 total images but rejects the tenth", () => {
    expect(validateReceiptFiles(0, [])).toBe("");
    expect(validateReceiptFiles(0, [file()])).toBe("");
    expect(validateReceiptFiles(4, Array.from({ length: 5 }, (_, index) => file(`${index}.png`)))).toBe("");
    expect(validateReceiptFiles(9, [file()])).toContain("最多只能上传 9 张");
  });

  it("rejects invalid type and size, and never counts local selection as ready", () => {
    expect(validateReceiptFiles(0, [{ ...file("receipt.gif"), fileType: "application/octet-stream" }])).toContain("图片");
    expect(validateReceiptFiles(0, [file("receipt.jpg", 10 * 1024 * 1024 + 1)])).toContain("10MB");
    expect(readyReceiptCount([attachment("one"), { status: "local_selected", origin: "local" }, attachment("two", "uploading")])).toBe(1);
    expect(occupiedReceiptCount([attachment("server")], [{ attachmentId: "server" }, { clientFileId: "local" }])).toBe(2);
  });
});

describe("integer-cent money", () => {
  it.each([["0", 0], ["0.1", 10], ["12.34", 1234], ["9999999.99", 999999999]])("parses %s exactly", (yuan, cents) => {
    expect(parseYuanToCents(yuan)).toBe(cents);
    expect(formatCentsToYuan(cents)).toBe(`${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`);
  });
  it.each(["-1", "1e3", "NaN", "Infinity", "1.234", "10000000"])("rejects %s", (value) => expect(() => parseYuanToCents(value)).toThrow());
  it("derives line totals without floating-point arithmetic", () => expect(deriveLineTotal(3, 1999, null)).toEqual({ lineTotalCents: 5997, priceDerived: true }));
});

describe("OCR application and recovery rules", () => {
  const required = { id: "required-row", requirementId: "requirement-one", plannedName: "招牌菜" };
  const incoming = [{ ...required, actualName: "招牌菜", quantity: 1 }];

  it("applies one job once and does not duplicate rows on a repeated result", () => {
    const first = applyOcrDishesOnce({ dishes: [required], appliedJobIds: [] }, "job-one", incoming);
    expect(first.applied).toBe(true);
    const second = applyOcrDishesOnce(first, "job-one", [...incoming, { id: "duplicate" }]);
    expect(second.applied).toBe(false);
    expect(second.dishes).toHaveLength(1);
  });

  it("refuses an apply result that drops or overwrites an administrator requirement", () => {
    expect(() => applyOcrDishesOnce({ dishes: [required], appliedJobIds: [] }, "job", [])).toThrow("菜品要求已更新");
    expect(() => applyOcrDishesOnce({ dishes: [required], appliedJobIds: [] }, "job", [{ ...incoming[0], plannedName: "另一道菜" }])).toThrow("菜品要求已更新");
  });

  it("uses progressive polling and surfaces required review fields", () => {
    expect([0, 1, 2, 3, 8].map(nextPollDelay)).toEqual([1000, 2000, 3000, 5000, 5000]);
    expect(requiredReviewMessage({ reviewFields: ["unitPriceCents"] })).toBe("");
    expect(requiredReviewMessage({ reviewFields: ["actualName"] })).toContain("核对");
  });

  it("requires an explicit server deletion handling choice", () => {
    expect(receiptDeletionOptions({ dishImpact: "none", appliedDishCount: 0 })).toEqual(["keep_as_manual"]);
    expect(receiptDeletionOptions({ dishImpact: "removable_auto_rows", appliedDishCount: 2 })).toEqual(["remove_unmodified_ocr_rows", "keep_as_manual"]);
    expect(receiptDeletionOptions({ dishImpact: "mixed", appliedDishCount: 2 })).toEqual(["keep_as_manual"]);
  });
});

describe("dishes page OCR lifecycle", () => {
  afterEach(() => { vi.useRealTimers(); delete globalThis.Page; delete globalThis.getApp; });

  it("stops polling while hidden and resumes only a known unfinished job on show", async () => {
    vi.useFakeTimers();
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?lifecycle-test");
    globalThis.getApp = () => ({ globalData: { publicConfig: { features: { receiptOcr: false } } } });
    const resumeOcr = vi.fn();
    const data = { loading: false, ocrView: { terminal: false }, pendingReceipts: [], ocrEnabled: false };
    const context = { ...pageConfig, data, recovery: { jobId: "known-job" }, routeMeta: null, resumeOcr, setData: (patch) => Object.assign(data, patch) };
    context.ocrTimer = setTimeout(() => {}, 5000);
    pageConfig.onHide.call(context);
    expect(context.pageVisible).toBe(false);
    expect(context.ocrTimer).toBeNull();
    pageConfig.onShow.call(context);
    expect(context.pageVisible).toBe(true);
    expect(resumeOcr).toHaveBeenCalledTimes(1);
    context.recovery = { jobId: null };
    pageConfig.onShow.call(context);
    expect(resumeOcr).toHaveBeenCalledTimes(1);
  });

  it("syncs the OCR entry visibility from client-config on show and stays hidden before config arrives", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?entry-test");
    const data = { ocrEnabled: false, loading: true, ocrView: { terminal: false }, pendingReceipts: [] };
    const context = { ...pageConfig, data, resumeOcr: vi.fn(), setData: (patch) => Object.assign(data, patch) };
    // publicConfig 未到达（getApp 为空）→ 保守隐藏，手动填写不受影响。
    globalThis.getApp = () => null;
    pageConfig.onShow.call(context);
    expect(data.ocrEnabled).toBe(false);
    // client-config 下发 features.receiptOcr=true → 入口显示；服务端关闭后回到隐藏。
    globalThis.getApp = () => ({ globalData: { publicConfig: { features: { receiptOcr: true } } } });
    pageConfig.onShow.call(context);
    expect(data.ocrEnabled).toBe(true);
    globalThis.getApp = () => ({ globalData: { publicConfig: { features: { receiptOcr: false } } } });
    pageConfig.onShow.call(context);
    expect(data.ocrEnabled).toBe(false);
  });
});
