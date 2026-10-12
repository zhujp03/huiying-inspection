import { describe, expect, it } from "vitest";
import { mergeSurveyAnswers } from "../../apps/miniapp/miniprogram/store/survey-merge.js";
import { mergeSurveyAnswers as mergeWeb } from "../../apps/web/src/store/survey-merge.js";

const scored = (id) => ({ answer: "scored", awardedScore: 2, remark: "", attachments: [], revision: id });

describe("survey draft pending-local merge rules", () => {
  it("uses the server answers when there is no unsynced local draft", () => {
    const result = mergeSurveyAnswers({ serverAnswers: { q1: scored(1) }, serverRevision: 5, rawLocal: null });
    expect(result).toMatchObject({ answers: { q1: scored(1) }, conflict: false, pendingResync: [] });
  });

  it("never lets an empty server answers object overwrite a pending local draft at the same revision", () => {
    const local = { revision: 5, synced: false, answers: { q2: { answer: "scored", remark: "", attachments: [] } } };
    const result = mergeSurveyAnswers({ serverAnswers: {}, serverRevision: 5, rawLocal: local });
    expect(result.answers.q2).toEqual(local.answers.q2);
    expect(result.conflict).toBe(false);
    expect(result.pendingResync).toEqual(["q2"]);
  });

  it("keeps local pending answers per question and resyncs only the differing scored ones", () => {
    const local = { revision: 5, synced: false, answers: { q1: { answer: "scored", remark: "", attachments: [] }, q3: { answer: "scored", remark: "", attachments: [] } } };
    const server = { q1: scored(1), q2: scored(2) };
    const result = mergeSurveyAnswers({ serverAnswers: server, serverRevision: 5, rawLocal: local });
    expect(result.answers.q1.answer).toBe("scored");
    expect(result.answers.q2).toEqual(scored(2));
    expect(result.answers.q3).toEqual(local.answers.q3);
    // q1 与本地一致无需补发；q3 本地独有需要补发。
    expect(result.pendingResync).toEqual(["q3"]);
  });

  it("stops silent merging and flags a conflict when the server revision advanced", () => {
    const local = { revision: 4, synced: false, answers: { q9: { answer: "scored", remark: "", attachments: [] } } };
    const server = { q1: scored(1) };
    const result = mergeSurveyAnswers({ serverAnswers: server, serverRevision: 6, rawLocal: local });
    expect(result.conflict).toBe(true);
    expect(result.answers).toEqual(server);
    expect(result.pendingResync).toEqual([]);
  });

  it("treats a synced local draft as plain server state", () => {
    const local = { revision: 5, synced: true, answers: { q9: { answer: "scored", remark: "", attachments: [] } } };
    const server = { q1: scored(1) };
    const result = mergeSurveyAnswers({ serverAnswers: server, serverRevision: 5, rawLocal: local });
    expect(result.conflict).toBe(false);
    expect(result.answers).toEqual(server);
  });
});

// 草稿同步时序链（T3：补发成功前不得标记已同步）。
// 纯函数层模拟"断网作答 → 补发失败刷新 → 部分补发成功 → 全部补完"的合并结果；
// web 与 miniapp 两份实现声明同名同语义，同一链路双跑防漂移。
describe("survey draft sync timing chain (web + miniapp parity)", () => {
  const localScored = { answer: "scored", remark: "", attachments: [] };

  for (const [label, merge] of [["miniapp", mergeSurveyAnswers], ["web", mergeWeb]]) {
    it(`[${label}] offline answering keeps the scored answer and queues it for resync`, () => {
      const rawLocal = { revision: 5, synced: false, answers: { q1: localScored } };
      const result = mergeSurveyAnswers({ serverAnswers: {}, serverRevision: 5, rawLocal });
      expect(result.answers.q1).toEqual(localScored);
      expect(result.conflict).toBe(false);
      expect(result.pendingResync).toEqual(["q1"]);
    });

    it(`[${label}] a failed resync followed by a refresh re-merges to the identical result (no data loss)`, () => {
      const rawLocal = { revision: 5, synced: false, answers: { q1: localScored } };
      const first = mergeSurveyAnswers({ serverAnswers: {}, serverRevision: 5, rawLocal });
      const second = mergeSurveyAnswers({ serverAnswers: {}, serverRevision: 5, rawLocal });
      expect(second).toEqual(first);
      expect(second.answers.q1).toEqual(localScored);
      expect(second.pendingResync).toEqual(["q1"]);
    });

    it(`[${label}] after one resync succeeds (draft revision advanced) only the remaining question stays queued`, () => {
      // q1 已补发成功：服务端含 q1、服务端 revision=R+1，草稿 revision 已推进为 R+1（synced 仍 false）且仍含 q1,q2。
      const rawLocal = { revision: 6, synced: false, answers: { q1: localScored, q2: localScored } };
      const result = mergeSurveyAnswers({ serverAnswers: { q1: { answer: "scored" } }, serverRevision: 6, rawLocal });
      expect(result.answers.q1).toEqual(localScored);
      expect(result.answers.q2).toEqual(localScored);
      expect(result.conflict).toBe(false);
      expect(result.pendingResync).toEqual(["q2"]);
    });

    it(`[${label}] once everything is re-sent (markDraftSynced) the draft reads as plain server state`, () => {
      const server = { q1: { answer: "scored" }, q2: { answer: "scored" } };
      const rawLocal = { revision: 6, synced: true, answers: { q1: localScored, q2: localScored } };
      const result = mergeSurveyAnswers({ serverAnswers: server, serverRevision: 6, rawLocal });
      expect(result.answers).toEqual(server);
      expect(result.conflict).toBe(false);
      expect(result.pendingResync).toEqual([]);
    });
  }
});
