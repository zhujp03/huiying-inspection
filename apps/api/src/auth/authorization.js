// 权限与数据范围解耦：authorizeAdmin 只回答「有没有该权限」，数据范围（user_data_scopes 行）
// 随会话带出，由查询层过滤（列表静默收窄）或写操作断言（范围外 403 SCOPE_FORBIDDEN）。
// 范围 SQL 与 batch5/stats 的既有实现保持同构：region 三层子树（自身/父/祖父）+ store 精确。
export async function authorizeAdmin(pool, { userId, permission }) {
  const permissionResult = await pool.query(`SELECT 1
    FROM user_roles ur
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = $1 AND ur.revoked_at IS NULL AND p.code = $2
    LIMIT 1`, [userId, permission]);
  if (!permissionResult.rows[0]) return { allowed: false, scopes: [] };
  const scopeResult = await pool.query(`SELECT scope_type,region_id,store_id FROM user_data_scopes
    WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  return { allowed: true, scopes: scopeResult.rows };
}

export function hasFullScope(scopes) {
  return Array.isArray(scopes) && scopes.some((scope) => scope.scope_type === "all");
}

// 与 batch5/routes.js、stats/queries.js 的范围 EXISTS 完全同构；storeAlias/regionAlias 替换表别名，
// userParam 是调用方把 userId push 进参数数组后得到的 $N 占位符文本。hasFullScope 时返回 null。
export function storeScopeFilter({ scopes, storeAlias = "s", regionAlias = "r", userParam }) {
  if (hasFullScope(scopes)) return null;
  return `EXISTS (SELECT 1 FROM user_data_scopes scope WHERE scope.user_id=${userParam} AND scope.revoked_at IS NULL AND
    (scope.scope_type='all' OR (scope.scope_type='region' AND (scope.region_id=${regionAlias}.id OR scope.region_id=${regionAlias}.parent_id OR scope.region_id=(SELECT parent_id FROM regions WHERE id=${regionAlias}.parent_id))) OR (scope.scope_type='store' AND scope.store_id=${storeAlias}.id)))`;
}

const regionCovered = (scopes, ancestorIds) => Array.isArray(scopes) && scopes.some((item) => item.scope_type === "region" && item.region_id && ancestorIds.includes(item.region_id));

// 目标门店是否被 scopes 覆盖：store 范围精确匹配；region 范围按门店所属区域的三层祖先链判断。
// 门店不存在时同样 fail（避免探测）；fail 由调用方注入（通常抛 403 SCOPE_FORBIDDEN）。
export async function assertStoreCovered(client, scopes, storeId, fail) {
  if (hasFullScope(scopes)) return;
  const result = await client.query(`SELECT region.id region_id, region.parent_id parent_id, grand.parent_id grandparent_id
    FROM stores store JOIN regions region ON region.id = store.region_id
    LEFT JOIN regions grand ON grand.id = region.parent_id WHERE store.id = $1`, [storeId]);
  const chain = result.rows[0];
  if (!chain) return fail();
  const ancestorIds = [chain.region_id, chain.parent_id, chain.grandparent_id].filter(Boolean);
  const covered = (Array.isArray(scopes) && scopes.some((item) => item.scope_type === "store" && item.store_id === storeId)) || regionCovered(scopes, ancestorIds);
  if (!covered) fail();
}

// 新建门店前置校验：body.regionId 等于 scope.region_id 或其子孙时放行；store 范围管理员
// 不能建新门店（新建门店没有既定 store_id 可匹配）；区域不存在同样 fail。
export async function assertRegionCovered(client, scopes, regionId, fail) {
  if (hasFullScope(scopes)) return;
  const result = await client.query(`SELECT region.parent_id parent_id, grand.parent_id grandparent_id
    FROM regions region LEFT JOIN regions grand ON grand.id = region.parent_id WHERE region.id = $1`, [regionId]);
  const chain = result.rows[0];
  if (!chain) return fail();
  if (!regionCovered(scopes, [regionId, chain.parent_id, chain.grandparent_id].filter(Boolean))) fail();
}
