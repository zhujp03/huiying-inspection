// T3d1 规则册测试（TDD 红灯基线）：R0 + R01–R33 共 34 条，断言语义唯一来源 docs/web/rules.md，
// 模块契约依据 docs/web/module-contracts.md，模块加载一律经 tests/helpers/contract-paths.js 的 loadSrc()。
//
// 断言层级阶梯（每个 it 上方注释标明层级）：
//   pure    —— store / router / utils 纯逻辑，不经网络；
//   service —— vi.stubGlobal("fetch", ...) 打桩后驱动 services/** 服务函数；
//   adapter —— 平台适配器（location / captcha 链）；
//   manifest —— 页面编排规则以 app-manifest.js 声明兜底，页面行为断言留待 stage-3 E2E 补（it 内注释标注）。
// 测试数据统一命名 sample*；响应样例均满足 contracts.generated.js 校验器（第 2 段实现后 validate 放行）。
//
// TDD 红灯基线：apps/web/src/** 尚未实现，本文件全部用例预期因模块不存在（Cannot find module）失败——这是预期，不是缺陷。
import { describe, it, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSrc } from "../helpers/contract-paths.js";
import { endpointRegistry } from "../../../../packages/contracts/endpoint-registry.js";

// ---------- 公共样例与打桩基建 ----------
const SAMPLE_SESSION = { accessToken: "sample-token", user: { id: "user-1", status: "approved_active" } };
const SAMPLE_MINE = { items: [{ id: "assignment-mine-1", status: "assigned" }] };
const ASSIGNMENT_SAMPLE = { id: "assignment-sample-1", status: "assigned", storeName: "sample-store" };
const START_SAMPLE = { attempt: { id: "attempt-start-1", revision: 0 }, questionnaireVersion: { id: "qv-start-1" } };
const QUESTIONNAIRE_SAMPLE = {
  attempt: { id: "attempt-sample-1", status: "in_progress", revision: 2 },
  questionnaireVersion: { id: "qv-sample-1" },
  questions: [],
  answers: {},
};
const SAMPLE_CHECK_IN = { latitude: 31.2304, longitude: 121.4737, accuracy: 25, capturedAt: "2026-10-10T10:00:00+08:00" };

let fetchMock;

const stubJson = (body, status = 200) => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
};

// 兼容 fetch(url) 与 fetch(url, init) 两种调用形态。基址仅用于解析同源相对路径
// （测试文件在 apps/web/tests/**，不在 R0 扫描范围，见 rules.md R0 边界与例外）。
const callsOf = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    pathname: new URL(String(url), "http://sample.local").pathname,
    method: String(init?.method ?? "GET").toUpperCase(),
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
  }));

const seedSession = async () => {
  (await loadSrc("store/session.js")).saveSession(SAMPLE_SESSION);
};

afterEach(async () => {
  vi.unstubAllGlobals();
  try {
    (await loadSrc("store/session.js")).clearSessionAndUserCache();
  } catch {
    // 红灯基线：模块未落地时清理让位于用例本身的模块缺失失败，不引入第二类错误
  }
});

// ---------- R0 扫描基建（扫描断言绿态生效；红灯基线由 it 内锚点 loadSrc 先行失败） ----------
const webRoot = fileURLToPath(new URL("../..", import.meta.url)); // apps/web/

const listFilesRecursively = (directory) => {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const entryPath = join(directory, entry);
    return statSync(entryPath).isDirectory() ? listFilesRecursively(entryPath) : [entryPath];
  });
};

