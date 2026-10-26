// A 结构断言：app-manifest 契约中枢 + 25 个 src 模块的存在性与导出面。
// 契约唯一来源：docs/web/module-contracts.md（布局为法律，不得自行增删模块或改名）。
//
// TDD 红灯基线：apps/web/src/** 尚未实现（第 2 段落地），本文件全部用例预期
// 因模块不存在（ERR_MODULE_NOT_FOUND / Cannot find module）而失败——这是预期，不是 bug。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers/contract-paths.js";

// 钉定页面布局：app.json pages 顺序（app.json:2-14），tabBar 三项（app.json:21-46）。
const PINNED_PAGES = [
  { name: "login", route: "/login", tabBar: false },
  { name: "location", route: "/location", tabBar: false },
  { name: "home", route: "/home", tabBar: true },
  { name: "schedule", route: "/schedule", tabBar: true },
  { name: "profile", route: "/profile", tabBar: true },
  { name: "task", route: "/task", tabBar: false },
  { name: "survey", route: "/survey", tabBar: false },
  { name: "issue", route: "/issue", tabBar: false },
  { name: "dishes", route: "/dishes", tabBar: false },
  { name: "other", route: "/other", tabBar: false },
  { name: "help", route: "/help", tabBar: false },
];
const PINNED_TABS = ["home", "schedule", "profile"];

// services/api.js 的 36 个导出函数（含闪光点照片三端点）。
const API_FUNCTIONS = [
  "login", "logout", "requestRegisterCode", "register", "resubmitRegistration",
  "requestPasswordCode", "verifyPasswordCode", "completePasswordReset",
  "getMyAssignments", "getAssignment", "checkIn", "startAssignment", "getQuestionnaire",
  "getDraft", "saveAnswer", "createEditSession", "updateEditSession", "initEvidenceUpload",
  "completeEvidenceUpload", "removeEvidence", "confirmIssue", "cancelIssue", "saveDishes",
  "listReceiptAttachments", "initializeReceiptUpload", "completeReceiptUpload",
  "deleteReceiptAttachment", "createReceiptOcrJob", "getReceiptOcrJob", "applyReceiptOcrJob",
  "saveOtherRecords", "submitQuestionnaire", "uploadToSignedTarget",
  "initHighlightPhotoUpload", "completeHighlightPhotoUpload", "deleteHighlightPhoto",
];
// 两个随 H5 移植新增的服务函数（非 api.js 导出）。
const PORTED_FUNCTIONS = ["loadPublicConfig", "obtainCaptchaTicket"];
const EXPECTED_UNION = [...API_FUNCTIONS, ...PORTED_FUNCTIONS].sort();

// 钉定 services 七域函数清单（逐域，含顺序无关的成员全集）。
const PINNED_SERVICES = {
  auth: ["login", "logout", "requestRegisterCode", "register", "resubmitRegistration", "requestPasswordCode", "verifyPasswordCode", "completePasswordReset"],
  assignments: ["getMyAssignments", "getAssignment", "checkIn", "startAssignment", "getQuestionnaire"],
  drafts: ["getDraft", "saveAnswer", "createEditSession", "updateEditSession", "initEvidenceUpload", "completeEvidenceUpload", "removeEvidence", "confirmIssue", "cancelIssue", "saveDishes", "saveOtherRecords", "submitQuestionnaire", "initHighlightPhotoUpload", "completeHighlightPhotoUpload", "deleteHighlightPhoto"],
  receipts: ["listReceiptAttachments", "initializeReceiptUpload", "completeReceiptUpload", "deleteReceiptAttachment", "createReceiptOcrJob", "getReceiptOcrJob", "applyReceiptOcrJob"],
  uploads: ["uploadToSignedTarget"],
  "public-config": ["loadPublicConfig"],
  captcha: ["obtainCaptchaTicket"],
};
const PINNED_ADAPTER_MODULES = {
  http: "adapters/http.js",
  storage: "adapters/storage.js",
  upload: "adapters/upload.js",
  location: "adapters/location.js",
};

const serviceFunctionUnion = (manifest) => Object.values(manifest.services).flatMap((domain) => domain.functions);

const assertFunctionExports = (mod, names) => {
  for (const name of names) assert.equal(typeof mod[name], "function", `应导出函数 ${name}`);
  assert.deepEqual(Object.keys(mod).sort(), [...names].sort(), "导出面应与契约完全一致（不得多、不得少、不得改名）");
};

