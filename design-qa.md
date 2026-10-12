# Design QA

> 更新日期：2026-08-10（FULLSTACK ONE-SHOT 收口轮）
> 本文件只记录当前已验证与仍未验证的事实，不再包含“游客 AppID / 从未运行开发者工具”等过时断言。

## 当前状态

生产 Admin 入口只呈现管理员登录；小程序只依赖真实 API 响应。本轮已完成：

- 后端：正式 Tencent CAPTCHA（`DescribeCaptchaMiniResult`，CaptchaType=9）与腾讯云短信（`SendSms`）Provider 在 `apps/api/src/server.js` 注入；生产缺少供应商密钥时启动失败关闭；沙箱模式仅限非生产且必须白名单。
- COS：`apps/api/src/storage/cos.js` 改为可续期最小权限凭证 Provider（CAM AssumeRole 单飞刷新、过期前自动续期、并发刷新合并、刷新失败返回可重试 503）；上传/预览/导出/备份仍为私有桶短时授权。
- OCR：`apps/worker/src/receipt-ocr.js` 有界可配置并发（`OCR_WORKER_MAX_CONCURRENCY`/`CLAIM_LIMIT`/`POLL_INTERVAL_MS`/`OCR_MAX_QUEUED_JOBS`），队列深度与最老年龄进入指标。
- 可观测性：`GET /metrics`（Prometheus 文本格式，无依赖）、`/health/live`、`/health/ready`、worker 心跳与备份完成写入 `system_job_runs`（migration 0019）。
- 小程序：app.js 初始化 CAPTCHA Adapter（`services/captcha-host.js`）；登录页接入 `plugin://captcha/t-captcha`（插件需在微信公众平台添加后才可本地编译，fixture 测试在临时项目副本中剥离该声明）；问卷草稿按“同 revision 保留本地未同步字段并逐项补发、revision 前进显示冲突”合并；个人页绑定真实会话数据并删除硬编码“周雨晴/已启用”；新增填写帮助页；问卷得分按钮、冲突横幅、窄屏布局修正。
- Admin：全部主要按钮调用真实 API；运营字号提升（正文 ≥13px、标签/表格 ≥12px，保留手机预览区的原样小字号）。

## Verified in this implementation

- Admin login renders as the only production entry（未登录只有管理员登录）。
- 管理员登录 → 注册审批（批准/不批准/重新打开/停用/启用）→ 父任务（创建/发布/整体取消）→ 逐人分配（创建/延期/取消/豁免）→ 提交筛选 → 提交详情（50 题只读）→ 导出筛选结果，全部按钮调用真实 API 并有 loading/禁用/失败/重试/成功反馈。
- Product-visible DOM 无 API 路径、HTTP 状态、内部 ID、token、revision、storage key、JSON、堆栈。
- 四角色菜单隔离、服务失败业务化提示、重试入口、会话失效返回登录由 Playwright 覆盖。
- 地图未配置状态明确提示且保存禁用，不会用默认坐标静默保存门店。
- 问卷草稿合并规则（`store/survey-merge.js`）单测覆盖：空服务端 answers 不覆盖本地待同步草稿、同 revision 补发、revision 前进冲突。
- COS 凭证续期单测覆盖：临近过期并发请求只触发一次 AssumeRole、旧凭证仍有效时续期失败不中断、真正过期返回 503。
- Provider 单测覆盖：票据缺失拒绝、CaptchaCode=1 通过、供应商拒绝归类、短信模板拒绝归类、日志脱敏、生产缺密钥失败关闭、sandbox 禁止用于生产。
- 可观测性单测覆盖：/health/live、/health/ready、/metrics 内容与无敏感标签。

## 本轮自动化证据（2026-08-11 更新）

