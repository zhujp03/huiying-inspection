import { describe, expect, it, vi } from "vitest";
import { assertRegionCovered, assertStoreCovered, authorizeAdmin, hasFullScope, storeScopeFilter } from "../../apps/api/src/auth/authorization.js";

// 层级固定为 省 P → 市 C → 区县 D，与 batch5/stats 的三层子树语义对照
const PROVINCE = "11111111-1111-7111-1111-111111111111";
const CITY = "22222222-2222-7222-2222-222222222222";
const DISTRICT = "33333333-3333-7333-3333-333333333333";
const STORE_ID = "44444444-4444-7444-4444-444444444444";
const OTHER_STORE = "55555555-5555-7555-5555-555555555555";
const USER_PARAM = "$3";

const scope = (scopeType, regionId = null, storeId = null) => ({ scope_type: scopeType, region_id: regionId, store_id: storeId });
// 假 client：assertStoreCovered/assertRegionCovered 查门店或区域的 parent 链
const regionChainRow = { region_id: DISTRICT, parent_id: CITY, grandparent_id: PROVINCE };
const fakeClient = (rows) => {
  const calls = [];
  return { calls, query: async (text, params) => { calls.push({ text, params }); return { rows }; } };
};
const fail = () => vi.fn();

describe("authorizeAdmin", () => {
  const fakePool = ({ permissionRows, scopeRows }) => {
    const queries = [];
    return {
      queries,
      query: async (text, params) => {
        queries.push({ text, params });
        if (text.includes("user_data_scopes")) return { rows: scopeRows };
        return { rows: permissionRows };
      },
    };
  };

  it("有权限时返回 allowed=true 并携带 user_data_scopes 行数组", async () => {
    const rows = [scope("region", PROVINCE), scope("all")];
    const pool = fakePool({ permissionRows: [{ "?column?": 1 }], scopeRows: rows });
    const result = await authorizeAdmin(pool, { userId: "u1", permission: "campaign:manage" });
    expect(result).toEqual({ allowed: true, scopes: rows });
    expect(result.scopes).toBe(rows);
  });

  it("无权限时返回 allowed=false、scopes 为空，且不再查询范围表", async () => {
    const pool = fakePool({ permissionRows: [], scopeRows: [scope("all")] });
    const result = await authorizeAdmin(pool, { userId: "u1", permission: "campaign:manage" });
    expect(result).toEqual({ allowed: false, scopes: [] });
    expect(pool.queries).toHaveLength(1);
  });
});

describe("hasFullScope", () => {
  it("scopes 含 scope_type=all 时为 true", () => {
    expect(hasFullScope([scope("region", PROVINCE), scope("all")])).toBe(true);
  });

  it("仅 region/store/空数组/undefined 时为 false", () => {
    expect(hasFullScope([scope("region", PROVINCE)])).toBe(false);
    expect(hasFullScope([scope("store", null, STORE_ID)])).toBe(false);
    expect(hasFullScope([])).toBe(false);
    expect(hasFullScope(undefined)).toBe(false);
  });
});

describe("storeScopeFilter", () => {
  it("all 范围返回 null（调用方跳过过滤）", () => {
    expect(storeScopeFilter({ scopes: [scope("all")], userParam: USER_PARAM })).toBeNull();
  });

  it("region 范围返回与 batch5 同构的三层子树 EXISTS SQL（别名可替换）", () => {
    const sql = storeScopeFilter({ scopes: [scope("region", PROVINCE)], storeAlias: "s", regionAlias: "r", userParam: USER_PARAM });
    expect(sql).toContain("EXISTS (SELECT 1 FROM user_data_scopes scope");
    expect(sql).toContain(`scope.user_id=${USER_PARAM}`);
    expect(sql).toContain("scope.revoked_at IS NULL");
    expect(sql).toContain("scope.scope_type='all'");
    expect(sql).toContain(`scope.region_id=r.id OR scope.region_id=r.parent_id OR scope.region_id=(SELECT parent_id FROM regions WHERE id=r.parent_id)`);
    expect(sql).toContain(`scope.scope_type='store' AND scope.store_id=s.id`);
  });

  it("自定义别名逐字替换（batch5 原别名 region/store 也能还原）", () => {
    const sql = storeScopeFilter({ scopes: [scope("store", null, STORE_ID)], storeAlias: "store", regionAlias: "region", userParam: "$7" });
    expect(sql).toContain("scope.region_id=region.id OR scope.region_id=region.parent_id OR scope.region_id=(SELECT parent_id FROM regions WHERE id=region.parent_id)");
    expect(sql).toContain("scope.store_id=store.id");
    expect(sql).toContain("scope.user_id=$7");
  });
});

