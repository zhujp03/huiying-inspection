// miniprogram-automator 0.12.1 兼容垫片（仅测试工具链，不影响业务代码）。
// 新版微信开发者工具的 Tool.getInfo 响应不再包含 SDKVersion 字段，旧版 automator
// 的 checkVersion() 会因 cmpVersion(undefined) 崩溃；此处跳过该版本检查。
// 只放宽测试工具与开发者工具的握手，不改变任何生产断言或业务逻辑。
const MiniProgram = require("miniprogram-automator/out/MiniProgram").default;

if (MiniProgram && MiniProgram.prototype) {
  MiniProgram.prototype.checkVersion = async function checkVersionCompatibility() {
    // 新版 DevTools 不再上报 SDKVersion；automator 版本检查无意义，直接放行。
  };
}

module.exports = {};