- `npm run check:runtime`：Node.js 24.14.0 supported。
- `npm run contracts:check`：内容哈希漂移检查 PASS（故意漂移时非零退出已验证）。
- `npm run test:production-source`：passed。
- `node tests/frontend-contract.mjs`：passed。
- `npx vitest run tests/unit tests/contract`：81 passed（新增 providers/cos-renewal/survey-merge/observability）。
- PostgreSQL 17（docker postgres:17）空库 19 项 migration + seed；升级路径：0017 基线 → 全量迁移 PASS。
- `npm run test:backend:postgres`：31 passed（真实 PostgreSQL 17）。
- `npm run test:backend`：33 passed。
- `npx playwright test`（Admin E2E）：13 passed。
- `npm run build:admin` + `node tests/bundle-contract.mjs`：passed。
- `node tests/e2e/miniapp-native.cjs`：30/30 通过（02:00 新鲜截图，exceptions=0）。
- `node tests/e2e/miniapp-receipt-native.cjs`：通过。
- **`npm run verify:release` 总门禁（2026-08-11 04:40）：12/12 步骤 PASS**（check:runtime、production-source、contracts、frontend、db:migrate、db:seed、test:backend:postgres〔32，含真实 PaddleOCR 集成〕、test:backend〔34〕、test:admin:e2e〔13〕、test:miniapp:native〔30/30〕、test:miniapp:receipt-native、test:miniapp:real-api〔20/20〕）；唯一缺项 `P1_PLAN_PATH`（仓库外授权 staging 计划），门禁按设计失败关闭退出码 1（BLOCKED）。
- 真实 PaddleOCR：`docker run --platform linux/amd64 junde-ocr:amd64-verify` 在本机（Rosetta 模拟）加载真实 PP-OCRv6_small_det/rec 模型并通过 `/ready`；真实中文小票推理返回 君德餐厅/宫保鸡丁 x1 38.00 等行；`tests/integration/ocr-real.postgres.test.js` 让真实 worker 领取租约→真实推理→候选落库（succeeded）。解析器据此修复：x1/1x 数量写法、单金额行整除推算单价、跨行合并、实收/应收等汇总词过滤。
- 真实 API 小程序流程：`tests/e2e/miniapp-real-api.mjs` 20/20（真实注册→真实审批→真实任务发布→小程序 UI 登录→日程显示真实任务→真实打卡正/负路径落库）。

## Verified Admin captures（历史视觉证据，fixture）

- `tests/visual/admin-campaign-editor.png`
- `tests/visual/admin-assignment-editor.png`
- `tests/visual/admin-submission-filters.png`
- `tests/visual/admin-submission-detail-full.png`
- `tests/visual/admin-store-map-unconfigured.png`
- `tests/visual/fullstack-audit-2026-08-10/admin-*.png`（本轮审计截图）

## 小程序原生证据（fixture 视觉回归，本轮新鲜）

- 小程序项目使用真实 AppID `wx35690c1079fb5a5d`（`apps/miniapp/project.config.json`）。
- 2026-08-11（本轮）微信开发者工具登录态可用后：
  - `node tests/e2e/miniapp-native.cjs`：**30 个页面状态全部通过**，`tests/visual/wechat-2026-07-24/results.json`（passed=30、exceptions=0、applicationExceptions=0、errors=[]），截图时间戳 2026-08-11 01:13（00-login … 10e-submit-success）。
  - `node tests/e2e/miniapp-receipt-native.cjs`：**通过**（小票上传恢复、OCR 排队/处理/成功与隐藏时停止轮询、恢复后幂等自动带入、金额修改 12.34→1234 分、人工修改标记、管理员要求行不被覆盖、无运行时异常）。
- fixture 运行使用剥离人机验证插件声明的临时项目副本（`tests/e2e/prepare-miniapp-fixture.cjs`），生产 `app.json` 保留插件声明。
- 旧证据：2026-08-10 21:36–21:37 也通过 30 状态（代码修改前）；本轮 01:13 为最新新鲜结果。

## Native verification blockers（外部条件，需要用户操作）

1. ~~微信开发者工具自动化端口与登录态~~：2026-08-11 已解决（`cli auto` 以真实 AppID 启动自动化，fixture 原生两套测试通过）。
2. 腾讯验证码插件（provider `wx5a3a7366fd07182e`）需要在微信公众平台「添加插件」授权后，真实 AppID 项目才能本地编译带 `plugins` 声明的版本；fixture 测试已通过临时副本剥离该声明，真实插件编译仍待授权。
3. Android/iOS 真机定位、键盘、返回、相机、录音、播放、网络失败、上传重试与提交锁尚未执行。
4. staging 真实供应商（CAPTCHA/SMS/COS/PaddleOCR/地图 Key）验收未执行。

## 认证页面方案 2 重构（2026-08-12）

按「方案 2：唯一文字视觉契约」重写 `apps/miniapp/miniprogram/pages/login/*`（真实 WXML/WXSS 实现，非图片资源）：

