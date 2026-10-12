// 区域基础数据 seed（幂等；code 使用民政部 6 位行政区划代码，全量全国数据见 regions-data.mjs）。
// 层级：省级(1) -> 地级市(2) -> 区县(3)；直辖市的地级节点为"市辖区/县"。
// 全量数据约 3367 条（31 省 / 342 地级 / 2994 区县，不含港澳台），来自 china-division@2.4.0。
import { REGIONS } from "./regions-data.mjs";

export const SEED_REGIONS = Object.freeze(REGIONS.map(({ code, name, level }) => ({ code, name, level })));

export async function seedRegions(pool) {
  const byCode = new Map();
  for (const region of REGIONS) byCode.set(region.code, region);
  // 按 level 显式排序（1→2→3，稳定排序保留同层原相对顺序），父行先插、id 回填后子行才能引用，
  // 不再依赖 regions-data.mjs 的文件行序（父层级恒低于子层级，排序即保证父先于子）。
  const ordered = [...REGIONS].sort((a, b) => a.level - b.level);
  for (const region of ordered) {
    const parentId = region.parent ? byCode.get(region.parent).id : null;
    const result = await pool.query(
      `INSERT INTO regions (id,name,code,parent_id,level) VALUES (gen_random_uuid(),$1,$2,$3,$4)
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name,parent_id=EXCLUDED.parent_id,level=EXCLUDED.level
       RETURNING id`,
      [region.name, region.code, parentId, region.level],
    );
    region.id = result.rows[0].id;
  }
}
