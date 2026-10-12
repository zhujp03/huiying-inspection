// store/survey.js 草稿同步时序契约（T3：补发成功前不得标记已同步）。
// 惯例对齐 rules/r34-r66.test.js 的 store 用例：一律经 loadSrc() 加载 src 模块、
// 复用 adapters/storage.js 的内存兜底（node 环境无 localStorage）、会话种子 + 用例后清理草稿键。
import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { loadSrc } from "../helpers/contract-paths.js";

const SAMPLE_SESSION = { accessToken: "sample-token", user: { id: "user-sync", status: "approved_active" } };
const META = { assignmentId: "as-sync", attemptId: "at-sync", questionnaireVersionId: "qv-sync", revision: 5 };
const DRAFT_KEY = `junde:survey:${encodeURIComponent("user-sync")}:as-sync:at-sync:qv-sync`;
const scored = { answer: "scored", remark: "", attachments: [] };

describe("store/survey.js 草稿同步时序（补发成功前不得标记已同步）", () => {
  afterEach(async () => {
    const session = await loadSrc("store/session.js");
    const storage = await loadSrc("adapters/storage.js");
    storage.removeStorage(DRAFT_KEY);
    storage.removeStorage("junde:draft-index");
    session.clearSessionAndUserCache();
  });

  it("A1-saveDraft 落盘 synced=false（乐观先行的时序前提）", async () => {
    const surveyStore = await loadSrc("store/survey.js");
    (await loadSrc("store/session.js")).saveSession(SAMPLE_SESSION);
    surveyStore.saveDraft(META, { answers: { q1: scored, q2: scored } });
    const raw = surveyStore.peekDraft(META);
    assert.equal(raw.synced, false, "保存即未同步");
    assert.equal(raw.revision, 5);
    assert.deepEqual(raw.answers, { q1: scored, q2: scored });
  });

  it("A2-advanceDraftRevision 仅推进 revision：synced 保持 false、内容与索引不动", async () => {
    const surveyStore = await loadSrc("store/survey.js");
    const storage = await loadSrc("adapters/storage.js");
    (await loadSrc("store/session.js")).saveSession(SAMPLE_SESSION);
    surveyStore.saveDraft(META, { answers: { q1: scored, q2: scored } });
    // 单题 q1 补发成功：已知服务端 revision 推进到 6，但 q2 尚未补发 → 整体仍 synced:false。
    surveyStore.advanceDraftRevision({ ...META, revision: 6 }, 6);
    const raw = surveyStore.peekDraft({ ...META, revision: 6 });
    assert.equal(raw.revision, 6, "草稿已知的服务端 revision 推进");
    assert.equal(raw.synced, false, "补发未全部完成不得标记已同步（否则刷新丢 q2）");
    assert.deepEqual(raw.answers, { q1: scored, q2: scored }, "内容字段不得被改动");
    const index = storage.readStorage("junde:draft-index");
    assert.deepEqual(index["user-sync"], [DRAFT_KEY], "registerDraftKey 照旧登记且去重");
  });

  it("A3-markDraftSynced 仍以 synced=true 收口（全部补发完成的既有语义）", async () => {
    const surveyStore = await loadSrc("store/survey.js");
    (await loadSrc("store/session.js")).saveSession(SAMPLE_SESSION);
    surveyStore.saveDraft(META, { answers: { q1: scored } });
    surveyStore.advanceDraftRevision({ ...META, revision: 6 }, 6);
    surveyStore.markDraftSynced({ ...META, revision: 6 }, 6);
    const raw = surveyStore.peekDraft({ ...META, revision: 6 });
    assert.equal(raw.synced, true, "全部补发完成后才允许整体置已同步");
    assert.equal(raw.revision, 6);
    assert.deepEqual(raw.answers, { q1: scored }, "同步不清内容");
  });

  it("A4-无草稿时 advanceDraftRevision 不抛错（实现定义：仅落 revision 骨架）", async () => {
    const surveyStore = await loadSrc("store/survey.js");
    (await loadSrc("store/session.js")).saveSession(SAMPLE_SESSION);
    assert.doesNotThrow(() => surveyStore.advanceDraftRevision({ ...META, revision: 7 }, 7));
    assert.equal(surveyStore.peekDraft(META)?.revision, 7, "落盘仅含推进后的 revision");
  });
});
