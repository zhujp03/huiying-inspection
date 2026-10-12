// T3d3 规则册测试（TDD 红灯基线）：R67–R99 共 33 条，断言语义唯一来源 docs/web/rules.md，
// 模块契约依据 docs/web/module-contracts.md，模块加载一律经 tests/helpers/contract-paths.js 的 loadSrc()。
//
// 断言层级阶梯（每个 it 上方注释标明层级）：
//   pure    —— features / utils 纯逻辑，不经网络；
//   service —— vi.stubGlobal("fetch", ...) 打桩后驱动 services/** 服务函数；
//   manifest —— 页面编排规则以 app-manifest.js 声明兜底，页面行为断言留待 stage-3 E2E 补（it 内注释标注）。
//
// 加载纪律：loadSrc 一律放在每个 it 体内（钩子里的失败会被归并吞掉逐用例报错）。
// URL 断言口径：零域名（R0）——fetch 第一参字符串逐字等于 /api 开头的同源相对路径，不做 new URL 解析。
// 测试数据统一命名 sample*；响应样例均满足 contracts.generated.js 校验器（第 2 段实现后 validate 放行）。
//
// TDD 红灯基线：apps/web/src/** 尚未实现，本文件全部用例预期因模块不存在（Cannot find module）失败——这是预期，不是缺陷。
import { describe, it, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { loadSrc } from "../helpers/contract-paths.js";
import { endpointRegistry } from "../../../../packages/contracts/endpoint-registry.js";

// R87 的超时分支依赖适配层 12s 超时驱动；放宽本文件用例窗口以兼容不同超时实现（正常路径毫秒级完成）。
vi.setConfig({ testTimeout: 30_000 });

const ATTEMPT_ID = "attempt-sample-1";
const ATTACHMENT_ID = "receipt-sample-1";
const JOB_ID = "ocr-job-sample-1";
const SAMPLE_SUBMIT_PAYLOAD = { submitToken: "sample-submit-token-1", assignmentRevision: 5, confirmation: true };
// 响应体满足 assertQuestionnaire（attempt.id+非负整数 revision+questionnaireVersion.id+questions 数组+answers 对象）。
const QUESTIONNAIRE_DRAFT_SAMPLE = {
  attempt: { id: ATTEMPT_ID, status: "draft", revision: 2 },
  questionnaireVersion: { id: "qv-sample-1" },
  questions: [],
  answers: {},
};

let fetchMock;

const stubJson = (body, status = 200) => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
};

// 兼容 fetch(url) 与 fetch(url, init) 两种调用形态，逐次解析请求参数（URL 断言见 assertRequestUrl）。
const callOf = (callIndex = 0) => {
  const [, init] = fetchMock.mock.calls[callIndex];
  return {
    method: String(init?.method ?? "GET").toUpperCase(),
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
  };
};

// 零域名口径：fetch 第一参必须是字符串，且逐字等于期望的同源相对路径（不解析、不拼基址）。
const assertRequestUrl = (expectedPath, callIndex = 0) => {
  const raw = fetchMock.mock.calls[callIndex]?.[0];
  assert.equal(typeof raw, "string", "零域名：fetch 第一参必须是同源相对路径字符串");
  assert.equal(String(raw), expectedPath, "零域名：请求地址必须逐字等于 /api 开头的同源相对路径");
};

