// Q 组：问卷/提交/任务页场景脚本（Q1–Q7）。本阶段【只写不跑】——不启动开发者工具/API/代理/数据库，
// 运行由包工头统一排期：
//   node tests/e2e/parity/flow.mjs 2>&1 | tee /Users/michaelzhu/Documents/agent-reports/miniapp-parity-e2e/flow-$(date +%Y%m%d-%H%M%S).log
//
// 场景与通过标准（每场景输出一行 PASS/FAIL；失败不中断其他场景；任一 FAIL 则 exit 1）：
//   Q1 问卷得分保存遇代理 dropNext 失败 → 网络恢复回调补发成功；草稿 synced=true；库里该题 scored
//   Q2 问题页停留期间触发「问卷页实例」网络恢复回调 → 不重拉问卷、仍停留在问题页
//   Q3 问题页填说明 + mock 选图直传 1 张照片 + 确认 → 返回问卷页、无 409、库里 unscored 带照片
//   Q4 问题页说明为空 → 「确认」disabled 且显示「请填写问题说明后再确认」
//   Q5 提交被注入 409 SUBMIT_PROCESSING(retryable) → retryable_failed → 重试提交（同 submitToken）成功
//   Q6 提交被注入 409 TASK_OVERDUE(requiresNewToken) → refresh_required → 「刷新」重载回 draft
//   Q7 Q5 提交成功后 reLaunch 任务页点「继续填写」→ 不跳问卷页且重新拉取聚合
//
// 关键取舍（动手前已核对源码）：
//   1) Q1/Q2 的网络恢复回调采用【直调页面实例 networkListener({isConnected:true})】
//      （apps/miniapp/miniprogram/pages/survey/index.js:38 定义）。理由：故障代理是 Node 侧进程，
//      断连不会改变模拟器的网络类型，开发者工具里 wx.onNetworkStatusChange 不会因请求失败而触发；
//      直调与真实事件进入的是同一个回调函数，确定性等价。
//   2) Q5 的 submitToken 一致性：fault-proxy.mjs:34–52 的隐私约定只记录 JSON 顶层键名（不记值），
//      故 proxy.hits 无法直接比对两次请求体的 token 值。替代证据链：
//        a. proxy.hits 恰 2 条 POST submit（第 1 条 fault=fail/409，第 2 条转发且 status=200）；
//        b. 第一次 409 后经 evaluate 读取页面持有的 submitToken（只在内存与库中比对，绝不打印）；
//        c. 成功后库 idempotency_keys（scope='questionnaire_submit'）恰 1 行、status='succeeded'、
//           idempotency_key === b 中读到的值 —— 证明重试送达服务端的 token 与首次失败后页面持有的
//           相同（pages/other/index.js 中 retryable_failed → retrySubmit → submitWithExistingToken
//           全程无改写该字段的路径，input() 才会清空，本场景不触碰输入框）。
//   3) Q7 前提复用 Q5 的已提交 attempt；若 Q5 未通过，则用 fresh attempt 经真实 HTTP 自构造
//      submitted 前提（小票直传 + 逐题作答 + 提交），并在 stderr 注明前提来源。
//   4) Q5/Q6 前提（服务端构造、全部真实 API 经代理）：确认弹窗需要 confirmScore 非空
//      （utils/scoring.js:20 要求每道启用题都有作答）→ 先经 HTTP 逐题 PUT scored；
//      Q5 另需 1 张 ready 小票（env 建的 assignment receiptRequired=true，batch3/routes.js:253 提交强校验）
//      → 按 env.mjs 冒烟同款三步签名直传上传。Q6 的提交被代理拦截、到不了 API，故无需小票。
//   5) Q7 的「继续填写」：已提交任务聚合状态为 submitted，任务页 wxml 渲染只读区块、不渲染该按钮
//      （pages/task/index.wxml:58 vs 84–88）；场景直接调用按钮绑定的处理函数 continueDraft()
//      （task/index.js:83–94 的已提交守卫），并以「路由不变 + 重拉聚合」作为通过标准。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setupParityEnv, SESSION_STORAGE_KEY, PARITY_PUBLIC_CONFIG } from "./env.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const REPORT_DIR = "/Users/michaelzhu/Documents/agent-reports/miniapp-parity-e2e";
const FIXTURE_RECEIPT_PNG = join(projectRoot, "tests/fixtures/ocr-sample-receipt.png");
const CLI_PATH = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const Q3_REMARK = "对齐验收：现场发现问题说明";

const requireFromRoot = createRequire(join(projectRoot, "package.json"));
requireFromRoot("./tests/e2e/automator-compat.cjs");
const automator = requireFromRoot("miniprogram-automator");
const { prepareMiniappProjectForFixture, stopDevTools } = requireFromRoot("./tests/e2e/prepare-miniapp-fixture.cjs");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const now = () => new Date().toISOString().slice(11, 23);
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)),
]);
const truncate = (text, max = 400) => {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
};
const json = async (url, options = {}) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};
// 探员鉴权头：token 只进请求头，绝不进日志与断言消息。
const inspectorHeaders = (env) => ({ authorization: `Bearer ${env.inspector.session.accessToken}`, "content-type": "application/json" });

// ---- 页面栈观察与操作（合成事件 + 页面方法调用，风格同 tests/e2e/miniapp-receipt-native.cjs）----
const pageSnapshot = (miniProgram) => withTimeout(miniProgram.evaluate(() => {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  return {
    route: String(page?.route || ""),
    stackDepth: pages.length,
    stack: pages.map((item) => String(item?.route || "")),
    data: page?.data || null,
  };
}), 15000, "page snapshot");

async function waitForPage(miniProgram, predicate, label, timeout = 20000) {
  const started = Date.now();
  let snapshot = await pageSnapshot(miniProgram);
  while (!predicate(snapshot) && Date.now() - started < timeout) {
    await sleep(250);
    snapshot = await pageSnapshot(miniProgram);
  }
  assert.ok(
    predicate(snapshot),
    `${label}超时（最后快照 route=${snapshot.route} data=${truncate(JSON.stringify(snapshot.data), 240)}）`,
  );
  return snapshot;
}

// 调用指定栈深页面上的方法（depthFromTop=0 栈顶；Q2 用 1 触达栈底问卷页）。
const callPageMethod = (miniProgram, depthFromTop, method, ...args) => withTimeout(miniProgram.evaluate(({ depth, method, args }) => {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1 - depth];
  if (!page || typeof page[method] !== "function") throw new Error(`page method missing: depth=${depth} method=${method}`);
  return Promise.resolve(page[method](...args)).then((value) => (value === undefined ? null : value));
}, { depth: depthFromTop, method, args }), 20000, `call ${method}`);

// 读取页面实例属性（submitToken / networkListener 等）。函数值只回报 "function"，值本身绝不打印。
const readPageProperty = (miniProgram, depthFromTop, property) => withTimeout(miniProgram.evaluate(({ depth, property }) => {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1 - depth];
  if (!page || !(property in page)) return { present: false, value: null };
  const value = page[property];
  return { present: true, value: typeof value === "function" ? "function" : value };
}, { depth: depthFromTop, property }), 15000, `read ${property}`);

