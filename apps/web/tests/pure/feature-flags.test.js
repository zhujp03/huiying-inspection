// C 类纯逻辑测试：utils/feature-flags.js（module-contracts §5.5；语义来源 login/index.js:55、dishes/index.js:34，佐证 app.js:31）。
// 契约：isSelfServiceEnabled(publicConfig) / isReceiptOcrEnabled(publicConfig)。
// 语义：publicConfig 为 null/undefined、缺 features 对象、对应 flag 不严格等于 true → 一律 false（保守隐藏入口，R13/R15）；
// flag === true → true。两函数对称。
//
// TDD 红灯基线：apps/web/src/utils/feature-flags.js 尚未实现，本文件全部用例预期因模块不存在而失败。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { loadSrc } from "../helpers/contract-paths.js";

// 两函数对称表驱动：functionName + 对应的 features flag 名（module-contracts §1 featureFlags）。
const FLAG_FUNCTIONS = [
  { functionName: "isSelfServiceEnabled", flagName: "authSelfService" },
  { functionName: "isReceiptOcrEnabled", flagName: "receiptOcr" },
];

for (const { functionName, flagName } of FLAG_FUNCTIONS) {
  describe(`utils/feature-flags.js ${functionName}`, () => {
    it("publicConfig 为 null/undefined 返回 false", async () => {
      const mod = await loadSrc("utils/feature-flags.js");
      assert.equal(mod[functionName](null), false);
      assert.equal(mod[functionName](undefined), false);
    });

    it("缺 features 对象 / features 为空对象返回 false（保守隐藏入口）", async () => {
      const mod = await loadSrc("utils/feature-flags.js");
      assert.equal(mod[functionName]({ captchaAppId: "sample-app-id" }), false);
      assert.equal(mod[functionName]({ features: {} }), false);
    });

    it(`flag 不严格等于 true（false / 字符串 "true" / 数字 1）返回 false`, async () => {
      const mod = await loadSrc("utils/feature-flags.js");
      assert.equal(mod[functionName]({ features: { [flagName]: false } }), false);
      assert.equal(mod[functionName]({ features: { [flagName]: "true" } }), false);
      assert.equal(mod[functionName]({ features: { [flagName]: 1 } }), false);
    });

    it("flag 严格等于 true 返回 true", async () => {
      const mod = await loadSrc("utils/feature-flags.js");
      assert.equal(mod[functionName]({ features: { [flagName]: true } }), true);
    });
  });
}
