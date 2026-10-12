# 汇盈探店：部署与运维单一路径

> 面向新工程师/运维。唯一配置输入是根目录 `.env`；唯一正式微信项目是 `apps/miniapp`。
> 明确区分：代码通过（本仓库） / 配置通过（preflight） / 外部服务通过（verify:external） / 真机通过 / 容量通过（staging P1）。

## 1. 配置

```bash
cp .env.example .env                       # 生产模板（强制类别；验证码/短信是否强制取决于 AUTH_SELF_SERVICE）
# 或
cp .env.development.example .env           # 开发版模板（tencent 模式 + 开发子域；缺省密钥优雅降级）
# 用户只在本机填写 .env（不提交 Git、不发送给任何人）
```

根目录 `.env` 是**当前活跃环境**的唯一输入；`ENV_FILE` 环境变量可让脚本/Compose
指向其它环境文件（如 staging），但同一时刻只有一个活跃环境，禁止开发与生产共用
数据库、Bucket、短信身份或 Cookie 域（见 BACKEND_DESIGN 3.1）。

每个变量的来源（全部在腾讯云控制台 / 微信公众平台 / 域名服务商）：

| 变量组 | 来源 |
|---|---|
| PUBLIC_API_ORIGIN / MINIAPP_API_BASE_URL / ADMIN_ORIGIN | 已备案 HTTPS 域名 |
| CADDY_EMAIL | 真实可收信的邮箱（Caddy ACME 证书申请） |
| DATABASE_URL | PostgreSQL 17（同机自建：容器内地址 `postgres:5432`；外部托管则填托管地址） |
| DATABASE_HOST_URL | 宿主机脚本（preflight/deploy/backup/migrate）用 127.0.0.1:5432；同机自建时必填 |
| POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB | 同机自建 PG17 的初始化凭据（compose postgres 服务注入） |
| AUTH_TOKEN_HMAC_KEY / PHONE_ENCRYPTION_KEY_BASE64 | 本机随机生成（32+ 字符 / 32 字节 base64） |
| AUTH_SELF_SERVICE | 取值 enabled/disabled；生产必须显式声明；disabled=自助注册/找回休眠 |
| CAPTCHA_APP_ID / APP_SECRET_KEY / API_SECRET_ID / API_SECRET_KEY | 腾讯云验证码控制台（四键职责分离，禁止同值）；仅 AUTH_SELF_SERVICE=enabled 时必填（disabled 时必须留空） |
| SMS_* | 腾讯云短信控制台（签名 + 注册/找回两个模板审核通过；办理清单见 `docs/sms-captcha-setup.md`）；仅 AUTH_SELF_SERVICE=enabled 时必填（disabled 时必须留空） |
| COS_* | COS 控制台创建三个私有桶 + CAM 角色（最小权限） |
| OCR_PROVIDER | 三态开关（none=关闭/tencent=腾讯云 OCR/paddle=自托管 sidecar）；生产必须显式声明，默认 none |
| OCR_SECRET_ID / OCR_SECRET_KEY / OCR_REGION | 腾讯云 CAM 子账号（仅可调用 OCR 接口的最小权限）；仅 OCR_PROVIDER=tencent 时必填 |
| OCR_SERVICE_URL | 私网 PaddleOCR（Linux x86-64）；仅 OCR_PROVIDER=paddle 时必填 |
| TENCENT_MAP_KEY | 腾讯位置服务（限制正式 Admin 域名） |

## 2. 发布准备

```bash
npm run release:prepare            # 生成小程序 API Origin、构建 Admin、生成契约、泄密扫描
npm run release:prepare:check      # 无 .env 时用 .env.example 验证生成逻辑
```

## 3. 离线门禁

```bash
npm run verify:offline             # 全部不依赖云服务的检查；缺环境即 BLOCKED
```

## 4. 生产预检（不改变云资源）

```bash
npm run preflight:production       # 配置、数据库连接/migration、部署文件；OCR 按 OCR_PROVIDER 分支（none 跳过探活，tencent 只验密钥，paddle 探活 /ready）
```

## 5. 开发环境（开发版）与生产切换

