# 暗访问卷后端完整设计规范

> 文档状态：实施基线  
> 适用阶段：第一阶段产品后端从零搭建  
> 当前事实：本文完成的是后端设计，仓库内尚没有可供产品联调的正式后端、数据库、COS 签名服务或 OCR worker。  
> 技术基线：JavaScript ES Modules、Node.js 24 LTS、Fastify 5、Zod、Drizzle、PostgreSQL 17、腾讯云 COS、自托管 PaddleOCR。

> 2026-08-10 全栈收口更新（实现事实，非设计修订）：上方"当前事实"是 2026-07 设计阶段的起点。当前实现状态：
> - 正式后端 `apps/api`（Fastify 5 + Zod + pg pool）与 worker `apps/worker` 已实现，`db/migrations` 共 19 项（含 0019 `system_job_runs`）。
> - 认证供应商按第 6 节接线：`apps/api/src/server.js` 通过 `createConfiguredProviders` 注入 Tencent CAPTCHA（`DescribeCaptchaMiniResult`，CaptchaType=9）与腾讯云短信（`SendSms`，TC3 签名）；生产缺密钥启动失败，`AUTH_PROVIDER_MODE=sandbox` 仅限非生产白名单（`apps/api/src/auth/providers.js`）。
> - COS 按第 12 节实施且升级为可续期凭证：`COS_ROLE_ARN` + `COS_ASSUME_ROLE_SECRET_ID/KEY` 经 CAM AssumeRole 单飞刷新，过期前自动续期，路由在开启事务前 `cos.assertReady()`（网络刷新不发生在持锁期间）；静态 `COS_STS_*` 仅测试/一次性运维（`apps/api/src/storage/cos.js`）。
> - OCR worker 按第 14 节实施并有界并发：`OCR_WORKER_MAX_CONCURRENCY`（1–8）、`OCR_WORKER_CLAIM_LIMIT`、`OCR_WORKER_POLL_INTERVAL_MS`、`OCR_JOB_MAX_ATTEMPTS`、`OCR_MAX_QUEUED_JOBS`（超限返回可重试 503）；队列深度/最老年龄/提交状态等指标由 `GET /metrics` 暴露（`apps/api/src/observability/metrics.js`），worker 心跳与备份完成写入 `system_job_runs`。
> - 健康检查规范路径为 `/health/live`、`/health/ready`（`/live`、`/ready` 兼容别名）。
> - 本地验证：PostgreSQL 17 空库迁移+种子、0017→最新升级路径、31 项 PostgreSQL 集成测试、33 项后端测试、81 项单元/契约测试、13 项 Admin E2E 全部通过（详见 design-qa.md）。P1 容量验收（第 19.4 节）仍需目标 staging 实测。

## 0. 文档目的与约束强度

本文给后端工程师提供可直接实施的唯一后端架构基线，覆盖认证、审批、权限、门店定位、任务、问卷、证据、小票、OCR、菜品、提交、导出、审计、保留、备份和运维。

文档中的“必须”“禁止”是第一阶段验收约束；“建议”允许在不改变业务契约的前提下替换实现。任何实现若需要改变状态机、API 路径、字段含义或安全边界，必须先同时修订本文、共享契约和相关产品规格，不能只改代码。

### 0.1 规范来源与优先级

发生冲突时按以下顺序处理：

1. project_boundary.md：决定第一阶段做什么、不做什么。
2. assignment_spec.md：决定业务状态机、所有权和守卫。
3. IMPLEMENTATION_PLAN.md 第 7 节：决定唯一 API 路径和方法。
4. packages/contracts/index.js：决定当前可执行的请求/响应校验；如与前三项冲突，应先修复共享契约。
5. video_replication_spec.md 与 FRONTEND_RECEIPT_OCR_PROMPT.md：决定交互和前端接入方式，不得反向削弱服务端规则。
6. STATE_MACHINE_OVERVIEW.md：只提供跨文档可视化索引，不创建新的状态、字段或接口。

本文补充后端内部实现细节，不另造第二套业务 API。本文列出的“契约修订”必须在搭建后端批次 0 中先完成。

### 0.2 第一阶段完成定义

只有同时满足以下条件，才可称为“后端第一阶段完成”：

- 正式 API、PostgreSQL、私有 COS、PaddleOCR worker 均已接通，不依赖 fixture 或 Mock。
- 小程序和管理员端只请求正式 API，所有权、RBAC、区域/门店数据范围均由服务端校验。
- 上传使用受限临时许可，原始证据和小票保存在私有 COS，数据库保存可追溯元数据。
- 提交是不可逆、原子且幂等的；提交后所有答案、菜品、小票、OCR 和附件写接口均拒绝。
- 定时任务、租约恢复、数据保留、备份恢复和审计均有自动化测试或演练证据。
- 微信开发者工具及 Android 真机仍需单独验收；浏览器或 contract server 通过不等于产品完成。

### 0.3 实施人员快速索引

| 任务 | 重点章节 |
|---|---|
| 注册、审批、登录、忘记密码 | 6、8.2、11.1 |
| 门店坐标、定位、打卡和豁免 | 8.3、8.5、9.4、11.2–11.3 |
| 父任务、逐人分配和逾期 | 8.5、9.1–9.3 |
| 题库（启用题号 1..N 连续、数量不设上限）和不合格证据 | 8.4、8.6、9.5、11.4 |
| 小票私有上传和长期保存 | 8.7、12 |
| PaddleOCR 和菜品自动带入 | 9.6、13、14 |
| 幂等提交和崩溃恢复 | 8.8、9.7–9.8 |
| 四张统一状态图与整体流程 | STATE_MACHINE_OVERVIEW.md |
| 当前并发能力审计与 P1 判定 | CONCURRENCY_REVIEW.md、3.4、19.4 |
| API/前端契约修订 | 10–11 |
| 安全、监控、备份、测试和上线 | 15–22 |

## 1. 已确定的技术决策

| 领域 | 第一阶段固定方案 | 原因 |
|---|---|---|
| 架构 | 模块化单体 API + 独立 worker | 事务边界清楚，适合当前规模，部署和排障简单 |
| 运行时 | Node.js 24 LTS，JavaScript ESM | 与现有仓库一致，并使用当前 LTS |
| HTTP | Fastify 5 + Zod | 性能稳定，共享运行时契约 |
| 包管理 | npm workspaces + 根 package-lock.json | 与当前实际安装和脚本一致，避免 npm/pnpm 双锁漂移 |
| 数据库 | PostgreSQL 17 当前小版本 | 支持行锁、部分唯一索引、JSONB 和可靠队列 |
| 查询与迁移 | Drizzle 查询层 + 显式 SQL migration | 保留类型/结构便利，同时能表达复杂约束 |
| 文件 | 腾讯云 COS 私有 Bucket | 与腾讯云服务器同地域，文件与主机生命周期解耦 |
| OCR | `OCR_PROVIDER` 三态开关（默认 `none`）：`tencent` 腾讯云通用印刷体识别 / `paddle` 自托管 PaddleOCR（PP-OCRv6 small） | 默认关闭：小票纯手工填写即可上线，2C2G 单机可部署；开启后人工确认仍是最终依据 |
| 短信 | 腾讯云短信 Adapter | 手机验证和密码找回所需，密钥只在后端 |
| 行为验证 | 第三方滑块/行为验证码 Adapter | 服务端必须二次核验票据 |
| 地图与坐标 | 腾讯位置服务录入 GCJ-02；微信原生定位 | 符合小程序和中国坐标体系 |
| 后台任务 | PostgreSQL job 表 + FOR UPDATE SKIP LOCKED | 第一阶段不引入 Redis、RabbitMQ 或 Kafka |
| 金额 | 整数分 | 避免浮点误差 |
| 时间 | 数据库存 UTC，接口 ISO 8601 含时区，UI 转 Asia/Shanghai | 避免夏令时和服务器时区歧义 |
| ID | UUID v7 | 不暴露自增规模，并保留大致时间局部性 |

**设计决定修订（原"no cloud-OCR fallback"条款）**：早期设计固定"仅自托管 PaddleOCR、禁止云 OCR"。修订为 `OCR_PROVIDER` 三态开关（`none` 默认 / `tencent` / `paddle`），理由：

- 小票图片本就存于腾讯云 COS 私有桶（同厂商、同地域 ap-shanghai）；`tencent` provider 并不引入新的数据出域边界，识别调用走 HTTPS API，密钥由 worker 持有。
- worker 持有的是仅可调用 OCR 接口的最小权限 CAM 子账号密钥（不能读 COS、不能访问其他服务），泄露半径有界。
- `model_version` 记录 provider+模型（paddle→`PP-OCRv6_small`，tencent→`tencent-general-basic`），历史 job 的识别结果可复现、可追溯。
- provider 进入 OCR job 的 `input_hash`：切换 provider 后同一批小票不会命中旧 provider 的结果缓存（缓存串味防护）；paddle 沿用历史标签 `paddleocr`，既有 job 幂等去重行为不变。
- 语义不变的部分：云 OCR 仍然绝不作为 PaddleOCR 低置信度或失败时的**自动**降级路径；是否启用 OCR、用哪个 provider，永远由管理员显式配置（生产环境必须显式声明 `OCR_PROVIDER`，缺省即关闭）。启用 `tencent` 即接受按量付费，调用上限由 `OCR_MAX_QUEUED_JOBS`/`OCR_JOB_MAX_ATTEMPTS` 与队列深度兜底，审计沿用 `receipt_ocr_requested`/`receipt_ocr_applied` 事件。

`OCR_PROVIDER` 开关语义：

| 取值 | 含义 | 生产强制校验 |
|---|---|---|
| `none`（默认） | 纯手动填写，OCR 功能关闭；worker 静默跳过 OCR 轮询，创建 OCR job 返回不可重试 503 `OCR_NOT_CONFIGURED` | `OCR_SERVICE_URL` 与腾讯 OCR 密钥必须全部留空 |
| `tencent` | 腾讯云 GeneralBasicOCR 按量付费；入口显隐经 `/api/public/client-config` 的 `features.receiptOcr` 动态下发，小程序无需发版 | `OCR_SECRET_ID`/`OCR_SECRET_KEY` 必填且非占位值；`OCR_SERVICE_URL` 必须留空 |
| `paddle` | 自托管 PaddleOCR sidecar（逃生舱） | `OCR_SERVICE_URL` 必填（私网地址、禁 localhost/占位值）；腾讯密钥必须留空 |

已知限制（接受，不解决）：腾讯云接口 base64 上限约 7MB，而单附件允许 10MiB——超限图片该 provider 会失败并走终态失败路径，由探店员手工填写兜底；禁止为此引入图片压缩依赖。

## 2. 系统边界与总体架构

~~~mermaid
flowchart LR
  Mini["微信小程序\n探店员"] -->|"HTTPS JSON"| API["Fastify API\n业务与权限"]
  Admin["React 管理后台"] -->|"HTTPS JSON + Cookie/CSRF"| API
  API --> PG[("PostgreSQL\n业务数据与任务队列")]
  API -->|"短时限定上传许可"| Mini
  Mini -->|"原图直传"| COS[("腾讯云 COS\n私有证据库")]
  API -->|"HEAD/读取校验\n短时查看链接"| COS
  Worker["Node Worker\n租约、解析、清理、导出"] --> PG
  Worker --> COS
  Worker -->|"OCR_PROVIDER 分发"| OCR["OCR Provider\npaddle=自托管 sidecar（可选）\ntencent=腾讯云 OCR"]
  API --> SMS["短信/行为验证供应商"]
  API --> LBS["腾讯位置服务\n仅录入/地址辅助"]
~~~

### 2.1 组件职责

Fastify API 负责：

- 身份认证、会话、RBAC、数据范围和所有权。
- 业务状态机、revision、幂等、事务和审计。
- 上传初始化、对象完成校验、短时预览链接。
- 门店距离计算、打卡、豁免和任务推进。
- OCR 任务创建、查询和候选应用；不在请求线程执行模型推理。
- 管理端查询、导出任务创建和下载授权。

Node Worker 负责：

- OCR job 取租约、下载私有小票、调用 PaddleOCR、规范化和解析。
- 逾期任务、豁免过期、提交崩溃恢复。
- 临时附件、过期会话、归档恢复、导出和保留清理。
- COS/数据库孤儿对象对账、备份状态检查和指标汇总。

PaddleOCR Sidecar 只负责：

- 接收本机或私有网络中的图片字节。
- 图像预处理、文字检测、方向分类和中文文字识别。
- 返回文字、置信度和边界框。
- 不读取 PostgreSQL，不持有 COS、短信或用户凭据，不直接修改菜品。

PostgreSQL 是业务真相源；COS 只保存对象；PaddleOCR 输出是建议；客户端本地状态不是服务端事实。

### 2.2 第一阶段明确不引入

- 微服务拆分、服务网格、分布式事务。
- Redis 会话、Redis 队列、Kafka、RabbitMQ。
- Elasticsearch。
- 自动 AI 判分、自动决定“得分/不得分”。
- OCR 结果未经探店员确认直接提交。
- 公有 Bucket、永久签名 URL 或后端中转所有上传。

## 3. 腾讯云部署拓扑

### 3.1 环境

至少建立三套逻辑环境：

| 环境 | 用途 | 数据要求 |
|---|---|---|
| local | 开发和自动化测试 | 只能使用合成/脱敏样本；本地 S3 兼容服务可替代 COS |
| staging | 小程序体验版、集成和恢复演练 | 独立数据库、独立私有 Bucket、独立短信模板或白名单 |
| production | 正式业务 | 独立账号权限、密钥、Bucket、备份与告警 |

环境之间禁止共用数据库、Bucket、Cookie 域、签名密钥和短信 challenge。对象 key 必须包含环境前缀作为第二道保护，但不能把前缀当作环境隔离的唯一手段。

### 3.2 生产推荐

- API 与 Node Worker 部署在腾讯云同一地域、同一 VPC。
- PostgreSQL 优先使用腾讯云托管 PostgreSQL；预算受限的最早阶段可暂放独立云主机，但必须每日异机备份，并在首批真实用户前迁移或完成故障演练。
- COS 与服务器同地域，API/worker 通过内网域名访问。
- PaddleOCR 单独部署在至少 4 vCPU、8 GiB 内存的 CPU 实例或容器节点；2 vCPU/2 GiB Lighthouse 只适合低流量 API，不适合稳定 OCR 推理。
- API 前使用腾讯云负载均衡或受管理 HTTPS 入口；TLS 1.2+，仅开放 443。
- 数据库、OCR sidecar 和内部管理端口不暴露公网。

#### 3.2.1 低成本单机形态（2C2G Lighthouse，OCR_PROVIDER=none）

`OCR_PROVIDER=none`（默认）下，系统不再携带 PaddleOCR sidecar（原常驻约 2.5GiB 内存），小票以纯手工填写流程运作，2 vCPU / 2 GiB 的腾讯云 Lighthouse 单机即可承载全栈：

- 拓扑：`docker compose`（ops/docker/docker-compose.production.yml）单机编排 postgres（同机自建 PG17）+ api + worker + caddy；Caddy 是唯一公网入口，数据库仅内网、5432 只绑定宿主机 127.0.0.1（供备份/迁移/preflight 等宿主机脚本经 `DATABASE_HOST_URL` 使用）。
- 备份要求：每日 `npm run ops:backup`（BACKUP_EXECUTION_CONFIRM=yes）将 `pg_dump` 备份上传至 COS 备份桶，35 天滚动保留；定期执行恢复演练（`ops/restore-drill.mjs`，使用隔离演练库，禁止指向生产库）。同机自建数据库没有托管实例的自动备份，该演练是硬性要求而非可选动作。
- 容量边界：该形态是试点配置，不具备高可用结论（见 3.4）；用户量或小票量增长后，先恢复 `paddle`（`--profile ocr`，需 4C8G+）或切换 `tencent`，再考虑 API 横向扩展与托管数据库。
- 启用 OCR：`.env` 修改 `OCR_PROVIDER=tencent` 并填写 `OCR_SECRET_ID`/`OCR_SECRET_KEY`（或 `paddle` 并提供私网 `OCR_SERVICE_URL`），`docker compose up -d` 生效；`features.receiptOcr` 经 client-config 动态下发，小程序无需重新发版。

