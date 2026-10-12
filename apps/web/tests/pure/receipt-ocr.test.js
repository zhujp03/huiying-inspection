import { describe, expect, it } from "vitest";
import { loadSrc } from "../helpers/contract-paths.js";

// H5 镜像模块：features/receipt-ocr.js（契约 docs/web/module-contracts.md §6.1）。
// 期望值全部硬编码，逐条对照小程序源码 apps/miniapp/miniprogram/features/receipt-ocr.js（只读校准）。
const receiptOcr = await loadSrc("features/receipt-ocr.js");

const {
  MAX_RECEIPTS, MAX_RECEIPT_BYTES, MAX_MONEY_CENTS, OCR_POLL_DELAYS,
  readyReceiptCount, occupiedReceiptCount, validateReceiptFiles, parseYuanToCents,
  formatCentsToYuan, nextPollDelay, ocrStatusView, applyOcrDishesOnce,
  markDishEdited, deriveLineTotal, requiredReviewMessage, receiptDeletionOptions,
} = receiptOcr;

// 样例数据（非 fixture，见禁词红线）。
const sampleFile = (name = "receipt.jpg", size = 1024, fileType = "image") => ({ tempFilePath: `/tmp/${name}`, size, fileType });

describe("常量（receipt-ocr.js:1-4）", () => {
  it("张数/字节/金额上限与轮询间隔与源码一致", () => {
    expect(MAX_RECEIPTS).toBe(9);
    expect(MAX_RECEIPT_BYTES).toBe(10485760);
    expect(MAX_MONEY_CENTS).toBe(999999999);
    expect(OCR_POLL_DELAYS).toEqual([1000, 2000, 3000, 5000]);
  });
});

describe("validateReceiptFiles（receipt-ocr.js:15-24）", () => {
  it("0/1/9 张总数通过，第 10 张拒绝", () => {
    expect(validateReceiptFiles(0, [])).toBe("");
    expect(validateReceiptFiles(0, [sampleFile()])).toBe("");
    expect(validateReceiptFiles(8, [sampleFile("ninth.jpg")])).toBe("");
    expect(validateReceiptFiles(9, [sampleFile("tenth.jpg")])).toBe("最多只能上传 9 张消费小票");
    expect(validateReceiptFiles(0, Array.from({ length: 10 }, (_, index) => sampleFile(`${index}.jpg`)))).toBe("最多只能上传 9 张消费小票");
  });

  it("非图片类型拒绝", () => {
    expect(validateReceiptFiles(0, [{ ...sampleFile("receipt.gif"), fileType: "application/octet-stream" }])).toBe("请选择 10MB 以内的图片");
  });

  it("图片扩展名（.png/.jpeg）也算合法图片", () => {
    expect(validateReceiptFiles(0, [{ path: "/tmp/receipt.png", size: 1024 }])).toBe("");
    expect(validateReceiptFiles(0, [{ ...sampleFile(), fileType: "image/jpeg" }])).toBe("");
  });

  it("大小非法拒绝：超 10MB、恰好 10MB 通过、≤0、非有限", () => {
    expect(validateReceiptFiles(0, [sampleFile("big.jpg", 10 * 1024 * 1024)])).toBe("");
    expect(validateReceiptFiles(0, [sampleFile("big.jpg", 10 * 1024 * 1024 + 1)])).toBe("请选择 10MB 以内的图片");
    expect(validateReceiptFiles(0, [sampleFile("zero.jpg", 0)])).toBe("请选择 10MB 以内的图片");
    expect(validateReceiptFiles(0, [sampleFile("neg.jpg", -5)])).toBe("请选择 10MB 以内的图片");
    expect(validateReceiptFiles(0, [sampleFile("nan.jpg", NaN)])).toBe("请选择 10MB 以内的图片");
  });
});

describe("readyReceiptCount（receipt-ocr.js:6-8）", () => {
  it("只计 status 为 ready 且 origin 非 local 的条目", () => {
    expect(readyReceiptCount([
      { id: "r1", status: "ready", origin: "server" },
      { id: "r2", status: "ready", origin: "local" },
      { id: "r3", status: "uploading", origin: "server" },
    ])).toBe(1);
    expect(readyReceiptCount([])).toBe(0);
  });
});

describe("occupiedReceiptCount（receipt-ocr.js:10-13）", () => {
  it("服务端条目全占格；本地 pending 未落服务端 id 时占格", () => {
    const serverReceipts = [
      { id: "attachment-1", status: "ready", origin: "server" },
      { id: "attachment-2", status: "ready", origin: "server" },
    ];
    const pending = [
      { attachmentId: "attachment-1" }, // 已在服务端列表 → 不重复占格
      { attachmentId: "attachment-x" }, // 落了 id 但服务端还没有 → 占格
      { clientFileId: "local-1" },      // 未落 id → 占格
    ];
    expect(occupiedReceiptCount(serverReceipts, pending)).toBe(4);
    expect(occupiedReceiptCount(serverReceipts, [])).toBe(2);
  });
});