- 登录默认页：品牌标记 92rpx（#F25F42 圆角方块「汇」）+ 汇盈探店 + 「探店员工作台」52rpx 主标题 + 「欢迎回来」副标题 + 用户名/密码（96rpx 输入框外壳；密码框为完整单框，最右侧嵌入纯 CSS 眼睛图标：可视约 21px、透明点击热区 44px、距右缘约 15px，`showPassword` 切换睁眼/闭眼斜线两态，无文字、无分隔线、图标切换不引起布局变化）+ 主按钮「登录」（96rpx、pending 原生 loading + disabled）+ 底部说明「账号需经管理员审核后启用」。次级操作区「忘记密码 / 注册探店员账号」已按 2026-08-13 策略隐藏（`wx:if="{{false}}"`，后端与 JS 保留）。
- 删除：登录/注册/忘记密码三页签、登录页验证码加载区（t-captcha 仅 `mode !== 'login'` 渲染）、「完成行为验证并发送验证码」文案（改为「获取短信验证码」+ 辅助说明「下一步将完成行为验证」）。
- 注册页（已按 2026-08-13 策略隐藏，`wx:if="{{false}}"`）：顶部「返回登录」（80rpx 点击区）+ 标题「注册探店员账号」+ 说明「提交后需等待管理员审核」+ 用户名/手机号/密码/确认密码 + 行为验证状态区。
- 验证码不可用终态：浅灰状态区「行为验证暂不可用」+ 说明 + 「重新加载 / 返回登录」按钮；不永久显示加载中（`captchaUnavailable` 终态）。
- 忘记密码页（已按 2026-08-13 策略隐藏，`wx:if="{{false}}"`）：标题「重置登录密码」+ 说明「验证绑定手机号后可以设置新密码」，只显示手机号字段，不复用注册字段。
- 短信验证码页：标题「输入短信验证码」+ 说明「验证码已发送至 138\*\*\*\*0000」（`maskPhone` 脱敏）+ 6 位 number 输入框（96rpx、34rpx 字号、letter-spacing）+ 倒计时 + 按流程主按钮（验证并提交申请 / 验证短信验证码 / 验证并重新提交申请）+ 更换手机号 + 重新发送。
- 账号状态页：居中非弹窗三态（申请正在审核中 / 注册申请未通过〔显示原因〕/ 账号已停用），rejected 提供「修改并重新提交」主按钮。
- 颜色契约：#FFFFFF / #26272A / #85888E / #7D8086 / #F25F42 / #DADDE2 / #A1A5AB / #F2A18F / #D93F2B / #ECEDEF；无渐变、无 fixed 主按钮。
- 回归：`npx vitest run tests/unit tests/contract` 115 passed；`test:production-source` passed。

QA 状态（如实记录）：

- 视觉基准：方案 2 文字视觉契约
- 登录状态：**BLOCKED（未运行自动化验证）** — 按用户指示（2026-08-12）不再使用 `prepare-miniapp-fixture` 临时项目副本做 automator 验证；验证对象应以 `apps/miniapp` 根目录（真实项目）为准，待用户在微信开发者工具中人工查看/截图。
- 注册状态：BLOCKED（同上）
- 找回密码状态：BLOCKED（同上）
- 账号状态页：BLOCKED（同上）
- 窄屏适配：BLOCKED（320px 单列规则已实现于 WXSS `@media (max-width: 340px)`，未自动化验证）
- 键盘适配：BLOCKED（`adjust-position`/`cursor-spacing` 已配置，未验证）
- 验证码不可用状态：BLOCKED（终态 UI 已实现，未自动化验证）
- 本次截图路径：无（未运行截图）
- 未验证的真机和外部服务边界：真实腾讯验证码、真实短信、Android/iPhone 真机（与既有 blocker 一致）

final result: BLOCKED — 本地自动化 12/12（含 87 单元/契约、32+34 后端〔真实 PG17 + 真实 PaddleOCR〕、13 Admin E2E、原生 30 状态 + 小票 OCR、真实 API 小程序流程 20/20）全部通过；真实云供应商（CAPTCHA/SMS/COS/地图）、staging P1 容量、微信插件授权、Android/iOS 真机验收需要用户提供外部条件后继续。认证页面方案 2 重构实现完成（2026-08-12），automator 视觉验证按用户指示未运行。
