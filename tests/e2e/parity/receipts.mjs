// R 组小票场景对齐验收（微信开发者工具模拟器 + 真实 API + 真实库 + 故障注入代理）。
// 运行：node tests/e2e/parity/receipts.mjs 2>&1 | tee /Users/michaelzhu/Documents/agent-reports/miniapp-parity-e2e/receipts-<时间戳>.log
//
// 场景 R1..R6 全部跑在 pages/dishes/index 上；每个场景 setupParityEnv({ fresh: true })
// 新建 attempt（互不影响），场景失败不中断其他场景，任一 FAIL 进程退出码为 1。
// 验收以服务端事实为准：junde_realapi（经 env.pool）+ 故障代理 hits + 页面 data 三方对账。
// 边界：只连回环；不改小程序项目本身（fixture 临时副本 + 副本内 runtime-config 回环化）；
// 不新增 npm 依赖；日志与留档不包含 token/密码/连接串。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setupParityEnv, SESSION_STORAGE_KEY, PARITY_PUBLIC_CONFIG } from "./env.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const REPORT_DIR = "/Users/michaelzhu/Documents/agent-reports/miniapp-parity-e2e";
const WECHAT_CLI_PATH = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const PNG_FIXTURE_PATH = join(projectRoot, "tests", "fixtures", "ocr-sample-receipt.png");
const CONFIG_DELAY_MS = 3000; // R6：client-config 晚到窗口（≥3 秒）。
const CONFIG_CACHE_TTL_MS = 300_000; // client-config 响应 cache-control: public, max-age=300（app.js 下发）。
let automationLaunchedAtMs = 0; // R6 缓存过期等待的起点（main 在自动化会话建立后写入）。

const requireFromRoot = createRequire(join(projectRoot, "package.json"));
requireFromRoot("./tests/e2e/automator-compat.cjs");
const automator = requireFromRoot("miniprogram-automator");
const { prepareMiniappProjectForFixture, stopDevTools } = requireFromRoot("./tests/e2e/prepare-miniapp-fixture.cjs");