describe("parseYuanToCents / formatCentsToYuan（receipt-ocr.js:26-40）", () => {
  it.each([
    ["0", 0], ["0.1", 10], ["12.34", 1234], ["9999999.99", 999999999],
  ])("%s 元解析为 %s 分（整数分运算，无浮点误差）", (yuan, cents) => {
    expect(parseYuanToCents(yuan)).toBe(cents);
  });

  it("空串（含纯空白）返回 null", () => {
    expect(parseYuanToCents("")).toBeNull();
    expect(parseYuanToCents("   ")).toBeNull();
  });

  it.each(["-1", "1e3", "NaN", "Infinity", "1.234", "10000000"])("%s 格式非法直接 throw", (value) => {
    expect(() => parseYuanToCents(value)).toThrow("请输入正确的金额，最多保留两位小数");
  });

  it("formatCentsToYuan：null/undefined → 空串；非法 throw；0 与常规值格式化", () => {
    expect(formatCentsToYuan(null)).toBe("");
    expect(formatCentsToYuan(undefined)).toBe("");
    expect(formatCentsToYuan(0)).toBe("0.00");
    expect(formatCentsToYuan(5997)).toBe("59.97");
    expect(formatCentsToYuan(1234)).toBe("12.34");
    expect(formatCentsToYuan(999999999)).toBe("9999999.99");
    expect(() => formatCentsToYuan(-1)).toThrow("金额数据暂时无法使用");
    expect(() => formatCentsToYuan(12.5)).toThrow("金额数据暂时无法使用");
    expect(() => formatCentsToYuan(1000000000)).toThrow("金额数据暂时无法使用");
  });
});

describe("deriveLineTotal（receipt-ocr.js:72-78）", () => {
  it("数量×单价推算且 priceDerived 为 true", () => {
    expect(deriveLineTotal(3, 1999, null)).toEqual({ lineTotalCents: 5997, priceDerived: true });
  });
  it("显式行总价优先且 priceDerived 为 false", () => {
    expect(deriveLineTotal(3, 1999, 5000)).toEqual({ lineTotalCents: 5000, priceDerived: false });
  });
  it("数量/单价非法（未显式给值）返回 null 行总价", () => {
    expect(deriveLineTotal(0, 100, null)).toEqual({ lineTotalCents: null, priceDerived: false });
    expect(deriveLineTotal(-1, 100, null)).toEqual({ lineTotalCents: null, priceDerived: false });
    expect(deriveLineTotal(2, 10.5, null)).toEqual({ lineTotalCents: null, priceDerived: false });
  });
  it("超 MAX_MONEY_CENTS throw", () => {
    expect(() => deriveLineTotal(1000, 1000000, null)).toThrow("金额超出可填写范围");
  });
});

describe("nextPollDelay（receipt-ocr.js:42-44）", () => {
  it("按 OCR_POLL_DELAYS 递进并在末位封顶", () => {
    expect([0, 1, 2, 3, 8].map(nextPollDelay)).toEqual([1000, 2000, 3000, 5000, 5000]);
    expect(nextPollDelay(-1)).toBe(1000);
  });
});

describe("ocrStatusView（receipt-ocr.js:46-53）", () => {
  it("各 job 状态映射 label/tone/terminal", () => {
    expect(ocrStatusView(null)).toEqual({ label: "尚未识别", tone: "idle", terminal: true });
    expect(ocrStatusView({ status: "queued" })).toEqual({ label: "正在排队识别", tone: "working", terminal: false });
    expect(ocrStatusView({ status: "processing" })).toEqual({ label: "正在识别小票", tone: "working", terminal: false });
    expect(ocrStatusView({ status: "succeeded", recognizedDishCount: 3 })).toEqual({ label: "已识别 3 道菜", tone: "success", terminal: true });
    expect(ocrStatusView({ status: "partial", recognizedDishCount: 2 })).toEqual({ label: "已带入 2 道菜，请核对标记内容", tone: "review", terminal: true });
  });
  it("其余状态一律按失败兜底（仍可手动填写）", () => {
    expect(ocrStatusView({ status: "failed" })).toEqual({ label: "暂时无法识别这张小票，您仍可以手动填写菜品", tone: "failed", terminal: true });
    expect(ocrStatusView({ status: "unknown-state" })).toEqual({ label: "暂时无法识别这张小票，您仍可以手动填写菜品", tone: "failed", terminal: true });
  });
});