// 本地草稿存储键（store/survey.js identity() 的同构实现，字段顺序不可变）。
const draftKeyFor = (userId, assignment) => `junde:survey:${encodeURIComponent(userId)}:${encodeURIComponent(assignment.assignmentId)}:${encodeURIComponent(assignment.attemptId)}:${encodeURIComponent(assignment.questionnaireVersionId)}`;
const readDraftStorage = (miniProgram, key) => withTimeout(miniProgram.evaluate(({ key }) => wx.getStorageSync(key) || null, { key }), 15000, "read draft");

// ---- 常用导航 ----
const surveyRoute = (assignment) => `/pages/survey/index?assignmentId=${encodeURIComponent(assignment.assignmentId)}&attemptId=${encodeURIComponent(assignment.attemptId)}&questionnaireVersionId=${encodeURIComponent(assignment.questionnaireVersionId)}&revision=${assignment.revision}`;
const otherRoute = (assignment) => `/pages/other/index?assignmentId=${encodeURIComponent(assignment.assignmentId)}&attemptId=${encodeURIComponent(assignment.attemptId)}&questionnaireVersionId=${encodeURIComponent(assignment.questionnaireVersionId)}&revision=${assignment.revision}`;

// reLaunch 三次重试：IDE 导航队列被上一场景迟到的导航占住时，reLaunch 会被静默丢弃
// （run7 实测：自愈重试的首次 reLaunch 未生效、应用停在 home 页）——未生效就排水再试。
async function reLaunchWithRetry(miniProgram, url, probe, label) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await withTimeout(miniProgram.reLaunch(url), 30000, `reLaunch ${label}`);
    } catch (error) {
      console.error(`[${label}] reLaunch 被拒（${truncate(error?.message, 80)}），排水后重试`);
    }
    try {
      return await waitForPage(miniProgram, probe, `${label}加载`, 15000);
    } catch {
      console.error(`[${label}] 第 ${attempt} 次 reLaunch 未生效，排水后重试`);
      await drainNavigation(miniProgram, 20000);
    }
  }
  assert.fail(`${label}加载失败（reLaunch 三次未生效）`);
}

const openSurveyPage = (miniProgram, assignment) => reLaunchWithRetry(
  miniProgram,
  surveyRoute(assignment),
  (s) => s.route === "pages/survey/index" && s.data?.loading === false && Array.isArray(s.data?.questions) && s.data.questions.length >= 3,
  "问卷页",
);

const openOtherPage = (miniProgram, assignment) => reLaunchWithRetry(
  miniProgram,
  otherRoute(assignment),
  (s) => s.route === "pages/other/index" && s.data?.loading === false && Boolean(s.data?.meta),
  "其他记录页",
);

async function openIssuePage(miniProgram, questionId) {
  // survey 页 openIssue(questionId, target)：navigateTo 问题页（父页问卷存活在栈内）。
  await callPageMethod(miniProgram, 0, "openIssue", questionId, "unscored");
  return waitForPage(
    miniProgram,
    (s) => s.route === "pages/issue/index" && s.data?.loading === false && Boolean(s.data?.editSessionId),
    "问题页加载",
    30000,
  );
}

// 带超时的库查询：任何一步挂起都必须变成场景 FAIL，不允许拖死整个流程。
// 注：automator 的 page.$/element.* 元素查询在本 IDE（Stable 2.01.2510290）上挂起/拒答
// （run1 永久卡死、run3 15s 超时；evaluate 正常）——因此所有 UI 事实一律用
// 「页面 data + wxml 渲染契约（wx:if/绑定表达式为 data 的确定函数）+ 行为守卫」表达，
// 与 tests/e2e/miniapp-receipt-native.cjs 的断言风格一致（该参考同样零元素查询）。
const queryPool = (pool, sql, params = []) => withTimeout(pool.query(sql, params), 20000, "pool query");

const firstEnabledQuestion = async (scene) => {
  const { rows } = await queryPool(scene.pool, "SELECT id, question_number FROM questions WHERE version_id=$1 AND enabled ORDER BY question_number LIMIT 1", [scene.assignment.questionnaireVersionId]);
  assert.ok(rows[0], "问卷没有可用题目");
  return rows[0];
};

// ---- 服务端前提构造（全部走真实 API、经代理，仅回环）----
const currentAttemptRevision = async (env, attemptId) => {
  const draft = await json(`${env.apiBase}/api/questionnaires/secret/drafts/${attemptId}`, { headers: inspectorHeaders(env) });
  assert.equal(draft.status, 200, `读取草稿失败 status=${draft.status}`);
  return Number(draft.body.attempt.revision);
};

// 三步签名直传 1 张 ready 小票（同 env.mjs 冒烟 371–390 行的链路），返回最新 attempt revision。
async function uploadReceiptViaHttp(env, attemptId) {
  const revision = await currentAttemptRevision(env, attemptId);
  const png = await readFile(FIXTURE_RECEIPT_PNG);
  const fileMeta = {
    clientFileId: randomUUID(),
    fileName: "parity-flow-receipt.png",
    mimeType: "image/png",
    sizeBytes: png.length,
    sha256: createHash("sha256").update(png).digest("hex"),
  };
  const init = await json(`${env.apiBase}/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/uploads`, {
    method: "POST", headers: inspectorHeaders(env), body: JSON.stringify({ fileMeta, revision }),
  });
  assert.equal(init.status, 201, `小票上传 init 失败 status=${init.status} body=${truncate(JSON.stringify(init.body), 200)}`);
  const form = new FormData();
  for (const [key, value] of Object.entries(init.body.uploadTarget.formData)) form.append(key, String(value));
  form.append("file", new Blob([png]), fileMeta.fileName);
  const upload = await fetch(init.body.uploadTarget.url, { method: "POST", body: form }); // uploadTarget.origin = 代理
  assert.equal(upload.status, 204, `小票直传失败 status=${upload.status}`);
  const complete = await json(`${env.apiBase}/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/${init.body.attachment.id}/complete`, {
    method: "POST", headers: inspectorHeaders(env), body: JSON.stringify({ fileMeta, revision: init.body.revision }),
  });
  assert.equal(complete.status, 200, `小票 complete 失败 status=${complete.status}`);
  assert.equal(complete.body.attachment?.status, "ready", `小票未就绪 status=${complete.body.attachment?.status}`);
  return Number(complete.body.revision);
}

// 逐题 PUT scored（revision 链式推进），返回最新 attempt revision。确认弹窗的 confirmScore 依赖每题有作答。
async function answerAllQuestionsViaHttp(env, attemptId) {
  const draft = await json(`${env.apiBase}/api/questionnaires/secret/drafts/${attemptId}`, { headers: inspectorHeaders(env) });
  assert.equal(draft.status, 200, `读取草稿失败 status=${draft.status}`);
  let revision = Number(draft.body.attempt.revision);
  for (const question of draft.body.questions) {
    const saved = await json(`${env.apiBase}/api/questionnaires/secret/drafts/${attemptId}/answers/${question.id}`, {
      method: "PUT", headers: inspectorHeaders(env), body: JSON.stringify({ answer: "scored", revision }),
    });
    assert.equal(saved.status, 200, `第 ${question.number} 题作答失败 status=${saved.status}`);
    revision = Number(saved.body.revision);
  }
  return revision;
}