服务器可以使用阿里云等平台，但若 COS 留在腾讯云会产生跨云公网流量、延迟和更多密钥边界。第一阶段固定同地域腾讯云部署，避免无业务收益的混云。

### 3.3 容量起点

以下是起点，不是永久承诺：

- API：2 vCPU / 2–4 GiB，开发/小规模试点可单实例起步；正式并发验收至少使用两个无状态 API 进程或实例，并置于同一受控入口后。
- Worker/OCR：4 vCPU / 8 GiB，worker 并发 1 起步。
- PostgreSQL：2 vCPU / 4 GiB、100 GiB SSD、自动备份；连接池上限按实例能力设置。
- 单张小票最大 10 MiB、每问卷最多 9 张；问题证据图片/音频限制见共享附件策略。
- OCR 单任务最多处理 9 张，单张超时 90 秒，整任务最大执行 10 分钟。

不要根据这些数字在业务代码中硬编码容量；限制进入配置并有上下界。

### 3.4 并发部署、连接池与背压

“业务并发正确”与“硬件能承受多少并发”是两件事：前者由事务、唯一约束、revision 和幂等保证；后者只能由目标环境压测证明。任何实现不得把“用了 Fastify/PostgreSQL”直接写成“支持任意 N 人并发”。

第一阶段固定规则：

- API 必须无进程内业务会话和“当前任务”状态，任一请求都能被任一 API 实例处理；会话、限流、幂等和 job 状态均落 PostgreSQL。
- 生产至少两个 API 进程或实例，支持滚动重启和故障摘除；预算受限的单机单进程只可称为试点配置，不具备高可用结论。
- 初始 PostgreSQL 连接池建议每个 API 实例最多 10、worker 最多 5；必须满足 `所有 API 池 + worker 池 + 运维预留 <= max_connections * 70%`。池获取等待默认最多 2 秒，超时返回可重试 `503 DATABASE_BUSY`，不能无限排队。
- 单个父任务默认最多 500 条分配；需要提高 `MAX_ASSIGNMENTS_PER_CAMPAIGN` 前必须用目标规模重跑发布、整体取消和同父任务集中提交压测。
- 同一父任务内的状态变化会短暂串行在 campaign 行上；不同父任务和不同问卷可以并行。父任务重算使用 `(campaign_id, status)` 索引，普通单分配转换不得锁定该父任务的全部分配。
- Argon2、图片解码、音频解析、SHA-256 和压缩等 CPU/内存任务必须有独立有界信号量。2 vCPU API 起始值为密码哈希 2、附件校验 2；等待队列达到配置上限时返回带 `Retry-After` 的可重试 503，禁止无限占用 Event Loop、libuv worker pool 或内存。
- OCR 推理、导出和保留清理不得在 API 请求线程执行。OCR worker 并发 1 只是低流量起点；队列长度只影响识别等待时间，不应拖慢问卷普通 API。
- Fastify 必须设置非零 request/handler timeout、bodyLimit、keep-alive 和优雅关闭；收到终止信号后先从入口摘流、拒绝新请求、等待在途短事务结束，再关闭连接池。
- PostgreSQL `40P01` 死锁和 `40001` 序列化失败最多做 3 次带抖动重试；只有请求本身具备幂等键或纯读时才自动重试。锁等待超过 `lock_timeout` 返回可重试冲突，不能无限等待。

初始数值是安全起点，不是容量承诺；正式上线门槛见第 19.4 节。

## 4. 仓库结构

建议在当前单仓库中新增：

~~~text
apps/
  api/
    src/
      app.js
      server.js
      config/
      plugins/
      modules/
        auth/
        users/
        rbac/
        stores/
        campaigns/
        assignments/
        checkins/
        questionnaires/
        evidence/
        receipts/
        ocr/
        submissions/
        exports/
        audits/
        retention/
      infrastructure/
        db/
        cos/
        captcha/
        sms/
        location/
      jobs/
      observability/
    test/
  worker/
    src/
      worker.js
      leases/
      jobs/
        receipt-ocr.js
        overdue.js
        exemption-expiry.js
        submission-recovery.js
        object-cleanup.js
        retention.js
        export.js
        reconciliation.js
    test/
  ocr-service/
    app/
    models/
    tests/
packages/
  contracts/
  domain/
  config/
db/
  migrations/
  seeds/
  checks/
ops/
  docker/
  runbooks/
  scripts/
tests/
  load/
    p1-mixed.js
    p1-submit-race.js
    p1-campaign-hotspot.js
    p1-upload-ocr.js
~~~

约束：

- packages/contracts 是 HTTP schema 唯一来源，禁止前后端各写一份同名 DTO。
- packages/domain 只放无 I/O 的领域函数、状态转换和计算，例如 Haversine、父任务状态重算、提交完整性检查。
- apps/api 不导入小程序或 React 代码。
- Python 仅用于 OCR 推理；认证、金额解析、菜品匹配和业务规则保持在 JavaScript。
- migration 只向前执行；生产禁止 ORM 自动同步 schema。
- 批次 0 在根 package.json 增加 workspaces，并迁移为唯一根 package-lock.json；确认 npm install/test 通过后再移除遗留的 apps/admin/package-lock.json 和未实际使用的 pnpm-workspace.yaml。迁移完成前不得同时更新两套锁文件。

## 5. 通用 API 与数据约定

### 5.1 HTTP

- 所有产品接口使用 /api 前缀。
- JSON Content-Type 为 application/json; charset=utf-8。
- GET 无副作用；POST 执行动作或创建；PATCH 局部修改；PUT 替换一个有明确集合语义的资源；DELETE 仅用于规范允许的草稿删除。
- 请求体默认最大 1 MiB；文件不通过普通 JSON 上传。
- 列表使用 cursor + limit，limit 默认 20、最大 100；不得用无限全量列表。
- 服务端生成 requestId，并在响应头 X-Request-Id 返回。
- 客户端日期必须为 ISO 8601 且包含时区；服务端拒绝无时区值。
- API 不返回 storage_key、密码哈希、验证码、供应商原始密钥或内部堆栈。

成功响应直接使用共享 schema 描述的资源。错误统一：

~~~json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "内容已在其他位置更新，请刷新后重试",
    "retryable": false,
    "requiresNewToken": false,
    "requestId": "019..."
  }
}
~~~

### 5.2 HTTP 状态和错误分类

| HTTP | 场景 |
|---|---|
| 400 | schema、格式或条件字段不合法 |
| 401 | 未登录、会话过期或 token 被撤销 |
| 403 | 已登录但无角色、范围或所有权 |
| 404 | 资源不存在，或为避免越权枚举而隐藏 |
| 409 | revision、状态机、唯一性或幂等摘要冲突 |
| 410 | 临时上传许可、challenge 或 reset token 已失效 |
| 413 | 请求或文件超过限制 |
| 422 | 业务完整性不满足，例如证据缺失 |
| 429 | 用户/IP/手机号/供应商限流 |
| 503 | 可重试的供应商、OCR 或基础设施暂不可用 |

内部错误记录技术详情；面向探店员的 message 使用中文业务文案，不显示 SQL、HTTP 上游响应、API 路径或堆栈。

### 5.3 revision 与并发

- 所有可编辑聚合根保存整数 revision，从 0 开始。
- 修改请求携带当前 revision；SQL 使用 WHERE id = ? AND revision = ? 并原子 revision = revision + 1。
- 影响多个子项的写操作先锁聚合根，再修改子项，最后只增加一次聚合 revision。
- revision 冲突返回 409 REVISION_CONFLICT，并返回最新安全摘要；不能静默覆盖。
- 附件上传初始化也会占用问卷附件名额并增加 revision。

审批、启停、发布、取消、延期、豁免、题库复制/发布、导出和归档恢复等管理员动作 POST 还必须携带 Idempotency-Key 请求头。相同 actor + route scope + key + request hash 重放首次结果；同 key 不同请求冲突。revision 解决并发覆盖，幂等键解决响应丢失后的安全重试，二者不能互相替代。

### 5.4 金额、数量和文本

- 第一阶段币种固定 CNY；所有金额字段为 bigint/int 的整数分，接口为安全整数范围内的 number；不保存浮点人民币。
- 菜品数量第一阶段固定为 1–999 的整数；共享 DishRecordSchema 必须改为 int。
- 普通备注/菜名等文本做 Unicode NFC 并按字段规则去除首尾空白；用户名单独做 NFKC 和 ASCII 大小写归一；密码按原始输入逐字节验证，绝不 trim、规范化或改变大小写。
- 用户文本进入 HTML 时必须转义；导出 CSV 时对以 =、+、-、@ 开头的单元格加安全前缀，防公式注入。
- 普通备注最大 2,000 字；不得分说明最少 1 个非空字符，最大 2,000 字。

## 6. 认证、注册、审批和会话

### 6.1 密码

- 使用 Argon2id。
- 最低参数：内存 19 MiB、迭代 2、并行度 1；服务器基准测试后只可提高。
- 每条密码独立随机盐；可额外使用存于密钥管理中的 pepper。
- 密码 10–64 字符，允许密码管理器和粘贴；拒绝常见泄露/弱密码。
- 数据库只存 password_hash、password_changed_at 和 password_version。
- 日志、审计、分析和错误响应绝不记录密码或哈希。
- 密码哈希/验证走异步原生实现并受 `AUTH_HASH_MAX_CONCURRENCY` 有界信号量保护；2 vCPU 实例默认最多同时 2 个，队列满时返回带 Retry-After 的可重试 503。必须用实际 Argon2 基准确认参数与登录峰值，不能在 Event Loop 中执行同步哈希。

### 6.2 探店员注册

固定流程：

1. 客户端完成行为验证码，获得短时 ticket。
2. POST /api/auth/register/phone-code 提交手机号、ticket 和设备风险摘要。
3. 后端在数据库事务外向验证码供应商二次核验；成功后以短事务创建 delivery_status=pending 的 SMS challenge，并使同手机号/用途的旧 challenge 失效。
4. 提交事务后调用短信 Adapter；成功则短事务置 sent 并记录 provider_message_id，失败则置 send_failed/invalidated。数据库事务期间不等待供应商。
5. 用户提交用户名、手机号、密码、确认密码、phoneChallengeId 和 smsCode。
6. POST /api/auth/register 在一个事务内锁定 sent challenge，核验手机号、用途、有效期和错误次数，成功后原子消费。
7. 创建 user 和 inspector_registration，状态为 pending_approval；不创建业务会话。
8. 管理员批准后用户才可登录并获取业务 token。

当前 RegisterRequestSchema 中 phoneVerificationToken 没有可签发它的接口，因此批次 0 必须修订为 phoneChallengeId + smsCode。禁止为了兼容当前字段而在客户端伪造 token。

用户名和手机号均采用数据库唯一索引。注册响应对已存在手机号不暴露具体账号信息；管理员审计可见冲突原因。

### 6.3 审批状态机

账号状态图统一见 [STATE_MACHINE_OVERVIEW.md](STATE_MACHINE_OVERVIEW.md) 第 1 节；本节保留服务端守卫与会话副作用。

- rejected 不能直接变为 approved_active，必须回到 pending_approval 再批准。
- 拒绝原因仅本人和有权限管理员可见。
- 停用在同一事务中增加 session_version 并撤销全部会话。
- 停用后未开始分配冻结；已有草稿保留但不能继续写或提交；管理员不得把已有草稿转让给别人。
- 重新启用要求重新登录，不恢复旧 token。

“冻结”不是新的 assignment 状态；API 根据 user.status 返回 executionBlockedReason=USER_DISABLED。这样任务仍按时间推进为 overdue，管理员可以取消，重新启用原用户后合法任务可继续。

密码正确后的登录结果按状态区分：

- approved_active：签发 inspector 业务会话。
- pending_approval：只签发 application_status 会话，可调用 /api/me 和 logout 查看等待状态。
- rejected：只签发 application_status 会话，可查看拒绝原因并调用 registration/resubmit。
- disabled：不签发任何新会话，只显示业务化停用提示。

application_status 会话不能访问任务、问卷、附件或管理员 API。

### 6.4 忘记密码

> 2026-08-13 策略调整：小程序端忘记密码 UI 已隐藏（`wx:if="{{false}}"`），本节后端流程全部保留不变，供其它调用途径与将来恢复 UI 使用。

1. POST /api/auth/password-resets/code 接收手机号和服务端可验证的行为验证码票据。
2. 无论手机号是否存在，返回一致文案和尽量一致的响应时序；不存在时不发短信。
3. 存在账号时复用注册短信的 pending → sent/send_failed 外部调用状态机；不存在账号执行等时的空操作，二者均不在数据库事务中等待供应商。
4. challenge 默认 5 分钟有效、60 秒后才可重发；重发原子失效旧 challenge。
5. 每个验证码最多错误 3 次；第 3 次失败原子锁死。并发请求通过行锁/条件更新不能突破 3 次。
6. POST /verify 成功后消费验证码并签发随机 256-bit、10 分钟、单次使用的 reset token；数据库只存 token hash。
7. POST /complete 锁 token，校验密码策略，更新密码并消费 token，增加 session_version，撤销全部旧会话。
8. 完成后不自动登录，返回登录页。

### 6.5 会话

探店员小程序：

- 使用 256-bit 不透明 bearer token；数据库只保存带服务端密钥的 HMAC-SHA-256 和 key version。
- access token 默认空闲 12 小时、绝对 30 天；每次认证校验用户状态和 session_version。
- 小程序安全存储 token；日志和错误上报必须脱敏。

管理员网页：

- 使用随机服务端会话，Cookie 设置 HttpOnly、Secure、SameSite=Strict、限定 Path。
- 登录响应同时返回可轮换 CSRF token；所有写请求要求 X-CSRF-Token。
- AdminSessionSchema 必须增加 csrfToken，管理员 fetch adapter 必须统一携带。
- 空闲 30 分钟、绝对 12 小时；高风险操作可要求最近 15 分钟内重新认证。