describe("R0 零域名约束", () => {
  it("R0-零域名约束: src 与构建产物零域名字面量、零构建期 API 地址变量（API 一律同源相对路径）", async () => {
    // 层级：manifest/源码扫描。扫描口径按主控钉定：① 不含 https?:// 字面量；② 不含 VITE_/API_BASE/import.meta.env
    // 构建期注入标识；③ 不含引号内的协议相对地址（//host 形式，rules.md R0 正文明令禁止）。
    // 例外边界以 rules.md R0 条目为准：预签名直传 URL 仅作运行时数据，不得以字面量出现在源码。
    await loadSrc("app-manifest.js"); // 锚点：红灯基线因模块不存在 FAIL；绿灯阶段保证 src 已落地后再扫描
    const scanTargets = [
      ...listFilesRecursively(join(webRoot, "src")),
      join(webRoot, "vitest.config.js"),
      ...listFilesRecursively(join(webRoot, "dist")), // dist 不存在时跳过
    ];
    assert.ok(scanTargets.includes(join(webRoot, "vitest.config.js")), "构建配置必须纳入零域名扫描");
    assert.ok(scanTargets.length > 2, "扫描目标必须覆盖 src/** 全部文件与构建配置");
    const violations = [];
    // dist 窄豁免（主控裁决 2026-10-10，本套件唯一测试改动，仅对 dist/** 生效）：
    // react-dom 产物内嵌 XML 命名空间串（http://www.w3.org/…）与 react 错误码文档前缀
    //（https://react.dev/errors/）为 vendor 不可避免内容、非 API 地址——rules.md R0 的立法意图是
    // API 地址零字面量（与 R0 边界「tests/** 不在扫描范围」同理）。扫描 dist 文件时先从行内容剥离
    // 这两个前缀串，再跑既有正则判定；src/** 与 vitest.config.js 仍零容忍、不做任何剥离。
    const DIST_ONLY_EXEMPT_PREFIXES = ["http://www.w3.org/", "https://react.dev/errors/"];
    const isDistFile = (filePath) => relative(webRoot, filePath).startsWith(`dist${sep}`);
    for (const filePath of scanTargets) {
      readFileSync(filePath, "utf8")
        .split("\n")
        .forEach((line, lineIndex) => {
          const effectiveLine = isDistFile(filePath)
            ? DIST_ONLY_EXEMPT_PREFIXES.reduce((stripped, prefix) => stripped.split(prefix).join(""), line)
            : line;
          if (/https?:\/\//.test(effectiveLine) || effectiveLine.includes("VITE_") || effectiveLine.includes("API_BASE") || effectiveLine.includes("import.meta.env") || /["'`]\/\/[a-z0-9.-]+\.[a-z]{2,}\//i.test(effectiveLine)) {
            violations.push(`${relative(webRoot, filePath)}:${lineIndex + 1}`);
          }
        });
    }
    assert.deepEqual(violations, [], `发现域名/构建期注入标识残留（零域名违规）：\n${violations.join("\n")}`);
  });
});

