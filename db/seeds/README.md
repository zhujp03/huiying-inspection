# Seeds

Seeds are development-only, idempotent SQL/JavaScript scripts. They must never create production bypass users or fake supplier success.

生产环境不运行 `db:seed`；regions 行政区划基础数据由 `admin:bootstrap` 幂等补种（`seedRegions`，`ON CONFLICT (code)`），避免建店被空 regions 表阻断。
