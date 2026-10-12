# Render 单实例部署（新加坡 Starter + 免费 PostgreSQL 17 + 本地磁盘存储）

目标形态：一个 always-on Render Node Web Service 同时承载 Fastify API、PostgreSQL 队列 worker、
探员端 H5（`/`）与管理后台（`/admin/`）。文件存储（小票原图/题目证据/录音/导出）落在
持久磁盘 `/var/data/storage`；OCR 关闭（纯手动填写）；自助注册/找回休眠；打卡定位用既有
腾讯地图 Key（运行时注入）。不使用 Caddy、不上传 .env、不改动业务代码。

## 1. 形态开关（服务端强制校验）

| 键 | 值 | 说明 |
|---|---|---|
| `NODE_ENV` | `production` | 全部生产门保持生效（HTTPS 来源、真实 DB/密钥、无 sandbox） |
| `DEPLOYMENT_TARGET` | `render` | **生产 + 本地磁盘存储的唯一合法 opt-in**；缺省时生产仍拒绝 `STORAGE_PROVIDER=local` |
| `STORAGE_PROVIDER` | `local` | 证据/导出落 `/var/data/storage`（持久磁盘 1GB） |
| `LOCAL_STORAGE_DIR` | `/var/data/storage` | 必须是 `/var/data/` 下的绝对路径（config.js 强制） |
| `OCR_PROVIDER` | `none` | 纯手动填写；消费小票原图仍必须上传 |
| `AUTH_SELF_SERVICE` | `disabled` | 自助注册/找回休眠；管理员后台建号 |
| `HOST` | `0.0.0.0` | Render 注入 `PORT`，服务端直接读取 |

公开 Origin（`PUBLIC_API_ORIGIN` / `MINIAPP_API_BASE_URL` / `ADMIN_ORIGIN` / `WEB_ORIGIN`）
默认从平台注入的 `RENDER_EXTERNAL_URL`（https）派生且同源；前端零域名规则不变（不出现任何
API 域名字面量）。如需覆盖可在 Render 配置显式键（https、非 localhost）。

## 2. 首次部署（Blueprint，逐命令）

1. 代码推送到 GitHub（发布前的卫生检查见第 6 节），Render 控制台 → **New → Blueprint**，
   选择仓库与 `render.yaml`（或 CLI：`render blueprint launch`）。
2. Blueprint 会提示填写三个 `sync:false` 密钥（生成命令在本机执行，值不落库）：
   ```bash
   openssl rand -hex 32            # → AUTH_TOKEN_HMAC_KEY
   openssl rand -base64 32         # → PHONE_ENCRYPTION_KEY_BASE64
   # TENCENT_MAP_KEY：既有腾讯位置服务浏览器 Key
   ```
3. 首次构建顺序：`npm ci --include=dev`（vite 在 devDependencies）→ `npm run build:render`
   （构建 H5 dist 与 `--base /admin/` 的 Admin dist）→ preDeploy `npm run db:migrate`
   （只做迁移，无种子/无默认账号）→ `npm run start:render`（同实例拉起 API + worker）。
4. 健康检查：`GET /health/ready`（数据库就绪 + 磁盘已在启动期探测通过）。

## 3. 初始化数据：两条路线，二选一（不要都做）

### 路线 A —— 全新空库（无历史数据）

迁移完成后（preDeploy 已建表），在 Render Dashboard 打开服务的 **Shell** 标签，运行：

```bash
npm run admin:bootstrap
```

按交互提示输入管理员用户名/密码/手机号。该脚本只在 TTY 交互下创建首个超级管理员
（已存在超级管理员时会拒绝执行），不产生任何默认口令或演示账号。

### 路线 B —— 迁移既有本地数据（当前选定的路线：本地账号/数据原样上云）

本地上已有真实管理员/探店员账号与业务数据，迁移时**沿用原账号**，不重新引导：

1. 在**本机**导出开发库（凭证在根目录 `.env`，不外传）：
   ```bash
   pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --file junde-migrate.dump
   ```
2. 恢复到 Render 免费库（连接串取自 Render Dashboard → junde-db → Connections）：
   ```bash
   pg_restore --dbname "<RENDER_DATABASE_URL>" --no-owner --no-privileges --clean --if-exists junde-migrate.dump
   ```
3. **密钥必须原样沿用（关键）**：Restored 数据里的手机号密文与登录盲索引都是用源系统的
   `PHONE_ENCRYPTION_KEY_BASE64` 与 `AUTH_TOKEN_HMAC_KEY` 加密/派生的。迁移数据时这两个
   Render secret **必须填源系统的原值，绝不重新生成**——换键会让全部既有账号无法登录、
   手机号密文不可解。
4. **恢复后不要运行 `admin:bootstrap`**：管理员账号已随数据恢复存在，重新引导没有意义
   （脚本检测到已有超级管理员会直接拒绝）。直接用既有管理员账号登录 `https://<service>.onrender.com/admin/`。
5. 本地磁盘文件（`/var/data/storage`）与附件表：本次迁移时本地证据/小票附件表为空，
   无历史文件需要搬迁；如未来需要搬迁文件，把本机 `.local-storage/` 内容上传到
   Render 持久磁盘同路径（`Render Shell` + tar/scp 或对象中转），保持相对 key 结构不变。

## 4. 验证清单（部署后）

| 检查 | 期望 |
|---|---|
| `https://<service>/health/ready` | `{"status":"ready"}` |
| `https://<service>/` | 探员端 H5 打开（同源 `/api`） |
| `https://<service>/admin` | 308 → `/admin/`，后台登录页 |
| 后台上传/预览证据 | 小票/证据真实写入 `/var/data/storage`，预览走签名 URL |
| 后台导出 | worker 生成真实 CSV/XLSX，下载可用 |
| `https://<service>/api/not-exist` | JSON 404（不是 index.html） |

## 5. 平台限制与已知约束

- **免费托管 PostgreSQL 17 自创建日起 30 天整体过期**（与是否活跃无关），之后有 14 天宽限期
  可恢复，逾期删除：到期前用 `pg_dump` 导出并迁移到新库（或升级付费实例）。备份命令：
  `pg_dump "$DATABASE_URL" --format=custom --file junde.dump`。
- **持久磁盘与重新部署**：磁盘在部署期间保持挂载，但部署切换有短暂停机（单实例）；证据
  文件跨部署保留。**不要缩容到 0 实例后再换磁盘挂载点**——路径变化会让启动期磁盘探测失败
  关闭（这是刻意设计）。
- **Starter 512MB**：已设 `AUTH_HASH_MAX_CONCURRENCY=1`、`DATABASE_POOL_MAX=4`
  （worker 内部自限 5）。如出现内存压力优先降并发而不是升配。
- 单实例 = API 与 worker 同进程树（`scripts/start-render.mjs` 管理信号与子进程失败联动）；
  队列只有 PostgreSQL 一份，没有第二个调度器。

## 6. 公开发布前卫生（Supervisor 执行）

- 确认仓库不含：根目录 `.env*`（模板 `.env.example`/`.env.*.example` 除外，均只有占位符）、
  `.local-storage/`、`.npm-cache/`、`.workbuddy/`、`.zcode/`、`.codegraph/`、`test-results/`。
- `git status` 审阅一次性确认无真实密钥文件（`*.pem`、`*.key`、`*.sts.json` 等已被忽略）。
- 本仓库模板（`.env.example`、`.env.local.example`、`.env.render.example`、`render.yaml`）
  只含占位符，可随源码公开。