describe("app-manifest 结构契约", () => {
  it("pages 恰好 11 项且顺序/名称/route/tabBar 与钉定布局一致", async () => {
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.length, 11);
    assert.deepEqual(manifest.pages, PINNED_PAGES);
  });

  it("tabs 恰为 home/schedule/profile，且与 tabBar:true 页互相一致", async () => {
    const manifest = await loadSrc("app-manifest.js");
    assert.deepEqual(manifest.tabs, PINNED_TABS);
    const tabBarPageNames = manifest.pages.filter((page) => page.tabBar).map((page) => page.name);
    assert.deepEqual([...tabBarPageNames].sort(), [...PINNED_TABS].sort());
  });

  it("services 七域函数逐域钉定，并集恰为 36 个 api 函数 + 2 个移植函数且无跨域重复", async () => {
    const manifest = await loadSrc("app-manifest.js");
    assert.deepEqual(Object.keys(manifest.services).sort(), Object.keys(PINNED_SERVICES).sort());
    for (const [domain, functions] of Object.entries(PINNED_SERVICES)) {
      assert.deepEqual(manifest.services[domain].functions, functions, `services.${domain}.functions 应与契约一致`);
    }
    const union = serviceFunctionUnion(manifest);
    assert.equal(union.length, 38);
    assert.equal(new Set(union).size, 38, "services 函数不允许跨域重复");
    assert.deepEqual([...union].sort(), EXPECTED_UNION);
  });

  it("adapters 恰好 http/storage/upload/location 四键且 module 路径钉定", async () => {
    const manifest = await loadSrc("app-manifest.js");
    assert.deepEqual(Object.keys(manifest.adapters).sort(), Object.keys(PINNED_ADAPTER_MODULES).sort());
    for (const [key, modulePath] of Object.entries(PINNED_ADAPTER_MODULES)) {
      assert.equal(manifest.adapters[key].module, modulePath, `adapters.${key}.module 应为 ${modulePath}`);
    }
  });

  it("featureFlags 两键：authSelfService→login 页、receiptOcr→dishes 页", async () => {
    const manifest = await loadSrc("app-manifest.js");
    assert.deepEqual(Object.keys(manifest.featureFlags), ["authSelfService", "receiptOcr"]);
    assert.equal(manifest.featureFlags.authSelfService.flag, "features.authSelfService");
    assert.deepEqual(manifest.featureFlags.authSelfService.pages, ["login"]);
    assert.equal(manifest.featureFlags.receiptOcr.flag, "features.receiptOcr");
    assert.deepEqual(manifest.featureFlags.receiptOcr.pages, ["dishes"]);
  });
});

