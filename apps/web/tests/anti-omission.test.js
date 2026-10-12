// E 反遗漏断言：以小程序 services/api.js 源码为提取源，防止 H5 移植漏函数/漏类，
// 并约束 app-manifest 引用的模块路径与 tests/helpers/contract-paths.js 的
// srcPathList（24 项）一一归属。
//
// TDD 红灯基线：apps/web/src/** 尚未实现，本文件全部用例预期因模块不存在而失败。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { srcPathList, loadSrc } from "./helpers/contract-paths.js";

// 小程序源码（只读参照，禁止改动）：apps/web/tests → 仓库根需上跳三级。
const apiSourcePath = fileURLToPath(new URL("../../../apps/miniapp/miniprogram/services/api.js", import.meta.url));

// 两个非 api.js 导出、随 H5 移植新增的服务函数（app.js 直连 client-config 与验证码链）。
const PORTED_EXTRA = ["loadPublicConfig", "obtainCaptchaTicket"];

// srcPathList 钉定 24 项（与 helpers/contract-paths.js 同步维护）。
const PINNED_SRC_LIST = [
  "app-manifest.js",
  "adapters/http.js",
  "adapters/storage.js",
  "adapters/upload.js",
  "adapters/location.js",
  "services/auth.js",
  "services/assignments.js",
  "services/drafts.js",
  "services/receipts.js",
  "services/uploads.js",
  "services/public-config.js",
  "services/captcha.js",
  "store/session.js",
  "store/assignments-cache.js",
  "store/survey.js",
  "store/survey-merge.js",
  "utils/presentation.js",
  "utils/business.js",
  "utils/errors.js",
  "utils/coordinates.js",
  "utils/feature-flags.js",
  "utils/upload-queue.js",
  "features/receipt-ocr.js",
  "router/guards.js",
];

const extractApiExports = () => {
  const source = readFileSync(apiSourcePath, "utf8");
  return {
    functions: [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((match) => match[1]),
    classes: [...source.matchAll(/export\s+class\s+(\w+)/g)].map((match) => match[1]),
  };
};

const manifestFunctionUnion = async () => {
  const manifest = await loadSrc("app-manifest.js");
  return Object.values(manifest.services).flatMap((domain) => domain.functions);
};

describe("反遗漏断言：api.js ↔ app-manifest ↔ srcPathList", () => {
  it("小程序 api.js 恰好导出 33 个函数，且每个都归入 manifest.services 某域", async () => {
    const { functions, classes } = extractApiExports();
    assert.equal(classes.length, 1, "api.js 应恰好导出一个类（BusinessError）");
    assert.equal(functions.length, 33, `api.js 导出函数应为 33 个，实际 ${functions.length}`);
    assert.equal(new Set(functions).size, 33, "api.js 导出函数名不得重复");
    const union = await manifestFunctionUnion();
    const unionSet = new Set(union);
    const missing = functions.filter((name) => !unionSet.has(name));
    assert.deepEqual(missing, [], "以下 api.js 函数未归入 manifest.services 任何域");
  });

  it("manifest.services 与 api.js 函数双向对齐（额外仅允许 loadPublicConfig 与 obtainCaptchaTicket）", async () => {
    const { functions } = extractApiExports();
    const union = await manifestFunctionUnion();
    const expected = [...new Set([...functions, ...PORTED_EXTRA])].sort();
    assert.deepEqual([...new Set(union)].sort(), expected, "manifest.services 函数并集应恰为 api.js 33 函数 + 2 个移植函数");
  });

  it("api.js 导出的 BusinessError 类由 utils/errors.js 等价导出（含 presentError）", async () => {
    const { classes } = extractApiExports();
    assert.deepEqual(classes, ["BusinessError"]);
    const errors = await loadSrc("utils/errors.js");
    assert.equal(typeof errors.BusinessError, "function", "utils/errors.js 应导出 BusinessError 类");
    assert.equal(errors.BusinessError.name, "BusinessError");
    assert.equal(typeof errors.presentError, "function", "完整错误映射 presentError 必须随 utils/errors.js 导出");
  });

  it("manifest.services 各域 functions 无重复成员", async () => {
    const manifest = await loadSrc("app-manifest.js");
    for (const [domain, config] of Object.entries(manifest.services)) {
      assert.equal(new Set(config.functions).size, config.functions.length, `services.${domain}.functions 存在重复成员`);
    }
  });

  it("srcPathList 钉定 24 项，且 manifest 引用的 services/adapters 模块路径与之双向归属", async () => {
    assert.deepEqual(srcPathList, PINNED_SRC_LIST, "contract-paths 的 srcPathList 必须与钉定 24 项一致");
    const manifest = await loadSrc("app-manifest.js");
    const referenced = [
      ...Object.values(manifest.services).map((domain) => domain.module),
      ...Object.values(manifest.adapters).map((adapter) => adapter.module),
    ];
    const ioPaths = srcPathList.filter((path) => path.startsWith("services/") || path.startsWith("adapters/"));
    assert.equal(new Set(referenced).size, referenced.length, "manifest 引用的 module 路径不得重复");
    assert.deepEqual([...new Set(referenced)].sort(), [...ioPaths].sort(), "manifest.services/adapters 的 module 全集必须与 srcPathList 的 services/*+adapters/* 子集双向一致");
  });
});