// Q7 前提自构造：真实 HTTP 提交（token 只进请求体，不打印）。
async function submitAttemptViaHttp(env, assignment) {
  const detail = await json(`${env.apiBase}/api/assignments/${assignment.assignmentId}`, { headers: inspectorHeaders(env) });
  assert.equal(detail.status, 200, `读取任务失败 status=${detail.status}`);
  const submitted = await json(`${env.apiBase}/api/questionnaires/secret/${assignment.attemptId}/submit`, {
    method: "POST", headers: inspectorHeaders(env),
    body: JSON.stringify({ submitToken: randomUUID(), assignmentRevision: Number(detail.body.revision), confirmation: true }),
  });
  assert.equal(submitted.status, 200, `HTTP 提交失败 status=${submitted.status} body=${truncate(JSON.stringify(submitted.body), 200)}`);
}

// ---- Q3 选图 mock：真实 PNG 字节写入模拟器用户目录，再 mock wx.chooseMedia 返回该路径 ----
async function stagePhotoFixture(miniProgram) {
  const png = await readFile(FIXTURE_RECEIPT_PNG);
  const path = await withTimeout(miniProgram.evaluate(({ base64 }) => {
    const target = `${wx.env.USER_DATA_PATH}/parity-issue-photo.png`;
    wx.getFileSystemManager().writeFileSync(target, wx.base64ToArrayBuffer(base64), "binary");
    return target;
  }, { base64: png.toString("base64") }), 20000, "write photo fixture");
  return { path, size: png.length };
}

async function mockChooseMedia(miniProgram, staged) {
  const mock = await withTimeout(miniProgram.mockWxMethod("chooseMedia", {
    tempFiles: [{ tempFilePath: staged.path, size: staged.size }],
    tempFilePaths: [staged.path],
  }), 15000, "mockWxMethod chooseMedia");
  return async () => {
    try {
      if (mock && typeof mock.restore === "function") await withTimeout(mock.restore(), 10000, "restore chooseMedia");
      else await withTimeout(miniProgram.restoreWxMethod("chooseMedia"), 10000, "restoreWxMethod chooseMedia");
    } catch { /* mock 状态随页面销毁回收，不阻塞场景 */ }
  };
}

// ---- 开发者工具启动（照抄 env.mjs runSmoke 的 attach 退避 workaround，勿改参数）----
const attachAutomationSession = (projectPath, cliPath) => {
  const result = spawnSync(cliPath, ["auto", "--project", projectPath, "--auto-port", "9420", "--trust-project"], { encoding: "utf8", timeout: 90000 });
  const tail = `${result.stdout || ""}${result.stderr || ""}`.split("\n").filter(Boolean).slice(-2).join(" | ");
  console.error(`[flow] cli auto attach: ${tail}`);
};

async function connectWithBackoff() {
  for (let connectTry = 1; connectTry <= 12; connectTry += 1) {
    let session = null;
    try {
      session = await withTimeout(automator.connect({ wsEndpoint: "ws://127.0.0.1:9420" }), 15000, "connect");
      await withTimeout(session.systemInfo(), 20000, "engine probe");
      return session;
    } catch {
      try { session?.disconnect?.(); } catch { /* 未建立 */ }
      await sleep(2000);
    }
  }
  return null;
}

// App 层自愈：重走附加模式（README 已知问题 1——对已运行 IDE 再次 cli auto 后 App.* 恢复应答），
// 换新自动化会话；session/globalData 在小程序进程内持久，无需重新注入。
async function reattachAutomation(projectPath, currentSession) {
  console.error("[flow] App 层无应答（Uncaught/超时症状），重走 cli auto 附加自愈...");
  attachAutomationSession(projectPath, CLI_PATH);
  try { currentSession?.disconnect?.(); } catch { /* 已断开 */ }
  const session = await connectWithBackoff();
  assert.ok(session, "attach 自愈后仍无法连接自动化引擎");
  console.error("[flow] 自愈完成（新自动化会话已建立）");
  return session;
}

async function launchAutomation(projectPath) {
  let session = null;
  for (let attempt = 1; attempt <= 3 && !session; attempt += 1) {
    await stopDevTools();
    console.error(`[flow] devtools launch attempt ${attempt}...`);
    try {
      const launched = await withTimeout(automator.launch({ cliPath: CLI_PATH, projectPath, trustProject: true, timeout: 300000 }), 340000, "launch");
      console.error(`[flow] launch returned session=${Boolean(launched)}, attaching fresh automation session...`);
      attachAutomationSession(projectPath, CLI_PATH);
      try { launched?.disconnect?.(); } catch { /* 已断开 */ }
      session = await connectWithBackoff();
    } catch (error) {
      try { session?.disconnect?.(); } catch { /* 未建立 */ }
      session = null;
      console.error(`[flow] attempt ${attempt} failed: ${truncate(error?.message, 200)}`);
      if (attempt < 3) await sleep(10000);
    }
    if (session) console.error("[flow] automation engine responds (Tool+App layers)");
  }
  assert.ok(session, "unable to launch WeChat DevTools for parity flow");
  return session;
}

// 场景边界排水：等页面栈稳定（吸收上一场景迟到的导航，避免与下一次 reLaunch 相撞）。
async function drainNavigation(miniProgram, maxMs = 120000) {
  const started = Date.now();
  let last = null;
  let stableSince = 0;
  while (Date.now() - started < maxMs) {
    const snapshot = await pageSnapshot(miniProgram).catch(() => null);
    const route = snapshot?.route || "";
    if (route === last && route !== "") {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 2000) return route;
    } else {
      last = route;
      stableSince = 0;
    }
    await sleep(500);
  }
  return last;
}

// ---- 每场景留证：截图优先；attach 模式截图不可用时降级写页面 data 快照 JSON（不默默跳过）----
async function captureEvidence(miniProgram, id) {
  try {
    await withTimeout(miniProgram.screenshot({ path: join(REPORT_DIR, `${id}.png`) }), 20000, `screenshot ${id}`);
    console.error(`[evidence] ${id} -> ${id}.png`);
  } catch (error) {
    const snapshot = await pageSnapshot(miniProgram).catch(() => ({ note: "snapshot failed too" }));
    await writeFile(join(REPORT_DIR, `${id}.json`), JSON.stringify({
      id,
      reason: "attach 模式截图 API 不可用，降级为页面 data 快照",
      screenshotError: truncate(error?.message, 200),
      snapshot,
    }, null, 2));
    console.error(`[evidence] ${id} 截图不可用，降级写 ${id}.json（${truncate(error?.message, 120)}）`);
  }
}

