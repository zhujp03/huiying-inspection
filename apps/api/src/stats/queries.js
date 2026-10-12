// 数据看板统计查询：submission_versions × campaign × store × region 链路 + user_data_scopes 范围过滤。
// 月份按 Asia/Shanghai 自然月；得分/得分率 = SUM(awarded)/SUM(max) × 100（两位小数）。
// 该模块被 API 路由与 worker（xlsx 导出）共用，禁止引入 fastify/app 依赖。

const FROM_JOINS = `FROM submission_versions sv
  JOIN audit_campaigns c ON c.id = sv.campaign_id
  JOIN stores s ON s.id = c.store_id
  LEFT JOIN brands b ON b.id = s.brand_id
  JOIN regions r ON r.id = s.region_id
  LEFT JOIN regions cr ON cr.id = r.parent_id`;
const DETAIL_FROM_JOINS = `FROM submission_question_scores sqs
  JOIN submission_versions sv ON sv.id = sqs.submission_id
  JOIN audit_campaigns c ON c.id = sv.campaign_id
  JOIN stores s ON s.id = c.store_id
  LEFT JOIN brands b ON b.id = s.brand_id
  JOIN regions r ON r.id = s.region_id
  LEFT JOIN regions cr ON cr.id = r.parent_id`;
const MONTH_EXPR = "to_char(sv.submitted_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM')";

const round2 = (value) => Math.round(value * 100) / 100;
const rateOf = (awarded, max) => (Number(max) > 0 ? round2((Number(awarded) / Number(max)) * 100) : 0);

// from/to（YYYY-MM-DD）之间的完整自然月列表（含首尾），最多 60 个月防御异常区间。
export function monthRange(from, to) {
  const months = [];
  const end = `${to.slice(0, 7)}-01`;
  let cursor = `${from.slice(0, 7)}-01`;
  while (cursor <= end && months.length < 60) {
    const [year, month] = cursor.split("-").map(Number);
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    const next = month === 12 ? [year + 1, 1] : [year, month + 1];
    cursor = `${next[0]}-${String(next[1]).padStart(2, "0")}-01`;
  }
  return months;
}

function baseConditions(filter, userId, params) {
  params.push(filter.from, filter.to);
  const conditions = ["sv.submitted_at >= $1::date", "sv.submitted_at < ($2::date + INTERVAL '1 day')"];
  const optional = [["brandId", "s.brand_id"], ["cityRegionId", "r.parent_id"], ["regionId", "s.region_id"], ["storeId", "s.id"]];
  for (const [key, column] of optional) {
    if (filter[key]) {
      params.push(filter[key]);
      conditions.push(`${column} = $${params.length}::uuid`);
    }
  }
  params.push(userId);
  conditions.push(`EXISTS (SELECT 1 FROM user_data_scopes scope WHERE scope.user_id = $${params.length} AND scope.revoked_at IS NULL AND
    (scope.scope_type='all' OR (scope.scope_type='region' AND (scope.region_id=r.id OR scope.region_id=r.parent_id OR scope.region_id=(SELECT parent_id FROM regions WHERE id=r.parent_id))) OR (scope.scope_type='store' AND scope.store_id=s.id)))`);
  return conditions;
}

