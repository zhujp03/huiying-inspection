import { describe, expect, it } from "vitest";
import { createAssignmentCache } from "../../apps/miniapp/miniprogram/store/assignments-cache.js";

describe("assignment cache", () => {
  it("hits within TTL for the same user", () => {
    let clock = 0;
    const cache = createAssignmentCache({ now: () => clock });
    cache.set("u1", [{ id: "a" }]);
    expect(cache.get("u1")?.items).toEqual([{ id: "a" }]);
  });

  it("isolates entries by userId", () => {
    const cache = createAssignmentCache();
    cache.set("u1", [{ id: "a" }]);
    cache.set("u2", [{ id: "b" }]);
    expect(cache.get("u1")?.items).toEqual([{ id: "a" }]);
    expect(cache.get("u2")?.items).toEqual([{ id: "b" }]);
    expect(cache.get("u3")).toBeNull();
  });

  it("expires after TTL and evicts the stale entry", () => {
    let clock = 1000;
    const cache = createAssignmentCache({ now: () => clock, ttlMs: 15000 });
    cache.set("u1", [{ id: "a" }]);
    clock = 1000 + 15000; // 恰好到期
    expect(cache.get("u1")).toBeNull();
    expect(cache.get("u1")).toBeNull(); // 过期项已被清理
  });

  it("force skips the cache", () => {
    const cache = createAssignmentCache();
    cache.set("u1", [{ id: "a" }]);
    expect(cache.get("u1", { force: true })).toBeNull();
  });

  it("ignores set without userId", () => {
    const cache = createAssignmentCache();
    cache.set("", [{ id: "a" }]);
    cache.set(null, [{ id: "a" }]);
    expect(cache.get("")).toBeNull();
  });

  it("clear wipes all users (login / logout / 401 path)", () => {
    const cache = createAssignmentCache();
    cache.set("u1", [{ id: "a" }]);
    cache.set("u2", [{ id: "b" }]);
    cache.clear();
    expect(cache.get("u1")).toBeNull();
    expect(cache.get("u2")).toBeNull();
  });
});
