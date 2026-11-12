# 小程序对齐验收环境（S 组产物，R/Q 组复用）

「微信开发者工具模拟器 + 真实 API + 真实库 + 故障注入」的小程序/后端对齐验收环境。

```
小程序（开发者工具模拟器，临时项目副本）
   │  apiBase = http://127.0.0.1:3100   ← 同时是签名直传 uploadTarget.url 的 origin
   ▼
故障注入代理 :3100（fault-proxy.mjs：failNext / dropNext / offline / hits，其余原样转发）
   ▼
真实 API :3000（NODE_ENV=development，AUTH_PROVIDER_MODE=sandbox，STORAGE_PROVIDER=local）
   ▼
PostgreSQL 17 :5433 / 库 junde_realapi（每次 bootstrap 删库重建 + 全量迁移 + seedRbac）
```

## 文件与导出

| 文件 | 导出 | 说明 |
| --- | --- | --- |
| `tests/e2e/parity/env.mjs` | `setupParityEnv({ fresh })`（约 62 行） | 全套环境搭建与 `teardown()` |
| | `SESSION_STORAGE_KEY`（约 29 行）、`PARITY_PUBLIC_CONFIG`（约 30 行） | 小程序注入约定常量 |
| | 直接运行 `node tests/e2e/parity/env.mjs --smoke` | 冒烟自测 |
| `tests/e2e/parity/fault-proxy.mjs` | `startFaultProxy({ target, port })`（约 76 行） | 故障注入反向代理 |

`setupParityEnv()` 返回：

```js
{
  apiBase,            // = proxyBase = http://127.0.0.1:3100（小程序与测试统一走这里）
  proxyBase,          // 同上
  upstreamBase,       // 真实 API 直连地址 http://127.0.0.1:3000（健康检查/绕过代理用）
  uploadTargetOrigin, // = proxyBase，签名直传 uploadTarget.url 的 origin
  inspector,          // { id, username, session }，session 即 junde:session 存储对象
  assignment,         // { assignmentId, attemptId, questionnaireVersionId, revision,
                      //   campaignId, storeId, attemptStatus: "draft" }
  proxy,              // fault-proxy 实例（见下）
  pool,               // junde_realapi 的 pg.Pool（只查隔离测试库）
  localStorageDir,    // API 本地磁盘存储目录（mkdtemp，/tmp 下）
  async teardown(),   // 见「teardown 语义」
}
```

## 怎么运行

前提条件：

1. PG17 容器在运行（`junde-pg17`，127.0.0.1:5433），仓库根 `.env` 提供本机连接串
   （`DATABASE_URL` 或 `REAL_API_DATABASE_URL`/`REAL_API_ADMIN_DATABASE_URL`；测试库一律经
   `deriveRealApiTestDatabaseUrl` 派生为回环上的 `junde_realapi`，指向生产/云端/源库会失败关闭）。
2. 微信开发者工具已开启服务端口（automator :9420 链路可用；脚本会用 `stopDevTools()` 先行再 launch）。
3. 用仓库默认 Node 即可；无新增 npm 依赖（只用 `miniprogram-automator`、`pg`、Node 内置模块）。

```bash
# 冒烟自测（建议 tee 留档，输出目录见下）
node tests/e2e/parity/env.mjs --smoke 2>&1 | tee /Users/michaelzhu/Documents/agent-reports/miniapp-parity-e2e/smoke-$(date +%Y%m%d-%H%M%S).log

# 下游 R 组/Q 组脚本（同目录）：
node tests/e2e/parity/receipts.mjs   # 小票直传/OCR 链路 + 故障注入
node tests/e2e/parity/flow.mjs       # 整体业务流 + 故障注入
```

输出目录：`/Users/michaelzhu/Documents/agent-reports/miniapp-parity-e2e/`（仓库外，放日志与留档）。

## R/Q 组接入模板

