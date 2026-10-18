// 门店级联纯函数：品牌分组、组内店名主选项（店号只读回显）、门店反查级联值与店号自然排序比较器。
// 排序语义与门店管理服务端一致（batch2 businessNoSortKey）：数字段按数值（2 在 10 前），
// 非数字段按字典序；"007" 与 "7" 数值相等时返回 0，由调用方用店号文本/id 兜底保证确定性。
const normalizeBrandId = (brandId) => brandId ?? null;

export function compareBusinessNoNatural(left, right) {
  const chunksA = String(left ?? "").match(/\d+|\D+/g) || [];
  const chunksB = String(right ?? "").match(/\d+|\D+/g) || [];
  const longest = Math.max(chunksA.length, chunksB.length);
  for (let index = 0; index < longest; index += 1) {
    const chunkA = chunksA[index];
    const chunkB = chunksB[index];
    if (chunkA === undefined) return -1;
    if (chunkB === undefined) return 1;
    if (/^\d+$/.test(chunkA) && /^\d+$/.test(chunkB)) {
      // 先比去前导零后的位数、再逐位比较：不受超长数字精度影响，"007" 与 "7" 视为相等
      const bareA = chunkA.replace(/^0+/, "");
      const bareB = chunkB.replace(/^0+/, "");
      if (bareA.length !== bareB.length) return bareA.length < bareB.length ? -1 : 1;
      if (bareA !== bareB) return bareA < bareB ? -1 : 1;
    } else if (chunkA !== chunkB) {
      return chunkA < chunkB ? -1 : 1;
    }
  }
  return 0;
}

const byBusinessNoThenId = (a, b) =>
  compareBusinessNoNatural(a.businessNo, b.businessNo) ||
  String(a.businessNo ?? "").localeCompare(String(b.businessNo ?? "")) ||
  String(a.id).localeCompare(String(b.id));

export function brandGroups(stores, brands) {
  const known = new Set(brands.map((brand) => brand.id));
  const groups = brands.map((brand) => ({
    brandId: brand.id,
    label: brand.name,
    stores: stores.filter((store) => store.brandId === brand.id),
  }));
  const unknownGroups = [];
  const unassigned = [];
  for (const store of stores) {
    if (store.brandId == null) {
      unassigned.push(store);
    } else if (!known.has(store.brandId)) {
      let group = unknownGroups.find((item) => item.brandId === store.brandId);
      if (!group) {
        group = { brandId: store.brandId, label: store.brandName || String(store.brandId), stores: [] };
        unknownGroups.push(group);
      }
      group.stores.push(store);
    }
  }
  groups.push(...unknownGroups);
  if (unassigned.length > 0) groups.push({ brandId: null, label: "未分品牌", stores: unassigned });
  return groups;
}

// 品牌下的店名主选项：店名优先（同名相邻），同名再按店号自然序、店号文本、id 排序。
export function storeNameOptions(stores, brandId) {
  const target = normalizeBrandId(brandId);
  return stores
    .filter((store) => normalizeBrandId(store.brandId) === target)
    .slice()
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), "zh-Hans-CN") || byBusinessNoThenId(a, b));
}

// 店名下拉的展示文案：同名门店追加「店号 · 区域」区分，唯一店名只显示店名。
export function storeNameOptionLabel(store, duplicateNames) {
  const name = String(store.name ?? "");
  return duplicateNames?.has(name) ? `${name}（${store.businessNo} · ${store.regionName || "—"}）` : name;
}

// 品牌下出现 ≥2 家的同名门店集合（供文案追加店号/区域）。
export function duplicateStoreNames(stores, brandId) {
  const counts = new Map();
  for (const store of storeNameOptions(stores, brandId)) {
    counts.set(store.name, (counts.get(store.name) || 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
}

export function businessNoOptions(stores, brandId) {
  const target = normalizeBrandId(brandId);
  const options = [];
  for (const store of stores) {
    if (normalizeBrandId(store.brandId) !== target) continue;
    if (!options.includes(store.businessNo)) options.push(store.businessNo);
  }
  return options;
}

export function storeOptions(stores, brandId, businessNo) {
  const target = normalizeBrandId(brandId);
  return stores.filter((store) => normalizeBrandId(store.brandId) === target && store.businessNo === businessNo);
}

// 门店反查级联值：返回品牌 id（null 归一）、店号与店名，供编辑/复制回填「品牌 + 店名」。
export function cascadeFromStore(stores, storeId) {
  if (!storeId) return null;
  const store = stores.find((item) => item.id === storeId);
  if (!store) return null;
  return { brandId: normalizeBrandId(store.brandId), businessNo: store.businessNo, name: store.name };
}