开发版语义（`.env.development.example`）：`NODE_ENV=development` + `AUTH_PROVIDER_MODE=tencent`，
Origin 为开发子域（`dev-api.` / `dev-admin.`，与生产域名不同），数据库/COS/短信/验证码全部
使用独立的开发实例；缺省的真实密钥在开发环境**优雅降级**（验证码区域业务化不可用、允许重试），
只有 production 失败关闭。开发版**不使用** sandbox、`SMS_SANDBOX_*` 或 127.0.0.1 常态 Origin。

开发服务器部署（不经过 `deploy:production`，该命令是生产专用门禁）：

```bash
# 与生产部署相同的编排文件，--env-file 指向开发版 .env（内含 ENV_FILE 说明）
docker compose --env-file ../../.env.development -f ops/docker/docker-compose.production.yml up -d --build
```

切换环境：

- 同一时刻只有根目录 `.env` 一个活跃环境；切换＝替换 `.env` 内容（`.env.example` ↔ `.env.development.example`）。
- 同一台服务器上开发与生产**不同时占用 80/443**；如需共存，为开发环境设置
  `COMPOSE_PROJECT_NAME` 并修改 Caddy `ports`（如 `8080:80` / `8443:443`），域名仍走各自子域。
- `ENV_FILE` 环境变量可让 release:prepare / preflight / deploy / verify-external 读取指定环境文件。

## 6. 数据库初始化与首个管理员

```bash
DATABASE_URL='...' npm run db:migrate
npm run admin:bootstrap            # 仅在安全 TTY 交互执行；不创建默认账号、不公开 HTTP bootstrap
node ops/check-database.mjs        # migration 后检查与完整性抽样
```

- 生产环境**不运行 `db:seed`**（seed 为开发专用，见 `db/seeds/README.md`）；`admin:bootstrap`
  现已幂等补种 regions 基础数据（内部 `seedRegions`，`ON CONFLICT (code)`，否则
  `stores.region_id NOT NULL` 会阻断建店），RBAC 角色行同样由内部 `seedRbac` 创建，
  migration 只建表结构。
- `preflight:production` 与 `deploy:production` 都会校验 migration 数量完整，
  migration 缺失时部署在改变外部状态前失败关闭。

## 7. 部署

```bash
# 部署（先跑 preflight；无首管时输出 TTY bootstrap 命令）：
DEPLOY_CONFIRM=yes npm run deploy:production
```

- `OCR_PROVIDER=none`（默认，推荐先以此上线）：`docker compose up -d` 不需要 junde-ocr 镜像，
  postgres/api/worker/caddy 全部拉起，小票走纯手工填写。
- `OCR_PROVIDER=paddle`（逃生舱）时需先单独拉起 OCR（首次启动会下载 PP-OCRv6 模型，需数分钟）：
  ```bash
  docker compose --env-file ../../.env --profile ocr up -d ocr
  curl -s http://127.0.0.1:8080/ready          # 应返回 200（仅宿主机回环，不暴露公网）
  # 宿主机解析（preflight/deploy 的宿主机脚本依赖；容器内部走 Compose DNS，无需此条）：
  echo '127.0.0.1 ocr' | sudo tee -a /etc/hosts
  ```
- `OCR_PROVIDER=tencent`：无需任何 OCR 容器，`.env` 填 `OCR_SECRET_ID`/`OCR_SECRET_KEY` 即可。

- API/Worker/PostgreSQL/OCR 由 `ops/docker/docker-compose.production.yml` 编排；Caddy 是唯一公网入口（`ops/docker/Caddyfile`）。
- `deploy:production` 自动向 Compose 传入 `--env-file`（根目录 `.env`）供 Caddy 域名与 `CADDY_EMAIL` 插值；
  手动执行 `docker compose` 时必须自带 `--env-file ../../.env`，否则 Caddy 因域名/邮箱为空而失败关闭。
- Admin 静态产物由 `release:prepare` 构建（`apps/admin/dist`）并只读挂载给 Caddy 的 `/srv/admin`；
  部署前必须已构建，否则 preflight 失败关闭。