// 两张内容不同（sha256 不同，避开 receipt_attachments_active_sha_uq）的真实 PNG：
// A=仓库 fixture 原字节；B=同一 PNG 末尾附加 1 字节（解码器忽略 IEND 后尾数据，
// 服务端魔数闸只认 PNG signature，size/sha256 两边口径一致）。
const receiptImageA = readFileSync(PNG_FIXTURE_PATH);
const receiptImageB = Buffer.concat([receiptImageA, Buffer.from([0])]);
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)),
]);
const json = async (url, options = {}) => {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

// ---- 自动化会话：照抄 env.mjs runSmoke 的 launch→attach→退避重连 workaround ----
// IDE Stable 2.01.2510290 冷启动时自动化引擎 App.* 不应答，必须对已运行 IDE 再次
// `cli auto`（附加模式），且 attach 会重启 9420（先拒连后可用），connect 需退避重试。
const attachAutomationSession = (projectPath, cliPath) => {
  const result = spawnSync(cliPath, ["auto", "--project", projectPath, "--auto-port", "9420", "--trust-project"], { encoding: "utf8", timeout: 90000 });
  const tail = `${result.stdout || ""}${result.stderr || ""}`.split("\n").filter(Boolean).slice(-2).join(" | ");
  console.error(`[receipts] cli auto attach: ${tail}`);
};

async function launchAutomation(projectPath) {
  let miniProgram = null;
  for (let attempt = 1; attempt <= 3 && !miniProgram; attempt += 1) {
    await stopDevTools();
    console.error(`[receipts] devtools launch attempt ${attempt}...`);
    try {
      const launchedSession = await withTimeout(automator.launch({ cliPath: WECHAT_CLI_PATH, projectPath, trustProject: true, timeout: 300000 }), 340000, "launch");
      console.error("[receipts] launch returned, attaching fresh automation session...");
      attachAutomationSession(projectPath, WECHAT_CLI_PATH);
      try { launchedSession?.disconnect?.(); } catch { /* 已断开 */ }
      for (let connectTry = 1; connectTry <= 12 && !miniProgram; connectTry += 1) {
        try {
          const session = await withTimeout(automator.connect({ wsEndpoint: "ws://127.0.0.1:9420" }), 15000, "connect");
          await withTimeout(session.systemInfo(), 20000, "engine probe");
          miniProgram = session;
        } catch {
          try { miniProgram?.disconnect?.(); } catch { /* 未建立 */ }
          miniProgram = null;
          await sleep(2000);
        }
      }
    } catch (error) {
      console.error(`[receipts] launch attempt ${attempt} failed: ${String(error.message).slice(0, 200)}`);
      try { miniProgram?.disconnect?.(); } catch { /* 未建立 */ }
      miniProgram = null;
      if (attempt < 3) await sleep(10000);
    }
    if (miniProgram) console.error("[receipts] automation engine responds (Tool+App layers)");
  }
  assert.ok(miniProgram, "unable to launch WeChat DevTools for receipts parity scenarios");
  return miniProgram;
}

// ---- 页面观察与操作（方法名以 apps/miniapp/miniprogram/pages/dishes/index.js 为准） ----
async function pageSnapshot(miniProgram) {
  return miniProgram.evaluate(() => {
    const page = getCurrentPages().slice(-1)[0];
    const data = page?.data || {};
    return {
      route: page?.route || "",
      loading: data.loading,
      error: data.error || "",
      receiptError: data.receiptError || "",
      receiptBusy: data.receiptBusy,
      receipts: (data.receipts || []).map((item) => ({ id: item.id, status: item.status, displayOrder: item.displayOrder })),
      pendingReceipts: (data.pendingReceipts || []).map((item) => ({ clientFileId: item.clientFileId, status: item.status, attachmentId: item.attachmentId || null })),
      readyCount: data.readyCount,
      canAddReceipt: data.canAddReceipt,
      dishEnabled: data.dishEnabled,
      meta: data.meta ? { attemptId: data.meta.attemptId } : null,
    };
  });
}

async function waitForPage(miniProgram, predicate, label, timeout = 30000) {
  const started = Date.now();
  let snapshot = await pageSnapshot(miniProgram);
  while (!predicate(snapshot) && Date.now() - started < timeout) {
    await sleep(200);
    snapshot = await pageSnapshot(miniProgram);
  }
  assert.ok(predicate(snapshot), `${label}（最后快照：${JSON.stringify(snapshot).slice(0, 300)}）`);
  return snapshot;
}

async function openDishesPage(miniProgram, assignment) {
  const route = `/pages/dishes/index?assignmentId=${assignment.assignmentId}&attemptId=${assignment.attemptId}&questionnaireVersionId=${assignment.questionnaireVersionId}&revision=${assignment.revision}`;
  await withTimeout(miniProgram.reLaunch(route), 30000, "reLaunch");
  const started = Date.now();
  let snapshot = await pageSnapshot(miniProgram);
  while ((snapshot.route !== "pages/dishes/index" || snapshot.loading !== false) && Date.now() - started < 30000) {
    await sleep(300);
    snapshot = await pageSnapshot(miniProgram);
  }
  assert.equal(snapshot.route, "pages/dishes/index", `未进入菜品页：${snapshot.route}`);
  assert.equal(snapshot.loading, false, `菜品页 loading 未结束：${JSON.stringify(snapshot).slice(0, 300)}`);
  assert.equal(snapshot.error, "", `菜品页加载报错：${snapshot.error}`);
  return snapshot;
}

// 合成事件直调页面方法（与 tests/e2e/miniapp-receipt-native.cjs 同款，稳定优先于点按钮）。
async function callPageMethod(miniProgram, method, datasetId) {
  return miniProgram.evaluate(({ methodName, id }) => {
    const page = getCurrentPages().slice(-1)[0];
    return page[methodName]({ currentTarget: { dataset: { id } } });
  }, { methodName: method, id: datasetId });
}

async function triggerChooseReceipts(miniProgram) {
  await miniProgram.evaluate(() => { getCurrentPages().slice(-1)[0].chooseReceipts(); });
}

async function injectPublicConfig(miniProgram, config) {
  await miniProgram.evaluate((value) => { getApp().globalData.publicConfig = value; }, config);
}

// 选图 mock：把真实 PNG 字节写进 wx.env.USER_DATA_PATH，再 mock wx.chooseMedia 返回该路径。
async function prepareLocalImage(miniProgram, fileName, bytes) {
  const savedPath = await miniProgram.evaluate(({ name, base64 }) => {
    const path = `${wx.env.USER_DATA_PATH}/${name}`;
    wx.getFileSystemManager().writeFileSync(path, base64, "base64");
    return path;
  }, { name: fileName, base64: bytes.toString("base64") });
  assert.ok(typeof savedPath === "string" && savedPath.length > 0, "写入 USER_DATA_PATH 失败");
  return { path: savedPath, bytes };
}

const chooseMediaResult = (files) => ({
  type: "image",
  tempFiles: files.map((file) => ({ tempFilePath: file.path, size: file.bytes.length })),
});

async function withChooseMediaMock(miniProgram, files, run) {
  await miniProgram.mockWxMethod("chooseMedia", chooseMediaResult(files));
  try {
    await run();
  } finally {
    try { await miniProgram.restoreWxMethod("chooseMedia"); } catch { /* 已还原 */ }
  }
}

// ---- 服务端事实 ----
// fresh attempt 的问卷是空答，菜品页 load() 会因 firstIncompleteQuestion 跳回问卷页；
// 场景前用真实 HTTP（探员会话）把全部题目答成 scored，与小程序保存链路同构。
async function answerAllQuestions(env) {
  const headers = { authorization: `Bearer ${env.inspector.session.accessToken}`, "content-type": "application/json" };
  const draft = await json(`${env.apiBase}/api/questionnaires/secret/drafts/${env.assignment.attemptId}`, { headers });
  assert.equal(draft.status, 200, `预答问卷读取草稿失败：${draft.status}`);
  let revision = Number(draft.body?.attempt?.revision);
  assert.ok(Number.isInteger(revision), "草稿 revision 缺失，无法预答");
  for (const question of draft.body?.questions || []) {
    const saved = await json(`${env.apiBase}/api/questionnaires/secret/drafts/${env.assignment.attemptId}/answers/${question.id}`, {
      method: "PUT", headers, body: JSON.stringify({ answer: "scored", revision }),
    });
    assert.equal(saved.status, 200, `预答第 ${question.number} 题失败：${JSON.stringify(saved.body)}`);
    revision = Number(saved.body.revision);
  }
}

const initMatcher = (attemptId) => ({ method: "POST", path: new RegExp(`/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/uploads$`) });
const completeMatcher = (attemptId) => ({ method: "POST", path: new RegExp(`/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/[^/]+/complete$`) });
const deleteMatcher = (attemptId) => ({ method: "DELETE", path: new RegExp(`/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/(?!uploads)[^/]+$`) });
const directUploadMatcher = { method: "POST", path: /\/api\/local-storage\/objects/ };

async function attemptReceiptRows(env, attemptId) {
  const result = await env.pool.query(
    "SELECT client_file_id, status, sha256, deleted_at, display_order FROM receipt_attachments WHERE attempt_id=$1 ORDER BY created_at",
    [attemptId],
  );
  return result.rows.map((row) => ({
    clientFileId: row.client_file_id,
    status: row.status,
    sha256: row.sha256,
    deleted: row.deleted_at !== null,
    displayOrder: Number(row.display_order),
  }));
}

// ---- 场景结束留证：截图 <编号>.png（automator App.captureScreenshot）；
// attach 模式下截图 API 不可用时降级为 <编号>.json 页面 data 快照，绝不默默跳过。
async function captureEvidence(miniProgram, id, evidence) {
  try {
    await withTimeout(miniProgram.screenshot({ path: join(REPORT_DIR, `${id}.png`) }), 20000, `screenshot ${id}`);
    evidence.artifact = `${id}.png + ${id}.json`;
  } catch (error) {
    evidence.artifact = `${id}.json（截图 API 不可用，已降级为页面 data 快照：${String(error.message).slice(0, 120)}）`;
  }
  await writeFile(join(REPORT_DIR, `${id}.json`), JSON.stringify(evidence, null, 2));
}

// 代理全量记录快照（id/method/path/fault/status/at；记录本体已脱敏），分阶段留痕用。
const proxySnapshot = (env) => env.proxy.hits(null).records.map((item) => ({ id: item.id, method: item.method, path: item.path, fault: item.fault, status: item.status, at: item.at }));
const markPhase = (env, evidence, phase) => {
  evidence.proxyByPhase = evidence.proxyByPhase || {};
  evidence.proxyByPhase[phase] = proxySnapshot(env);
  console.error(`[${evidence.id}] proxy records at ${phase}: ${evidence.proxyByPhase[phase].length}`);
};

// ---- R1：选 1 张图上传。----
// 通过标准：待传项消失、出现 1 张 ready 小票；库中该行 sha256 == node:crypto 对图片字节的摘要。
async function scenarioR1(miniProgram, env, evidence) {
  const assignment = env.assignment;
  const expectedSha = sha256Hex(receiptImageA);
  await injectPublicConfig(miniProgram, PARITY_PUBLIC_CONFIG);
  const file = await prepareLocalImage(miniProgram, "parity-receipt-r1.png", receiptImageA);
  await withChooseMediaMock(miniProgram, [file], async () => {
    await openDishesPage(miniProgram, assignment);
    await triggerChooseReceipts(miniProgram);
    const done = await waitForPage(miniProgram,
      (s) => s.pendingReceipts.length === 0 && s.receipts.length === 1 && s.receipts[0]?.status === "ready",
      "R1 上传后未出现 1 张 ready 小票或待传项未消失");
    assert.equal(done.readyCount, 1, `readyCount=${done.readyCount}`);
    assert.equal(done.canAddReceipt, true, "上传 1 张后 canAddReceipt 应仍为 true");
  });
  const rows = await attemptReceiptRows(env, assignment.attemptId);
  assert.equal(rows.length, 1, `测试库该 attempt 应只有 1 行附件，实际 ${rows.length}`);
  assert.equal(rows[0].status, "ready", `库中附件状态=${rows[0].status}`);
  assert.equal(rows[0].sha256, expectedSha, "库中 sha256 与图片字节摘要不一致");
  const initHits = env.proxy.hits(initMatcher(assignment.attemptId));
  const completeHits = env.proxy.hits(completeMatcher(assignment.attemptId));
  assert.equal(initHits.count, 1, `init 应恰好 1 次，实际 ${initHits.count}`);
  assert.equal(completeHits.count, 1, `complete 应恰好 1 次，实际 ${completeHits.count}`);
  Object.assign(evidence, { expectedSha, rows, init: initHits.records, complete: completeHits.records });
}

// ---- R2：complete 500 后点「重试」。----
// 通过标准：失败后待传项变 failed；重试发起新的 init（不能复用旧 uploadTarget）；最终 ready；库同 clientFileId 仅 1 行。
async function scenarioR2(miniProgram, env, evidence) {
  const assignment = env.assignment;
  const expectedSha = sha256Hex(receiptImageA);
  await injectPublicConfig(miniProgram, PARITY_PUBLIC_CONFIG);
  const file = await prepareLocalImage(miniProgram, "parity-receipt-r2.png", receiptImageA);
  env.proxy.failNext(completeMatcher(assignment.attemptId), { status: 500, body: { error: { code: "PARITY_COMPLETE_FAULT", message: "parity injected complete failure" } } });
  await withChooseMediaMock(miniProgram, [file], async () => {
    await openDishesPage(miniProgram, assignment);
    await triggerChooseReceipts(miniProgram);
    const failed = await waitForPage(miniProgram,
      (s) => s.pendingReceipts.length === 1 && s.pendingReceipts[0].status === "failed",
      "R2 complete 注入 500 后待传项未变 failed");
    const clientFileId = failed.pendingReceipts[0].clientFileId;
    const initBefore = env.proxy.hits(initMatcher(assignment.attemptId));
    const failedComplete = env.proxy.hits(completeMatcher(assignment.attemptId));
    assert.equal(failedComplete.count, 1, "失败阶段应恰好 1 次 complete");
    assert.equal(failedComplete.records[0].fault, "fail", "第一次 complete 应为注入故障");
    assert.equal(failedComplete.records[0].status, 500);
    assert.equal(initBefore.count, 1, "失败阶段应恰好 1 次 init");
    await callPageMethod(miniProgram, "retryUpload", clientFileId);
    const done = await waitForPage(miniProgram,
      (s) => s.pendingReceipts.length === 0 && s.receipts.length === 1 && s.receipts[0]?.status === "ready",
      "R2 重试后未恢复 ready");
    assert.equal(done.readyCount, 1);
    const initAfter = env.proxy.hits(initMatcher(assignment.attemptId));
    const uploads = env.proxy.hits(directUploadMatcher);
    const completeAfter = env.proxy.hits(completeMatcher(assignment.attemptId));
    assert.equal(initAfter.count, initBefore.count + 1, `重试必须发起新的 init（旧 uploadTarget 不可复用），init 命中 ${initAfter.count}`);
    assert.ok(initAfter.records[1].id > failedComplete.records[0].id, "新 init 必须发生在失败的 complete 之后");
    assert.equal(uploads.count, 2, `签名直传应有 2 次（初次 + 重试重传），实际 ${uploads.count}`);
    assert.equal(completeAfter.count, 2, `complete 应有 2 次，实际 ${completeAfter.count}`);
    assert.equal(completeAfter.records[1].fault, null, "重试的 complete 不应再命中故障");
    assert.equal(completeAfter.records[1].status, 200);
    const rows = await attemptReceiptRows(env, assignment.attemptId);
    assert.equal(rows.length, 1, `同 clientFileId 库里必须只有 1 行，实际 ${rows.length}`);
    assert.equal(rows[0].status, "ready");
    assert.equal(rows[0].sha256, expectedSha);
    Object.assign(evidence, { clientFileId, expectedSha, rows, init: initAfter.records, complete: completeAfter.records, directUploads: uploads.count });
  });
}

// ---- R3：init 响应丢失形态后点 × 移除待传项。----
// 通过标准：代理记录到同 clientFileId 重放的 init，接着 DELETE；库该行软删；页面占用名额不增加。
// 注入模型说明（run2 实测）：开发者工具的 wx.request 在传输层连接被掐断后会立即自动重发一次
// （2ms 内第二发直达服务端），单个 dropNext 挡不住。因此排队两个 dropNext 把两次尝试全部掐断，
// 得到与生产「init 已提交但响应丢失」一致的客户端形态：待传项 failed、sha256 已持久化、
// attachmentId 未知、服务端无行；随后 × 触发业务既定恢复路径（同 clientFileId 幂等重放 init
// 找回/建行 → DELETE 软删）。failed 态确认后 proxy.reset() 清掉可能剩余的注入，再验证重放。
async function scenarioR3(miniProgram, env, evidence) {
  const assignment = env.assignment;
  await injectPublicConfig(miniProgram, PARITY_PUBLIC_CONFIG);
  const file = await prepareLocalImage(miniProgram, "parity-receipt-r3.png", receiptImageA);
  env.proxy.dropNext(initMatcher(assignment.attemptId));
  env.proxy.dropNext(initMatcher(assignment.attemptId));
  markPhase(env, evidence, "fault-queued");
  try {
    await withChooseMediaMock(miniProgram, [file], async () => {
      await openDishesPage(miniProgram, assignment);
      markPhase(env, evidence, "page-loaded");
      await triggerChooseReceipts(miniProgram);
      const failed = await waitForPage(miniProgram,
        (s) => s.pendingReceipts.length === 1 && s.pendingReceipts[0].status === "failed",
        "R3 init 被断开后待传项未变 failed");
      markPhase(env, evidence, "failed-observed");
      const clientFileId = failed.pendingReceipts[0].clientFileId;
      const dropped = env.proxy.hits(initMatcher(assignment.attemptId));
      assert.ok(dropped.count >= 1, `init 应至少被断开 1 次，实际 ${dropped.count}`);
      assert.ok(dropped.records.every((item) => item.fault === "drop"), "断开阶段不允许有任何转发成功的 init（记录：见 proxyByPhase.failed-observed）");
      const rowsBeforeRemove = await attemptReceiptRows(env, assignment.attemptId);
      assert.equal(rowsBeforeRemove.length, 0, `init 全断开形态下服务端不应建行，实际 ${JSON.stringify(rowsBeforeRemove)}`);
      // 清掉可能剩余的一次性注入（客户端若未重发则队列有残留），避免误伤随后的重放 init。
      env.proxy.reset();
      await callPageMethod(miniProgram, "removePending", clientFileId);
      const done = await waitForPage(miniProgram,
        (s) => s.pendingReceipts.length === 0 && s.receipts.length === 0,
        "R3 移除后待传项/服务端小票未清空");
      const initAfter = env.proxy.hits(initMatcher(assignment.attemptId));
      const deletes = env.proxy.hits(deleteMatcher(assignment.attemptId));
      assert.equal(initAfter.count, 1, `移除必须以同 clientFileId 幂等重放 init，init 命中 ${initAfter.count}`);
      assert.equal(initAfter.records[0].fault, null, "重放的 init 不应再命中故障");
      assert.equal(initAfter.records[0].status, 201, "重放 init 应在服务端建行（201）");
      assert.equal(deletes.count, 1, `移除应恰好发 1 次 DELETE，实际 ${deletes.count}`);
      assert.equal(deletes.records[0].status, 200, `DELETE 状态码=${deletes.records[0].status}`);
      assert.equal(done.canAddReceipt, true, "移除后占用名额应释放（canAddReceipt=true）");
      assert.equal(done.readyCount, 0);
      const rows = await attemptReceiptRows(env, assignment.attemptId);
      assert.equal(rows.length, 1, `该 clientFileId 库里应只有 1 行，实际 ${rows.length}`);
      assert.equal(rows[0].status, "deleted", `库中该行应软删，实际 ${rows[0].status}`);
      assert.equal(rows[0].deleted, true, "deleted_at 应非空");
      Object.assign(evidence, { clientFileId, rows, rowsBeforeRemove, init: initAfter.records, deletes: deletes.records });
    });
  } catch (error) {
    markPhase(env, evidence, "on-failure");
    evidence.failureRows = await attemptReceiptRows(env, assignment.attemptId).catch(() => null);
    throw error;
  }
}

// ---- R4：已知 attachmentId 的失败项点 × 移除。----
// 通过标准：先发 DELETE（200），成功后本地才移除；库里该行软删。
// 顺序的确定性证据：DELETE 命中记录存在且 200 + 本地最终清空 + 库软删——若本地先行（缺陷形态），
// DELETE 记录与软删行都不会存在；removePending 业务码路径亦不重放 init（init 命中数保持 1）。
async function scenarioR4(miniProgram, env, evidence) {
  const assignment = env.assignment;
  await injectPublicConfig(miniProgram, PARITY_PUBLIC_CONFIG);
  const file = await prepareLocalImage(miniProgram, "parity-receipt-r4.png", receiptImageA);
  env.proxy.failNext(completeMatcher(assignment.attemptId), { status: 500, body: { error: { code: "PARITY_COMPLETE_FAULT", message: "parity injected complete failure" } } });
  await withChooseMediaMock(miniProgram, [file], async () => {
    await openDishesPage(miniProgram, assignment);
    await triggerChooseReceipts(miniProgram);
    const failed = await waitForPage(miniProgram,
      (s) => s.pendingReceipts.length === 1 && s.pendingReceipts[0].status === "failed",
      "R4 complete 注入 500 后待传项未变 failed");
    const clientFileId = failed.pendingReceipts[0].clientFileId;
    assert.ok(failed.pendingReceipts[0].attachmentId, "R4 前置：失败项必须已知 attachmentId（init 已成功）");
    const initBefore = env.proxy.hits(initMatcher(assignment.attemptId));
    assert.equal(initBefore.count, 1);
    await callPageMethod(miniProgram, "removePending", clientFileId);
    const done = await waitForPage(miniProgram,
      (s) => s.pendingReceipts.length === 0 && s.receipts.length === 0,
      "R4 移除后本地待传项未清空");
    const initAfter = env.proxy.hits(initMatcher(assignment.attemptId));
    const deletes = env.proxy.hits(deleteMatcher(assignment.attemptId));
    assert.equal(initAfter.count, 1, `已知 attachmentId 时不得重放 init，init 命中 ${initAfter.count}`);
    assert.equal(deletes.count, 1, `应恰好发 1 次 DELETE，实际 ${deletes.count}`);
    assert.equal(deletes.records[0].status, 200, `DELETE 状态码=${deletes.records[0].status}`);
    const rows = await attemptReceiptRows(env, assignment.attemptId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "deleted", `库中该行应软删，实际 ${rows[0].status}`);
    assert.equal(rows[0].deleted, true, "deleted_at 应非空");
    Object.assign(evidence, { clientFileId, attachmentId: failed.pendingReceipts[0].attachmentId, rows, init: initAfter.records, deletes: deletes.records });
  });
}

// ---- R5：第一张在上传时第二张已在队列，第一张完成后第二张无需操作自动上传。----
// 形态说明：chooseReceipts 在 receiptBusy 期间是静默 no-op（业务守卫），因此「第二张」按一次
// 选图返回 2 个文件建模：第二张在第一张上传期间处于 local_selected 等待态，由
// runQueuedUploads/for-await 队列自动续传——与通过标准「无需操作自动开始、最终两张 ready」一致。
// 服务端证明串行：第 1 次 complete 的记录 id < 第 2 次 init 的记录 id（并发实现则相反）。
async function scenarioR5(miniProgram, env, evidence) {
  const assignment = env.assignment;
  const shaA = sha256Hex(receiptImageA);
  const shaB = sha256Hex(receiptImageB);
  await injectPublicConfig(miniProgram, PARITY_PUBLIC_CONFIG);
  const fileA = await prepareLocalImage(miniProgram, "parity-receipt-r5a.png", receiptImageA);
  const fileB = await prepareLocalImage(miniProgram, "parity-receipt-r5b.png", receiptImageB);
  await withChooseMediaMock(miniProgram, [fileA, fileB], async () => {
    await openDishesPage(miniProgram, assignment);
    await triggerChooseReceipts(miniProgram);
    // 等待期间持续采样：一旦捕到「一张 uploading/confirming + 一张 local_selected」即记下
    // （队列等待态的直接证据）；终态判定不依赖是否捕到（命中记录的串行序是硬断言）。
    const queueObservations = [];
    const pendingSamples = [];
    const terminal = (s) => s.pendingReceipts.length === 0 && s.receipts.length === 2 && s.receipts.every((item) => item.status === "ready");
    const started = Date.now();
    let snapshot = await pageSnapshot(miniProgram);
    while (!terminal(snapshot) && Date.now() - started < 40000) {
      const busy = snapshot.pendingReceipts.find((item) => ["uploading", "confirming"].includes(item.status));
      const waiting = snapshot.pendingReceipts.find((item) => item.status === "local_selected");
      if (busy && waiting) queueObservations.push({ elapsedMs: Date.now() - started, uploading: busy.clientFileId, waiting: waiting.clientFileId });
      if (snapshot.pendingReceipts.length >= 2 && pendingSamples.length < 20) {
        pendingSamples.push({ elapsedMs: Date.now() - started, items: snapshot.pendingReceipts.map((item) => ({ clientFileId: item.clientFileId, status: item.status })) });
      }
      await sleep(40);
      snapshot = await pageSnapshot(miniProgram);
    }
    if (!terminal(snapshot)) {
      // 失败即缺陷取证：库行数、页内两个待传项的 clientFileId 是否撞车，全部写进断言消息与留档。
      const rows = await attemptReceiptRows(env, assignment.attemptId).catch(() => null);
      markPhase(env, evidence, "on-failure");
      evidence.failureRows = rows;
      evidence.pendingSamples = pendingSamples;
      assert.ok(terminal(snapshot), `R5 两张小票未全部 ready（快照：${JSON.stringify(snapshot).slice(0, 200)}；库行：${JSON.stringify(rows)}；页内待传项采样：${JSON.stringify(pendingSamples.slice(0, 5))}）——疑似业务缺陷：secureUuid 恒定导致两图共用 clientFileId 时，第一张完成会连带清除排队中的第二张`);
    }
    assert.equal(snapshot.readyCount, 2);
    const inits = env.proxy.hits(initMatcher(assignment.attemptId));
    const completes = env.proxy.hits(completeMatcher(assignment.attemptId));
    const uploads = env.proxy.hits(directUploadMatcher);
    assert.equal(inits.count, 2, `init 应恰好 2 次，实际 ${inits.count}`);
    assert.equal(completes.count, 2, `complete 应恰好 2 次，实际 ${completes.count}`);
    assert.equal(uploads.count, 2, `直传应恰好 2 次，实际 ${uploads.count}`);
    assert.ok(completes.records[0].id < inits.records[1].id, "第二张的 init 必须在第一张 complete 之后（串行队列），记录序不符");
    const rows = await attemptReceiptRows(env, assignment.attemptId);
    assert.equal(rows.length, 2, `库中应有 2 行附件，实际 ${rows.length}`);
    assert.ok(rows.every((row) => row.status === "ready"), `库中存在非 ready 行：${JSON.stringify(rows)}`);
    assert.deepEqual([...new Set(rows.map((row) => row.sha256))].sort(), [shaA, shaB].sort(), "库中两张 sha256 与两张图片字节摘要不一致");
    Object.assign(evidence, { shaA, shaB, rows, init: inits.records, complete: completes.records, queueObservations, pendingSamples });
  });
}

// ---- R6：publicConfig 缺失 + /client-config 晚到 3 秒。----
// 通过标准：3 秒内 getAssignment/getDraft 已发出（proxy.hits 顺序与时间戳证明），期间 loading 恒 true；
// 配置回来后 loading=false，dishEnabled 与到达配置的 features.dishRecords 一致。
// 延迟注入说明：fault-proxy 无延迟原语、app.loadPublicConfig 无重试（drop 后配置永不到达，
// 与「配置回来后 loading=false」矛盾），故按任务书「脚本侧自行实现」路线：运行时把
// app.loadPublicConfig 包一层 3s 延迟（内部仍调原方法、真实请求仍走代理），不改任何业务文件。
async function scenarioR6(miniProgram, env, evidence) {
  const assignment = env.assignment;
  // devtools 的 wx.request 遵循 client-config 响应的 cache-control: public, max-age=300
  // （run1 实测：延迟重请求被 HTTP 缓存接管，代理 0 命中）。启动时的那次 client-config 填充了
  // 缓存；先等缓存过期，保证延迟后的真实请求确实打到代理上。
  const cacheWaitMs = automationLaunchedAtMs + CONFIG_CACHE_TTL_MS + 5_000 - Date.now();
  if (cacheWaitMs > 0) {
    console.error(`[R6] waiting ${Math.ceil(cacheWaitMs / 1000)}s for client-config HTTP cache (max-age=300) to expire`);
    await sleep(cacheWaitMs);
  }
  await miniProgram.evaluate((delayMs) => {
    const app = getApp();
    app.globalData.publicConfig = null;
    const original = app.loadPublicConfig.bind(app);
    app.__parityOriginalLoadPublicConfig = original;
    app.__parityConfigProbe = { wrappedAt: new Date().toISOString(), called: false, calledAt: null, resolvedAt: null, configKind: null };
    app.loadPublicConfig = () => {
      const probe = app.__parityConfigProbe;
      probe.called = true;
      probe.calledAt = new Date().toISOString();
      return new Promise((resolveLater) => setTimeout(() => {
        Promise.resolve(original()).then((value) => {
          probe.resolvedAt = new Date().toISOString();
          probe.configKind = value && typeof value === "object" ? "object" : String(value);
          resolveLater(value);
        }, () => resolveLater(null));
      }, delayMs));
    };
  }, CONFIG_DELAY_MS);
  try {
    const route = `/pages/dishes/index?assignmentId=${assignment.assignmentId}&attemptId=${assignment.attemptId}&questionnaireVersionId=${assignment.questionnaireVersionId}&revision=${assignment.revision}`;
    const navigation = withTimeout(miniProgram.reLaunch(route), 60000, "R6 reLaunch");
    navigation.catch(() => {}); // 超时赢下竞速后，底层 promise 的迟到拒绝不炸进程（await 时仍会抛出）。
    // reLaunch 调用与采样并行：窗口期（配置未到）发生在 changeRoute 的 sleep 期间，必须同步抓。
    const samples = [];
    const started = Date.now();
    while (Date.now() - started < 12000) {
      const current = await pageSnapshot(miniProgram).catch(() => null);
      // 只认本场景 attempt 的新开菜品页（run4 教训：上一场景残留页 loading=false 且 meta 已填，
      // 会被误判成「配置到达」的翻转样本导致采样提前 break，必须按 attemptId 过滤）。
      // 窗口样本=首帧 loading=true（此时 meta 必为 null，无需比对 attemptId）；
      // 翻转样本=loading=false 且 meta.attemptId 等于本场景 attempt。
      if (current && current.route === "pages/dishes/index") {
        if (current.loading === true) {
          samples.push({ elapsedMs: Date.now() - started, loading: current.loading, dishEnabled: current.dishEnabled });
        }
        if (current.loading === false && current.meta?.attemptId === assignment.attemptId) {
          samples.push({ elapsedMs: Date.now() - started, loading: false, dishEnabled: current.dishEnabled, afterConfig: true });
          break;
        }
      }
      await sleep(150);
    }
    await navigation;
    const finalSnapshot = await waitForPage(miniProgram,
      (s) => s.route === "pages/dishes/index" && s.loading === false,
      "R6 配置到达后 loading 未变 false");
    const assignmentHits = env.proxy.hits({ method: "GET", path: new RegExp(`/api/assignments/${assignment.assignmentId}$`) });
    const draftHits = env.proxy.hits({ method: "GET", path: new RegExp(`/api/questionnaires/secret/drafts/${assignment.attemptId}$`) });
    const configHits = env.proxy.hits({ method: "GET", path: "/api/public/client-config" });
    assert.equal(assignmentHits.count, 1, `getAssignment 应恰好 1 次，实际 ${assignmentHits.count}`);
    assert.equal(draftHits.count, 1, `getDraft 应恰好 1 次，实际 ${draftHits.count}`);
    assert.ok(configHits.count >= 1, "client-config 应至少 1 次");
    const configRecord = configHits.records[configHits.records.length - 1];
    assert.ok(assignmentHits.records[0].id < configRecord.id && draftHits.records[0].id < configRecord.id,
      "getAssignment/getDraft 必须都在 client-config 之前发出（proxy.hits 记录序）");
    const gapMs = Date.parse(configRecord.at) - Date.parse(draftHits.records[0].at);
    assert.ok(gapMs >= CONFIG_DELAY_MS - 500, `配置必须晚到 ≥2.5s（期望 3s），实测 ${gapMs}ms`);
    const trueSamples = samples.filter((item) => item.loading === true);
    assert.ok(trueSamples.length >= 2, `窗口期 loading=true 采样不足（${trueSamples.length} 条），采样序列：${JSON.stringify(samples)}`);
    const windowSpanMs = trueSamples[trueSamples.length - 1].elapsedMs - trueSamples[0].elapsedMs;
    assert.ok(windowSpanMs >= 2000, `loading=true 窗口跨度 ${windowSpanMs}ms，不足以证明 3 秒等待`);
    const lastTrueIndex = samples.reduce((last, item, index) => (item.loading === true ? index : last), -1);
    const flipSamples = samples.slice(lastTrueIndex + 1);
    assert.ok(flipSamples.length >= 1 && flipSamples.every((item) => item.loading === false),
      "loading=true 必须贯穿配置到达前，且到达后保持 false（出现 true→false→true 即失败）");
    assert.ok(trueSamples.every((item) => item.dishEnabled === false), "配置缺失期间 dishEnabled 必须保守为 false");
    const arrivedConfig = await miniProgram.evaluate(() => getApp()?.globalData?.publicConfig || null);
    assert.ok(arrivedConfig && typeof arrivedConfig === "object" && arrivedConfig.features, "client-config 到达后 globalData.publicConfig 仍为空");
    assert.equal(finalSnapshot.dishEnabled, arrivedConfig.features.dishRecords === true,
      `dishEnabled=${finalSnapshot.dishEnabled} 与到达配置 features.dishRecords=${arrivedConfig.features.dishRecords} 不一致`);
    const configProbe = await miniProgram.evaluate(() => getApp()?.__parityConfigProbe || null);
    Object.assign(evidence, {
      samples,
      trueSampleSpanMs: windowSpanMs,
      configGapMs: gapMs,
      arrivedConfig,
      configProbe,
      hits: { assignment: assignmentHits.records, draft: draftHits.records, clientConfig: configHits.records },
    });
  } catch (error) {
    markPhase(env, evidence, "on-failure");
    evidence.configProbe = await miniProgram.evaluate(() => getApp()?.__parityConfigProbe || null).catch(() => null);
    evidence.arrivedConfig = await miniProgram.evaluate(() => getApp()?.globalData?.publicConfig || null).catch(() => null);
    throw error;
  } finally {
    await miniProgram.evaluate(() => {
      const app = getApp();
      if (app.__parityOriginalLoadPublicConfig) {
        app.loadPublicConfig = app.__parityOriginalLoadPublicConfig;
        delete app.__parityOriginalLoadPublicConfig;
        delete app.__parityConfigProbe;
      }
      app.globalData.publicConfig = null;
    }).catch(() => { /* 页面已卸载等场景下尽力还原 */ });
  }
}

const SCENARIOS = [
  { id: "R1", title: "选 1 张图上传", run: scenarioR1 },
  { id: "R2", title: "complete 500 后重试", run: scenarioR2 },
  { id: "R3", title: "init 断开后移除待传项", run: scenarioR3 },
  { id: "R4", title: "已知 attachmentId 的失败项移除", run: scenarioR4 },
  { id: "R5", title: "排队第二张自动上传", run: scenarioR5 },
  { id: "R6", title: "配置晚到 3 秒", run: scenarioR6 },
];

// 单场景包装：fresh attempt、场景前预答问卷、proxy.reset() 隔离；失败不中断后续场景；
// 监听 miniProgram.on("exception")——场景期间出现运行时异常即该场景 FAIL。
async function runScenario({ id, title, run }, miniProgram, exceptions, cursor) {
  const evidence = { id, title, page: null, artifact: "", exceptions: [] };
  let failure = "";
  try {
    const scene = await setupParityEnv({ fresh: true });
    await answerAllQuestions(scene);
    scene.proxy.reset();
    await run(miniProgram, scene, evidence);
    evidence.page = await pageSnapshot(miniProgram).catch(() => null);
  } catch (error) {
    failure = String(error?.message || error).slice(0, 400);
    evidence.page = await pageSnapshot(miniProgram).catch(() => null);
    evidence.failure = failure;
  }
  const newExceptions = exceptions.slice(cursor.value).map((entry) => String(entry?.message || entry).slice(0, 200));
  cursor.value = exceptions.length;
  evidence.exceptions = newExceptions;
  if (!failure && newExceptions.length) failure = `小程序运行时异常 ${newExceptions.length} 条：${newExceptions.join("；").slice(0, 200)}`;
  try {
    await captureEvidence(miniProgram, id, evidence);
  } catch (error) {
    console.error(`[${id}] 留证失败：${String(error.message).slice(0, 160)}`);
  }
  console.log(`${failure ? "FAIL" : "PASS"} ${id} ${title}${failure ? ` — ${failure}` : ""}`);
  return { id, failed: Boolean(failure) };
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  // --only R3,R5：只跑指定场景（调试用；完整验收仍默认全跑）。
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex > 0 ? String(process.argv[onlyIndex + 1] || "").split(",") : null;
  const scenarios = only ? SCENARIOS.filter((scenario) => only.includes(scenario.id)) : SCENARIOS;
  const env = await setupParityEnv();
  const fixture = await prepareMiniappProjectForFixture();
  // fixture 副本内重写 runtime-config（仓库源文件不动）：apiBase 指回环代理，保证冷启动请求只打回环。
  await writeFile(
    join(fixture.projectPath, "miniprogram", "runtime-config.generated.js"),
    `// parity fixture copy: loopback-only apiBase（指向故障注入代理）\nexport const RUNTIME_CONFIG = Object.freeze({ apiBase: ${JSON.stringify(env.apiBase)} });\n`,
  );
  let miniProgram = null;
  const exceptions = [];
  const cursor = { value: 0 };
  const results = [];
  try {
    miniProgram = await launchAutomation(fixture.projectPath);
    automationLaunchedAtMs = Date.now();
    miniProgram.removeAllListeners?.("exception");
    miniProgram.on("exception", (entry) => exceptions.push(entry));
    await miniProgram.callWxMethod("setStorageSync", SESSION_STORAGE_KEY, env.inspector.session);
    await miniProgram.evaluate((storageKey) => { getApp().globalData.session = wx.getStorageSync(storageKey); }, SESSION_STORAGE_KEY);
    for (const scenario of scenarios) results.push(await runScenario(scenario, miniProgram, exceptions, cursor));
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 300);
    console.error(`[receipts] 环境或自动化启动失败：${reason}`);
    for (const { id, title } of scenarios) {
      if (!results.some((item) => item.id === id)) {
        console.log(`FAIL ${id} ${title} — 环境或自动化启动失败：${reason}`);
        results.push({ id, failed: true });
      }
    }
  } finally {
    if (miniProgram) { try { miniProgram.disconnect(); } catch { /* 已断开 */ } }
    if (fixture) await fixture.cleanup();
    await stopDevTools();
    if (env) await env.teardown();
  }
  const failedCount = results.filter((item) => item.failed).length;
  console.log(`receipts parity: ${results.length - failedCount}/${results.length} passed${only ? ` (--only ${only.join(",")})` : ""}`);
  if (failedCount > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