```js
import { setupParityEnv, PARITY_PUBLIC_CONFIG, SESSION_STORAGE_KEY } from "./env.mjs";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const requireFromRoot = createRequire(join(projectRoot, "package.json"));
const automator = requireFromRoot("miniprogram-automator");
const { prepareMiniappProjectForFixture, stopDevTools } = requireFromRoot("./tests/e2e/prepare-miniapp-fixture.cjs");
const cliPath = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timeout")), ms))]);

const env = await setupParityEnv();              // 或 { fresh: true } 新开一个 attempt 场景
const fixture = await prepareMiniappProjectForFixture();   // 小程序项目必须用临时副本
// 【必须】fixture 副本内重写 runtime-config（仓库源文件不动）：见「已知问题」第 2 条。
await writeFile(join(fixture.projectPath, "miniprogram", "runtime-config.generated.js"),
  `export const RUNTIME_CONFIG = Object.freeze({ apiBase: ${JSON.stringify(env.apiBase)} });\n`);

await stopDevTools();
const launched = await automator.launch({ cliPath, projectPath: fixture.projectPath, trustProject: true, timeout: 300000 });
// 【必须】对已运行 IDE 再次 cli auto（附加模式）并退避重连：见「已知问题」第 1 条。
spawnSync(cliPath, ["auto", "--project", fixture.projectPath, "--auto-port", "9420", "--trust-project"], { encoding: "utf8", timeout: 90000 });
launched?.disconnect?.();
let miniProgram = null;
for (let i = 0; i < 12 && !miniProgram; i++) {
  try {
    miniProgram = await withTimeout(automator.connect({ wsEndpoint: "ws://127.0.0.1:9420" }), 15000, "connect");
    await withTimeout(miniProgram.systemInfo(), 20000, "probe");
  } catch { try { miniProgram?.disconnect?.(); } catch {} miniProgram = null; await sleep(2000); }
}

await miniProgram.callWxMethod("setStorageSync", SESSION_STORAGE_KEY, env.inspector.session);
await miniProgram.evaluate((publicConfig) => { getApp().globalData.publicConfig = publicConfig; }, PARITY_PUBLIC_CONFIG);

// 问卷页（已处于可作答状态：已打卡、已开始、attempt=draft）
await miniProgram.reLaunch(`/pages/survey/index?assignmentId=${env.assignment.assignmentId}&attemptId=${env.assignment.attemptId}&questionnaireVersionId=${env.assignment.questionnaireVersionId}&revision=${env.assignment.revision}`);
// 菜品/小票页
await miniProgram.reLaunch(`/pages/dishes/index?assignmentId=${env.assignment.assignmentId}&attemptId=${env.assignment.attemptId}&questionnaireVersionId=${env.assignment.questionnaireVersionId}&revision=${env.assignment.revision}`);

// 故障注入示例
env.proxy.failNext({ method: "POST", path: /\/receipt-attachments\/.+\/complete$/ }, { status: 500, body: { error: { code: "FAULT_INJECTED" } } });
env.proxy.dropNext({ method: "POST", path: "/api/local-storage/objects" });   // 断网（覆盖签名直传一步）
env.proxy.offline(true);                                                      // 全量断网
const { count, records } = env.proxy.hits({ method: "GET", path: /\/questionnaire$/ });

// 收尾
miniProgram.disconnect();
await fixture.cleanup();
await stopDevTools();
await env.teardown();
```

新开互不影响的行为场景用 `const scene = await setupParityEnv({ fresh: true })`（得到新的
`scene.assignment.attemptId` 等；环境进程不重建）。

## fault-proxy match 用法

- `match = { method?: string, path: RegExp | string }`：`method` 大小写不敏感、可省略；
  `path` 为 RegExp 时对 `pathname` 做 `.test()`，为字符串时与 `pathname` 严格相等；query 不参与匹配。
- `failNext(match, { status, body, contentType? })`：下一次命中的请求不转发，直接返回给定状态码
  与响应体（`body` 为对象时按 JSON 发送）；缺省 `status=500`、缺省体为 `FAULT_INJECTED`。
- `dropNext(match)`：下一次命中的请求直接断开连接（模拟断网/超时，小程序侧得到 network fail）。
- `offline(on)`：开启后所有请求一律断开；关闭恢复转发。一次性故障队列不受影响。
- `hits(match?)`：返回 `{ count, records }`，`records` 每条含 `method/path/fault/status/body/at`。
  隐私约定：不含请求头（无 token）、JSON 体只记顶层键名、multipart 只记字段名与字节数——日志不会出现密码或凭据值。
- `reset()`：清空待生效故障与命中记录（场景隔离用）；`close()`：停止监听并断开存量连接。

## 直传 URL 走代理的方案（一句话）

