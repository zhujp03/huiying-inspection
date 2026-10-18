import { describe, expect, it } from "vitest";
import {
  brandGroups, businessNoOptions, compareBusinessNoNatural, cascadeFromStore, duplicateStoreNames,
  storeNameOptionLabel, storeNameOptions, storeOptions,
} from "../../apps/admin/src/utils/store-cascade.js";

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

  describe("compareBusinessNoNatural", () => {
    it("数字段按数值排序：2 在 9、10 前", () => {
      const ordered = ["JD-10", "JD-2", "JD-9"].sort(compareBusinessNoNatural);
      expect(ordered).toEqual(["JD-2", "JD-9", "JD-10"]);
    });

    it("前导零数字段数值相等返回 0（由调用方用店号文本/id 兜底）", () => {
      expect(compareBusinessNoNatural("S-007", "S-7")).toBe(0);
      expect(compareBusinessNoNatural("007", "7")).toBe(0);
    });

    it("数字段超长时按位数与逐位比较（不受浮点精度影响）", () => {
      const long = "9".repeat(40);
      const bigger = `${long}1`;
      expect(compareBusinessNoNatural(long, bigger)).toBe(-1);
      expect(compareBusinessNoNatural(bigger, long)).toBe(1);
      expect(compareBusinessNoNatural(`X-${"0".repeat(30)}5`, "X-5")).toBe(0);
    });

    it("文字段按字典序、与数字段交错比较保持自然序", () => {
      expect(compareBusinessNoNatural("C001", "C010")).toBe(-1);
      expect(compareBusinessNoNatural("B20", "B3")).toBe(1);
      expect(compareBusinessNoNatural("A1", "B1")).toBe(-1);
      expect(compareBusinessNoNatural("A", "A1")).toBe(-1); // 前缀短的在前
      expect(compareBusinessNoNatural("甲2号", "甲10号")).toBe(-1);
    });

    it("与前端排序键同语义：整体升序为 2,9,10、混合编号确定性", () => {
      const ordered = ["S-10", "S-9", "S-2", "S-007", "S-7", "A-1", "B20", "B3"]
        .map((businessNo, index) => ({ id: `id-${index}`, businessNo, name: "店", regionName: "区" }))
        .sort((a, b) => compareBusinessNoNatural(a.businessNo, b.businessNo) || a.businessNo.localeCompare(b.businessNo) || a.id.localeCompare(b.id))
        .map((store) => store.businessNo);
      // S-007 与 S-7 数值相等 → 店号文本兜底（"0" < "7"）；S-2 数值小于 S-007（2 < 7），其余按数值
      expect(ordered).toEqual(["A-1", "B3", "B20", "S-2", "S-007", "S-7", "S-9", "S-10"]);
    });
  });

  describe("storeNameOptions", () => {
    const namedStores = [
      { id: "s10", name: "中山店", businessNo: "JD-9", brandId: "b1", regionName: "静安区" },
      { id: "s11", name: "向阳店", businessNo: "JD-10", brandId: "b1", regionName: "静安区" },
      { id: "s12", name: "向阳店", businessNo: "JD-2", brandId: "b1", regionName: "浦东新区" },
      { id: "s13", name: "朝阳店", businessNo: "JD-1", brandId: "b1", regionName: "静安区" },
      { id: "s14", name: "他牌店", businessNo: "JD-3", brandId: "b2", regionName: "静安区" },
      { id: "s15", name: "无牌店", businessNo: "JD-4", brandId: null, regionName: "静安区" },
    ];

    it("店名优先排序（zh 拼音序），同名门店相邻且按店号自然序排列", () => {
      const ordered = storeNameOptions(namedStores, "b1");
      expect(ordered.map((store) => `${store.name}/${store.businessNo}`)).toEqual([
        "朝阳店/JD-1", // 店名 zh 拼音排序：朝(chao) < 向(xiang) < 中(zhong)
        "向阳店/JD-2", // 同名「向阳店」：店号数值 2 在 10 前
        "向阳店/JD-10",
        "中山店/JD-9",
      ]);
    });

    it("只含所选品牌的门店（含未分品牌组，不含其他品牌）", () => {
      expect(storeNameOptions(namedStores, null).map((store) => store.id)).toEqual(["s15"]);
      expect(storeNameOptions(namedStores, "b2").map((store) => store.id)).toEqual(["s14"]);
      expect(storeNameOptions(namedStores, "bx")).toEqual([]);
    });

    it("brandId 为 undefined 的门店视同未分品牌", () => {
      const orphan = { id: "s16", name: "散店", businessNo: "JD-5", regionName: "静安区" };
      // 散(san) < 无(wu)，店名 zh 拼音序
      expect(storeNameOptions([...namedStores, orphan], null).map((store) => store.id)).toEqual(["s16", "s15"]);
    });
  });

  describe("duplicateStoreNames 与 storeNameOptionLabel", () => {
    const namedStores = [
      { id: "s10", name: "中山店", businessNo: "JD-9", brandId: "b1", regionName: "静安区" },
      { id: "s11", name: "向阳店", businessNo: "JD-10", brandId: "b1", regionName: "静安区" },
      { id: "s12", name: "向阳店", businessNo: "JD-2", brandId: "b1", regionName: "浦东新区" },
      { id: "s15", name: "无牌店", businessNo: "JD-4", brandId: null, regionName: "静安区" },
    ];

    it("同名 ≥2 家的店名集合按品牌范围计算", () => {
      expect(duplicateStoreNames(namedStores, "b1")).toEqual(new Set(["向阳店"]));
      expect(duplicateStoreNames(namedStores, null)).toEqual(new Set());
    });

    it("唯一店名只显示店名，同名门店追加店号与区域", () => {
      expect(storeNameOptionLabel(namedStores[0], duplicateStoreNames(namedStores, "b1"))).toBe("中山店");
      expect(storeNameOptionLabel(namedStores[1], duplicateStoreNames(namedStores, "b1"))).toBe("向阳店（JD-10 · 静安区）");
      expect(storeNameOptionLabel(namedStores[2], duplicateStoreNames(namedStores, "b1"))).toBe("向阳店（JD-2 · 浦东新区）");
    });

    it("区域缺失时以 — 兜底", () => {
      expect(storeNameOptionLabel({ name: "向阳店", businessNo: "JD-2", regionName: undefined }, new Set(["向阳店"]))).toBe("向阳店（JD-2 · —）");
    });
  });

  describe("cascadeFromStore", () => {
    it("命中门店时回填 brandId、businessNo 与 name（编辑/复制回填品牌 + 店名下拉）", () => {
      expect(cascadeFromStore(stores, "s1")).toEqual({ brandId: "b1", businessNo: "C001", name: "春熙店" });
    });

    it("未分品牌门店的 brandId 归一为 null（null 与 undefined 两种）", () => {
      expect(cascadeFromStore(stores, "s6")).toEqual({ brandId: null, businessNo: "N001", name: "未挂靠店" });
      expect(cascadeFromStore(stores, "s7")).toEqual({ brandId: null, businessNo: "N002", name: "老店" });
    });

    it("storeId 为空串或未命中时返回 null", () => {
      expect(cascadeFromStore(stores, "")).toBeNull();
      expect(cascadeFromStore(stores, "nope")).toBeNull();
    });
  });
});
