// 门店级联纯函数：品牌分组、组内店号选项、门店选项与门店反查级联值
const normalizeBrandId = (brandId) => brandId ?? null;

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

export function cascadeFromStore(stores, storeId) {
  if (!storeId) return null;
  const store = stores.find((item) => item.id === storeId);
  if (!store) return null;
  return { brandId: normalizeBrandId(store.brandId), businessNo: store.businessNo };
}
