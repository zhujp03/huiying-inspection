// Content-based contract drift check.
// Generates the three contract artifacts into a temp directory and compares
// SHA-256 hashes against the files on disk. Unlike `git diff --exit-code`,
// this detects drift even when the repository has no HEAD or the generated
// files are not yet tracked.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  "apps/miniapp/miniprogram/services/contracts.generated.js",
  "apps/api/src/generated/route-schemas.js",
  "apps/api/openapi.json",
];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const temp = mkdtempSync(join(tmpdir(), "junde-contracts-"));
try {
  const result = spawnSync(process.execPath, ["packages/contracts/scripts/generate.mjs", "--out", temp], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    console.error("contracts generation failed:");
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(1);
  }
  const failures = [];
  for (const relative of targets) {
    const diskPath = resolve(root, relative);
    const generatedPath = resolve(temp, relative);
    let diskHash = null;
    try { diskHash = sha256(readFileSync(diskPath)); } catch { failures.push(`${relative}: missing on disk (generate with npm run contracts:generate)`); continue; }
    const generatedHash = sha256(readFileSync(generatedPath));
    if (diskHash !== generatedHash) failures.push(`${relative}: DRIFTED — on-disk file differs from packages/contracts endpoint registry (run npm run contracts:generate)`);
  }
  if (failures.length > 0) {
    console.error("contracts:check FAILED");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`contracts:check PASS (${targets.length} artifacts match the endpoint registry)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