describe("assertStoreCovered", () => {
  it("all 范围直接放行且不查询", async () => {
    const client = fakeClient([regionChainRow]);
    const onFail = fail();
    await assertStoreCovered(client, [scope("all")], STORE_ID, onFail);
    expect(client.calls).toHaveLength(0);
    expect(onFail).not.toHaveBeenCalled();
  });

  it.each([
    ["区县层命中", DISTRICT],
    ["市级层命中", CITY],
    ["省级层命中", PROVINCE],
  ])("region 范围按三层子树命中：%s", async (_label, regionId) => {
    const client = fakeClient([regionChainRow]);
    const onFail = fail();
    await assertStoreCovered(client, [scope("region", regionId)], STORE_ID, onFail);
    expect(client.calls[0].params).toEqual([STORE_ID]);
    expect(onFail).not.toHaveBeenCalled();
  });

  it("store 范围精确匹配目标门店时放行", async () => {
    const client = fakeClient([regionChainRow]);
    const onFail = fail();
    await assertStoreCovered(client, [scope("store", null, STORE_ID)], STORE_ID, onFail);
    expect(onFail).not.toHaveBeenCalled();
  });

  it("region 与 store 范围均未覆盖时调用 fail", async () => {
    const client = fakeClient([regionChainRow]);
    const onFail = fail();
    await assertStoreCovered(client, [scope("region", "99999999-9999-7999-9999-999999999999"), scope("store", null, OTHER_STORE)], STORE_ID, onFail);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("门店不存在（空结果）时调用 fail（避免探测）", async () => {
    const client = fakeClient([]);
    const onFail = fail();
    await assertStoreCovered(client, [scope("region", PROVINCE)], STORE_ID, onFail);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("链上 null 祖先不得与 null scope.region_id 误匹配", async () => {
    const client = fakeClient([{ region_id: DISTRICT, parent_id: CITY, grandparent_id: null }]);
    const onFail = fail();
    await assertStoreCovered(client, [scope("region", null)], STORE_ID, onFail);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("fail 由调用方注入（可抛 403 业务错误）", async () => {
    const client = fakeClient([regionChainRow]);
    await expect(assertStoreCovered(client, [scope("store", null, OTHER_STORE)], STORE_ID, () => {
      throw Object.assign(new Error("该数据不在你的管理范围内"), { statusCode: 403 });
    })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("assertRegionCovered", () => {
  it("all 范围直接放行且不查询", async () => {
    const client = fakeClient([{ parent_id: CITY, grandparent_id: PROVINCE }]);
    const onFail = fail();
    await assertRegionCovered(client, [scope("all")], DISTRICT, onFail);
    expect(client.calls).toHaveLength(0);
    expect(onFail).not.toHaveBeenCalled();
  });

  it.each([
    ["region 范围等于目标区域自身", DISTRICT],
    ["region 范围是目标区域的父级", CITY],
    ["region 范围是目标区域的祖父级", PROVINCE],
  ])("%s时放行", async (_label, scopeRegionId) => {
    const client = fakeClient([{ parent_id: CITY, grandparent_id: PROVINCE }]);
    const onFail = fail();
    await assertRegionCovered(client, [scope("region", scopeRegionId)], DISTRICT, onFail);
    expect(onFail).not.toHaveBeenCalled();
  });

  it("store 范围管理员对任意区域都不放行（新建门店无既定 store_id 可匹配）", async () => {
    const client = fakeClient([{ parent_id: CITY, grandparent_id: PROVINCE }]);
    const onFail = fail();
    await assertRegionCovered(client, [scope("store", null, STORE_ID)], DISTRICT, onFail);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("区域不存在（空结果）时调用 fail", async () => {
    const client = fakeClient([]);
    const onFail = fail();
    await assertRegionCovered(client, [scope("region", PROVINCE)], DISTRICT, onFail);
    expect(onFail).toHaveBeenCalledTimes(1);
  });
});
