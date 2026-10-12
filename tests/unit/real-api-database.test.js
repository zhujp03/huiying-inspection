// real-api-database 助手安全回归：测试库派生必须隔离（回环 + junde_realapi 双闸），
// 源码不再内嵌任何连接串字面量；凭证只经环境变量/根 .env 流转。
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveRealApiTestDatabaseUrl, loadRootEnvFile, postgresAdminUrl, REAL_API_TEST_DB_NAME } from "../../tests/e2e/real-api-database.mjs";

describe("real api test database derivation", () => {
  it("derives the isolated loopback test database from an admin/source url", () => {
    const derived = deriveRealApiTestDatabaseUrl({ databaseUrl: "postgresql://u:p@127.0.0.1:5433/junde" });
    expect(derived).toBe("postgresql://u:p@127.0.0.1:5433/junde_realapi");
    expect(derived.includes(`/${REAL_API_TEST_DB_NAME}`)).toBe(true);
  });

  it("forces the test database name even when the source url names another database", () => {
    // 源 junde / 其它库的连接串只作凭证来源；派生目标一律强制为 junde_realapi。
    const derived = deriveRealApiTestDatabaseUrl({ databaseUrl: "postgresql://u:p@localhost:5432/junde" });
    expect(new URL(derived).pathname).toBe("/junde_realapi");
  });

  it("rejects non-loopback targets (production/cloud) with fail-closed", () => {
    expect(() => deriveRealApiTestDatabaseUrl({ databaseUrl: "postgresql://u:p@db.example.internal:5432/junde" })).toThrow(/回环/);
    expect(() => deriveRealApiTestDatabaseUrl({ databaseUrl: "postgresql://u:p@10.0.0.8:5432/junde" })).toThrow(/回环/);
    expect(() => deriveRealApiTestDatabaseUrl({ adminDatabaseUrl: "postgresql://u:p@postgres.internal:5432/junde" })).toThrow(/回环/);
  });

  it("requires a connection string (no embedded defaults in source)", () => {
    expect(() => deriveRealApiTestDatabaseUrl({})).toThrow(/不内嵌凭证/);
    expect(() => deriveRealApiTestDatabaseUrl({ databaseUrl: "" })).toThrow(/不内嵌凭证/);
    expect(() => deriveRealApiTestDatabaseUrl({ databaseUrl: "not-a-url" })).toThrow(/无法解析/);
    expect(() => postgresAdminUrl("")).toThrow(/不内嵌凭证|管理连接/);
  });

  it("derives the server-level admin url and keeps loopback enforcement", () => {
    expect(postgresAdminUrl("postgresql://u:p@127.0.0.1:5433/junde")).toBe("postgresql://u:p@127.0.0.1:5433/postgres");
    expect(() => postgresAdminUrl("postgresql://u:p@db.cloud.internal:5432/junde")).toThrow(/回环/);
  });

  it("loads the root env file only when it exists, without printing values", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "realapi-env-"));
    const marker = `REALAPI_MARKER_${Date.now()}`;
    expect(loadRootEnvFile(path.join(dir, "missing.env"))).toBe(false);
    await writeFile(path.join(dir, ".env"), `${marker}=loaded\n`);
    expect(loadRootEnvFile(path.join(dir, ".env"))).toBe(true);
    expect(process.env[marker]).toBe("loaded");
    delete process.env[marker];
    await rm(dir, { recursive: true, force: true });
  });
});