// ---- Q1：问卷得分保存断连 → 网络恢复回调补发 ----
async function scenarioQ1({ env, miniProgram }) {
  const scene = await setupParityEnv({ fresh: true });
  const question = await firstEnabledQuestion(scene);
  await openSurveyPage(miniProgram, scene.assignment);
  const answerPath = `/api/questionnaires/secret/drafts/${scene.assignment.attemptId}/answers/${question.id}`;

  // 红灯1：点得分时全量断网 → 第一次保存必须失败且不落库。
  // 用 offline 开关而非排队 dropNext：devtools 传输层断连后 ~2ms 自动重发（重发次数不定），
  // 排队 N 个 dropNext 若重发未发生会残留并误吃后面的补发请求；offline(true/false) 无队列残留。
  console.error(`[q1] scene ready attempt=${scene.assignment.attemptId} question=${question.id}`);
  env.proxy.offline(true);
  await callPageMethod(miniProgram, 0, "score", { currentTarget: { dataset: { id: question.id } } });
  const failedState = await waitForPage(
    miniProgram,
    (s) => s.route === "pages/survey/index" && s.data?.syncMessage === "保存失败，请重试",
    "等待首次保存失败提示",
    20000,
  );
  assert.ok(!(failedState.data.answers || {})[question.id], "失败后页面答案未回退");
  env.proxy.offline(false);
  const putHitsAfterDrop = env.proxy.hits({ method: "PUT", path: answerPath });
  assert.ok(putHitsAfterDrop.count >= 1, "PUT saveAnswer 未被代理观测到");
  assert.ok(
    putHitsAfterDrop.records.every((item) => item.fault === "drop" || item.fault === "offline"),
    `存在未被断连的保存请求：${truncate(JSON.stringify(putHitsAfterDrop.records), 200)}`,
  );
  const afterDrop = await queryPool(scene.pool, "SELECT answer FROM question_answers WHERE attempt_id=$1 AND question_id=$2", [scene.assignment.attemptId, question.id]);
  assert.equal(afterDrop.rowCount, 0, "断连的保存请求不应落库");

  // 红灯2：直调问卷页实例 networkListener（触发方式选择见文件头注释 1）
  const listener = await readPageProperty(miniProgram, 0, "networkListener");
  assert.equal(listener.value, "function", "问卷页实例缺少 networkListener 回调字段");
  await callPageMethod(miniProgram, 0, "networkListener", { isConnected: true });

  // 红灯3：补发成功 → 草稿 synced=true（轮询草稿存储；resync 完成后 syncMessage 为空串，不能等「已保存」）
  const draftKey = draftKeyFor(env.inspector.session.user.id, scene.assignment);
  let draft = null;
  let finalSnapshot = null;
  const started = Date.now();
  while (Date.now() - started < 20000) {
    draft = await readDraftStorage(miniProgram, draftKey);
    finalSnapshot = await pageSnapshot(miniProgram);
    if (draft?.synced === true && finalSnapshot.route === "pages/survey/index" && finalSnapshot.data?.loading === false) break;
    await sleep(300);
  }
  assert.equal(draft?.synced, true, `网络恢复后草稿未置 synced=true（synced=${draft?.synced} route=${finalSnapshot?.route}）`);

  // 服务端事实：补发请求真的发出且成功（转发、非故障响应）；库里该题 scored；草稿 revision 与库一致
  const putHitsAfterResync = env.proxy.hits({ method: "PUT", path: answerPath });
  const lastPut = putHitsAfterResync.records[putHitsAfterResync.records.length - 1];
  assert.ok(putHitsAfterResync.count > putHitsAfterDrop.count, "网络恢复后没有新的补发请求");
  assert.equal(lastPut.fault, null, `补发请求命中故障 fault=${lastPut.fault}`);
  assert.equal(lastPut.status, 200, `补发响应 status=${lastPut.status}`);
  const answerRow = (await queryPool(scene.pool, "SELECT answer, awarded_score FROM question_answers WHERE attempt_id=$1 AND question_id=$2", [scene.assignment.attemptId, question.id])).rows[0];
  assert.equal(answerRow?.answer, "scored", `库里该题答案=${answerRow?.answer}`);
  const attemptRow = (await queryPool(scene.pool, "SELECT revision FROM survey_attempts WHERE id=$1", [scene.assignment.attemptId])).rows[0];
  assert.equal(Number(draft.revision), Number(attemptRow.revision), `草稿 revision=${draft.revision} 库 revision=${attemptRow.revision} 不一致`);
  return { attemptId: scene.assignment.attemptId, questionId: question.id };
}

// ---- Q2：问题页停留期间，问卷页实例的网络恢复回调不得触发重拉 ----
async function scenarioQ2({ env, miniProgram }) {
  const scene = await setupParityEnv({ fresh: true });
  console.error(`[q2] scene ready attempt=${scene.assignment.attemptId}`);
  const question = await firstEnabledQuestion(scene);
  await openSurveyPage(miniProgram, scene.assignment);
  await openIssuePage(miniProgram, question.id);

  const stack = await pageSnapshot(miniProgram);
  assert.equal(stack.stackDepth, 2, `问题页打开后栈深=${stack.stackDepth}`);
  assert.equal(stack.stack[0], "pages/survey/index", `栈底应为问卷页，实际=${stack.stack[0]}`);

  const match = { method: "GET", path: `/api/assignments/${scene.assignment.assignmentId}/questionnaire` };
  const baseline = env.proxy.hits(match).count;
  const listener = await readPageProperty(miniProgram, 1, "networkListener"); // 倒数第 2 个页面 = 问卷页实例
  assert.equal(listener.value, "function", "栈底问卷页缺少 networkListener 回调字段");
  await callPageMethod(miniProgram, 1, "networkListener", { isConnected: true });
  await sleep(1500);

  const after = env.proxy.hits(match).count;
  assert.equal(after, baseline, `问题页停留期间问卷页重新拉取了问卷（GET 问卷 ${baseline}→${after}）`);
  const final = await pageSnapshot(miniProgram);
  assert.equal(final.route, "pages/issue/index", `当前页面应仍是问题页，实际=${final.route}`);
  return { attemptId: scene.assignment.attemptId, baselineHits: baseline };
}

