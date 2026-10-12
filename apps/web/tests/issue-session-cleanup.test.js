// IssuePage 编辑会话清理时序契约（源码字符串扫描，不绑行号，
// 风格对齐 survey-sync-static.test.js / strict-mode-unloaded-guard.test.js）。
//
// 背景（T4）：编辑会话遗留会锁死同题 30 分钟（后端已改恢复语义，此处钉 H5 侧清理）：
// - 路由离开（SPA）尽力取消，但 StrictMode 双挂载的"假卸载"不得误发取消；
// - 刷新/关页（pagehide）时 setTimeout 不可靠，必须同步直发 keepalive 请求；
// - 已确认/已取消的会话卸载时无需再取消（sessionClosedRef 守卫）；
// - unloadedRef 契约（StrictMode 卸载防护）不得被破坏。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// apps/web/tests → 仓库根需上跳三级（与 survey-sync-static.test.js 同口径）。
const root = resolve(import.meta.dirname, "../../..");
const source = readFileSync(join(root, "apps/web/src/pages/IssuePage.jsx"), "utf8");

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

const effectBody = useEffectBodies(source)[0] || "";
// effect 体内有两处 return () =>（缺参早退的 cleanup 在前）；主 cleanup（卸载清理）取最后一处。
const cleanupBody = braceBlockFrom(effectBody, effectBody.lastIndexOf("return () =>"));
const beaconBody = braceBlock(source, "function sendEditSessionCancel");
const saveBody = braceBlock(source, "const save = async () =>");
const cancelBody = braceBlock(source, "const cancel = async () =>");

describe("IssuePage 编辑会话清理契约（apps/web/src/pages/IssuePage.jsx）", () => {
  it("C1-pagehide 监听注册/移除成对（移除在同一 effect 的 cleanup 内，StrictMode 双挂载安全）", () => {
    expect(source).toContain('addEventListener("pagehide"');
    expect(source).toContain('removeEventListener("pagehide"');
    expect(effectBody, "缺少挂载 effect").toBeTruthy();
    expect(effectBody, "pagehide 注册必须在挂载 effect 体内").toContain('addEventListener("pagehide"');
    expect(effectBody, "removeEventListener 必须位于同一 effect 的 cleanup 内").toContain('removeEventListener("pagehide"');
    expect(effectBody.indexOf("removeEventListener")).toBeGreaterThan(effectBody.indexOf("addEventListener"));
  });

  it("C2-卸载尽力取消受 sessionClosedRef 守卫，且 keepalive 请求内联实现（不经 services）", () => {
    expect(cleanupBody, "缺少 effect 主 cleanup 块").toBeTruthy();
    expect(cleanupBody).toContain("revokeObjectURL", "提取到的必须是含卸载清理的主 cleanup");
    expect(cleanupBody).toContain("!sessionClosedRef.current");
    // keepalive 直发（页面卸载后 setTimeout/普通 fetch 会被浏览器丢弃）
    expect(source).toContain("keepalive: true");
    expect(beaconBody, "缺少 sendEditSessionCancel 尽力取消函数").toBeTruthy();
    expect(beaconBody).toContain("endpointRegistry.drafts.cancelEdit.path");
    expect(beaconBody).toContain("getSession()");
    expect(beaconBody).toContain("keepalive: true");
    expect(beaconBody).toContain("catch(() => {})", "尽力取消必须 fire-and-forget，失败不阻塞不弹错");
  });

  it("C3-SPA 路由离开延迟发送且发送前复查 unloadedRef（StrictMode 重挂载跳过取消），定时器重挂载时清除", () => {
    expect(cleanupBody).toContain("setTimeout(");
    const timerBody = braceBlock(cleanupBody, "setTimeout(");
    expect(timerBody, "延迟取消缺少定时器回调体").toBeTruthy();
    const unloadedIndex = timerBody.indexOf("unloadedRef.current");
    const sendIndex = timerBody.indexOf("sendEditSessionCancel");
    expect(unloadedIndex, "发送前必须复查 unloadedRef").toBeGreaterThanOrEqual(0);
    expect(sendIndex, "定时器回调内必须发送尽力取消").toBeGreaterThanOrEqual(0);
    expect(unloadedIndex).toBeLessThan(sendIndex);
    // pagehide（刷新/关页）路径不走延迟：同步直发
    expect(cleanupBody).toContain("pagehide");
    // 定时器 id 存 ref，重挂载 effect 体里 clearTimeout（防止 StrictMode 假卸载误发）
    expect(source).toContain("leaveCancelTimerRef = useRef(null)");
    expect(effectBody).toContain("clearTimeout(leaveCancelTimerRef.current)");
  });

  it("C4-sessionClosedRef 在确认/取消成功后置位（会话已关闭，卸载无需再取消）", () => {
    expect(source).toContain("sessionClosedRef = useRef(false)");
    expect(saveBody, "缺少 save 函数").toBeTruthy();
    expect(saveBody).toContain("sessionClosedRef.current = true");
    expect(saveBody.indexOf("confirmIssue("), "确认成功后才置位").toBeLessThan(saveBody.indexOf("sessionClosedRef.current = true"));
    expect(cancelBody, "缺少 cancel 函数").toBeTruthy();
    expect(cancelBody).toContain("sessionClosedRef.current = true");
    expect(cancelBody.indexOf("cancelIssue("), "取消成功后才置位").toBeLessThan(cancelBody.indexOf("sessionClosedRef.current = true"));
  });

  it("C5-unloadedRef StrictMode 卸载防护契约未破坏（effect 体内先重置 false，cleanup 置 true 在后）", () => {
    expect(source).toContain("unloadedRef = useRef(false)");
    expect(effectBody).toContain("unloadedRef.current = false");
    expect(effectBody).toContain("unloadedRef.current = true");
    expect(effectBody.indexOf("unloadedRef.current = false")).toBeLessThan(effectBody.indexOf("unloadedRef.current = true"));
  });
});
