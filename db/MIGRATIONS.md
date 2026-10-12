# Migrations 说明

`db/migrate.mjs` 按**完整文件名字典序**执行迁移，并以（文件名, sha256 内容校验和）记录在 `schema_migrations` 表。`ops/check-database.mjs` 与生产 preflight 均按同一口径逐行比对文件与库记录——**改名后必须对齐本地库记录，否则校验失败**。

## 编号规则

- 文件名格式：`三位递增序号_主题.sql`（如 `0031_foo_bar.sql`）。
- 新增迁移序号必须**严格递增、绝不复用**：取当前最大序号 +1。
- 同一序号禁止出现两个文件：字典序会让执行顺序变得不可控。`db/migrate.mjs` 启动时会做序号查重，发现重复立即报错（不连库、不改状态）。
- 迁移文件一旦提交或在他处应用过，**只允许改名对齐，严禁改动内容**（内容变化会导致 checksum 校验失败）。

## 2026-10 重排对照表（保序重编号）

历史原因产生了 `0022`/`0023` 双号，按当时的实际字典序执行顺序重新连续编号。**所有文件内容均未改动**（sha256 逐文件一致），仅改名。

| 旧文件名 | 新文件名 |
| --- | --- |
| 0022_brands.sql | 0022_brands.sql（不变） |
| 0022_user_roles_typed.sql | 0023_user_roles_typed.sql |
| 0023_evidence_limits.sql | 0024_evidence_limits.sql |
| 0023_question_categories.sql | 0025_question_categories.sql |
| 0024_questionnaire_deadline.sql | 0026_questionnaire_deadline.sql |
| 0025_question_number_unbounded.sql | 0027_question_number_unbounded.sql |
| 0026_dashboard_stats.sql | 0028_dashboard_stats.sql |
| 0027_audit_actor_snapshot.sql | 0029_audit_actor_snapshot.sql |
| 0028_audit_actor_username.sql | 0030_audit_actor_username.sql |

各迁移相互之间零依赖，重排不改变任何库结构结果。

## 本机已应用旧名迁移时的对齐步骤

若本地开发库曾按旧文件名应用过上表中的迁移（`schema_migrations` 里存的是旧名），改名后需按对照表逐条改写记录。**内容未变、仅改名，checksum 不受影响，无需重跑迁移。**

操作前先备份数据库，然后执行：

```sql
-- ⚠️ 执行前先备份数据库；仅替换文件名记录，不动 checksum。
UPDATE schema_migrations SET name = '0023_user_roles_typed.sql'      WHERE name = '0022_user_roles_typed.sql';
UPDATE schema_migrations SET name = '0024_evidence_limits.sql'       WHERE name = '0023_evidence_limits.sql';
UPDATE schema_migrations SET name = '0025_question_categories.sql'   WHERE name = '0023_question_categories.sql';
UPDATE schema_migrations SET name = '0026_questionnaire_deadline.sql' WHERE name = '0024_questionnaire_deadline.sql';
UPDATE schema_migrations SET name = '0027_question_number_unbounded.sql' WHERE name = '0025_question_number_unbounded.sql';
UPDATE schema_migrations SET name = '0028_dashboard_stats.sql'       WHERE name = '0026_dashboard_stats.sql';
UPDATE schema_migrations SET name = '0029_audit_actor_snapshot.sql'  WHERE name = '0027_audit_actor_snapshot.sql';
UPDATE schema_migrations SET name = '0030_audit_actor_username.sql'  WHERE name = '0028_audit_actor_username.sql';
```

对齐后执行 `node ops/check-database.mjs` 验证文件与库记录逐行一致，再运行 `npm run db:migrate` 补齐尚未应用的迁移。

## 已知债务：stats:read 权限双源

`0028_dashboard_stats.sql`（上表旧名 `0026_dashboard_stats.sql`）在迁移内幂等补插了 `stats:read` 权限及角色绑定，与 `db/seeds/rbac.mjs` 的权限字典构成**双源**。改动权限字典时必须两处同步（`rbac.mjs` 权限字典处已有注释指向本条）。后续新增权限码时应避免在迁移内补插，统一收敛到种子单源。
