// H5 StrictMode 卸载防护静态契约（源码字符串扫描，风格对齐 tests/unit/miniapp-pages-static.test.js）。
//
// 背景：main.jsx 启用 React.StrictMode，开发模式双挂载会先模拟卸载再重挂载。
// 若挂载 effect 只在 cleanup 里把 unloadedRef 置 true、重挂载时不恢复 false，
// 第二次挂载后所有 if (unloadedRef.current) return 守卫会吞掉全部异步回调，
// 页面永久卡在骨架屏。本契约钉死：置 true 的 effect 必须先在 effect 体内重置 false，
// 且不得以删除 React.StrictMode 的方式绕过。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// apps/web/tests → 仓库根需上跳三级（与 anti-omission.test.js 的 ../../../ 同口径）。
const root = resolve(import.meta.dirname, "../../..");
const pagesDir = join(root, "apps/web/src/pages");
const readPage = (name) => readFileSync(join(pagesDir, name), "utf8");

const GUARDED_PAGES = [
  "HomePage.jsx",
  "SchedulePage.jsx",
  "TaskPage.jsx",
  "SurveyPage.jsx",
  "DishesPage.jsx",
  "IssuePage.jsx",
  "OtherPage.jsx",
];

// 提取文件内每个 useEffect(...) 调用的 effect 体源码（箭头函数大括号块）。
// 大括号配对时跳过字符串 / 模板字符串 / 注释，避免其中的花括号干扰层级统计。
function useEffectBodies(source) {
  const bodies = [];
  let searchFrom = 0;
  for (;;) {
    const callStart = source.indexOf("useEffect(", searchFrom);
    if (callStart === -1) return bodies;
    const bodyOpen = source.indexOf("{", callStart);
    if (bodyOpen === -1) return bodies;
    let depth = 0;
    let i = bodyOpen;
    let bodyClose = -1;
    while (i < source.length && bodyClose === -1) {
      const ch = source[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        i += 1;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === "\\") i += 1;
          i += 1;
        }
      } else if (ch === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") i += 1;
      } else if (ch === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i);
        if (end === -1) return bodies;
        i = end + 1;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) bodyClose = i;
      }
      i += 1;
    }
    if (bodyClose === -1) return bodies;
    bodies.push(source.slice(bodyOpen, bodyClose + 1));
    searchFrom = bodyClose + 1;
  }
}

describe("H5 StrictMode 卸载防护契约（apps/web/src/pages）", () => {
  it("七个异步页面均声明 unloadedRef 守卫", () => {
    for (const name of GUARDED_PAGES) {
      const source = readPage(name);
      expect(source, name).toContain("unloadedRef = useRef(false)");
      expect(source, name).toContain("unloadedRef.current");
    }
  });

  it("置 true 的 effect 体内必须先重置 false（StrictMode 二次挂载后守卫可恢复）", () => {
    for (const name of GUARDED_PAGES) {
      const source = readPage(name);
      const guardEffects = useEffectBodies(source).filter((body) =>
        body.includes("unloadedRef.current = true"),
      );
      // 防护不得被整体删除：至少一个 effect 在卸载 cleanup 置 true。
      expect(guardEffects.length, `${name} 缺少置 true 的卸载防护 effect`).toBeGreaterThan(0);
      guardEffects.forEach((body, index) => {
        const label = `${name} 第 ${index + 1} 个置 true 的 effect`;
        const resetAt = body.indexOf("unloadedRef.current = false");
        expect(resetAt, `${label} 缺少先行的 unloadedRef.current = false 重置`).toBeGreaterThanOrEqual(0);
        expect(
          resetAt < body.indexOf("unloadedRef.current = true"),
          `${label} 的 false 重置必须位于置 true 之前`,
        ).toBe(true);
      });
    }
  });

  it("main.jsx 保留 React.StrictMode（不得以删除 StrictMode 的方式修复）", () => {
    const main = readFileSync(join(root, "apps/web/src/main.jsx"), "utf8");
    expect(main).toContain("<React.StrictMode>");
    expect(main).toContain("</React.StrictMode>");
  });
});
