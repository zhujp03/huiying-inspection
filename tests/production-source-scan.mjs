import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const roots = [
  "apps/api/src",
  "apps/worker/src",
  "apps/ocr-service",
  "apps/admin/src",
  "apps/miniapp/miniprogram",
  "packages/contracts",
  "packages/domain",
  "ops",
];
const sourceExtensions = new Set([".js", ".jsx", ".py", ".wxml"]);
const forbidden = [
  "USE_MOCK",
  "mockRequest",
  "task-current",
  "survey-current",
  "fixture adapter",
  "fake OCR result",
  "fake COS success",
  "debug admin",
];

function collect(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? collect(path) : [path];
  });
}

for (const relative of roots) {
  for (const file of collect(join(root, relative)).filter((path) => sourceExtensions.has(extname(path)))) {
    const source = readFileSync(file, "utf8");
    for (const value of forbidden) assert.equal(source.toLowerCase().includes(value.toLowerCase()), false, `${file} must not contain production-forbidden marker: ${value}`);
  }
}

console.log("production source scan: passed");
