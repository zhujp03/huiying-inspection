import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyScoreWipe } from "../../packages/domain/index.js";
import { computeSurveyScore as webComputeSurveyScore } from "../../apps/web/src/utils/business.js";

// 小程序 utils/scoring.js 是 ESM 源码（无构建产物），直接动态导入求值。
const miniappModule = await import(resolve(import.meta.dirname, "../../apps/miniapp/miniprogram/utils/scoring.js"));
const miniappComputeSurveyScore = miniappModule.computeSurveyScore;

// 提交前得分预览必须与「服务端提交落库」的权威计分一致：
//   权威 = domain.applyScoreWipe(启用题, 全部作答含停用题残留) + 启用题满分和。
// 覆盖：常规得分/不得分、分类清零（wipe 是/否）、清零后改答、**与满分不同的持久化
// awardedScore**（服务端以落库值为准，不从 max 推导）、停用题残留作答（orphan 计入分子）、
// 缺答（未完成题）、0 满分、空问卷。

const enabledQuestions = [
  { id: "q1", category: "environment", score: 2, isScoreWipe: false },
  { id: "q2", category: "environment", score: 3, isScoreWipe: false },
  { id: "q3", category: "service", score: 5, isScoreWipe: false },
];
const wipeQuestions = [
  { id: "q1", category: "environment", score: 2, isScoreWipe: true },
  { id: "q2", category: "environment", score: 3, isScoreWipe: false },
  { id: "q3", category: "service", score: 5, isScoreWipe: false },
];

// 权威服务端口径：domain.applyScoreWipe(启用题, 全部作答) + 启用题满分和（提交端点同式）。
function serverScore(questions, answers) {
  const wipe = applyScoreWipe(
    questions.map((question) => ({ id: question.id, category: question.category, maxScore: question.score, scoreWipe: Boolean(question.isScoreWipe) })),
    Object.entries(answers).map(([questionId, answer]) => ({ questionId, answer: answer.answer, awardedScore: Number(answer.awardedScore ?? null) })),
  );
  const maxScore = questions.reduce((sum, question) => sum + question.score, 0);
  return { totalScore: wipe.totalScore, maxScore, percent: maxScore > 0 ? Math.round((wipe.totalScore / maxScore) * 100) : null };
}

// scored 作答默认 awardedScore=满分（服务端 confirm 语义），可显式覆盖为任意持久化值。
const scored = (max, awarded) => ({ answer: "scored", awardedScore: awarded === undefined ? max : awarded });
const unscored = () => ({ answer: "unscored", awardedScore: 0 });

describe("提交前得分预览与 domain.applyScoreWipe（服务端权威）同口径", () => {
  const cases = [
    ["常规全得分", enabledQuestions, { q1: scored(2), q2: scored(3), q3: scored(5) }],
    ["常规含不得分", enabledQuestions, { q1: unscored(), q2: scored(3), q3: unscored() }],
    ["持久化 awardedScore 与满分不同（历史口径）", enabledQuestions, { q1: scored(2, 1), q2: scored(3, 2), q3: scored(5, 4) }],
    ["awardedScore 为 0 的得分（清零残留形态）", enabledQuestions, { q1: scored(2, 0), q2: scored(3, 0), q3: scored(5) }],
    ["清零题答是→整类清零", wipeQuestions, { q1: unscored(), q2: scored(3), q3: scored(5) }],
    ["清零题答否→不清零", wipeQuestions, { q1: scored(2), q2: unscored(), q3: scored(5) }],
    ["清零后改答为得分→恢复", wipeQuestions, { q1: scored(2), q2: scored(3), q3: scored(5) }],
    ["跨分类独立清零", wipeQuestions, { q1: unscored(), q2: unscored(), q3: scored(5) }],
    ["停用题残留作答计入分子（orphan）", enabledQuestions, { q1: scored(2), q2: scored(3), q3: scored(5), orphanQ: { answer: "scored", awardedScore: 7 } }],
    ["orphan + 清零并存", wipeQuestions, { q1: unscored(), q2: scored(3), q3: scored(5), orphanQ: { answer: "unscored", awardedScore: 0 }, orphanQ2: { answer: "scored", awardedScore: 3 } }],
    ["orphan awardedScore 缺失（Number(null)=0 同款保守读法）", enabledQuestions, { q1: scored(2), q2: scored(3), q3: scored(5), orphanQ: { answer: "scored" } }],
  ];

  for (const [name, questions, answers] of cases) {
    it(`${name}：web/miniapp 预览与服务端落库计分一致`, () => {
      const server = serverScore(questions, answers);
      for (const [client, compute] of [["web", webComputeSurveyScore], ["miniapp", miniappComputeSurveyScore]]) {
        expect(compute(questions, answers), `${client} 预览必须与服务端计分一致`).toEqual(server);
      }
    });
  }

  it("0 满分：返回 null（服务端 max_score>0 约束下不可提交，预览绝不显示 Infinity/100%）", () => {
    for (const compute of [webComputeSurveyScore, miniappComputeSurveyScore]) {
      expect(compute([{ id: "q1", category: "c", score: 0, isScoreWipe: false }], { q1: scored(0) })).toBeNull();
      expect(compute([], {})).toBeNull();
    }
  });

  it("存在未作答启用题：返回 null（缺失/过期数据不展示百分比，也不允许确认提交）", () => {
    for (const compute of [webComputeSurveyScore, miniappComputeSurveyScore]) {
      expect(compute(enabledQuestions, { q1: scored(2) })).toBeNull();
      expect(compute(enabledQuestions, { q1: scored(2), q2: scored(3), q3: { answer: "other", awardedScore: 9 } })).toBeNull();
    }
  });

  it("全清零（总分 0）：预览 0%（真实得分，不是 fabricated 100%）", () => {
    const server = serverScore(wipeQuestions, { q1: unscored(), q2: unscored(), q3: unscored() });
    expect(server).toEqual({ totalScore: 0, maxScore: 10, percent: 0 });
    for (const compute of [webComputeSurveyScore, miniappComputeSurveyScore]) {
      expect(compute(wipeQuestions, { q1: unscored(), q2: unscored(), q3: unscored() })).toEqual(server);
    }
  });
});

