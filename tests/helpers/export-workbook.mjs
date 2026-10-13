// 导出测试共用：把 fakeCos/本地存储捕获的上传对象重读为 ExcelJS 工作簿。
// 约定上传形如 { key, body, contentType }（与 apps/worker/src/export-jobs.js 的 putExportObject 调用一致）。
import ExcelJS from "exceljs";

export async function workbookOf(upload) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(upload.body);
  return workbook;
}

export async function workbooksOf(storageWithUploads) {
  const uploads = storageWithUploads.uploaded || [];
  return Promise.all(uploads.map(workbookOf));
}
