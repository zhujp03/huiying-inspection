# apps/web 测试 runbook（testing）

> 适用范围：H5 探员端移植套件（apps/web/tests/**）。契约文本：docs/web/module-contracts.md。
> 环境要求：Node 24（`export PATH=/opt/homebrew/opt/node@24/bin:$PATH`）、vitest 4.1.10、纯 node 环境（无浏览器/DOM，禁止 import jsdom 等）。

---

## 1. 固定跑法

在**仓库根目录**执行（vitest 的 root 默认取 cwd，include 模式按仓库根解析）：

```bash
# 全量（当前 = 红灯基线）
npx vitest run --config apps/web/vitest.config.js

# 单文件（路径过滤追加在命令尾部）
npx vitest run --config apps/web/vitest.config.js apps/web/tests/manifest.test.js
npx vitest run --config apps/web/vitest.config.js apps/web/tests/anti-omission.test.js
```

配置文件：`apps/web/vitest.config.js`（environment: "node"，include: `apps/web/tests/**/*.test.js`）。

门禁入口：`npm run test:web`（verify:offline 的 web 段）——串行执行上文全量套件 + `vite build` + dist 产物零域名扫描（apps/web/scripts/scan-dist.mjs）。

## 2. 预期红灯状态（TDD 基线，不是 bug）

当前处于三阶段流水线的第 1 段（盘点与测试规格）：`apps/web/src/**` 尚未实现。因此**全部用例预期 FAIL**，失败类型为模块不存在——`Cannot find module` / `ERR_MODULE_NOT_FOUND`（vite-node 可能转述为 "Failed to load url … Does the file exist?"），指向 `apps/web/src/<模块路径>`。

- 只要是「模块不存在」型失败即为正确基线；如出现语法错误、配置错误或其他类型失败，属于本套件自身缺陷，必须修复到只剩模块不存在型失败。
- 第 2 段按 docs/web/module-contracts.md 落地 src 模块后，同一命令应转为全绿——这正是本套件的验收口径（module-contracts.md §8）。

## 3. 测试目录命名约束

`apps/web/tests/` 下**只允许**以下子目录名：

- `helpers/` —— 共享加载器（contract-paths.js），非测试文件；
- `services/` —— services 层行为测试（后续任务）；
- `pure/` —— 纯函数测试（后续任务）；
- `rules/` —— 规则回归测试（后续任务）。

**禁止**使用 unit / integration / contract / load / visual / e2e 等名字：根套件的运行方式是路径过滤器（如 `vitest run tests/unit`、`vitest run tests/integration tests/contract`），过滤器按路径子串匹配；若 apps/web 下出现同名目录（例如 `apps/web/tests/unit/…` 会被 `tests/unit` 命中），会造成两套套件互相误伤。

## 4. 与根套件互不干扰

- 根套件：`npx vitest run tests/unit`（无 config，21 文件 207 测试）只收集并运行路径含 `tests/unit` 的文件；apps/web 套件目录名（helpers/services/pure/rules）与其过滤器无子串交集，不会被误收集。
- apps/web 套件**只在**显式携带 `--config apps/web/vitest.config.js` 时运行（其 include 锁定 `apps/web/tests/**/*.test.js`）。
- 后端套件 `vitest run tests/integration tests/contract` 同理不会命中本套件（无 `tests/contract` 子串）。

## 5. 禁词红线（生产源码扫描）

`node tests/frontend-contract.mjs` 会把 `apps/**` 下全部 `.js/.jsx/.wxml` 内容拼接后扫描一组禁用标记（清单见 tests/frontend-contract.mjs:20 与 :59，此处不复录原文，以免文档本身踩线）。apps/web 下新增的任何 `.js` 文件（含测试）都在扫描范围内：

- 因此本套件的测试数据命名一律使用 **sample/seed** 等词，禁止以「fixture」一词命名，禁止引入任何被扫描的生产源码禁用标记；
- 规格类文档（docs/**）虽不在扫描范围，同样遵守（见第 7 节自查）；
- 该扫描纳入 `npm run verify:offline` 门禁（经 `test:frontend`），踩线即破坏离线验收基线。

另：`apps/**` 下禁止出现 `.ts/.tsx` 文件（frontend-contract.mjs:17），本套件全部使用 ESM `.js`。

## 6. 零域名（R0）

rules.md R0（零域名约束）对本套件的落点：

- **B 类测试**（services 行为类，后续阶段落地）强制断言全部 API 请求 URL 为同源相对路径——以 `/api` 开头、不含 scheme/host，不得拼接任何 base/origin，不得读取构建期注入的 API 地址变量；
- apps/web 的 src（apps/web/src/**）与构建产物（如存在）不得出现域名/origin 字面量（含 https://、http:// 前缀地址与 //host 协议相对地址）以及 `VITE_API_BASE_URL` 等构建期注入变量名；`uploadToSignedTarget` 的预签名绝对 URL 只能作为服务端下发的运行时数据，不得以字面量进入源码；
- apps/web/tests/** 不在 R0 扫描范围（测试注释中的公开文档引用 URL、URL 解析辅助基址均非运行时 API 地址）；/api 前缀由同源反向代理承担。

## 7. 测试结构速览

- `apps/web/tests/helpers/contract-paths.js` —— 统一 `loadSrc()` 加载器；`srcPathList` 钉定 24 个 src 模块路径，所有用例经它加载 src，杜绝手写相对路径。
- `apps/web/tests/manifest.test.js` —— A 结构断言：app-manifest 页面/tab/services/adapters/featureFlags 布局；24 个 src 模块逐一「可加载 + 导出面与契约一致」。
- `apps/web/tests/anti-omission.test.js` —— E 反遗漏断言：从小程序 services/api.js 源码正则提取导出（33 函数 + BusinessError 类），与 manifest.services 双向对照；manifest 引用的 services/adapters 模块路径与 srcPathList 双向归属。

## 8. 提交前自查（本套件维护者执行）

```bash
npx vitest run --config apps/web/vitest.config.js   # 预期：红灯期全 FAIL（模块不存在）；实现后全 PASS
npx vitest run tests/unit                            # 预期：21 文件 207 测试全 PASS（无泄漏）
node tests/frontend-contract.mjs                     # 预期：passed
npm run test:web                                     # 预期：web 套件 321 全 PASS + vite build + 产物扫描 passed
```