describe("pure 层：store / router / utils 规则", () => {
  it("R01-会话本地存储: saveSession 持久化到 junde:session，未登录/清除后 getSession 返回 null", async () => {
    // 层级：pure（store/session.js + adapters/storage）
    const session = await loadSrc("store/session.js");
    const storage = await loadSrc("adapters/storage.js");
    assert.equal(session.getSession(), null, "从未登录读取返回 null");
    session.saveSession(SAMPLE_SESSION);
    assert.deepEqual(storage.readStorage("junde:session"), SAMPLE_SESSION, "整包持久化到 junde:session 键");
    assert.deepEqual(session.getSession(), SAMPLE_SESSION, "保存后 getSession 返回该会话");
    session.clearSessionAndUserCache();
    assert.equal(session.getSession(), null, "清除后读取返回 null");
    assert.equal(storage.readStorage("junde:session"), null, "清除后存储键移除");
    // 应用启动时从存储恢复会话（H5 由模块内存态承担 globalData 职责）：页面编排，stage-3 E2E 补
  });

  it("R02-导航守卫: approved_active+accessToken 放行返回会话，否则判定 redirect /login", async () => {
    // 层级：pure（router/guards.js requireApprovedSession；wx.reLaunch 语义改为纯判定 + redirect 由调用方执行）
    const { requireApprovedSession } = await loadSrc("router/guards.js");
    const sampleSession = { ...SAMPLE_SESSION };
    const result = requireApprovedSession(sampleSession);
    assert.deepEqual(result, { ok: true, session: sampleSession });
    assert.equal(result.session, sampleSession, "放行时返回同一会话对象");
    assert.deepEqual(
      requireApprovedSession({ accessToken: "sample-token", user: { id: "user-1", status: "pending_approval" } }),
      { ok: false, redirect: "/login" },
      "非 approved_active 一律踢回登录",
    );
    assert.deepEqual(
      requireApprovedSession({ user: { id: "user-1", status: "approved_active" } }),
      { ok: false, redirect: "/login" },
      "缺 accessToken 一律踢回登录",
    );
    assert.deepEqual(requireApprovedSession(null), { ok: false, redirect: "/login" }, "无会话一律踢回登录");
    // 页面编排（守卫挂载 home/schedule/profile/location，返回 ok:false 时中止加载）：stage-3 E2E 补
  });

  it("R03-冷启动会话探测: coldStartRoute 已登录分流 /home，未登录留守 /login", async () => {
    // 层级：pure（router/guards.js coldStartRoute）
    const { coldStartRoute } = await loadSrc("router/guards.js");
    assert.equal(coldStartRoute(SAMPLE_SESSION), "/home", "已登录冷启动进首页");
    assert.equal(
      coldStartRoute({ accessToken: "sample-token", user: { id: "user-1", status: "pending_approval" } }),
      "/login",
      "非 approved 会话留守登录页",
    );
    assert.equal(coldStartRoute(null), "/login", "无会话留守登录页");
    // 页面编排（getMyAssignments 探测一次成功且 login/form 才进首页、失败不自动重试）：stage-3 E2E 补
  });

  it("R09-任务列表短时缓存: 15s TTL 命中、过期惰性删除、force 跳过读取、按 userId 隔离", async () => {
    // 层级：pure（store/assignments-cache.js，注入 { now } 时钟）
    const { createAssignmentCache } = await loadSrc("store/assignments-cache.js");
    let nowMs = 1_000_000;
    const cache = createAssignmentCache({ now: () => nowMs });
    const sampleItems = [{ id: "assignment-cache-1", status: "assigned" }];
    cache.set("user-1", sampleItems);
    cache.set("user-2", [{ id: "assignment-cache-2", status: "assigned" }]);
    assert.deepEqual(cache.get("user-1"), { items: sampleItems }, "TTL 内命中返回 { items }");
    assert.deepEqual(cache.get("user-2"), { items: [{ id: "assignment-cache-2", status: "assigned" }] }, "条目按 userId 隔离");
    nowMs += 14_999;
    assert.deepEqual(cache.get("user-1"), { items: sampleItems }, "15 秒内仍命中");
    cache.set("user-2", [{ id: "assignment-cache-2", status: "assigned" }]); // 时钟已推进，重写 user-2 使其仍在 TTL 内（原用例两键同刻写入、同刻过期，末条断言在固定 TTL 语义下不可满足；2026-10-10 PM 裁决的最小修复，原断言全部保留）
    nowMs += 2;
    assert.equal(cache.get("user-1"), null, "过期条目被删除并返回 null");
    assert.deepEqual(cache.get("user-2"), { items: [{ id: "assignment-cache-2", status: "assigned" }] }, "过期删除只影响自身条目");
    cache.set("user-1", sampleItems);
    nowMs = 1_000_000;
    assert.equal(cache.get("user-1", { force: true }), null, "force=true 跳过缓存读取");
    assert.equal(cache.get(""), null, "userId 为空直接 miss");
  });

  it("R13-自助服务 UI 门控: authSelfService falsy → isSelfServiceEnabled false（入口保守隐藏）", async () => {
    // 层级：pure（utils/feature-flags.js）+ manifest 声明
    const { isSelfServiceEnabled } = await loadSrc("utils/feature-flags.js");
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(isSelfServiceEnabled(null), false, "配置未到达 → 保守隐藏注册/找回/重交入口");
    assert.equal(isSelfServiceEnabled({ features: { authSelfService: false } }), false);
    assert.equal(isSelfServiceEnabled({ features: { authSelfService: "true" } }), false, "非严格 true → false");
    assert.equal(isSelfServiceEnabled({ features: { authSelfService: true } }), true, "开关严格 true 才放行");
    assert.deepEqual(manifest.featureFlags.authSelfService, { flag: "features.authSelfService", pages: ["login"] });
    // 页面编排（被拒状态页无「修改并重新提交」仅显「资料需修改…」等 wxml 显隐）：stage-3 E2E 补
  });

  it("R15-OCR 入口门控: receiptOcr falsy → isReceiptOcrEnabled false（OCR 面板保守隐藏）", async () => {
    // 层级：pure（utils/feature-flags.js）+ manifest 声明
    const { isReceiptOcrEnabled } = await loadSrc("utils/feature-flags.js");
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(isReceiptOcrEnabled(null), false, "publicConfig 未到达 → 面板整体不渲染");
    assert.equal(isReceiptOcrEnabled({ features: {} }), false);
    assert.equal(isReceiptOcrEnabled({ features: { receiptOcr: 1 } }), false, "非严格 true → false");
    assert.equal(isReceiptOcrEnabled({ features: { receiptOcr: true } }), true);
    assert.deepEqual(manifest.featureFlags.receiptOcr, { flag: "features.receiptOcr", pages: ["dishes"] });
    // 页面编排（关闭时小票上传/删除/手工填菜完全不受影响）：stage-3 E2E 补
  });

  it("R16-OCR 开关动态同步: 每次调用按传入 publicConfig 重新求值（配置晚到可补显）", async () => {
    // 层级：pure（utils/feature-flags.js 无模块级缓存，页面生命周期重挂的前提）
    const { isReceiptOcrEnabled } = await loadSrc("utils/feature-flags.js");
    assert.equal(isReceiptOcrEnabled(null), false, "配置未到达：保守隐藏");
    assert.equal(isReceiptOcrEnabled({ features: { receiptOcr: true } }), true, "配置晚到：补显面板");
    assert.equal(isReceiptOcrEnabled({ features: { receiptOcr: false } }), false, "配置中途关闭：隐藏");
    // 页面编排（onLoad 与每次 onShow 重挂 syncOcrEntry、仅值变化才 setData）：stage-3 E2E 补
  });

  it("R33-分类动态下发与兜底: getDraft 空骨架兜底字段齐全（服务端数据缺失时的回落基座）", async () => {
    // 层级：pure（store/survey.js getDraft 空骨架字段，主控钉定断言点）
    await seedSession();
    const surveyStore = await loadSrc("store/survey.js");
    const meta = { assignmentId: "assignment-sample-1", attemptId: "attempt-sample-1", questionnaireVersionId: "qv-sample-1", revision: 0 };
    assert.deepEqual(
      surveyStore.getDraft(meta),
      {
        answers: {},
        dishes: [],
        highlight: "",
        suggestion: "",
        highlights: [],
        receiptRecovery: { pendingReceipts: [], jobId: null, applyKey: null, appliedJobId: null },
        revision: 0,
      },
      "无草稿时返回完整空骨架（answers/dishes/highlight/suggestion/highlights/receiptRecovery/revision）",
    );
    // 分类回落固定三分类（环境卫生/为客服务/产品品质）与非法路由分类回落到第一分类：页面编排，stage-3 E2E 补
  });
});