export async function fetchDashboardStats(pool, filter, userId) {
  const params = [];
  const whereSql = `WHERE ${baseConditions(filter, userId, params).join(" AND ")}`;

  const trendRows = await pool.query(`SELECT ${MONTH_EXPR} AS month, count(*)::int submissions, SUM(sv.total_score) awarded, SUM(sv.max_score) max_score
    ${FROM_JOINS} ${whereSql} GROUP BY 1 ORDER BY 1`, params);

  const storeRows = await pool.query(`SELECT s.id store_id, s.name store_name, b.name brand_name, cr.name city_name, ${MONTH_EXPR} AS month,
      count(*)::int submissions, SUM(sv.total_score) awarded, SUM(sv.max_score) max_score
    ${FROM_JOINS} ${whereSql} GROUP BY s.id, s.name, b.name, cr.name, ${MONTH_EXPR} ORDER BY s.name`, params);

  const categoryRows = await pool.query(`SELECT s.id store_id, s.name store_name, sqs.category,
      SUM(sqs.awarded_score) awarded, SUM(sqs.max_score) max_score
    ${DETAIL_FROM_JOINS} ${whereSql} GROUP BY s.id, s.name, sqs.category`, params);

  const questionRows = await pool.query(`SELECT sqs.question_number, MIN(sqs.question_text) question_text, ${MONTH_EXPR} AS month,
      SUM(sqs.awarded_score) awarded, SUM(sqs.max_score) max_score
    ${DETAIL_FROM_JOINS} ${whereSql} GROUP BY sqs.question_number, ${MONTH_EXPR} ORDER BY sqs.question_number`, params);

  const categoryList = await pool.query("SELECT code, name FROM question_categories ORDER BY sort_order, created_at");

  const months = monthRange(filter.from, filter.to);

  const trend = trendRows.rows.map((row) => ({ month: row.month, submissions: Number(row.submissions), score: rateOf(row.awarded, row.max_score) }));

  const storeMap = new Map();
  for (const row of storeRows.rows) {
    let entry = storeMap.get(row.store_id);
    if (!entry) {
      entry = { storeId: row.store_id, storeName: row.store_name, brandName: row.brand_name, cityName: row.city_name, awarded: 0, maxScore: 0, submissions: 0, monthMap: new Map(months.map((month) => [month, null])) };
      storeMap.set(row.store_id, entry);
    }
    entry.awarded += Number(row.awarded);
    entry.maxScore += Number(row.max_score);
    entry.submissions += Number(row.submissions);
    entry.monthMap.set(row.month, rateOf(row.awarded, row.max_score));
  }
  const stores = [...storeMap.values()]
    .map((entry) => ({ storeId: entry.storeId, storeName: entry.storeName, brandName: entry.brandName, cityName: entry.cityName, overall: rateOf(entry.awarded, entry.maxScore), submissions: entry.submissions, monthly: months.map((month) => ({ month, score: entry.monthMap.get(month) })) }))
    .sort((left, right) => right.overall - left.overall);

  const storeCategoryMap = new Map();
  for (const row of categoryRows.rows) {
    let entry = storeCategoryMap.get(row.store_id);
    if (!entry) {
      entry = { storeId: row.store_id, storeName: row.store_name, awarded: 0, maxScore: 0, rates: new Map() };
      storeCategoryMap.set(row.store_id, entry);
    }
    entry.awarded += Number(row.awarded);
    entry.maxScore += Number(row.max_score);
    entry.rates.set(row.category, { awarded: Number(row.awarded), max: Number(row.max_score) });
  }
  const storeCategories = [...storeCategoryMap.values()]
    .map((entry) => ({
      storeId: entry.storeId, storeName: entry.storeName, overallRate: rateOf(entry.awarded, entry.maxScore),
      rates: categoryList.rows.map((category) => {
        const cell = entry.rates.get(category.code);
        return { category: category.code, rate: cell ? rateOf(cell.awarded, cell.max) : null };
      }),
    }))
    .sort((left, right) => right.overallRate - left.overallRate);

  const questionMap = new Map();
  for (const row of questionRows.rows) {
    const identity = `${row.question_number}|${row.question_text}`;
    let entry = questionMap.get(identity);
    if (!entry) {
      entry = { key: `k${row.question_number}`, number: row.question_number, text: row.question_text, awarded: 0, maxScore: 0, monthMap: new Map(months.map((month) => [month, null])) };
      questionMap.set(identity, entry);
    }
    entry.awarded += Number(row.awarded);
    entry.maxScore += Number(row.max_score);
    entry.monthMap.set(row.month, rateOf(row.awarded, row.max_score));
  }
  const questions = [...questionMap.values()]
    .map((entry) => {
      const monthly = months.map((month) => ({ month, rate: entry.monthMap.get(month) }));
      const present = monthly.filter((point) => point.rate !== null).map((point) => point.rate);
      const delta = present.length >= 2 ? round2(present[present.length - 1] - present[present.length - 2]) : null;
      return { key: entry.key, number: entry.number, text: entry.text, overallRate: rateOf(entry.awarded, entry.maxScore), monthly, delta };
    })
    .sort((left, right) => left.overallRate - right.overallRate);

  return {
    range: { from: filter.from, to: filter.to },
    months,
    categories: categoryList.rows.map((row) => ({ code: row.code, name: row.name })),
    trend,
    stores,
    storeCategories,
    questions,
  };
}
