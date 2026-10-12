// store/assignments-cache.js（module-contracts §4.2；小程序 store/assignments-cache.js:5-20）
//
// 任务列表短时缓存：按 userId 隔离，默认最多 15 秒，支持 force 跳过。
// 纯逻辑、无平台依赖（由 services 层注入实际数据），可在 Node 中单独测试。
// 登录成功、退出登录、401 清会话时必须调用 clear()，防止跨账号串数据（R09/R10）。

export function createAssignmentCache({ now = () => Date.now(), ttlMs = 15000 } = {}) {
  const entries = new Map();
  return {
    /** 命中且未过期返回 { items }，否则返回 null（并清理过期项）。 */
    get(userId, { force = false } = {}) {
      if (force || !userId) return null;
      const entry = entries.get(userId);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        entries.delete(userId);
        return null;
      }
      return { items: entry.items };
    },
    set(userId, items) {
      if (userId) entries.set(userId, { items, expiresAt: now() + ttlMs });
    },
    /** 清空全部用户缓存（登录/退出/401）。 */
    clear() {
      entries.clear();
    },
  };
}
