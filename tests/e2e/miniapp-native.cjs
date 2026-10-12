const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const automator = require("miniprogram-automator");
require("./automator-compat.cjs");
const { startMiniappFixtureServer, stopMiniappFixtureServer } = require("./miniapp-fixture-server.cjs");
const { prepareMiniappProjectForFixture, stopDevTools } = require("./prepare-miniapp-fixture.cjs");

const projectRoot = path.resolve(__dirname, "../..");
const outputDir = path.join(projectRoot, "tests/visual/wechat-2026-07-24");
const cliPath = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const projectPath = path.join(projectRoot, "apps/miniapp");
const routeQuery = "assignmentId=assignment-one&attemptId=attempt-one&questionnaireVersionId=version-one&revision=4";
const results = [];
const runtimeEvents = [];

fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(path.join(outputDir, "failure.txt"), { force: true });

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalisePagePath(value) {
  return `/${String(value || "").replace(/^\//, "")}`;
}

async function currentPageSnapshot(miniProgram) {
  return miniProgram.evaluate(() => {
    const page = getCurrentPages().slice(-1)[0];
    return { route: page?.route || "", data: page?.data || {} };
  });
}

async function setCurrentPageData(miniProgram, patch) {
  await miniProgram.evaluate((data) => getCurrentPages().slice(-1)[0]?.setData(data), patch);
}

async function waitUntilSettled(miniProgram, expectedPath, timeout = 45000) {
  const startedAt = Date.now();
  let snapshot = await currentPageSnapshot(miniProgram);
  while ((normalisePagePath(snapshot.route) !== expectedPath || snapshot.data.loading === true) && Date.now() - startedAt < timeout) {
    await sleep(200);
    snapshot = await currentPageSnapshot(miniProgram);
  }
  assert.equal(normalisePagePath(snapshot.route), expectedPath, `${expectedPath} 页面逻辑层未就绪`);
  assert.notEqual(snapshot.data.loading, true, `${expectedPath} 加载超时`);
  return snapshot.data;
}

async function capture(miniProgram, name, page, expectedPath, options = {}) {
  process.stdout.write(`CAPTURE ${name}: wait\n`);
  const data = await waitUntilSettled(miniProgram, expectedPath, options.timeout);
  assert.equal(normalisePagePath(page.path), expectedPath, `${name} 路由错误`);
  if (!options.allowError) assert.equal(data.error || "", "", `${name} 加载失败: ${data.error}`);
  const filePath = path.join(outputDir, `${name}.png`);
  process.stdout.write(`CAPTURE ${name}: screenshot\n`);
  await miniProgram.screenshot({ path: filePath });
  const result = {
    name,
    route: normalisePagePath(page.path),
    screenshot: filePath,
    loading: data.loading === undefined ? null : data.loading,
    error: data.error || "",
  };
  results.push(result);
  process.stdout.write(`PASS ${name} ${result.route}\n`);
  return data;
}

async function open(miniProgram, name, url, expectedPath, options) {
  process.stdout.write(`OPEN ${name}: ${url}\n`);
  const page = await miniProgram.reLaunch(url);
  process.stdout.write(`OPEN ${name}: routed\n`);
  await sleep(400);
  const data = await capture(miniProgram, name, page, expectedPath, options);
  return { page, data };
}

async function captureState(miniProgram, name, page, patch) {
  await setCurrentPageData(miniProgram, patch);
  await miniProgram.pageScrollTo(0);
  await sleep(250);
  return capture(miniProgram, name, page, normalisePagePath(page.path), { allowError: true });
}