describe("applyOcrDishesOnce（receipt-ocr.js:55-65）", () => {
  const required = { id: "row-required", requirementId: "requirement-one", plannedName: "招牌菜" };
  const incoming = [{ ...required, actualName: "招牌菜", quantity: 1, reviewFields: ["quantity"] }];

  it("同 job 第二次应用幂等：applied false 且 dishes 不变", () => {
    const first = applyOcrDishesOnce({ dishes: [required], appliedJobIds: [] }, "job-one", incoming);
    expect(first.applied).toBe(true);
    expect(first.dishes).toEqual(incoming);
    expect(first.appliedJobIds).toEqual(["job-one"]);
    const second = applyOcrDishesOnce(first, "job-one", [...incoming, { id: "duplicate" }]);
    expect(second.applied).toBe(false);
    expect(second.dishes).toHaveLength(1);
  });

  it("丢必点菜 → throw「菜品要求已更新，请刷新后重试」", () => {
    expect(() => applyOcrDishesOnce({ dishes: [required], appliedJobIds: [] }, "job", [])).toThrow("菜品要求已更新，请刷新后重试");
  });

  it("改必点菜 plannedName → throw 同文案", () => {
    expect(() => applyOcrDishesOnce({ dishes: [required], appliedJobIds: [] }, "job", [{ ...incoming[0], plannedName: "另一道菜" }])).toThrow("菜品要求已更新，请刷新后重试");
  });

  it("多次成功应用时 appliedJobIds 累加登记", () => {
    const first = applyOcrDishesOnce({ dishes: [required], appliedJobIds: [] }, "job-one", incoming);
    const second = applyOcrDishesOnce(first, "job-two", incoming);
    expect(second.applied).toBe(true);
    expect(second.appliedJobIds).toEqual(["job-one", "job-two"]);
  });
});

describe("markDishEdited（receipt-ocr.js:67-70）", () => {
  it("置 manuallyModified 并从 reviewFields 移除被编辑字段", () => {
    const dish = { actualName: "旧名", quantity: 1, reviewFields: ["actualName", "quantity"] };
    expect(markDishEdited(dish, "actualName", "招牌菜")).toEqual({
      actualName: "招牌菜", quantity: 1, manuallyModified: true, reviewFields: ["quantity"],
    });
  });
  it("编辑不在 reviewFields 的字段时 reviewFields 保持不变", () => {
    const dish = { actualName: "旧名", reviewFields: ["quantity"] };
    const edited = markDishEdited(dish, "unitPriceCents", 1234);
    expect(edited.unitPriceCents).toBe(1234);
    expect(edited.manuallyModified).toBe(true);
    expect(edited.reviewFields).toEqual(["quantity"]);
  });
});

describe("requiredReviewMessage（receipt-ocr.js:80-83）", () => {
  it("reviewFields 含 actualName 或 quantity → 提示核对菜名和数量", () => {
    expect(requiredReviewMessage({ reviewFields: ["actualName", "quantity"] })).toBe("请核对菜名和数量后再继续");
    expect(requiredReviewMessage({ reviewFields: ["actualName"] })).toBe("请核对菜名和数量后再继续");
    expect(requiredReviewMessage({ reviewFields: ["quantity"] })).toBe("请核对菜名和数量后再继续");
  });
  it("仅非必核字段（unitPriceCents 等）或缺失 reviewFields → 空串", () => {
    expect(requiredReviewMessage({ reviewFields: ["unitPriceCents"] })).toBe("");
    expect(requiredReviewMessage({ reviewFields: [] })).toBe("");
    expect(requiredReviewMessage({})).toBe("");
  });
});

describe("receiptDeletionOptions（receipt-ocr.js:85-89）", () => {
  it("按 dishImpact/appliedDishCount 组合给出删除选项序列", () => {
    expect(receiptDeletionOptions({ dishImpact: "none", appliedDishCount: 3 })).toEqual(["keep_as_manual"]);
    expect(receiptDeletionOptions({ dishImpact: "removable_auto_rows", appliedDishCount: 2 })).toEqual(["remove_unmodified_ocr_rows", "keep_as_manual"]);
    expect(receiptDeletionOptions({ dishImpact: "mixed", appliedDishCount: 2 })).toEqual(["keep_as_manual"]);
  });
  it("空附件与 0 菜数一律只保留手动记录选项", () => {
    expect(receiptDeletionOptions(null)).toEqual(["keep_as_manual"]);
    expect(receiptDeletionOptions({ dishImpact: "removable_auto_rows", appliedDishCount: 0 })).toEqual(["keep_as_manual"]);
  });
});
