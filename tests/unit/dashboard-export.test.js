import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildDashboardWorkbook } from "../../apps/worker/src/dashboard-export.js";

const stats = {
  range: { from: "2026-07-01", to: "2026-08-31" },
  months: ["2026-07", "2026-08"],
  categories: [{ code: "environment", name: "环境卫生" }, { code: "service", name: "为客服务" }],
  trend: [{ month: "2026-07", submissions: 2, score: 90 }, { month: "2026-08", submissions: 1, score: 75.5 }],
  stores: [{ storeId: "11111111-1111-4111-8111-111111111111", storeName: "门店甲", brandName: "品牌", cityName: "昆明", overall: 82.75, submissions: 3, monthly: [{ month: "2026-07", score: 90 }, { month: "2026-08", score: 75.5 }] }],
  storeCategories: [{ storeId: "11111111-1111-4111-8111-111111111111", storeName: "门店甲", overallRate: 82.75, rates: [{ category: "environment", rate: 100 }, { category: "service", rate: 65.5 }] }],
  questions: [{ key: "k2", number: 2, text: "迎宾是否主动", overallRate: 65.5, monthly: [{ month: "2026-07", rate: 70 }, { month: "2026-08", rate: 61 }], delta: -9 }],
};

describe("dashboard xlsx export", () => {
  it("builds a workbook with four report sheets", async () => {
    const buffer = await buildDashboardWorkbook(stats);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["得分趋势", "门店月度得分", "门店大项得分率", "考核点得分率"]);
    const trend = workbook.getWorksheet("得分趋势");
    expect(trend.getRow(1).getCell(1).value).toBe("月份");
    expect(trend.getRow(2).getCell(3).value).toBe(90);
    const storeSheet = workbook.getWorksheet("门店月度得分");
    expect(storeSheet.getRow(1).getCell(7).value).toBe("2026-07月");
    expect(storeSheet.getRow(2).getCell(6).value).toBe(82.75);
    const categorySheet = workbook.getWorksheet("门店大项得分率");
    expect(categorySheet.getRow(1).getCell(4).value).toBe("环境卫生(%)");
    expect(categorySheet.getRow(2).getCell(5).value).toBe(65.5);
    const questionSheet = workbook.getWorksheet("考核点得分率");
    expect(questionSheet.getRow(2).getCell(2).value).toBe("迎宾是否主动");
    expect(questionSheet.getRow(2).getCell(7).value).toBe(-9);
  });
});
