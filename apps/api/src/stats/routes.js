import { DashboardFilterSchema } from "../../../../packages/contracts/index.js";
import { fetchDashboardStats } from "./queries.js";

// 管理后台时区统一按 Asia/Shanghai 展示（en-CA 输出 YYYY-MM-DD）。
const shanghaiDate = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(date);

export function registerStatsRoutes(app, { pool }) {
  app.get("/api/admin/stats/dashboard", async (request) => {
    const session = await app.jundeAuth.adminReadSession(request, "stats:read");
    const today = shanghaiDate(new Date());
    const filter = DashboardFilterSchema.parse({
      from: request.query.from || `${today.slice(0, 7)}-01`,
      to: request.query.to || today,
      brandId: request.query.brandId || undefined,
      cityRegionId: request.query.cityRegionId || undefined,
      regionId: request.query.regionId || undefined,
      storeId: request.query.storeId || undefined,
    });
    return fetchDashboardStats(pool, filter, session.user_id);
  });
}
