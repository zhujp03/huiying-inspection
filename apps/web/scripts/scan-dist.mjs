// apps/web dist 产物零域名扫描 —— 发布门禁 web 段的收尾步骤（verify:offline 中 build 之后执行）。
// 判定口径与 tests/rules/r00-r33.test.js 的 R0 完全一致：
//   ① https?:// 字面量；② VITE_ / API_BASE / import.meta.env 构建期注入标识；
//   ③ 引号内协议相对地址（//host 形式）。
// dist 专属窄豁免（仅 dist 文件生效，与 r00-r33.test.js 的 DIST_ONLY_EXEMPT_PREFIXES 同口径，
// PM 裁决 2026-10-10）：react-dom 产物内嵌的 XML 命名空间 URI（http://www.w3.org/…）与
// React 错误码文档前缀（https://react.dev/errors/）为 vendor 不可避免内容、非 API 地址，
// 逐行剥离这两个前缀串后再判定。
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url)); // apps/web/
const distRoot = join(webRoot, "dist");
if (!existsSync(distRoot)) {
  console.error("dist 不存在：请先构建（npm --prefix apps/web run build）");
  process.exit(1);
}

const listFiles = (directory) =>
  readdirSync(directory).flatMap((entry) => {
    const entryPath = join(directory, entry);
    return statSync(entryPath).isDirectory() ? listFiles(entryPath) : [entryPath];
  });

const DIST_ONLY_EXEMPT_PREFIXES = ["http://www.w3.org/", "https://react.dev/errors/"];

const violations = [];
for (const file of listFiles(distRoot)) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, lineIndex) => {
      const stripped = DIST_ONLY_EXEMPT_PREFIXES.reduce((acc, prefix) => acc.split(prefix).join(""), line);
      if (/https?:\/\//.test(stripped) || stripped.includes("VITE_") || stripped.includes("API_BASE") || stripped.includes("import.meta.env") || /["'`]\/\/[a-z0-9.-]+\.[a-z]{2,}\//i.test(stripped)) {
        violations.push(`${relative(webRoot, file)}:${lineIndex + 1}  ${line.trim().slice(0, 120)}`);
      }
    });
}

assert.equal(violations.length, 0, `web dist scan: 发现 ${violations.length} 处零域名/构建期注入违规：\n${violations.join("\n")}`);
console.log("web dist scan: passed");