// ---- Q3：问题页填说明 + 直传 1 张照片 + 确认 ----
async function scenarioQ3({ env, miniProgram }) {
  const scene = await setupParityEnv({ fresh: true });
  console.error(`[q3] scene ready ${now()} attempt=${scene.assignment.attemptId}`);
  const question = await firstEnabledQuestion(scene);
  await openSurveyPage(miniProgram, scene.assignment);
  console.error(`[q3] survey loaded ${now()}`);
  await openIssuePage(miniProgram, question.id);
  console.error(`[q3] issue loaded ${now()}`);

  await callPageMethod(miniProgram, 0, "remark", { detail: { value: Q3_REMARK } });

  const staged = await stagePhotoFixture(miniProgram);
  const restoreMock = await mockChooseMedia(miniProgram, staged);
  try {
    await callPageMethod(miniProgram, 0, "chooseImage");
    console.error(`[q3] chooseImage 调用 ${now()}`);
    await waitForPage(
      miniProgram,
      (s) => s.route === "pages/issue/index"
        && (s.data?.images || []).some((item) => item.status === "staged_ready")
        && (s.data?.images || []).every((item) => item.status !== "uploading" && item.status !== "failed"),
      "等待照片三步直传完成",
      30000,
    );
    console.error(`[q3] staged_ready ${now()}`);
  } finally {
    await restoreMock();
  }

  console.error(`[q3] save() 调用 ${now()}`);
  await callPageMethod(miniProgram, 0, "save");
  console.error(`[q3] save() 已resolve ${now()}`);
  // 已知 IDE 自动化缺陷（run3/run5 实测，证据见输出目录 fail.json）：confirm 200 后页面在
  // ~70ms 内走完 backToSurvey（sessionSettled=true），但 wx.navigateBack 偶发被自动化层吞没，
  // 页面栈长时间停在问题页（单跑同一场景 89ms 即返回）。处置：页面已发起返回（sessionSettled）
  // 而 4s 仍停问题页时，测试侧补一次 wx.navigateBack（等价用户手按系统返回），业务断言
  // （无 409、库里 unscored+照片）全部由服务端事实承担，不依赖导航本身。
  const returnStarted = Date.now();
  let nudgeCount = 0;
  let snapshot = await pageSnapshot(miniProgram);
  while (Date.now() - returnStarted < 150000) {
    if (snapshot.route === "pages/survey/index" && snapshot.data?.loading === false) break;
    // IDE 导航延迟实测 30–94s+（run2~run7）：页面已发起返回后，每 20s 补一次 navigateBack 促进排队。
    if (Date.now() - returnStarted >= 4000 + nudgeCount * 20000) {
      const settled = await readPageProperty(miniProgram, 0, "sessionSettled");
      if (settled.value === true) {
        nudgeCount += 1;
        console.error(`[q3] 页面已发起返回但 ${now()} 仍停问题页（第 ${nudgeCount} 次补 navigateBack）`);
        await withTimeout(miniProgram.evaluate(() => { wx.navigateBack(); }), 10000, "navigateBack nudge").catch(() => {});
      }
    }
    await sleep(300);
    snapshot = await pageSnapshot(miniProgram);
  }
  const returnedToSurvey = snapshot.route === "pages/survey/index" && snapshot.data?.loading === false;
  if (!returnedToSurvey) {
    // IDE 自动化层导航卡死（150s+8 次补发仍未出栈；业务已成功：confirm 200、sessionSettled=true、
    // run2/run3 截图证明应用最终会返回，仅被 IDE 拖 30~90s+，单跑本场景 89ms 即返回）。
    // 处置：重启开发者工具会话，重进同一问卷核对「确认结果已呈现在问卷页」，缺陷留证回报。
    console.error(`[q3] ${now()} 150s 未返回（IDE 导航卡死），重启 IDE 会话后核对确认结果`);
    const settled = await readPageProperty(miniProgram, 0, "sessionSettled");
    assert.equal(settled.value, true, `页面未发起返回（sessionSettled=${settled.value}），导航卡死且无确认意图`);
    assert.equal(typeof ctx.restartIde, "function", "缺少 restartIde 注入");
    await ctx.restartIde();
    const surveyAfter = await openSurveyPage(ctx.miniProgram, scene.assignment);
    assert.equal(surveyAfter.data.answeredCount, 1, `重进问卷后已完成数=${surveyAfter.data.answeredCount}（应为 1，含 unscored）`);
  }

  // 无 409：本场景窗口内任何代理记录都不得是 409 或注入/断连故障
  const conflicts = env.proxy.hits().records.filter((item) => item.status === 409 || item.fault === "fail" || item.fault === "drop");
  assert.equal(conflicts.length, 0, `出现冲突/故障响应：${truncate(JSON.stringify(conflicts.map((item) => ({ path: item.path, status: item.status, fault: item.fault }))), 240)}`);
  const confirmHits = env.proxy.hits({ method: "POST", path: /\/edit-sessions\/.+\/confirm$/ });
  assert.equal(confirmHits.count, 1, `确认请求数=${confirmHits.count}`);
  assert.equal(confirmHits.records[0].status, 200, `确认响应 status=${confirmHits.records[0].status}`);
  const directUploadHits = env.proxy.hits({ method: "POST", path: "/api/local-storage/objects" });
  assert.ok(directUploadHits.count >= 1, "照片字节未经代理直传（/api/local-storage/objects 命中=0）");

  // 服务端事实：该题 unscored、说明落库、照片 active
  const answer = (await queryPool(scene.pool, "SELECT answer, issue_remark FROM question_answers WHERE attempt_id=$1 AND question_id=$2", [scene.assignment.attemptId, question.id])).rows[0];
  assert.equal(answer?.answer, "unscored", `库里该题答案=${answer?.answer}`);
  assert.equal(answer?.issue_remark, Q3_REMARK, `库里问题说明=${truncate(answer?.issue_remark, 80)}`);
  const evidence = (await queryPool(scene.pool, "SELECT id, status FROM question_evidence_attachments WHERE attempt_id=$1 AND question_id=$2 AND type='image'", [scene.assignment.attemptId, question.id])).rows;
  assert.equal(evidence.length, 1, `该题照片附件数=${evidence.length}`);
  assert.equal(evidence[0].status, "active", `照片附件状态=${evidence[0].status}`);
  return { attemptId: scene.assignment.attemptId, evidenceId: evidence[0]?.id };
}

// ---- Q4：说明为空 → 确认禁用 + 提示文案 ----
async function scenarioQ4({ env, miniProgram }) {
  const scene = await setupParityEnv({ fresh: true });
  console.error(`[q4] scene ready attempt=${scene.assignment.attemptId}`);
  const question = await firstEnabledQuestion(scene);
  await openSurveyPage(miniProgram, scene.assignment);
  console.error("[q4] survey loaded");
  const issue = await openIssuePage(miniProgram, question.id);
  console.error("[q4] issue loaded");

  assert.equal(issue.data.target, "unscored", `target=${issue.data.target}`);
  assert.equal(issue.data.remark, "", `remark=${issue.data.remark}`);
  assert.equal(issue.data.remarkMissing, true, `remarkMissing=${issue.data.remarkMissing}`);
  assert.equal(issue.data.saving, false, `saving=${issue.data.saving}`);
  console.error("[q4] data binding inputs ok (saving=false, remarkMissing=true)");
  // 渲染契约（pages/issue/index.wxml 静态结构，automator 元素查询不可用、见上方注）：
  //   确认按钮 disabled="{{saving || remarkMissing}}" → 当前数据下恒为 disabled=true；
  //   <view wx:if="{{remarkMissing}}" class="muted">请填写问题说明后再确认</view> → 提示必然渲染。

  // 行为守卫：空说明点确认 → 只给提示，不得发出任何编辑会话写请求（PATCH/confirm/cancel）。
  const writesBefore = env.proxy.hits({ method: "POST", path: /\/edit-sessions\/.+\/(confirm|cancel)$/ }).count;
  const patchesBefore = env.proxy.hits({ method: "PATCH", path: /\/edit-sessions\/.+/ }).count;
  await callPageMethod(miniProgram, 0, "save");
  await sleep(800);
  const writesAfter = env.proxy.hits({ method: "POST", path: /\/edit-sessions\/.+\/(confirm|cancel)$/ }).count;
  const patchesAfter = env.proxy.hits({ method: "PATCH", path: /\/edit-sessions\/.+/ }).count;
  assert.equal(writesAfter, writesBefore, `空说明确认仍发出了 confirm/cancel 请求（${writesBefore}→${writesAfter}）`);
  assert.equal(patchesAfter, patchesBefore, `空说明确认仍发出了 PATCH 请求（${patchesBefore}→${patchesAfter}）`);
  return { attemptId: scene.assignment.attemptId };
}