API 进程注入 `PUBLIC_API_ORIGIN=http://127.0.0.1:3100`，本地存储 Provider 的
`createPostTarget` 用它拼 `uploadTarget.url`，而直传签名只覆盖 `formData` 字段、不覆盖 URL，
因此签名直传天然经过代理且验签不受影响——只改环境变量，不改任何业务代码。
冒烟里已做真实三步直传（init → multipart POST 经代理 → complete）验证该链路。

## 打卡处理方式（一句话）

不用管理员接口、不直接改库：`setupParityEnv` 用真实 HTTP 打卡（门店坐标，`result=accepted`）
再 `POST /api/assignments/:id/start` 创建 attempt，任务天然处于「已打卡、已开始、可作答」状态，
与小程序真实链路完全一致。

## fresh 语义（一句话）

进程内首次 `setupParityEnv()` 做完整 bootstrap（删库重建 → 迁移 → seedRbac → 管理员 → 起 API
→ 起代理 → sandbox 注册/审批/问卷发布/任务分配/登录/打卡/开始）；之后 `fresh=true` 只在同一
环境上新建「campaign + assignment(receiptRequired=true) + 打卡 + attempt」返回新
`assignment`（场景间互不影响，残留数据下次 bootstrap 删库时清掉），`fresh=false`（默认）原样
复用上一次的 assignment/attempt。

## teardown 语义（一句话）

`teardown()` 反序清理共享环境（代理 close → API 进程 SIGTERM → pg pool end），幂等；
**不删库**——`junde_realapi` 保留在磁盘上便于事后取证，下次 bootstrap 第一步即 `DROP DATABASE
IF EXISTS` 重建；automator/DevTools 生命周期归调用方（`disconnect()` + `stopDevTools()`），
临时项目副本由 `fixture.cleanup()` 清理。

## publicConfig 注入约定（一句话）

运行时 `getApp().globalData.publicConfig = { features: { receiptOcr: false, dishRecords: true } }`
（即 `PARITY_PUBLIC_CONFIG` 常量，R/Q 组直接 import，勿手写字面量）；session 注入用
`SESSION_STORAGE_KEY`（`junde:session`）+ `globalData.session`，与 `miniapp-receipt-native.cjs`
39–47 行同构。

## 安全边界

- 所有网络只打回环地址：代理/开发者工具/数据库均在 127.0.0.1；代理拒绝非回环上游。
- 数据库只允许隔离测试库 `junde_realapi`（`deriveRealApiTestDatabaseUrl` 强制回环 + 库名双闸）。
- 禁止任何 deploy/发布/上传命令；本目录脚本不含也不调用它们。
- 日志不输出 token/密码/连接串；测试账号密码仅存在于本目录源码内（仅对隔离测试库有效）。
- 测试短信走 sandbox（白名单手机号 + 固定验证码），不触达真实用户。

## 已知问题与固定做法（2026-11-11 实测，证据见输出目录留档）

1. **IDE 自动化冷启动回归（必须用附加模式）**：开发者工具 Stable 2.01.2510290 下，`cli auto`
   冷启动 IDE 时自动化引擎的 `Tool.*` 有应答、`App.*` 永不应答（原始 ws 抓帧证据：
   `Tool.getInfo` 秒回、`App.getPageStack` 12 秒无响应）；仓库现有 `tests/e2e/miniapp-receipt-native.cjs`
   同样卡死。对**已运行**的 IDE 再次执行 `cli auto`（附加模式）后 App 层恢复应答，且 attach 会让
   9420 服务重启（先 ECONNREFUSED → 初始化 → 数秒后可用），connect 需退避重试。
   冒烟脚本已内置该 workaround；R/Q 组照模板抄即可。
2. **fixture 副本必须重写 runtime-config（回环化）**：仓库 `apps/miniapp/miniprogram/runtime-config.generated.js`
   现为手写局域网地址（`http://192.168.0.172:3000`）。小程序冷启动 `loadPublicConfig` 会打非回环地址
   （违反「只连回环」边界），且实测导致模拟器首屏崩溃：`TypeError [ERR_INVALID_ARG_TYPE]: The "path"
   argument must be of type string. Received undefined`（login 页白屏报错，截图留档）。副本内改写为
   代理地址后首屏恢复正常。仓库源文件一行未动；该问题应单独走缺陷流程修复生成器。
3. 其余现象（已排除）：`lazyCodeLoading` 与崩溃无关（对照实验）；插件剥离/fixture 流程本身与参考脚本
   一致，不是故障源。
