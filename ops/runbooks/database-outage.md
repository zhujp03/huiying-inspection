# Runbook: Database unavailable（数据库不可用）

影响：API `/health/ready` 返回 503 `DATABASE_UNAVAILABLE`；所有业务接口 503 `DATABASE_BUSY`；worker 心跳停止（`worker_heartbeat_age_seconds` 增长）。

## 检测
- 告警：`database_pool_waiting_count` 持续升高、5xx > 2%、`/health/ready` 503。
- `SELECT 1` 与 `pg_stat_activity` 查看连接与状态。

## 处置
1. 确认是否为连接池打满：API pool 10 × N + worker pool 5 不得超过 `max_connections` 的 70%。
2. 数据库侧：检查磁盘（>75% 告警）、慢查询、锁等待（`pg_locks`）、复制延迟。
3. 应用侧：按第 8.1 节 pool 参数调低或扩容；`DATABASE_BUSY` 是安全过载响应，允许入口有界排队。
4. 恢复：`/health/ready` 转 200 后先放量 10% 流量 5 分钟，再全量。

## 验证
- 演练（staging）：停库 → 确认 API 503 且不崩溃 → 恢复 → 确认自动恢复、无半提交、幂等重放正常。

## 禁止
- 禁止用内存状态或 fixture 顶替数据库；禁止无限重试击穿数据库。