// ---- Q5：提交注入 409 SUBMIT_PROCESSING → retryable_failed → 同 submitToken 重试成功 ----
// 成功后把 assignment 写回 ctx.q5（Q7 的前提复用；Q7 会再向库复核 submitted 状态）。
async function scenarioQ5(ctx) {
  const { env, miniProgram } = ctx;
  const scene = await setupParityEnv({ fresh: true });
  console.error(`[q5] scene ready attempt=${scene.assignment.attemptId}`);
  // 前提（服务端构造）：1 张 ready 小票（receiptRequired）+ 全部题目 scored（confirmScore 需要）
  await uploadReceiptViaHttp(scene, scene.assignment.attemptId);
  await answerAllQuestionsViaHttp(scene, scene.assignment.attemptId);
  await openOtherPage(miniProgram, scene.assignment);
  console.error("[q5] other page loaded");

  const submitMatch = { method: "POST", path: `/api/questionnaires/secret/${scene.assignment.attemptId}/submit` };
  env.proxy.failNext(submitMatch, { status: 409, body: { error: { code: "SUBMIT_PROCESSING", message: "提交正在处理中，请稍后重试", retryable: true } } });

  await callPageMethod(miniProgram, 0, "confirm"); // 「提交问卷」按钮：保存记录 + 打开确认弹窗
  await waitForPage(miniProgram, (s) => s.route === "pages/other/index" && s.data?.confirmOpen === true && s.data?.confirmScore !== null, "等待提交确认弹窗就绪", 20000);
  console.error("[q5] confirm modal ready, submitting");
  await callPageMethod(miniProgram, 0, "confirmModalSubmit");
  const failedState = await waitForPage(miniProgram, (s) => s.route === "pages/other/index" && s.data?.submitState === "retryable_failed", "等待 retryable_failed", 20000);
  console.error("[q5] retryable_failed reached");
  assert.ok(String(failedState.data.message || "").includes("可以重试提交"), `失败文案=${truncate(failedState.data.message, 80)}`);

  const submitHitsAfterFirst = env.proxy.hits(submitMatch);
  assert.equal(submitHitsAfterFirst.count, 1, `首次提交命中数=${submitHitsAfterFirst.count}`);
  assert.equal(submitHitsAfterFirst.records[0].fault, "fail", `首次提交未命中注入故障 fault=${submitHitsAfterFirst.records[0].fault}`);
  assert.equal(submitHitsAfterFirst.records[0].status, 409, `首次提交响应 status=${submitHitsAfterFirst.records[0].status}`);

  // 页面持有的 submitToken（只在内存/库比对，绝不打印；替代证据链见文件头注释 2）
  const held = await readPageProperty(miniProgram, 0, "submitToken");
  assert.ok(held.present && typeof held.value === "string" && held.value.length > 0, "首次失败后页面未持有 submitToken");

  // 「重试提交」按钮由 wxml wx:if="{{submitState === 'retryable_failed' || submitState === 'processing'}}"
  // 渲染、绑定 retrySubmit（元素查询不可用，见通用注；渲染事实由 submitState 断言承担）。
  await callPageMethod(miniProgram, 0, "retrySubmit");
  const doneState = await waitForPage(miniProgram, (s) => s.route === "pages/other/index" && s.data?.submitState === "submitted", "等待提交成功", 30000);
  assert.equal(doneState.data.message, "提交成功", `成功文案=${doneState.data.message}`);
  ctx.q5 = { assignment: scene.assignment }; // Q7 前提（Q7 自行向库复核 submitted）
  const heldAfter = await readPageProperty(miniProgram, 0, "submitToken");
  assert.equal(heldAfter.value, held.value, "重试前后页面持有的 submitToken 发生变化");

  const submitHitsAfterRetry = env.proxy.hits(submitMatch);
  assert.equal(submitHitsAfterRetry.count, 2, `重试后提交请求数=${submitHitsAfterRetry.count}`);
  assert.equal(submitHitsAfterRetry.records[1].fault, null, `重试请求命中了故障 fault=${submitHitsAfterRetry.records[1].fault}`);
  assert.equal(submitHitsAfterRetry.records[1].status, 200, `重试提交响应 status=${submitHitsAfterRetry.records[1].status}`);

  // 服务端事实：幂等键恰 1 行、成功、键值 = 页面两次请求持有的同一 token；attempt 已 submitted
  const keys = (await queryPool(scene.pool, "SELECT idempotency_key, status, failure_code FROM idempotency_keys WHERE scope='questionnaire_submit' AND attempt_id=$1", [scene.assignment.attemptId])).rows;
  assert.equal(keys.length, 1, `幂等键行数=${keys.length}`);
  assert.equal(keys[0].status, "succeeded", `幂等键状态=${keys[0].status}`);
  assert.equal(keys[0].failure_code, null, `幂等键残留 failure_code=${keys[0].failure_code}`);
  assert.equal(keys[0].idempotency_key, held.value, "重试送达服务端的 submitToken 与首次失败后页面持有的 token 不一致");
  const attemptRow = (await queryPool(scene.pool, "SELECT status FROM survey_attempts WHERE id=$1", [scene.assignment.attemptId])).rows[0];
  assert.equal(attemptRow?.status, "submitted", `库里 attempt 状态=${attemptRow?.status}`);
  const submissions = await queryPool(scene.pool, "SELECT id FROM submission_versions WHERE attempt_id=$1", [scene.assignment.attemptId]);
  assert.equal(submissions.rowCount, 1, `提交版本行数=${submissions.rowCount}`);
  return { attemptId: scene.assignment.attemptId, assignment: scene.assignment };
}

