// T3d2 规则册测试（TDD 红灯基线）：R34–R66 共 33 条，断言语义唯一来源 docs/web/rules.md，
// 模块契约依据 docs/web/module-contracts.md，模块加载一律经 tests/helpers/contract-paths.js 的 loadSrc()。
//
// 断言层级阶梯（每个 it 上方注释标明层级）：
//   pure    —— store / utils / features 纯逻辑，不经网络；
//   service —— vi.stubGlobal("fetch", ...) 打桩后驱动 services/** 服务函数；
//   adapter —— uploadToSignedTarget 运输层行为（预签名 URL 为服务端下发运行时数据，R0 例外）；
//   manifest —— 页面编排规则以 app-manifest.js 声明兜底，页面行为断言留待 stage-3 E2E 补（it 内注释标注）。
// 测试数据统一命名 sample*；服务 URL 断言为零域名口径：String(fetch 第 1 参) 逐字等于同源相对路径。
//
// TDD 红灯基线：apps/web/src/** 尚未实现，本文件全部用例预期因模块不存在（Cannot find module）失败——这是预期，不是缺陷。
import { describe, it, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { loadSrc } from "../helpers/contract-paths.js";
import { endpointRegistry } from "../../../../packages/contracts/endpoint-registry.js";

// ---------- 公共样例与打桩基建 ----------
const SAMPLE_SESSION = { accessToken: "sample-token", user: { id: "user-t3d2", status: "approved_active" } };
const RECEIPT_FILE_META = { clientFileId: "cf-rc-1", fileName: "sample-receipt.jpg", mimeType: "image/jpeg", sizeBytes: 2048 };
const EVIDENCE_PAYLOAD = { clientFileId: "cf-ev-1", type: "image", mimeType: "image/png", sizeBytes: 4096 };

const presignedTargetSample = () => ({
  url: "https://storage.sample.local/presigned/sample-object",
  method: "POST",
  fileFieldName: "file",
  formData: { key: "sample-object" },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const sampleImageFile = () => new File(["sample-evidence-bytes"], "sample-evidence.png", { type: "image/png" });
const sampleReceiptFile = () => new File(["sample-receipt-bytes"], "sample-receipt.jpg", { type: "image/jpeg" });

let fetchMock;

const stubJson = (body, status = 200) => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
};

const stubFetch = (implementation) => {
  fetchMock = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchMock);
};

// 零域名口径（R0）：URL 断言直接比较 fetch 第 1 参字符串与同源相对路径，不做任何 base 拼接。
const callUrl = (index) => String(fetchMock.mock.calls[index][0]);
const callMethod = (index) => String(fetchMock.mock.calls[index][1]?.method ?? "GET").toUpperCase();
const callBody = (index) => JSON.parse(fetchMock.mock.calls[index][1].body);

const seedSession = async () => {
  (await loadSrc("store/session.js")).saveSession(SAMPLE_SESSION);
};

afterEach(async () => {
  vi.unstubAllGlobals();
  try {
    (await loadSrc("store/session.js")).clearSessionAndUserCache();
  } catch (error) {
    if (!/Cannot find module|ERR_MODULE_NOT_FOUND|Failed to load url/.test(String(error?.message ?? error))) throw error;
  }
});

// ---------- pure 层 ----------
describe("pure 层：store / utils / features 规则", () => {
  it("R34-本地草稿作用域隔离: 任一作用域要素（含 userId）缺失抛 DRAFT_SCOPE_MISSING 且不落盘", async () => {
    // 层级：pure（store/survey.js identity）
    const surveyStore = await loadSrc("store/survey.js");
    const storage = await loadSrc("adapters/storage.js");
    const scopedMeta = { assignmentId: "as-r34", attemptId: "at-r34", questionnaireVersionId: "qv-r34", revision: 1 };
    // 未登录：userId 取 getSession()?.user?.id 为空 → 缺参
    assert.throws(() => surveyStore.getDraft(scopedMeta), { message: "DRAFT_SCOPE_MISSING" }, "无 userId 读取抛 DRAFT_SCOPE_MISSING");
    assert.throws(() => surveyStore.saveDraft(scopedMeta, { answers: {} }), { message: "DRAFT_SCOPE_MISSING" }, "无 userId 保存抛 DRAFT_SCOPE_MISSING");
    assert.throws(() => surveyStore.peekDraft(scopedMeta), { message: "DRAFT_SCOPE_MISSING" });
    assert.throws(() => surveyStore.clearDraft(scopedMeta), { message: "DRAFT_SCOPE_MISSING" });
    // 已登录但缺其余三元组任一段
    await seedSession();
    assert.throws(() => surveyStore.saveDraft({ attemptId: "at-r34", questionnaireVersionId: "qv-r34", revision: 1 }, {}), { message: "DRAFT_SCOPE_MISSING" }, "缺 assignmentId 抛错");
    assert.throws(() => surveyStore.saveDraft({ assignmentId: "as-r34", questionnaireVersionId: "qv-r34", revision: 1 }, {}), { message: "DRAFT_SCOPE_MISSING" }, "缺 attemptId 抛错");
    assert.throws(() => surveyStore.saveDraft({ assignmentId: "as-r34", attemptId: "at-r34", revision: 1 }, {}), { message: "DRAFT_SCOPE_MISSING" }, "缺 questionnaireVersionId 抛错");
    // 缺参时不落盘：草稿索引与会话键之外不得出现任何草稿键
    assert.equal(storage.readStorage("junde:draft-index"), null, "缺参报错不得登记草稿索引");
    assert.equal(storage.readStorage("junde:session")?.user?.id, "user-t3d2", "会话键不受影响");
  });

  it("R34-本地草稿作用域隔离: 键为四元组 encodeURIComponent 拼接，saveDraft 合并 patch 强制 synced=false 记 savedAt 并登记草稿索引，不同 userId 互不可见", async () => {
    // 层级：pure（store/survey.js saveDraft + store/session.js registerDraftKey + adapters/storage）
    const session = await loadSrc("store/session.js");
    const surveyStore = await loadSrc("store/survey.js");
    const storage = await loadSrc("adapters/storage.js");
    await seedSession();
    const meta = { assignmentId: "as/34", attemptId: "at 34", questionnaireVersionId: "qv?34", revision: 7 };
    const saved = surveyStore.saveDraft(meta, { answers: { q1: { answer: "scored", remark: "" } } });
    assert.equal(saved.synced, false, "保存即置未同步");
    const expectedKey = `junde:survey:${encodeURIComponent("user-t3d2")}:${encodeURIComponent("as/34")}:${encodeURIComponent("at 34")}:${encodeURIComponent("qv?34")}`;
    const stored = storage.readStorage(expectedKey);
    assert.ok(stored, "草稿按四元组编码键落盘");
    assert.equal(stored.revision, 7);
    assert.equal(stored.synced, false);
    assert.equal(typeof stored.savedAt, "string", "记录 savedAt");
    assert.deepEqual(stored.answers, { q1: { answer: "scored", remark: "" } });
    assert.deepEqual(stored.dishes, [], "未提供的字段以空骨架合并");
    // patch 合并：再次保存保留旧字段
    surveyStore.saveDraft(meta, { suggestion: "建议改进" });
    const merged = storage.readStorage(expectedKey);
    assert.deepEqual(merged.answers, { q1: { answer: "scored", remark: "" } }, "合并保存不得清掉旧字段");
    assert.equal(merged.suggestion, "建议改进");
    // 键登记进 junde:draft-index 当前 userId 的去重集合
    surveyStore.saveDraft(meta, { suggestion: "再改一次" });
    const index = storage.readStorage("junde:draft-index");
    assert.deepEqual(index["user-t3d2"], [expectedKey], "重复保存同一键必须去重登记");
    // 不同 userId 的草稿互不可见：键含 userId
    session.saveSession({ ...SAMPLE_SESSION, user: { id: "user-t3d2-b", status: "approved_active" } });
    const otherView = surveyStore.getDraft(meta);
    assert.deepEqual(otherView.answers, {}, "其他账号读不到该草稿（键隔离）");
    assert.deepEqual(otherView.dishes, []);
    storage.removeStorage(expectedKey);
    storage.removeStorage("junde:draft-index");
  });

  it("R34-本地草稿作用域隔离: getDraft 仅 revision 相等返回内容否则空骨架，peekDraft 不过滤 revision，markDraftSynced 推进 revision", async () => {
    // 层级：pure（store/survey.js getDraft/peekDraft/markDraftSynced）
    const surveyStore = await loadSrc("store/survey.js");
    const storage = await loadSrc("adapters/storage.js");
    await seedSession();
    const meta = { assignmentId: "as-r34b", attemptId: "at-r34b", questionnaireVersionId: "qv-r34b", revision: 2 };
    surveyStore.saveDraft(meta, { highlight: "高亮样例" });
    // revision 不匹配 → 空骨架（answers={}、dishes=[]、highlight=""、suggestion=""、receiptRecovery 空壳、revision 同步）
    assert.deepEqual(
      surveyStore.getDraft({ ...meta, revision: 3 }),
      { answers: {}, dishes: [], highlight: "", suggestion: "", receiptRecovery: { pendingReceipts: [], jobId: null, applyKey: null, appliedJobId: null }, revision: 3 },
      "revision 不匹配返回空骨架",
    );
    // peekDraft 读原始值不做 revision 过滤
    const raw = surveyStore.peekDraft({ ...meta, revision: 3 });
    assert.equal(raw.highlight, "高亮样例", "peekDraft 绕过 revision 过滤");
    assert.equal(raw.revision, 2);
    assert.equal(raw.synced, false);
    // markDraftSynced 以新 revision 写 synced=true
    surveyStore.markDraftSynced(meta, 3);
    const synced = surveyStore.getDraft({ ...meta, revision: 3 });
    assert.equal(synced.synced, true, "同步标记后 getDraft 按 revision 3 放行");
    assert.equal(synced.revision, 3);
    assert.equal(synced.highlight, "高亮样例", "同步不清内容");
    // clearDraft 删键（revision 不参与键）
    surveyStore.clearDraft(meta);
    assert.equal(surveyStore.peekDraft(meta), null, "清除后 peek 返回 null");
    storage.removeStorage("junde:draft-index");
  });

  it("R35-草稿合并规则: 无本地草稿或 synced!==false → 直接采用服务端 answers、无冲突、无补发", async () => {
    // 层级：pure（store/survey-merge.js 分支 1）
    const { mergeSurveyAnswers } = await loadSrc("store/survey-merge.js");
    const serverAnswers = { q1: { answer: "scored", remark: "" } };
    assert.deepEqual(
      mergeSurveyAnswers({ serverAnswers, serverRevision: 5, rawLocal: null }),
      { answers: serverAnswers, conflict: false, pendingResync: [] },
      "无本地草稿 → 服务端为准",
    );
    assert.deepEqual(
      mergeSurveyAnswers({ serverAnswers, serverRevision: 5, rawLocal: { revision: 4, synced: true, answers: { q9: { answer: "scored", remark: "" } } } }),
      { answers: serverAnswers, conflict: false, pendingResync: [] },
      "已同步草稿不参与合并（synced!==false）",
    );
  });

  it("R35-草稿合并规则: 同 revision 且 synced=false → 本地覆盖同题（服务端空 {} 不清本地）+ pendingResync 为 scored 且不同的题（answer+remark 空串归一）", async () => {
    // 层级：pure（store/survey-merge.js 分支 2）
    const { mergeSurveyAnswers } = await loadSrc("store/survey-merge.js");
    const rawLocal = {
      revision: 5,
      synced: false,
      answers: {
        q1: { answer: "scored", remark: "" },
        q2: { answer: "scored", remark: "同文案" },
        q3: { answer: "unscored", remark: "本地问题说明" },
      },
    };
    const serverAnswers = {
      q1: { answer: "unscored", remark: "服务端说明" },
      q2: { answer: "scored" },
      q4: { answer: "scored", remark: "仅服务端" },
    };
    const merged = mergeSurveyAnswers({ serverAnswers, serverRevision: 5, rawLocal });
    assert.equal(merged.conflict, false);
    assert.deepEqual(merged.answers.q1, { answer: "scored", remark: "" }, "本地同题覆盖服务端");
    assert.deepEqual(merged.answers.q4, { answer: "scored", remark: "仅服务端" }, "服务端独有题保留");
    // q2 必须进入补发：服务端 {answer:"scored"} 缺 remark，按 answer+remark 比较与本地 {scored,"同文案"} 不同
    // （防后人误删：q2 在列是 remark 归一比较的直接结果，不是测试噪声）
    assert.deepEqual(merged.pendingResync, ["q1", "q2"], "补发列表只含本地 scored 且与服务端 answer+remark 不同的题");
    // 服务端空 {} 不能清掉本地待同步答案
    const mergedEmptyServer = mergeSurveyAnswers({ serverAnswers: {}, serverRevision: 5, rawLocal });
    assert.deepEqual(mergedEmptyServer.answers.q1, { answer: "scored", remark: "" }, "服务端空 answers 不清本地");
    assert.deepEqual(mergedEmptyServer.pendingResync, ["q1", "q2"], "服务端无记录时仅本地 scored 题待补发（q3 unscored 被 answer==='scored' 过滤，不入列表）");
    // answer 相同且 remark 空串归一相等 → 不补发（q2 服务端缺 remark 与本地 remark "同文案" 不同 → 补发；此处验证 remark 归一）
    const sameWithEmptyRemark = mergeSurveyAnswers({
      serverAnswers: { q1: { answer: "scored" } },
      serverRevision: 5,
      rawLocal: { revision: 5, synced: false, answers: { q1: { answer: "scored", remark: "" } } },
    });
    assert.deepEqual(sameWithEmptyRemark.pendingResync, [], "remark 空串归一后相同不补发");
  });

  it("R35-草稿合并规则: serverRevision 更大 → conflict 且不覆盖本地；本地 revision 更大 → 以本地为准无冲突", async () => {
    // 层级：pure（store/survey-merge.js 分支 3/4）
    const { mergeSurveyAnswers } = await loadSrc("store/survey-merge.js");
    const rawLocal = { revision: 5, synced: false, answers: { q1: { answer: "scored", remark: "本地" } } };
    const serverAnswers = { q1: { answer: "unscored", remark: "服务端" } };
    assert.deepEqual(
      mergeSurveyAnswers({ serverAnswers, serverRevision: 6, rawLocal }),
      { answers: serverAnswers, conflict: true, pendingResync: [] },
      "服务端 revision 前进 → 冲突，采用服务端展示、不覆盖本地存储",
    );
    const localNewer = mergeSurveyAnswers({ serverAnswers, serverRevision: 4, rawLocal });
    assert.equal(localNewer.conflict, false, "本地更新 → 无冲突");
    assert.deepEqual(localNewer.answers.q1, { answer: "scored", remark: "本地" }, "本地 revision 更大以本地为准");
    assert.deepEqual(localNewer.pendingResync, []);
  });

  it("R36-合并后逐题补发: 补发单题按 saveAnswer PUT {answer:'scored', revision} 调用，survey 页声明承载逐题循环", async () => {
    // 层级：service（services/drafts.js saveAnswer —— 补发循环体内的网络调用形状）+ manifest
    await seedSession();
    stubJson({ revision: 6 });
    const drafts = await loadSrc("services/drafts.js");
    await drafts.saveAnswer("at-r36", "q-r36-1", { answer: "scored", revision: 5 });
    assert.equal(callUrl(0), endpointRegistry.drafts.answer.path("at-r36", "q-r36-1"), "补发走保存答案端点（零域名相对路径）");
    assert.equal(callMethod(0), "PUT");
    assert.deepEqual(callBody(0), { answer: "scored", revision: 5 }, "补发载荷固定 scored + 当前 revision");
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "survey"), true, "survey 页承载逐题补发编排");
    // 页面编排（按 pendingResync 顺序逐题、单题成功仅推进 revision（advanceDraftRevision）、全部待补发清零才 markDraftSynced、显示「正在恢复未保存的答案…」、单题失败保留草稿下次再补、全清后清 syncMessage）：stage-3 E2E 补
  });

  it("R37-得分作答乐观更新: 本地先行（saveDraft 落盘 synced=false），成功后 markDraftSynced 推进 revision；回滚编排以 survey 页兜底", async () => {
    // 层级：pure（store/survey.js —— 乐观更新「先改本地后保存」的本地侧）+ manifest
    const surveyStore = await loadSrc("store/survey.js");
    const storage = await loadSrc("adapters/storage.js");
    await seedSession();
    const meta = { assignmentId: "as-r37", attemptId: "at-r37", questionnaireVersionId: "qv-r37", revision: 4 };
    // 点击「得分」：本地立即落盘该题答案（synced=false，服务端失败也不丢本地作答）
    surveyStore.saveDraft(meta, { answers: { q1: { answer: "scored", remark: "", attachments: [] } } });
    const pending = surveyStore.peekDraft(meta);
    assert.deepEqual(pending.answers.q1, { answer: "scored", remark: "", attachments: [] });
    assert.equal(pending.synced, false, "乐观更新本地先行：未同步标记");
    // 保存成功：revision 推进到服务端返回值并标记同步
    surveyStore.markDraftSynced({ ...meta, revision: 5 }, 5);
    const synced = surveyStore.peekDraft({ ...meta, revision: 5 });
    assert.equal(synced.synced, true);
    assert.equal(synced.revision, 5);
    assert.deepEqual(synced.answers.q1, { answer: "scored", remark: "", attachments: [] }, "失败回滚所需旧值/成功值均保存在本地草稿");
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "survey"), true, "survey 页承载乐观更新与失败回滚编排");
    storage.removeStorage(`junde:survey:${encodeURIComponent("user-t3d2")}:as-r37:at-r37:qv-r37`);
    storage.removeStorage("junde:draft-index");
    // 页面编排（显示「正在保存…」→ 成功「已保存」/ 失败恢复旧答案或删除该键 + toast 文案、onShow 重载）：stage-3 E2E 补
  });

  it("R40-进菜品页全题守卫: firstIncompleteQuestion 命中未作答/非法答案/空备注/缺必备证据，缺号兜底返回首题分类，全完成返回 undefined", async () => {
    // 层级：pure（utils/business.js firstIncompleteQuestion）
    const { firstIncompleteQuestion } = await loadSrc("utils/business.js");
    const question = (overrides = {}) => ({ id: `q-${overrides.number ?? 1}`, number: overrides.number ?? 1, category: "product", evidence: {}, ...overrides });
    const scoredAnswer = { answer: "scored", remark: "", attachments: [] };
    const imageActive = { type: "image", status: "active" };
    const imageRemoved = { type: "image", status: "active", pendingRemoval: true };
    const audioActive = { type: "audio", status: "active" };

    // 未作答
    assert.deepEqual(firstIncompleteQuestion([question()], {}), question(), "未作答命中第一题");
    // answer 不在 ["scored","unscored"]
    assert.deepEqual(firstIncompleteQuestion([question()], { "q-1": { answer: "scoring", remark: "" } }), question(), "非法答案枚举命中");
    // unscored 备注空白
    assert.deepEqual(
      firstIncompleteQuestion([question()], { "q-1": { answer: "unscored", remark: "   ", attachments: [] } }),
      question(),
      "unscored 备注 trim 空命中",
    );
    // unscored 备注齐但 imageRequired 无合格图（active 且未标移除）
    const imageQuestion = question({ evidence: { imageRequired: true, audioRequired: true } });
    assert.deepEqual(
      firstIncompleteQuestion([imageQuestion], { "q-1": { answer: "unscored", remark: "说明", attachments: [imageRemoved] } }),
      imageQuestion,
      "仅剩 pendingRemoval 图片不算合格证据",
    );
    assert.deepEqual(
      firstIncompleteQuestion([imageQuestion], { "q-1": { answer: "unscored", remark: "说明", attachments: [imageActive] } }),
      imageQuestion,
      "图片齐但 audioRequired 无音频仍命中",
    );
    assert.equal(
      firstIncompleteQuestion([imageQuestion], { "q-1": { answer: "unscored", remark: "说明", attachments: [imageActive, audioActive] } }),
      undefined,
      "备注与两类必备证据齐全放行",
    );
    // scored 无需备注与证据
    assert.equal(firstIncompleteQuestion([imageQuestion], { "q-1": scoredAnswer }), undefined, "scored 直接通过");
    // 缺号兜底：题号 1..maxNumber 缺口 → { number: 缺号, category: 第一道题的分类 }
    const gapQuestions = [
      question({ id: "q-a", number: 1, category: "environment" }),
      question({ id: "q-b", number: 2, category: "service" }),
      question({ id: "q-d", number: 4, category: "product" }),
    ];
    assert.deepEqual(
      firstIncompleteQuestion(gapQuestions, { "q-a": scoredAnswer, "q-b": scoredAnswer, "q-d": scoredAnswer }),
      { number: 3, category: "environment" },
      "缺号兜底返回缺口题号与第一道题分类",
    );
    // 全部完成 → undefined
    const completeQuestions = [question({ id: "q-a", number: 1, category: "environment" }), question({ id: "q-b", number: 2, category: "service" })];
    assert.equal(firstIncompleteQuestion(completeQuestions, { "q-a": scoredAnswer, "q-b": scoredAnswer }), undefined, "全部完成返回 undefined");
    // 页面编排（问卷页切换到该题分类 + toast「请先完成第 N 题」阻断进入、菜品页二次校验重定向回问卷带 category=product）：stage-3 E2E 补
  });

  it("R47-证据失败重试: 重试以 secureUuid 重新生成 clientFileId（每次新值、UUIDv4 形状），issue 页声明承载重试编排", async () => {
    // 层级：pure（utils/business.js secureUuid）+ manifest
    const { secureUuid } = await loadSrc("utils/business.js");
    const first = secureUuid();
    const second = secureUuid();
    assert.notEqual(first, second, "重试必须生成新的 clientFileId，不复用原值");
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    assert.match(first, uuidPattern, "必须是 UUIDv4 形状");
    assert.match(second, uuidPattern);
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "issue"), true, "issue 页承载失败项重试编排");
    // 页面编排（先从列表移除失败项、以原 type/path/size/duration 重走 R46 完整链路且不带原 clientFileId）：stage-3 E2E 补
  });

  it("R49-不得分保存必填校验: unscored 必填备注、imageRequired/audioRequired 须有 active 未移除证据（问卷侧同语义口径）", async () => {
    // 层级：pure（utils/business.js firstIncompleteQuestion —— rules.md 来源标注的问卷侧同语义 utils/business.js:34-42）
    const { firstIncompleteQuestion } = await loadSrc("utils/business.js");
    const question = { id: "q-r49", number: 1, category: "product", evidence: { imageRequired: true, audioRequired: true } };
    // unscored 说明 trim 空 → 阻断
    assert.deepEqual(firstIncompleteQuestion([question], { "q-r49": { answer: "unscored", remark: "", attachments: [] } }), question, "说明为空阻断保存");
    // imageRequired 无合格图片 → 阻断
    assert.deepEqual(
      firstIncompleteQuestion([question], { "q-r49": { answer: "unscored", remark: "说明", attachments: [] } }),
      question,
      "无问题照片阻断保存",
    );
    // audioRequired 无合格音频 → 阻断
    assert.deepEqual(
      firstIncompleteQuestion([question], { "q-r49": { answer: "unscored", remark: "说明", attachments: [{ type: "image", status: "active" }] } }),
      question,
      "无问题音频阻断保存",
    );
    // active 与 staged_ready 同为合格证据（此处以 active 判定，staged_ready 语义由页面状态机保证）
    assert.equal(
      firstIncompleteQuestion([question], {
        "q-r49": { answer: "unscored", remark: "说明", attachments: [{ type: "image", status: "active" }, { type: "audio", status: "active" }] },
      }),
      undefined,
      "证据齐备放行",
    );
    // 页面编排（issue 页保存侧「请先上传成功的问题照片/音频」「请等待附件上传完成」四条顺序校验与 target=scored 全跳过）：stage-3 E2E 补
  });

  it("R52-本地未同步菜品优先: synced=false 且有行时本地 dishes 为渲染数据源，服务端落盘后 markDraftSynced 置同步", async () => {
    // 层级：pure（store/survey.js —— dishes 页 useLocal 判定的数据源）
    const surveyStore = await loadSrc("store/survey.js");
    const storage = await loadSrc("adapters/storage.js");
    await seedSession();
    const meta = { assignmentId: "as-r52", attemptId: "at-r52", questionnaireVersionId: "qv-r52", revision: 2 };
    const localDishes = [{ id: "dish-local-1", fulfillmentStatus: "ordered", actualName: "本地未同步菜" }];
    surveyStore.saveDraft(meta, { dishes: localDishes });
    const local = surveyStore.getDraft(meta);
    assert.equal(local.synced, false, "本地未同步");
    assert.deepEqual(local.dishes, localDishes, "synced=false 且有行时以本地草稿菜品渲染（数据源为 getDraft 原值）");
    // 服务端 dishes 采纳后写本地并 markDraftSynced → 后续以同步态为准
    surveyStore.saveDraft(meta, { dishes: [{ id: "dish-server-1", fulfillmentStatus: "ordered", actualName: "服务端菜" }] });
    surveyStore.markDraftSynced(meta, meta.revision);
    assert.equal(surveyStore.peekDraft(meta).synced, true, "服务端落盘后置同步");
    assert.equal(surveyStore.peekDraft(meta).dishes[0].id, "dish-server-1");
    storage.removeStorage(`junde:survey:${encodeURIComponent("user-t3d2")}:as-r52:at-r52:qv-r52`);
    storage.removeStorage("junde:draft-index");
    // 页面编排（useLocal 判定、服务端无 dishes 时 dirty=true、待传小票恢复列表取 receiptRecovery.pendingReceipts 且仅保留含 localPath 项）：stage-3 E2E 补
  });

  it("R54-菜品字段校验: validateDish 九分支逐一命中固定文案，全通过返回空串", async () => {
    // 层级：pure（utils/business.js validateDish）
    const { validateDish } = await loadSrc("utils/business.js");
    const dish = (overrides = {}) => ({
      fulfillmentStatus: "ordered", required: false, allowSubstitution: true,
      actualName: "样例菜名", substitutionReason: "", unavailableReason: "",
      evaluation: "样例评价", fullySatisfied: false, requirementId: null,
      ...overrides,
    });
    // ① required 且 skipped
    assert.equal(validateDish(dish({ fulfillmentStatus: "skipped", required: true, actualName: "", evaluation: "" })), "必点菜品不能选择未点");
    // ② ordered 保留替代/售罄原因（trim 后非空才命中）
    assert.equal(validateDish(dish({ substitutionReason: " 换菜 " })), "已点菜品不能保留替代或售罄原因");
    assert.equal(validateDish(dish({ unavailableReason: "售罄" })), "已点菜品不能保留替代或售罄原因");
    assert.equal(validateDish(dish({ substitutionReason: "   " })), "", "纯空白原因 trim 后不算保留");
    // ③ substituted 且不允许替代
    assert.equal(validateDish(dish({ fulfillmentStatus: "substituted", allowSubstitution: false, substitutionReason: "替代" })), "该菜品不允许替代");
    // ④ substituted 缺替代菜名或原因
    assert.equal(validateDish(dish({ fulfillmentStatus: "substituted", actualName: " ", substitutionReason: "替代" })), "请填写替代菜名和替代原因");
    assert.equal(validateDish(dish({ fulfillmentStatus: "substituted", substitutionReason: " " })), "请填写替代菜名和替代原因");
    // ⑤ unavailable 未清字段或缺售罄原因
    const unavailableError = "售罄时请清空实际菜名和评价，并填写售罄原因";
    assert.equal(validateDish(dish({ fulfillmentStatus: "unavailable", actualName: "残留菜名", evaluation: "", unavailableReason: "没了" })), unavailableError);
    assert.equal(validateDish(dish({ fulfillmentStatus: "unavailable", evaluation: "残留评价", unavailableReason: "没了" })), unavailableError);
    assert.equal(validateDish(dish({ fulfillmentStatus: "unavailable", fullySatisfied: true, unavailableReason: "没了" })), unavailableError);
    assert.equal(validateDish(dish({ fulfillmentStatus: "unavailable", actualName: "", evaluation: "", unavailableReason: "" })), unavailableError, "缺售罄原因命中");
    assert.equal(validateDish(dish({ fulfillmentStatus: "unavailable", actualName: "", evaluation: "", unavailableReason: "卖完了" })), "", "合规售罄通过");
    // ⑥ skipped 填了实际菜名/评价或选全部满意
    const skippedError = "未点菜品不填写实际菜名和评价";
    assert.equal(validateDish(dish({ fulfillmentStatus: "skipped", actualName: "残留", evaluation: "" })), skippedError);
    assert.equal(validateDish(dish({ fulfillmentStatus: "skipped", evaluation: "残留" })), skippedError);
    assert.equal(validateDish(dish({ fulfillmentStatus: "skipped", fullySatisfied: true })), skippedError);
    assert.equal(validateDish(dish({ fulfillmentStatus: "skipped", actualName: "", evaluation: "" })), "", "合规未点通过");
    // ⑦ extra 却带 requirementId
    assert.equal(validateDish(dish({ fulfillmentStatus: "extra", requirementId: "req-1", actualName: "加菜", evaluation: "好" })), "额外菜品状态不正确");
    // ⑧ active 态缺实际菜名
    assert.equal(validateDish(dish({ actualName: "  " })), "请填写实际菜名");
    assert.equal(validateDish(dish({ fulfillmentStatus: "extra", actualName: "" })), "请填写实际菜名");
    // ⑨ active 态未选全部满意且评价为空
    assert.equal(validateDish(dish({ evaluation: "" })), "请填写评价或选择全部满意");
    assert.equal(validateDish(dish({ evaluation: " ", fullySatisfied: true })), "", "选全部满意免填评价");
    // 全通过 → 空串
    assert.equal(validateDish(dish({})), "");
  });

  it("R56-金额分转元解析: parseYuanToCents 拒绝负数/科学计数/三位小数/整数超 7 位，合法值精确转分；formatCentsToYuan 反向归一", async () => {
    // 层级：pure（features/receipt-ocr.js parseYuanToCents/formatCentsToYuan）
    const { parseYuanToCents, formatCentsToYuan } = await loadSrc("features/receipt-ocr.js");
    // 空串/纯空白 → null（允许清空）
    assert.equal(parseYuanToCents(""), null);
    assert.equal(parseYuanToCents("   "), null);
    // 合法精确转换
    assert.equal(parseYuanToCents("12.34"), 1234);
    assert.equal(parseYuanToCents("0.1"), 10);
    assert.equal(parseYuanToCents("0"), 0);
    assert.equal(parseYuanToCents("9999999.99"), 999999999, "恰达上限放行");
    // 格式错误逐类拒绝
    const FORMAT_ERROR = "请输入正确的金额，最多保留两位小数";
    for (const bad of ["-1", "1e3", "12.345", "12345678", "00", "1,234", "abc", "NaN", "Infinity", "0."]) {
      assert.throws(() => parseYuanToCents(bad), { message: FORMAT_ERROR }, `非法金额 ${bad} 必须按格式错误拒绝`);
    }
    // 反向归一
    assert.equal(formatCentsToYuan(null), "");
    assert.equal(formatCentsToYuan(undefined), "");
    assert.equal(formatCentsToYuan(0), "0.00");
    assert.equal(formatCentsToYuan(10), "0.10");
    assert.equal(formatCentsToYuan(1234), "12.34");
    for (const bad of [-1, 1.5, 1000000000, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => formatCentsToYuan(bad), { message: "金额数据暂时无法使用" }, `非法分值 ${bad} 拒绝`);
    }
    // 页面编排（失焦才解析归一、输入过程仅清错误态）：stage-3 E2E 补
  });

  it("R57-行总价推导: 显式行总价优先；数量非正整数或单价非整数不推导；否则数量×单价精确推导，溢出抛错", async () => {
    // 层级：pure（features/receipt-ocr.js deriveLineTotal）
    const { deriveLineTotal } = await loadSrc("features/receipt-ocr.js");
    assert.deepEqual(deriveLineTotal(3, 500, 777), { lineTotalCents: 777, priceDerived: false }, "显式行总价直接采用且不标推导");
    assert.deepEqual(deriveLineTotal(0, null, 100), { lineTotalCents: 100, priceDerived: false }, "显式总价不受数量单价合法性影响");
    assert.deepEqual(deriveLineTotal(0, 500, null), { lineTotalCents: null, priceDerived: false }, "数量非正整数不推导");
    assert.deepEqual(deriveLineTotal(2.5, 500, null), { lineTotalCents: null, priceDerived: false }, "数量非整数不推导");
    assert.deepEqual(deriveLineTotal(3, 500.5, null), { lineTotalCents: null, priceDerived: false }, "单价非整数不推导");
    assert.deepEqual(deriveLineTotal(3, 500, null), { lineTotalCents: 1500, priceDerived: true }, "整数精确乘法推导并标 priceDerived");
    assert.throws(() => deriveLineTotal(1000, 1000000, null), { message: "金额超出可填写范围" }, "数量×单价超 999999999 分抛错");
    assert.throws(() => deriveLineTotal(2, 4503599627370496, null), { message: "金额超出可填写范围" }, "非安全整数溢出抛错");
    // 页面编排（改单价仅当行总价为空或 priceDerived 才重算、用户显式改行总价后 priceDerived=false 不再联动）：stage-3 E2E 补
  });

  it("R59-额外菜品创建与空白拦截: isBlankExtraDish 空白判定全字段，secureUuid 无安全随机源抛 SECURE_RANDOM_UNAVAILABLE", async () => {
    // 层级：pure（utils/business.js isBlankExtraDish/secureUuid）
    const { isBlankExtraDish, secureUuid } = await loadSrc("utils/business.js");
    const extraBlank = { fulfillmentStatus: "extra", actualName: "", evaluation: "", substitutionReason: "", unavailableReason: "", fullySatisfied: false };
    assert.equal(isBlankExtraDish(extraBlank), true, "全空额外菜为空白行");
    assert.equal(isBlankExtraDish({ ...extraBlank, actualName: " " }), true, "纯空白按 trim 归一仍算空白");
    assert.equal(isBlankExtraDish({ ...extraBlank, actualName: "加菜" }), false, "填了实际菜名不算空白");
    assert.equal(isBlankExtraDish({ ...extraBlank, evaluation: "好吃" }), false);
    assert.equal(isBlankExtraDish({ ...extraBlank, substitutionReason: "原因" }), false);
    assert.equal(isBlankExtraDish({ ...extraBlank, unavailableReason: "原因" }), false);
    assert.equal(isBlankExtraDish({ ...extraBlank, fullySatisfied: true }), false, "选了全部满意不算空白");
    assert.equal(isBlankExtraDish({ ...extraBlank, fulfillmentStatus: "ordered", actualName: "" }), false, "非 extra 状态不参与空白拦截");
    // secureUuid 优先安全随机源生成（创建额外菜品行 id）
    const first = secureUuid();
    const second = secureUuid();
    assert.notEqual(first, second, "每次生成新行 id");
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "UUIDv4 形状");
    // 两者皆无安全随机源 → 抛 SECURE_RANDOM_UNAVAILABLE
    vi.stubGlobal("crypto", undefined);
    assert.throws(() => secureUuid(), { message: "SECURE_RANDOM_UNAVAILABLE" }, "无安全随机源必须抛错（页面 toast 升级提示的前提）");
    // 页面编排（添加其他菜品置脏滚动聚焦、返回问卷时空白额外菜阻断并显示「请补全这道额外菜品，或点击删除」）：stage-3 E2E 补
  });

  it("R61-小票数量上限与占用计数: 上限固定 9，占用=服务端条数+无 attachmentId 或不在服务端集合的待传项，占用+新选>9 拒绝", async () => {
    // 层级：pure（features/receipt-ocr.js MAX_RECEIPTS/occupiedReceiptCount/readyReceiptCount/validateReceiptFiles）
    const ocr = await loadSrc("features/receipt-ocr.js");
    assert.equal(ocr.MAX_RECEIPTS, 9, "上限固定 9（本地常量，非 client-config 下发）");
    assert.equal(ocr.MAX_RECEIPT_BYTES, 10 * 1024 * 1024);
    const serverReceipts = [{ id: "att-a", status: "ready", origin: "server" }, { id: "att-b", status: "ready", origin: "server" }];
    const pending = [
      { clientFileId: "cf-1" },
      { clientFileId: "cf-2", attachmentId: "att-a" },
      { clientFileId: "cf-3", attachmentId: "att-zzz" },
    ];
    assert.equal(ocr.occupiedReceiptCount(serverReceipts, pending), 4, "占用 = 服务端 2 + 待传 2（cf-2 的 attachmentId 已在服务端集合不重复占格）");
    assert.equal(
      ocr.readyReceiptCount([{ status: "ready", origin: "server" }, { status: "ready", origin: "local" }, { status: "uploading", origin: "server" }]),
      1,
      "ready 数仅计 status=ready 且 origin 非 local",
    );
    const imageFile = { tempFilePath: "/tmp/sample-receipt.jpg", fileType: "image", size: 1024 };
    assert.equal(ocr.validateReceiptFiles(9, [imageFile]), "最多只能上传 9 张消费小票", "占用+新选 >9 整批拒绝（9+1=10>9）");
    assert.equal(ocr.validateReceiptFiles(8, [imageFile]), "", "8+1=9 不大于上限放行（边界不误伤）");
    assert.equal(ocr.validateReceiptFiles(8, [imageFile, imageFile]), "最多只能上传 9 张消费小票");
    assert.equal(ocr.validateReceiptFiles(7, [imageFile]), "", "占用+新选 ≤9 放行");
    // 页面编排（添加入口仅当占用 <9 渲染、标题区固定提示「最多 9 张图片，每张不超过 10MB」）：stage-3 E2E 补
  });

  it("R62-小票文件校验: 仅 jpeg/png（类型或路径后缀）且 10MB 内，任一不满足整批拒绝", async () => {
    // 层级：pure（features/receipt-ocr.js validateReceiptFiles）
    const ocr = await loadSrc("features/receipt-ocr.js");
    const REJECT = "请选择 10MB 以内的图片";
    assert.equal(ocr.validateReceiptFiles(0, [{ tempFilePath: "/x/a.jpg", fileType: "image", size: 1024 }]), "", "image 类型放行");
    assert.equal(ocr.validateReceiptFiles(0, [{ tempFilePath: "/x/a.jpg", fileType: "image/jpeg", size: 1024 }]), "", "image/jpeg 放行");
    assert.equal(ocr.validateReceiptFiles(0, [{ tempFilePath: "/x/a", fileType: "image/png", size: 1024 }]), "", "image/png 放行");
    assert.equal(ocr.validateReceiptFiles(0, [{ path: "/x/a.jpeg", type: "", size: 1024 }]), "", "路径 .jpeg 后缀判定");
    assert.equal(ocr.validateReceiptFiles(0, [{ tempFilePath: "/x/a.PNG", fileType: "", size: 1024 }]), "", "路径 .png 后缀判定（大小写不敏感）");
    assert.equal(ocr.validateReceiptFiles(0, [{ tempFilePath: "/x/a.gif", fileType: "gif", size: 1024 }]), REJECT, "gif 等其他图片类型拒绝");
    assert.equal(ocr.validateReceiptFiles(0, [{ tempFilePath: "/x/a.jpg", fileType: "image", size: 0 }]), REJECT, "size ≤0 拒绝");
    assert.equal(ocr.validateReceiptFiles(0, [{ tempFilePath: "/x/a.jpg", fileType: "image", size: -1 }]), REJECT);
    assert.equal(ocr.validateReceiptFiles(0, [{ tempFilePath: "/x/a.jpg", fileType: "image", size: Number.NaN }]), REJECT, "size 非有限拒绝");
    assert.equal(ocr.validateReceiptFiles(0, [{ tempFilePath: "/x/a.jpg", fileType: "image", size: 10 * 1024 * 1024 }]), "", "恰好 10MB 放行");
    assert.equal(ocr.validateReceiptFiles(0, [{ tempFilePath: "/x/a.jpg", fileType: "image", size: 10 * 1024 * 1024 + 1 }]), REJECT, "超 10MB 拒绝");
    assert.equal(
      ocr.validateReceiptFiles(0, [{ tempFilePath: "/x/good.jpg", fileType: "image", size: 1024 }, { tempFilePath: "/x/bad.gif", fileType: "gif", size: 1024 }]),
      REJECT,
      "任一不满足整批拒绝",
    );
    // 页面编排（选后图片信息探测补全类型：png → image/png 否则一律 image/jpeg；文件名取路径末段兜底 receipt.jpg）：stage-3 E2E 补
  });

  it("R64-小票上传取消语义: 取消集合 add 后 has 恒真、delete 为唯一复活通道、size 计数去重", async () => {
    // 层级：pure（utils/upload-queue.js createCancelledUploads）
    const { createCancelledUploads } = await loadSrc("utils/upload-queue.js");
    const queue = createCancelledUploads();
    assert.equal(queue.has("cf-1"), false, "初始无取消登记");
    assert.equal(queue.size, 0);
    queue.add("cf-1");
    queue.add("cf-1");
    assert.equal(queue.has("cf-1"), true, "登记后 has 恒为 true（在途回调据此放弃回填）");
    assert.equal(queue.size, 1, "重复登记去重");
    queue.add("cf-2");
    assert.equal(queue.size, 2);
    queue.delete("cf-1");
    assert.equal(queue.has("cf-1"), false, "显式重试先 delete 解除登记（唯一复活通道）");
    assert.equal(queue.size, 1);
    queue.delete("cf-missing");
    assert.equal(queue.size, 1, "删除不存在项安全");
    // 页面编排（三个 await 点后检查取消集合放弃回填、uploading/confirming 项移除按钮禁用、底层传输任务不外露不 abort）：stage-3 E2E 补
  });

  it("R66-小票删除选项推导: 按 dishImpact/appliedDishCount 推导 1 或 2 个选项，确认删除携带 dishHandling+revision 调 DELETE 端点", async () => {
    // 层级：pure（features/receipt-ocr.js receiptDeletionOptions）+ service（services/receipts.js deleteReceiptAttachment）
    const ocr = await loadSrc("features/receipt-ocr.js");
    assert.deepEqual(ocr.receiptDeletionOptions({ dishImpact: "none", appliedDishCount: 3 }), ["keep_as_manual"], "dishImpact none → 仅转手工");
    assert.deepEqual(ocr.receiptDeletionOptions({ dishImpact: "removable_auto_rows", appliedDishCount: 0 }), ["keep_as_manual"], "appliedDishCount 0 → 仅转手工");
    assert.deepEqual(
      ocr.receiptDeletionOptions({ dishImpact: "removable_auto_rows", appliedDishCount: 2 }),
      ["remove_unmodified_ocr_rows", "keep_as_manual"],
      "可移除未修改识别行 → 双选项",
    );
    assert.deepEqual(ocr.receiptDeletionOptions({ dishImpact: "manual_rows_only", appliedDishCount: 2 }), ["keep_as_manual"], "其余 dishImpact 兜底仅转手工");
    assert.deepEqual(ocr.receiptDeletionOptions(null), ["keep_as_manual"]);
    // 确认后调删除接口：携带 dishHandling 与 revision
    await seedSession();
    stubJson({ revision: 9, items: [], dishes: [] });
    const receipts = await loadSrc("services/receipts.js");
    await receipts.deleteReceiptAttachment("at-r66", "att-del-9", "remove_unmodified_ocr_rows", 8);
    assert.equal(callUrl(0), endpointRegistry.drafts.receiptAttachment.path("at-r66", "att-del-9"), "删除走小票附件 DELETE 端点（零域名相对路径）");
    assert.equal(callMethod(0), "DELETE");
    assert.deepEqual(callBody(0), { dishHandling: "remove_unmodified_ocr_rows", revision: 8 }, "删除载荷携带推导出的 dishHandling 与 revision");
    // 页面编排（单选项确认弹窗/双选项 ActionSheet 文案、服务端返回 items/dishes 全量采纳）：stage-3 E2E 补
  });
});

