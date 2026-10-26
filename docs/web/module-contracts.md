# H5 探员端 src 模块契约（module-contracts）

> 本文是三阶段流水线第 2 段（apps/web/src/** 实现）的**唯一模块契约**，也是第 1 段测试（apps/web/tests/manifest.test.js、anti-omission.test.js）断言的**法律文本**。
> 上游依据：docs/web/inventory.md（复审 PASS，行号引用均出自该盘点与小程序源码快照 2026-10-10）。
> 布局钉定：**不得自行增删 src 模块、不得改名、不得增删导出**。改动本文必须走主控裁决。

---

## 0. 总则

1. `apps/web/src/` 共 **24 个模块**：1 个契约中枢 app-manifest.js + 4 adapters + 7 services + 4 store + 6 utils + 1 features + 1 router。
2. 服务层合计 **35 个导出函数** = 小程序 services/api.js 的 33 个同名同语义函数 + `loadPublicConfig`（app.js 直连移植）+ `obtainCaptchaTicket`（验证码链移植）。
3. 所有测试经 `apps/web/tests/helpers/contract-paths.js` 的 `loadSrc()` 加载 src 模块；`srcPathList` 钉定上述 24 项相对路径。
4. **TDD 红灯基线**：第 2 段实现前全部测试因模块不存在（ERR_MODULE_NOT_FOUND / Cannot find module）失败，这是预期状态，不是缺陷。
5. 测试环境为 node（无浏览器/DOM 依赖）；src 模块不得 import DOM API，平台差异一律收进 adapters。

---

## 1. app-manifest.js（契约中枢，原样钉定）

```js
export const pages = [  // app.json 顺序，恰好 11 项
  { name: 'login',    route: '/login',    tabBar: false },
  { name: 'location', route: '/location', tabBar: false },
  { name: 'home',     route: '/home',     tabBar: true  },
  { name: 'schedule', route: '/schedule', tabBar: true  },
  { name: 'profile',  route: '/profile',  tabBar: true  },
  { name: 'task',     route: '/task',     tabBar: false },
  { name: 'survey',   route: '/survey',   tabBar: false },
  { name: 'issue',    route: '/issue',    tabBar: false },
  { name: 'dishes',   route: '/dishes',   tabBar: false },
  { name: 'other',    route: '/other',    tabBar: false },
  { name: 'help',     route: '/help',     tabBar: false },
];
export const tabs = ['home', 'schedule', 'profile']; // tabBar 顺序
export const services = {
  auth:            { module: 'services/auth.js',          functions: ['login','logout','requestRegisterCode','register','resubmitRegistration','requestPasswordCode','verifyPasswordCode','completePasswordReset'] },
  assignments:     { module: 'services/assignments.js',   functions: ['getMyAssignments','getAssignment','checkIn','startAssignment','getQuestionnaire'] },
  drafts:          { module: 'services/drafts.js',        functions: ['getDraft','saveAnswer','createEditSession','updateEditSession','initEvidenceUpload','completeEvidenceUpload','removeEvidence','confirmIssue','cancelIssue','saveDishes','saveOtherRecords','submitQuestionnaire'] },
  receipts:        { module: 'services/receipts.js',      functions: ['listReceiptAttachments','initializeReceiptUpload','completeReceiptUpload','deleteReceiptAttachment','createReceiptOcrJob','getReceiptOcrJob','applyReceiptOcrJob'] },
  uploads:         { module: 'services/uploads.js',       functions: ['uploadToSignedTarget'] },
  'public-config': { module: 'services/public-config.js', functions: ['loadPublicConfig'] },
  captcha:         { module: 'services/captcha.js',       functions: ['obtainCaptchaTicket'] },
};
export const adapters = {
  http:     { module: 'adapters/http.js' },
  storage:  { module: 'adapters/storage.js' },
  upload:   { module: 'adapters/upload.js' },
  location: { module: 'adapters/location.js' },
};
export const featureFlags = {
  authSelfService: { flag: 'features.authSelfService', pages: ['login'] },
  receiptOcr:      { flag: 'features.receiptOcr',      pages: ['dishes'] },
};
```

小程序侧来源：页面顺序 app.json:2-14；tabBar app.json:21-46；33 个 api 函数 api.js:56-97；client-config 直连 app.js:24-42；验证码链 services/captcha.js:3-13。

---

## 2. adapters（4 个，平台数据面）

### 2.1 adapters/http.js

- **导出清单**：`export function request({ url, method = "GET", data, validate, dedupeKey })`。
- **语义契约**（等价 api.js request，api.js:30-54）：
  - 请求 URL 即相对路径本身（以 /api 开头），直接 `fetch(url)`；method 默认 GET；data 为 JSON 请求体。**零域名（R0）**：不拼接任何 base/origin、不读取任何构建期注入的 API 地址变量。
  - 超时 12000ms（TIMEOUT_MS，api.js:6）。
  - 请求头恒带 `Accept: application/json`、`Content-Type: application/json`；会话存在（`session.accessToken`）时注入 `Authorization: Bearer <token>`（api.js:38）。
  - 非 2xx → 走 utils/errors.presentError；错误 kind 为 `session` 时：清会话与用户缓存、清任务缓存，并调用 router/guards 的 `handleUnauthorized()` 跳登录（等价 api.js:42 的 reLaunch 链）。
  - 2xx → 执行 `validate(response.data)`（缺省按对象校验）；校验器抛错 → `BusinessError("contract", "服务返回的数据暂时无法使用，请稍后重试")`（api.js:45-46）。
  - 网络失败：超时 → kind `timeout`「请求超时，请检查网络后重试」；其他失败 → kind `network`「暂时无法连接服务，请检查网络后重试」；均 retryable（api.js:48）。
  - dedupe：模块级 pending Map；key = 显式 `dedupeKey` 或默认 `${method}:${url}`；进行中的同 key 请求复用同一 Promise，settle 后删除——只合并并发、不缓存结果（api.js:5,31-32,51-52）。
- **废弃说明**：getApiBase/apiBase 拼接机制废弃——小程序 app.js:13 的该机制仅因小程序宿主无 origin 概念；H5 同源部署不适用，见 rules.md R0。

### 2.2 adapters/storage.js

- **导出清单**：`export function readStorage(key)`；`export function writeStorage(key, value)`；`export function removeStorage(key)`。
- **语义契约**：`globalThis.localStorage` 存在时持久化（JSON 序列化读写），否则以模块内内存 Map 兜底——保证 node 测试环境可用；读不到返回 null。存储键沿用小程序命名：`junde:session`、`junde:draft-index`、草稿键 `junde:survey:{userId}:{assignmentId}:{attemptId}:{questionnaireVersionId}`。
- **小程序侧来源**：wx.getStorageSync/setStorageSync/removeStorageSync 的全部使用点——store/session.js:4-5,9-12,16-20；store/survey.js:11,20,27,36,40。

### 2.3 adapters/upload.js

- **导出清单**：`export function postFile({ url, fileFieldName, formData, file, onProgress, signal })` → `Promise<{ etag }>`。
- **语义契约**：wx.uploadFile 的 fetch 等价运输层——multipart 直传 file 到预签名 url，表单字段名 fileFieldName，附 formData；进度经 onProgress 回调且钳制 0-100（api.js:106）；成功从响应头取 ETag（大小写双捕 `ETag || etag`，允许 null，api.js:102）；非 2xx / 网络失败 reject（业务文案与校验在 services/uploads.js，运输层不做业务校验）；signal 支持中止。
- **小程序侧来源**：api.js:97-108；调用点 pages/dishes/index.js:219。

### 2.4 adapters/location.js

- **导出清单**：`export function getCurrentLocation()` → `Promise<{ latitude, longitude, accuracy }>`。
- **语义契约**：返回 **GCJ02** 坐标。浏览器 geolocation 返回 WGS84，内部经 utils/coordinates.wgs84ToGcj02 转换；拒绝/失败 reject（页面层转 blocked 态），等价 `wx.getLocation({ type: "gcj02", isHighAccuracy: true })`。
- **小程序侧来源**：pages/location/index.js:8-13；pages/task/index.js:80-81（含 highAccuracyExpireTime:5000 与 capturedAt 组装）；授权声明 app.json:47-54。

---

## 3. services（7 个域，35 个函数）

所有请求函数经 adapters/http.request 发送；函数名与小程序 services/api.js 同名同参数同语义。端点映射见 §7。

### 3.1 services/auth.js（8 函数，api.js:56-63）

- `login(credentials)`：POST auth.login；成功 `saveSession(result)` 并清任务缓存（api.js:56）。
- `logout()`：POST auth.logout；无论成败清会话与任务缓存（api.js:57 try/finally）。
- `requestRegisterCode(payload)` / `register(payload)` / `resubmitRegistration(payload)` / `requestPasswordCode(payload)` / `verifyPasswordCode(payload)` / `completePasswordReset(payload)`：纯转发 POST（api.js:58-63）。

### 3.2 services/assignments.js（5 函数，api.js:66-76）

- `getMyAssignments({ force = false } = {})`：userId 取 `getSession()?.user?.id`；15 秒按 userId 缓存命中 → 直接返回 items；miss → GET assignments.mine 后写缓存。**缓存本体在 store/assignments-cache.js，本模块不含缓存逻辑**（api.js:64-72）。
- `getAssignment(assignmentId)`（api.js:73）；`checkIn(assignmentId, location)`，dedupeKey `checkin:{assignmentId}`（api.js:74）；`startAssignment(assignmentId)`，dedupeKey `start:{assignmentId}`（api.js:75）；`getQuestionnaire(assignmentId)`（api.js:76）。

### 3.3 services/drafts.js（12 函数，api.js:77-86,94-95）

`getDraft(attemptId)`（:77）；`saveAnswer(attemptId, questionId, answer)` PUT，dedupeKey `answer:{attemptId}:{questionId}`（:78）；`createEditSession(attemptId, questionId, payload)`（:79）；`updateEditSession(attemptId, questionId, editSessionId, payload)` PATCH（:80）；`initEvidenceUpload(attemptId, questionId, editSessionId, payload)`（:81）；`completeEvidenceUpload(attemptId, questionId, editSessionId, attachmentId, payload)`（:82）；`removeEvidence(attemptId, questionId, editSessionId, attachmentId)` DELETE（:83）；`confirmIssue(attemptId, questionId, editSessionId, payload)`（:84）；`cancelIssue(attemptId, questionId, editSessionId)`（:85）；`saveDishes(attemptId, payload)` PUT，dedupeKey `dishes:{attemptId}`（:86）；`saveOtherRecords(attemptId, data)` PUT，dedupeKey `other:{attemptId}`（:94）；`submitQuestionnaire(attemptId, payload)` POST，dedupeKey `submit:{attemptId}:{payload.submitToken}`（:95，同 token 幂等重放依赖此键）。

### 3.4 services/receipts.js（7 函数，api.js:87-93）

`listReceiptAttachments(attemptId)`，dedupeKey `receipt-list:{attemptId}`（:87）；`initializeReceiptUpload(attemptId, fileMeta, revision)`，body `{fileMeta, revision}`，dedupeKey `receipt-init:{attemptId}:{fileMeta.clientFileId}`（:88）；`completeReceiptUpload(attemptId, attachmentId, fileMeta, revision)`，dedupeKey `receipt-complete:{attemptId}:{attachmentId}`（:89）；`deleteReceiptAttachment(attemptId, attachmentId, dishHandling, revision)`（:90）；`createReceiptOcrJob(attemptId, attachmentIds, idempotencyKey, revision)`（:91）；`getReceiptOcrJob(attemptId, jobId)`（:92）；`applyReceiptOcrJob(attemptId, jobId, idempotencyKey, dishRevision)`（:93）。

### 3.5 services/uploads.js（1 函数，api.js:97-108）

- `uploadToSignedTarget({ url, method, fileFieldName, formData, expiresAt }, file, onProgress)`：
  - 参数校验：`method !== "POST"` 或 url/fileFieldName/formData 缺失或 `new Date(expiresAt) <= new Date()` → 立即 `BusinessError("upload", "上传链接已失效，请重新上传")`（api.js:99）。
  - 成功（2xx）→ `resolve({ etag })`（大小写双捕，允许 null）；非 2xx → 「暂时无法上传小票，请重试」（retryable）；网络失败 → 「暂时无法上传小票，请检查网络后重试」（retryable）。
  - 进度钳制 0-100；发送经 adapters/upload.postFile；目标为对象存储预签名 URL，**无 registry 条目**（inventory §3.c）。

### 3.6 services/public-config.js（1 函数，app.js:24-42）

- `loadPublicConfig()` → `Promise<object|null>`：GET `/api/public/client-config`（同源相对路径，R0），超时 5000ms，无 Bearer、无 dedupe；非 200 / 响应非对象 / 网络失败 → 返回 null（不抛错，app.js:30-40）。配置仅内存态、无持久化。（小程序 app.js:25 的 apiBase 空值守卫随零域名口径废弃。）

### 3.7 services/captcha.js（1 函数，captcha.js:3-13 + captcha-host.js:12-24，R17）

- `obtainCaptchaTicket(scene, adapter)` → `Promise<{ ticket, randstr }>`：`scene` 与 `adapter` 均必传——`adapter` 为适配器函数 `async ({ scene }) => ({ ticket, randstr })`，由页面桥注册的实现显式注入，替代小程序 `getApp().globalData.captchaAdapter` 全局态（便于 node 测试；签名修订：主控裁决 2026-10-10）。失败抛 kind **captcha** 的 BusinessError——`adapter` 非函数（宿主缺失/加载失败）→ 「行为验证服务暂时不可用，请稍后重试」（captcha.js:5、captcha-host.js:16）；返回的 ticket 空/非字符串 → 「行为验证未完成，请重试」（captcha.js:10、captcha-host.js:20）。成功时返回 `{ ticket, randstr: ticket.randstr || "" }`（randstr 允许为空串）。
- **kind 三分工（镜像小程序语义，R17/R18）**：
  - `captcha` = 客户端获取票据失败（本模块抛出，R17）；
  - `captcha_cancel` = 用户取消/页面卸载，由**页面桥**产生（「已取消行为验证，请重试」；onUnload login/index.js:75-81（reject 语句 :80）、onCaptchaClose :101-105（reject 语句 :104））——R18，属 stage-2 页面桥职责，不由本模块产生；页面桥其余语义：组件缺失/无 show → captcha「行为验证组件暂未就绪，请稍后重试」（login/index.js:38-41，reject 语句 :40）；onCaptchaVerify 的 `ret!==0`/空 ticket 分支 → captcha「验证未通过，请重试」（login/index.js:95-99，reject 语句 :98）；onCaptchaError → captcha「行为验证加载失败，请稍后重试」（login/index.js:106-110，reject 语句 :109）；卸载时未完成 Promise 必须 reject（captcha_cancel）不得永久 pending；
  - `captcha_rejected` = 服务端拒票，仅由 utils/errors.js 的 presentError 对 CAPTCHA_EXPIRED / CAPTCHA_REJECTED / CAPTCHA_CANCELLED 映射产生（api.js:18-19，presentError 语义不变）。
- scene ∈ `register` / `password_reset` / `registration_resubmit`；**登录本身不需要验证码**（inventory §8.6）。

---

## 4. store（4 个）

### 4.1 store/session.js（store/session.js:1-20）

- **导出清单**：`getSession()` / `saveSession(session)` / `clearSessionAndUserCache()` / `registerDraftKey(userId, key)`。
- **语义契约**：读写 `junde:session`（整包，无值返回 null）；`clearSessionAndUserCache()` 按 `junde:draft-index` 中当前用户的键逐个删草稿 → 删该用户索引项 → 删会话 → 清内存会话（小程序经 getApp().globalData.session，H5 由模块内变量承担等价职责）；`registerDraftKey(userId, key)` 去重登记草稿键索引。持久化一律经 adapters/storage。

### 4.2 store/assignments-cache.js（store/assignments-cache.js:5-20）

- **导出清单**：`createAssignmentCache({ now = () => Date.now(), ttlMs = 15000 } = {})`。
- **语义契约**：返回 `{ get(userId, { force = false } = {}), set(userId, items), clear() }`。get：force 或无 userId 直接 miss；命中且未过期返回 `{ items }`，过期项惰性删除后返回 null。set：仅 userId 存在时写。clear：清空全部用户。清空时机：login 成功 / logout / 401（api.js:42,56,57）。

### 4.3 store/survey.js（store/survey.js:1-40，导出清单照源码抄录）

- **导出清单**：`getDraft(meta)` / `peekDraft(meta)` / `saveDraft(meta, patch)` / `markDraftSynced(meta, revision)` / `clearDraft(meta)`（5 个）。
- **语义契约**：
  - identity：userId = `getSession()?.user?.id`；四元组 `userId/assignmentId/attemptId/questionnaireVersionId` 缺任一 → `throw new Error("DRAFT_SCOPE_MISSING")`；键 = `junde:survey:{encodeURIComponent(userId)}:{encodeURIComponent(assignmentId)}:{encodeURIComponent(attemptId)}:{encodeURIComponent(questionnaireVersionId)}`（:3-7）。
  - `getDraft(meta)`：无值或 `value.revision !== meta.revision` → 空骨架 `{ answers: {}, dishes: [], highlight: "", suggestion: "", receiptRecovery: { pendingReceipts: [], jobId: null, applyKey: null, appliedJobId: null }, revision: meta.revision }`；否则返回存值（:9-14）。
  - `peekDraft(meta)`：读原始值（不做 revision 过滤），非对象返回 null（:18-22）。
  - `saveDraft(meta, patch)`：合并 `{ ...getDraft(meta), ...patch, revision: meta.revision, synced: false, savedAt: new Date().toISOString() }` 并 registerDraftKey（:24-30）。
  - `markDraftSynced(meta, revision)`：以新 revision 写 `synced: true` 并 registerDraftKey（:32-38）。
  - `clearDraft(meta)`：删键（:40）。

### 4.4 store/survey-merge.js（store/survey-merge.js:1-26，导出清单照源码抄录）

- **导出清单**：`mergeSurveyAnswers({ serverAnswers = {}, serverRevision, rawLocal })`（1 个）。
- **语义契约**（四条规则，:1-7 注释 + :8-20 实现）：
  1. 本地无未同步草稿（`!rawLocal || rawLocal.synced !== false`）→ `{ answers: serverAnswers, conflict: false, pendingResync: [] }`。
  2. 本地 synced=false 且 `serverRevision === rawLocal.revision` → `{ ...serverAnswers, ...本地 answers }` 本地覆盖同题；pendingResync = 本地答案中 `answer === "scored"` 且与服务端不同（sameAnswer 按 answer+remark 比较）的题 id 列表。
  3. 本地 synced=false 且 `serverRevision > rawLocal.revision` → `{ answers: serverAnswers, conflict: true, pendingResync: [] }`。
  4. 本地 revision 更大 → 以本地为准（合并、无冲突、无 resync）。

---

## 5. utils（7 个）

### 5.1 utils/presentation.js（utils/presentation.js:10-104，9 函数同名同语义）

`safeDate(value)`（:10-14，无效输入→null，杜绝 Invalid Date 上屏）；`formatDateHeading(value)`（:23-27，「M月D日 周X」，无效→「时间待确认」）；`formatTimeRange(startIso, endIso)`（:30-36，同天「HH:mm–HH:mm」、跨天「HH:mm 开始」、end 无效「HH:mm 起」、start 无效「时间待确认」）；`formatSubmittedAt(value)`（:39-43，「M月D日 周X HH:mm」）；`formatBudgetLabel(cents)`（:46-49，非正整数/0/缺失→「未设置」，否则「¥x.xx」）；`mapAssignmentStatus(status)`（:51-62，五态映射 + 未知值「状态待确认」muted 且 isActionable:true）；`taskTypeText(taskType)`（:64，secret→「暗访」、overt→「明察」、其他→""）；`projectAssignmentForDisplay(assignment)`（:70-89，纯展示投影，isActionable = status ∈ {assigned,in_progress,overdue,submitted,cancelled}）；`groupAssignmentsByDate(assignments)`（:92-104，按 displayDate 分组、保持原序，空数组→[]）。展示语义明细以 inventory §7 为准。

### 5.2 utils/business.js（utils/business.js:1-53，4 函数）

`secureUuid()`（:1-10，安全随机 UUIDv4，无安全随机源 → throw "SECURE_RANDOM_UNAVAILABLE"）；`validateDish(dish)`（:12-24，菜品状态机校验，返回错误文案或 ""）；`firstIncompleteQuestion(questions, answers)`（:26-44，缺号兜底 + 逐题检查 scored/unscored/备注/证据附件）；`isBlankExtraDish(dish)`（:46-53，空白额外菜判定）。

### 5.3 utils/errors.js（api.js:10-28）

- **导出清单**：`export class BusinessError` + `export function presentError(statusCode, payload)`。
- **BusinessError**：`constructor(kind, message, details = {})`，字段 `name = "BusinessError"`、`kind`、`retryable = Boolean(details.retryable)`、`requiresNewToken = Boolean(details.requiresNewToken)`（api.js:10-12）。
- **presentError 完整映射**（优先级自上而下，api.js:14-28；码判断先于状态码）：

| 触发 | kind | 文案 | 附加 |
|---|---|---|---|
| code ∈ {SMS_CODE_INVALIDATED, SMS_CODE_ATTEMPTS_EXHAUSTED} | sms_invalidated | 验证码已失效，请重新发送并完成人机验证 | — |
| code === QUESTIONNAIRE_SUBMITTED | questionnaire_submitted | 任务已提交，小票不可再查看或修改 | dishes 页据此锁重试（inventory §5.c） |
| code === CAPTCHA_EXPIRED | captcha_rejected | 验证已过期，请重新验证 | — |
| code ∈ {CAPTCHA_REJECTED, CAPTCHA_CANCELLED} | captcha_rejected | 验证未通过，请重新验证 | — |
| statusCode === 401 | session | 登录已失效，请重新登录 | 触发清会话+清缓存+跳登录 |
| statusCode === 403 | forbidden | 你没有权限进行此操作 | — |
| statusCode === 409 | conflict | `payload?.error?.message \|\| "内容已更新，请刷新后重试"` | requiresNewToken 透传（:23） |
| statusCode >= 500 | service | 服务暂时不可用，请稍后重试 | retryable: true |
| code === RECEIPT_LIMIT_EXCEEDED | validation | 最多只能上传 9 张消费小票 | — |
| code === RECEIPT_FILE_INVALID | validation | 请选择 10MB 以内的图片 | — |
| 兜底 | validation | 操作未完成，请检查填写内容 | — |

### 5.4 utils/coordinates.js（新增，平台差异）

- **导出清单**：`export function wgs84ToGcj02(latitude, longitude)` → `{ latitude, longitude }`。
- **语义契约**：公开 GCJ-02 偏移算法；中国境外坐标原样返回（不做偏移）。小程序由 `wx.getLocation({ type: "gcj02" })` 由系统完成转换（location/index.js:8-13、task/index.js:80-81），H5 需自行实现，故为新增模块，无小程序 file:line 对应。

### 5.5 utils/feature-flags.js（login/index.js:55、dishes/index.js:34；佐证 app.js:31）

- **导出清单**：`export function isSelfServiceEnabled(publicConfig)` / `export function isReceiptOcrEnabled(publicConfig)`。
- **语义契约**：publicConfig 为 null/undefined、缺 `features` 对象、对应 flag 不严格等于 `true` → 一律 `false`（保守隐藏入口）；`=== true` → true。对应 `Boolean(publicConfig?.features?.authSelfService)`（login/index.js:55，resolveSelfService）与 `Boolean(publicConfig?.features?.receiptOcr)`（dishes/index.js:34，syncOcrEntry）两个消费点；app.js:31 是 publicConfig 有效性判定（响应为对象才写入 globalData.publicConfig），非开关求值点。

### 5.6 utils/upload-queue.js（pages/dishes/index.js:235-243）

- **导出清单**：`export function createCancelledUploads()` → `{ has(id), add(id), delete(id), size }`。
- **语义契约**：已取消上传 id 集合。add(id) 后 has(id) 恒为 true、size 计数；上传回调命中 has 即放弃回填（dishes js:213,220,223）；**显式重试是唯一复活通道**——retryUpload 先 `delete(id)` 再重新发起上传（dishes/index.js:235 `this.cancelledUploads?.delete(id)`，重试入口 wxml:38 `bindtap="retryUpload"`）；delete 后 has(id) 恢复 false、size 减一。小程序为页面内联 Set，H5 抽为独立纯逻辑模块。

### 5.7 utils/digest.js（新增，平台差异；2026-10 小票 sha256 修复）

- **导出清单**：`export const SHA256_HEX_PATTERN`；`export function hasSha256Hex(value)`；`export async function sha256Hex(file)`。
- **语义契约**：浏览器端文件 SHA-256 摘要（crypto.subtle，安全上下文限定）。小票契约 ReceiptFileMetaSchema 在 init/complete 都强制 64-hex sha256，且服务端 complete 用它对账存储对象实测摘要——必须在 init 之前对选中文件真实字节计算一次并以同一字符串贯穿上传链（摘要字符串允许随待传项持久化，File/ArrayBuffer/摘要 Promise 不得持久化）。`sha256Hex`：file 缺失/不可读、crypto.subtle 不可用 → 抛可读中文错误（页面 safeMessage 原样透传），绝不返回占位/伪造摘要；`hasSha256Hex`：64-hex 字符串判定（重试时复用已算摘要的守卫）。小程序 wx.getCurrentInstance 侧无对应实现（小程序同链路缺陷另行处理），无小程序 file:line 对应。
---

## 6. features 与 router（2 个）

### 6.1 features/receipt-ocr.js（features/receipt-ocr.js:1-89，导出清单照源码抄录）

- **常量 4 个**：`MAX_RECEIPTS = 9`（:1）；`MAX_RECEIPT_BYTES = 10 * 1024 * 1024`（:2）；`MAX_MONEY_CENTS = 999999999`（:3）；`OCR_POLL_DELAYS = [1000, 2000, 3000, 5000]`（:4）。
- **函数 12 个**：
  - `readyReceiptCount(receipts)`（:6-8）：status==="ready" 且 origin!=="local" 计数。
  - `occupiedReceiptCount(receipts, pending)`（:10-13）：已占小票格数（本地项无 attachmentId 或未落服务端 id 时占格）。
  - `validateReceiptFiles(occupied, files)`（:15-24）：张数超 9 → 「最多只能上传 9 张消费小票」；类型/大小（>10MB、≤0、非有限）→ 「请选择 10MB 以内的图片」；通过返回 ""。
  - `parseYuanToCents(raw)`（:26-34）：元字符串→分；空串→null；格式错/超 MAX_MONEY_CENTS → throw。
  - `formatCentsToYuan(cents)`（:36-40）：null/undefined→""；非法→throw；否则「整数.两位小数」。
  - `nextPollDelay(attempt)`（:42-44）：按 OCR_POLL_DELAYS 封顶取值。
  - `ocrStatusView(job)`（:46-53）：job 状态→{label, tone, terminal} 视图。
  - `applyOcrDishesOnce(state, jobId, incomingDishes)`（:55-65）：同 job 幂等；required 菜校验（缺失或改名 → throw「菜品要求已更新，请刷新后重试」）；成功替换 dishes 并登记 appliedJobIds。
  - `markDishEdited(dish, field, value)`（:67-70）：置 manuallyModified 并从 reviewFields 移除该字段。
  - `deriveLineTotal(quantity, unitPriceCents, explicitLineTotalCents)`（:72-78）：显式行总价优先；否则数量×单价推算并置 priceDerived；超限 throw。
  - `requiredReviewMessage(dish)`（:80-83）：reviewFields 含 actualName/quantity → 「请核对菜名和数量后再继续」。
  - `receiptDeletionOptions(attachment)`（:85-89）：按 dishImpact/appliedDishCount 给出删除选项序列。

### 6.2 router/guards.js（utils/auth.js:3-8；api.js:42；login/index.js:58-66）

- **导出清单**：`requireApprovedSession(session)` / `coldStartRoute(session)` / `handleUnauthorized()`。
- **语义契约**：
  - `requireApprovedSession(session)`：`session?.user?.status === "approved_active" && session.accessToken` → `{ ok: true, session }`；否则 `{ ok: false, redirect: "/login" }`（小程序 wx.reLaunch 改为纯判定 + redirect 由调用方执行；使用方 home/schedule/profile/location，inventory §4.2）。
  - `coldStartRoute(session)`：有 approved 会话 → `"/home"`；否则 `"/login"`（等价 login 冷启动探测分流，login js:58-66）。
  - `handleUnauthorized()`：清会话与用户缓存（等价 clearSessionAndUserCache + 任务缓存清空，api.js:42），返回 `"/login"` 供路由层跳转。

---

## 7. 服务函数 → endpoint-registry 端点映射总表

来源：packages/contracts/endpoint-registry.js（唯一机器可读端点清单）+ inventory §3.b 反向对照。方法与路径必须逐字一致。

| 服务函数（所属域） | registry 条目 | method | path |
|---|---|---|---|
| login (auth) | auth.login | POST | /api/auth/login |
| logout (auth) | auth.logout | POST | /api/auth/logout |
| requestRegisterCode (auth) | auth.registerPhoneCode | POST | /api/auth/register/phone-code |
| register (auth) | auth.register | POST | /api/auth/register |
| resubmitRegistration (auth) | auth.registrationResubmit | POST | /api/auth/registration/resubmit |
| requestPasswordCode (auth) | auth.passwordCode | POST | /api/auth/password-resets/code |
| verifyPasswordCode (auth) | auth.passwordVerify | POST | /api/auth/password-resets/verify |
| completePasswordReset (auth) | auth.passwordComplete | POST | /api/auth/password-resets/complete |
| getMyAssignments (assignments) | assignments.mine | GET | /api/assignments/mine |
| getAssignment (assignments) | assignments.byId | GET | /api/assignments/:id |
| checkIn (assignments) | assignments.checkIn | POST | /api/assignments/:id/check-in |
| startAssignment (assignments) | assignments.start | POST | /api/assignments/:id/start |
| getQuestionnaire (assignments) | assignments.questionnaire | GET | /api/assignments/:id/questionnaire |
| getDraft (drafts) | drafts.byId | GET | /api/questionnaires/secret/drafts/:id |
| saveAnswer (drafts) | drafts.answer | PUT | /api/questionnaires/secret/drafts/:id/answers/:questionId |
| createEditSession (drafts) | drafts.editSessions | POST | /api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions |
| updateEditSession (drafts) | drafts.editSession | PATCH | /api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId |
| initEvidenceUpload (drafts) | drafts.evidenceUploads | POST | /api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/evidence-uploads |
| completeEvidenceUpload (drafts) | drafts.evidenceComplete | POST | /api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/evidence-uploads/:attachmentId/complete |
| removeEvidence (drafts) | drafts.evidence | DELETE | /api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/evidence/:attachmentId |
| confirmIssue (drafts) | drafts.confirmEdit | POST | /api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/confirm |
| cancelIssue (drafts) | drafts.cancelEdit | POST | /api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/cancel |
| saveDishes (drafts) | drafts.dishes | PUT | /api/questionnaires/secret/drafts/:id/dishes |
| saveOtherRecords (drafts) | drafts.otherRecords | PUT | /api/questionnaires/secret/drafts/:id/other-records |
| submitQuestionnaire (drafts) | drafts.submit | POST | /api/questionnaires/secret/:id/submit |
| listReceiptAttachments (receipts) | drafts.receiptAttachments | GET | /api/questionnaires/secret/drafts/:id/receipt-attachments |
| initializeReceiptUpload (receipts) | drafts.receiptUploads | POST | /api/questionnaires/secret/drafts/:id/receipt-attachments/uploads |
| completeReceiptUpload (receipts) | drafts.receiptComplete | POST | /api/questionnaires/secret/drafts/:id/receipt-attachments/:attachmentId/complete |
| deleteReceiptAttachment (receipts) | drafts.receiptAttachment | DELETE | /api/questionnaires/secret/drafts/:id/receipt-attachments/:attachmentId |
| createReceiptOcrJob (receipts) | drafts.receiptOcrJobs | POST | /api/questionnaires/secret/drafts/:id/receipt-ocr-jobs |
| getReceiptOcrJob (receipts) | drafts.receiptOcrJob | GET | /api/questionnaires/secret/drafts/:id/receipt-ocr-jobs/:jobId |
| applyReceiptOcrJob (receipts) | drafts.receiptOcrApply | POST | /api/questionnaires/secret/drafts/:id/receipt-ocr-jobs/:jobId/apply |
| uploadToSignedTarget (uploads) | **无 registry 条目** | POST | 对象存储预签名 URL（服务端下发 uploadTarget.url） |
| loadPublicConfig (public-config) | public.clientConfig | GET | /api/public/client-config |
| obtainCaptchaTicket (captcha) | 无网络端点（客户端验证码链） | — | — |

差异对照（inventory §3.c）：registry 的 auth.me（GET /api/me）、auth.adminLogin、auth.adminLogout 探员端零消费；registry admin 组 60 条整体零消费；无「小程序调用了 registry 之外 /api 路径」的情况。

---

## 8. 第 2 段实现验收口径

1. **测试入口**（仓库根目录执行）：
   - 全量：`npx vitest run --config apps/web/vitest.config.js`
   - 单文件：`npx vitest run --config apps/web/vitest.config.js apps/web/tests/manifest.test.js`
2. **当前阶段测试文件清单**：
   - `apps/web/tests/manifest.test.js`（A 结构断言：app-manifest 布局 + 24 模块导出面）
   - `apps/web/tests/anti-omission.test.js`（E 反遗漏断言：api.js 33 函数双向对照 + 模块归属）
   - `apps/web/tests/helpers/contract-paths.js` 为统一加载器（非测试文件，不被收集）。
   - 后续任务将新增 `apps/web/tests/services/`、`apps/web/tests/pure/`、`apps/web/tests/rules/`；目录命名约束见 docs/web/testing.md。
3. **第 2 段完成判定**：上述命令全绿（此前为红灯基线：全部用例因 apps/web/src/** 不存在而失败）。新增任何 src 模块必须先修订本文与 srcPathList，再实现。
4. **实现纪律**：只依赖 node 环境能力（不得引入 DOM）；平台差异只允许出现在 4 个 adapters；services/store/utils/features/router 必须保持可被 node 直接 import 的纯 ESM。