/api/admin/* 只接受管理员 Cookie，不接受小程序 bearer token；探店员业务接口只接受 bearer/application_status token。/api/me 可识别其中一种凭据，但请求同时携带两种时拒绝，避免混淆身份。

首个 super_admin 只可通过服务器 TTY 的一次性 npm run admin:bootstrap 命令创建。命令交互读取两次密码、确认当前没有首管、记录审计并立即失效 bootstrap 授权；不得接受命令行明文密码，不得在 HTTP 中暴露“创建首管”接口。

### 6.6 限流

第一阶段使用 PostgreSQL 固定窗口/令牌桶表，按接口组合手机号 hash、用户、IP 和设备摘要：

- 登录：每 IP 每分钟 20 次、每账号每 15 分钟 10 次失败。
- 短信：同手机号 60 秒 1 次、24 小时最多 10 次；同 IP 另有限额。
- 密码验证：challenge 固有 3 次错误上限。
- 打卡：每用户/分配每分钟 10 次，连续范围外只保留必要明细并提示稍后重试。
- 上传初始化：每用户每分钟 30 次。
- OCR 创建：每问卷同一 input_hash 幂等；每用户每分钟 5 次。
- 最终提交：每问卷每分钟 5 次，仍必须走 submitToken 幂等。
- 管理员导出：每用户同时最多 2 个运行任务。

阈值进入配置并不得弱于供应商限制；限流 key 使用 HMAC，禁止把明文手机号写进指标标签。

## 7. 授权、所有权和数据范围

角色：

| 角色 | 主要范围 |
|---|---|
| inspector | 只访问分配给自己的任务、问卷、证据、小票和提交成功摘要 |
| super_admin | 全部管理能力，包括角色、范围、保留和高风险审计 |
| operations_admin | 授权区域内门店、探店员、任务、豁免、题库和提交 |
| reviewer | 授权区域内已提交结果、原始证据、小票/OCR 对比和导出，只读 |
| store_manager | 指定门店的已提交摘要/证据，只读；不能看到其他门店或账号管理 |

实现要求：

- 路由层只做身份和粗粒度权限，repository 查询必须再次带 scope 条件。
- inspector 所有权通过 attempt.assignment_id → assignment.inspector_id 联表推导，不在 attempt 重复存 owner_user_id。
- 对不属于当前用户的资源优先返回 404，避免枚举。
- storage_key 永远不由客户端决定；预览 URL 只在授权后签发。
- 所有管理员列表默认应用区域/门店 scope；前端筛选器不能扩大服务端范围。
- reviewer/store_manager 默认不返回探店员手机号；store_manager 只得到完成业务所需的显示名或去标识标签，查看完整账号身份需要额外 users:review 权限并写审计。
- 角色、scope、豁免、延期、取消、审批、导出和预览原始证据均写不可变审计日志。

权限至少拆分为：

~~~text
users:review
users:disable
roles:manage
stores:read
stores:write
campaigns:read
campaigns:write
campaigns:publish
assignments:read
assignments:write
checkin:exempt
questionnaires:read
questionnaires:write
questionnaires:publish
submissions:read
evidence:read
exports:create
audits:read
retention:manage
~~~

权限判定不得只依赖前端隐藏按钮。

## 8. PostgreSQL 数据模型

### 8.1 数据库基础

启用扩展：

~~~sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
~~~

通用约定：

- 主键 uuid，应用生成 UUID v7。
- created_at、updated_at 使用 timestamptz，默认数据库 now()。
- 可编辑聚合带 revision bigint NOT NULL DEFAULT 0。
- 业务枚举使用 PostgreSQL enum 或带 CHECK 的 text；迁移必须能向前扩展。
- 手机号使用标准化 E.164/中国大陆格式的密文与 blind index：phone_ciphertext 用信封加密，phone_lookup_hmac 用于唯一查询。
- 用户可见业务编号单独生成，不使用 UUID。
- 敏感 JSON 不存入通用审计 payload。

数据库运行约定：

- 默认隔离级别 READ COMMITTED，依靠显式 SELECT FOR UPDATE、revision、唯一约束和条件更新；不把全局 SERIALIZABLE 当作并发设计替代品。
- session timezone 固定 UTC。
- 普通 API statement_timeout 10 秒、lock_timeout 2 秒、idle_in_transaction_session_timeout 30 秒；导出/迁移使用独立角色和明确更高上限。
- API、worker、migration 使用不同 application_name 和连接池；各实例池总和不超过数据库 max_connections 的 70%，为运维和恢复保留连接。
- 第一阶段不启用复杂 PostgreSQL RLS；应用查询必须带 scope/owner 条件，并以越权集成测试保证。若以后启用 RLS，仍不能删除应用层授权。

### 8.2 账号、认证与权限

#### users

主要字段：

- id、username_display、username_normalized、display_name。
- phone_ciphertext、phone_lookup_hmac、phone_verified_at。
- password_hash、password_changed_at、password_version。
- status：pending_approval、approved_active、rejected、disabled。
- session_version、last_login_at、disabled_at、closed_at、anonymized_at、created_at、updated_at。

约束：

- username_normalized 唯一；phone_lookup_hmac 唯一。
- approved_active 必须 phone_verified_at 非空。
- password_hash 不可空。

username_normalized 由用户名 NFKC 后对 ASCII 大小写归一得到；原展示值单独保存。手机号先规范为 +86 E.164，再加密保存并对规范值计算 HMAC blind index，不保存可直接查询的明文手机号。

#### inspector_registrations

- id、user_id、status、rejection_reason。
- submitted_at、reviewed_at、reviewed_by、revision。
- previous_registration_id，可追溯重新提交链。

一个 user 只能有一条当前 pending_approval 申请。批准、拒绝、重新打开均使用状态 + revision 条件更新并写审计。

#### roles、permissions、role_permissions、user_roles

角色与权限显式建模。user_roles 带 granted_by、granted_at、revoked_at。普通探店员不能拥有管理员角色。

#### user_data_scopes

- user_id。
- scope_type：all、region、store。
- region_id/store_id，按类型条件约束。
- granted_by、granted_at、revoked_at。

查询权限是角色权限与有效 scope 的交集。

#### auth_sessions

- id、user_id、token_hmac、token_key_version、kind：inspector/admin/application_status。
- session_version、csrf_secret_hash（管理员）、idle_expires_at、absolute_expires_at。
- last_seen_at、revoked_at、revoke_reason、created_at。

token_hmac 唯一；过期或撤销会话由清理任务删除，安全审计保留摘要而非 token。

#### phone_verification_challenges

- id、purpose：registration/password_reset。
- phone_lookup_hmac、phone_ciphertext。
- code_hmac、provider_message_id、expires_at、resend_available_at。
- delivery_status：pending、sent、send_failed。
- failed_attempts、max_attempts 默认 3、consumed_at、invalidated_at。
- captcha_provider、captcha_verification_id、created_ip_hmac、created_at。

验证码由密码学安全随机数生成 6 位数字，只保存带服务端密钥的 HMAC。校验必须锁行；成功消费与用户/重置 token 创建位于同一事务。

#### password_reset_tokens

- id、user_id、token_hmac、key_version、expires_at、consumed_at、created_at。
- token_hmac 唯一；同用户签发新 token 时使旧 token 失效。

#### rate_limit_buckets

- scope、key_hmac、window_started_at、count、expires_at。
- UNIQUE(scope, key_hmac, window_started_at)。
- 消费额度必须用单条 `INSERT ... ON CONFLICT ... DO UPDATE SET count = count + 1 ... RETURNING` 原子完成，禁止先读后写；限流事务不得同时持有任何业务聚合锁。
- `(expires_at)` 建清理索引并小批量删除。监控单桶锁等待；只有真实 P1/P2 压测证明 PostgreSQL 限流表成为热点时，才把该基础设施职责迁移到 Redis，业务状态仍留在 PostgreSQL。

### 8.3 区域和门店

#### regions

- id、name、code、active、revision、created_at、updated_at。

#### stores

- id、business_no、name、region_id、address。
- latitude_gcj02、longitude_gcj02、coordinate_provider 固定 tencent。
- provider_poi_id、coordinate_source：poi 或 manual_adjusted。
- checkin_radius_meters。
- accuracy_allowance_max_meters。
- location_verified_at、location_verified_by。
- active、revision、created_at、updated_at。

发布守卫：

- 经纬度必须是 GCJ-02，且在合法范围。
- checkin_radius_meters 默认 300，允许按门店在 100–1000 米内配置。
- accuracy_allowance_max_meters 默认且最大 200 米，商场室内误差不能无限放大。
- location_verified_at 非空。

打卡服务端判定：

~~~text
effectiveRadius = checkinRadius + min(clientAccuracy, accuracyAllowanceMax)
pass = clientAccuracy <= accuracyAllowanceMax
       AND sampleAge <= 60 seconds
       AND haversine(sample, store) <= effectiveRadius
~~~

Haversine 使用平均地球半径 6,371,008.8 米，计算中夹紧浮点边界；是否通过使用未四舍五入值，展示距离才取整。capturedAt 比服务端时间未来超过 5 秒同样拒绝，防设备时钟/伪造样本绕过新鲜度。

不额外调用地图供应商决定打卡结果；地图服务仅协助管理员选点、地址和 POI。

管理员地图使用仅允许正式后台域名的腾讯位置服务浏览器 Key；地址/POI WebService 使用仅允许生产出口 IP 的独立服务端 Key。小程序不持有这两个 Key，且不得混存 WGS84、BD-09 或高德坐标作为门店业务真值。管理员拖动校准坐标、半径或补偿上限都写审计。

### 8.4 题库和版本

#### questionnaire_templates

- id、name、mode、active、created_by、created_at。

#### questionnaire_versions

- id、template_id、version_number、effective_at。
- status：draft、published、retired。
- source_version_id。
- revision、created_by、created_at、published_by、published_at。

已发布版本不可修改。复制操作创建新 draft，并复制题目和证据要求但生成新的版本 ID；稳定 question_key 保留。API 的 versionLabel 由版本号/展示规则生成。

#### questions

- id、version_id、question_key。
- question_number、category：environment/service/product。
- text、max_score、risk_level、enabled、sort_order、revision。

#### question_evidence_requirements

- question_id。
- evidence_required。
- image_required。
- audio_required。
- image_min_count：0 或 1。
- audio_min_count：0 或 1。

约束：

~~~sql
CHECK (
  (NOT evidence_required AND NOT image_required AND NOT audio_required)
  OR
  (evidence_required AND (image_required OR audio_required))
)
~~~

含义：

- 未勾选“上传不合格图片/证据”时，三项均 false。
- 勾选后至少选择图片或音频，可以两者都选。
- 探店员选择 unscored 后，文字问题说明永远必填；图片/音频按版本配置分别必填。

发布版本必须至少 1 道 enabled 题，启用题 question_number 覆盖 1..N 连续且不重复（数量不设上限），分类必须属于启用中的动态分类，稳定 question_key 不重复。停用题（enabled=false）编号排在启用题之后，不参与发布校验。发布事务执行完整校验，不能只校验第一版种子。管理员可在草稿版本上新增、删除、排序题目（题号按启用优先自动重排）和启用/停用单题。

关键索引：

~~~sql
CREATE UNIQUE INDEX questions_version_number_uq
  ON questions(version_id, question_number);
CREATE UNIQUE INDEX questions_version_key_uq
  ON questions(version_id, question_key);
~~~

### 8.5 父任务、分配、菜品要求和打卡

#### audit_campaigns

- id、business_no、name、store_id。
- starts_at、due_at、common_instruction。
- status：draft、published、in_progress、completed、cancelled。
- created_by、created_at、published_by、published_at、completed_at。
- cancelled_by、cancelled_at、cancel_reason。
- revision、updated_at。

父任务状态持久化，由唯一领域函数在每次分配状态变化的同一事务中重算：

- draft：未发布。
- published：已发布且所有非取消分配尚未开始、未逾期。
- in_progress：任一分配已开始/逾期，或已有部分终结但仍有活动分配。
- completed：全部分配均为 submitted 或 cancelled。
- cancelled：管理员整体取消。

overdue 不是父任务终态；存在 overdue 分配时通常为 in_progress。父任务取消会原子取消所有未 submitted 的分配，已提交快照不变。

#### audit_assignments

- id、business_no、campaign_id、inspector_id、questionnaire_version_id。
- task_type：secret、overt。
- starts_at、due_at、budget_limit_cents、receipt_required。
- special_instruction。
- status：draft、assigned、in_progress、submitted、overdue、cancelled。
- created_by、created_at、assigned_by、assigned_at。
- started_at、checked_in_at、submitted_at。
- cancelled_by、cancelled_at、cancel_reason。
- checkin_id、revision、updated_at。

约束：

~~~sql
CREATE UNIQUE INDEX audit_assignments_campaign_inspector_uq
  ON audit_assignments(campaign_id, inspector_id);

CREATE INDEX audit_assignments_campaign_status_idx
  ON audit_assignments(campaign_id, status);

CREATE INDEX audit_assignments_active_due_idx
  ON audit_assignments(campaign_id, due_at, id)
  WHERE status IN ('assigned', 'in_progress');
~~~

- 第一阶段允许保存 overt 草稿，但父任务发布遇到任何 overt 分配必须拒绝。
- 单个父任务分配数受 `MAX_ASSIGNMENTS_PER_CAMPAIGN` 限制，第一阶段默认 500；服务端发布前再次计数。
- 分配开始后 inspector_id、questionnaire_version_id、task_type 不可修改。
- 逾期不能开始或提交；管理员延期到未来后，无问卷恢复 assigned，有草稿恢复 in_progress。
- draft 且没有 attempt/外部引用时可物理删除；其他情况只能取消。

#### assignment_dish_requirements

- id、assignment_id、planned_name、quantity。
- required、allow_substitution、max_unit_price_cents、instruction。
- sort_order、created_at、updated_at。

同一分配内名称可重复，但 ID 唯一；最终菜品通过 requirement_id 精确关联。

菜品要求只可在分配为 draft，或尚无 attempt 的 assigned 状态下按 revision 修改，并记录管理员审计；开始后完全冻结。开始问卷事务会为每条 requirement 创建一条带服务端稳定 record ID 和规则快照的初始 dish_record：actual_name 先取 planned_name、quantity 取计划数量、fulfillment_status=ordered、评价为空、fully_satisfied=false。这样前端重开页面不会为要求行重新生成 ID，且仍必须完成评价/满意状态。

#### audit_checkins

- id、assignment_id、inspector_id。
- latitude_gcj02、longitude_gcj02、accuracy_meters、captured_at、received_at。
- store_latitude_snapshot、store_longitude_snapshot。
- base_radius_snapshot、accuracy_allowance_meters、allowance_max_snapshot、effective_radius_meters。
- computed_distance_meters。
- result：accepted、outside_radius、stale、low_accuracy、rejected；failure_code。
- valid_until、consumed_at、created_at。

通过打卡默认 5 分钟有效。首次创建问卷时原子消费；重复 start 返回已有 attempt，不重复消费。

#### checkin_exemptions

- id、assignment_id。
- status：active、used、revoked、expired。
- reason、granted_by、granted_at、valid_until。
- used_at、used_by_attempt_id、revoked_by、revoked_at、revision。

有效 SQL：

~~~sql
CREATE UNIQUE INDEX checkin_exemptions_one_active_uq
  ON checkin_exemptions(assignment_id)
  WHERE status = 'active';

CREATE INDEX checkin_exemptions_active_expiry_idx
  ON checkin_exemptions(valid_until, id)
  WHERE status = 'active';

ALTER TABLE checkin_exemptions ADD CONSTRAINT checkin_exemption_window_ck
CHECK (
  valid_until > granted_at
  AND valid_until <= granted_at + INTERVAL '30 minutes'
);
~~~

创建、查询、开始任务前，先在同一事务中把该分配已到期的 active 行更新为 expired；每分钟任务只是补充。开始任务通过 SELECT FOR UPDATE 或条件 UPDATE 原子消费豁免。撤销需要 checkin:exempt 权限、原因和 revision。

### 8.6 问卷草稿、答案和问题证据

#### survey_attempts

- id、assignment_id、questionnaire_version_id、mode。
- status：draft、submitting、submitted、failed。
- current_category、revision、started_at、last_saved_at、updated_at、submitted_at。
- submit_token、submitting_since、last_failure_code。

~~~sql
CREATE UNIQUE INDEX survey_attempts_assignment_uq
  ON survey_attempts(assignment_id);
~~~

不保存重复 owner_user_id；所有者由 assignment.inspector_id 推导。分配开始后不允许改 owner。

#### question_answers

- id、attempt_id、question_id、questionnaire_version_id（用于组合外键）。
- result：scored、unscored。
- issue_remark、awarded_score。
- revision、created_at、updated_at。

UNIQUE(attempt_id, question_id)。awarded_score 只由服务端根据冻结版本计算。

第一阶段没有部分分：scored 的 awarded_score=max_score，unscored 的 awarded_score=0。总分和分类分均在提交事务重新求和；score_rate=awarded/max，题库发布时要求总 max_score > 0，禁止客户端提交或覆盖分值。

#### question_answer_edit_sessions

- id、attempt_id、question_id、questionnaire_version_id（用于组合外键）。
- status：open、confirmed、cancelled、expired。
- base_answer_revision、draft_result、draft_issue_remark。
- expires_at、created_at、confirmed_at、cancelled_at。

~~~sql
CREATE UNIQUE INDEX question_edit_sessions_one_open_uq
  ON question_answer_edit_sessions(attempt_id, question_id)
  WHERE status = 'open';

CREATE INDEX question_edit_sessions_open_expiry_idx
  ON question_answer_edit_sessions(expires_at, id)
  WHERE status = 'open';
~~~

创建前原子推进同题过期会话；并发插入由部分唯一索引裁决。默认 30 分钟有效。

#### question_evidence_attachments

- id、attempt_id、question_id、questionnaire_version_id、edit_session_id、client_file_id。
- type：image、audio。
- state：staged_uploading、staged_ready、active、deleted、failed。
- storage_bucket、storage_key、storage_version_id。
- original_file_name_sanitized、mime_type、size_bytes、sha256。
- image_width、image_height；audio_duration_ms。
- verification_locked_by、verification_lease_expires_at；用于 complete 的短时单飞校验，不作为产品 UI 状态。
- created_by、created_at、verified_at、activated_at、deleted_at。

附件必须通过组合外键证明属于同一 attempt + question。active 附件不能被另一个问卷引用。

~~~sql
CREATE UNIQUE INDEX question_evidence_client_file_uq
  ON question_evidence_attachments(edit_session_id, client_file_id);
~~~

#### question_answer_edit_session_removals

- edit_session_id、attachment_id、attempt_id、question_id、created_at。

使用关联表记录待删除意图，不在会话行存 ID 数组。组合外键保证被移除附件是同问卷同题的 active 附件。

确认编辑在一个事务内：

1. 锁 attempt、answer、edit session。
2. 检查 attempt 仍为 draft/failed、revision 和会话未过期。
3. 校验 unscored 的文字、图片、音频必填条件。
4. 激活 staged_ready 新附件，把 removal 中附件标记 deleted。
5. 写答案、关闭会话、增加 attempt revision。

取消编辑只关闭会话，不动原答案和 active 附件；staged_ready/staged_uploading 新对象由清理任务在 24 小时内删除。提交后的所有编辑会话和附件写操作一律拒绝。

### 8.7 小票、OCR、菜品和其他记录

#### receipt_attachments

- id、attempt_id、client_file_id、display_order。
- state：pending_upload、uploaded_unverified、ready、failed、deleted。
- storage_bucket、storage_key、storage_version_id。
- original_file_name_sanitized、mime_type、size_bytes、sha256、width、height。
- verification_locked_by、verification_lease_expires_at；并发 complete 只能有一个校验者。
- failure_code、created_at、verified_at、deleted_at。

一个 attempt 最多 9 个非 deleted 小票。初始化时先锁 attempt 再计数。对 (attempt_id, client_file_id) 建唯一索引，使网络重试返回同一 attachment；对所有非 deleted 记录建立 (attempt_id, sha256) 部分唯一索引，完成校验前 sha256 可空。failed 文件需先软删除才能上传同一内容。

~~~sql
CREATE UNIQUE INDEX receipt_client_file_uq
  ON receipt_attachments(attempt_id, client_file_id);

CREATE UNIQUE INDEX receipt_active_sha_uq
  ON receipt_attachments(attempt_id, sha256)
  WHERE state <> 'deleted' AND sha256 IS NOT NULL;
~~~

#### receipt_ocr_jobs

- id、attempt_id、input_hash。
- provider、model_version、parser_version。
- status：queued、processing、succeeded、partial、failed、cancelled。
- request_idempotency_key、attempt_count、max_attempts。
- locked_by、locked_at、lease_expires_at、heartbeat_at。
- next_attempt_at、cancellation_requested_at、failure_code、failure_detail_redacted。
- created_at、started_at、completed_at。

同一 attempt + input_hash 只能有一个非废弃结果。input_hash 覆盖按 display_order 排序的附件 ID/sha256、provider、模型版本和解析器版本。

~~~sql
CREATE UNIQUE INDEX receipt_ocr_input_uq
  ON receipt_ocr_jobs(attempt_id, input_hash);

CREATE INDEX receipt_ocr_queued_claim_idx
  ON receipt_ocr_jobs(next_attempt_at, created_at, id)
  WHERE status = 'queued';

CREATE INDEX receipt_ocr_processing_lease_idx
  ON receipt_ocr_jobs(lease_expires_at, id)
  WHERE status = 'processing';
~~~

#### receipt_ocr_job_attachments

- job_id、attachment_id、attempt_id、display_order、sha256_snapshot。

OCR job 固定输入快照；之后删除小票不修改历史 OCR 原始结果。

#### receipt_ocr_lines

- id、job_id、attachment_id。
- page_order、line_order、text。
- confidence、bounding_box_json、created_at。

保存规范化原始识别行，供管理员比对和解析回放；不保存供应商无关的巨大调试响应。

#### receipt_ocr_candidates

- id、job_id、attachment_id。
- raw_name、normalized_name、quantity、unit_price_cents、line_total_cents、currency 固定 CNY。
- name_confidence、quantity_confidence、unit_price_confidence、line_total_confidence。
- source_text、source_bounding_box、sort_order。
- status：proposed、applied、rejected。

#### receipt_ocr_summaries

- id、job_id、attachment_id。
- subtotal_cents、discount_cents、service_charge_cents。
- payable_total_cents、calculated_item_total_cents、difference_cents。

折扣、服务费、优惠、抹零、支付方式只进入 summary，不自动创建菜品。

#### receipt_ocr_applications

- id、attempt_id、job_id、idempotency_key、request_hash。
- base_revision、result_revision、applied_at、created_by。

UNIQUE(attempt_id, idempotency_key)。重复 apply 返回同一结果。

#### dish_records

- id、attempt_id、assignment_id、requirement_id nullable。
- planned_name nullable、planned_quantity nullable、actual_name nullable、quantity integer。
- required_snapshot、allow_substitution_snapshot、max_unit_price_cents_snapshot、instruction_snapshot。
- unit_price_cents nullable、line_total_cents nullable。
- fulfillment_status：ordered、substituted、unavailable、skipped、extra。
- substitution_reason、unavailable_reason、evaluation。
- fully_satisfied。
- source：manual、ocr。
- source_candidate_id nullable、manually_modified、price_derived。
- review_fields jsonb、sort_order、created_at、updated_at。

~~~sql
CREATE UNIQUE INDEX dish_records_one_requirement_uq
  ON dish_records(attempt_id, requirement_id)
  WHERE requirement_id IS NOT NULL;
~~~

条件约束：

- required_snapshot=true 只能 ordered、substituted、unavailable，不能 skipped。
- ordered：actual_name 必填，substitution_reason/unavailable_reason 为空。
- substituted：只有 allow_substitution_snapshot=true 才允许，actual_name 和 substitution_reason 必填，unavailable_reason 为空。
- unavailable：actual_name 为空、unavailable_reason 必填，价格/evaluation 为空、fully_satisfied=false。
- skipped：只允许 required_snapshot=false，actual_name、价格和 evaluation 为空、fully_satisfied=false。
- extra：requirement_id 为空、actual_name 必填。
- ordered/substituted/extra 必须满足 fully_satisfied=true 或 trim(evaluation) 非空至少一项；满意可取消，取消后评价为空即未完成。
- ordered/substituted/extra 的 quantity 为 1–999。
- 单价和总价若同时存在，允许因折扣出现差异，但标记 review_fields；不能偷偷改金额。
- OCR 行经用户修改后 manually_modified=true，原 candidate 不变。
- PUT dishes 只接受实际菜名、履行状态、实际数量/金额、原因、评价和满意等可编辑字段；planned/required/allowSubstitution/限价/说明以服务端快照为准，客户端值不一致时拒绝，不能覆盖。

assignment 的总预算和单品 max_unit_price 是现场执行提示及管理员比对依据。第一阶段实际价格超过预算时增加 price_over_limit/budget_over_limit 核对标记，但不阻止记录真实消费或最终提交，避免菜单涨价造成任务无法完成。

#### other_records

- attempt_id、highlight、suggestion、revision、updated_at。

highlight 为 1–2,000 字的必填文本；suggestion 可空，填写时最多 2,000 字。

### 8.8 提交、幂等、导出、审计和保留

#### idempotency_keys

- id、actor_id、scope、idempotency_key、request_hash。
- status：processing、succeeded、terminal_failed、retryable_failed。
- response_status、response_body_json、failure_code。
- locked_by、locked_at、lease_expires_at、attempt_count。
- created_at、updated_at、expires_at。

~~~sql
CREATE UNIQUE INDEX idempotency_actor_scope_key_uq
  ON idempotency_keys(actor_id, scope, idempotency_key);

CREATE INDEX idempotency_processing_lease_idx
  ON idempotency_keys(lease_expires_at, id)
  WHERE status = 'processing';
~~~

同 key 不同 request_hash 返回 409 IDEMPOTENCY_KEY_REUSED。成功和 token 终态失败可重放；瞬时失败可用相同 token 再取租约。

response_body_json 只保存共享契约允许重放的最小响应，不保存附件 URL、token 或答案全文。非 processing 记录默认在最后更新 30 天后清理；即使幂等记录已清理，attempt/submission 唯一约束和 submitted 状态仍阻止产生第二份提交。processing 不能靠过期删除，必须先由恢复器对账。

#### submission_versions

- id、attempt_id、assignment_id、version_number。
- questionnaire_version_id、submitted_by、submitted_at。
- total_score、max_score、score_rate。
- answer_snapshot_json、dish_snapshot_json、other_snapshot_json。
- receipt_snapshot_json、ocr_snapshot_json。
- integrity_hash、integrity_hmac、integrity_key_version。

第一阶段每个 attempt 只有 version 1；表结构允许未来整改产生后续版本，但绝不覆盖 version 1。

快照按固定字段顺序和稳定 JSON canonicalization 生成 SHA-256 integrity_hash，再用独立于数据库的密钥计算 HMAC-SHA-256；验签密钥版本随行保存。普通管理员不能重新计算并覆盖历史 HMAC。

#### export_jobs

- id、requested_by、scope_snapshot_json、filters_json。
- format、status：queued、processing、succeeded、failed、expired。
- storage_bucket、storage_key、row_count。
- locked_at、lease_expires_at、failure_code。
- created_at、completed_at、expires_at。

下载前重新校验当前权限和 scope；URL 最多 5 分钟有效，导出对象 7 天后删除。

#### archive_restore_jobs

- id、submission_id、attachment_type、attachment_id。
- storage_bucket、storage_key、storage_version_id。
- requested_by、status：queued、processing、restoring、ready、failed、expired。
- locked_by、locked_at、lease_expires_at、available_until、failure_code。
- created_at、updated_at、completed_at。

同一个 Bucket/key/version 只允许一个 queued/processing/restoring/ready 活动恢复任务。重复请求返回现有状态；ready 到期后可重新申请。worker 调用 COS 恢复接口，管理员 API 不在 HTTP 请求中等待归档取回。

#### audit_logs

- id、request_id、actor_id、actor_type。
- action、subject_type、subject_id、scope_snapshot_json。
- outcome、reason_code、ip_hmac、user_agent_summary。
- metadata_redacted_json、created_at。

只追加；应用角色没有 UPDATE/DELETE 权限。审计不保存密码、验证码、token、精确定位原值或原始用户文本全文。

#### legal_holds

- id、subject_type、subject_id、reason。
- requested_by、approved_by、starts_at、hold_until、released_by、released_at。

必须有明确对象、原因和到期时间；requested_by 与 approved_by 必须是两个不同且有 retention:manage 权限的管理员。有效 hold 阻止业务数据和对应 COS 对象删除，但不扩大查看权限；释放同样要求原因和审计。

#### retention_runs、system_job_runs

记录策略版本、游标、锁租约、开始/完成时间、各类处理数量和错误摘要，保证任务幂等且可审计。

### 8.9 外键、删除与数据库角色

禁止用普通 CHECK 跨表验证所有权。需要同时证明归属的关系使用重复的父级 ID + 组合外键，重复字段不能由客户端填写：

~~~sql
ALTER TABLE audit_assignments
  ADD CONSTRAINT audit_assignments_id_inspector_uq UNIQUE (id, inspector_id);

ALTER TABLE survey_attempts
  ADD CONSTRAINT attempts_id_assignment_uq UNIQUE (id, assignment_id),
  ADD CONSTRAINT attempts_id_version_uq UNIQUE (id, questionnaire_version_id);

ALTER TABLE questions
  ADD CONSTRAINT questions_id_version_uq UNIQUE (id, version_id);

ALTER TABLE question_answers
  ADD CONSTRAINT answers_attempt_version_fk
    FOREIGN KEY (attempt_id, questionnaire_version_id)
    REFERENCES survey_attempts(id, questionnaire_version_id),
  ADD CONSTRAINT answers_question_version_fk
    FOREIGN KEY (question_id, questionnaire_version_id)
    REFERENCES questions(id, version_id);

ALTER TABLE assignment_dish_requirements
  ADD CONSTRAINT requirements_id_assignment_uq UNIQUE (id, assignment_id);

ALTER TABLE dish_records
  ADD CONSTRAINT dishes_attempt_assignment_fk
    FOREIGN KEY (attempt_id, assignment_id)
    REFERENCES survey_attempts(id, assignment_id),
  ADD CONSTRAINT dishes_requirement_assignment_fk
    FOREIGN KEY (requirement_id, assignment_id)
    REFERENCES assignment_dish_requirements(id, assignment_id);
~~~

同样模式用于：

- audit_checkins 的 (assignment_id, inspector_id) → audit_assignments。
- question_answer_edit_sessions 的 attempt/version 和 question/version。
- question_evidence_attachments 的 (edit_session_id, attempt_id, question_id) → edit session。
- question_answer_edit_session_removals 的附件/题目/问卷组合归属。
- checkin_exemptions 的 (used_by_attempt_id, assignment_id) → survey_attempts。
- receipt_ocr_job_attachments 的 job/attachment/attempt 组合归属；候选只引用该快照关联。

因此任何人即使猜到另一个问卷的 questionId、requirementId 或 attachmentId，也无法插入跨任务引用。

- 核心业务数据默认 ON DELETE RESTRICT。
- 临时上传、过期会话等只由后台清理服务做受控删除。
- user 不因停用而删除；显示层可在保留期后匿名化。
- 数据库至少分 migration_owner、app_api、app_worker、backup_reader 四个角色。
- app_api 无 schema DDL 权限；app_worker 只能访问所需 job/业务表；普通角色无 audit_logs 删除权限。
- 所有 production migration 在备份后以专用角色运行，并保存 migration checksum。

### 8.10 统一锁顺序

所有跨表事务按以下顺序取得锁，避免死锁：

~~~text
idempotency row（如有）
→ campaign
→ assignment
→ survey_attempt
→ edit_session 或 ocr_job
→ answer / attachment / dish 子项（按 UUID 排序）
~~~

需要修改 assignment 并重算父任务的事务，先用不加锁查询取得不可变的 campaign_id，再按上述顺序锁 campaign、assignment；禁止先锁 assignment 后再回头锁 campaign。需要锁多条 assignment 或子项时，统一按 UUID 升序。worker 的“领取 job”短事务只锁 job；其完成事务若还要检查 attempt，必须重新按 `survey_attempt → ocr_job` 顺序取锁，不能沿用相反顺序。

所有数据库事务帮助函数必须统一识别 `40P01`、`40001` 和 lock timeout：只有安全幂等请求可做最多 3 次带抖动重试，其余请求返回带 requestId 的可重试业务错误。监控单独统计死锁、锁等待、重试次数和最终失败。

禁止在持有数据库事务锁时调用短信、验证码、COS、PaddleOCR 或其他外部网络。外部调用使用 outbox/job 或分成“预留—调用—确认”阶段。

## 9. 核心状态机与业务流程

四张统一可视化图见 [STATE_MACHINE_OVERVIEW.md](STATE_MACHINE_OVERVIEW.md)。该文件用于阅读；本节仍是后端事务、守卫和失败恢复的实施依据。其他规格不再各自维护一份重复的大型状态图。

### 9.1 分配状态

| 当前状态 | 允许目标 | 唯一业务动作 |
|---|---|---|
| draft | assigned / cancelled | 发布 / 草稿期受控取消 |
| assigned | in_progress / overdue / cancelled | 有效打卡或豁免后开始 / 到期推进 / 管理员取消 |
| in_progress | submitted / overdue / cancelled | 原子提交 / 到期推进 / 无有效提交租约时管理员取消 |
| overdue | assigned / in_progress / cancelled | 延期后按是否已有草稿恢复 / 管理员取消 |
| submitted | 无 | 永久只读 |
| cancelled | 无 | 保留审计，不恢复 |

没有 overdue → submitted。逾期后只有管理员延期到未来，任务恢复合法活动状态，用户刷新 revision 并生成新的 submit token，才可再次提交。

管理员取消、整体取消或延期若发现 attempt=submitting 且提交租约仍有效，返回 409 TASK_SUBMISSION_IN_PROGRESS，不与最终化事务抢状态；租约过期时先执行同一恢复函数，再继续管理操作。

逾期不只在用户操作时判断：

- 每分钟 worker 先用 `FOR UPDATE SKIP LOCKED` 领取存在到期分配的 campaign 行，再按 UUID 顺序锁定该 campaign 下的到期 assigned/in_progress 分配并批量推进；不能先领取 assignment 再反向锁 campaign。
- 任务列表、详情、开始、提交、延期、取消事务在操作前对作用域执行相同条件更新。
- worker 延迟只影响展示刷新速度，不影响操作正确性。

### 9.2 发布父任务

发布事务：

1. 锁 campaign。
2. 校验状态为 draft、revision 一致、整体时间合法、门店启用且位置已验证。
3. 锁全部 assignments，至少一条。
4. 校验探店员 approved_active、手机号已验证、范围允许、时间在父任务范围内。
5. 校验题库为 published，task_type=secret，菜品要求合法。
6. 把所有 draft 分配置为 assigned，campaign 置为 published。
7. 写发布快照与审计日志。
8. 提交后任务自然出现在探店员日程；第一阶段不发送消息通知。

### 9.3 “问卷”入口的 0/1/多任务规则

后端不存在全局 current assignment，也不提供 task-current 或 survey-current：

- GET /api/assignments/mine?executable=true 返回当前用户所有可执行分配。
- 0 条：客户端显示空状态并引导日程。
- 1 条：客户端可进入该 assignment 的详情/继续草稿。
- 多条：客户端必须显示选择器；后续每个请求显式携带 assignmentId 或由 attemptId 唯一关联。
- submitted/cancelled 不属于可执行项；overdue 可在列表单独展示但不可进入编辑。

任何草稿缓存键必须至少包含 userId、assignmentId、attemptId、questionnaireVersionId 和 revision。

### 9.4 打卡和开始任务

POST check-in：

1. 验证用户 approved_active 且是 assignment.inspector_id。
2. 先调用统一逾期推进短事务；该事务按 campaign → assignment 取锁。随后在打卡事务中只锁 assignment，只接受 assigned；若锁定后发现时间刚跨过 due_at，则回滚并重新走逾期推进，不在持有 assignment 锁时反向请求 campaign 锁。
3. 校验 starts_at 已到、due_at 未过。
4. 校验 capturedAt 不超过 60 秒、GCJ-02 坐标和 accuracy 合法。
5. 从 store 读取坐标与半径快照，服务端计算 Haversine 距离。
6. 无论通过/失败都记录 audit_checkins；仅通过记录产生 valid_until。
7. 返回业务化结果、可重试建议和不敏感的距离摘要。

POST start：

1. 先做不加锁查询取得不可变 campaign_id，再在一个事务中依次锁 campaign、assignment；若已有 attempt，再锁 attempt、验证所有权并幂等返回同一个 ID。
2. 按同一有序锁事务推进逾期，并校验账号、时间、assignment 状态。
3. 锁最新未过期通过打卡；若无，则原子过期并尝试锁 active 豁免。
4. 消费打卡或豁免。
5. 创建 survey_attempt，冻结 questionnaire_version_id 和 mode。
6. 从 assignment_dish_requirements 创建带稳定 ID 的初始 dish_records；重复 start 不能重复创建。
7. assignment → in_progress，写 started_at，重算 campaign。
8. 提交事务并返回 attempt。

客户端计算的 distance 或“范围内=true”只用于即时提示，服务端不能信任。

### 9.5 不得分编辑与证据

打开不得分题不会立刻破坏已有答案：

1. 创建 edit session，复制当前答案 revision 和编辑值。
2. 上传新证据完成校验后进入 staged_ready，删除旧证据只写 removal。
3. 每次修改会话都校验会话 owner、attempt 仍可写和 expires_at。
4. confirm 才原子替换答案与附件集合。
5. cancel/过期恢复原附件，新上传对象进入清理。

unanswered/scored → scored 可以直接 PUT；任何当前为 unscored、存在说明或 active 证据的题目改为 scored，必须打开 edit session 并在 confirm 中原子清除说明/附件。直接 PUT 这类转换返回 409 EDIT_SESSION_REQUIRED。

unscored 确认条件：

~~~text
trim(issueRemark).length > 0
AND (imageRequired = false OR activeImageCount >= 1)
AND (audioRequired = false OR activeAudioCount >= 1)
~~~

点击下一题和最终提交都执行相同服务端规则。客户端校验只改善体验，不能成为唯一校验。

### 9.6 小票上传和 OCR

小票流程：

~~~mermaid
sequenceDiagram
  participant U as 探店员小程序
  participant A as Fastify API
  participant C as 私有 COS
  participant W as Node Worker
  participant O as PaddleOCR
  participant D as PostgreSQL

  U->>A: 初始化上传（attempt、文件元数据、revision）
  A->>D: 预留附件名额与随机对象键
  A-->>U: 5 分钟限定 POST 目标和 formData
  U->>C: 原图直传
  U->>A: complete（大小、sha256、revision）
  A->>C: HEAD + 流式读取校验
  A->>D: 附件 ready
  U->>A: 创建 OCR job（附件 IDs、幂等键）
  A->>D: 固定 input_hash 并排队
  W->>D: 取得 job 租约
  W->>C: 下载原始小票
  W->>O: 私有推理请求
  O-->>W: 文本、置信度、边界框
  W->>D: 保存不可变行、候选、汇总
  U->>A: 查询 job
  U->>A: apply（幂等键、revision）
  A->>D: 合并到可编辑菜品
~~~

最多 9 张是“一个问卷中非 deleted 小票”的总上限，不是单次选择后可再次无限追加。上传和 OCR 都不改变问卷答案。

OCR 失败或部分成功时：

- 原始小票继续保留并可预览。
- 允许对同一 input_hash 显式重试，达到最大次数后新版本模型/解析器才产生新 input_hash。
- 探店员始终可完全手工输入。
- receipt_required 只要求至少一张 ready 原图，不要求 OCR 成功。

### 9.7 最终提交与幂等

submitToken 由客户端对一次明确提交动作生成 UUID/高熵随机值。规范化请求摘要至少覆盖 actor、attempt、assignment revision、attempt revision、提交契约版本和请求体。

幂等结果：

| 状态 | 含义 | 原 token |
|---|---|---|
| succeeded | 已有唯一成功快照 | 重放成功 |
| terminal_failed | 本 token 的确定业务拒绝 | 重放失败；修正后生成新 token |
| retryable_failed | 未产生不可逆业务结果的瞬时失败 | 可用原 token 重取租约 |
| processing | 正在执行，有 30 秒租约 | 租约内返回处理中，过期可 CAS 接管 |

TASK_OVERDUE 属于 terminal_failed，并返回 requiresNewToken=true。管理员延期不删除旧记录；客户端刷新后使用新 token。

租约内重复请求返回 HTTP 202、稳定 processing 状态和 Retry-After；succeeded 重放最初成功状态码/响应，terminal_failed 重放最初业务失败。客户端不能因 202 自动生成新 token。

为了让 processing/submitting 能在进程崩溃后被观察和恢复，提交不是一个永远无法留下中间状态的超长事务，而是三个短事务；只有第三阶段包含不可逆业务结果：

**A. 幂等租约事务**

1. 计算 request_hash，锁定或创建 idempotency row。
2. 按状态重放 succeeded/terminal_failed，处理 retryable_failed，或对过期 processing 做 CAS 接管。
3. 把记录持久化为 processing，写 30 秒 lease、leaseOwner 和 attemptCount，然后提交。不同 request_hash 立即冲突。

**B. 问卷占用事务**

4. 再次锁 idempotency，确认本执行者仍持有租约；用预读得到的不可变 campaign_id，按统一锁顺序锁 campaign、assignment、attempt。
5. 验证唯一所有者、revision、attempt 状态，推进逾期并要求 assignment=in_progress。
6. 若发生 TASK_OVERDUE 等确定业务拒绝，在本事务把 idempotency 置 terminal_failed、attempt 恢复/保持 draft 并清空提交占用，然后提交失败结果。
7. 合法时把 attempt 置 submitting，写 submit_token/submitting_since，提交事务。从这一刻起所有普通草稿写接口拒绝。

**C. 原子最终化事务**

8. 锁 idempotency、campaign、assignment、attempt，校验 leaseOwner、token、request_hash 和 submitting 状态；再做一次账号、所有权、revision、截止时间检查。
9. 原子过期编辑会话，并要求没有 open 会话。
10. 校验冻结题库的全部启用题均已作答。
11. 校验每个 unscored 的说明和 active 必需证据。
12. 服务端重新计算题目、分类和总分。
13. 校验菜品要求、数量、金额、评价、闪光点和 receipt_required。
14. 创建不可变 submission_versions 快照和 integrity_hash。
15. 将 queued OCR job 置 cancelled，对 processing job 写 cancellation_requested_at；迟到 worker 只能结束任务，不能新增候选或改菜品。
16. attempt/assignment → submitted，写 submitted_at，重算 audit_campaign。
17. 写审计，把 idempotency → succeeded 并保存安全响应。
18. 提交事务。

若 C 阶段发现可由用户修正的确定校验失败，先回滚 C，再以短失败事务把 attempt 恢复 draft、清空提交占用，并把 idempotency 置 terminal_failed；用户修正后使用新 token。数据库连接中断等无法证明业务结果的故障不伪装成确定失败，由恢复器对账后置 retryable_failed。

三个阶段都不调用 COS、短信或 OCR。所有不可逆业务副作用——提交快照、submitted 状态、父任务聚合、审计成功和幂等成功响应——只在 C 的同一个数据库事务提交。快照引用已经验证且 ready/active 的附件及其 versionId/sha256。

提交后以下全部拒绝：

- 答案 PUT。
- edit session 创建、更新、confirm、cancel。
- 证据上传初始化、complete、DELETE。
- 小票上传初始化、complete、DELETE。
- OCR 创建、apply。
- 菜品和其他记录 PUT。
- 再次使用不同 token 提交。

提交后探店员只可看任务名称、门店、submitted 状态和提交时间；第一阶段不能回看答案和证据。管理员通过独立只读 API 查看完整题目、证据、小票和 OCR 对比。

### 9.8 崩溃恢复

每分钟 recovery worker：

- 扫描 lease_expires_at 已过期的 processing idempotency row。
- 若 submission snapshot 已存在，对账 attempt/assignment/idempotency 为 submitted/succeeded。
- 若无快照且 attempt 为 draft/failed，幂等记录 → retryable_failed。
- 若无快照且 attempt=submitting 且 submitting_since 超过租约 + 30 秒宽限，attempt → failed，幂等记录 → retryable_failed。
- 若 attempt=submitted 但无快照，或快照 hash 不一致，标记 invariant_violation，停止自动修复并告警人工对账。

因为所有不可逆提交副作用都在最终化事务中，且提交阶段没有外部调用，安全失败分支没有“短信发了但数据库回滚”等外部不一致。

## 10. 共享契约在后端开工前必须修订

以下不是可选优化，而是当前 packages/contracts 与可实施后端之间的缺口：

1. RegisterRequestSchema：删除无签发路径的 phoneVerificationToken，改为 phoneChallengeId + smsCode；注册接口在事务中验证并消费。
2. AdminSessionSchema：增加 csrfToken；管理员所有写请求携带 X-CSRF-Token。
3. ReceiptUploadInitSchema 和问题证据上传响应：uploadTarget 增加 method、fileFieldName、formData、expiresAt。当前仅有 url/headers，wx.uploadFile 无法完成 COS POST Policy。
4. 小程序 uploadToSignedTarget：必须把后端返回的 formData 原样传给 wx.uploadFile，并把 name 设为 fileFieldName；客户端不得生成 key 或签名字段。重复的 uploadObject 旧适配器应删除或统一委托该实现，避免遗漏 formData。
5. DishRecordSchema.quantity 和 ComparisonDishSchema.quantity：第一阶段改为 int 1–999。
6. ReceiptAttachmentSchema 及 AdminReceiptComparisonSchema 的小票项增加 previewStatus=ready/restoring/unavailable；归档对象恢复期间 thumbnailUrl/previewUrl 可空，并可返回 restoreEstimatedAt。
7. AssignmentWriteSchema 的 budgetLimit 改为整数 budgetLimitCents；DishRequirementWriteSchema 补充可空 maxUnitPriceCents 和 instruction，所有金额统一整数分。
8. ReceiptOcrJobSchema 补充 failureKind、canRetry、nextRetryAt、createdAt、updatedAt；上传/OCR schema 增加 requestId/必要恢复状态，但不得暴露 storage_key。
9. ApiErrorSchema 增加 requestId；revision 冲突响应增加最新安全摘要，不能返回内部行。
10. contracts.generated.js 必须由 packages/contracts 自动生成并由 CI 比较；目前只存在于 generated 文件中的 answer/edit/start/submit 等 validator 要移入 packages/contracts 唯一源，禁止长期手工维护两份投影。
11. 所有列表 schema 补充 cursor pagination；assignments/mine 明确定义 executable/status 查询 schema。
12. 问卷草稿响应中的每条 assignment dish requirement 必须返回服务端创建的 recordId/对应 dish_record；前端不得在每次加载时为要求行重新生成随机 ID。
13. API 常量和共享契约增加 POST /api/admin/submissions/:id/attachments/:attachmentId/restore，以及 archive restore job 状态 schema；GET 详情不能用副作用偷偷触发恢复。
14. RECEIPT_OCR_STATUS 增加 cancelled；ReceiptOcrJobSchema 能返回取消后的业务文案。提交时不等待 OCR，queued/processing job 必须按第 9.7 节取消或丢弃迟到结果。
15. ReceiptFileMetaSchema.clientFileId 以及问题证据对应字段改为必填安全 UUID；上传初始化以它做服务端幂等，不能用文件名、数组下标或本地路径去重。
16. 管理员状态动作的 API client 统一生成并发送 Idempotency-Key；Fastify header schema 校验安全 UUID，contract server 和并发测试必须覆盖响应丢失后的重放。

这些变更需要同时更新 miniapp service、管理员 fetch adapter、contract server 与契约测试；不能只改后端解析器。

## 11. 唯一 API 清单

请求和响应具体字段由 packages/contracts 定义；下列路径、方法和行为与 IMPLEMENTATION_PLAN.md 第 7 节一致。新增接口必须先修订该节和共享契约。

### 11.1 认证和当前用户

| 方法与路径 | 认证 | 关键行为 |
|---|---|---|
| POST /api/auth/register/phone-code | 无 | 二次核验 CAPTCHA，发送注册短信，统一限流 |
| POST /api/auth/register | 无 | 消费短信 challenge，创建 pending_approval |
| POST /api/auth/registration/resubmit | 申请状态会话 | rejected → pending_approval |
| POST /api/auth/login | 无 | 校验密码和账号状态，合法 active 才签业务 token |
| POST /api/auth/logout | 登录 | 撤销当前会话，幂等 |
| POST /api/auth/password-resets/code | 无 | 统一响应，CAPTCHA 后发送找回短信 |
| POST /api/auth/password-resets/verify | 无 | 最多 3 次，签发一次性 reset token |
| POST /api/auth/password-resets/complete | reset token | 更新密码并撤销全部旧会话 |
| POST /api/admin/auth/login | 无 | 管理员 Cookie 会话 + CSRF |
| POST /api/admin/auth/logout | 管理员 | 撤销 Cookie 会话 |
| GET /api/me | 登录 | 返回最小身份、角色/范围摘要，不返回内部权限实现 |

登录需要防账号枚举：不存在用户名和错误密码使用统一文案。只有密码正确后才能向本人显示 pending/rejected/disabled 状态。

### 11.2 管理门店、账号和任务

| 方法与路径 | 权限 | 关键行为 |
|---|---|---|
| GET /api/admin/stores | stores:read | scope + cursor 列表 |
| POST /api/admin/stores | stores:write | 创建 GCJ-02 门店 |
| PATCH /api/admin/stores/:id | stores:write | revision 更新 |
| GET /api/admin/users | users:review | 可分配用户与脱敏信息 |
| POST /api/admin/users/:id/disable | users:disable | 撤销会话并冻结 |
| POST /api/admin/users/:id/enable | users:disable | 启用但不恢复会话 |
| GET /api/admin/inspector-registrations | users:review | 状态筛选 |
| POST /api/admin/inspector-registrations/:id/approve | users:review | pending → active |
| POST /api/admin/inspector-registrations/:id/reject | users:review | 必填原因 |
| POST /api/admin/inspector-registrations/:id/reopen | users:review | rejected → pending |
| GET /api/admin/campaigns | campaigns:read | 聚合状态列表 |
| GET /api/admin/campaigns/:id | campaigns:read | 父任务、分配和菜品要求 |
| POST /api/admin/campaigns | campaigns:write | 创建 draft |
| PATCH /api/admin/campaigns/:id | campaigns:write | 仅合法状态 + revision |
| POST /api/admin/campaigns/:id/assignments | assignments:write | 创建逐人分配 |
| PATCH /api/admin/assignments/:id | assignments:write | 仅未开始字段 |
| DELETE /api/admin/assignments/:id | assignments:write | 仅无引用 draft |
| PUT /api/admin/assignments/:id/dish-requirements | assignments:write | 原子替换要求集合 |
| POST /api/admin/campaigns/:id/publish | campaigns:publish | 完整发布守卫 |
| POST /api/admin/campaigns/:id/cancel | campaigns:write | 原因 + revision，保留已提交 |
| POST /api/admin/assignments/:id/cancel | assignments:write | 合法状态取消 |
| POST /api/admin/assignments/:id/extend | assignments:write | 未来截止时间 + 原因 |
| GET /api/admin/assignments/:id/check-in-exemptions | checkin:exempt | 先推进过期 |
| POST /api/admin/assignments/:id/check-in-exemptions | checkin:exempt | 最长 30 分钟、每分配一个 active |
| POST /api/admin/assignments/:id/check-in-exemptions/:exemptionId/revoke | checkin:exempt | revision 撤销 |

所有管理员写接口要求 CSRF、revision、scope 和审计。拒绝原因、延期原因、取消原因、豁免原因均必填。

### 11.3 探店员任务

| 方法与路径 | 关键行为 |
|---|---|
| GET /api/assignments/mine | 只返回本人；支持 executable/status/cursor |
| GET /api/assignments/:id | 本人任务详情；先推进该任务逾期 |
| POST /api/assignments/:id/check-in | 保存原始样本并由服务端判距 |
| POST /api/assignments/:id/start | 消费有效打卡/豁免，幂等返回唯一 attempt |
| GET /api/assignments/:id/questionnaire | 返回冻结版本元数据与 attempt 路由信息 |

不存在 GET /api/task-current、GET /api/survey-current 或任何全局“当前问卷”接口。

### 11.4 题库和问卷草稿

| 方法与路径 | 关键行为 |
|---|---|
| GET /api/admin/questionnaire-versions | 模板/状态筛选和 cursor |
| GET /api/admin/questionnaire-versions/:id | 版本详情 |
| POST /api/admin/questionnaire-versions/:id/copy | 从 published 复制为新 draft |
| GET /api/admin/questionnaire-versions/:id/questions | 返回题目（含 enabled/maxScore）和证据要求 |
| PATCH /api/admin/questionnaire-versions/:id/questions/:questionId | 仅 draft；文字/分值/启停/证据，证据父子约束 |
| POST /api/admin/questionnaire-versions/:id/questions | 仅 draft；新增题目并按启用优先重排题号 |
| DELETE /api/admin/questionnaire-versions/:id/questions/:questionId | 仅 draft；已作答或已被证据引用时拒绝 |
| POST /api/admin/questionnaire-versions/:id/questions/:questionId/move | 仅 draft；同分类同启停状态内上移/下移 |
| POST /api/admin/questionnaire-versions/:id/publish | 校验启用题号 1..N 连续后冻结 |
| GET /api/questionnaires/secret/drafts/:id | owner-only；提交后不返回内容 |
| PUT /api/questionnaires/secret/drafts/:id/answers/:questionId | 保存简单 scored 答案；unscored→scored 必须 edit session |
| POST /api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions | 打开 unscored 临时编辑 |
| PATCH /api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId | 保存会话草稿 |
| POST /api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/evidence-uploads | 预留并返回限定 COS 上传目标 |
| POST /api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/evidence-uploads/:attachmentId/complete | 服务端验证并置为 staged_ready |
| DELETE /api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/evidence/:attachmentId | 记录移除意图或删除本会话 staged_ready |
| POST /api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/confirm | 原子确认答案和附件 |
| POST /api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/cancel | 保留原答案，排队清理暂存附件 |

不得重新引入集合式 PATCH /answers。

### 11.5 小票、OCR、菜品和其他记录

| 方法与路径 | 关键行为 |
|---|---|
| GET /api/questionnaires/secret/drafts/:id/receipt-attachments | 最多 9 张、短时预览状态 |
| POST /api/questionnaires/secret/drafts/:id/receipt-attachments/uploads | 锁名额并返回限定 POST Policy |
| POST /api/questionnaires/secret/drafts/:id/receipt-attachments/:attachmentId/complete | HEAD + 内容验证后 ready |
| DELETE /api/questionnaires/secret/drafts/:id/receipt-attachments/:attachmentId | 明确 dishHandling 后软删除 |
| POST /api/questionnaires/secret/drafts/:id/receipt-ocr-jobs | input_hash + idempotency 排队 |
| GET /api/questionnaires/secret/drafts/:id/receipt-ocr-jobs/:jobId | 查询可恢复状态和用户文案 |
| POST /api/questionnaires/secret/drafts/:id/receipt-ocr-jobs/:jobId/apply | 幂等合并候选，revision 防覆盖 |
| PUT /api/questionnaires/secret/drafts/:id/dishes | 原子保存并完整条件校验 |
| PUT /api/questionnaires/secret/drafts/:id/other-records | 保存闪光点和建议 |

OCR job 查询建议使用 1、2、3、5、8 秒退避，最长前台轮询 60 秒；之后显示“后台识别中”，页面重开继续查询。禁止每次页面加载自动创建新 job。

### 11.6 提交、管理员只读和导出

| 方法与路径 | 权限/行为 |
|---|---|
| POST /api/questionnaires/secret/:id/submit | owner；submitToken；原子、不可逆 |
| GET /api/admin/submissions | submissions:read + scope |
| GET /api/admin/submissions/:id | 完整题目、证据、小票/OCR/最终菜品只读 |
| POST /api/admin/submissions/:id/attachments/:attachmentId/restore | evidence:read + scope；幂等创建/查询归档恢复 |
| POST /api/admin/exports | exports:create；创建异步 job（kind=submissions 提交记录 CSV / dashboard 看板统计 xlsx，多工作表） |
| GET /api/admin/stats/dashboard | stats:read；按提交时间范围与品牌/城市/区域/门店聚合：月度得分趋势、门店月度得分、门店大项得分率、考核点得分率（数据源 submission_question_scores） |
| GET /api/admin/exports/:id | 创建人/授权范围；短时下载 |
| GET /api/admin/audit-logs | audits:read；敏感操作审计 |

提交详情中的附件 URL 最多 5 分钟有效。每次签发记录 actor、subject、用途和结果，但不把签名 URL 写入日志。

## 12. COS 私有文件设计

### 12.1 Bucket

每个环境至少分三个私有 Bucket：

| Bucket | 内容 | 访问者 |
|---|---|---|
| evidence | 题目图片/音频、原始小票 | API、worker；客户端仅短时单对象权限 |
| exports | 管理员导出文件 | export worker；管理员短时下载 |
| backups | 加密数据库备份和恢复清单 | backup 角色；应用 API 无权限 |

Bucket 名称不可含用户信息。启用服务端加密、版本控制、访问日志和同地域内网访问。默认 ACL 为 private，禁止任何 allUsers/public-read。

建议对象键：

~~~text
prod/attempts/{attemptId}/question-evidence/{attachmentId}/{random}.{ext}
prod/attempts/{attemptId}/receipts/{attachmentId}/{random}.{ext}
prod/exports/{exportJobId}/{random}.csv
prod/backups/postgres/{yyyy}/{mm}/{backupId}.dump.enc
~~~

对象键不包含用户名、手机号、门店名、题目文本或原始文件名。

### 12.2 直传许可

第一阶段由 API 通过受限 CAM 角色取得短期 STS 会话并签发 COS POST Object Policy，而不是把长期 SecretId/SecretKey 发给小程序，也不是让 3 Mbps API 中转图片。响应中的 q-ak/security-token 只能是短期会话材料，权限仍被 Policy 收紧到一个随机对象键。

服务端限制：

| 用途 | 格式 | 单文件 | 单问卷/题目上限 |
|---|---|---|---|
| 问题图片证据 | JPEG、PNG | 10 MiB；最长边不超过 8,192；最多 20 MP | 每题最多 9 张 active + staged_ready |
| 问题音频证据 | AAC、MP3、M4A 中经服务端实际解码支持的格式 | 10 MiB；1–60 秒 | 每题最多 3 段 active + staged_ready |
| 消费小票 | JPEG、PNG | 10 MiB；最长边不超过 8,192；最多 20 MP | 每问卷最多 9 张非 deleted |

上限在初始化事务和 complete 时都校验；多个并发初始化先锁 attempt/edit session，不能突破名额。前端 accept/MIME 只用于提示。

初始化响应：

~~~json
{
  "attachment": {
    "id": "019...",
    "status": "uploading"
  },
  "uploadTarget": {
    "method": "POST",
    "url": "https://private-bucket.cos.ap-shanghai.myqcloud.com",
    "fileFieldName": "file",
    "headers": {},
    "formData": {
      "key": "由服务端生成的精确对象键",
      "policy": "opaque",
      "q-sign-algorithm": "opaque",
      "q-ak": "opaque",
      "q-key-time": "opaque",
      "q-signature": "opaque",
      "x-cos-security-token": "opaque"
    },
    "expiresAt": "2026-01-01T00:05:00Z"
  },
  "revision": 4
}
~~~

formData 是供应商不透明字段，客户端只原样传给 wx.uploadFile。策略必须限制：

- 只允许一个服务端生成的随机精确 key。
- 5 分钟内有效。
- 限制 Content-Length；小票单张最大 10 MiB。
- 限制允许的 Content-Type，但 complete 仍做内容嗅探。
- 写入不可猜测 attachmentId/uploadNonce 元数据。
- 不授予列目录、读取、覆盖其他 key 或删除权限。

clientFileId 对每个本地选择文件必填且在当前 attempt/edit session 内唯一。重复初始化返回同一 attachment；Policy 仍有效时重放原目标，过期后只为同一随机 key 续签。网络不确定导致重复上传时，complete 固定最新验证通过的 versionId；其他未被数据库引用的旧 version 由 24 小时对账任务指定 versionId 删除。

上传域名加入微信小程序合法域名和 COS CORS 白名单，只允许生产小程序/管理员正式来源。CORS 不是鉴权，真正权限来自 POST Policy。

### 12.3 complete 校验

客户端直传成功不等于业务 ready。complete 必须拆成三个阶段，禁止在持有数据库锁时等待 COS 或执行图片/音频解析：

**A. 校验租约短事务**

1. 重新认证，按 attempt → attachment 取锁，校验 owner/scope、attempt 可写、上传 nonce、对象 key 和 Bucket 与预留完全相同。
2. attachment 已 ready/staged_ready 且对象版本、nonce 与请求一致时幂等返回原结果；已有未过期 verification lease 时返回 202 和 Retry-After。
3. 通过条件更新写 60 秒 verification_locked_by/verification_lease_expires_at 后提交；此阶段不访问 COS。

**B. 事务外内容验证**

4. 对 COS 执行 HEAD，检查大小和对象版本。
5. 以流式方式读取对象，计算 SHA-256；不能把 ETag 当作 SHA-256。
6. 用 magic bytes 嗅探格式。
7. 图片解码并检查尺寸、像素总量、截断、解压炸弹；移除不需要的 EXIF/GPS 派生副本，但原始证据按政策保留。
8. 音频使用受限解析器检查真实 codec、时长 1–60 秒和大小。
9. 可选异步恶意文件扫描；第一阶段至少拒绝无法解码和格式伪装。CPU/内存校验遵守第 3.4 节有界信号量。

**C. 最终确认短事务**

10. 再按 attempt → attachment 取锁，确认 lease owner、nonce、versionId 和请求仍一致，并重新校验 attempt 仍可写、revision 和附件数量上限。
11. 记录 COS versionId、sha256、真实 MIME 和元数据；问题证据转 staged_ready，小票转 ready，只增加一次 attempt revision，然后清除校验租约。
12. 若 B 阶段期间问卷进入 submitting/submitted，C 阶段拒绝业务写入并把该对象加入孤儿清理；迟到 complete 不能改变提交快照。

验证失败时，以持有同一校验租约为条件把附件置 failed 并排队删除对象。进程崩溃后租约到期可以由同一请求安全接管；旧校验者的迟到写入因 lease owner/version 条件不匹配而被拒绝。旧上传许可不能重新绑定其他文件；重试创建新的 attachment/upload nonce。

### 12.4 防覆盖和证据完整性

- 对象 key 使用至少 128-bit 随机后缀，且每次上传新建，不复用。
- Bucket 开启版本控制；数据库固定保存完成时的 versionId。
- API/worker 运行角色不授予覆盖已完成证据的业务接口。
- submission snapshot 保存 attachmentId、versionId、sha256、size、MIME 和采集/验证时间。
- 每夜抽样或分批 HEAD 对账；对象缺失、版本不一致或 sha256 异常立即告警。
- COS 版本控制是误覆盖保护，不替代数据库审计和备份。

第一阶段不启用全 Bucket WORM/Object Lock。当前业务需要按明确保留期删除敏感证据，错误配置 WORM 会导致无法依法删除。若未来监管要求不可篡改，必须建立独立合规 Bucket、法律批准流程和新的保留策略，不能直接切换现有 Bucket。

### 12.5 查看、缩略图和归档恢复

- 原图永远不公开。
- 管理员详情先通过 API 校验角色和 scope，再得到最多 5 分钟的签名 GET URL。
- 列表优先返回服务端生成的无 EXIF 缩略图，原图仅在用户明确预览时签发。
- 音频使用短时 URL，Content-Disposition inline，限定 MIME。
- 下载响应设置 no-store；管理员 Web 设置严格 Referrer-Policy，防签名 URL 泄漏。
- 探店员提交后不签发证据 URL。

归档对象不能假装可立即预览。响应增加：

~~~text
previewStatus: ready | restoring | unavailable
previewUrl: URL | null
restoreEstimatedAt: ISO timestamp | null
~~~

管理员请求归档证据时创建恢复 job；重复请求幂等。恢复完成后签短时 URL，不把恢复副本转为永久公开对象。

### 12.6 生命周期与业务保留

COS 存储类别迁移：

- 0–180 天：标准存储。
- 181–730 天：低频存储。
- 第 731 天起：归档存储。
- 不使用 COS 生命周期直接按年龄删除正式证据；删除由了解 legal hold 和业务状态的 retention worker 执行。

临时对象可使用独立前缀生命周期：

- 未完成上传、取消/过期 edit session 的暂存对象：24 小时后删除。
- failed/unverified 隔离对象：48 小时后删除。
- 导出：7 天。
- 数据库备份：35 天滚动；月度恢复演练结果另留审计。

正式数据保留：

| 数据 | 期限起点与期限 | 到期动作 |
|---|---|---|
| 被拒绝且未重提注册资料 | 拒绝后 90 天 | 删除手机号和密码哈希；不可逆指纹及审批审计最多保留 1 年 |
| 已批准/停用账号的手机号和密码哈希 | 账号存续期间；书面确认永久关闭后 180 天 | 删除手机号和密码哈希，历史 userId 去标识化 |
| 短信/CAPTCHA challenge | 创建后 30 天 | 使用、失效或过期时立即清空验证码 HMAC；30 天后删除 challenge 行 |
| 过期/撤销会话 | 结束后 30 天 | 删除 token HMAC 和会话行 |
| 精确打卡坐标 | assignment 终结后 180 天 | 删除经纬度，仅保留通过/失败、距离区间和策略快照 |
| 问卷、问题证据、小票、OCR、最终菜品、提交快照 | submitted/cancelled 后 3 年 | 无 legal hold 时删除对象并匿名化业务明细 |
| 审计日志 | 创建后 3 年 | 删除或转不可识别统计 |
| 导出对象 | 完成后 7 天 | 删除 COS 对象并置 expired |
| 数据库备份 | 创建后 35 天 | 自动删除；保留演练记录 |

活跃账号和仍在进行的任务不按上表提前删除。legal hold 暂停对应数据库和 COS 删除，hold 到期后下次 retention run 继续。

这些期限是本项目第一阶段产品基线，上线前须由业务负责人和适用的隐私/合规顾问书面确认。确认后的 policy_version 固化到配置和 retention_runs；不得由工程师临时改变。

删除流程是可恢复的状态机：

1. retention worker 锁定对象，复核状态、期限和 legal hold。
2. 写 deletion_pending tombstone/outbox。
3. 删除 COS 指定 version；确认不存在。
4. 删除或匿名化数据库敏感字段，保留不含敏感内容的 deletion audit。
5. 若 COS 失败，保留数据库引用并重试，不能先丢失对象定位。

## 13. PaddleOCR 识别与菜品解析

### 13.1 方案边界

这里的 OCR 是专门识别图像文字的小型开源模型服务，不是大语言模型：

- 文字检测：PP-OCRv6_small_det。
- 方向/旋转处理：PaddleOCR 文档方向和文字行方向能力。
- 中文识别：PP-OCRv6_small_rec。
- CPU 推理起步；模型和 Paddle/PaddleOCR 版本固定在镜像 digest 和 model_version。

自托管避免腾讯 OCR 的按次 API 费用，但仍有 OCR 机器、存储、带宽、监控和维护成本；上线镜像必须生成 SBOM 并保留所用代码/模型许可证文本。

PP-OCRv6 medium、tiny 和 PP-OCRv5 mobile 只作为脱敏餐饮小票基准的对照候选；上线默认固定 v6 small。若基准证明另一模型在准确率/延迟/内存上更合适，必须在首次上线前书面改定；上线后的任何升级都产生新 model_version，不能让同一历史 job 的结果静默改变。

### 13.2 OCR Provider 接口

Node worker 只依赖：

~~~text
recognizeReceipt({
  imageBytes,
  mimeType,
  attachmentId,
  requestId
}) -> {
  modelVersion,
  lines: [{
    text,
    confidence,
    boundingBox
  }],
  timings
}
~~~

实现：

- PaddleOcrProvider：第一阶段默认。
- TencentPaidOcrProvider：未来可选，默认 disabled。

禁止失败时自动从免费 Provider 切到付费 Provider。启用付费 Provider 必须显式管理员配置、预算上限、调用审计和告警。

### 13.3 Sidecar 安全

- 第一阶段以 PaddleX Basic Serving 启动固定 OCR pipeline，再用极薄的本地适配层裁剪为第 13.2 节接口；吞吐实测不足后才评估高稳定/Triton 方案。
- 只监听 127.0.0.1、Unix socket 或 VPC 私有地址。
- 使用服务间认证；请求体限制 10 MiB，超时和并发限制。
- 运行用户无 root、只读文件系统、无数据库/COS/短信密钥。
- 生产运行时默认不允许访问公网；模型构建阶段固定下载并校验 sha256。
- 图片在内存/短时临时目录处理，任务完成立即删除；临时目录单独配额。
- 返回错误码，不返回 Python 堆栈给客户端。
- 禁用“把二进制结果上传后返回 URL”的能力；当前官方 Serving 的 URL 存储后端并非 COS，本项目直接在私有网络传图片字节，避免给 OCR sidecar 任何对象存储 AK/SK。

### 13.4 图像预处理

对每张小票：

1. 解码并应用 EXIF 方向。
2. 检测 90/180/270 度旋转。
3. 限制最大像素，按比例缩放，防内存耗尽。
4. 轻度去噪、对比度增强、灰度/自适应二值化作为可比较候选。
5. 透视矫正和边缘裁切；原图不修改。
6. 超长小票按 10–15% 重叠切片，重叠文字按边界框和规范化文本去重。
7. 从原图与增强图中选择整体置信度更高但不违反完整性的结果。

预处理参数进入 preprocessor_version，并纳入 input_hash。

### 13.5 确定性解析

PaddleOCR 只返回文字。Node 解析器负责：

- 按 y 坐标和行高聚类，恢复阅读顺序。
- 识别数量模式：x2、2份、数量 2 等。
- 识别人民币金额和小数点常见误识别。
- 组合跨行菜名，但保留 source_text 和 bounding box。
- 区分菜品行、表头、店名、桌号、时间、支付方式和汇总行。
- 把小计、折扣、优惠、服务费、抹零、应付/实付放入 summary。
- 计算 quantity × unit price 与 line total 的差异。
- quantity 和 unit price 可信时可精确推算 line total；quantity 和 line total 只有在能整除为整数分时才推算 unit price，不能为消除 1 分差额静默四舍五入。
- 不能确定时字段置 null 并加入 reviewFields，禁止猜测。

第一阶段不把餐饮小票文本发送给外部 LLM。解析规则有 parser_version、fixture 和回归测试。

### 13.6 置信度

初始提示阈值可配置：

- 菜名低于 0.85：name 加入 reviewFields。
- 数量/单价/总价低于 0.90：对应字段加入 reviewFields。
- 供应商/模型没有字段置信度时，不能填 1.0；标记 confidence_missing。
- 推算单价或总价时 priceDerived=true，即使算术确定也显示“系统推算”。

阈值必须用至少 100 组脱敏真实餐饮小票基准校准。OCR 准确率不是提交守卫；用户必须能修改每个候选字段。

### 13.7 与任务菜品要求匹配

自动 apply 只做安全匹配：

1. 规范化全半角、空白、常见单位和明确配置的门店菜名别名。
2. 对 planned_name/别名做唯一精确匹配。
3. 只有一个未绑定 requirement 时才自动填该要求行。
4. 多个要求或多个候选歧义时不自动绑定，作为 extra/待核对。
5. 不使用模糊相似度自动覆盖必点菜品。
6. 跨小票相似菜名不自动合并，除非业务规则和来源都能证明是同一行。
7. 相同 sha256 小票在 complete 阶段拒绝重复，防同一图重复识别。

apply 锁 attempt，校验 revision，写 source_candidate_id。worker 永远不直接改 dish_records。

### 13.8 删除小票后的菜品处理

删除请求必须携带：

- remove_unmodified_ocr_rows：删除只由该小票产生、未人工修改且未绑定 requirement 的自动 extra 行。
- keep_as_manual：保留受影响菜品，但清除自动来源并标为 manual/manuallyModified。

若行绑定 requirement、已人工修改或来源包含其他小票，服务端不能静默删除；返回 409 RECEIPT_DISH_CONFIRMATION_REQUIRED 和影响摘要。提交快照中的小票不能删除。

删除小票的同一事务会把引用该附件的 queued OCR job 置 cancelled，并对 processing job 写 cancellation_requested_at；多图 job 只要缺少一张固定输入就整体取消。已完成 OCR 候选作为审计历史保留到问卷提交/保留期，但不能再次 apply 被删除来源。

### 13.9 管理员人工比对

管理员提交详情同时展示：

- 最多 9 张原始小票缩略图及授权原图。
- OCR 规范化候选、来源小票、置信度和识别框。
- 探店员最终菜品、数量、单价、总价。
- manual_added、ocr_removed、name_changed、quantity_changed、price_changed、derived、manual_modified 差异。
- 识别总额、最终菜品合计和差额。

管理员第一阶段只能查看和人工比对，不能修改已提交快照。发现问题通过线下流程处理；后续整改版本另行设计。

## 14. Worker、租约和后台任务

### 14.1 领取协议

worker 领取任务使用数据库时间：

~~~sql
WITH candidate AS (
  SELECT id
  FROM receipt_ocr_jobs
  WHERE status IN ('queued', 'processing')
    AND next_attempt_at <= now()
    AND (status = 'queued' OR lease_expires_at < now())
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE receipt_ocr_jobs j
SET status = 'processing',
    locked_by = :worker_id,
    locked_at = now(),
    lease_expires_at = now() + INTERVAL '5 minutes',
    heartbeat_at = now(),
    attempt_count = attempt_count + 1
FROM candidate
WHERE j.id = candidate.id
RETURNING j.*;
~~~

- 心跳每 30 秒延长租约。
- 只有 locked_by 匹配且租约有效的 worker 可完成任务。
- OCR 最大 3 次，建议退避 30 秒、2 分钟；永久格式错误不重试。
- 完成结果和 job 状态在一个事务写入。
- 进程崩溃后租约过期可接管；旧 worker 的迟到写入因 CAS 失败而丢弃。
- 每次昂贵步骤前和写结果前检查 cancellation_requested_at 与 attempt 状态；attempt=submitting 且尚未明确取消时不写结果，释放租约并短暂延后重试；attempt=submitted、已请求取消或 job=cancelled 时删除临时数据，只把 job 结束为 cancelled，不写候选。

### 14.2 计划任务

| 频率 | 任务 |
|---|---|
| 每分钟 | 分配逾期推进、豁免过期、提交恢复 |
| 每 5 分钟 | OCR/导出/归档恢复租约恢复、过期 edit session |
| 每小时 | 暂存/failed 对象清理、过期 auth 记录 |
| 每日 | retention 批次、COS/DB 对账、备份存在性检查 |
| 每周 | 全量孤儿对象抽样/分片扫描、索引和慢查询报告 |
| 每月 | PostgreSQL 恢复演练、随机证据完整性抽验 |

每项任务使用 advisory lock 或 system_job_runs 租约，允许多 worker 但同一分片只有一个执行者。批处理使用小批次和游标，不能长事务锁全表。

## 15. 安全设计

### 15.1 密钥

- 生产 Secret 只在腾讯云密钥管理/部署 Secret 中，绝不提交 .env。
- COS、短信、验证码、数据库和会话签名分别使用独立凭据。
- API 与 worker 使用最小权限子账号；OCR 无云密钥。
- 每 90 天轮换长期凭据；会话/CSRF 密钥支持双 key 过渡。
- 启动时校验必需配置，但日志只输出配置名是否存在，不输出值。

### 15.2 Web/API 防护

- 管理端只允许配置的 HTTPS Origin，拒绝通配 CORS。
- Cookie 管理接口启用 CSRF、Origin/Referer 校验。
- 使用参数化查询，禁止拼接用户 SQL。
- 设置 CSP、frame-ancestors、X-Content-Type-Options、Referrer-Policy。
- 输入 schema 默认 strip/reject 未知敏感字段。
- 对 username/login/phone 接口做时序和响应统一，减少枚举。
- 所有 URL 抓取被禁止；OCR worker 只能按数据库中的受信 Bucket/key 读对象，防 SSRF。
- 上传文件不在 Web 根目录执行或直接提供。

### 15.3 隐私

- 手机号字段信封加密；查找使用 HMAC blind index。
- 精确坐标不进入通用日志、分析事件或审计 metadata。
- 预览签名 URL、验证码、session、reset token、COS 签名全部纳入日志脱敏。
- 管理员手机号默认脱敏，只有明确业务权限才能查看完整值，并写审计。
- 错误追踪平台只接收 requestId、业务错误码和去标识 ID。
- 隐私政策明确位置只用于到店打卡，不进行持续轨迹采集。

### 15.4 供应链与基础设施

- package-lock/依赖锁文件必须提交；CI 执行依赖漏洞扫描和许可证检查。
- 容器固定镜像 digest，不使用浮动 latest。
- 数据库和 COS 访问均使用 TLS。
- PostgreSQL 开启静态加密/云盘加密；备份二次加密。
- 主机只开放必要端口，SSH 使用密钥和最小管理员。
- production 禁止调试路由、TraceConsole、fixture 数据和宽松 Mock。

## 16. 可观测性、告警与运行手册

### 16.1 日志

结构化日志字段：

~~~text
timestamp, level, service, environment, requestId,
routeName, actorIdHash, role, subjectType, subjectId,
durationMs, resultCode, retryable
~~~

不得记录请求完整 body。认证、手机号、坐标、答案文本、签名 URL 和供应商响应使用 allowlist 后再记录。

提供不含业务数据的 GET /health/live 和 GET /health/ready。live 只表示进程事件循环可响应；ready 检查数据库和关键内部配置，但不因短信/PaddleOCR 短时失败把全部 API 摘除。生产 OpenAPI 文档只对受权管理员或内部网络开放。

### 16.2 指标

- HTTP 请求量、P50/P95/P99、4xx/5xx、连接池等待。
- 登录失败、短信发送、CAPTCHA 拒绝、验证码锁死。
- assignment 各状态数、逾期推进延迟。
- 上传初始化/complete 成功率、校验失败原因、孤儿对象数。
- OCR queue depth、queue age、推理时长、重试、partial/failed 比例。
- submit succeeded/terminal_failed/retryable_failed、租约接管和恢复数。
- 导出时长、失败、过期下载。
- backup age、restore drill age、retention lag、legal hold 数。

指标标签禁止使用手机号、用户名、门店自由文本、对象 key 或 request body。

### 16.3 初始服务目标

- 核心 API 月可用性 99.5%。
- 非上传/导出请求 P95 < 500 ms。
- submit P95 < 2 s。
- 在第 19.4 节 P1 OCR 负载（每任务 1–3 张）下，有效小票 OCR 任务 95% 在 120 秒内得到 succeeded/partial/failed 明确结果；最多 9 张的单任务仍受 10 分钟硬超时保护。
- 逾期状态推进延迟 P95 < 2 分钟。
- 每日备份成功率 100%，恢复演练不超过 31 天未执行。

### 16.4 必备告警

- 5 分钟窗口 5xx > 2%。
- submit retryable_failed 或 invariant_violation 突增。
- OCR 最老 queued > 10 分钟。
- worker 无心跳 > 5 分钟。
- 未验证/孤儿对象超过阈值。
- 最新成功备份超过 26 小时。
- 数据库磁盘 > 75%、连接池等待持续升高。
- COS 拒绝/签名失败异常增加。

ops/runbooks 至少包含：数据库不可用、COS 不可用、OCR 堆积、短信异常、泄露密钥轮换、提交不变量破坏、备份恢复和误删对象恢复。

## 17. 备份与灾难恢复

- PostgreSQL 每日执行加密 custom-format pg_dump 到 backups Bucket，保留 35 天。
- backups Bucket 优先放在独立腾讯云项目/备份账号，生产 API 无读写删权限；备份任务只可新增，独立清理角色按 35 天策略删除。
- 若使用托管 PostgreSQL，同时开启自动备份/PITR；逻辑备份仍保留，不能只依赖同一平台快照。
- Lighthouse/云主机快照是辅助，不是唯一数据库备份。
- COS evidence Bucket 开启版本控制；跨地域复制在真实数据量和预算确认后启用。
- 每月把随机备份恢复到隔离数据库，运行 schema checksum、核心行数、随机提交 integrity_hash 和附件引用检查。
- 恢复演练禁止连接生产短信、验证码和小程序域名。

第一阶段目标：

- RPO：24 小时；托管 PITR 启用后目标可收紧到 15 分钟。
- RTO：4 小时。

恢复顺序：

1. 建立隔离网络和新数据库。
2. 恢复最近完整备份/PITR。
3. 运行 migration checksum 与完整性检查。
4. 校验 COS Bucket、versionId 和随机 sha256。
5. 以只读方式启动 API，验证 /ready 和管理员抽样。
6. 切换流量后再启动 worker，防重复任务。
7. 记录事件时间线和数据缺口。

## 18. 配置

配置按 schema 在启动时验证。示例名称：

~~~text
NODE_ENV
API_PUBLIC_BASE_URL
ADMIN_PUBLIC_ORIGIN
DATABASE_URL
DATABASE_POOL_MAX
DATABASE_POOL_ACQUIRE_TIMEOUT_MS
MAX_ASSIGNMENTS_PER_CAMPAIGN
AUTH_HASH_MAX_CONCURRENCY
ATTACHMENT_VERIFY_MAX_CONCURRENCY
ATTACHMENT_VERIFY_QUEUE_MAX
SESSION_PEPPER_KEY_ID
PHONE_ENCRYPTION_KEY_ID
BLIND_INDEX_KEY_ID
COS_REGION
COS_EVIDENCE_BUCKET
COS_EXPORT_BUCKET
COS_BACKUP_BUCKET
COS_ROLE_ARN
COS_UPLOAD_TTL_SECONDS
COS_PREVIEW_TTL_SECONDS
CAPTCHA_PROVIDER
CAPTCHA_APP_ID
CAPTCHA_APP_SECRET_KEY
CAPTCHA_API_SECRET_ID
CAPTCHA_API_SECRET_KEY
SMS_PROVIDER
SMS_SECRET_REF
OCR_PROVIDER=paddle
OCR_SERVICE_URL
OCR_MODEL_VERSION
OCR_PARSER_VERSION
OCR_MAX_CONCURRENCY
JOB_WORKER_ID
LOG_LEVEL
RETENTION_POLICY_VERSION
~~~

仓库提供 .env.example，只写说明和非敏感默认值。生产 Secret 变量可以是密钥引用，不要求以明文环境变量注入。

## 19. 测试与验收

### 19.1 测试层次

| 层次 | 必测内容 |
|---|---|
| 单元 | Haversine、半径补偿、状态机、得分、菜品条件、OCR parser、request hash |
| 数据库集成 | 部分唯一索引、组合外键、revision、行锁、租约、删除限制 |
| HTTP 契约 | 每个路由请求/响应都通过 packages/contracts，错误结构一致 |
| 供应商 Adapter | CAPTCHA/SMS/COS/PaddleOCR 超时、失败、重试与脱敏 |
| 并发 | 审批、开始任务、豁免消费、9 张上限、edit session、apply、submit |
| 安全 | 越权、ID 枚举、CSRF、限流、文件伪装、SSRF、日志泄露 |
| OCR 基准 | 中文餐饮小票、长图、旋转、模糊、折扣、跨行菜名和多图 |
| E2E | 真实 API + PostgreSQL + 私有对象存储兼容环境；不走生产 Mock |
| 恢复 | worker crash、过期 lease、数据库恢复、COS version 恢复 |

### 19.2 关键并发用例

必须自动化验证：

1. 两名管理员同时审批，只有一个成功。
2. 两个请求同时创建 active 豁免，只有一个成功。
3. 过期豁免存在时可原子过期并创建新豁免。
4. 两次 start 只创建一个 attempt。
5. 两个设备同时开同题 edit session，只有一个 open。
6. 并发初始化第 9/10 张小票，第 10 张被拒绝。
7. 人工保存与 OCR apply 使用相同旧 revision，只有一个成功。
8. 同 submitToken 并发，只创建一个 submission。
9. 不同 token 并发提交同 attempt，只允许一个成功。
10. 进程在 submitting 中崩溃，恢复后没有永久 processing。
11. TASK_OVERDUE 的旧 token 在延期后仍重放失败；新 token 可提交。
12. 提交成功后所有附件/OCR/菜品写路径都返回冲突。

### 19.3 OCR 基准验收

建立不少于 100 组经授权脱敏的餐饮小票测试集，覆盖：

- 不同打印机、字号、背景、折痕、阴影。
- 单张和最多 9 张。
- 长小票、旋转、透视、轻度模糊。
- 份数、单价、总价、折扣、服务费、优惠和支付信息。
- 新疆/粤菜等较长中文菜名、数字菜名和多行菜名。

统计字符识别、菜名召回、数量/金额字段准确率和需要人工核对比例。第一阶段不设置“达不到某准确率就禁止手工提交”，但必须确认：

- 不会把折扣/支付方式自动创建为菜品。
- 低置信度和推算字段明确标记。
- 所有字段可修改且原始候选可追溯。
- OCR 失败可手工完成。

### 19.4 并发容量验收与判定口径

第一阶段先定义最低“试点并发档 P1”，而不是声称支持无限 N。压测必须在与生产同规格的 staging 上使用真实 Fastify、PostgreSQL、私有对象存储和 PaddleOCR；不得使用 `tests/fixtures/contract-server.mjs`、内存数据库或把外部调用全部改成立即成功。

P1 固定负载模型：

| 场景 | 最低负载 |
|---|---|
| 混合在线业务 | 120 个虚拟用户（100 探店员 + 20 管理员），思考时间 2–5 秒，30 RPS 持续 30 分钟 |
| 短时峰值 | 100 RPS 持续 60 秒；入口可以有界排队，但不得进程崩溃或连接池失控 |
| 长时间稳定性 | 20 RPS 持续 2 小时，内存、连接数、job lag 不得持续爬升 |
| 独立问卷写入 | 50 个不同 attempt 同时保存答案/菜品，不得互相阻塞或串数据 |
| 同父任务热点 | 同一 campaign 的 100 条分配在 60 秒内混合开始、提交、延期或取消；允许短暂父行等待，不允许未恢复死锁或聚合状态错误 |
| 最终提交 | 30 个不同 attempt 在 10 秒内提交；另对同一 attempt 发 20 个同 token/不同 token 竞争请求，只能有一个快照 |
| 管理员竞争 | 20 个并发审批/延期/取消请求覆盖相同和不同资源，状态、revision、审计必须一致 |
| 附件完成 | 20 个不同 attempt 并发校验文件；单 attempt 的 9 张并发 complete 不得重复计数、越过上限或写入提交后问卷 |
| OCR | 10 个任务同时入队，每个 1–3 张基准小票；用实测结果调整 worker 数，使第 16.3 节 OCR SLO 通过 |
| 父任务上限 | 500 条分配的发布、状态重算和整体取消；整体取消 P95 目标 < 5 秒且无部分提交 |

P1 通过门槛：

- 数据不变量失败、越权、跨问卷串数据、重复 submission、丢失已确认附件：必须为 0。
- 非预期 5xx < 0.5%；预期 revision 冲突、限流、202 processing 和有界 503 必须返回正确业务码，不计为静默成功。
- 普通非上传/导出 API P95 < 500 ms，submit P95 < 2 s；同父任务热点的数据库锁等待 P95 < 200 ms。
- 数据库连接池获取 P95 < 100 ms，使用率不得长期超过 80%；无泄漏，运维预留连接始终可用。
- API/数据库平均 CPU < 70%、持续 5 分钟不得高于 85%；Event Loop delay P99 < 100 ms；RSS 在 2 小时稳定性测试中不得单向无界增长。
- 死锁应为 0；若故障注入产生 `40P01/40001`，只允许按第 3.4 节安全重试且最终状态一致。
- 杀死一个 API 进程时，入口摘流后其他实例继续服务；杀死 OCR worker 后，租约到期可接管且候选不重复。

容量报告必须同时给出硬件规格、API/worker 实例数、连接池、测试数据量、P50/P95/P99、错误码分布、锁等待、数据库/CPU/内存、OCR 吞吐和原始压测脚本。逐级增加 VU/RPS 找到首个不达标点；对外承诺的安全容量不得超过“最后一个全部通过档位”的 70%，保留至少 30% 峰值余量。

如果 P1 未通过，结论只能是“并发设计待修复/容量不足”；不得通过放宽正确性断言、隐藏 409/503 或改用 fixture 获得通过。更大的 N 必须新增 P2/P3 负载档并重测，不能从 P1 线性猜测。

### 19.5 完成证据

后端 Agent 的完成报告必须列出：

- 实际 migration 列表和数据库约束测试。
- 实际 API 路由与共享契约一致性结果。
- 私有 COS 直传、complete 校验和短时预览的 staging 证据。
- PaddleOCR 使用的模型/镜像 digest、基准数据版本和结果。
- 并发、崩溃恢复、权限和提交不可变测试。
- 备份文件、最近恢复演练和 RPO/RTO 结果。
- 尚未完成的真实供应商、微信开发者工具或 Android 真机验证。

fixture、浏览器演示、静态扫描和“按钮可以点”不能替代上述证据。

## 20. 实施批次

### 批次 0：契约和工程底座

1. 修复第 10 节共享契约缺口。
2. 统一 npm workspaces 和根 package-lock，再建立 apps/api、apps/worker、apps/ocr-service 和 db/migrations。
3. 配置 Fastify plugin、Zod/OpenAPI、PostgreSQL pool、结构化日志。
4. 建立 health/live/ready、requestId 和统一错误。
5. CI 增加 schema 生成一致性、migration、禁止生产 Mock 和敏感词扫描。

通过门槛：空业务 API 可启动，真实 PostgreSQL migration 可重复执行，契约生成无漂移。

### 批次 1：认证、审批和 RBAC

1. users、registrations、sessions、SMS/CAPTCHA、密码重置。
2. 管理员 Cookie/CSRF、角色、permission、scope。
3. 审批、停用、会话撤销和 bootstrap。
4. 限流与安全审计。

通过门槛：注册到批准登录、拒绝重提、3 次验证码、停用即时撤销的集成/并发测试。

### 批次 2：门店、任务、定位和题库

1. 门店 GCJ-02、半径与校准。
2. 题库版本、复制、证据配置和发布守卫（启用题号 1..N 连续）。
3. campaign、assignment、菜品要求和父状态聚合。
4. check-in、豁免、start、逾期 worker。

通过门槛：0/1/多任务、范围内/外/精度不足、豁免竞争、逾期延期全部真实 API 通过。

### 批次 3：问卷、问题证据和 COS

1. attempt、逐题答案、revision。
2. edit session、staged_ready/removal/confirm/cancel。
3. COS POST Policy、complete 内容校验、短时预览。
4. 临时对象清理和提交后写锁。

通过门槛：图片/音频条件必填、取消恢复、并发会话、私有访问和对象对账通过。

### 批次 4：小票、PaddleOCR 和菜品

1. 最多 9 张小票上传、删除影响处理。
2. PaddleOCR sidecar、PostgreSQL job 租约和预处理。
3. 确定性 parser、候选/汇总、幂等 apply。
4. 菜品状态、价格/数量和管理员对比。

通过门槛：九图、长图、部分失败、worker crash、人工修改、删除来源和手工兜底通过。

### 批次 5：提交、管理员详情、导出

1. submit idempotency、完整校验、不可变快照。
2. processing/submitting 恢复。
3. 管理员完整题目详情和小票/OCR 对比。
4. 异步导出和下载授权。

通过门槛：第 19.2 节提交竞争、逾期 token、崩溃和提交后全写锁测试通过。

### 批次 6：保留、备份和上线

1. retention/legal hold、COS 存储迁移、孤儿对账。
2. 备份、恢复、告警和 runbook。
3. 在同规格 staging 执行第 19.4 节 P1 并发/容量压测、安全检查、微信工具和 Android 真机联调。
4. production 配置复核和回滚演练。

通过门槛：恢复演练、隐私删除、告警演练和端到端真实环境证据齐全。

不得跳过批次 0 直接让后端适配有缺口的前端 schema。可以在同一批次内并行模块，但每个后续批次必须依赖前一批次的数据和安全门槛。

## 21. 数据库迁移和种子

- migration 文件按时间序号只增不改；已在共享环境执行的 migration 禁止重写。
- 每次 migration 在事务中执行；CREATE INDEX CONCURRENTLY 等例外拆成明确非事务 migration。
- migration CI 从空库升级到最新，并从上一个生产 tag 升级到最新。
- seed 只创建角色、权限、区域测试数据、第一版题库和脱敏开发账号。
- production seed 不创建默认密码管理员；首管走 TTY bootstrap。
- 第一版题库 seed 也必须通过通用发布守卫，不能绕过。
- 数据修复写独立、可重跑、带审计和 dry-run 的脚本。

## 22. 上线检查表

### 22.1 配置与权限

- [ ] production 无 USE_MOCK、fixture server、调试管理员入口。
- [ ] COS Bucket 为 private，CORS/域名、版本控制和生命周期已核验。
- [ ] API/worker/OCR/backup IAM 分离并最小权限。
- [ ] CAPTCHA、短信、小程序定位接口权限和模板审核通过。
- [ ] 数据库公网关闭、TLS 和备份开启。
- [ ] Secret 扫描无泄露，日志脱敏抽查通过。

### 22.2 数据与业务

- [ ] 发布守卫（启用题号 1..N 连续、数量不设上限）适用于所有版本。
- [ ] 明察草稿不能在第一阶段发布。
- [ ] 任务没有全局 current 对象。
- [ ] owner/scope 越权测试全部拒绝。
- [ ] 逾期 worker、延期新 token 和父状态一致。
- [ ] unscored 文本及图片/音频条件均由服务端验证。
- [ ] 9 张小票上限在并发下有效。
- [ ] OCR 不直接修改菜品，apply 幂等且 revision 防覆盖。
- [ ] submit 崩溃恢复和提交后全写锁通过。

### 22.3 运维

- [ ] 指标、日志、告警和 requestId 可用。
- [ ] 最新备份小于 26 小时，最近恢复演练小于 31 天。
- [ ] retention/legal hold dry-run 结果经审批。
- [ ] OCR 模型、解析器和基准版本固定。
- [ ] P1 压测脚本、原始结果和 30% 容量余量报告已归档；结果未使用 fixture。
- [ ] 回滚方案不依赖回滚数据库 migration。
- [ ] 微信开发者工具及 Android 真机主路径完成。

## 23. 官方技术依据

- Node.js 发布状态：[Node.js Previous Releases](https://nodejs.org/en/about/previous-releases)
- Fastify 5 运行时要求：[Fastify v5 Migration Guide](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/)
- Fastify 请求超时与优雅关闭：[Fastify Server Reference](https://fastify.dev/docs/latest/Reference/Server/)
- PostgreSQL 支持周期：[PostgreSQL Versioning Policy](https://www.postgresql.org/support/versioning/)
- PostgreSQL 行锁与统一锁顺序：[Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- PostgreSQL 队列领取的 `SKIP LOCKED` 语义：[SELECT Locking Clause](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- node-postgres 有界连接池：[Pooling](https://node-postgres.com/features/pooling)
- Node.js 避免阻塞 Event Loop/Worker Pool：[Don't Block the Event Loop](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)
- 微信小程序定位：[wx.getLocation](https://developers.weixin.qq.com/miniprogram/dev/api/location/wx.getLocation.html)
- 腾讯云 COS 生命周期：[对象生命周期管理](https://cloud.tencent.com/document/product/436/17028)
- 腾讯云 COS 小程序直传：[小程序直传实践](https://cloud.tencent.com/document/product/436/34929)
- 腾讯云 COS 版本控制：[版本控制配置](https://cloud.tencent.com/document/product/436/19884)
- 腾讯云 COS 流量说明：[流量费用](https://intl.cloud.tencent.com/zh/document/product/436/33776)
- PaddleOCR OCR 产线：[General OCR Pipeline](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/OCR.html)
- PaddleOCR 服务化部署：[Self-hosted Serving](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/serving/serving.html)
- OWASP 密码存储：[Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- OWASP 找回密码：[Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)

依赖版本和云产品行为在实际开工/上线前需再次核验官方文档。第三方文档只作为补充，安全和费用不能凭博客假设。