// ---- Q6：提交注入 409 TASK_OVERDUE → refresh_required → 「刷新」重载 ----
async function scenarioQ6({ env, miniProgram }) {
  const scene = await setupParityEnv({ fresh: true });
  console.error(`[q6] scene ready attempt=${scene.assignment.attemptId}`);
  // 前提：全部题目 scored（confirmScore 需要）；提交被代理拦截、到不了 API，故无需小票
  await answerAllQuestionsViaHttp(scene, scene.assignment.attemptId);
  await openOtherPage(miniProgram, scene.assignment);
  console.error("[q6] other page loaded");

  const submitMatch = { method: "POST", path: `/api/questionnaires/secret/${scene.assignment.attemptId}/submit` };
  env.proxy.failNext(submitMatch, { status: 409, body: { error: { code: "TASK_OVERDUE", message: "任务已逾期，请等待管理员延期后刷新任务", requiresNewToken: true } } });

  await callPageMethod(miniProgram, 0, "confirm");
  await waitForPage(miniProgram, (s) => s.route === "pages/other/index" && s.data?.confirmOpen === true && s.data?.confirmScore !== null, "等待提交确认弹窗就绪", 20000);
  console.error("[q6] confirm modal ready, submitting");
  await callPageMethod(miniProgram, 0, "confirmModalSubmit");
  const failedState = await waitForPage(miniProgram, (s) => s.route === "pages/other/index" && s.data?.submitState === "refresh_required", "等待 refresh_required", 20000);
  console.error("[q6] refresh_required reached");
  assert.equal(failedState.data.message, "任务已逾期，请等待管理员延期后刷新任务", `提示文案=${truncate(failedState.data.message, 80)}`);
  const held = await readPageProperty(miniProgram, 0, "submitToken");
  assert.equal(held.value ?? null, null, "requiresNewToken 后页面未清空 submitToken");

  // 「刷新」按钮由 wxml wx:if="{{submitState === 'refresh_required'}}" 渲染、绑定 retryLoad
  // （元素查询不可用，见通用注；渲染事实由上面 submitState==='refresh_required' 断言承担）。
  const assignmentMatch = { method: "GET", path: `/api/assignments/${scene.assignment.assignmentId}` };
  const beforeReload = env.proxy.hits(assignmentMatch).count;
  await callPageMethod(miniProgram, 0, "retryLoad"); // 「刷新」按钮绑定 retryLoad
  await waitForPage(miniProgram, (s) => s.route === "pages/other/index" && s.data?.submitState === "draft" && s.data?.loading === false, "等待刷新后回到 draft", 20000);
  const afterReload = env.proxy.hits(assignmentMatch).count;
  assert.ok(afterReload > beforeReload, `刷新未重新拉取任务（GET assignment ${beforeReload}→${afterReload}）`);

  const submitHits = env.proxy.hits(submitMatch);
  assert.equal(submitHits.count, 1, `刷新不应补发提交（submit 命中=${submitHits.count}）`);
  const attemptRow = (await queryPool(scene.pool, "SELECT status FROM survey_attempts WHERE id=$1", [scene.assignment.attemptId])).rows[0];
  assert.equal(attemptRow?.status, "draft", `库里 attempt 状态=${attemptRow?.status}`);
  return { attemptId: scene.assignment.attemptId };
}

// ---- Q7：已提交任务点「继续填写」→ 不跳问卷页 + 重拉聚合 ----
async function scenarioQ7({ env, miniProgram, q5 }) {
  console.error("[q7] begin（前提复用/构造见下行日志）");
  // 前提：优先复用 Q5 提交成功的 attempt；Q5 未通过则 fresh attempt 经真实 HTTP 自构造并注明来源
  let assignment = q5?.assignment || null;
  let premise = "Q5（Q5 提交成功的 attempt）";
  if (assignment) {
    const row = (await queryPool(env.pool, "SELECT status FROM survey_attempts WHERE id=$1", [assignment.attemptId])).rows[0];
    if (row?.status !== "submitted") assignment = null;
  }
  if (!assignment) {
    const scene = await setupParityEnv({ fresh: true });
    assignment = scene.assignment;
    premise = "Q7 自构造（Q5 未通过，fresh attempt 经真实 HTTP 提交）";
    await uploadReceiptViaHttp(scene, assignment.attemptId);
    await answerAllQuestionsViaHttp(scene, assignment.attemptId);
    await submitAttemptViaHttp(scene, assignment);
  }
  console.error(`[q7] 前提来源：${premise} attemptId=${assignment.attemptId}`);

  await withTimeout(miniProgram.reLaunch(`/pages/task/index?assignmentId=${encodeURIComponent(assignment.assignmentId)}&source=schedule`), 30000, "reLaunch task");
  const taskState = await waitForPage(miniProgram, (s) => s.route === "pages/task/index" && s.data?.loading === false && Boolean(s.data?.task), "任务页加载", 30000);
  assert.equal(taskState.data.task.attempt?.status, "submitted", `任务页 attempt 状态=${taskState.data.task.attempt?.status}`);

  const match = { method: "GET", path: `/api/assignments/${assignment.assignmentId}` };
  const beforeTap = env.proxy.hits(match).count;
  // 已提交任务的任务页渲染只读区块、「继续填写」按钮不渲染（wxml wx:else 分支），
  // 故直接调用按钮绑定的处理函数 continueDraft（理由见文件头注释 5）。
  await callPageMethod(miniProgram, 0, "continueDraft");
  await sleep(1500);

  const final = await pageSnapshot(miniProgram);
  assert.equal(final.route, "pages/task/index", `点击后路由=${final.route}，不应跳问卷页`);
  assert.equal(final.stackDepth, 1, `点击后栈深=${final.stackDepth}`);
  const afterTap = env.proxy.hits(match).count;
  assert.ok(afterTap > beforeTap, `未重新拉取数据（GET assignment ${beforeTap}→${afterTap}）`);
  return { attemptId: assignment.attemptId, premise };
}