describe("提交流程静态契约（应用内确认弹窗）", () => {
  const root = resolve(import.meta.dirname, "../..");
  const read = (path) => readFileSync(resolve(root, path), "utf8");

  it("H5 提交确认走 ConfirmModal 且包含不可逆警示与得分占位（无 window.confirm）", () => {
    const source = read("apps/web/src/pages/OtherPage.jsx");
    expect(source).toContain("ConfirmModal");
    expect(source).toContain("问卷提交后无法再次修改");
    expect(source).toContain("得分率暂时无法计算");
    expect(source).toMatch(/confirmGuardRef/); // 同步 guard 防状态刷新前的重复确认
    expect(source).not.toMatch(/window\.confirm\s*\(/);
  });

  it("H5/小程序 弹窗在得分缺失时禁用确认并提供可恢复重试", () => {
    const web = read("apps/web/src/pages/OtherPage.jsx");
    const wxml = read("apps/miniapp/miniprogram/pages/other/index.wxml");
    expect(web).toContain("confirmDisabled={!confirmScore}");
    expect(wxml).toContain("confirmScore ? '当前得分");
    expect(wxml).toContain("重新获取得分");
  });

  it("小程序提交确认走自定义 WXML 弹窗（无 wx.showModal 提交确认）且包含得分占位", () => {
    const wxml = read("apps/miniapp/miniprogram/pages/other/index.wxml");
    const js = read("apps/miniapp/miniprogram/pages/other/index.js");
    expect(wxml).toContain("confirm-mask");
    expect(wxml).toContain("confirmModalSubmit");
    expect(wxml).toContain("得分率暂时无法计算");
    expect(js).not.toMatch(/wx\.showModal\s*\(/);
  });

  it("小程序问题照片选填（无 imageRequired 强制门），H5 同步；首题守卫不再因缺照片拦截", () => {
    const issueWxml = read("apps/miniapp/miniprogram/pages/issue/index.wxml");
    const issueJs = read("apps/miniapp/miniprogram/pages/issue/index.js");
    const issuePage = read("apps/web/src/pages/IssuePage.jsx");
    const webBusiness = read("apps/web/src/utils/business.js");
    const miniBusiness = read("apps/miniapp/miniprogram/utils/business.js");
    expect(issueWxml).toContain("问题照片（选填）");
    expect(issueWxml).not.toContain("question.evidence.imageRequired");
    expect(issueJs).not.toContain("请先上传成功的问题照片");
    expect(issuePage).toContain("问题照片（选填）");
    expect(issuePage).not.toContain("请先上传成功的问题照片");
    // firstIncompleteQuestion 双端镜像：缺照片不视为未完成
    expect(webBusiness).not.toContain("imageRequired && !attachments");
    expect(miniBusiness).not.toContain("imageRequired && !attachments");
  });
});
