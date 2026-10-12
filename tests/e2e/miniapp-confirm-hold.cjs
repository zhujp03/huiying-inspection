const automator = require("miniprogram-automator");

const session = {
  accessToken: "test-access-token",
  user: { id: "user-inspector-one", displayName: "周雨晴", status: "approved_active" },
};

(async () => {
  const miniProgram = await automator.connect({ wsEndpoint: "ws://127.0.0.1:9420" });
  try {
    await miniProgram.callWxMethod("setStorageSync", "junde:session", session);
    await miniProgram.evaluate(() => {
      getApp().globalData.apiBase = "http://127.0.0.1:8788";
      getApp().globalData.session = wx.getStorageSync("junde:session");
    });
    await miniProgram.reLaunch("/pages/other/index?assignmentId=assignment-one&attemptId=attempt-one&questionnaireVersionId=version-one&revision=4");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await miniProgram.evaluate(() => { getCurrentPages().slice(-1)[0]?.confirm(); });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    process.stdout.write("MODAL_READY\n");
    await new Promise((resolve) => setTimeout(resolve, 120000));
  } finally {
    miniProgram.disconnect();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