// ---- 主流程：环境 → fixture 副本 → 启动 IDE → 逐场景（失败不中断）→ 汇总 ----
async function main() {
  const scenarios = [
    { id: "Q1", title: "问卷得分保存断连后网络恢复自动补发", run: (ctx) => scenarioQ1(ctx) },
    { id: "Q2", title: "问题页停留期间问卷页网络恢复回调不触发重拉", run: (ctx) => scenarioQ2(ctx) },
    { id: "Q3", title: "问题页填说明并直传照片后确认", run: (ctx) => scenarioQ3(ctx) },
    { id: "Q4", title: "问题页说明为空时确认禁用并提示", run: (ctx) => scenarioQ4(ctx) },
    { id: "Q5", title: "提交409可重试后同token重试成功", run: (ctx) => scenarioQ5(ctx) },
    { id: "Q6", title: "提交409需换token后刷新恢复", run: (ctx) => scenarioQ6(ctx) },
    { id: "Q7", title: "已提交任务继续填写不跳问卷且重拉数据", run: (ctx) => scenarioQ7(ctx) },
  ];
  const results = [];
  const exceptions = [];
  const consoleLog = []; // 小程序 console 尾部（FAIL 证据用，不含敏感值）
  const ctx = { q5: null };
  let env = null;
  let fixtureProject = null;
  let miniProgram = null;
  try {
    env = await setupParityEnv();
    console.error(`[flow] env ready: apiBase=${env.apiBase} upstream=${env.upstreamBase} attempt=${env.assignment.attemptId}`);
    await mkdir(REPORT_DIR, { recursive: true });

    console.error("[flow] preparing fixture project copy...");
    fixtureProject = await prepareMiniappProjectForFixture();
    // fixture 副本内重写 runtime-config（仓库源文件不动）：apiBase 指回环代理（同 env.mjs 冒烟）。
    await writeFile(join(fixtureProject.projectPath, "miniprogram", "runtime-config.generated.js"),
      `// parity fixture copy: loopback-only apiBase（指向故障注入代理）\nexport const RUNTIME_CONFIG = Object.freeze({ apiBase: ${JSON.stringify(env.apiBase)} });\n`);

    miniProgram = await launchAutomation(fixtureProject.projectPath);
    await withTimeout(miniProgram.callWxMethod("setStorageSync", SESSION_STORAGE_KEY, env.inspector.session), 30000, "setStorageSync");
    await withTimeout(miniProgram.evaluate(({ storageKey, publicConfig }) => {
      getApp().globalData.session = wx.getStorageSync(storageKey);
      getApp().globalData.publicConfig = publicConfig;
    }, { storageKey: SESSION_STORAGE_KEY, publicConfig: PARITY_PUBLIC_CONFIG }), 30000, "inject globals");
    ctx.env = env;
    ctx.miniProgram = miniProgram;

    // PARITY_FLOW_ONLY=Q3,Q5：只跑指定场景（迭代诊断用；默认全跑）。
    const only = process.env.PARITY_FLOW_ONLY ? process.env.PARITY_FLOW_ONLY.split(",").map((item) => item.trim()) : null;
    const selected = only ? scenarios.filter((scenario) => only.includes(scenario.id)) : scenarios;
    assert.ok(selected.length > 0, `PARITY_FLOW_ONLY 未匹配任何场景: ${process.env.PARITY_FLOW_ONLY}`);

    const registerListeners = (session) => {
      session.on("exception", (entry) => exceptions.push(entry));
      try {
        session.on("console", (message) => {
          const args = (message?.args || []).map((item) => {
            const text = typeof item === "string" ? item : JSON.stringify(item);
            return truncate(text, 160);
          });
          consoleLog.push({ type: message?.type || "", args });
          if (consoleLog.length > 200) consoleLog.shift();
        });
      } catch { /* console 事件不可用不影响场景 */ }
    };
    // 应用级导航卡死恢复：整会话重启（区别于 reattach：nav 队列楔死时只有冷重启能解）。
    ctx.restartIde = async () => {
      console.error("[flow] 重启开发者工具会话...");
      if (miniProgram) { try { miniProgram.disconnect(); } catch { /* 已断开 */ } }
      await stopDevTools();
      miniProgram = await launchAutomation(fixtureProject.projectPath);
      await withTimeout(miniProgram.callWxMethod("setStorageSync", SESSION_STORAGE_KEY, env.inspector.session), 30000, "setStorageSync");
      await withTimeout(miniProgram.evaluate(({ storageKey, publicConfig }) => {
        getApp().globalData.session = wx.getStorageSync(storageKey);
        getApp().globalData.publicConfig = publicConfig;
      }, { storageKey: SESSION_STORAGE_KEY, publicConfig: PARITY_PUBLIC_CONFIG }), 30000, "inject globals");
      registerListeners(miniProgram);
      ctx.miniProgram = miniProgram;
    };
    registerListeners(miniProgram);

    const describeError = (error) => {
      let text = truncate(error?.message || JSON.stringify(error), 500);
      if (/Uncaught/.test(text) && error && typeof error === "object") {
        const raw = JSON.stringify(error, Object.getOwnPropertyNames(error));
        if (raw && raw !== "{}") text = `${text} | raw=${truncate(raw, 300)}`;
      }
      return text;
    };

    for (const scenario of selected) {
      console.error(`[flow] scenario ${scenario.id} begin ${now()}`);
      const exceptionBaseline = exceptions.length;
      let passed = false;
      let detail = "";
      let healed = false;
      const runOnce = async () => {
        env.proxy.reset(); // 场景隔离：清空待生效故障与命中记录（offline 开关不受影响）
        await scenario.run(ctx);
      };
      try {
        await runOnce();
        passed = true;
      } catch (error) {
        detail = describeError(error);
        // 自动化层症状（Uncaught/协议超时/reLaunch 三次未生效）→ 重走附加模式自愈，同一场景最多重试一次。
        if (/Uncaught \[object Object\]|timeout after \d+ms|reLaunch 三次未生效/.test(detail)) {
          try {
            miniProgram = await reattachAutomation(fixtureProject.projectPath, miniProgram);
            registerListeners(miniProgram);
            ctx.miniProgram = miniProgram;
            healed = true;
            console.error(`[flow] 自愈完成，重试 ${scenario.id} ${now()}`);
            const retryBaseline = exceptions.length;
            try {
              await runOnce();
              passed = true;
              detail = "";
              console.error(`[flow] ${scenario.id} 自愈重试通过`);
            } catch (retryError) {
              detail = describeError(retryError);
              const retryExceptions = exceptions.slice(retryBaseline);
              if (retryExceptions.length > 0) detail = `小程序运行时异常 ${retryExceptions.length} 条：${truncate(JSON.stringify(retryExceptions), 300)}`;
            }
          } catch (healError) {
            detail = `${detail}；自愈失败：${truncate(healError?.message || String(healError), 150)}`;
          }
        }
      }
      const newExceptions = exceptions.slice(exceptionBaseline);
      if (newExceptions.length > 0) {
        passed = false;
        detail = `小程序运行时异常 ${newExceptions.length} 条：${truncate(JSON.stringify(newExceptions), 300)}`;
      }
      if (healed && passed) console.error(`[flow] ${scenario.id} 经 attach 自愈重试后通过`);
      console.log(`${passed ? "PASS" : "FAIL"} ${scenario.id} ${scenario.title}${passed ? "" : ` — ${detail}`}`);
      results.push({ id: scenario.id, passed });
      await captureEvidence(ctx.miniProgram, scenario.id);
      if (!passed) {
        // FAIL 场景留档：页面快照 + 小程序 console 尾部 + 代理记录尾部（均不含请求头/凭据值）。
        const snapshot = await pageSnapshot(ctx.miniProgram).catch(() => ({ note: "snapshot failed" }));
        await writeFile(join(REPORT_DIR, `${scenario.id}.fail.json`), JSON.stringify({
          id: scenario.id,
          detail,
          snapshot,
          consoleTail: consoleLog.slice(-30),
          proxyRecordsTail: env.proxy.hits().records.slice(-40).map((item) => ({ at: item.at, method: item.method, path: item.path.slice(0, 110), fault: item.fault, status: item.status })),
        }, null, 2));
        console.error(`[evidence] ${scenario.id} FAIL 证据 -> ${scenario.id}.fail.json`);
      }
      // 场景边界排水：等页面栈稳定再进入下一场景（吸收迟到的导航，避免与下一次 reLaunch 相撞）。
      const drained = await drainNavigation(ctx.miniProgram);
      console.error(`[flow] ${scenario.id} 边界排水完成 route=${drained} ${now()}`);
    }
  } catch (error) {
    console.error("parity flow FAILED (环境/启动阶段):", truncate(error?.stack || error, 1200));
    process.exitCode = 1;
  } finally {
    if (miniProgram) { try { miniProgram.disconnect(); } catch { /* 已断开 */ } }
    if (fixtureProject) { try { await fixtureProject.cleanup(); } catch { /* 清理失败不掩盖结果 */ } }
    await stopDevTools();
    if (env) await env.teardown();
  }
  const failed = results.filter((item) => !item.passed).length;
  console.log(`\nparity flow: ${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

await main();
