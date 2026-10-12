# 汇盈探店：第一阶段全栈追踪矩阵

> 建立日期：2026-08-11（生产化收口轮）。
> 口径：规范条款 → 数据库 → API → 服务端校验 → UI → 自动测试 → 外部证据。
> 外部证据列标记 BLOCKED 表示依赖真实云/真机/staging，不把 fixture/Mock/sandbox 算作通过。
> 本矩阵是核心 Markdown（project_boundary / assignment_spec / BACKEND_DESIGN / STATE_MACHINE_OVERVIEW）第一阶段要求的追踪结果。

| 领域 | 规范条款 | 数据库 | API | 服务端校验 | 小程序/Admin UI | 自动测试 | 外部证据 |
|---|---|---|---|---|---|---|---|
| 注册/审批/登录/找回密码 | boundary 4.1#15-16, assignment 6.1, BACKEND 6 | users, inspector_registrations, phone_verification_challenges, password_reset_tokens, auth_sessions | /api/auth/*, /api/admin/auth/* | Argon2id、3 次验证码上限、reset token 单次、统一响应、停用撤销会话、CAPTCHA 二次校验 | login 页面（register/forgot/status UI 已按 2026-08-13 策略隐藏，接口保留） | auth.postgres (33 项)、providers (37 项) | CAPTCHA/短信真实密钥 BLOCKED |
| 任务 0/1/多、类型、逾期/延期/取消/豁免 | boundary 4.1.5, assignment 3.2/3.2.2 | audit_campaigns, audit_assignments, checkin_exemptions | /api/assignments/mine, /api/admin/campaigns/* | 所有权、时间窗口、逾期推进、豁免 30 分钟部分唯一索引 | schedule/task 0/1/多入口、问卷答题在 survey 页 | batch2.postgres (31 项) | 真机任务流 BLOCKED |
| 门店 GCJ-02 与后端距离 | boundary 4.1.4, BACKEND 8.3 | stores, audit_checkins | /api/admin/stores, /api/assignments/:id/check-in | Haversine、60s 新鲜度、200m 精度补偿上限、服务端判定 | 门店地图组件、任务详情打卡 | location.test (3 项)、batch2 打卡测试 | 腾讯地图 Key + 真机定位 BLOCKED |
| 50 题/证据要求/编辑会话 | boundary 4.1.3, BACKEND 8.4/8.6 | questions, question_evidence_requirements, question_answer_edit_sessions, question_evidence_attachments | 题库 CRUD/发布、草稿 answers、edit-sessions、evidence-uploads | 发布 50 题守卫、unscored 必填说明+图片/音频条件、会话确认/取消原子 | survey/issue 页面 | domain/unit、batch2 会话竞争测试 | — |
| 草稿隔离 | boundary 4.1.1, assignment 3.4 | survey_attempts UNIQUE(assignment_id) | drafts/* | 所有者联表推导、revision 乐观锁 | store/survey.js 草稿键 userId+assignment+attempt+version | survey-merge.test (5 项) | — |
| 菜品状态与条件校验 | assignment 3.3, BACKEND 8.7 | dish_records | PUT drafts/:id/dishes | ordered/substituted/unavailable/skipped/extra 条件、评价/满意 | dishes 页面 | miniapp-business.test (4 项)、validateDish | — |
| 小票 9 张/COS/OCR/人工校对 | boundary 4.1.6, assignment 3.3.1, BACKEND 12/13 | receipt_attachments, receipt_ocr_jobs, receipt_ocr_candidates | receipt-attachments/*, receipt-ocr-jobs/*, apply | 9 张并发上限、sha256 去重、complete 内容校验、apply 幂等 | dishes 小票区/OCR 状态、Admin 比对 | receipt-ocr/parser 测试、ocr-real.postgres (32 项)、cos 测试 | 真实 COS 桶 + PaddleOCR Linux x86-64 部署 BLOCKED |
| 幂等提交/崩溃恢复/不可逆 | boundary 6.3, BACKEND 9.7/9.8 | idempotency_keys, submission_versions | POST submit | 三段事务、30s 租约、成功/终态/可重试失败、提交后全写拒绝 | other 提交确认 | batch2 提交竞争/恢复测试 | — |
| 四角色 RBAC/数据范围/技术隔离 | BACKEND 7, 8.2/8.9 | roles, permissions, user_data_scopes | /api/admin/* | 路由权限+scope 双重校验、越权 404/403 | Admin 菜单投影、业务化文案 | admin E2E (13 项) | 真实 staging 四角色 E2E BLOCKED |
| 保留/备份/对账/心跳/审计 | boundary 9.2.1, BACKEND 16/17 | retention_runs, system_job_runs, audit_logs | /metrics, /health/* | 每日幂等清理、legal hold、备份上传 | — | retention/observability 测试 | 备份恢复演练真实执行 BLOCKED |
| 公开客户端配置 | contracts/endpoint-registry.js（clientConfig）、BACKEND_DESIGN 3.2 | — | GET /api/public/client-config | 只返回公开字段、production 缺值 503 | 小程序/Admin 运行时加载 | config-consistency.test | 真实 CaptchaAppId/地图 Key BLOCKED |

## 本轮发现并关闭的实现缺口

1. CAPTCHA：DescribeCaptchaMiniResult 请求体删除不受支持的 UserAgent；CAPTCHA_APP_ID 严格校验；Provider 组合显式化（修复对象展开覆盖）；只保存腾讯 RequestId（migration 0020 允许空）；客户端 refresh/取消/卸载处理；受限 trustProxy。
2. 配置：根 .env 单一来源；Zod Schema 补齐 COS AssumeRole/续期、LOG_LEVEL、TRUST_PROXY、公开 Origin、地图 Key；production 全部强制类别失败关闭（含三桶不同、禁 static STS、禁占位值/localhost）。
3. COS：续期字段不再被 Zod 剥离（回归测试）；renewing 为唯一长期模式。
4. 微信项目：apps/miniapp 唯一正式目录；正式 AppID 唯一性检查；品牌更名汇盈探店。
5. 部署：production Compose + Caddy + Worker/OCR 健康检查 + release:prepare/preflight:production/deploy:production/verify:external + verify:offline。
6. 首管安全：deploy 检测无 super_admin 时只输出 TTY bootstrap 命令，不创建默认账号。