// 用本地时区构造时间，避免时区漂移（2026-08-11 是周二）。
const localIso = (y, m, d, h, min) => new Date(y, m - 1, d, h, min).toISOString();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pure 层：features / utils 规则", () => {
  it("R69-OCR 轮询退避: nextPollDelay 按 1s/2s/3s 递进并在 5s 封顶", async () => {
    // 层级：pure（features/receipt-ocr.js nextPollDelay）
    const { nextPollDelay } = await loadSrc("features/receipt-ocr.js");
    assert.deepEqual([0, 1, 2, 3].map(nextPollDelay), [1000, 2000, 3000, 5000], "前四次轮询 1s/2s/3s/5s");
    assert.equal(nextPollDelay(4), 5000, "attempt 超出序列后封顶 5 秒");
    assert.equal(nextPollDelay(99), 5000, "超大 attempt 封顶 5 秒");
    assert.equal(nextPollDelay(-1), 1000, "负值钳制回 1 秒");
    // 页面编排（onHide/onUnload 清定时器暂停轮询、onShow 恢复、pageVisible=false 时回调直接返回）：stage-3 E2E 补
  });

  it("R70-OCR 只应用一次与必点保护: appliedJobIds 幂等跳过；必点缺失/改名 throw 保护文案且不落数据", async () => {
    // 层级：pure（features/receipt-ocr.js applyOcrDishesOnce）
    const { applyOcrDishesOnce } = await loadSrc("features/receipt-ocr.js");
    const requiredRow = { id: "row-required", requirementId: "requirement-1", plannedName: "招牌菜" };
    const incomingDishes = [{ ...requiredRow, actualName: "招牌菜", quantity: 1 }];
    const first = applyOcrDishesOnce({ dishes: [requiredRow], appliedJobIds: [] }, "sample-job-1", incomingDishes);
    assert.equal(first.applied, true, "首次应用成功");
    assert.deepEqual(first.appliedJobIds, ["sample-job-1"], "成功应用登记 appliedJobIds");
    assert.deepEqual(first.dishes, incomingDishes, "应用后以识别结果整体替换行数据");
    const replay = applyOcrDishesOnce(first, "sample-job-1", [{ ...requiredRow, actualName: "重复应用" }]);
    assert.equal(replay.applied, false, "同一 jobId 重复应用直接跳过（applied=false）");
    assert.deepEqual(replay.dishes, incomingDishes, "重复应用不改变 dishes");
    assert.deepEqual(replay.appliedJobIds, ["sample-job-1"], "重复应用不追加登记");
    assert.throws(
      () => applyOcrDishesOnce({ dishes: [requiredRow], appliedJobIds: [] }, "sample-job-2", []),
      /菜品要求已更新，请刷新后重试/,
      "识别结果缺必点行必须抛保护错误",
    );
    assert.throws(
      () => applyOcrDishesOnce({ dishes: [requiredRow], appliedJobIds: [] }, "sample-job-2", [{ ...requiredRow, plannedName: "另一道菜" }]),
      /菜品要求已更新，请刷新后重试/,
      "必点行改名必须抛保护错误",
    );
    // 应用成功后以服务端返回 revision 推进、编辑 OCR 行置 manuallyModified：页面编排，stage-3 E2E 补
  });

  it("R71-OCR 状态文案映射: 各任务状态给出固定 label/tone/terminal", async () => {
    // 层级：pure（features/receipt-ocr.js ocrStatusView）
    const { ocrStatusView } = await loadSrc("features/receipt-ocr.js");
    assert.deepEqual(ocrStatusView(null), { label: "尚未识别", tone: "idle", terminal: true }, "无任务为空闲态");
    assert.deepEqual(ocrStatusView({ status: "queued" }), { label: "正在排队识别", tone: "working", terminal: false });
    assert.deepEqual(ocrStatusView({ status: "processing" }), { label: "正在识别小票", tone: "working", terminal: false });
    assert.deepEqual(ocrStatusView({ status: "succeeded", recognizedDishCount: 3 }), { label: "已识别 3 道菜", tone: "success", terminal: true });
    assert.deepEqual(ocrStatusView({ status: "partial", recognizedDishCount: 2 }), { label: "已带入 2 道菜，请核对标记内容", tone: "review", terminal: true });
    assert.deepEqual(
      ocrStatusView({ status: "failed" }),
      { label: "暂时无法识别这张小票，您仍可以手动填写菜品", tone: "failed", terminal: true },
      "failed 固定文案同时进入 ocrError 展示",
    );
    assert.deepEqual(
      ocrStatusView({ status: "anything-else" }),
      { label: "暂时无法识别这张小票，您仍可以手动填写菜品", tone: "failed", terminal: true },
      "未知状态一律按失败兜底",
    );
    // 页面编排（failed 后按钮文案变「重新识别」）：stage-3 E2E 补
  });

  it("R86-错误码→文案映射总表: presentError 按优先级逐码产出 kind/文案/标志", async () => {
    // 层级：pure（utils/errors.js presentError，按 rules.md 优先级逐码走一遍；
    // 与 tests/pure/errors.test.js 侧重不同：这里按规则语义验证优先级次序与标志透传）
    const { presentError } = await loadSrc("utils/errors.js");
    const assertMapping = (error, kind, message, { retryable = false, requiresNewToken = false } = {}) => {
      assert.equal(error.name, "BusinessError");
      assert.equal(error.kind, kind);
      assert.equal(error.message, message);
      assert.equal(error.retryable, retryable, `retryable 应为 ${retryable}`);
      assert.equal(error.requiresNewToken, requiresNewToken, `requiresNewToken 应为 ${requiresNewToken}`);
    };
    // [payload, statusCode, kind, message, flags]——顺序即 rules.md 优先级表自上而下。
    const branchMatrix = [
      [{ error: { code: "SMS_CODE_INVALIDATED" } }, 422, "sms_invalidated", "验证码已失效，请重新发送并完成人机验证", {}],
      [{ error: { code: "SMS_CODE_ATTEMPTS_EXHAUSTED" } }, 409, "sms_invalidated", "验证码已失效，请重新发送并完成人机验证", {}],
      [{ error: { code: "QUESTIONNAIRE_SUBMITTED", message: "该任务已提交，不能回看问卷内容" } }, 409, "questionnaire_submitted", "任务已提交，小票不可再查看或修改", {}],
      [{ error: { code: "CAPTCHA_EXPIRED" } }, 400, "captcha_rejected", "验证已过期，请重新验证", {}],
      [{ error: { code: "CAPTCHA_REJECTED" } }, 400, "captcha_rejected", "验证未通过，请重新验证", {}],
      [{ error: { code: "CAPTCHA_CANCELLED" } }, 400, "captcha_rejected", "验证未通过，请重新验证", {}],
      [{ error: { code: "TOKEN_EXPIRED" } }, 401, "session", "登录已失效，请重新登录", {}],
      [{}, 403, "forbidden", "你没有权限进行此操作", {}],
      [{ error: { message: "任务已逾期，请等待管理员延期后刷新任务", requiresNewToken: true } }, 409, "conflict", "任务已逾期，请等待管理员延期后刷新任务", { requiresNewToken: true }],
      [{ error: {} }, 409, "conflict", "内容已更新，请刷新后重试", {}],
      [{}, 503, "service", "服务暂时不可用，请稍后重试", { retryable: true }],
      [{ error: { code: "RECEIPT_LIMIT_EXCEEDED" } }, 422, "validation", "最多只能上传 9 张消费小票", {}],
      [{ error: { code: "RECEIPT_FILE_INVALID" } }, 400, "validation", "请选择 10MB 以内的图片", {}],
      [{ error: { code: "SOMETHING_ELSE" } }, 422, "validation", "操作未完成，请检查填写内容", {}],
    ];
    for (const [payload, statusCode, kind, message, flags] of branchMatrix) {
      assertMapping(presentError(statusCode, payload), kind, message, flags);
    }
    // 优先级次序证明：码判断先于状态码——SMS_* 以 409/422 返回仍映射 sms_invalidated；
    // QUESTIONNAIRE_SUBMITTED 以 409 返回落 questionnaire_submitted 而非 conflict；
    // 状态码 ≥500 分支先于小票码分支（rules.md R86 表序：第 8 行在前）。
    assertMapping(presentError(500, { error: { code: "RECEIPT_LIMIT_EXCEEDED" } }), "service", "服务暂时不可用，请稍后重试", { retryable: true });
    // 另两处非映射错误：契约校验失败（本文件 R88 用例）与网络失败（本文件 R87 用例）。
  });

  it("R90-日期时间安全展示: 无效值一律「时间待确认」，不出现 Invalid Date", async () => {
    // 层级：pure（utils/presentation.js safeDate 与各格式化降级）
    const { safeDate, formatDateHeading, formatTimeRange, formatSubmittedAt } = await loadSrc("utils/presentation.js");
    for (const bad of [null, undefined, "", "not-a-date"]) {
      assert.equal(safeDate(bad), null, "safeDate 对无效输入返回 null（统一入口）");
    }
    assert.equal(formatDateHeading("bad"), "时间待确认");
    assert.equal(formatTimeRange(null, localIso(2026, 8, 11, 20, 0)), "时间待确认");
    assert.equal(formatSubmittedAt(undefined), "时间待确认");
    for (const rendered of [formatDateHeading("bad"), formatTimeRange("x", "y"), formatSubmittedAt(null)]) {
      assert.equal(rendered.includes("Invalid Date"), false, "任何展示路径不得出现 Invalid Date");
    }
    assert.equal(formatDateHeading(localIso(2026, 8, 11, 19, 32)), "8月11日 周二", "日期标题形如「N月N日 周X」");
    assert.equal(formatTimeRange(localIso(2026, 8, 11, 19, 32), localIso(2026, 8, 11, 20, 3)), "19:32–20:03", "同天区间 HH:MM–HH:MM");
    assert.equal(formatTimeRange(localIso(2026, 8, 11, 19, 32), ""), "19:32 起", "结束缺失为 HH:MM 起");
    assert.equal(formatTimeRange(localIso(2026, 8, 11, 23, 0), localIso(2026, 8, 12, 0, 30)), "23:00 开始", "跨天为 HH:MM 开始（截止日由 displayDueDate 单独展示）");
    assert.equal(formatSubmittedAt(localIso(2026, 8, 11, 19, 32)), "8月11日 周二 19:32", "提交时间形如「N月N日 周X HH:MM」");
  });

  it("R91-预算展示: 非正整数/0/缺失为「未设置」，否则「¥x.xx」两位小数", async () => {
    // 层级：pure（utils/presentation.js formatBudgetLabel）
    const { formatBudgetLabel } = await loadSrc("utils/presentation.js");
    for (const cents of [0, -100, null, undefined, NaN, 12.5]) {
      assert.equal(formatBudgetLabel(cents), "未设置", `分值 ${cents} 必须展示「未设置」`);
    }
    assert.equal(formatBudgetLabel(1234), "¥12.34", "分转元两位小数");
    assert.equal(formatBudgetLabel(105), "¥1.05", "分位为零补零");
    assert.equal(formatBudgetLabel(10000), "¥100.00", "整元补零两位");
  });

  it("R92-任务状态展示映射: 五态固定映射+未知态「状态待确认」兜底，taskType 暗访/明察", async () => {
    // 层级：pure（utils/presentation.js mapAssignmentStatus/taskTypeText）
    const { mapAssignmentStatus, taskTypeText } = await loadSrc("utils/presentation.js");
    assert.deepEqual(mapAssignmentStatus("assigned"), { statusText: "待开始", statusTone: "primary", actionText: "查看任务" });
    assert.deepEqual(mapAssignmentStatus("in_progress"), { statusText: "进行中", statusTone: "dark", actionText: "继续填写" });
    assert.deepEqual(mapAssignmentStatus("overdue"), { statusText: "已逾期", statusTone: "warning", actionText: "查看详情" });
    assert.deepEqual(mapAssignmentStatus("submitted"), { statusText: "已提交", statusTone: "neutral", actionText: "查看状态" });
    assert.deepEqual(mapAssignmentStatus("cancelled"), { statusText: "已取消", statusTone: "muted", actionText: "查看详情" });
    assert.deepEqual(
      mapAssignmentStatus("unknown-state"),
      { statusText: "状态待确认", statusTone: "muted", actionText: "查看详情", isActionable: true },
      "未知状态兜底且 isActionable=true",
    );
    assert.equal(taskTypeText("secret"), "暗访");
    assert.equal(taskTypeText("overt"), "明察");
    assert.equal(taskTypeText("vip"), "", "其他类型为空串");
  });

  it("R93-任务列表投影与分组: 展示字段集中生成（原始 ISO 不外泄）、按 displayDate 稳定分组", async () => {
    // 层级：pure（utils/presentation.js projectAssignmentForDisplay/groupAssignmentsByDate）
    const { projectAssignmentForDisplay, groupAssignmentsByDate } = await loadSrc("utils/presentation.js");
    const sampleAssignment = {
      id: "assignment-view-1", storeName: "sample-store", name: "sample-task", taskType: "secret", status: "assigned",
      startsAt: localIso(2026, 8, 11, 19, 0), dueAt: localIso(2026, 8, 11, 20, 0),
    };
    const view = projectAssignmentForDisplay(sampleAssignment);
    assert.equal(view.storeName, "sample-store", "字段齐全时原样投影");
    assert.equal(projectAssignmentForDisplay({ ...sampleAssignment, storeName: "" }).storeName, "门店待确认", "门店缺失兜底");
    assert.equal(projectAssignmentForDisplay({ ...sampleAssignment, name: "" }).name, "任务待确认", "任务名缺失兜底");
    assert.equal(projectAssignmentForDisplay({ ...sampleAssignment, taskType: "" }).taskTypeText, "任务", "类型为空兜底「任务」");
    const crossDay = projectAssignmentForDisplay({ ...sampleAssignment, startsAt: localIso(2026, 8, 11, 23, 0), dueAt: localIso(2026, 8, 12, 1, 0) });
    assert.equal(crossDay.displayDueDate, "8月12日 周三", "跨天任务单独展示截止日");
    assert.equal(JSON.stringify(view).includes("startsAt"), false, "原始 ISO 字段不得进入视图层");
    for (const status of ["assigned", "in_progress", "overdue", "submitted", "cancelled"]) {
      assert.equal(projectAssignmentForDisplay({ ...sampleAssignment, status }).isActionable, true, `${status} 五态可进入详情`);
    }
    assert.equal(projectAssignmentForDisplay({ ...sampleAssignment, status: "weird" }).isActionable, false, "未知状态不可进入详情");
    const groups = groupAssignmentsByDate([
      { ...sampleAssignment, id: "a", startsAt: localIso(2026, 8, 11, 19, 0), dueAt: localIso(2026, 8, 11, 20, 0) },
      { ...sampleAssignment, id: "b", startsAt: localIso(2026, 8, 12, 9, 0), dueAt: localIso(2026, 8, 12, 10, 0) },
      { ...sampleAssignment, id: "c", startsAt: localIso(2026, 8, 11, 21, 0), dueAt: localIso(2026, 8, 11, 22, 0) },
    ]);
    assert.deepEqual(groups.map((group) => group.dateHeading), ["8月11日 周二", "8月12日 周三"], "按 displayDate 分组且保持服务端顺序");
    assert.deepEqual(groups[0].items.map((item) => item.id), ["a", "c"], "同组内保持原顺序");
  });
});

