// T3 任务与提交语义：GET /api/assignments/:id/questionnaire 已提交守卫静态契约。
//
// 背景：该端点此前只做归属校验，查 survey_attempts 仅取 id、不校验 attempt 状态，
// attempt 已 submitted 后仍返回问卷全文，与同类读取入口（GET drafts/:id、小票附件列表）不一致。
// 契约：submitted → 409 QUESTIONNAIRE_SUBMITTED，文案与 drafts 端点逐字一致；
// 归属校验双保险（assignmentReference + attemptForOwner）与无 attempt 的
// QUESTIONNAIRE_NOT_STARTED 分支保持不变。
// 风格对齐 web-answer-ux-static.test.js（源码字符串扫描，不启动服务）。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const routesSource = readFileSync(join(root, "apps/api/src/batch3/routes.js"), "utf8");

// 端点切片：从 questionnaire 路由注册起，到下一个两级缩进的 `app.` 注册为止
// （注册体内行缩进均 ≥4 空格，`\n  app.` 只会命中下一个路由注册，不会混入 drafts 端点）。
const endpointStart = routesSource.indexOf('app.get("/api/assignments/:id/questionnaire"');
const endpointNextAt = routesSource.indexOf("\n  app.", Math.max(endpointStart, 0) + 1);
const endpoint = endpointStart >= 0 && endpointNextAt > endpointStart ? routesSource.slice(endpointStart, endpointNextAt) : "";

// drafts 端点切片（守卫文案比对基准：batch3 内 GET /api/questionnaires/secret/drafts/:id）。
const draftsStart = routesSource.indexOf('app.get("/api/questionnaires/secret/drafts/:id"');
const draftsNextAt = routesSource.indexOf("\n  app.", Math.max(draftsStart, 0) + 1);
const draftsEndpoint = draftsStart >= 0 && draftsNextAt > draftsStart ? routesSource.slice(draftsStart, draftsNextAt) : "";

const submittedMessage = (slice) => slice.match(/QUESTIONNAIRE_SUBMITTED", "([^"]+)"/)?.[1] || "";

describe("questionnaire 读取守卫静态契约（apps/api/src/batch3/routes.js）", () => {
  it("端点切片提取有效且未混入 drafts 端点", () => {
    expect(endpointStart).toBeGreaterThanOrEqual(0);
    expect(endpoint).toContain('app.get("/api/assignments/:id/questionnaire"');
    expect(endpoint).not.toContain('app.get("/api/questionnaires/secret/drafts/:id"');
    expect(draftsEndpoint).toContain("QUESTIONNAIRE_SUBMITTED");
  });

  it("attempt 已 submitted 时命中 QUESTIONNAIRE_SUBMITTED 守卫", () => {
    expect(endpoint).toContain('found.status === "submitted"');
    expect(endpoint).toContain("QUESTIONNAIRE_SUBMITTED");
  });

  it("归属校验双保险保留：assignmentReference + attemptForOwner", () => {
    expect(endpoint).toContain("assignmentReference(assignmentId, session.user_id)");
    expect(endpoint).toContain("attemptForOwner");
  });

  it("无 attempt 时 QUESTIONNAIRE_NOT_STARTED 分支保留", () => {
    expect(endpoint).toContain("QUESTIONNAIRE_NOT_STARTED");
  });

  it("守卫文案与 drafts 端点逐字一致", () => {
    const guardMessage = submittedMessage(endpoint);
    const draftsMessage = submittedMessage(draftsEndpoint);
    expect(draftsMessage, "drafts 基准切片应能提取守卫文案").not.toBe("");
    expect(guardMessage).toBe(draftsMessage);
    expect(guardMessage).toBe("该任务已提交，不能回看问卷内容");
  });
});
