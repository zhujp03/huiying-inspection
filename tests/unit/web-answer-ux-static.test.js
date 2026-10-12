import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const surveyPage = readFileSync(join(root, "apps/web/src/pages/SurveyPage.jsx"), "utf8");
const issuePage = readFileSync(join(root, "apps/web/src/pages/IssuePage.jsx"), "utf8");

describe("Web 答题页静态契约（apps/web 探员端）", () => {
  it("探员端答题页不得出现分值概念", () => {
    for (const source of [surveyPage, issuePage]) {
      expect(source).not.toContain("{question.score}");
      expect(source).not.toMatch(/\.score}分/);
      expect(source).not.toContain("maxScore");
      expect(source).not.toContain("满分");
      expect(source).not.toContain("分值");
    }
  });

  it("不得分确认：空说明禁用确认按钮并就地提示（toast 校验保留作兜底）", () => {
    expect(issuePage).toContain("TextArea");
    expect(issuePage).toContain("remark.trim()");
    expect(issuePage).toContain("remarkMissing");
    expect(issuePage).toContain("disabled={saving || remarkMissing}");
    expect(issuePage).toContain("请填写问题说明后再确认");
    expect(issuePage).toContain("请填写问题说明"); // save() 内 toast 前置校验兜底
  });

  it("得分/不得分作答按钮文案保留", () => {
    expect(surveyPage).toContain("得分");
    expect(surveyPage).toContain("不得分");
  });
});
