// SurveyPage 草稿同步时序编排静态契约（源码字符串扫描，不绑行号，
// 风格对齐 strict-mode-unloaded-guard.test.js / tests/unit/web-answer-ux-static.test.js）。
//
// 背景（T3）：load()/补发循环/score() 此前会过早把整份草稿 markDraftSynced——
// 部分补发成功或补发失败遗留时，刷新即丢未补发答案（merge 走"服务端态"分支）。
// 本契约钉定："已同步"标记必须以"全部待补发清零"为前提；单题成功只推进
// revision（advanceDraftRevision）；revision 冲突转既有冲突横幅链路；
// 网络恢复经 online 事件重新 load() 且 load 进行中互斥防同题双发。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// apps/web/tests → 仓库根需上跳三级（与 strict-mode-unloaded-guard.test.js 同口径）。
const root = resolve(import.meta.dirname, "../../..");
const source = readFileSync(join(root, "apps/web/src/pages/SurveyPage.jsx"), "utf8");

// 提取 source 中 start 位置起第一个大括号块的完整源码（跳过字符串/注释，防花括号干扰）。
// start 为 -1 或结构不完整时返回 null。
function braceBlockFrom(text, start) {
  if (start === -1) return null;
  const open = text.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i);
      if (end === -1) return null;
      i = end + 1;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

const braceBlock = (text, signature) => braceBlockFrom(text, text.indexOf(signature));

// 提取文件内每个 useEffect(...) 调用的 effect 体源码（箭头函数大括号块，含 cleanup）。
function useEffectBodies(text) {
  const bodies = [];
  let searchFrom = 0;
  for (;;) {
    const body = braceBlockFrom(text, text.indexOf("useEffect(", searchFrom));
    if (body === null) return bodies;
    bodies.push(body);
    searchFrom = text.indexOf(body, searchFrom) + body.length;
  }
}

const loadBody = braceBlock(source, "const load = async () =>");
const scoreBody = braceBlock(source, "const score = async (questionId) =>");

describe("SurveyPage 草稿同步时序契约（apps/web/src/pages/SurveyPage.jsx）", () => {
  it("C1-load 成功路径的 markDraftSynced 受 pendingResync.length === 0 条件保护", () => {
    expect(loadBody, "缺少 load 函数").toBeTruthy();
    const guardIndex = loadBody.indexOf("merged.pendingResync.length === 0");
    expect(guardIndex, "load 成功路径缺少 pendingResync.length === 0 条件").toBeGreaterThanOrEqual(0);
    // 守卫 if 块内必须包含 markDraftSynced（块内容整体同步标记只在该条件成立时执行）。
    const guardedBlock = braceBlock(loadBody, "merged.pendingResync.length === 0");
    expect(guardedBlock, "pendingResync 清零条件后必须跟块语句").toBeTruthy();
    expect(guardedBlock).toContain("markDraftSynced(");
    // 守卫之前不得出现无条件 markDraftSynced（旧缺陷形状：saveDraft 后直接整份标记）。
    const firstSynced = loadBody.indexOf("markDraftSynced(");
    expect(firstSynced, "load 内首个 markDraftSynced 必须位于 pendingResync 守卫之后").toBeGreaterThan(guardIndex);
  });

  it("C2-存在 advanceDraftRevision 的导入与调用（部分成功仅推进 revision）", () => {
    expect(source).toMatch(/import\s*\{[^}]*advanceDraftRevision[^}]*\}\s*from\s*"\.\.\/store\/survey\.js"/);
    expect(source).toContain("advanceDraftRevision(");
  });

  it("C3-补发循环按题号升序（找不到题号的排最后）", () => {
    expect(source).toContain("const pendingQuestionOrder = (");
    const helperBody = braceBlock(source, "const pendingQuestionOrder = (");
    expect(helperBody, "缺少 pendingQuestionOrder 函数体").toBeTruthy();
    expect(helperBody).toContain(".sort(");
    expect(helperBody).toContain("undefined", "缺号回退：找不到题号的排最后");
    expect(loadBody).toContain("pendingQuestionOrder(merged.pendingResync");
  });

  it("C4-online 事件监听与移除成对（移除在同一 effect 的 cleanup，StrictMode 双挂载安全）", () => {
    expect(source).toContain('addEventListener("online"');
    expect(source).toContain('removeEventListener("online"');
    const onlineEffect = useEffectBodies(source).find((body) => body.includes('addEventListener("online"'));
    expect(onlineEffect, "缺少注册 online 监听的 effect").toBeTruthy();
    expect(onlineEffect, "removeEventListener 必须位于同一 effect 的 cleanup 内").toContain('removeEventListener("online"');
  });

  it("C5-score 成功分支条件化标记，失败把该题重新加入待补发集合", () => {
    expect(scoreBody, "缺少 score 函数").toBeTruthy();
    const sizeGuard = scoreBody.indexOf("pendingResyncRef.current.size === 0");
    expect(sizeGuard, "score 成功分支缺少 pendingResyncRef 清零条件").toBeGreaterThanOrEqual(0);
    const syncedIndex = scoreBody.indexOf("markDraftSynced(");
    expect(syncedIndex, "score 内 markDraftSynced 必须在清零守卫之后").toBeGreaterThan(sizeGuard);
    expect(scoreBody).toContain("advanceDraftRevision(");
    expect(scoreBody).toContain("pendingResyncRef.current.add(questionId)", "保存失败须把该题留在待补发集合");
  });

  it("C6-load 进行中互斥（online 恢复与初始加载/手点重试并发时防同题双发）", () => {
    expect(source).toContain("loadInProgressRef = useRef(false)");
    expect(loadBody).toContain("loadInProgressRef.current = true");
    expect(loadBody).toContain("loadInProgressRef.current = false");
    expect(loadBody.indexOf("if (loadInProgressRef.current) return")).toBeGreaterThanOrEqual(0);
  });
});