- 健康检查：API 由 Compose healthcheck 探测 `/health/live`（postgres 用 `pg_isready`，OCR sidecar 用 `/ready`）。
  注意：Worker 的 Compose healthcheck 只是恒过的进程占位（`node -e "process.exit(0)"`），不反映业务健康；
  Worker 真实心跳以其周期写入 `system_job_runs` 为准，观测走 `/metrics` 或查询 `system_job_runs` 最近记录。
- 日志轮换（json-file 20m×5）、优雅关闭（SIGTERM）、自动重启（unless-stopped）、资源上限已配置。
- 数据库与 OCR 只走私网网络，不暴露公网端口（postgres 5432 与 OCR 8080 仅绑定宿主机 127.0.0.1，供本机脚本使用）。

### 7.1 低成本单机模式（2C2G Lighthouse）

`OCR_PROVIDER=none` 形态下的单机拓扑：postgres（同机自建 PG17）+ api + worker + caddy 全部由一份
compose 编排，无需 PaddleOCR sidecar（省去约 2.5GiB 常驻内存），2 vCPU / 2 GiB 即可运行。

- 服务器规格：2 vCPU / 2 GiB Lighthouse（试点配置，不具备高可用结论，见 BACKEND_DESIGN 3.4）。
- 数据库：同机自建 PG17（compose postgres 服务），数据卷持久化；`DATABASE_URL` 指向容器内
  `postgres:5432`，`DATABASE_HOST_URL` 指向 `127.0.0.1:5432` 供宿主机脚本使用，两条路径都必须实测连通。
- 备份要求（硬性）：同机自建没有托管实例的自动备份，必须每日
  `BACKUP_EXECUTION_CONFIRM=yes npm run ops:backup`（pg_dump 上传 COS 备份桶，35 天滚动保留），
  并定期用 `ops/restore-drill.mjs` 做恢复演练（隔离演练库，禁止指向生产库）。
- 稍后启用 OCR（约 5 分钟，小程序无需重新发版）：
  1. 编辑根目录 `.env`：改 `OCR_PROVIDER=tencent` 并填写 `OCR_SECRET_ID`/`OCR_SECRET_KEY`
     （或 `OCR_PROVIDER=paddle` 并提供私网 `OCR_SERVICE_URL`，见第 7 节 paddle 步骤，需 4C8G+）；
  2. `docker compose --env-file ../../.env -f ops/docker/docker-compose.production.yml up -d`；
  3. `npm run preflight:production` 确认通过。
  菜品页 OCR 入口由 `/api/public/client-config` 的 `features.receiptOcr` 动态下发，即时生效。

## 8. 健康检查与运维

```bash
curl https://<PUBLIC_API_ORIGIN>/health/live
curl https://<PUBLIC_API_ORIGIN>/health/ready
curl https://<PUBLIC_API_ORIGIN>/metrics          # Prometheus 文本格式
```

- 备份：`BACKUP_EXECUTION_CONFIRM=yes DATABASE_URL=... node ops/backup-database.mjs`（每日；35 天滚动）。
- 恢复演练：`BACKUP_EXECUTION_CONFIRM=yes DRILL_DUMP_PATH=... DRILL_DATABASE_URL=... node ops/restore-drill.mjs`。
- 密钥轮换、数据库不可用、COS 不可用、OCR 堆积、短信异常、误删对象恢复：见 `ops/runbooks/`。

## 9. 外部验收（真实腾讯云/微信/真机/P1 就绪后）

```bash
npm run verify:external            # 任何缺项非零退出；sandbox/Mock/模拟器不算通过
P1_PLAN_PATH='/secure/staging-p1-plan.json' npm run preflight:p1
npm run verify:release
```

## 10. 微信上传与发布

1. 微信开发者工具打开 `apps/miniapp`（唯一正式项目，AppID wx35690c1079fb5a5d）。
2. 公众平台：验证码插件授权、地理位置接口权限、隐私声明、request/upload/download 合法域名。
3. 上传体验版 → 真机测试 → 提交审核 → 发布。

## 11. 事故处理

- 数据库不可用 / COS 不可用 / OCR 堆积 / 短信异常 / 密钥轮换 / 提交不变量 / 误删对象：`ops/runbooks/*.md`。
- 所有演练使用 staging 独立环境，禁止连接生产短信、验证码、小程序域名或生产数据库。
