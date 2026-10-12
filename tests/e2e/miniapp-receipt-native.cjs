const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const automator = require("miniprogram-automator");
require("./automator-compat.cjs");
const { startMiniappFixtureServer, stopMiniappFixtureServer } = require("./miniapp-fixture-server.cjs");
const { prepareMiniappProjectForFixture, stopDevTools } = require("./prepare-miniapp-fixture.cjs");

const route = "/pages/dishes/index?assignmentId=assignment-one&attemptId=attempt-one&questionnaireVersionId=version-one&revision=4";
const session = { accessToken: "test-access-token", user: { id: "user-inspector-one", displayName: "周雨晴", status: "approved_active" } };
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function snapshot(miniProgram) {
  return miniProgram.evaluate(() => {
    const page = getCurrentPages().slice(-1)[0];
    return { route: page?.route, data: page?.data || {}, polling: Boolean(page?.ocrTimer), recovery: page?.recovery || null };
  });
}

async function waitFor(miniProgram, predicate, message, timeout = 20000) {
  const started = Date.now();
  let current = await snapshot(miniProgram);
  while (!predicate(current) && Date.now() - started < timeout) { await sleep(200); current = await snapshot(miniProgram); }
  assert.ok(predicate(current), message);
  return current;
}

(async () => {
  let fixtureServer;
  let miniProgram;
  let fixtureProject;
  const exceptions = [];
  try {
    fixtureServer = await startMiniappFixtureServer();
    // fixture 视觉回归使用剥离人机验证插件的临时项目副本，生产 app.json 不变。
    fixtureProject = await prepareMiniappProjectForFixture();
    // 始终用 launch 让开发者工具指向本次 fixture 副本（automator.launch 内部执行
    // cli auto --auto-port 9420）。先彻底停止已运行实例，避免接管过程中的竞态。
    await stopDevTools();
    miniProgram = await automator.launch({ cliPath: "/Applications/wechatwebdevtools.app/Contents/MacOS/cli", projectPath: fixtureProject.projectPath, trustProject: true, timeout: 300000 });
    miniProgram.on("exception", (entry) => exceptions.push(entry));
    await miniProgram.callWxMethod("setStorageSync", "junde:session", session);
    await miniProgram.evaluate(() => {
      getApp().globalData.apiBase = "http://127.0.0.1:8788";
      getApp().globalData.session = wx.getStorageSync("junde:session");
      // fixture 形态=OCR 已开启（启动期 loadPublicConfig 拿不到数据），显式注入 client-config 功能开关。
      getApp().globalData.publicConfig = { captchaAppId: "2026", tencentMapKey: "fixture-map-key", features: { receiptOcr: true } };
    });
    await miniProgram.reLaunch(route);
    let current = await waitFor(miniProgram, (item) => item.route === "pages/dishes/index" && item.data.loading === false, "菜品页未完成加载");
    assert.equal(current.data.error, "");
    assert.equal(current.data.receiptRequired, true);
    assert.equal(current.data.readyCount, 1);
    assert.equal(current.data.receipts[0].status, "ready");
    assert.equal(current.data.dishes.find((dish) => dish.requirementId === "requirement-one").plannedName, "招牌烤鸭");

    await miniProgram.evaluate(async () => { await getCurrentPages().slice(-1)[0].startOcr(); });
    current = await waitFor(miniProgram, (item) => ["queued", "processing"].includes(item.data.ocrJob?.status), "OCR 未进入排队或处理状态");
    await miniProgram.evaluate(() => getCurrentPages().slice(-1)[0].onHide());
    current = await snapshot(miniProgram);
    assert.equal(current.polling, false, "页面隐藏后仍在轮询");
    await miniProgram.evaluate(() => getCurrentPages().slice(-1)[0].onShow());
    current = await waitFor(miniProgram, (item) => item.data.ocrJob?.status === "succeeded" && item.recovery?.appliedJobId === item.data.ocrJob.id, "OCR 未在恢复后成功并自动带入", 25000);
    assert.equal(current.data.dishes.filter((dish) => dish.id === "dish-ocr-extra").length, 1, "自动 apply 产生了重复菜品");
    assert.equal(current.data.dishes.find((dish) => dish.requirementId === "requirement-one").plannedName, "招牌烤鸭", "管理员要求菜品被覆盖");

    await miniProgram.evaluate(() => {
      const page = getCurrentPages().slice(-1)[0];
      page.moneyInput({ currentTarget: { dataset: { id: "dish-one", field: "unitPriceYuan" } }, detail: { value: "12.34" } });
      page.moneyBlur({ currentTarget: { dataset: { id: "dish-one", field: "unitPriceYuan" } } });
    });
    current = await snapshot(miniProgram);
    const edited = current.data.dishes.find((dish) => dish.id === "dish-one");
    assert.equal(edited.unitPriceCents, 1234);
    assert.equal(edited.manuallyModified, true);
    assert.equal(edited.unitPriceYuan, "12.34");
    assert.equal(exceptions.length, 0, `检测到 ${exceptions.length} 个小程序运行时异常`);
    process.stdout.write("miniapp receipt native runtime: passed\n");
  } finally {
    if (miniProgram) miniProgram.disconnect();
    await stopMiniappFixtureServer(fixtureServer);
    await fixtureProject?.cleanup();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