describe("service 层：stub fetch 驱动服务函数", () => {
  it("R04-Bearer 头注入: 有 accessToken 注入 Authorization，无则三个 JSON 头之外不带", async () => {
    // 层级：service（services/assignments.js → adapters/http.js）
    const session = await loadSrc("store/session.js");
    assert.equal(session.getSession(), null);
    stubJson(ASSIGNMENT_SAMPLE);
    const assignments = await loadSrc("services/assignments.js");
    await assignments.getAssignment("assignment-noauth-1");
    const anonymousCall = callsOf()[0];
    assert.equal(anonymousCall.headers.get("authorization"), null, "无 accessToken 不得注入 Authorization");
    assert.equal(anonymousCall.headers.get("accept"), "application/json");
    assert.equal(anonymousCall.headers.get("content-type"), "application/json");
    session.saveSession(SAMPLE_SESSION);
    await assignments.getAssignment("assignment-auth-1");
    const authorizedCall = callsOf()[1]; // PM 裁决 2026-10-10：第二次请求在同 mock 上为索引 1（原 [0] 与匿名断言矛盾）
    assert.equal(authorizedCall.headers.get("authorization"), "Bearer sample-token", "有 accessToken 注入 Bearer 头");
    assert.equal(authorizedCall.headers.get("accept"), "application/json");
    assert.equal(authorizedCall.headers.get("content-type"), "application/json");
    // uploadToSignedTarget 直传不注入该头（凭证由签名参数携带）：services/uploads 契约测试覆盖
  });

  it("R05-401 统一登出: 任意请求 401 → kind session 固定文案 + 会话清空（getSession null）", async () => {
    // 层级：service（presentError 401 分支 + 清会话链）
    await seedSession();
    stubJson({ error: { code: "AUTH_INVALID" } }, 401);
    const assignments = await loadSrc("services/assignments.js");
    await assert.rejects(
      assignments.getAssignment("assignment-sample-1"),
      { name: "BusinessError", kind: "session", message: "登录已失效，请重新登录", retryable: false },
    );
    const session = await loadSrc("store/session.js");
    assert.equal(session.getSession(), null, "401 必须清空本地会话");
    // 清草稿索引与任务缓存、跳登录页的完整链路见 R10 与 router/guards 契约测试
  });

  it("R06-登录成功流转: login 成功持久化会话且 getSession 返回登录响应", async () => {
    // 层级：service（services/auth.js login）
    stubJson(SAMPLE_SESSION);
    const auth = await loadSrc("services/auth.js");
    const result = await auth.login({ username: "sample-user", password: "sample-password" });
    assert.deepEqual(result, SAMPLE_SESSION, "登录响应原样返回");
    const [call] = callsOf();
    assert.equal(call.pathname, endpointRegistry.auth.login.pattern);
    assert.equal(call.method, endpointRegistry.auth.login.method);
    assert.deepEqual(call.body, { username: "sample-user", password: "sample-password" });
    const session = await loadSrc("store/session.js");
    assert.deepEqual(session.getSession(), SAMPLE_SESSION, "登录成功必须 saveSession 持久化会话");
    // approved_active → redirectTo 定位说明页 / 非 approved_active → 账号状态步：页面编排，stage-3 E2E 补
  });

  it("R08-退出登录: 接口失败（finally 语义）仍清空会话", async () => {
    // 层级：service（services/auth.js logout try/finally）
    await seedSession();
    stubJson({ error: { code: "SERVICE_DOWN" } }, 500);
    const auth = await loadSrc("services/auth.js");
    await assert.rejects(
      auth.logout(),
      { name: "BusinessError", kind: "service", message: "服务暂时不可用，请稍后重试" },
      "接口失败以业务错误上抛",
    );
    assert.equal(callsOf()[0].pathname, endpointRegistry.auth.logout.pattern);
    const session = await loadSrc("store/session.js");
    assert.equal(session.getSession(), null, "logout 接口失败也必须清空会话（finally）");
    // 确认弹窗、loggingOut 防重复点击、finally reLaunch 登录页：页面编排，stage-3 E2E 补
  });

  it("R10-任务缓存失效时机: 登录/退出/401 三处之后 getMyAssignments 重新 fetch（mock 计数）", async () => {
    // 层级：service（services/auth.js 与 services/assignments.js 的缓存清空联动）
    let mode = "mine";
    fetchMock = vi.fn(async () => {
      if (mode === "login") return new Response(JSON.stringify(SAMPLE_SESSION), { status: 200 });
      if (mode === "logout") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (mode === "unauthorized") return new Response(JSON.stringify({ error: { code: "AUTH_INVALID" } }), { status: 401 });
      return new Response(JSON.stringify(SAMPLE_MINE), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const session = await loadSrc("store/session.js");
    const assignments = await loadSrc("services/assignments.js");
    const auth = await loadSrc("services/auth.js");

    await seedSession();
    await assignments.getMyAssignments();
    await assignments.getMyAssignments();
    assert.equal(fetchMock.mock.calls.length, 1, "TTL 内命中缓存不重复请求");

    mode = "login";
    await auth.login({ username: "sample-user", password: "sample-password" });
    mode = "mine";
    await assignments.getMyAssignments();
    assert.equal(fetchMock.mock.calls.length, 3, "登录成功必须清空任务缓存（重新 fetch）");

    mode = "logout";
    await auth.logout();
    mode = "mine";
    await seedSession();
    await assignments.getMyAssignments();
    assert.equal(fetchMock.mock.calls.length, 5, "退出登录必须清空任务缓存（重新 fetch）");

    mode = "unauthorized";
    await assert.rejects(assignments.getMyAssignments({ force: true }), { kind: "session" }, "401 触发统一登出");
    assert.equal(session.getSession(), null, "401 清空会话");
    mode = "mine";
    await seedSession();
    await assignments.getMyAssignments();
    assert.equal(fetchMock.mock.calls.length, 7, "401 清会话时必须同时清空任务缓存（重新 fetch）");
  });

  it("R11-请求并发去重: 同 dedupeKey 并发调用复用同一 Promise，仅一次 fetch", async () => {
    // 层级：service（adapters/http.js pending Map，缺省键 method:url）
    await seedSession();
    let releaseFetch;
    fetchMock = vi.fn(
      () => new Promise((resolve) => { releaseFetch = resolve; }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const assignments = await loadSrc("services/assignments.js");
    const first = assignments.getAssignment("assignment-dedupe-1");
    const second = assignments.getAssignment("assignment-dedupe-1");
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    assert.equal(fetchMock.mock.calls.length, 1, "进行中的同 key 请求必须合并为一次网络调用");
    releaseFetch(new Response(JSON.stringify({ id: "assignment-dedupe-1", status: "assigned" }), { status: 200 }));
    const [left, right] = await Promise.all([first, second]);
    assert.deepEqual(left, { id: "assignment-dedupe-1", status: "assigned" });
    assert.equal(right, left, "并发调用共享同一 Promise 结果");
  });

  it("R12-公共配置拉取与重试: 非 200/非对象/网络失败 → null，200 对象原样返回且无 Bearer", async () => {
    // 层级：service（services/public-config.js loadPublicConfig）
    await seedSession();
    const config = await loadSrc("services/public-config.js");
    stubJson({ captchaAppId: null, features: {} }, 503);
    assert.equal(await config.loadPublicConfig(), null, "非 200 → resolve(null)，不抛错");
    fetchMock = vi.fn(async () => new Response(JSON.stringify("sample-config"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    assert.equal(await config.loadPublicConfig(), null, "响应非对象 → null");
    fetchMock = vi.fn(async () => { throw new Error("network down"); });
    vi.stubGlobal("fetch", fetchMock);
    assert.equal(await config.loadPublicConfig(), null, "网络失败 → null");
    const sampleConfig = { captchaAppId: "sample-app-id", features: { authSelfService: true, receiptOcr: true } };
    stubJson(sampleConfig);
    assert.deepEqual(await config.loadPublicConfig(), sampleConfig, "200 且为对象时原样写入/返回");
    const [call] = callsOf();
    assert.equal(call.pathname, endpointRegistry.public.clientConfig.pattern);
    assert.equal(call.method, endpointRegistry.public.clientConfig.method);
    assert.equal(call.headers.get("authorization"), null, "公共配置为无 Bearer 直连");
    // 登录页发现 captchaAppId 缺失自动重拉一次、失败进「行为验证暂不可用」可重试终态：页面编排，stage-3 E2E 补
  });

  it("R14-自助服务端点休眠: 自助端点 503（服务未配置）→ kind service retryable", async () => {
    // 层级：service（presentError ≥500 分支承载端点休眠语义）
    stubJson({ error: { code: "SMS_NOT_CONFIGURED" } }, 503);
    const auth = await loadSrc("services/auth.js");
    await assert.rejects(
      auth.requestRegisterCode({ phone: "13800000000", captchaTicket: "sample-ticket", captchaRandstr: "sample-randstr" }),
      { name: "BusinessError", kind: "service", message: "服务暂时不可用，请稍后重试", retryable: true },
      "休眠端点的 503 必须落到可重试的 service 业务错误",
    );
    assert.equal(callsOf()[0].pathname, endpointRegistry.auth.registerPhoneCode.pattern);
    // 开关关闭时客户端不提供任何可触达自助端点的 UI 路径（R13 门控）+ captchaAppId 允许为 null：页面编排，stage-3 E2E 补
  });

  it("R23-忘记密码三步流: 发码→验码换 token→重置 三端点顺序可达", async () => {
    // 层级：service（services/auth.js 三函数端点映射）
    const auth = await loadSrc("services/auth.js");
    stubJson({ phoneChallengeId: "sample-challenge-1", resendAfterSeconds: 60 });
    await auth.requestPasswordCode({ phone: "13800000000", captchaTicket: "sample-ticket", captchaRandstr: "sample-randstr" });
    assert.equal(callsOf()[0].pathname, endpointRegistry.auth.passwordCode.pattern, "第一步发码端点");
    assert.equal(callsOf()[0].method, "POST");
    stubJson({ resetToken: "sample-reset-token" });
    await auth.verifyPasswordCode({ phoneChallengeId: "sample-challenge-1", smsCode: "123456" });
    assert.equal(callsOf()[0].pathname, endpointRegistry.auth.passwordVerify.pattern, "第二步验码换 token 端点");
    stubJson({ ok: true });
    const resetPayload = { resetToken: "sample-reset-token", password: "sample-password-123", confirmPassword: "sample-password-123" };
    await auth.completePasswordReset(resetPayload);
    const [resetCall] = callsOf();
    assert.equal(resetCall.pathname, endpointRegistry.auth.passwordComplete.pattern, "第三步重置端点");
    assert.deepEqual(resetCall.body, resetPayload, "重置载荷固定 resetToken+password+confirmPassword");
    // 三步页面流转（sms 步掩码+倒计时提示、password 步、成功回登录清密码并 toast「密码已重置…」）：stage-3 E2E 补
  });

  it("R24-被拒注册重交流: resubmitRegistration 端点 POST /api/auth/registration/resubmit", async () => {
    // 层级：service（services/auth.js resubmitRegistration）
    const auth = await loadSrc("services/auth.js");
    stubJson({ ok: true });
    const payload = { phoneChallengeId: "sample-challenge-2", smsCode: "123456" };
    await auth.resubmitRegistration(payload);
    const [call] = callsOf();
    assert.equal(call.pathname, endpointRegistry.auth.registrationResubmit.pattern);
    assert.equal(call.method, endpointRegistry.auth.registrationResubmit.method);
    assert.deepEqual(call.body, payload, "重交载荷为 phoneChallengeId+smsCode");
    // registration_resubmit 专用验证码场景、复用注册发码端点、成功回 pending_approval 状态页：页面编排，stage-3 E2E 补
  });

  it("R26-签到判定在服务端: checkIn 发送坐标四字段 body，客户端不做半径判断", async () => {
    // 层级：service（services/assignments.js checkIn 的 body 形状即服务端判定契约）
    await seedSession();
    stubJson({ result: "accepted" });
    const assignments = await loadSrc("services/assignments.js");
    const result = await assignments.checkIn("assignment-sample-1", SAMPLE_CHECK_IN);
    assert.deepEqual(result, { result: "accepted" });
    const [call] = callsOf();
    assert.equal(call.pathname, endpointRegistry.assignments.checkIn.path("assignment-sample-1"));
    assert.equal(call.method, endpointRegistry.assignments.checkIn.method);
    assert.deepEqual(
      Object.keys(call.body).sort(),
      ["accuracy", "capturedAt", "latitude", "longitude"],
      "打卡样本恰为 latitude/longitude/accuracy/capturedAt 四字段，半径判定完全在服务端",
    );
    // 四态拒绝文案映射（outside_radius/stale/low_accuracy/rejected → 固定中文提示）与非 accepted 不推进：页面编排，stage-3 E2E 补
  });

  it("R27-开始流程阶段机: startAssignment 端点 POST /api/assignments/:id/start", async () => {
    // 层级：service（services/assignments.js startAssignment）
    await seedSession();
    stubJson(START_SAMPLE);
    const assignments = await loadSrc("services/assignments.js");
    const result = await assignments.startAssignment("assignment-sample-1");
    assert.deepEqual(result, START_SAMPLE);
    const [call] = callsOf();
    assert.equal(call.pathname, endpointRegistry.assignments.start.path("assignment-sample-1"));
    assert.equal(call.method, endpointRegistry.assignments.start.method);
    // 阶段机 locating→checking_in→starting→navigating、活动阶段禁重入、failed 可重试、成功 redirectTo 问卷携 4 参：页面编排，stage-3 E2E 补
  });

  it("R28-不可开始的任务状态: startAssignment 409 TASK_OVERDUE → kind conflict + 后端文案与 requiresNewToken 透传", async () => {
    // 层级：service（presentError 409 分支承载不可开始态的服务端拒绝）
    await seedSession();
    stubJson({ error: { code: "TASK_OVERDUE", message: "任务已逾期，请等待管理员延期后刷新任务", requiresNewToken: true } }, 409);
    const assignments = await loadSrc("services/assignments.js");
    await assert.rejects(
      assignments.startAssignment("assignment-sample-1"),
      {
        name: "BusinessError",
        kind: "conflict",
        message: "任务已逾期，请等待管理员延期后刷新任务",
        requiresNewToken: true,
      },
      "后端文案与 requiresNewToken 必须原样透出",
    );
    // submitted/overdue/cancelled/overt 四态的页面只读块渲染与开始动作前置拦截：页面编排，stage-3 E2E 补
  });

  it("R30-任务详情加载: getAssignment 与 getQuestionnaire 端点可达（详情与问卷数据源）", async () => {
    // 层级：service（services/assignments.js 两个读取端点）
    await seedSession();
    const assignments = await loadSrc("services/assignments.js");
    stubJson(ASSIGNMENT_SAMPLE);
    assert.deepEqual(await assignments.getAssignment("assignment-sample-1"), ASSIGNMENT_SAMPLE);
    assert.equal(callsOf()[0].pathname, endpointRegistry.assignments.byId.path("assignment-sample-1"));
    stubJson(QUESTIONNAIRE_SAMPLE);
    assert.deepEqual(await assignments.getQuestionnaire("assignment-sample-1"), QUESTIONNAIRE_SAMPLE);
    assert.equal(callsOf()[0].pathname, endpointRegistry.assignments.questionnaire.path("assignment-sample-1"));
    // 无 id 阻断「未找到对应任务…」、800ms 慢加载提示、卸载防护、缺失字段安全归一：页面编排，stage-3 E2E 补
  });

  it("R31-问卷已提交终态拦截: getDraft 409 QUESTIONNAIRE_SUBMITTED → kind questionnaire_submitted 固定文案", async () => {
    // 层级：service（presentError QUESTIONNAIRE_SUBMITTED 分支）
    await seedSession();
    stubJson({ error: { code: "QUESTIONNAIRE_SUBMITTED" } }, 409);
    const drafts = await loadSrc("services/drafts.js");
    await assert.rejects(
      drafts.getDraft("attempt-sample-1"),
      { name: "BusinessError", kind: "questionnaire_submitted", message: "任务已提交，小票不可再查看或修改" },
      "已提交终态必须以专用 kind 拦截，不落普通失败",
    );
    // toast「该任务已提交，不能回看问卷内容」+ redirectTo 任务详情不渲染内容：页面编排，stage-3 E2E 补
  });
});

describe("adapter 层：平台适配器语义", () => {
  it("R17-验证码票据获取守卫: adapter 非函数→captcha 兜底文案；空 ticket→未完成文案；成功→{ticket, randstr}", async () => {
    // 层级：adapter（services/captcha.js obtainCaptchaTicket(scene, adapter) 双参签名，契约 §3.7）
    const { obtainCaptchaTicket } = await loadSrc("services/captcha.js");
    await assert.rejects(
      obtainCaptchaTicket("register", undefined),
      { name: "BusinessError", kind: "captcha", message: "行为验证服务暂时不可用，请稍后重试" },
      "adapter 非函数（宿主缺失/加载失败）→ captcha 兜底",
    );
    await assert.rejects(
      obtainCaptchaTicket("register", async () => ({ ticket: "", randstr: "sample-randstr" })),
      { name: "BusinessError", kind: "captcha", message: "行为验证未完成，请重试" },
      "空字符串票据 → 未完成文案",
    );
    await assert.rejects(
      obtainCaptchaTicket("password_reset", async () => ({ ticket: null })),
      { name: "BusinessError", kind: "captcha", message: "行为验证未完成，请重试" },
      "非字符串票据 → 未完成文案",
    );
    assert.deepEqual(
      await obtainCaptchaTicket("register", async () => ({ ticket: "sample-ticket", randstr: "sample-randstr" })),
      { ticket: "sample-ticket", randstr: "sample-randstr" },
    );
    assert.deepEqual(
      await obtainCaptchaTicket("registration_resubmit", async () => ({ ticket: "sample-ticket" })),
      { ticket: "sample-ticket", randstr: "" },
      "randstr 缺省归一为空串（客户端绝不自造票据）",
    );
  });

  it("R25-定位采集语义: getCurrentLocation 返回 GCJ02 {latitude, longitude, accuracy}，失败 reject", async () => {
    // 层级：adapter（adapters/location.js；等价 wx.getLocation({type:"gcj02", isHighAccuracy:true})）
    const { getCurrentLocation } = await loadSrc("adapters/location.js");
    const rawWgs84 = { latitude: 31.2304, longitude: 121.4737, accuracy: 25 };
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition: (onSuccess) => onSuccess({ coords: rawWgs84 }) },
    });
    const sampleLocation = await getCurrentLocation();
    for (const key of ["latitude", "longitude", "accuracy"]) {
      assert.equal(typeof sampleLocation[key], "number", `返回结构必须含数值型 ${key}`);
    }
    assert.notEqual(
      sampleLocation.longitude,
      rawWgs84.longitude,
      "坐标必须经 WGS84→GCJ02 转换（上海点位必有偏移），不得原样透传浏览器 WGS84",
    );
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition: (onSuccess, onError) => onError(new Error("permission denied")) },
    });
    await assert.rejects(getCurrentLocation(), undefined, "定位失败/拒绝必须 reject（页面层转 blocked 态）");
    // highAccuracyExpireTime 与 capturedAt 组装发生在任务开始页面层：页面编排，stage-3 E2E 补
  });
});

describe("manifest 层：页面编排规则以 app-manifest.js 声明兜底", () => {
  it("R07-登录后账号状态展示: login 页声明为账号状态步承载页", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "login"), true);
    // 页面编排（pending_approval「申请正在审核中」/rejected「注册申请未通过」+rejectedReason/其他「账号已停用」+「返回登录」按钮）：stage-3 E2E 补
  });

  it("R18-验证码宿主异常转业务错误: captcha 服务与 login 页声明就绪", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.deepEqual(manifest.services.captcha, { module: "services/captcha.js", functions: ["obtainCaptchaTicket"] });
    assert.equal(manifest.pages.some((page) => page.name === "login"), true, "验证码宿主桥注册于登录页");
    // 页面编排（组件缺失「行为验证组件暂未就绪…」/ret!==0 或空票「验证未通过，请重试」/关闭 captcha_cancel「已取消行为验证…」/error「行为验证加载失败…」/卸载必 reject 不 pending）：stage-3 E2E 补
  });

  it("R19-登录表单本地校验: auth.login 服务声明（空账号不发请求为页面编排）", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.ok(manifest.services.auth.functions.includes("login"), "登录链必须声明 login");
    // 页面编排（username trim 空/密码空 → toast「请完整填写账号信息」，不发请求、不进 pending）：stage-3 E2E 补
  });

  it("R20-注册表单本地校验: 注册发码与注册服务声明（手机号/密码本地校验为页面编排）", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.ok(manifest.services.auth.functions.includes("requestRegisterCode"), "注册发码必须声明");
    assert.ok(manifest.services.auth.functions.includes("register"), "注册提交必须声明");
    // 页面编排（/^1\d{10}$/ 否则「请输入正确的手机号」；密码 <10 或两次不一致否则「密码至少 10 个字符…」；命中不发请求）：stage-3 E2E 补
  });

  it("R21-短信验证码格式校验: 三个 sms 确认链服务声明（6 位数字校验为页面编排）", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    for (const fn of ["register", "verifyPasswordCode", "resubmitRegistration"]) {
      assert.ok(manifest.services.auth.functions.includes(fn), `sms 确认链必须声明 ${fn}`);
    }
    // 页面编排（注册确认/找回验码/重交确认的 smsCode 不匹配 /^\d{6}$/ → toast「请输入 6 位短信验证码」且不发请求）：stage-3 E2E 补
  });

  it("R22-验证码重发倒计时: 两条发码链服务声明（resendAfterSeconds 倒计时为页面编排）", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    for (const fn of ["requestRegisterCode", "requestPasswordCode"]) {
      assert.ok(manifest.services.auth.functions.includes(fn), `重发链必须声明 ${fn}`);
    }
    // 页面编排（resendAfterSeconds 缺省 60 逐秒递减、countdown>0 忽略重发、归零后重发清 smsCode/challengeId 回表单步重走人机验证+发码）：stage-3 E2E 补
  });

  it("R29-继续填写入口: task/survey 页声明承载继续填写链路", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "task"), true, "继续填写入口在任务详情页");
    assert.equal(manifest.pages.some((page) => page.name === "survey"), true, "落点为问卷页");
    // 页面编排（attempt.id 存在渲染「继续填写」、携 questionnaireVersionId/revision 直进问卷跳过打卡、navigating 防重）：stage-3 E2E 补
  });

  it("R32-问卷路由一致性校验: survey 页声明承载路由参数校验", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "survey"), true);
    // 页面编排（缺 assignmentId/attemptId/questionnaireVersionId 任一阻断「未找到问卷…」；attempt.id/版本与路由不符报「问卷信息已更新…」；revision 缺省按 0）：stage-3 E2E 补
  });
});
