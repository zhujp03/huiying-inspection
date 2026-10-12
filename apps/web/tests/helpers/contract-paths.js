// 统一的 src 模块加载入口：apps/web 下所有测试一律经 loadSrc() 加载 apps/web/src/**，
// 禁止在用例里手写 ../src 相对路径（防拼错、防漂移）。模块清单（24 项）与
// docs/web/module-contracts.md 钉定布局一一对应。
//
// TDD 红灯基线：第 2 段实现落地前 apps/web/src/** 全部不存在，loadSrc 的每个调用
// 都会以模块不存在（ERR_MODULE_NOT_FOUND / Cannot find module）失败——这是预期，不是 bug。
const srcRoot = new URL("../../src/", import.meta.url); // apps/web/src/

export const srcPathList = [
  "app-manifest.js",
  "adapters/http.js",
  "adapters/storage.js",
  "adapters/upload.js",
  "adapters/location.js",
  "services/auth.js",
  "services/assignments.js",
  "services/drafts.js",
  "services/receipts.js",
  "services/uploads.js",
  "services/public-config.js",
  "services/captcha.js",
  "store/session.js",
  "store/assignments-cache.js",
  "store/survey.js",
  "store/survey-merge.js",
  "utils/presentation.js",
  "utils/business.js",
  "utils/errors.js",
  "utils/coordinates.js",
  "utils/feature-flags.js",
  "utils/upload-queue.js",
  "features/receipt-ocr.js",
  "router/guards.js",
];

export const srcPaths = Object.fromEntries(srcPathList.map((path) => [path, new URL(path, srcRoot).href]));

export const loadSrc = (path) => import(srcPaths[path]);