describe("src 模块加载与导出契约（srcPathList 全部 25 项）", () => {
  it("app-manifest.js 可加载且导出面恰为 pages/tabs/services/adapters/featureFlags", async () => {
    const mod = await loadSrc("app-manifest.js");
    assert.deepEqual(Object.keys(mod).sort(), ["adapters", "featureFlags", "pages", "services", "tabs"]);
  });

  it("adapters/http.js 导出 request（零域名口径，R0）", async () => {
    assertFunctionExports(await loadSrc("adapters/http.js"), ["request"]);
  });

  it("adapters/storage.js 导出 readStorage/writeStorage/removeStorage", async () => {
    assertFunctionExports(await loadSrc("adapters/storage.js"), ["readStorage", "writeStorage", "removeStorage"]);
  });

  it("adapters/upload.js 导出 postFile", async () => {
    assertFunctionExports(await loadSrc("adapters/upload.js"), ["postFile"]);
  });

  it("adapters/location.js 导出 getCurrentLocation", async () => {
    assertFunctionExports(await loadSrc("adapters/location.js"), ["getCurrentLocation"]);
  });

  it("services/auth.js 导出 8 个同名函数", async () => {
    assertFunctionExports(await loadSrc("services/auth.js"), [
      "login", "logout", "requestRegisterCode", "register", "resubmitRegistration",
      "requestPasswordCode", "verifyPasswordCode", "completePasswordReset",
    ]);
  });

  it("services/assignments.js 导出 5 个同名函数", async () => {
    assertFunctionExports(await loadSrc("services/assignments.js"), [
      "getMyAssignments", "getAssignment", "checkIn", "startAssignment", "getQuestionnaire",
    ]);
  });

  it("services/drafts.js 导出 15 个同名函数", async () => {
    assertFunctionExports(await loadSrc("services/drafts.js"), [
      "getDraft", "saveAnswer", "createEditSession", "updateEditSession", "initEvidenceUpload",
      "completeEvidenceUpload", "removeEvidence", "confirmIssue", "cancelIssue", "saveDishes",
      "saveOtherRecords", "submitQuestionnaire",
      "initHighlightPhotoUpload", "completeHighlightPhotoUpload", "deleteHighlightPhoto",
    ]);
  });

  it("services/receipts.js 导出 7 个同名函数", async () => {
    assertFunctionExports(await loadSrc("services/receipts.js"), [
      "listReceiptAttachments", "initializeReceiptUpload", "completeReceiptUpload",
      "deleteReceiptAttachment", "createReceiptOcrJob", "getReceiptOcrJob", "applyReceiptOcrJob",
    ]);
  });

  it("services/uploads.js 导出 uploadToSignedTarget", async () => {
    assertFunctionExports(await loadSrc("services/uploads.js"), ["uploadToSignedTarget"]);
  });

  it("services/public-config.js 导出 loadPublicConfig", async () => {
    assertFunctionExports(await loadSrc("services/public-config.js"), ["loadPublicConfig"]);
  });

  it("services/captcha.js 导出 obtainCaptchaTicket", async () => {
    assertFunctionExports(await loadSrc("services/captcha.js"), ["obtainCaptchaTicket"]);
  });

  it("store/session.js 导出 4 个会话函数", async () => {
    assertFunctionExports(await loadSrc("store/session.js"), [
      "getSession", "saveSession", "clearSessionAndUserCache", "registerDraftKey",
    ]);
  });

  it("store/assignments-cache.js 导出 createAssignmentCache", async () => {
    assertFunctionExports(await loadSrc("store/assignments-cache.js"), ["createAssignmentCache"]);
  });

  it("store/survey.js 导出 6 个草稿函数", async () => {
    assertFunctionExports(await loadSrc("store/survey.js"), [
      "getDraft", "peekDraft", "saveDraft", "markDraftSynced", "advanceDraftRevision", "clearDraft",
    ]);
  });

  it("store/survey-merge.js 导出 mergeSurveyAnswers", async () => {
    assertFunctionExports(await loadSrc("store/survey-merge.js"), ["mergeSurveyAnswers"]);
  });

  it("utils/presentation.js 导出 9 个展示函数", async () => {
    assertFunctionExports(await loadSrc("utils/presentation.js"), [
      "safeDate", "formatDateHeading", "formatTimeRange", "formatSubmittedAt", "formatBudgetLabel",
      "mapAssignmentStatus", "taskTypeText", "projectAssignmentForDisplay", "groupAssignmentsByDate",
    ]);
  });

  it("utils/business.js 导出 5 个业务函数", async () => {
    assertFunctionExports(await loadSrc("utils/business.js"), [
      "secureUuid", "validateDish", "firstIncompleteQuestion", "isBlankExtraDish", "computeSurveyScore",
    ]);
  });

  it("utils/errors.js 导出 BusinessError 类与 presentError", async () => {
    const mod = await loadSrc("utils/errors.js");
    assert.equal(typeof mod.BusinessError, "function", "应导出 BusinessError 类");
    assert.equal(mod.BusinessError.name, "BusinessError");
    assert.equal(typeof mod.presentError, "function", "应导出 presentError");
    assert.deepEqual(Object.keys(mod).sort(), ["BusinessError", "presentError"]);
  });

  it("utils/coordinates.js 导出 wgs84ToGcj02", async () => {
    assertFunctionExports(await loadSrc("utils/coordinates.js"), ["wgs84ToGcj02"]);
  });

  it("utils/feature-flags.js 导出 isSelfServiceEnabled/isReceiptOcrEnabled", async () => {
    assertFunctionExports(await loadSrc("utils/feature-flags.js"), ["isSelfServiceEnabled", "isReceiptOcrEnabled"]);
  });

  it("utils/digest.js 导出 SHA256_HEX_PATTERN/hasSha256Hex/sha256Hex", async () => {
    const mod = await loadSrc("utils/digest.js");
    assert.equal(typeof mod.hasSha256Hex, "function");
    assert.equal(typeof mod.sha256Hex, "function");
    assert.deepEqual(Object.keys(mod).sort(), ["SHA256_HEX_PATTERN", "hasSha256Hex", "sha256Hex"]);
  });

  it("utils/upload-queue.js 导出 createCancelledUploads", async () => {
    assertFunctionExports(await loadSrc("utils/upload-queue.js"), ["createCancelledUploads"]);
  });

  it("features/receipt-ocr.js 导出 12 个函数 + 4 个常量（常量值钉定）", async () => {
    const mod = await loadSrc("features/receipt-ocr.js");
    const functions = [
      "readyReceiptCount", "occupiedReceiptCount", "validateReceiptFiles", "parseYuanToCents",
      "formatCentsToYuan", "nextPollDelay", "ocrStatusView", "applyOcrDishesOnce",
      "markDishEdited", "deriveLineTotal", "requiredReviewMessage", "receiptDeletionOptions",
    ];
    for (const name of functions) assert.equal(typeof mod[name], "function", `应导出函数 ${name}`);
    assert.equal(mod.MAX_RECEIPTS, 9);
    assert.equal(mod.MAX_RECEIPT_BYTES, 10 * 1024 * 1024);
    assert.equal(mod.MAX_MONEY_CENTS, 999999999);
    assert.deepEqual(mod.OCR_POLL_DELAYS, [1000, 2000, 3000, 5000]);
    assert.deepEqual(Object.keys(mod).sort(), [...functions, "MAX_RECEIPTS", "MAX_RECEIPT_BYTES", "MAX_MONEY_CENTS", "OCR_POLL_DELAYS"].sort());
  });

  it("router/guards.js 可加载且导出三个导航守卫函数", async () => {
    assertFunctionExports(await loadSrc("router/guards.js"), [
      "requireApprovedSession", "coldStartRoute", "handleUnauthorized",
    ]);
  });
});
