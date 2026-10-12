// 契约中枢（module-contracts.md §1 原样钉定；布局为法律，不得自行增删或改名）。
// 页面顺序 = 小程序 app.json:2-14；tabBar = app.json:21-46。
export const pages = [
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
export const tabs = ["home", "schedule", "profile"];
export const services = {
  auth: {
    module: "services/auth.js",
    functions: [
      "login", "logout", "requestRegisterCode", "register", "resubmitRegistration",
      "requestPasswordCode", "verifyPasswordCode", "completePasswordReset",
    ],
  },
  assignments: {
    module: "services/assignments.js",
    functions: ["getMyAssignments", "getAssignment", "checkIn", "startAssignment", "getQuestionnaire"],
  },
  drafts: {
    module: "services/drafts.js",
    functions: [
      "getDraft", "saveAnswer", "createEditSession", "updateEditSession", "initEvidenceUpload",
      "completeEvidenceUpload", "removeEvidence", "confirmIssue", "cancelIssue", "saveDishes",
      "saveOtherRecords", "submitQuestionnaire",
    ],
  },
  receipts: {
    module: "services/receipts.js",
    functions: [
      "listReceiptAttachments", "initializeReceiptUpload", "completeReceiptUpload",
      "deleteReceiptAttachment", "createReceiptOcrJob", "getReceiptOcrJob", "applyReceiptOcrJob",
    ],
  },
  uploads: { module: "services/uploads.js", functions: ["uploadToSignedTarget"] },
  "public-config": { module: "services/public-config.js", functions: ["loadPublicConfig"] },
  captcha: { module: "services/captcha.js", functions: ["obtainCaptchaTicket"] },
};
export const adapters = {
  http: { module: "adapters/http.js" },
  storage: { module: "adapters/storage.js" },
  upload: { module: "adapters/upload.js" },
  location: { module: "adapters/location.js" },
};
export const featureFlags = {
  authSelfService: { flag: "features.authSelfService", pages: ["login"] },
  receiptOcr: { flag: "features.receiptOcr", pages: ["dishes"] },
};
