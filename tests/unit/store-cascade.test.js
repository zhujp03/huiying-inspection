import { describe, expect, it } from "vitest";
import { brandGroups, businessNoOptions, storeOptions, cascadeFromStore } from "../../apps/admin/src/utils/store-cascade.js";

const brands = [
  { id: "b1", name: "川菜人家", active: true },
  { id: "b2", name: "粤味轩", active: true },
];

const stores = [
  { id: "s1", name: "春熙店", businessNo: "C001", brandId: "b1", brandName: "川菜人家" },
  { id: "s2", name: "天府店", businessNo: "C002", brandId: "b1", brandName: "川菜人家" },
  { id: "s3", name: "天河店", businessNo: "C003", brandId: "b2", brandName: "粤味轩" },
  { id: "s4", name: "珠江店", businessNo: "C001", brandId: "b2", brandName: "粤味轩" },
  { id: "s5", name: "佛山店", businessNo: "C003", brandId: "b2", brandName: "粤味轩" },
  { id: "s6", name: "未挂靠店", businessNo: "N001", brandId: null },
  { id: "s7", name: "老店", businessNo: "N002" }, // brandId 为 undefined，视同 null
];

const unknownBrandStore = { id: "s8", name: "杂牌店", businessNo: "Z001", brandId: "b9", brandName: "野生品牌" };
const storesWithUnknown = [...stores, unknownBrandStore];

describe("store cascade", () => {
  describe("brandGroups", () => {
    it("按 brands 顺序分组，未分品牌组存在且排在最后", () => {
      const groups = brandGroups(stores, brands);
      expect(groups.map((g) => g.brandId)).toEqual(["b1", "b2", null]);
      expect(groups[0]).toEqual({ brandId: "b1", label: "川菜人家", stores: [stores[0], stores[1]] });
      expect(groups[1]).toEqual({ brandId: "b2", label: "粤味轩", stores: [stores[2], stores[3], stores[4]] });
      expect(groups[2]).toEqual({ brandId: null, label: "未分品牌", stores: [stores[5], stores[6]] });
    });

    it("未知品牌门店独立成组且 label 取 brandName", () => {
      const groups = brandGroups(storesWithUnknown, brands);
      expect(groups.map((g) => g.brandId)).toEqual(["b1", "b2", "b9", null]);
      expect(groups[2]).toEqual({ brandId: "b9", label: "野生品牌", stores: [unknownBrandStore] });
    });

    it("没有未分品牌门店时不出现未分品牌组", () => {
      const groups = brandGroups(stores.slice(0, 5), brands);
      expect(groups.map((g) => g.brandId)).toEqual(["b1", "b2"]);
    });

    it("stores 为空时只有 brands 的空组且无未分品牌组", () => {
      const groups = brandGroups([], brands);
      expect(groups).toEqual([
        { brandId: "b1", label: "川菜人家", stores: [] },
        { brandId: "b2", label: "粤味轩", stores: [] },
      ]);
    });

    it("brands 为空时所有带 brandId 的门店按首现顺序独立成组，未分品牌组最后", () => {
      const groups = brandGroups(storesWithUnknown, []);
      expect(groups).toEqual([
        { brandId: "b1", label: "川菜人家", stores: [stores[0], stores[1]] },
        { brandId: "b2", label: "粤味轩", stores: [stores[2], stores[3], stores[4]] },
        { brandId: "b9", label: "野生品牌", stores: [unknownBrandStore] },
        { brandId: null, label: "未分品牌", stores: [stores[5], stores[6]] },
      ]);
    });
  });

  describe("businessNoOptions", () => {
    it("按 brandId 过滤并按首现顺序去重", () => {
      expect(businessNoOptions(stores, "b1")).toEqual(["C001", "C002"]);
      // b2 门店店号依次为 C003/C001/C003，去重后按首现顺序 C003 在前
      expect(businessNoOptions(stores, "b2")).toEqual(["C003", "C001"]);
    });

    it("空组返回空数组", () => {
      expect(businessNoOptions(stores, "bx")).toEqual([]);
    });

    it("brandId 为 null 时返回未分品牌组的店号", () => {
      expect(businessNoOptions(stores, null)).toEqual(["N001", "N002"]);
    });
  });

  describe("storeOptions", () => {
    it("按 brandId 与 businessNo 双重过滤并保持原顺序", () => {
      expect(storeOptions(stores, "b1", "C001")).toEqual([stores[0]]);
      expect(storeOptions(stores, "b2", "C003")).toEqual([stores[2], stores[4]]);
    });

    it("某组某店号恰好一家门店时返回长度 1", () => {
      const matched = storeOptions(stores, "b2", "C001");
      expect(matched).toHaveLength(1);
      expect(matched[0].id).toBe("s4");
    });

    it("用 A 品牌查询只存在于 B 品牌的店号返回空数组", () => {
      expect(storeOptions(stores, "b1", "C003")).toEqual([]);
    });

    it("brandId 为 null 时按未分品牌组过滤", () => {
      expect(storeOptions(stores, null, "N001")).toEqual([stores[5]]);
    });
  });

  describe("cascadeFromStore", () => {
    it("命中已分品牌门店时回填 brandId 与 businessNo", () => {
      expect(cascadeFromStore(stores, "s1")).toEqual({ brandId: "b1", businessNo: "C001" });
    });

    it("未分品牌门店的 brandId 归一为 null（null 与 undefined 两种）", () => {
      expect(cascadeFromStore(stores, "s6")).toEqual({ brandId: null, businessNo: "N001" });
      expect(cascadeFromStore(stores, "s7")).toEqual({ brandId: null, businessNo: "N002" });
    });

    it("storeId 为空串或未命中时返回 null", () => {
      expect(cascadeFromStore(stores, "")).toBeNull();
      expect(cascadeFromStore(stores, "nope")).toBeNull();
    });
  });
});
