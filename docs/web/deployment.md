# apps/web 部署与运维 runbook（deployment）

> 适用范围：探员端 H5（apps/web）。生产形态：Caddy 单一公网入口，web 与 API 同源
> （`{$WEB_ORIGIN}` 站点块内 `/api/*` 反代 + 静态托管），apps/api 零改动、零 CORS。
> 相关文件：../../ops/docker/Caddyfile、../../ops/docker/docker-compose.production.yml
> （两者均已接入 web 托管）、../../.env.example、固定测试跑法 ./testing.md、模块契约 ./module-contracts.md。

---

## 1. 本地开发

- 后端：与小程序共后端。本机直跑 API（`PORT=3000`），或用 dev 容器编排——与小程序开发完全同一套后端与数据库。
- 前端：`npm --prefix apps/web run dev` → `http://127.0.0.1:5174`。
  - 端口与代理契约见 apps/web/vite.config.js：固定 5174（strictPort），`/api` 代理到本机后端 127.0.0.1:3000（changeOrigin）。
  - 因此 H5 与小程序开发者工具可同时连同一后端：**同一账号双端登录，操作同一套数据**。
- API 一律同源相对路径 `/api/*`（rules.md R0）：本地同源由 Vite 代理承担，生产同源由 Caddy 承担——源码不出现任何域名/origin 字面量。
- 测试：固定跑法见 ./testing.md（仓库根目录 `npx vitest run --config apps/web/vitest.config.js`）。

## 2. 生产部署步骤

前提：根目录 `.env` 已按 ../../.env.example 配齐全部生产字段；`WEB_ORIGIN` 域名已备案并把 DNS 解析到本机；80/443 已放行；`CADDY_EMAIL` 非空（Caddy 自动 ACME 证书）。

1. **配置站点域名**：根目录 `.env` 增加 `WEB_ORIGIN=https://<你的域名>`（模板占位 `https://web.example.cn`）。
2. **构建产物**：`npm --prefix apps/web run build` → 生成 `apps/web/dist/`（hash 路由 SPA，`try_files` 回退 index.html）。
3. **compose 侧已接入**（ops/docker/docker-compose.production.yml 的 `caddy` 服务）：
   - **卷挂载**：`../../apps/web/dist:/srv/web:ro`——探员端 H5 静态产物只读挂载给 Caddy，与 admin dist 同款语义：部署前必须先构建（第 2 步），Docker 对不存在的挂载源目录会静默创建空目录（空站点），产物缺失由 healthcheck 兜底（见下）。
   - **环境注入**：`WEB_ORIGIN: ${WEB_ORIGIN:-}`——值来自 deploy:production 传入的 `--env-file`（根目录 .env）；留空时 Caddy 启动即失败关闭，与 `PUBLIC_API_ORIGIN`/`ADMIN_ORIGIN` 同语义，不会回退到占位域名。
   - **healthcheck**：`test -f /srv/admin/index.html && test -f /srv/web/index.html`——任一产物缺失即 unhealthy，`docker compose up --wait` 会部署失败、`docker compose ps` 可见 unhealthy，明确暴露"未先构建"错误；interval 30s / timeout 5s / retries 3 / start_period 10s。
4. **Caddy 生效**：
   - 随整体部署：`DEPLOY_CONFIRM=yes npm run deploy:production`（脚本自动携带 `--env-file` 根目录 `.env`）；
   - 已运行集群只加站点：手动 `docker compose -f ops/docker/docker-compose.production.yml --env-file ../../.env up -d caddy`（重建注入新 env）；仅改 Caddyfile 可 `... exec caddy caddy reload --config /etc/caddy/Caddyfile`。
5. **部署后自检**：
   - `curl -sI https://<你的域名>/` → 200，且带 X-Content-Type-Options / X-Frame-Options / Referrer-Policy / Content-Security-Policy；
   - `curl -s https://<你的域名>/api/health/live` → 200（同源反代打通的直接证据）；
   - 浏览器打开 `https://<你的域名>/`，登录后全程 Network 面板只有 `<你的域名>/api/*` 同源请求。

### 2.1 已知缺口（红线外，本批不改，后续批次/运维待办）

以下脚本尚未覆盖 web 产物，上线时需**运维手动保证**第 2 步已执行：

- `scripts/preflight-production.mjs` 只检查 `apps/admin/dist/index.html` 存在性，不查 `apps/web/dist/index.html` 与 `WEB_ORIGIN` 配置；
- `scripts/release-prepare.mjs` 只构建 admin 产物，且泄密扫描清单不含 `apps/web/dist`——web 构建需单独跑 `npm --prefix apps/web run build`，泄密扫描暂无 web 产物覆盖；
- 兜底现状：产物缺失时 Docker 会静默创建空挂载目录，仅 caddy healthcheck（见第 3 条）能把该错误暴露为 unhealthy。

## 3. COS 存储桶 CORS 控制台配置（用户手动操作项，代码不代做）

背景：探员端证据/小票直传链路（./module-contracts.md §3.5 uploadToSignedTarget）是
**浏览器 fetch/XHR 直传**——API 下发 COS 预签名 URL（uploadTarget.url），浏览器以
POST（FormData）直传证据桶；预览则用预签名 GET。跨域 XHR 受浏览器 CORS 约束，
**必须在腾讯云 COS 控制台为证据桶（.env 的 `COS_EVIDENCE_BUCKET`）配置跨域规则**，
否则上传与预览在浏览器侧直接失败（DevTools 报 CORS 错误）。此配置在云控制台完成，
仓库代码与脚本不代做。

