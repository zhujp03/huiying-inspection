// 数据看板导出：把 fetchDashboardStats 的结果写成 xlsx 工作簿（4 个工作表）。
// 纯函数、不触 COS，便于单测。
import ExcelJS from "exceljs";

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const addSheet = (workbook, name, headers, rows) => {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow(headers).font = { bold: true };
  sheet.getRow(1).eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF1F3" } }; cell.border = { bottom: { style: "thin" } }; });
  for (const row of rows) sheet.addRow(row);
  headers.forEach((header, index) => {
    let width = String(header).length * 2 + 4;
    for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex += 1) {
      const value = sheet.getRow(rowIndex).getCell(index + 1).value;
      if (value !== null && value !== undefined) width = Math.max(width, String(value).length * 1.8 + 4);
    }
    sheet.getColumn(index + 1).width = Math.min(46, Math.max(10, width));
  });
  return sheet;
};

export async function buildDashboardWorkbook(stats) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "汇盈探店管理台";

  addSheet(workbook, "得分趋势", ["月份", "提交数", "得分（百分制）"], stats.trend.map((point) => [point.month, point.submissions, point.score]));

  addSheet(workbook, "门店月度得分", ["序号", "门店名称", "品牌", "城市", "提交数", "平均得分", ...stats.months.map((month) => `${month}月`)],
    stats.stores.map((row, index) => {
      const byMonth = new Map(row.monthly.map((point) => [point.month, point.score]));
      return [index + 1, row.storeName, row.brandName || "—", row.cityName || "—", row.submissions, row.overall, ...stats.months.map((month) => byMonth.get(month) ?? "—")];
    }));

  addSheet(workbook, "门店大项得分率", ["序号", "门店名称", "平均得分率(%)", ...stats.categories.map((category) => `${category.name}(%)`)],
    stats.storeCategories.map((row, index) => {
      const byCategory = new Map(row.rates.map((cell) => [cell.category, cell.rate]));
      return [index + 1, row.storeName, row.overallRate, ...stats.categories.map((category) => byCategory.get(category.code) ?? "—")];
    }));

  addSheet(workbook, "考核点得分率", ["序号", "考核点", "考核点序号", "平均得分率(%)", ...stats.months.map((month) => `${month}月(%)`), "与前一月差值(百分点)"],
    stats.questions.map((row, index) => {
      const byMonth = new Map(row.monthly.map((point) => [point.month, point.rate]));
      return [index + 1, row.text, row.key, row.overallRate, ...stats.months.map((month) => byMonth.get(month) ?? "—"), row.delta ?? "—"];
    }));

  return workbook.xlsx.writeBuffer();
}