// ---------- service 层 ----------
describe("service 层：stub fetch 驱动服务函数", () => {
  it("R41-编辑会话开启: createEditSession 以 baseAnswerRevision+targetAnswer 建会话，409 EDIT_SESSION_EXISTS → kind conflict + 后端文案与 requiresNewToken 透传", async () => {
    // 层级：service（services/drafts.js createEditSession + presentError 409 分支）
    await seedSession();
    stubJson({ id: "es-r41", draftIssueRemark: null, activeAttachments: [] });
    const drafts = await loadSrc("services/drafts.js");
    const payload = { baseAnswerRevision: 4, targetAnswer: "unscored" };
    await drafts.createEditSession("at-r41", "q-r41", payload);
    assert.equal(callUrl(0), endpointRegistry.drafts.editSessions.path("at-r41", "q-r41"), "创建会话走编辑会话端点（零域名相对路径）");
    assert.equal(callMethod(0), "POST");
    assert.deepEqual(callBody(0), payload, "以当前答案 revision 为基线 + 目标答案建会话");
    stubJson({ error: { code: "EDIT_SESSION_EXISTS", message: "该题正在编辑中，请先完成或取消当前编辑", requiresNewToken: true } }, 409);
    await assert.rejects(
      drafts.createEditSession("at-r41", "q-r41", payload),
      { name: "BusinessError", kind: "conflict", message: "该题正在编辑中，请先完成或取消当前编辑", requiresNewToken: true },
      "同题已有 open 会话的 409 必须透出后端文案与 requiresNewToken",
    );
    // 页面编排（路由缺参阻断「未找到题目…」、题目不存在「题目已更新…」、说明/附件初值取会话回填并按 image/audio 分组）：stage-3 E2E 补
  });

  it("R42-编辑会话状态机: confirm/cancel 端点可达，过期/已关闭的 409 后端文案透传（cancel 不做过期拦截由服务端保证）", async () => {
    // 层级：service（services/drafts.js confirmIssue/cancelIssue/updateEditSession + presentError 409）
    await seedSession();
    const drafts = await loadSrc("services/drafts.js");
    // 过期 open 会话上改说明 → 409 EDIT_SESSION_EXPIRED 透传（页面 toast 该文案）
    stubJson({ error: { code: "EDIT_SESSION_EXPIRED", message: "编辑会话已过期，请重新打开" } }, 409);
    await assert.rejects(
      drafts.updateEditSession("at-r42", "q-r42", "es-r42", { draftIssueRemark: "说明", revision: 1 }),
      { name: "BusinessError", kind: "conflict", message: "编辑会话已过期，请重新打开" },
      "过期后 patch 拒绝并透出固定文案",
    );
    // 确认端点 POST
    stubJson({ ok: true });
    await drafts.confirmIssue("at-r42", "q-r42", "es-r42", { answer: "unscored", revision: 1 });
    assert.equal(callUrl(0), endpointRegistry.drafts.confirmEdit.path("at-r42", "q-r42", "es-r42"), "确认走 confirm 端点");
    assert.equal(callMethod(0), "POST");
    // 取消端点 POST；非 open 会话取消 → EDIT_SESSION_CLOSED 透传（cancel 仅查 status，不查过期）
    stubJson({ error: { code: "EDIT_SESSION_CLOSED", message: "编辑会话已关闭" } }, 409);
    await assert.rejects(
      drafts.cancelIssue("at-r42", "q-r42", "es-r42"),
      { name: "BusinessError", kind: "conflict", message: "编辑会话已关闭" },
      "非 open 会话取消拒绝并透出后端文案",
    );
    stubJson({ ok: true });
    await drafts.cancelIssue("at-r42", "q-r42", "es-r42");
    assert.equal(callUrl(0), endpointRegistry.drafts.cancelEdit.path("at-r42", "q-r42", "es-r42"), "取消走 cancel 端点");
    assert.equal(callMethod(0), "POST");
    // 页面编排（客户端无主动过期计时、过期后取消仍置 cancelled、取消失败不返回）：stage-3 E2E 补；创建新会话时批量置过期旧会话为服务端语义
  });

  it("R43-图片证据数量上限: issue 页与证据上传链声明（imageMaxCount 余量计算与 toast 为页面编排）", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "issue"), true, "issue 页承载图片证据上限编排");
    assert.ok(manifest.services.drafts.functions.includes("initEvidenceUpload"), "证据链必须声明 initEvidenceUpload");
    // 页面编排（余量 = imageMaxCount||3 − 已有图片数、余量 ≤0 toast「每题最多上传 N 张照片」、chooseMedia count 取余量）：stage-3 E2E 补
  });

  it("R44-音频证据上限与时长: issue 页声明承载录音上限与时长截断编排", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "issue"), true, "issue 页承载音频证据编排");
    // 页面编排（已有 ≥3 段 toast「每题最多上传 3 段音频」、时长上限 audioMaxDurationSeconds||10 秒自动截断、<1000ms 拒收「录音至少需要 1 秒」、秒数 Math.ceil 且 mime 经 isTypeSupported 按序选择（audio/mp4→audio/aac→audio/webm）并以真实 recorder.mimeType 透传，后端白名单接受 mp4/aac/webm 等）：stage-3 E2E 补
  });

  it("R45-证据单文件 10MB: issue 页声明承载入队前体积守卫（与小票上限数值一致但入口独立）", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "issue"), true, "issue 页承载证据体积守卫");
    assert.deepEqual(manifest.services.uploads, { module: "services/uploads.js", functions: ["uploadToSignedTarget"] }, "证据直传复用 uploads 服务");
    // 页面编排（size > 10×1024×1024 不入队列直接 toast「单个文件不能超过 10MB」、不发起上传）：stage-3 E2E 补
  });

  it("R46-证据上传三步链: init（payload 透传）→ 预签名直传 → complete（uploadToken/sizeBytes/durationSeconds）端点序列逐笔钉定", async () => {
    // 层级：service + adapter（services/drafts.js initEvidenceUpload/completeEvidenceUpload + services/uploads.js uploadToSignedTarget）
    await seedSession();
    const presigned = presignedTargetSample();
    stubFetch(async (url) => {
      const path = String(url);
      if (path.startsWith("/api/")) {
        if (path.endsWith("/evidence-uploads")) {
          return new Response(JSON.stringify({ attachmentId: "att-ev-1", uploadToken: "tok-ev-1", uploadTarget: presigned }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: "staged_ready" }), { status: 200 });
      }
      return new Response(null, { status: 200, headers: { ETag: '"etag-ev-1"' } });
    });
    const drafts = await loadSrc("services/drafts.js");
    const uploads = await loadSrc("services/uploads.js");
    const init = await drafts.initEvidenceUpload("at-r46", "q-r46", "es-r46", EVIDENCE_PAYLOAD);
    await uploads.uploadToSignedTarget(init.uploadTarget, sampleImageFile(), null);
    const completed = await drafts.completeEvidenceUpload("at-r46", "q-r46", "es-r46", init.attachmentId, { uploadToken: init.uploadToken, sizeBytes: 4096 });
    assert.equal(completed.status, "staged_ready", "完成响应必须 staged_ready（非该值由页面按失败处理）");
    // 第 1 步：init 端点 + payload 逐字透传
    assert.equal(callUrl(0), endpointRegistry.drafts.evidenceUploads.path("at-r46", "q-r46", "es-r46"), "第一步 init 走证据上传端点");
    assert.equal(callMethod(0), "POST");
    assert.deepEqual(callBody(0), EVIDENCE_PAYLOAD, "init 载荷 clientFileId/type/mimeType/sizeBytes 透传");
    // 第 2 步：直传服务端下发的预签名 URL（R0 运行时数据例外）
    assert.equal(callUrl(1), presigned.url, "第二步直传预签名 url 原样");
    assert.equal(callMethod(1), "POST");
    // 第 3 步：complete 端点 + 载荷
    assert.equal(callUrl(2), endpointRegistry.drafts.evidenceComplete.path("at-r46", "q-r46", "es-r46", "att-ev-1"), "第三步 complete 走完成端点");
    assert.equal(callMethod(2), "POST");
    assert.deepEqual(callBody(2), { uploadToken: "tok-ev-1", sizeBytes: 4096 }, "complete 载荷携带 uploadToken/sizeBytes（图片无 durationSeconds）");
    // 页面编排（列表项 uploading「正在上传」→ staged_ready「上传成功」、非 staged_ready 兜底、失败置 failed 且 progressLabel 为错误文案、图片 png→image/png 否则 image/jpeg）：stage-3 E2E 补
  });

  it("R48-证据删除分流: 服务端附件先调 removeEvidence DELETE 端点，local- 前缀本地直接移除为页面分流", async () => {
    // 层级：service（services/drafts.js removeEvidence）
    await seedSession();
    stubJson({ ok: true });
    const drafts = await loadSrc("services/drafts.js");
    await drafts.removeEvidence("at-r48", "q-r48", "es-r48", "att-del-1");
    assert.equal(callUrl(0), endpointRegistry.drafts.evidence.path("at-r48", "q-r48", "es-r48", "att-del-1"), "服务端附件删除走 evidence DELETE 端点");
    assert.equal(callMethod(0), "DELETE");
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "issue"), true, "issue 页承载删除分流编排");
    // 页面编排（id 以 local- 开头仅本地移除不发请求；服务端删除失败 toast 且本地不移除、成功后本地移除；判定键为 id 前缀）：stage-3 E2E 补
  });

  it("R50-编辑会话确认与取消: 先 PATCH 写 draftIssueRemark 再 confirm 提交 {answer, revision}，两步载荷逐字钉定", async () => {
    // 层级：service（services/drafts.js updateEditSession/confirmIssue）
    await seedSession();
    stubJson({ id: "es-r50" });
    const drafts = await loadSrc("services/drafts.js");
    await drafts.updateEditSession("at-r50", "q-r50", "es-r50", { draftIssueRemark: "问题说明样例", revision: 5 });
    assert.equal(callUrl(0), endpointRegistry.drafts.editSession.path("at-r50", "q-r50", "es-r50"), "先写会话草稿说明（PATCH 端点）");
    assert.equal(callMethod(0), "PATCH");
    assert.deepEqual(callBody(0), { draftIssueRemark: "问题说明样例", revision: 5 });
    stubJson({ ok: true });
    await drafts.confirmIssue("at-r50", "q-r50", "es-r50", { answer: "unscored", revision: 5 });
    assert.equal(callUrl(0), endpointRegistry.drafts.confirmEdit.path("at-r50", "q-r50", "es-r50"), "确认提交答案走 confirm 端点"); // PM 裁决 2026-10-10：stubJson 重建 mock，confirm 在新 mock 上为索引 0
    assert.equal(callMethod(0), "POST");
    assert.deepEqual(callBody(0), { answer: "unscored", revision: 5 }, "确认载荷固定目标答案 + revision");
    // 页面编排（unscored 存 trim 后说明、scored 存空串、成功返回问卷页、失败停留编辑页 toast、无会话 id 取消直接返回）：stage-3 E2E 补
  });

  it("R63-小票上传流水线: init（{fileMeta,revision}）→ 预签名直传（ETag 捕获）→ complete（{fileMeta+etag,revision}）三步端点序列", async () => {
    // 层级：service + adapter（services/receipts.js 两端点 + services/uploads.js 直传）
    await seedSession();
    const presigned = presignedTargetSample();
    stubFetch(async (url) => {
      const path = String(url);
      if (path.endsWith("/receipt-attachments/uploads")) {
        return new Response(JSON.stringify({ attachment: { id: "att-rc-1", status: "uploading" }, uploadTarget: presigned, revision: 3 }), { status: 200 });
      }
      if (path.startsWith("https://")) return new Response(null, { status: 200, headers: { ETag: '"etag-rc-1"' } });
      return new Response(JSON.stringify({ revision: 4, attachment: { id: "att-rc-1", status: "ready" }, items: [] }), { status: 200 });
    });
    const receipts = await loadSrc("services/receipts.js");
    const uploads = await loadSrc("services/uploads.js");
    const init = await receipts.initializeReceiptUpload("at-r63", RECEIPT_FILE_META, 2);
    assert.equal(init.attachment.id, "att-rc-1");
    assert.equal(init.revision, 3, "init 成功推进 revision");
    const uploaded = await uploads.uploadToSignedTarget(init.uploadTarget, sampleReceiptFile(), null);
    assert.deepEqual(uploaded, { etag: '"etag-rc-1"' }, "直传捕获 ETag 供 complete 携带");
    const completed = await receipts.completeReceiptUpload("at-r63", init.attachment.id, { ...RECEIPT_FILE_META, etag: uploaded.etag }, init.revision);
    assert.equal(completed.revision, 4, "complete 成功推进 revision");
    // 逐笔钉定
    assert.equal(callUrl(0), endpointRegistry.drafts.receiptUploads.path("at-r63"), "第一步 init 走小票上传端点");
    assert.equal(callMethod(0), "POST");
    assert.deepEqual(callBody(0), { fileMeta: RECEIPT_FILE_META, revision: 2 }, "init 载荷 {fileMeta, revision}");
    assert.equal(callUrl(1), presigned.url, "第二步直传服务端下发的预签名 url（R0 运行时数据例外）");
    assert.equal(callMethod(1), "POST");
    assert.equal(callUrl(2), endpointRegistry.drafts.receiptComplete.path("at-r63", "att-rc-1"), "第三步 complete 走小票完成端点");
    assert.equal(callMethod(2), "POST");
    assert.deepEqual(callBody(2), { fileMeta: { ...RECEIPT_FILE_META, etag: '"etag-rc-1"' }, revision: 3 }, "complete 载荷 fileMeta 含 etag + revision");
    // 页面编排（receiptBusy 互斥、uploading→confirming 状态流转、进度钳制 0–100 与「正在上传 N%」文案、失败置 failed）：stage-3 E2E 补
  });

  it("R63-小票上传流水线: 直传入参校验失败（过期 expiresAt）→ kind upload 唯一不可重试分支且不发起直传", async () => {
    // 层级：adapter（services/uploads.js uploadToSignedTarget 入参校验分支）
    stubJson({});
    const uploads = await loadSrc("services/uploads.js");
    const expired = { ...presignedTargetSample(), expiresAt: new Date(Date.now() - 1000).toISOString() };
    await assert.rejects(
      uploads.uploadToSignedTarget(expired, sampleReceiptFile(), null),
      { name: "BusinessError", kind: "upload", message: "上传链接已失效，请重新上传", retryable: false },
      "过期链接是唯一不可重试的 upload 分支",
    );
    assert.equal(fetchMock.mock.calls.length, 0, "入参校验失败不得发起任何直传请求");
  });

  it("R63-小票上传流水线: 响应契约校验（init 须 attachmentId+uploadTarget、列表/变更 revision 非负整数）不满足 → kind contract", async () => {
    // 层级：service（contracts 校验器接入 —— assertReceiptUploadInit/assertReceiptList/assertReceiptMutation）
    await seedSession();
    const receipts = await loadSrc("services/receipts.js");
    const CONTRACT_ERROR = { name: "BusinessError", kind: "contract", message: "服务返回的数据暂时无法使用，请稍后重试" };
    stubJson({ attachment: { id: "att-rc-n1" } });
    await assert.rejects(
      receipts.initializeReceiptUpload("at-rc-n1", RECEIPT_FILE_META, 1),
      CONTRACT_ERROR,
      "init 响应缺 uploadTarget → 契约错误",
    );
    stubJson({ items: [], revision: -1 });
    await assert.rejects(
      receipts.listReceiptAttachments("at-rc-n2"),
      CONTRACT_ERROR,
      "列表响应 revision 非负整数校验",
    );
    stubJson({ revision: -1 });
    await assert.rejects(
      receipts.completeReceiptUpload("at-rc-n3", "att-rc-n3", RECEIPT_FILE_META, 1),
      CONTRACT_ERROR,
      "变更响应 revision 非负整数校验",
    );
    // 页面编排（失败项显示兜底错误文案、确认环节进度 100%「正在确认上传」）：stage-3 E2E 补
  });

  it("R65-失败小票换图重传: 先以 dishHandling=keep_as_manual 删旧附件（DELETE 携带 revision），dishes 页声明承载换图编排", async () => {
    // 层级：service（services/receipts.js deleteReceiptAttachment —— 换图重传的删旧步）
    await seedSession();
    stubJson({ revision: 8, items: [], dishes: [{ id: "dish-keep-1", actualName: "手工菜" }] });
    const receipts = await loadSrc("services/receipts.js");
    await receipts.deleteReceiptAttachment("at-r65", "att-old-1", "keep_as_manual", 7);
    assert.equal(callUrl(0), endpointRegistry.drafts.receiptAttachment.path("at-r65", "att-old-1"), "删旧附件走小票 DELETE 端点");
    assert.equal(callMethod(0), "DELETE");
    assert.deepEqual(callBody(0), { dishHandling: "keep_as_manual", revision: 7 }, "删旧固定 keep_as_manual + 当前 revision");
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "dishes"), true, "dishes 页承载换图重传编排");
    // 页面编排（status=failed 且 canRetry 且非 busy 才可选新图、数量按占用−1 校验、删旧采纳返回 dishes 后重走 R63 上传新图、canRetry=false 不提供重选按钮）：stage-3 E2E 补
  });
});

