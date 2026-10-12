import { describe, expect, it } from "vitest";
import { parseReceiptLines } from "../../apps/worker/src/receipt-parser.js";

const line = (text, confidence = 0.9) => ({ text, confidence, boundingBox: [[0, 0], [10, 10]] });

describe("receipt parser", () => {
  it("extracts two-amount rows in both x1 and 1x quantity notations", () => {
    const candidates = parseReceiptLines([line("招牌菜 x1 12.34 12.34"), line("清蒸鲈鱼 1x 88.00 88.00")]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ normalizedName: "招牌菜", quantity: 1, unitPriceCents: 1234, lineTotalCents: 1234 });
    expect(candidates[1]).toMatchObject({ normalizedName: "清蒸鲈鱼", quantity: 1, unitPriceCents: 8800, lineTotalCents: 8800 });
  });

  it("treats a single amount as the line total and derives the unit price only when divisible", () => {
    const divisible = parseReceiptLines([line("宫保鸡丁 x1 38.00")]);
    expect(divisible[0]).toMatchObject({ normalizedName: "宫保鸡丁", quantity: 1, unitPriceCents: 3800, lineTotalCents: 3800 });
    const three = parseReceiptLines([line("米饭 x3 10.00")]);
    expect(three[0]).toMatchObject({ quantity: 3, lineTotalCents: 1000 });
    expect(three[0].unitPriceCents).toBeNull(); // 1000 / 3 不能整除为整数分，禁止推算
  });

  it("merges a name-only line with the following quantity line", () => {
    const candidates = parseReceiptLines([line("米饭"), line("x2 4.00")]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ normalizedName: "米饭", quantity: 2, lineTotalCents: 400, unitPriceCents: 200 });
  });

  it("never turns summary or payment rows into dish candidates", () => {
    const candidates = parseReceiptLines([line("小计 130.00"), line("服务费 13.00"), line("实收 143.00"), line("微信支付")]);
    expect(candidates).toHaveLength(0);
  });

  it("parses plain name+amount rows as quantity 1", () => {
    const candidates = parseReceiptLines([line("凉菜拼盘 25.00")]);
    expect(candidates[0]).toMatchObject({ normalizedName: "凉菜拼盘", quantity: 1, unitPriceCents: 2500, lineTotalCents: 2500 });
  });

  it("parses real PaddleOCR output shape (x-before-quantity, spaces, cross-line splits)", () => {
    const candidates = parseReceiptLines([
      line("君德餐厅", 0.99), line("消费小票", 0.99), line("宫保鸡丁 x1 38.00", 0.95), line("清蒸鲈鱼 x1 88.00", 0.95),
      line("米饭", 0.99), line("x2 4.00", 0.93), line("小计", 0.99), line("130.00", 0.99),
      line("服务费", 0.99), line("13.00", 0.99), line("应收", 0.99), line("143.00", 0.99), line("谢谢惠顾", 0.99),
    ]);
    expect(candidates.map((c) => c.normalizedName)).toEqual(["宫保鸡丁", "清蒸鲈鱼", "米饭"]);
    expect(candidates[2]).toMatchObject({ quantity: 2, lineTotalCents: 400, unitPriceCents: 200 });
  });
});
