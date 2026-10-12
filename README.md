# 汇盈探店（暗访问卷）

微信小程序 + 管理后台 + Fastify API + PostgreSQL 17 + 私有 COS + 自托管 PaddleOCR 的暗访门店检查系统。

## 快速开始（开发者）

```bash
node --version   # 必须 Node 24（.nvmrc）
npm install
npm run verify:offline          # 离线门禁（无需云服务；默认跳过微信开发者工具 native fixture，加 -- --with-native 包含）
npm run release:prepare:check   # 无 .env 时验证发布准备逻辑
cp .env.example .env            # 生产模板；开发版用 cp .env.development.example .env
npm run preflight:production    # 生产配置/连通性预检（不改变云资源）
```

- 唯一正式微信开发者工具项目目录：`apps/miniapp`（AppID `wx35690c1079fb5a5d`）。
- 唯一配置输入：根目录 `.env`（本地先跑通模板 `.env.local.example`、开发版模板 `.env.development.example`、生产模板 `.env.example`，见 `docs/DEPLOYMENT.md`）。
- 用户可见品牌：汇盈探店。

## 本地存储 / 云上切换（STORAGE_PROVIDER）

文件存储形态由根目录 `.env` 的 `STORAGE_PROVIDER` 决定，业务页面与 worker 不感知差异：

| 形态 | 配置 | 说明 |
|---|---|---|
| `local`（本地先跑通） | `cp .env.local.example .env` 后填写密钥并重启服务 | 小票原图/题目证据/录音/导出文件全部落本机磁盘（`LOCAL_STORAGE_DIR`，默认 `.local-storage/`，已入 `.gitignore`，绝不入库入 Git）；OCR 关闭（`OCR_PROVIDER=none`，纯手动填写，小票原图仍必须上传）；自助注册/找回休眠（`AUTH_SELF_SERVICE=disabled`，用既有账号登录）。数据库仍是本机 PostgreSQL。上传/预览/下载走同桶语义的 HMAC 短时签名授权，磁盘目录树不对外暴露；备份上传能力显式不可用（`ops/backup-database.mjs` 拒绝执行，不伪造备份结果）。 |
| `cos`（默认，云上） | 按 `.env.example` 填 COS 三桶 + renewing 凭证 | 既有私有腾讯云 COS 形态，行为与校验完全不变；生产环境（`NODE_ENV=production`）强制 `cos` 并拒绝 `local`。 |

切换方法：改 `.env` 中 `STORAGE_PROVIDER` 与对应键（local 段 ↔ COS 段），然后重启 `npm run dev:api`（或 `start:api`）与 `start:worker`——API 与 worker 必须使用同一 `LOCAL_STORAGE_DIR`/COS 配置。**注意：已产生的本地文件不会自动迁移上云，云上对象也不会自动落回本地；环境之间文件彼此独立**（数据库数据由 `ops/backup-database.mjs` + `pg_restore` 另行迁移）。本地签名授权有效期由 `LOCAL_UPLOAD_TTL_SECONDS`/`LOCAL_PREVIEW_TTL_SECONDS` 控制。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run check:runtime` | Node 24 运行时检查 |
| `npm run contracts:check` | 契约生成漂移检查（内容哈希，不依赖 Git 基线） |
| `npm run test:production-source` | 生产源码泄漏/Mock 扫描 |
| `npm run test:frontend` | 前端单元/契约/Admin 构建 |
| `npm run test:backend:postgres` | PostgreSQL 17 集成测试（需 DATABASE_URL） |
| `npm run test:backend` | 后端全套 |
| `npm run test:admin:e2e` | Admin Playwright E2E（fixture 契约服务） |
| `npm run test:miniapp:native` / `test:miniapp:receipt-native` | 微信开发者工具 fixture 原生回归 |
| `npm run test:miniapp:real-api` | 小程序直连真实本地 API + 真实 PostgreSQL |
| `npm run verify:offline` | 离线发布门禁 |
| `npm run release:prepare` / `release:prepare:check` | 发布准备（生成小程序 API Origin、构建、泄密扫描） |
| `npm run preflight:production` | 生产预检（配置/数据库/OCR/部署文件） |
| `npm run deploy:production` | 生产部署（需 DEPLOY_CONFIRM=yes；先预检；无首管时输出 TTY bootstrap） |
| `npm run verify:external` | 外部验收门禁（真实腾讯云/微信/真机/P1 就绪后） |
| `npm run verify:release` | 全链路总门禁（含外部条件，缺项 BLOCKED） |

## 文档

- `BACKEND_DESIGN.md`：后端权威设计（数据库/COS/OCR/安全/运维实现事实）。
- `STATE_MACHINE_OVERVIEW.md`：统一状态机可视化总览。
- `docs/DEPLOYMENT.md`：部署与运维单一路径。
- `docs/RENDER.md`：Render 单实例部署（Starter + 免费托管 PG17 + 本地磁盘存储；Blueprint `render.yaml`）。
- `docs/sms-captcha-setup.md`：腾讯云短信/验证码控制台办理与 `.env` 填写清单。
- `docs/traceability-matrix.md`：第一阶段全栈追踪矩阵。
- `ops/runbooks/`：数据库/COS/OCR/短信/密钥/提交不变量/误删恢复手册。
- 其余核心规格见仓库根目录 Markdown（project_boundary / assignment_spec / BACKEND_DESIGN / STATE_MACHINE_OVERVIEW / video_replication_spec 等）。

## 安全边界

- 生产默认失败关闭：缺数据库、认证、COS 三桶与可续期凭证、OCR、地图 Key 或公网 Origin 时启动失败；验证码四键、短信双模板仅在 AUTH_SELF_SERVICE=enabled 时失败关闭（生产必须显式声明该开关；disabled 时相关密钥必须留空，自助注册/找回接口返回 503）。
- Secret 只存在于服务器运行环境；公开配置接口只返回 CaptchaAppId/地图公开 Key/功能开关。
- 首个管理员只能通过安全 TTY `npm run admin:bootstrap` 创建；不创建默认账号。