async function main() {
  let miniProgram;
  let fixtureServer;
  let fixtureProject;
  try {
    fixtureServer = await startMiniappFixtureServer();
    // fixture 视觉回归使用剥离人机验证插件的临时项目副本，生产 app.json 不变。
    fixtureProject = await prepareMiniappProjectForFixture();
    process.stdout.write("CONNECT 微信开发者工具自动化端口\n");
    // 始终用 launch 让开发者工具指向本次 fixture 副本（automator.launch 内部执行
    // cli auto --auto-port 9420，可接管已运行实例）；connect 只作为端口已就绪且
    // 项目即为本次副本时的快速路径，避免挂到被清理的旧临时项目上。
    await stopDevTools();
    miniProgram = await automator.launch({
      cliPath,
      projectPath: fixtureProject.projectPath,
      trustProject: true,
      timeout: 300000,
    });
    process.stdout.write("CONNECTED\n");
    miniProgram.on("console", (entry) => runtimeEvents.push({ type: "console", entry }));
    miniProgram.on("exception", (entry) => runtimeEvents.push({ type: "exception", entry }));

    let opened = await open(miniProgram, "00-login", "/pages/login/index", "/pages/login/index");
    // 策略（2026-08-13）：注册/忘记密码 UI 已隐藏（wx:if=false），登录页只保留
    // 用户名/密码/登录表单；保留一张隐藏态基线证明不再渲染注册/忘记密码入口。
    await captureState(miniProgram, "00a-login-hidden-entries", opened.page, { mode: "login", step: "form", accountStatus: "" });

    const session = {
      accessToken: "test-access-token",
      user: { id: "user-inspector-one", displayName: "周雨晴", status: "approved_active" },
    };
    await miniProgram.callWxMethod("setStorageSync", "junde:session", session);
    await miniProgram.evaluate(() => {
      getApp().globalData.apiBase = "http://127.0.0.1:8788";
      getApp().globalData.session = wx.getStorageSync("junde:session");
      // fixture 形态=OCR 已开启：client-config 功能开关（apiBase 在启动后才指向 fixture，启动期的
      // loadPublicConfig 拿不到数据），显式注入保证菜品页 OCR 入口与生产开启形态一致。
      getApp().globalData.publicConfig = { captchaAppId: "2026", tencentMapKey: "fixture-map-key", features: { receiptOcr: true } };
    });

    opened = await open(miniProgram, "01-location", "/pages/location/index", "/pages/location/index");
    await captureState(miniProgram, "01a-location-blocked", opened.page, { status: "blocked", message: "未能获取位置，你仍可查看任务说明，但不能开始探店。" });

    await open(miniProgram, "02-home", "/pages/home/index", "/pages/home/index");
    await open(miniProgram, "03-schedule", "/pages/schedule/index", "/pages/schedule/index");
    await open(miniProgram, "04-profile", "/pages/profile/index", "/pages/profile/index");

    opened = await open(miniProgram, "06-task", "/pages/task/index?assignmentId=assignment-one", "/pages/task/index");
    await captureState(miniProgram, "06a-task-submitted-readonly", opened.page, {
      task: { ...opened.data.task, status: "submitted", statusLabel: "已提交", submittedAt: "2026-07-24 17:30" },
    });

    await open(miniProgram, "07-survey", `/pages/survey/index?${routeQuery}`, "/pages/survey/index");

    opened = await open(miniProgram, "08-issue", `/pages/issue/index?${routeQuery}&questionId=question-2&target=unscored`, "/pages/issue/index");
    await captureState(miniProgram, "08a-evidence-states", opened.page, {
      question: { ...opened.data.question, evidence: { ...opened.data.question.evidence, imageRequired: true, audioRequired: true } },
      images: [
        { id: "image-uploading", type: "image", status: "uploading", progressLabel: "正在上传 42%" },
        { id: "image-failed", type: "image", status: "failed", progressLabel: "上传失败，请重试" },
        { id: "image-ready", type: "image", status: "staged_ready", progressLabel: "上传成功" },
      ],
      audios: [{ id: "audio-ready", type: "audio", status: "active", progressLabel: "已保存音频", previewUrl: "fixture://audio" }],
    });

    opened = await open(miniProgram, "09-dishes", `/pages/dishes/index?${routeQuery}`, "/pages/dishes/index");
    assert.deepEqual(opened.data.dishes.map((dish) => dish.fulfillmentStatus), ["ordered", "substituted", "unavailable", "skipped", "extra"]);
    assert.equal(opened.data.receiptRequired, true);
    assert.equal(opened.data.receipts.filter((receipt) => receipt.status === "ready").length, 1);
    await captureState(miniProgram, "09b-receipt-uploading", opened.page, {
      pendingReceipts: [{ clientFileId: "visual-upload", localPath: opened.data.receipts[0].previewUrl, status: "uploading", statusLabel: "上传中", progressPercent: 46, progressText: "46%", message: "正在上传 46%" }],
      receiptBusy: true,
    });
    await captureState(miniProgram, "09c-ocr-partial-review", opened.page, {
      pendingReceipts: [], receiptBusy: false,
      ocrJob: { id: "visual-job", status: "partial", recognizedDishCount: 3, reviewFieldCount: 1, userMessage: "已带入菜品，请核对价格" },
      ocrView: { label: "已带入 3 道菜，请核对标记内容", tone: "review", terminal: true },
      dishes: opened.data.dishes.map((dish, index) => index === 0 ? { ...dish, source: "ocr", fromReceipt: true, reviewFields: ["unitPriceCents"], needsReview: true, unitPriceYuan: "268.00", lineTotalYuan: "268.00" } : dish),
    });
    await miniProgram.pageScrollTo(1200);
    await sleep(300);
    await capture(miniProgram, "09a-dishes-lower", opened.page, "/pages/dishes/index");

    opened = await open(miniProgram, "10-other", `/pages/other/index?${routeQuery}`, "/pages/other/index");
    await miniProgram.evaluate(() => { getCurrentPages().slice(-1)[0]?.confirm(); });
    await sleep(700);
    await capture(miniProgram, "10a-submit-confirmation", opened.page, "/pages/other/index");

    opened = await open(miniProgram, "10b-other-reloaded", `/pages/other/index?${routeQuery}`, "/pages/other/index");
    await captureState(miniProgram, "10b-submit-processing", opened.page, { submitState: "processing", message: "问卷正在处理，请稍候" });
    await captureState(miniProgram, "10c-submit-retryable", opened.page, { submitState: "retryable_failed", message: "网络连接中断，可以重试提交" });
    await captureState(miniProgram, "10d-submit-terminal-failure", opened.page, { submitState: "terminal_failed", message: "任务状态已变更，请联系管理员" });
    await captureState(miniProgram, "10e-submit-success", opened.page, { submitState: "submitted", submittedAt: "2026-07-24 17:30", message: "提交成功" });

    const exceptions = runtimeEvents.filter((event) => event.type === "exception");
    const applicationExceptions = exceptions.filter((event) => !/webapi_getwxaasyncsecinfo|operateWXData|游客模式/.test(JSON.stringify(event)));
    fs.writeFileSync(path.join(outputDir, "results.json"), `${JSON.stringify({ passed: results.length, results, exceptions, applicationExceptions, runtimeEvents }, null, 2)}\n`);
    assert.equal(applicationExceptions.length, 0, `检测到 ${applicationExceptions.length} 个小程序运行时异常`);
    process.stdout.write(`DONE ${results.length} screenshots\n`);
  } finally {
    if (miniProgram) miniProgram.disconnect();
    await stopMiniappFixtureServer(fixtureServer);
    await fixtureProject?.cleanup();
  }
}

main().catch((error) => {
  fs.writeFileSync(path.join(outputDir, "failure.txt"), `${error.stack || error}\n`);
  console.error(error);
  process.exitCode = 1;
});