describe("service 层：stub fetch 驱动服务函数", () => {
  it("R67-已提交后小票面板锁定: 小票列表 409 QUESTIONNAIRE_SUBMITTED → kind questionnaire_submitted 固定文案且不可重试", async () => {
    // 层级：service（services/receipts.js listReceiptAttachments → presentError 固定文案，后端 message 不透传）
    const receipts = await loadSrc("services/receipts.js");
    stubJson({ error: { code: "QUESTIONNAIRE_SUBMITTED", message: "该任务已提交，不能回看问卷内容" } }, 409);
    await assert.rejects(
      receipts.listReceiptAttachments(ATTEMPT_ID),
      { name: "BusinessError", kind: "questionnaire_submitted", message: "任务已提交，小票不可再查看或修改", retryable: false },
      "固定文案不取后端 message；页面据此置 receiptLocked=true 且不再渲染「重试」",
    );
    assertRequestUrl(endpointRegistry.drafts.receiptAttachments.path(ATTEMPT_ID));
    // 页面编排（锁定面板、此后该 attempt 小票不可再查看/上传/删除）：stage-3 E2E 补
  });

  it("R68-OCR 任务创建与恢复: createReceiptOcrJob POST body {attachmentIds,idempotencyKey,revision}；getReceiptOcrJob GET 恢复通道", async () => {
    // 层级：service（services/receipts.js OCR 创建/查询两端点）
    const receipts = await loadSrc("services/receipts.js");
    stubJson({ id: JOB_ID, status: "queued" });
    await receipts.createReceiptOcrJob(ATTEMPT_ID, [ATTACHMENT_ID], "sample-ocr-idempotency-key", 5);
    assertRequestUrl(endpointRegistry.drafts.receiptOcrJobs.path(ATTEMPT_ID));
    assert.equal(callOf().method, "POST");
    assert.deepEqual(callOf().body, { attachmentIds: [ATTACHMENT_ID], idempotencyKey: "sample-ocr-idempotency-key", revision: 5 }, "创建载荷固定三字段");
    stubJson({ id: JOB_ID, status: "processing" });
    await receipts.getReceiptOcrJob(ATTEMPT_ID, JOB_ID);
    assertRequestUrl(endpointRegistry.drafts.receiptOcrJob.path(ATTEMPT_ID, JOB_ID)); // PM 裁决 2026-10-10：stubJson 重建 mock，GET 恢复请求在新 mock 上为索引 0（原索引 1 与 R78/R46 单发语义矛盾）
    assert.equal(callOf().method, "GET", "恢复/轮询走查询端点");
    // 页面编排（secureUuid 一次性幂等键、恢复元数据 {jobId,applyKey,appliedJobId} 随草稿持久化、重进自动 resumeOcr）：stage-3 E2E 补
  });

  it("R75-菜品保存与 revision 推进: saveDishes PUT 端点、body {dishes,revision}、服务端 revision 透传供推进", async () => {
    // 层级：service（services/drafts.js saveDishes；saving 互斥与先本地后服务端为页面编排）
    const drafts = await loadSrc("services/drafts.js");
    stubJson({ revision: 4 });
    const sampleDishes = [{ id: "dish-sample-1", actualName: "sample-dish", fulfillmentStatus: "ordered", quantity: 1, evaluation: "ok" }];
    const payload = { dishes: sampleDishes, revision: 3 };
    assert.deepEqual(await drafts.saveDishes(ATTEMPT_ID, payload), { revision: 4 }, "响应含服务端 revision，页面据以推进");
    assertRequestUrl(endpointRegistry.drafts.dishes.path(ATTEMPT_ID));
    assert.equal(callOf().method, "PUT");
    assert.deepEqual(callOf().body, payload);
    // 页面编排（saving 互斥、先存本地草稿再调服务端、失败不清脏）：stage-3 E2E 补
  });

  it("R77-其他记录加载: saveOtherRecords PUT 端点与 body 透传（加载编排的服务底座）", async () => {
    // 层级：service（services/drafts.js saveOtherRecords；本地优先/failed 提示/初始 draft 为页面编排）
    const drafts = await loadSrc("services/drafts.js");
    stubJson({ revision: 5 });
    const sampleRecords = { highlight: "sample-highlight", suggestion: "sample-suggestion", revision: 4 };
    assert.deepEqual(await drafts.saveOtherRecords(ATTEMPT_ID, sampleRecords), { revision: 5 });
    assertRequestUrl(endpointRegistry.drafts.otherRecords.path(ATTEMPT_ID));
    assert.equal(callOf().method, "PUT");
    assert.deepEqual(callOf().body, sampleRecords);
    // 页面编排（synced=false 本地 highlight/suggestion 优先、failed 提示「上次提交未完成…」仍进编辑、提交状态固定初始 draft）：stage-3 E2E 补
  });

  it("R78-编辑重置提交状态: token 更换后 dedupeKey 随之变化（新 token 必然重新发请求）", async () => {
    // 层级：service（submitQuestionnaire dedupeKey 含 submitToken：token 重置语义的可断言底座）
    const drafts = await loadSrc("services/drafts.js");
    stubJson({ status: "submitted" });
    await drafts.submitQuestionnaire(ATTEMPT_ID, { submitToken: "sample-submit-token-1", assignmentRevision: 5, confirmation: true });
    await drafts.submitQuestionnaire(ATTEMPT_ID, { submitToken: "sample-submit-token-2", assignmentRevision: 5, confirmation: true });
    assert.equal(fetchMock.mock.calls.length, 2, "token 更换 → dedupeKey 变化，两次提交各自发出、不被合并");
    assert.equal(callOf(1).body.submitToken, "sample-submit-token-2", "第二次提交携带更换后的新 token");
    assertRequestUrl(endpointRegistry.drafts.submit.path(ATTEMPT_ID), 1);
    // 页面编排（retryable_failed/terminal_failed 态编辑任一输入 → submitToken 置 null 回 draft、编辑 highlight 清字段错误与页面消息）：stage-3 E2E 补
  });

  it("R79-提交幂等 token: submitQuestionnaire POST 端点，dedupeKey 含 submitToken（同 token 并发仅一次 fetch）", async () => {
    // 层级：service（同 token 重试复用同一 dedupeKey；载荷固定三字段）
    const drafts = await loadSrc("services/drafts.js");
    let releaseFetch;
    fetchMock = vi.fn(() => new Promise((resolve) => { releaseFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const first = drafts.submitQuestionnaire(ATTEMPT_ID, SAMPLE_SUBMIT_PAYLOAD);
    const second = drafts.submitQuestionnaire(ATTEMPT_ID, SAMPLE_SUBMIT_PAYLOAD);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    assert.equal(fetchMock.mock.calls.length, 1, "可重试失败后的重试复用同一 token：并发合并为一次网络调用");
    releaseFetch(new Response(JSON.stringify({ status: "processing" }), { status: 200 }));
    const [left, right] = await Promise.all([first, second]);
    assert.equal(right, left, "并发调用共享同一 Promise 结果");
    assertRequestUrl(endpointRegistry.drafts.submit.path(ATTEMPT_ID));
    assert.deepEqual(callOf().body, SAMPLE_SUBMIT_PAYLOAD, "提交载荷固定 {submitToken, assignmentRevision, confirmation:true}");
    assert.deepEqual(callOf().method, "POST");
    // secureUuid 生成失败提示「当前环境不支持安全提交…」：页面编排，stage-3 E2E 补
  });

  it("R81-提交 processing 轮询: 200 {status:processing} 原样透传供页面续轮询；409 SUBMIT_PROCESSING → kind conflict 文案透传", async () => {
    // 层级：service（submitQuestionnaire 响应/错误透传；2500ms 同 token 轮询为页面编排）
    const drafts = await loadSrc("services/drafts.js");
    stubJson({ status: "processing" });
    assert.deepEqual(
      await drafts.submitQuestionnaire(ATTEMPT_ID, SAMPLE_SUBMIT_PAYLOAD),
      { status: "processing" },
      "processing 中间态必须原样透传，页面据以 2500ms 用同一 token 续询",
    );
    stubJson({ error: { code: "SUBMIT_PROCESSING", message: "提交正在处理中，请稍后重试", retryable: true } }, 409);
    await assert.rejects(
      drafts.submitQuestionnaire(ATTEMPT_ID, SAMPLE_SUBMIT_PAYLOAD),
      { name: "BusinessError", kind: "conflict", message: "提交正在处理中，请稍后重试", retryable: true, requiresNewToken: false },
      "409 通道布尔透传 retryable/requiresNewToken（本批次 T2 修订，2026-10-11），页面据此保 token 进 retryable_failed，同 token 续试",
    );
    assertRequestUrl(endpointRegistry.drafts.submit.path(ATTEMPT_ID)); // PM 裁决 2026-10-10：stubJson 重建 mock，第二次提交在新 mock 上为索引 0（原索引 1 与 R78/R46 单发语义矛盾）
    // 页面编排（processing 置态+提示、2500ms 定时器同 token 重发、终态停止轮询、locked 禁用提交与返回）：stage-3 E2E 补
  });

  it("R82-提交失败二分: retryable=true 上抛（页面保 token）；非 retryable 上抛（页面清 token）", async () => {
    // 层级：service（提交错误的 retryable 标志透传，页面二分的唯一依据）
    const drafts = await loadSrc("services/drafts.js");
    stubJson({ error: { code: "SERVICE_DOWN" } }, 500);
    await assert.rejects(
      drafts.submitQuestionnaire(ATTEMPT_ID, SAMPLE_SUBMIT_PAYLOAD),
      { name: "BusinessError", kind: "service", message: "服务暂时不可用，请稍后重试", retryable: true },
      "网络/超时/5xx 类可重试失败：页面据此保 token 进 retryable_failed",
    );
    stubJson({ error: { code: "SUBMIT_INCOMPLETE", message: "请完成全部问卷题目后再提交" } }, 422);
    await assert.rejects(
      drafts.submitQuestionnaire(ATTEMPT_ID, SAMPLE_SUBMIT_PAYLOAD),
      { name: "BusinessError", kind: "validation", message: "操作未完成，请检查填写内容", retryable: false },
      "不可重试失败：页面据此清 token 进 terminal_failed",
    );
    // 页面编排（retryable 消息拼「，可以重试提交」+「重试提交」按钮、终态消息为错误文案）：stage-3 E2E 补
  });

  it("R83-failed attempt 双保险恢复: 重开草稿重新拉取 getDraft 端点（failed 由服务端同事务重置回 draft）", async () => {
    // 层级：service（getDraft 恢复通道；failed→draft 重置在服务端完成，客户端按普通草稿进入编辑）
    const drafts = await loadSrc("services/drafts.js");
    stubJson(QUESTIONNAIRE_DRAFT_SAMPLE);
    assert.deepEqual(await drafts.getDraft(ATTEMPT_ID), QUESTIONNAIRE_DRAFT_SAMPLE, "重新拉取草稿即恢复数据");
    assertRequestUrl(endpointRegistry.drafts.byId.path(ATTEMPT_ID));
    assert.equal(callOf().method, "GET");
    // 页面编排（failed 打开即回 draft 可编辑态、提示「上次提交未完成…」、再次提交与 draft 完全同路径生成新 token）：stage-3 E2E 补
  });

  it("R84-409 冲突透传: kind conflict、文案取后端 error.message、requiresNewToken 布尔透传", async () => {
    // 层级：service（presentError 409 分支经提交链透传；页面现已读取 requiresNewToken 进入 refresh_required 分支——
    // 清 token 并提供「刷新」动作换新提交（本批次 T2 修订，2026-10-11），不再是「归入不可重试分支」）
    const drafts = await loadSrc("services/drafts.js");
    stubJson({ error: { code: "TASK_OVERDUE", message: "问卷已过最终截止时间，请等待管理员延期后刷新任务", requiresNewToken: true } }, 409);
    await assert.rejects(
      drafts.submitQuestionnaire(ATTEMPT_ID, SAMPLE_SUBMIT_PAYLOAD),
      { name: "BusinessError", kind: "conflict", message: "问卷已过最终截止时间，请等待管理员延期后刷新任务", requiresNewToken: true, retryable: false },
      "后端文案原样透出、requiresNewToken 原样携带（页面据此清 token 进 refresh_required，错误条提供手动「刷新」动作）",
    );
    assertRequestUrl(endpointRegistry.drafts.submit.path(ATTEMPT_ID));
  });

  it("R85-提交成功清理: 提交成功响应原样透传（页面据以清草稿并展示成功终态）", async () => {
    // 层级：service（submitQuestionnaire 成功通道，含幂等回放）
    const drafts = await loadSrc("services/drafts.js");
    stubJson({ status: "submitted" });
    assert.deepEqual(await drafts.submitQuestionnaire(ATTEMPT_ID, SAMPLE_SUBMIT_PAYLOAD), { status: "submitted" }, "成功响应原样透传");
    assertRequestUrl(endpointRegistry.drafts.submit.path(ATTEMPT_ID));
    // 页面编排（成功后 clearDraft 清本地草稿键、清脏、状态置 submitted、成功终态页+「确定」跳日程、onUnload 不再持久化）：stage-3 E2E 补
  });

  it("R87-网络错误二分类: 超时→kind timeout、其他失败→kind network，文案与 retryable 固定", async () => {
    // 层级：service（adapters/http.js 网络失败分类，经 services/assignments.js 驱动；
    // wx errMsg timeout 语义在 H5 由请求层 12s 超时（TIMEOUT_MS）承载）
    const assignments = await loadSrc("services/assignments.js");
    fetchMock = vi.fn(async () => { throw new TypeError("fetch failed"); });
    vi.stubGlobal("fetch", fetchMock);
    await assert.rejects(
      assignments.getAssignment("assignment-net-1"),
      { name: "BusinessError", kind: "network", message: "暂时无法连接服务，请检查网络后重试", retryable: true },
      "断网/连接失败 → kind network 且可重试",
    );
    try {
      vi.useFakeTimers();
      fetchMock = vi.fn((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));
      }));
      vi.stubGlobal("fetch", fetchMock);
      const expectation = assert.rejects(
        assignments.getAssignment("assignment-timeout-1"),
        { name: "BusinessError", kind: "timeout", message: "请求超时，请检查网络后重试", retryable: true },
        "12 秒超时（TIMEOUT_MS）→ kind timeout 且可重试",
      );
      await vi.advanceTimersByTimeAsync(12_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("R88-契约校验失败兜底: 2xx 响应不合契约 → kind contract 固定文案", async () => {
    // 层级：service（assertSubmit 要求 string status；返回 {status:123} 必须转为 contract 兜底而非透传）
    const drafts = await loadSrc("services/drafts.js");
    stubJson({ status: 123 });
    await assert.rejects(
      drafts.submitQuestionnaire(ATTEMPT_ID, SAMPLE_SUBMIT_PAYLOAD),
      { name: "BusinessError", kind: "contract", message: "服务返回的数据暂时无法使用，请稍后重试", retryable: false },
      "validate 抛错必须转换为固定 contract 兜底文案",
    );
  });
});

describe("manifest 层：页面编排规则以 app-manifest.js 声明兜底", () => {
  it("R72-菜品页离开持久化: dishes 页声明承载离开持久化链路", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "dishes"), true);
    // 页面编排（onHide/onUnload persistLocal 存 dishes 序列化态+脱敏 receiptRecovery 剔除 uploadTarget、onUnload 仅 dirty/待传/恢复 jobId 才写、存储异常静默吞掉、foldOpen 不入草稿）：stage-3 E2E 补
  });

  it("R73-菜品页下一步校验顺序: dishes 页声明承载五道校验链", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "dishes"), true);
    // 页面编排（receiptRequired 小票不足→待传未完成→reviewFields 未核对→amountError→逐行 validateDish，固定顺序短路、全过才保存跳转）：stage-3 E2E 补
  });

  it("R74-菜品页返回答题守卫: dishes 页声明承载返回链路与空白额外菜品拦截", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "dishes"), true);
    // 页面编排（isBlankExtraDish 命中阻断并标错「请补全这道额外菜品…」、通过后走保存、栈可返回 navigateBack 否则 redirectTo 问卷带 category=product）：stage-3 E2E 补
  });

  it("R76-attempt 提交中终态关闭: dishes/other 页声明承载终态拦截", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "dishes"), true, "菜品页承载 submitting/processing/submitted 拦截");
    assert.equal(manifest.pages.some((page) => page.name === "other"), true, "其他记录页承载同语义拦截");
    // 页面编排（toast「该问卷已关闭编辑」/「该任务已提交」或「问卷正在提交」并 redirectTo 任务详情，不进入编辑）：stage-3 E2E 补
  });

  it("R80-提交确认与闪光点必填: other 页声明承载提交确认链", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "other"), true);
    // 页面编排（闪光点 trim 空 → 字段错误+聚焦+滚动不提交；通过后先存其他记录再弹确认框，确认才提交；重试路径跳过校验与弹窗）：stage-3 E2E 补
  });

  it("R89-页面侧技术信息过滤: dishes 页声明承载 safeMessage 过滤（首页/日程页同语义兜底）", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "dishes"), true, "safeMessage 过滤部署于菜品页");
    assert.equal(manifest.pages.some((page) => page.name === "home"), true, "首页承载无 kind 异常兜底文案");
    assert.equal(manifest.pages.some((page) => page.name === "schedule"), true, "日程页承载无 kind 异常兜底文案");
    // 页面编排（含 /api/、http 状态、token、revision、stack、provider、request id 等技术词的错误换兜底文案，其余原样展示）：stage-3 E2E 补
  });

  it("R94-首页下一任务与草稿进度: home 页声明承载下一任务与草稿进度编排", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "home"), true);
    // 页面编排（候选仅 assigned/in_progress、in_progress 先于 assigned、同级按 dueAt 升序取第一；
    // 草稿进度前置条件 hasAttempt+attempt+questionnaireVersion 三者齐备且 revision 匹配的本地草稿 answers 非空；
    // 统计卡固定 assigned/in_progress/overdue 三计数；失败文案分流与已有内容非阻塞条）：stage-3 E2E 补
  });

  it("R95-日程页筛选与加载降级: schedule 页声明承载本地筛选与降级", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "schedule"), true);
    // 页面编排（chips「全部」+计数>0 状态段、纯本地过滤、重复点击忽略、下拉刷新 force 跳缓存、有旧内容错误不阻塞、navigatingId 防重）：stage-3 E2E 补
  });

  it("R96-定位说明页: location 页声明承载定位成功/失败分支", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "location"), true);
    // 页面编排（固定用途声明文案；成功 → locationStatus=ready+「定位可用…」+仅「查看我的任务」；失败 → blocked+「未能获取位置…」+「打开设置」与「重新定位」）：stage-3 E2E 补
  });

  it("R97-个人资料页: profile 页声明承载状态映射与退出链", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "profile"), true);
    // 页面编排（displayName 缺失→「探店员」、头像字首字符大写缺失→「探」、四态+未知状态映射、「账号安全」永久隐藏、退出确认见 R08）：stage-3 E2E 补
  });

  it("R98-应用结构与验证码插件: 11 页面、3 Tab、captcha 域注册", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.deepEqual(
      manifest.pages.map((page) => page.name),
      ["login", "location", "home", "schedule", "profile", "task", "survey", "issue", "dishes", "other", "help"],
      "页面注册恰为 11 个且顺序与 app.json 一致",
    );
    assert.deepEqual(manifest.tabs, ["home", "schedule", "profile"], "Tab 栏 3 个（首页/日程/我的）");
    assert.deepEqual(
      manifest.services.captcha,
      { module: "services/captcha.js", functions: ["obtainCaptchaTicket"] },
      "验证码域注册（等价小程序插件 captcha 链）",
    );
    // 页面编排（scope.userLocation 用途声明与 requiredPrivateInfos → 浏览器 Geolocation 授权、插件版本 captcha@2.1.4 → runtime 配置、自定义导航/下拉刷新声明）：stage-3 E2E 补
  });

  it("R99-录音/播放单例: issue 页声明承载录音与播放链", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "issue"), true);
    // 页面编排（RecorderManager 全局单例、onStop 只在首次使用注册一次、播放单例卸载 destroy 置空、无 path 且无 previewUrl 点击无效）：stage-3 E2E 补
  });
});