控制台路径：腾讯云控制台 → 对象存储 COS → 存储桶列表 → 选中 `COS_EVIDENCE_BUCKET`
对应桶 → **安全管理 → 跨域访问 CORS 设置 → 添加规则**，按下表填写：

| 控制台字段 | 填值 | 理由 |
| --- | --- | --- |
| 来源 Origin | `https://<你的域名>`（= WEB_ORIGIN；精确到 scheme+host，不带端口，除非站点本身带非标端口） | 仅放行探员端 H5 站点本身；不开 `*` |
| 操作 Methods | `POST, GET, PUT, HEAD` | POST=预签名直传；GET=预签名预览；PUT/HEAD=兼容预签名变体与预检探测 |
| Allow-Headers | `*` | 预签名请求头集合由服务端签名口径决定，放行全部避免逐头维护遗漏 |
| Expose-Headers | `ETag` | **必须**：浏览器要读上传响应的 `ETag` 头，填入 completeReceiptUpload 的 etag 字段；不暴露则该字段拿到 null |
| 超时 Max-Age | `600` | 预检结果缓存 10 分钟，减少 OPTIONS 往返 |

开发环境同理：开发桶（.env.development.example 的 `COS_EVIDENCE_BUCKET`）需为
`https://dev-web.example.cn` 对应的开发域名另配一条（开发/生产桶互不通用）。

## 4. 与小程序联动验证点清单（上线后回归）

1. **同一账号双端登录**：同一手机号在小程序端与 H5 端各自登录，均可进入探员工作台。
2. **双端同任务状态可见**：一端作答/上传小票后，另一端进入同一任务，草稿/已提交状态一致。
3. **Admin 不分来源**：任一端提交后，Admin 后台（`{$ADMIN_ORIGIN}`）可见该记录，与小程序提交的记录无来源区分。
4. **部署面旁证**：H5 Network 面板全部 API 请求 host 均为 `WEB_ORIGIN` 自身（同源反代到与小程序相同的 API 实例），数据同库同源是双端一致的根因。

## 5. 附录

### 5.1 零硬编码契约（R0）与单键换域

- **R0 落点**：apps/web 源码零域名（R0 扫描范围 tests/frontend-contract.mjs → `apps/**`），
  全部 API 走同源相对路径 `/api/*`；预签名绝对 URL 只是服务端下发的运行时数据。
  Caddyfile 与本文档虽不在 R0 扫描范围，同样遵守：站点域名一律 `{$PUBLIC_API_ORIGIN}`
  / `{$ADMIN_ORIGIN}` / `{$WEB_ORIGIN}` 环境占位，全文仅 `api:8787` 一类 compose 内部
  服务名，无任何真实业务域名。
- **单键换域**：换域名只改根目录 `.env` 的 `WEB_ORIGIN` 一个键——compose 重新注入并
  重建 caddy 服务、COS 控制台 CORS 的 Origin 同步改为新域名即可。无需重构建 web 产物
  （产物零域名），也无需改 apps/api（web 不在其 CORS 白名单，同源反代天然零改动）。

### 5.2 `route` 块说明（为何不用裸指令）

Caddy 对 Caddyfile 指令按全局固定序重排（try_files 先于 reverse_proxy）。裸写时
`try_files {path} /index.html` 的 SPA 回退会先执行，把 `/api/*` 请求改写为
/index.html，导致反代永不命中。web 站点块用 `route` 包裹以严格按书写顺序执行：
`/api/*` 反代必须先于静态回退。Admin 块无 API 反代，故不受影响、保持原样。

### 5.3 CSP 指令理由表

| 指令 | 值 | 理由 |
| --- | --- | --- |
| default-src | `'self'` | 兜底基线：未单独声明的取材类型一律限同源 |
| script-src | `'self'` | Vite 产物 JS 为自托管外链文件；无第三方脚本、无内联脚本需求 |
| style-src | `'self' 'unsafe-inline'` | Vite 构建把样式经 `<style>` 标签/内联 style 注入产物，必须放行内联样式；无用户输入进入样式的路径 |
| img-src | `'self' data: blob: https:` | `self`=站点静态图；`data:`=内联占位图；`blob:`=小票/证据上传前的本地预览；`https:`=COS 预签名绝对 URL 的证据图片——运行时服务端下发数据，桶域名禁止硬编码，只能放行协议 |
| connect-src | `'self' https:` | `self`=同源 `/api/*` 全部 API（fetch/XHR）；`https:`=uploadToSignedTarget 对 COS 预签名 URL 的直传 POST（同为运行时下发地址，需配合第 3 节桶 CORS） |
| object-src | `'none'` | 禁用 embed/object 插件内容，缩小注入面 |
| base-uri | `'self'` | 防注入篡改 `<base>` 破坏同源相对路径解析（`/api` 契约的前提） |
| form-action | `'self'` | 站点内无跨站表单导航；直传走 fetch 不走表单提交 |
| （header 另有）X-Content-Type-Options / X-Frame-Options / Referrer-Policy | 与 Admin 块一致 | nosniff；DENY 防嵌入 iframe；strict-origin-when-cross-origin 限制外泄 referrer |
