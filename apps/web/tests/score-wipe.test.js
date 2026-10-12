// H5 分数清零题 SurveyPage 静态契约（源码字符串扫描，风格对齐 strict-mode-unloaded-guard.test.js）。
//
// 背景：问卷题目下发带 isScoreWipe 布尔（packages/contracts QuestionSchema）。探员端 SurveyPage
// 需差异化呈现清零题：钉死标签、按钮文案「是/否」（是=unscored 整类清零、否=scored）、
// 选「是」先 window.confirm 二次确认（web 适配 wx.showModal，惯例参考 OtherPage R80），
// 确认后仍走既有 openIssue(id, "unscored") 流程（备注/证据在 issue 页，不改 IssuePage）。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// apps/web/tests → 仓库根需上跳三级（与 strict-mode-unloaded-guard.test.js 的 ../../.. 同口径）。
const root = resolve(import.meta.dirname, "../../..");
const surveyPage = readFileSync(join(root, "apps/web/src/pages/SurveyPage.jsx"), "utf8");

describe("分数清零题 SurveyPage 差异化契约（apps/web/src/pages/SurveyPage.jsx）", () => {
  it("visible 映射透传 isScoreWipe 且题卡按其条件渲染钉死标签", () => {
    // 数据流：questions → visible 映射必须显式带上 isScoreWipe（Boolean 归一）。
    expect(surveyPage).toContain("isScoreWipe: Boolean(");
    // 标签文案钉死（与小程序端逐字一致）。
    const label = "本题选「是」将清零本类全部得分";
    const labelAt = surveyPage.indexOf(label);
    expect(labelAt, "缺少钉死标签文案").toBeGreaterThanOrEqual(0);
    // 渲染条件基于 isScoreWipe：标签之前必须存在 question.isScoreWipe 条件。
    const conditionAt = surveyPage.lastIndexOf("question.isScoreWipe ?", labelAt);
    expect(conditionAt, "标签未包裹在 question.isScoreWipe 条件中").toBeGreaterThanOrEqual(0);
  });

  it("按钮文案清零题切换为 是/否，非清零题保持 得分/不得分", () => {
    expect(surveyPage).toContain('{question.isScoreWipe ? "否" : "得分"}');
    expect(surveyPage).toContain('{question.isScoreWipe ? "是" : "不得分"}');
  });

  it("「是」先 window.confirm 二次确认且弹窗文案钉死", () => {
    expect(surveyPage).toContain("window.confirm");
    expect(surveyPage).toContain('window.confirm("确认存在该严重问题？确认后本类目全部题目不得分。")');
  });

  it("确认后仍走 openIssue unscored，非清零题「不得分」保持直通", () => {
    // 确认包装：confirm 通过才进既有 unscored 流程。
    const wrapperAt = surveyPage.indexOf("confirmWipeThenIssue");
    expect(wrapperAt, "缺少 confirmWipeThenIssue 确认包装").toBeGreaterThanOrEqual(0);
    expect(surveyPage).toContain("openIssue(questionId, \"unscored\")");
    // 「不得分」按钮：清零题走确认包装，非清零题直通 openIssue。
    expect(surveyPage).toContain(
      'question.isScoreWipe ? confirmWipeThenIssue(question.id) : openIssue(question.id, "unscored")',
    );
  });
});