// ---------- manifest 层 ----------
describe("manifest 层：页面编排规则以 app-manifest.js 声明兜底", () => {
  it("R38-得分/不得分切换走问题页: survey/issue 页声明，切换双向经编辑会话链", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "survey"), true, "survey 页承载切换入口");
    assert.equal(manifest.pages.some((page) => page.name === "issue"), true, "issue 页为问题编辑页");
    for (const fn of ["createEditSession", "confirmIssue", "cancelIssue"]) {
      assert.ok(manifest.services.drafts.functions.includes(fn), `切换链必须声明 ${fn}`);
    }
    // 页面编排（unscored→scored 与 scored→unscored 都进 issue 编辑页、scored 目标展示「改为得分？」确认卡片、确认后清除原问题说明和证据、取消不改变原答案）：stage-3 E2E 补
  });

  it("R39-完成度统计口径: survey 页声明承载完成度统计（只统计当前题目集合内答案为页面编排）", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "survey"), true);
    // 页面编排（X 只统计 id 存在于当前服务端题目集合内的答案、Y 为当前题总数、unscored/scored 都算已作答、分类切换不改总数只改可见题）：stage-3 E2E 补
  });

  it("R51-菜品初始行构建: dishes 页与 saveDishes 声明（从 dishRequirements 派生初始行为页面编排）", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "dishes"), true, "dishes 页承载初始行构建");
    assert.ok(manifest.services.drafts.functions.includes("saveDishes"), "菜品保存链必须声明 saveDishes");
    // 页面编排（服务端 dishes 非空原样采用、为空时从 dishRequirements 派生：id 取 recordId||secureUuid、requirementId 关联、actualName 初值要求菜名、数量取要求数量或 1、状态 ordered、布尔化要求值；加载即无 dishes 时 dirty=true）：stage-3 E2E 补
  });

  it("R53-菜品状态选项推导: dishes 页声明承载状态选项动态推导", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "dishes"), true, "dishes 页承载状态选项推导");
    // 页面编排（requirementId 行可选 ordered/substituted/unavailable/skipped：required 剔除 skipped、allowSubstitution=false 剔除 substituted；无 requirementId 仅 extra；当前状态不在选项集下标按 0 兜底；额外行固定标签「额外菜品」、要求行按 required 显示「必点/建议」、额外行状态选择器禁用）：stage-3 E2E 补
  });

  it("R55-状态切换字段清理: dishes 页声明承载切换清理矩阵", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "dishes"), true, "dishes 页承载状态切换清理");
    // 页面编排（ordered 回填 plannedName 清替代/售罄原因；substituted 仅清售罄原因；unavailable 清实际菜名/替代原因/评价且 fullySatisfied=false；skipped 另清售罄原因；任何切换置 manuallyModified 含 OCR 行、切换不清 evaluation 除非进入 unavailable/skipped）：stage-3 E2E 补
  });

  it("R58-数量校验: dishes 页声明承载数量失焦校验（1–999 整数）", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "dishes"), true, "dishes 页承载数量校验");
    // 页面编排（非整数/≤0/>999 显示「请输入 1 到 999 的整数数量」且不更新数量；合法时更新数量、同步 quantityInput、priceDerived 时重算行总价；输入过程不校验）：stage-3 E2E 补
  });

  it("R60-要求菜品不可删除: dishes 页声明承载删除守卫（requirementId 行无删除入口为页面编排）", async () => {
    // 层级：manifest
    const manifest = await loadSrc("app-manifest.js");
    assert.equal(manifest.pages.some((page) => page.name === "dishes"), true, "dishes 页承载要求行删除守卫");
    // 页面编排（requirementId 行删除动作直接忽略且不渲染删除按钮；仅额外菜品可删且删除需确认弹窗：OCR 来源行「菜品将从最终填写记录中删除，小票原始识别结果仍由系统保留。」、手工行「已填写的菜名和评价会一起删除。」；删除为纯本地操作无服务端端点，小票连带处理属 R66 链路）：stage-3 E2E 补
  });
});
