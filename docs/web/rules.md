# H5 移植业务规则册（探员端）

> 用途：小程序探员端（`apps/miniapp/miniprogram/`）移植为 H5（`apps/web/`）前，把代码中体现的全部业务规则整理为编号规则册。后续阶段将为**每条规则**写至少 1 条 vitest 测试（测试名带规则编号）。
>
> 约定：
> - 路径均从仓库根 `/Users/michaelzhu/Documents/点评小程序/` 起算；小程序侧来源缩写为 `apps/miniapp/miniprogram/` 下相对路径。
> - 「后端佐证」指 `apps/api/src/` 中的对应实现，仅作行为佐证；每条规则主来源必须是小程序侧代码。
> - 「规则陈述」均为可断言行为：给定输入/状态 → 可观察的行为/输出。
> - 小程序 `wx.*` API 在 H5 中对应替换（wx.request→fetch、wx.setStorageSync→localStorage 等），规则只约束行为语义，不约束平台 API 名。

## 目录

| 编号 | 名称 | 摘要 |
|---|---|---|
| R0 | 零域名约束 | src 与构建产物零域名字面量、零构建期 API 地址变量；API 一律同源相对路径（预签名直传 URL 仅作运行时数据） |
| R01 | 会话本地存储 | 会话持久化在 `junde:session`，未登录读取返回 null |
| R02 | 导航守卫 | 非 approved_active+accessToken 一律踢回登录页 |
| R03 | 冷启动会话探测 | 已登录打开登录页只探测一次，成功进首页 |
| R04 | Bearer 头注入 | 有 accessToken 才注入 Authorization |
| R05 | 401 统一登出 | 401 清会话+草稿索引+任务缓存并跳登录 |
| R06 | 登录成功流转 | 登录成功存会话、清任务缓存，按状态分流 |
| R07 | 登录后账号状态展示 | pending/rejected/停用分别展示对应文案 |
| R08 | 退出登录 | 确认弹窗、防重复、接口失败仍跳登录 |
| R09 | 任务列表短时缓存 | 15 秒、按 userId 隔离、force 跳过 |
| R10 | 任务缓存失效时机 | 登录/退出/401 三处清空 |
| R11 | 请求并发去重 | 同 dedupeKey 并发复用同一 Promise |
| R12 | 公共配置拉取与重试 | client-config 失败进明确终态可重试 |
| R13 | 自助服务 UI 门控 | authSelfService 关闭时注册/找回/重交入口隐藏 |
| R14 | 自助服务端点休眠 | 开关关闭时后端对应端点 503（后端佐证） |
| R15 | OCR 入口门控 | receiptOcr 关闭/未到达时 OCR 面板隐藏 |
| R16 | OCR 开关动态同步 | onLoad/onShow 重新求值，配置晚到能补显 |
| R17 | 验证码票据获取守卫 | adapter 缺失或空票据转业务错误 |
| R18 | 验证码宿主异常转业务错误 | 组件缺失/取消/失败/卸载全部 reject |
| R19 | 登录表单本地校验 | 用户名密码缺失不发请求 |
| R20 | 注册表单本地校验 | 手机号、密码长度与一致性 |
| R21 | 短信验证码格式校验 | 必须 6 位数字 |
| R22 | 验证码重发倒计时 | resendAfterSeconds 起倒计时，归零才可重发 |
| R23 | 忘记密码三步流 | 发码→验码换 token→重置回登录 |
| R24 | 被拒注册重交流 | 专用 captcha 场景，提交后回待审核状态页 |
| R25 | 定位采集语义 | gcj02+高精度+accuracy+capturedAt 采集 |
| R26 | 签到判定在服务端 | 客户端不算半径；四态拒绝文案映射 |
| R27 | 开始流程阶段机 | 四阶段顺序固定且活动阶段禁重入 |
| R28 | 不可开始的任务状态 | submitted/overdue/cancelled/overt 不提供开始 |
| R29 | 继续填写入口 | 有 attempt 直接带参进问卷 |
| R30 | 任务详情加载 | 无 id 阻断、慢加载提示、卸载防护 |
| R31 | 问卷已提交终态拦截 | 已提交问卷不可回看，弹 toast 跳任务页 |
| R32 | 问卷路由一致性校验 | attempt/版本与路由不符报错 |
| R33 | 分类动态下发与兜底 | 服务端分类优先，非法路由分类回落 |
| R34 | 本地草稿作用域隔离 | 四元组键+revision 过滤+缺参报错 |
| R35 | 草稿合并规则 | survey-merge 四条分支 |
| R36 | 合并后逐题补发 | 只补发有差异的 scored 答案 |
| R37 | 得分作答乐观更新 | 先改本地后保存，失败回滚旧值 |
| R38 | 得分/不得分切换走问题页 | unscored→scored 也经编辑会话 |
| R39 | 完成度统计口径 | 只统计当前题目集合内的答案 |
| R40 | 进菜品页全题守卫 | 有未完成题拦截并跳到对应分类 |
| R41 | 编辑会话开启 | 以当前答案 revision 为基线建会话 |
| R42 | 编辑会话状态机 | open→confirmed/cancelled/expired，30 分钟 |
| R43 | 图片证据数量上限 | imageMaxCount 下发，缺省 3 |
| R44 | 音频证据上限与时长 | 每题 3 段、时长可配、至少 1 秒 |
| R45 | 证据单文件 10MB | 超限拒绝并提示 |
| R46 | 证据上传三步链 | init→上传→complete，须 staged_ready |
| R47 | 证据失败重试 | 失败项可重试重走链路 |
| R48 | 证据删除分流 | 服务端附件先删远端，本地项直接移除 |
| R49 | 不得分保存必填校验 | 说明必填、必填证据齐、无在传附件 |
| R50 | 编辑会话确认与取消 | 确认提交答案，取消关会话 |
| R51 | 菜品初始行构建 | 无记录时从 dishRequirements 派生 |
| R52 | 本地未同步菜品优先 | synced=false 且有行时以本地为准 |
| R53 | 菜品状态选项推导 | 按 requirementId/required/allowSubstitution 过滤 |
| R54 | 菜品字段校验 | validateDish 八条分支 |
| R55 | 状态切换字段清理 | 切状态时清空不兼容字段 |
| R56 | 金额分转元解析 | 拒绝负数/科学计数/三位小数/超上限 |
| R57 | 行总价推导 | 无显式总价时数量×单价精确推导 |
| R58 | 数量校验 | 1–999 整数 |
| R59 | 额外菜品创建与空白拦截 | secureUuid 生成，空白行阻断返回 |
| R60 | 要求菜品不可删除 | requirementId 行无删除入口 |
| R61 | 小票数量上限与占用计数 | 最多 9 张，占用=已有+未匹配待传 |
| R62 | 小票文件校验 | 仅 jpeg/png、10MB 内 |
| R63 | 小票上传流水线 | 串行 init→上传→complete+ETag，进度钳制 |
| R64 | 小票上传取消语义 | 移除待传项登记取消，放弃回填 |
| R65 | 失败小票换图重传 | canRetry 项删旧传新 |
| R66 | 小票删除选项推导 | 按 dishImpact 给 1 或 2 个选项 |
| R67 | 已提交后小票面板锁定 | 409 终态固定文案且禁重试 |
| R68 | OCR 任务创建与恢复 | 幂等键+恢复元数据持久化 |
| R69 | OCR 轮询退避 | 1s/2s/3s/5s 封顶，离开页面暂停 |
| R70 | OCR 只应用一次与必点保护 | appliedJobIds 去重+必点行校验 |
| R71 | OCR 状态文案映射 | 按任务状态给出固定文案 |
| R72 | 菜品页离开持久化 | onHide/onUnload 存草稿并脱敏 |
| R73 | 菜品页下一步校验顺序 | 五道校验按固定顺序短路 |
| R74 | 菜品页返回答题守卫 | 空白额外菜品阻断 |
| R75 | 菜品保存与 revision 推进 | saving 互斥、先存本地再存服务端 |
| R76 | attempt 提交中终态关闭 | submitting/processing/submitted 关编辑 |
| R77 | 其他记录加载 | 本地优先；failed 给恢复提示 |
| R78 | 编辑重置提交状态 | 失败态再编辑清 token 回 draft |
| R79 | 提交幂等 token | secureUuid 生成、成功前复用 |
| R80 | 提交确认与闪光点必填 | 先存记录、弹确认框再提交 |
| R81 | 提交 processing 轮询 | 2.5 秒轮询同一 token |
| R82 | 提交失败二分 | retryable 保 token，否则终态清 token |
| R83 | failed attempt 双保险恢复 | 重开重置回 draft；提交端视 failed 同 draft |
| R84 | 409 冲突透传 | 后端文案与 requiresNewToken 原样透出 |
| R85 | 提交成功清理 | 清本地草稿，展示成功终态页 |
| R86 | 错误码→文案映射总表 | presentError 全分支按优先级 |
| R87 | 网络错误二分类 | 超时与断网分别文案，均可重试 |
| R88 | 契约校验失败兜底 | 响应不合契约给固定文案 |
| R89 | 页面侧技术信息过滤 | 含敏感词的错误文案换兜底文案 |
| R90 | 日期时间安全展示 | 无效值一律"时间待确认"，不出现 Invalid Date |
| R91 | 预算展示 | 分转元两位小数，0/缺失为"未设置" |
| R92 | 任务状态展示映射 | 五态+未知态兜底 |
| R93 | 任务列表投影与分组 | 展示字段集中生成、按日期稳定分组 |
| R94 | 首页下一任务与草稿进度 | in_progress 优先，草稿进度按 revision 匹配 |
| R95 | 日程页筛选与加载降级 | 本地过滤；有内容错误不阻塞 |
| R96 | 定位说明页 | 定位成功/失败分支与继续入口 |
| R97 | 个人资料页 | 状态映射、账号安全隐藏、忘记密码引导 |
| R98 | 应用结构与验证码插件 | 11 页面、3 Tab、定位声明、插件版本 |
| R99 | 录音/播放单例 | recorder onStop 只注册一次；audio 卸载销毁 |

---

## R0-零域名约束
- **规则陈述**：apps/web 的源码（apps/web/src/**）与构建产物（apps/web/dist/**，如存在）中不得出现任何域名/origin 字面量——包括 https:// 或 http:// 前缀的 API 地址、协议相对地址 //host、以及 VITE_API_BASE_URL 等构建期注入 API 地址的变量名。全部 API 请求一律为同源相对路径（以 /api 开头、不含 scheme/host）；唯一例外：uploadToSignedTarget 的目标为服务端运行时下发的预签名绝对 URL（作为运行时数据传入，不得以字面量出现在源码）。
- **来源**：用户补充要求（2026-10-10，阶段 1/3 主控指令转达）；小程序侧对照：app.js:6,13 的 apiBase 拼接机制仅因小程序宿主无 origin 概念，H5 同源部署不适用。
- **边界与例外**：apps/web/tests/** 不在 R0 扫描范围（测试注释中的公开文档引用 URL、URL 解析辅助基址均非运行时 API 地址）；/api 前缀由同源反向代理承担；未来如引入 vite 等构建配置，配置文件同样受零域名约束。

## R01-会话本地存储
- **规则陈述**：给定登录成功后调用 `saveSession(session)`，则 session 对象被持久化到存储键 `junde:session`，此后 `getSession()` 返回该对象；给定从未登录或已清除，则 `getSession()` 返回 `null`。同时 `getApp().globalData.session` 在应用启动时从该存储恢复（app.js `onLaunch`）。
- **来源**：`apps/miniapp/miniprogram/store/session.js:1-5`；`apps/miniapp/miniprogram/app.js:14`
- **边界与例外**：仅存 accessToken/user 等 JSON；不存验证码 challenge 等临时态。

## R02-导航守卫
- **规则陈述**：给定 `requireApprovedSession()` 被调用，若本地会话满足 `user.status === "approved_active"` 且存在 `accessToken`，则返回该会话且不发生跳转；否则触发 `reLaunch` 到 `/pages/login/index` 并返回 `null`。守卫部署于定位页 onLoad、首页 onShow、日程页 onShow、个人资料页 onShow。
- **来源**：`apps/miniapp/miniprogram/utils/auth.js:3-8`；`apps/miniapp/miniprogram/pages/location/index.js:5`；`apps/miniapp/miniprogram/pages/home/index.js:43`；`apps/miniapp/miniprogram/pages/schedule/index.js:21`；`apps/miniapp/miniprogram/pages/profile/index.js:15`
- **边界与例外**：任务/问卷/菜品/问题/其他记录页不挂此守卫，靠 API 401 兜底（见 R05）；守卫页面在返回 null 时不再继续加载（如 schedule/index.js:21-22 提前 return）。

## R03-冷启动会话探测
- **规则陈述**：给定用户已登录（本地有 accessToken）且打开登录页（无 entryMode 或 entryMode 为 login），页面加载时用 `getMyAssignments()` 探测一次会话有效性：成功且当前仍处于登录表单步则 `switchTab` 进入首页；失败（网络/会话失效）留在登录页且不再自动重试（`sessionProbeDone` 只允许探测一次）。无 accessToken 则不探测。
- **来源**：`apps/miniapp/miniprogram/pages/login/index.js:26-28,57-66`
- **边界与例外**：仅在 `mode` 为空或 `login` 且 `step` 为 `form` 时跳转，避免打断进行中的注册/找回流程。

## R04-Bearer 头注入
- **规则陈述**：给定 `request()` 发起任意 API 调用，若本地会话存在 `accessToken` 则请求头带 `Authorization: Bearer <accessToken>`（叠加在固定 `Accept: application/json`、`Content-Type: application/json` 之上）；无 accessToken 则这三个头不带 Authorization。
- **来源**：`apps/miniapp/miniprogram/services/api.js:34-38`
- **边界与例外**：`uploadToSignedTarget`（直传对象存储）不注入该头，由签名上传参数自行携带凭证。

## R05-401 统一登出
- **规则陈述**：给定任意 API 响应状态码 401（`presentError` 产出 kind=`session`），则依次执行：清空该用户全部本地问卷草稿与草稿索引（`clearSessionAndUserCache`）、清空任务列表缓存、`setTimeout(0)` 后 `reLaunch` 到登录页；随后原请求以 BusinessError(kind=session, "登录已失效，请重新登录") reject。
- **来源**：`apps/miniapp/miniprogram/services/api.js:20,42`；`apps/miniapp/miniprogram/store/session.js:7-14`
- **边界与例外**：草稿清理按 `junde:draft-index` 中登记的当前 userId 全部键逐个移除，并从索引中删除该 userId；其他用户的草稿键不受影响。

## R06-登录成功流转
- **规则陈述**：给定登录接口成功，则 `saveSession` 持久化会话、`globalData.session` 更新、任务列表缓存清空；页面侧：`session.user.status === "approved_active"` 时 `redirectTo` 定位说明页 `/pages/location/index`，否则进入账号状态步（见 R07）。
- **来源**：`apps/miniapp/miniprogram/services/api.js:56`；`apps/miniapp/miniprogram/pages/login/index.js:151-160`
- **边界与例外**：`pending` 标志在整个流程互斥（见 R22 的 pending 包装器说明，login/index.js:237-249）。

## R07-登录后账号状态展示
- **规则陈述**：给定登录返回非 approved_active 的 status，则页面切换到 status 步并展示：`pending_approval` → 标题"申请正在审核中"/描述"审核通过后才能登录并接受任务"；`rejected` → "注册申请未通过"/描述为后端 `rejectedReason` 或兜底"请修改申请资料后重新提交。"；其他 → "账号已停用"/"请联系管理方确认账号状态"。注册提交成功同样落到 `pending_approval` 状态页。
- **来源**：`apps/miniapp/miniprogram/pages/login/index.js:141-148,172-179`；`apps/miniapp/miniprogram/pages/login/index.wxml:9-16`
- **边界与例外**：状态页始终提供"返回登录"按钮（login/index.wxml:15）。

## R08-退出登录
- **规则陈述**：给定用户在个人资料页确认退出，则调用 `logout()`：无论接口成败（finally）都清空会话与任务缓存（api.js `logout` 的 finally 分支），且页面在 finally 中 `reLaunch` 到登录页；接口失败时先 toast 错误文案。退出进行中（`loggingOut=true`）再次点击不重复触发；未确认弹窗不退出。
- **来源**：`apps/miniapp/miniprogram/pages/profile/index.js:38-57`；`apps/miniapp/miniprogram/services/api.js:57`
- **边界与例外**：退出弹窗文案"退出后需要重新输入账号和密码。"，按钮"退出/取消"。

## R09-任务列表短时缓存
- **规则陈述**：给定任务列表缓存模块（TTL 默认 15000ms），则：`get(userId)` 在同 userId 条目存在且未过期时返回 `{items}`；`force=true` 或 userId 为空返回 null；过期条目被删除并返回 null。`set(userId, items)` 在 userId 为空时忽略，否则写入 `expiresAt = now + 15000`。`getMyAssignments({force})` 命中缓存时直接返回缓存 items 不发请求；未命中则请求成功后写缓存。
- **来源**：`apps/miniapp/miniprogram/store/assignments-cache.js:5-19`；`apps/miniapp/miniprogram/services/api.js:64-72`
- **边界与例外**：force 只跳过读取，响应仍会回写缓存。

## R10-任务缓存失效时机
- **规则陈述**：任务列表缓存恰好在三处被清空：登录成功（api.js `login`）、退出登录（api.js `logout` finally）、任意请求返回 401 清会话时——三处均调用 `assignmentCache.clear()` 清掉全部用户的条目。
- **来源**：`apps/miniapp/miniprogram/services/api.js:42,56,57`；`apps/miniapp/miniprogram/store/assignments-cache.js:18`
- **边界与例外**：无 TTL 外的被动失效；跨账号数据靠登录/退出清空防串号。

## R11-请求并发去重
- **规则陈述**：给定 `request()` 以 `dedupeKey`（缺省 `${method}:${url}`）为键维护 pending Map：相同键的并发调用返回同一个 Promise，不重复发请求；Promise 结束（成功或失败）后键被删除，后续调用重新发请求。请求超时上限 12 秒。check-in、start、保存答案、保存菜品、其他记录、提交、小票 init/complete/delete、OCR create/get/apply 等变更型端点都显式带含业务 id 的 dedupeKey。
- **来源**：`apps/miniapp/miniprogram/services/api.js:5-6,30-32,51-53,74-95`
- **边界与例外**：GET 类列表请求按默认键去重；上传直传不走该通道。

## R12-公共配置拉取与重试
- **规则陈述**：给定应用启动，`loadPublicConfig()` 以 GET `clientConfig`（超时 5 秒）拉取：仅当状态码 200 且响应为对象时写入 `globalData.publicConfig`，否则置 null 并 resolve(null)；无 apiBase 时直接 resolve(null)。登录页发现 `captchaAppId` 缺失时自动重拉一次：拉到 captchaAppId 则清除 `captchaUnavailable`，否则进入"行为验证暂不可用"明确终态（含"重新加载"按钮），不得停留于永久加载态。
- **来源**：`apps/miniapp/miniprogram/app.js:21-42`；`apps/miniapp/miniprogram/pages/login/index.js:23,67-74`；`apps/miniapp/miniprogram/pages/login/index.wxml:106-115`
- **边界与例外**：`AUTH_SELF_SERVICE=disabled` 时 captchaAppId 允许为 null 而配置整体仍有效（只校验响应是对象，app.js:22-23）。

## R13-自助服务 UI 门控
- **规则陈述**：给定 `publicConfig.features.authSelfService` 为 falsy（disabled 或配置未到达），则登录页不渲染"忘记密码"与"注册探店员账号"入口、不渲染注册/找回/重交表单，且被拒状态页只显示"资料需修改，请联系管理员重新开放提交。"而无"修改并重新提交"按钮；为 truthy 时以上入口与表单全部可见。开关求值为 `Boolean(features.authSelfService)`。
- **来源**：`apps/miniapp/miniprogram/pages/login/index.js:54-56`；`apps/miniapp/miniprogram/pages/login/index.wxml:13-14,48-57`
- **边界与例外**：JS 侧注册/找回/重交处理函数与 API 封装始终保留，仅 UI 不可达（login/index.wxml:48-49 注释）。

## R14-自助服务端点休眠（后端佐证）
- **规则陈述**：给定 `AUTH_SELF_SERVICE=disabled`（`features.authSelfService=false`），客户端不提供任何可触达注册/发码/找回端点的 UI 路径（R13）；后端佐证：该开关关闭时生产配置强制留空短信/验证码供应商变量（config.js:155-166），此时自助端点因服务未配置返回 503 retryable（`AUTH_NOT_CONFIGURED`/`CAPTCHA_NOT_CONFIGURED`/`SMS_NOT_CONFIGURED`）；且 client-config 的 `captchaAppId` 允许为 null 不视为配置不完整。
- **来源**：`apps/miniapp/miniprogram/pages/login/index.wxml:48-49`；`apps/miniapp/miniprogram/app.js:22-23`；后端佐证：`apps/api/src/config.js:155-166,201-214`；`apps/api/src/auth/routes.js:35`；`apps/api/src/auth/providers.js:108,151`；`apps/api/src/app.js:80-87`
- **边界与例外**：`enabled` 时一切恢复；开关语义为 `authSelfService = (AUTH_SELF_SERVICE === "enabled")`。

## R15-OCR 入口门控
- **规则陈述**：给定 `publicConfig.features.receiptOcr` 为 falsy（false 或 publicConfig 未到达），则菜品页"小票菜品识别"面板整体不渲染（`ocrEnabled=false`），小票上传/删除/手工填菜流程完全不受影响；为 truthy 时面板渲染。开启判定为 `Boolean(features.receiptOcr)`。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:30-36`；`apps/miniapp/miniprogram/pages/dishes/index.wxml:45-50`
- **边界与例外**：面板内"识别并带入菜品"按钮还需 `readyCount > 0` 才可用（wxml:48），与开关无关。

## R16-OCR 开关动态同步
- **规则陈述**：给定 publicConfig 是启动后异步到达的，则菜品页在 `onLoad` 与每次 `onShow` 都重新求值 `syncOcrEntry()`，且仅当 `ocrEnabled` 值变化时才 setData——配置晚到时进入页面能补显面板，配置中途关闭能隐藏。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:33-36,40,396`
- **边界与例外**：不监听全局事件，依赖页面生命周期钩子。

## R17-验证码票据获取守卫
- **规则陈述**：给定 `obtainCaptchaTicket(scene)` 被调用（场景取值 `register`/`password_reset`/`registration_resubmit`），若全局 captchaAdapter 非函数则抛 BusinessError(kind=captcha, "行为验证服务暂时不可用，请稍后重试")；若 adapter 返回的 ticket 为空/非字符串，抛 BusinessError(kind=captcha, "行为验证未完成，请重试")；成功时返回 `{ ticket, randstr: ticket.randstr || "" }`（randstr 允许为空串）。
- **来源**：`apps/miniapp/miniprogram/services/captcha.js:3-13`；场景取值：`apps/miniapp/miniprogram/pages/login/index.js:165,183,211`
- **边界与例外**：客户端绝不自造票据，只透传插件产出（app.js:15-16 注释、captcha-host.js:1-3）。

## R18-验证码宿主异常转业务错误
- **规则陈述**：给定验证码宿主桥（登录页注册的 `verify` 实现）：插件组件缺失或无 `show` 方法 → reject BusinessError(kind=captcha, "行为验证组件暂未就绪，请稍后重试")；插件 verify 事件 `ret !== 0` 或 ticket 为空 → reject BusinessError(kind=captcha, "验证未通过，请重试")；用户关闭 → reject BusinessError(kind=captcha_cancel, "已取消行为验证，请重试")；插件 error 事件 → reject BusinessError(kind=captcha, "行为验证加载失败，请稍后重试")；页面卸载时未完成的验证 Promise 必须被 reject（captcha_cancel），不得永久 pending。仅 `ret===0` 且 ticket 非空才 resolve `{ticket, randstr}`。
- **来源**：`apps/miniapp/miniprogram/pages/login/index.js:33-52,75-81,87-110`；`apps/miniapp/miniprogram/services/captcha-host.js:12-24`
- **边界与例外**：后端拒绝票据（kind 为 captcha_rejected/sms_invalidated）后置 `captchaNeedsRefresh`，下一次展示前先对组件做受控 refresh；用户主动取消不触发 refresh（login/index.js:43-49,242-244）。

## R19-登录表单本地校验
- **规则陈述**：给定登录提交时用户名 trim 后为空或密码为空，则直接 toast "请完整填写账号信息"，不发任何请求、不进入 pending。
- **来源**：`apps/miniapp/miniprogram/pages/login/index.js:151-153`
- **边界与例外**：密码仅校验非空，长度策略只在注册/重置路径校验。

## R20-注册表单本地校验
- **规则陈述**：给定注册发码提交：手机号不匹配 `/^1\d{10}$/` → toast "请输入正确的手机号"；密码长度 <10 或与确认密码不一致 → toast "密码至少 10 个字符，且两次输入必须一致"；两者任一命中则不发请求。重置密码提交采用相同的密码校验。
- **来源**：`apps/miniapp/miniprogram/pages/login/index.js:161-163,199-200`
- **边界与例外**：wxml 占位文案标注 10–64 字符（上限由服务端校验，客户端只拦下限与一致性）。

## R21-短信验证码格式校验
- **规则陈述**：给定注册确认、找回验码、被拒重交确认任一提交时 smsCode 不匹配 `/^\d{6}$/`，则 toast "请输入 6 位短信验证码"且不发请求。
- **来源**：`apps/miniapp/miniprogram/pages/login/index.js:172-173,191-192,218-219`
- **边界与例外**：输入框 maxlength=6（login/index.wxml:73）。

## R22-验证码重发倒计时
- **规则陈述**：给定发码成功返回 `resendAfterSeconds`（缺省 60），则进入 sms 步并按秒递减倒计时；countdown>0 时"重新发送"点击被忽略；countdown 归零后重发按钮渲染，点击会清空 smsCode/challengeId 回到表单步并重走当前模式提交（即重新做人机验证+发码）。
- **来源**：`apps/miniapp/miniprogram/pages/login/index.js:167-168,185-186,213-214,235-236`；`apps/miniapp/miniprogram/pages/login/index.wxml:104,118`
- **边界与例外**：所有登录页提交都经 `pending()` 包装器互斥（进行中再次触发直接返回），并把 kind 为 captcha_rejected/sms_invalidated 的错误登记 refresh、把 sms_invalidated 额外重置回表单步（login/index.js:237-249）。

## R23-忘记密码三步流
- **规则陈述**：给定忘记密码流程：发码步校验手机号后以 `password_reset` 场景取票据发码，成功进入 sms 步（掩码手机号+倒计时）并提示"若该手机号已绑定账号，将发送验证码"；验码步以 `{phoneChallengeId, smsCode}` 换取 `resetToken` 进入 password 步；重置步校验密码后以 `{resetToken, password, confirmPassword}` 完成，成功回到登录表单、清空密码字段并提示"密码已重置，请重新登录"。
- **来源**：`apps/miniapp/miniprogram/pages/login/index.js:180-207`
- **边界与例外**：入口有二：登录页"忘记密码"按钮与个人资料页"账号安全"弹窗确认后 `reLaunch /pages/login/index?mode=forgot`（profile/index.js:26-34）。

## R24-被拒注册重交流
- **规则陈述**：给定被拒用户点击"修改并重新提交"（仅 `rejected && selfServiceEnabled` 时渲染），则进入 resubmit 模式表单（手机号等字段清空）；发码以 `registration_resubmit` 场景取票据、复用注册发码端点；提交以 `{phoneChallengeId, smsCode}` 调用重交端点，成功回到 mode=login + status 步并显示 pending_approval 文案。
- **来源**：`apps/miniapp/miniprogram/pages/login/index.js:208-226`；`apps/miniapp/miniprogram/pages/login/index.wxml:13`
- **边界与例外**：mode 支持从 URL 带入，白名单 `["login","register","forgot","resubmit"]`，非法值忽略（login/index.js:17-19）。

## R25-定位采集语义
- **规则陈述**：给定需要采集位置（定位说明页"允许获取位置"或任务开始），客户端调用定位 API 固定参数 `type: "gcj02"` 且 `isHighAccuracy: true`（任务开始另带 `highAccuracyExpireTime: 5000`）；任务开始时上送的打卡样本固定为 `{ latitude, longitude, accuracy, capturedAt: <ISO 时间> }`，客户端不计算与门店的距离、不做任何半径判断。
- **来源**：`apps/miniapp/miniprogram/pages/location/index.js:8-11`；`apps/miniapp/miniprogram/pages/task/index.js:80-86`
- **边界与例外**：定位说明页成功仅置 `globalData.locationStatus = "ready"`，不缓存坐标复用于打卡——开始任务时重新调用定位采集（`apps/miniapp/miniprogram/pages/task/index.js:80-86`）。

## R26-签到判定在服务端
- **规则陈述**：给定 check-in 响应 `result`，页面按固定映射展示：`accepted`→"现场位置已通过"；`outside_radius`→"当前距离门店较远，请到店后重试"；`stale`→"定位结果已过期，请重新定位"；`low_accuracy`→"定位精度不足，请移动到较开阔位置后重试"；`rejected`→"当前位置未通过，请重新定位"；其他→"暂时无法确认位置，请稍后重试"。非 accepted 一律进入 failed 阶段，不继续 startAssignment。后端佐证：半径=门店 gcj02 坐标 haversine 距离 vs `radius + min(accuracy, allowanceMax)`，样本过期（>60s）/未来（<-5s）/精度超上限/超半径分别判 stale/rejected/low_accuracy/outside_radius。
- **来源**：`apps/miniapp/miniprogram/pages/task/index.js:12-20,87-91`；后端佐证：`apps/api/src/location.js:11-23`；`apps/api/src/batch2/routes.js:968-973`
- **边界与例外**：accepted 才推进到 starting 阶段。

## R27-开始流程阶段机
- **规则陈述**：给定任务开始动作，阶段严格按 `locating → checking_in → starting → navigating` 推进，每阶段有唯一活动请求；当 `phase` 属于四活动阶段或 `navigating=true` 时再次触发开始被忽略；任意阶段失败进入 `failed` 并展示对应文案，failed 态可重新触发（按钮文案变"重新尝试开始"）。定位 API 失败进入 failed、弹"需要位置权限"确认框，确认后打开系统设置。成功终点为 `redirectTo` 问卷页（携带 assignmentId/attemptId/questionnaireVersionId/revision）。
- **来源**：`apps/miniapp/miniprogram/pages/task/index.js:4-10,73-79,95-109`；`apps/miniapp/miniprogram/pages/task/index.wxml:82-86`
- **边界与例外**：页面卸载后（`unloaded` 标志）异步回调不再 setData（task/index.js:29-39,83,94）。

## R28-不可开始的任务状态
- **规则陈述**：给定任务 `status` 为 `submitted`/`overdue`/`cancelled`，开始动作直接返回（不发起定位/打卡）；详情页相应渲染：submitted 显示"任务已提交"只读块（含提交时间与"提交后不能回看"说明）；cancelled 显示"任务已取消"+管理员取消原因（无原因给兜底文案）；overdue 显示"任务已逾期"警告块。`taskType === "overt"` 时渲染"明察任务暂未启用，当前不能开始。"，即使状态可执行。
- **来源**：`apps/miniapp/miniprogram/pages/task/index.js:78`；`apps/miniapp/miniprogram/pages/task/index.wxml:55-79`
- **边界与例外**：三者优先级 submitted > cancelled > overdue > overt（wxml elif 顺序）。

## R29-继续填写入口
- **规则陈述**：给定任务存在 `attempt.id`，详情页渲染"继续填写"按钮，点击直接 `redirectTo` 问卷页并携带 attempt 的 questionnaireVersionId 与 revision，跳过打卡/开始流程；无 attempt 或跳转进行中（navigating）时点击无效。
- **来源**：`apps/miniapp/miniprogram/pages/task/index.js:67-72,109`；`apps/miniapp/miniprogram/pages/task/index.wxml:84`
- **边界与例外**：继续填写不校验任务状态字段（由问卷/菜品页的终态拦截兜底，见 R31/R76）。

## R30-任务详情加载
- **规则陈述**：给定打开任务详情：URL 无 `assignmentId` → 不发请求，直接进入阻断错误"未找到对应任务，请从日程重新进入"；加载超过 800ms 显示"正在读取任务详情…"慢提示；加载失败时若无已加载内容则为阻断错误（含"返回日程"），有内容则非阻塞；页面卸载后加载回调不写状态。详情数据对缺失字段做安全归一（地址空串、时间窗/预算格式化、菜品要求数组兜底）。
- **来源**：`apps/miniapp/miniprogram/pages/task/index.js:28-64`；`apps/miniapp/miniprogram/pages/task/index.wxml:14,18-23`
- **边界与例外**：budget 展示见 R91；submittedAt 展示见 R90。

## R31-问卷已提交终态拦截
- **规则陈述**：给定问卷页加载后 `attempt.status === "submitted"`，则 toast "该任务已提交，不能回看问卷内容"并 `redirectTo` 任务详情页，不渲染问卷内容；菜品页与"其他记录"页对已提交任务有同语义拦截（菜品页 toast "该问卷已关闭编辑"，其他记录页 toast "该任务已提交"）。
- **来源**：`apps/miniapp/miniprogram/pages/survey/index.js:34`；`apps/miniapp/miniprogram/pages/dishes/index.js:54,395`；`apps/miniapp/miniprogram/pages/other/index.js:41-45`
- **边界与例外**：后端佐证：GET 草稿对 submitted attempt 抛 `QUESTIONNAIRE_SUBMITTED` 409（apps/api/src/batch3/routes.js:105）。

## R32-问卷路由一致性校验
- **规则陈述**：给定问卷页路由缺 `assignmentId`/`attemptId`/`questionnaireVersionId` 任一参数，则不加载并显示错误"未找到问卷，请从任务详情重新进入"；服务端返回的 attempt.id 或 questionnaireVersion.id 与路由不一致时抛错"问卷信息已更新，请从任务详情重新进入"（菜品页/其他记录页同语义）。
- **来源**：`apps/miniapp/miniprogram/pages/survey/index.js:13-15,35`；`apps/miniapp/miniprogram/pages/dishes/index.js:56`；`apps/miniapp/miniprogram/pages/other/index.js:24-27,47-49`
- **边界与例外**：`revision` 路由参数缺省按 0 处理，随后以服务端 revision 为准。

## R33-分类动态下发与兜底
- **规则陈述**：给定服务端返回分类列表非空则原样采用；为空/异常时回退固定三分类（环境卫生/为客服务/产品品质）。路由携带的 `category` 参数要等服务端分类返回后再校验：有效则优先选中；当前选中分类不在有效集合时回落到第一个分类。题目按当前分类过滤展示。
- **来源**：`apps/miniapp/miniprogram/pages/survey/index.js:6-9,16-17,21-29,72-73`
- **边界与例外**：菜品页返回问卷时固定带 `category=product`（dishes/index.js:394）。

## R34-本地草稿作用域隔离
- **规则陈述**：给定本地问卷草稿存储：键为 `junde:survey:<userId>:<assignmentId>:<attemptId>:<questionnaireVersionId>`（各段 encodeURIComponent），任一作用域要素（含 userId）缺失时抛 `DRAFT_SCOPE_MISSING` 而不落盘；`getDraft` 仅当存在且 `revision === meta.revision` 时返回内容，否则返回空草稿形状（answers={}、dishes=[]、highlight=""、suggestion=""、receiptRecovery 空壳、revision 同步）。`saveDraft` 合并 patch 并强制 `synced=false`、记录 `savedAt`；保存时把键登记进 `junde:draft-index` 下当前 userId 的去重集合。`markDraftSynced` 置 synced=true 并推进 revision。`peekDraft` 读取原始值不做 revision 过滤。
- **来源**：`apps/miniapp/miniprogram/store/survey.js:3-40`；`apps/miniapp/miniprogram/store/session.js:16-20`
- **边界与例外**：不同 userId 的草稿互不可见（键含 userId），退出时按索引清除（R05）。

## R35-草稿合并规则
- **规则陈述**：给定 `mergeSurveyAnswers({serverAnswers, serverRevision, rawLocal})`：本地无草稿或 `synced !== false` → 直接采用服务端 answers、无冲突、无补发；本地 `synced=false` 且 `serverRevision === local.revision` → 合并结果为 `{...serverAnswers, ...localAnswers}`（本地同题覆盖服务端，服务端空 {} 不能清掉本地待同步答案），且逐题比对出本地为 scored 且与服务端答案（answer+remark）不同的题号列表作为 `pendingResync`；`serverRevision > local.revision` → 返回 `conflict=true`、采用服务端 answers、不覆盖本地存储；`serverRevision < local.revision`（本地更新）→ 以本地覆盖合并、无冲突。答案相同判定为 answer 与 remark（空串归一）都相等。
- **来源**：`apps/miniapp/miniprogram/store/survey-merge.js:8-26`
- **边界与例外**：冲突时页面展示冲突横幅"问卷内容已在其他位置更新…"+“重新加载”按钮，不静默覆盖本地（survey/index.js:47-52；survey/index.wxml 冲突横幅）。

## R36-合并后逐题补发
- **规则陈述**：给定合并结果 `pendingResync` 非空（同 revision 下本地有未同步的 scored 答案），则按列表顺序逐题调用保存答案接口（`{answer:"scored", revision}`），每次成功后把 revision 推进到服务端返回值并 markDraftSynced，期间显示"正在恢复未保存的答案…"；单题失败保留本地草稿、中断后可下次再补发；全部处理完清空 syncMessage。
- **来源**：`apps/miniapp/miniprogram/pages/survey/index.js:57-68`
- **边界与例外**：补发仅针对 scored 答案（survey-merge.js:14 过滤条件）。

## R37-得分作答乐观更新
- **规则陈述**：给定点击"得分"：本地立即把该题答案置为 `{answer:"scored", remark:"", attachments:[]}` 并显示"正在保存…"，随后调保存接口，成功后 revision 推进并显示"已保存"；失败则恢复到点击前的旧答案（无旧答案则删除该键）、显示"保存失败，请重试"并 toast 错误文案。页面 onShow 且非加载中时重新加载问卷。
- **来源**：`apps/miniapp/miniprogram/pages/survey/index.js:20,81-92`
- **边界与例外**：本地保存先行（saveDraft，synced=false），服务端失败不丢本地作答。

## R38-得分/不得分切换走问题页
- **规则陈述**：给定点击"不得分"进入问题编辑页（target=unscored）；给定当前答案已是 unscored 时点击"得分"，同样进入问题编辑页（target=scored），确认后清除原问题说明和证据、取消不改变原答案（编辑页对 scored 目标展示"改为得分？"确认卡片）。
- **来源**：`apps/miniapp/miniprogram/pages/survey/index.js:81-84,93-94`；`apps/miniapp/miniprogram/pages/issue/index.js:9`；`apps/miniapp/miniprogram/pages/issue/index.wxml`（scored 确认卡片）
- **边界与例外**：scored→unscored 与 unscored→scored 都创建编辑会话（R41）。

## R39-完成度统计口径
- **规则陈述**：给定顶部"已完成 X / Y"计数：X 只统计 id 存在于当前服务端题目集合内的答案（被管理员停用/删除的题的遗留答案不计入）；Y 为当前题目总数；分类切换不改变总数只改变可见题。
- **来源**：`apps/miniapp/miniprogram/pages/survey/index.js:74-77`
- **边界与例外**：unscored/scored 都算已作答（判定见 R40 的 answer 枚举）。

## R40-进菜品页全题守卫（缺号兜底）
- **规则陈述**：给定点击"下一步：菜品与小票"，`firstIncompleteQuestion` 判定：第一道不满足条件的题导致跳转——未作答或 answer 不在 ["scored","unscored"]；unscored 时 remark trim 为空；unscored 且 evidence.imageRequired 时 active 且未标记移除的附件中无 image；同理 audioRequired 无 audio。题号出现缺口（1..maxNumber 中缺号）时返回 `{number: 缺号, category: 第一道题的分类}` 兜底；全部完成返回 undefined。存在未完成题时：问卷页切换到该题分类、toast "请先完成第 N 题"并阻断进入；菜品页加载时二次校验，命中则 toast 并重定向回问卷（category=product）。
- **来源**：`apps/miniapp/miniprogram/utils/business.js:26-44`；`apps/miniapp/miniprogram/pages/survey/index.js:95-97`；`apps/miniapp/miniprogram/pages/dishes/index.js:58-59`
- **边界与例外**：maxNumber 由实际题目最大题号推导，题量不设上限；附件须 `status==="active"` 且非 `pendingRemoval`。

## R41-编辑会话开启
- **规则陈述**：给定进入问题编辑页（路由含四元组+questionId+target），页面拉取问卷后定位题目：题目不存在 → 错误"题目已更新，请刷新问卷后重试"；随后以 `{baseAnswerRevision: 当前答案.revision || 0, targetAnswer: target}` 创建编辑会话，成功后：编辑会话 id 入状态、说明文字初值取 `session.draftIssueRemark ?? 当前答案.remark ?? ""`、附件列表取 `session.activeAttachments || 当前答案.attachments` 并按 image/audio 分组渲染。
- **来源**：`apps/miniapp/miniprogram/pages/issue/index.js:6-19`
- **边界与例外**：路由缺任一必需参数 → 错误"未找到题目，请返回问卷重试"（issue/index.js:7）。后端佐证：baseAnswerRevision 与实际不符抛 `REVISION_CONFLICT` 409（batch3/routes.js:309-310）；同题已有 open 会话抛 `EDIT_SESSION_EXISTS` 409"该题正在编辑中，请先完成或取消当前编辑"（batch3/routes.js:318）。

## R42-编辑会话状态机
- **规则陈述**：编辑会话生命周期为 `open → confirmed | cancelled | expired`：确认/取消分别调 confirm/cancel 端点后置 confirmed/cancelled；客户端无主动过期计时，创建后 30 分钟过期——过期后对该会话的 patch（改说明）、confirm、证据上传/证据删除操作均被后端以 409 `EDIT_SESSION_EXPIRED`"编辑会话已过期，请重新打开"拒绝（页面 toast 该文案，用户取消后重开）；**cancel 端点不做过期拦截**——只检查 `status === "open"`（非 open 以 409 `EDIT_SESSION_CLOSED`"编辑会话已关闭"拒绝，lockedSession 亦不查过期），因此过期的 open 会话仍可被取消并正常置 cancelled。后端佐证：创建新会话时同题已过期的 open 会话被批量置 expired 并丢弃其暂存证据。
- **来源**：`apps/miniapp/miniprogram/pages/issue/index.js:68-73`（confirm/cancel 调用与错误 toast）；后端佐证：`apps/api/src/batch3/routes.js:304-307,310,334,351,391-393,410,444,472,376,278-281`
- **边界与例外**：取消时若无 editSessionId（会话尚未建成功）直接返回上一页不发请求（issue/index.js:73）。

## R43-图片证据数量上限
- **规则陈述**：给定题目 `evidence.imageMaxCount`（服务端按题下发，客户端缺省兜底 3）：可继续添加的张数 = 上限 − 已有图片数；余量 ≤0 时点击添加 toast "每题最多上传 N 张照片"（N 为该题上限）；选择数量取余量。
- **来源**：`apps/miniapp/miniprogram/pages/issue/index.js:21-25`
- **边界与例外**：后端佐证：题目数据缺省 `Number(question.image_max_count ?? 3)`（batch2/routes.js:78）；提交期 SQL 同缺省 `COALESCE(r.image_max_count,3)`（batch3/routes.js:163）。

## R44-音频证据上限与时长
- **规则陈述**：给定音频证据：每题最多 3 段（已有 ≥3 时开始录音 toast "每题最多上传 3 段音频"）；录音时长上限 = `evidence.audioMaxDurationSeconds || 10` 秒（recorder 以该秒数×1000 为 duration 自动截断）；录音结束时长 <1000ms 时拒收并 toast "录音至少需要 1 秒"；有效录音按 `Math.ceil(duration/1000)` 记录秒数、mime 固定 `audio/mpeg`（mp3 格式）。
- **来源**：`apps/miniapp/miniprogram/pages/issue/index.js:27-39,80-84`
- **边界与例外**：后端佐证：题目数据缺省 `Number(question.audio_max_duration_seconds ?? 10)`（batch2/routes.js:79）；提交期 SQL 同缺省 `COALESCE(r.audio_max_duration_seconds,10)`（batch3/routes.js:163）。

## R45-证据单文件 10MB
- **规则陈述**：给定任一问题证据文件（图片/音频）size > 10×1024×1024 字节，则不入队列直接 toast "单个文件不能超过 10MB"，不发起上传。
- **来源**：`apps/miniapp/miniprogram/pages/issue/index.js:40-42`
- **边界与例外**：与小票 10MB 上限数值一致但入口独立（小票见 R62）。

## R46-证据上传三步链
- **规则陈述**：给定一个通过校验的证据文件，链路固定为：`initEvidenceUpload`（携带 clientFileId=secureUuid、type、mimeType（图片按扩展名 png→image/png 否则 image/jpeg；音频 audio/mpeg）、sizeBytes、durationSeconds）→ `uploadToSignedTarget` 直传 → `completeEvidenceUpload`（携带 uploadToken/sizeBytes/durationSeconds）。完成响应 `status !== "staged_ready"` 时按失败处理（"附件尚未确认，请重试"）。列表项状态流转 `uploading（"正在上传"）→ staged_ready（"上传成功"）`；任一步失败该项置 `failed` 且 progressLabel 为错误文案。
- **来源**：`apps/miniapp/miniprogram/pages/issue/index.js:40-52,80-84`；上传直传约束见 `apps/miniapp/miniprogram/services/api.js:97-108`
- **边界与例外**：重试失败附件会生成**新的** clientFileId（issue/index.js:43 `file.clientFileId || secureUuid()`，retryUpload 不带原 id），幂等性由服务端暂存流程保证而非 clientFileId 复用（见 R47）。

## R47-证据失败重试
- **规则陈述**：给定证据项处于 failed 状态，点击"重试"先从列表移除该项，再以原 type/path/size/duration 重走 R46 完整链路（生成新 clientFileId）。
- **来源**：`apps/miniapp/miniprogram/pages/issue/index.js:53`
- **边界与例外**：失败项在 wxml 中有条件渲染重试按钮（issue/index.wxml 图片/音频列表）。

## R48-证据删除分流
- **规则陈述**：给定删除证据：id 以 `local-` 开头（未完成 init 的本地项）→ 仅本地移除；否则先调 `removeEvidence`（DELETE 服务端附件），服务端删除失败时 toast 错误文案且本地不移除，成功后本地移除。
- **来源**：`apps/miniapp/miniprogram/pages/issue/index.js:54`
- **边界与例外**：判定键为 id 前缀而非 status 字段。

## R49-不得分保存必填校验
- **规则陈述**：给定 target=unscored 的保存：说明 trim 为空 → "请填写问题说明"；`evidence.imageRequired` 且无任一图片处于 active/staged_ready → "请先上传成功的问题照片"；`evidence.audioRequired` 且无任一音频处于 active/staged_ready → "请先上传成功的问题音频"；存在 uploading 状态附件 → "请等待附件上传完成"。任一命中则不保存。target=scored 时以上校验全部跳过。
- **来源**：`apps/miniapp/miniprogram/pages/issue/index.js:58-64`；问卷侧同语义：`apps/miniapp/miniprogram/utils/business.js:34-42`
- **边界与例外**：active（历史已存）与 staged_ready（本次暂存）都算合格证据。

## R50-编辑会话确认与取消
- **规则陈述**：给定保存：先 `updateEditSession` 把 `draftIssueRemark` 写入会话（unscored 存 trim 后说明，scored 存空串），再 `confirmIssue` 提交 `{answer: target, revision}`，成功后返回问卷页；失败 toast 错误文案且停留在编辑页。给定取消：有会话 id 则调 cancel 端点后返回，无会话 id 直接返回；取消失败 toast 错误文案且不返回。
- **来源**：`apps/miniapp/miniprogram/pages/issue/index.js:58-73`
- **边界与例外**：后端佐证：confirm 后会话置 confirmed、cancel 置 cancelled（batch3/routes.js:376,393）。

## R51-菜品初始行构建
- **规则陈述**：给定加载菜品页：服务端 `dishes` 数组非空则原样采用；为空时从 `dishRequirements` 派生初始行：id 取 `recordId || secureUuid()`、requirementId 关联、actualName 初值为要求菜名、数量取要求数量或 1、状态 ordered、required/allowSubstitution 取布尔化要求值。行数据与要求做富化匹配（plannedName/quantity/required/allowSubstitution/instruction 缺失时以要求补齐）。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:63-65,401-409`
- **边界与例外**：加载即无 dishes 时 `dirty=true`（line 70），确保首访也落本地草稿。

## R52-本地未同步菜品优先
- **规则陈述**：给定本地草稿 `synced === false` 且 `dishes` 非空，则页面以本地草稿菜品渲染（不采用服务端 dishes）；否则以服务端为准并把服务端 dishes 写入本地草稿、markDraftSynced。待传小票恢复列表取自本地 `receiptRecovery.pendingReceipts`（仅保留含 localPath 的项）。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:61-71`
- **边界与例外**：`dirty = useLocal || 服务端无 dishes`（line 70）。

## R53-菜品状态选项推导
- **规则陈述**：给定菜品行渲染状态选择器：有 `requirementId` 的行可选 ordered/substituted/unavailable/skipped——`required=true` 时剔除 skipped、`allowSubstitution=false` 时剔除 substituted；无 `requirementId`（额外菜品）只能选 extra。当前状态不在选项集内时下标按 0 兜底。额外菜品行固定标签"额外菜品"，要求行按 required 显示"必点"/"建议"。要求行的状态选择器可用，额外行禁用。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:410-419`；`apps/miniapp/miniprogram/pages/dishes/index.wxml:62`
- **边界与例外**：状态选项随行数据动态重算（projectDish 每次渲染执行）。

## R54-菜品字段校验（validateDish 全分支）
- **规则陈述**：给定 `validateDish(dish)` 返回首个命中错误、全通过返回空串，按序：① required 且 status=skipped → "必点菜品不能选择未点"；② status=ordered 且 substitutionReason/unavailableReason 任一非空（trim）→ "已点菜品不能保留替代或售罄原因"；③ status=substituted 且 !allowSubstitution → "该菜品不允许替代"；④ substituted 且 actualName 或 substitutionReason trim 为空 → "请填写替代菜名和替代原因"；⑤ unavailable 且 actualName/evaluation 任一非空或 fullySatisfied 为真或 unavailableReason 为空 → "售罄时请清空实际菜名和评价，并填写售罄原因"；⑥ skipped 且 actualName/evaluation 非空或 fullySatisfied → "未点菜品不填写实际菜名和评价"；⑦ extra 且有 requirementId → "额外菜品状态不正确"；⑧ ordered/substituted/extra 且 actualName trim 空 → "请填写实际菜名"；⑨ ordered/substituted/extra 且未选 fullySatisfied 且 evaluation trim 空 → "请填写评价或选择全部满意"。
- **来源**：`apps/miniapp/miniprogram/utils/business.js:12-24`
- **边界与例外**：校验在"下一步"时统一执行（R73），行内错误即时标记（showError）。

## R55-状态切换字段清理
- **规则陈述**：给定切换菜品状态：目标 ordered → actualName 空时回填 plannedName、清空 substitutionReason 与 unavailableReason；目标 substituted → 仅清 unavailableReason；目标 unavailable/skipped → 清空 actualName/substitutionReason/evaluation 且 fullySatisfied 置 false；目标 skipped → 另清 unavailableReason。任何切换都置 manuallyModified（OCR 行亦然）。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:146-157`
- **边界与例外**：切换不清 evaluation 除非进入 unavailable/skipped。

## R56-金额分转元解析
- **规则陈述**：给定 `parseYuanToCents(raw)`：空串/纯空白 → 返回 null（允许清空）；不匹配 `^(0|[1-9]\d{0,6})(\.\d{1,2})?$`（即含负号、科学计数、NaN/Infinity、三位以上小数、整数位超 7 位等）→ 抛"请输入正确的金额，最多保留两位小数"；解析出的分值非安全整数或 >999999999 → 抛"金额超出可填写范围"；合法值精确返回整数分（如 "12.34"→1234，"0.1"→10）。反向 `formatCentsToYuan(cents)`：null/undefined → 空串；非安全整数/负数/超上限 → 抛"金额数据暂时无法使用"；否则输出两位小数字符串。
- **来源**：`apps/miniapp/miniprogram/features/receipt-ocr.js:1-3,26-40`；输入接点：`apps/miniapp/miniprogram/pages/dishes/index.js:112-124`
- **边界与例外**：失焦时才解析归一，输入过程不报错（moneyInput 仅清错误态，dishes/index.js:104-110）。

## R57-行总价推导
- **规则陈述**：给定 `deriveLineTotal(quantity, unitPriceCents, explicitLineTotalCents)`：显式行总价非 null/undefined 时直接采用且 `priceDerived=false`；数量非正整数或单价非整数 → lineTotal 为 null 且 priceDerived=false；否则 lineTotal=数量×单价（整数精确乘法），溢出（非安全整数或超 999999999 分）抛"金额超出可填写范围"。页面侧：修改单价时仅当行总价为空或原为推导值（priceDerived）才重算行总价；用户显式修改行总价后 `priceDerived=false` 不再被单价联动。
- **来源**：`apps/miniapp/miniprogram/features/receipt-ocr.js:72-78`；`apps/miniapp/miniprogram/pages/dishes/index.js:119-121`
- **边界与例外**："系统推算"标签仅在 priceDerived=true 时展示（dishes/index.wxml:72）。

## R58-数量校验
- **规则陈述**：给定数量失焦：值非整数、≤0 或 >999 时该行显示"请输入 1 到 999 的整数数量"且不更新数量；合法时更新数量、同步 quantityInput 字符串，并在 priceDerived 时重算行总价。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:133-142`
- **边界与例外**：输入过程不校验（quantityInput 仅清错误并登记修改）。

## R59-额外菜品创建与空白拦截
- **规则陈述**：给定点击"添加其他菜品"：以 `secureUuid()` 生成行 id（生成失败 toast "当前环境不支持安全创建记录，请升级微信"）、新行为 status=extra 的空行、置脏、滚动聚焦到新行；给定返回问卷（back）时存在空白额外菜品（extra 且实际菜名/评价/替代原因/售罄原因全空且未选全部满意，`isBlankExtraDish`），则阻断保存并对该行显示"请补全这道额外菜品，或点击删除"。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:170-177,354-358`；`apps/miniapp/miniprogram/utils/business.js:46-53`
- **边界与例外**：secureUuid 优先 `wx.getRandomValues`，回退 Web Crypto，两者皆无抛 `SECURE_RANDOM_UNAVAILABLE`（utils/business.js:1-10）。

## R60-要求菜品不可删除
- **规则陈述**：给定菜品行含 `requirementId`（来自任务菜品要求）：删除动作直接忽略，且 wxml 不渲染删除按钮；仅额外菜品（无 requirementId）可删，删除需确认弹窗（OCR 来源行文案"菜品将从最终填写记录中删除，小票原始识别结果仍由系统保留。"，手工行文案"已填写的菜名和评价会一起删除。"）。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:179-187`；`apps/miniapp/miniprogram/pages/dishes/index.wxml:95`
- **边界与例外**：小票删除的"菜品连带处理"是另一条链路（R66），不受此限制。

## R61-小票数量上限与占用计数
- **规则陈述**：小票上限固定 9 张（本地常量，非 client-config 下发）。占用数 = 服务端小票条数 + 待传项中「无 attachmentId 或 attachmentId 不在服务端集合」的数量；ready 数 = status 为 ready 且 origin 非 local 的条数。选择小票时 `可选张数 = 9 − 占用`；校验"占用+新选 >9" → toast "最多只能上传 9 张消费小票"；添加入口仅当占用 <9 时渲染。页面标题区固定提示"最多 9 张图片，每张不超过 10MB"。
- **来源**：`apps/miniapp/miniprogram/features/receipt-ocr.js:1,6-13,15-17`；`apps/miniapp/miniprogram/pages/dishes/index.js:189-197,392`；`apps/miniapp/miniprogram/pages/dishes/index.wxml:16,42`
- **边界与例外**：client-config 仅下发 `captchaAppId/tencentMapKey/features`，不含小票上限（apps/miniapp/miniprogram/services/contracts.generated.js:85-87 + app.js:31-33）。后端佐证：≥9 拒绝 `RECEIPT_LIMIT_EXCEEDED` 422（batch4/routes.js:116）。

## R62-小票文件校验
- **规则陈述**：给定选择的小票文件逐个校验（`validateReceiptFiles`）：类型判定为 fileType/type ∈ {image, image/jpeg, image/png, jpg, jpeg, png} 或路径以 .jpg/.jpeg/.png 结尾；size 必须为有限正数且 ≤10×1024×1024 字节；任一不满足 → 整批拒绝并 toast "请选择 10MB 以内的图片"。选择后用图片信息探测补全类型：探测为 png 或路径 .png 结尾 → 声明 mime `image/png`，否则一律 `image/jpeg`；文件名取路径末段，兜底 "receipt.jpg"。
- **来源**：`apps/miniapp/miniprogram/features/receipt-ocr.js:15-24`；`apps/miniapp/miniprogram/pages/dishes/index.js:192-196,428-430`
- **边界与例外**：gif 等其他图片类型被拒（既有测试佐证 tests/unit/receipt-ocr.test.js）。后端佐证：complete 时按声明 mime/大小核验，不一致 `RECEIPT_FILE_INVALID`（batch4/routes.js:142）。

## R63-小票上传流水线
- **规则陈述**：给定单张待传小票，全局 `receiptBusy` 互斥（busy 时其他上传/删除/重选全部忽略），链路固定：置 uploading（进度 1%，"准备上传"）→ `initializeReceiptUpload`（携带 clientFileId/fileName/mimeType/sizeBytes 与 revision）成功后回填 attachmentId 与 uploadTarget、推进 revision、合并服务端附件 → `uploadToSignedTarget` 直传（进度回调钳制 0–100，文案"正在上传 N%"）→ 置 confirming（进度 100%，"正在确认上传"）→ `completeReceiptUpload`（携带 etag）成功后移除待传项、合并最终附件状态。任一步失败该项置 failed 并显示兜底错误文案。响应契约校验：`assertReceiptUploadInit` 要求 attachmentId+uploadTarget；`assertReceiptList/assertReceiptMutation` 要求非负整数 revision。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:202-233`；`apps/miniapp/miniprogram/services/api.js:88-89,97-108`；`apps/miniapp/miniprogram/services/contracts.generated.js:122-124`
- **边界与例外**：直传环节（`uploadToSignedTarget`）的 upload kind 错误逐码：入参校验失败（method 非 POST、url/fileFieldName/formData 缺失、expiresAt 已过期任一）→ kind=upload"上传链接已失效，请重新上传"，唯一不可重试（retryable=false）的 upload 分支（api.js:99）；直传 HTTP 状态非 2xx → kind=upload"暂时无法上传小票，请重试"，retryable=true（api.js:102）；直传网络失败 → kind=upload"暂时无法上传小票，请检查网络后重试"，retryable=true（api.js:103）；上传任务创建失败 → kind=upload"暂时无法上传小票，请稍后重试"，retryable=true（api.js:105）。ETag 从直传响应头 `ETag|etag` 捕获，允许为 null（api.js:102）。

## R64-小票上传取消语义
- **规则陈述**：给定用户移除一张待传小票：该 clientFileId 被登记进取消集合并立即从列表移除；在途链路在 init/直传/complete 三个 await 点之后检查取消集合，命中则放弃后续步骤与回填（已删除的小票不复活）。正在 uploading/confirming 的项其移除按钮被禁用（取消登记仅覆盖 init 等待窗口）；对已取消项点"重试"会先解除取消登记再重传。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:211-223,235,237-243`；`apps/miniapp/miniprogram/pages/dishes/index.wxml:39`
- **边界与例外**：底层 `wx.uploadFile` 任务句柄不外露、不调用 abort——取消语义是"放弃结果"而非"中断传输"。
- **H5 适配差异（2026-10 冲突修复）**：两端共用同一后端 init（先于直传建立服务端附件行），H5 待传项移除据此按服务端事实处理：`attachmentId` 已知 → 先以当前 revision 授权软删（DELETE 端点）释放槽位，成功后才清理本地；`attachmentId` 未知但持久化 fileMeta+sha256 有效（init 已提交但响应丢失）→ 以同 clientFileId 幂等重放 init 找回行后再软删；仅真未初始化的纯本地项仅本地移除。删除失败保留待传项置 failed 可重试，仅显式业务码（RECEIPT_NOT_FOUND/RECEIPT_DELETED）按幂等清理。另：H5 失败重试一律重新 init 幂等重放（丢弃已缓存 uploadTarget，服务端将 failed 行复位 uploading 并重签凭据）。

## R65-失败小票换图重传
- **规则陈述**：给定服务端小票项 `status === "failed"` 且 `canRetry` 为真且非 busy：可选一张新图（数量按占用−1 校验），成功后先以 `dishHandling="keep_as_manual"` 删除旧附件（服务端返回的 dishes 若有则采纳），再走 R63 上传新图。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:245-265`
- **边界与例外**：canRetry 为 false 的失败项（如服务端校验失败态）不提供"重新选择"按钮（wxml:30）。

## R66-小票删除选项推导
- **规则陈述**：给定删除服务端小票（须 `canDelete` 且非 busy）：`receiptDeletionOptions` 推导——`dishImpact === "none"` 或 `appliedDishCount === 0` → 仅 `["keep_as_manual"]`；`dishImpact === "removable_auto_rows"` → `["remove_unmodified_ocr_rows","keep_as_manual"]`（ActionSheet 文案"同时移除未修改的识别菜品"/"保留菜品，转为手工记录"）；其余 → 仅 keep_as_manual。单选项走确认弹窗（有带入菜品时文案"已带入的菜品会保留并转为手工记录。"，否则"删除后需要重新选择图片才能恢复。"）；确认后调删除接口（携带 dishHandling 与 revision），服务端返回的 items/dishes 全量采纳。
- **来源**：`apps/miniapp/miniprogram/features/receipt-ocr.js:85-89`；`apps/miniapp/miniprogram/pages/dishes/index.js:273-294`
- **边界与例外**：OCR 行的移除只删"未修改"的识别行（manuallyModified 行保留转手工）。

## R67-已提交后小票面板锁定
- **规则陈述**：给定加载小票列表时收到 kind=`questionnaire_submitted` 的 409（`QUESTIONNAIRE_SUBMITTED`，文案"任务已提交，小票不可再查看或修改"）：面板显示该固定文案且 `receiptLocked=true`（"重试"按钮不再渲染），不当作普通失败；此后该 attempt 的小票不可再查看、上传或删除。
- **来源**：`apps/miniapp/miniprogram/services/api.js:17`；`apps/miniapp/miniprogram/pages/dishes/index.js:85-88`；`apps/miniapp/miniprogram/pages/dishes/index.wxml:21`
- **边界与例外**：后端佐证：提交后再访问草稿侧小票接口被 `QUESTIONNAIRE_SUBMITTED` 409 拒绝（batch3/routes.js:105,156）。

## R68-OCR 任务创建与恢复
- **规则陈述**：给定点击"识别并带入菜品"（无在跑任务时）：服务端 ready 小票为空 → toast "请先完成消费小票上传"并中止；否则生成一次性 `idempotencyKey=secureUuid()` 创建 OCR 任务，并写入恢复元数据 `{jobId, applyKey: secureUuid(), appliedJobId: null}` 随草稿持久化；任务已是 succeeded/partial 立即应用，queued/processing 进入轮询。给定重进页面且存在恢复 jobId 且任务视图非终态，则自动 `resumeOcr`：拉取任务状态并续走应用或轮询。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:296-320,71,74,396`；去重键佐证 `apps/miniapp/miniprogram/services/api.js:91-93`
- **边界与例外**：create/get/apply 各自带含 attempt/jobId/idempotencyKey 的 dedupeKey，防止并发重复创建/应用。

## R69-OCR 轮询退避
- **规则陈述**：给定轮询等待序列 `nextPollDelay(attempt)`：延迟取 `[1000,2000,3000,5000][min(max(0,attempt),3)]` 毫秒——即 1s、2s、3s 后封顶 5s。每次轮询拉取任务：succeeded/partial → 应用；queued/processing → 以 attempt+1 续排；失败 → 显示"识别进度暂时中断，请点击恢复"。页面 onHide/onUnload 或重新加载时清除定时器暂停轮询，onShow 恢复。
- **来源**：`apps/miniapp/miniprogram/features/receipt-ocr.js:4,42-44`；`apps/miniapp/miniprogram/pages/dishes/index.js:322-334,350-352,396-398`
- **边界与例外**：pageVisible=false 时轮询回调直接返回不发请求（dishes/index.js:325-327）。

## R70-OCR 只应用一次与必点保护
- **规则陈述**：给定应用 OCR 结果：同一 jobId 已应用（`appliedJobId` 记录或正在应用中）时直接跳过不重复应用；应用前校验识别结果必须包含全部管理员要求行（requirementId 集合一致）且各行 plannedName 与现值一致，否则抛"菜品要求已更新，请刷新后重试"且不落任何数据；通过后一次性以识别 dishes 整体替换列表行、登记 appliedJobId、以服务端返回 revision 推进。应用成功与失败都由 `applyOcrDishesOnce` 保证幂等（重复传入同 jobId 返回 `applied:false` 且状态不变）。
- **来源**：`apps/miniapp/miniprogram/features/receipt-ocr.js:55-65`；`apps/miniapp/miniprogram/pages/dishes/index.js:336-347`
- **边界与例外**：编辑 OCR 行置 manuallyModified 并从 reviewFields 移除该字段（features/receipt-ocr.js:67-70）。

## R71-OCR 状态文案映射
- **规则陈述**：给定 `ocrStatusView(job)`：job 为空 → `{label:"尚未识别", tone:"idle", terminal:true}`；queued → "正在排队识别"/working/非终态；processing → "正在识别小票"/working/非终态；succeeded → `已识别 N 道菜`/success/终态；partial → `已带入 N 道菜，请核对标记内容`/review/终态；其他（含 failed）→ "暂时无法识别这张小票，您仍可以手动填写菜品"/failed/终态。failed 时该文案同时进入 ocrError 展示。
- **来源**：`apps/miniapp/miniprogram/features/receipt-ocr.js:46-53`；`apps/miniapp/miniprogram/pages/dishes/index.js:351`
- **边界与例外**：按钮文案在 failed 后变"重新识别"（wxml:48）。

## R72-菜品页离开持久化
- **规则陈述**：给定菜品页 onHide 或 onUnload：停止 OCR 轮询并持久化本地草稿——`persistLocal` 保存当前 dishes（序列化态）与 `receiptRecovery: {pendingReceipts(剔除 uploadTarget 的脱敏副本), jobId, applyKey, appliedJobId}`，且 onUnload 仅在 `dirty || 有待传项 || 有恢复 jobId` 时才写；存储异常静默吞掉（由下一次鉴权请求处理会话丢失）。任何行编辑/状态切换/新增删除都置脏并即时 persistLocal。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:385-387,396-398,426`
- **边界与例外**：折叠状态 foldOpen 是纯视图态，不进入草稿序列化（dishes/index.js:164-168,417 注释与 serialiseDish）。

## R73-菜品页下一步校验顺序
- **规则陈述**：给定点击"下一步：其他记录"，按固定顺序短路校验：① `receiptRequired` 为真且 ready 小票 <1 → 页面级错误"该任务要求上传至少一张消费小票"并滚动到小票区；② 存在 local_selected/uploading/confirming 的待传项 → "请等待小票上传完成，或删除未完成的图片"；③ 存在 reviewFields 含 actualName/quantity 的行 → 该行标错"请核对菜名和数量后再继续"并滚动聚焦；④ 存在 amountError 的行 → 该行标错；⑤ 逐行 `validateDish`（R54），首个不通过 → 全部行置 showError+展开、该行标错并滚动。全部通过才保存并跳转。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:360-370`；`apps/miniapp/miniprogram/features/receipt-ocr.js:80-83`
- **边界与例外**：`receiptRequired` 取自 assignment.receiptRequired 布尔化（dishes/index.js:72）。

## R74-菜品页返回答题守卫
- **规则陈述**：给定点击"上一步：答题"：先做空白额外菜品拦截（R59），通过后走保存流程并以问卷页为目的地：页面栈可返回时 navigateBack，否则 redirectTo 问卷（带 category=product）。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:354-358,394`
- **边界与例外**：saving 期间按钮禁用（wxml:4,101）。

## R75-菜品保存与 revision 推进
- **规则陈述**：给定 `saveAndNavigate`：saving 互斥（进行中再次触发直接返回）；先把序列化 dishes 写本地草稿，再以 `{dishes, revision}` 调保存接口；成功后 revision 推进为服务端值、markDraftSynced、清脏、按目的地导航；失败显示页面级错误+toast（经 R89 过滤）且不清脏。序列化规则：非 active 行 actualName/evaluation 输出空串、fullySatisfied 仅 active 行为真、substituted/unavailable 行仅输出各自原因、sortOrder 按下标+1。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:372-382,420-423`
- **边界与例外**：保存接口 dedupeKey `dishes:<attemptId>`（api.js:86）。

## R76-attempt 提交中终态关闭
- **规则陈述**：给定菜品页加载后草稿 `attempt.status ∈ {submitting, processing, submitted}`，toast "该问卷已关闭编辑"并 redirectTo 任务详情页，不进入编辑；其他记录页同语义（toast 按状态为"该任务已提交"或"问卷正在提交"）。attempt/版本与路由不一致同样阻断（R32）。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:57,395`；`apps/miniapp/miniprogram/pages/other/index.js:50-54`
- **边界与例外**：后端佐证：submit 端点对非 draft/failed 状态抛 `SUBMIT_STATE_INVALID` 409（batch3/routes.js:159）。

## R77-其他记录加载
- **规则陈述**：给定加载其他记录页：任务已提交 → toast+跳任务详情；草稿 attempt 状态为 submitting/processing/submitted → toast+跳任务详情（R76）；`attempt.status === "failed"` → 页面提示"上次提交未完成，请检查内容后重新提交"但仍以 draft 态进入编辑；本地草稿 `synced===false` 时 highlight/suggestion 以本地为准，否则采用服务端 otherRecords 并 markDraftSynced；提交状态固定初始化为 `draft`（重开草稿即重置）。
- **来源**：`apps/miniapp/miniprogram/pages/other/index.js:55-74`
- **边界与例外**：assignmentRevision 记录自 assignment/草稿响应，提交时携带（other/index.js:64,159）。

## R78-编辑重置提交状态
- **规则陈述**：给定提交状态为 `retryable_failed` 或 `terminal_failed` 时用户编辑任一输入：`submitToken` 立即置 null（下次提交生成新 token）、状态回到 `draft`；编辑 highlight 时同时清除该字段错误与页面消息；任何输入置脏并持久化本地。
- **来源**：`apps/miniapp/miniprogram/pages/other/index.js:82-88,215-218`
- **边界与例外**：仅这两个失败态清 token；draft 态编辑不清（本就为空）。

## R79-提交幂等 token
- **规则陈述**：给定提交动作：无 token 时生成 `submitToken = secureUuid()`（生成失败提示"当前环境不支持安全提交，请升级微信后重试"并中止）；提交载荷固定 `{submitToken, assignmentRevision, confirmation: true}`；可重试失败（retryable）后重试**复用同一 token**（dedupeKey `submit:<attemptId>:<token>` 相同）；仅当产生不可重试失败或用户编辑内容（R78）后 token 才被更换。接口层同 token 同请求哈希的重复提交由后端幂等键去重（后端佐证：idempotency_keys 按 actor+scope+key 加锁，succeeded 直接回放响应）。
- **来源**：`apps/miniapp/miniprogram/pages/other/index.js:149-161,178-199`；`apps/miniapp/miniprogram/services/api.js:95`；后端佐证：`apps/api/src/batch3/routes.js:122-137,154-155`
- **边界与例外**：跨内容变更的重复 token 由后端 `IDEMPOTENCY_CONFLICT` 409 拒绝（batch3/routes.js:126）。

## R80-提交确认与闪光点必填
- **规则陈述**：给定点击"提交问卷"（非重试路径）：闪光点 trim 为空 → 字段错误"请填写闪光点"+聚焦+滚动，不提交；通过后先保存其他记录（失败则中止并 toast），再弹确认框"提交后将无法回看或修改本次问卷，请确认所有内容已经完成。"，用户确认才发起提交。
- **来源**：`apps/miniapp/miniprogram/pages/other/index.js:101-123`
- **边界与例外**：重试路径（retryable_failed 且有 token）跳过必填校验与弹窗直接重试（other/index.js:103-106）。

## R81-提交 processing 轮询
- **规则陈述**：给定提交响应 `status === "processing"`：状态置 processing、显示"问卷正在处理，请稍候"，并以 2500ms 定时器用**同一 token** 重发提交查询；再次 processing 继续轮询，终态（成功/失败）停止轮询。锁定态 `locked()` 覆盖 submitting/processing/submitted——期间提交与返回按钮全部禁用。
- **来源**：`apps/miniapp/miniprogram/pages/other/index.js:162-166,191-194,201-204,213`；`apps/miniapp/miniprogram/pages/other/index.wxml:56-73`
- **边界与例外**：后端佐证：租约内重复提交返回 `SUBMIT_PROCESSING` 409 retryable（batch3/routes.js:129）。

## R82-提交失败二分
- **规则陈述**：给定提交抛错：`error.retryable === true`（网络/超时/5xx 等）→ 状态置 `retryable_failed`、消息"<错误文案>，可以重试提交"、**保留 token**、展示"重试提交"按钮；否则 → 状态置 `terminal_failed`、消息为错误文案、**token 置 null**。retryable_failed/processing 态渲染"重试提交"按钮（点击走 R79 复用 token 或 R81 续轮询）。
- **来源**：`apps/miniapp/miniprogram/pages/other/index.js:168-175,195-198`；`apps/miniapp/miniprogram/pages/other/index.wxml:59`
- **边界与例外**：retryable 标志只来自 BusinessError 的 details.retryable（api.js:11）。

## R83-failed attempt 双保险恢复
- **规则陈述**：客户端侧：attempt.status=failed 时打开草稿即重置回 draft 可编辑态（R77），再次提交与 draft 完全同路径（生成新 token）。后端佐证（双保险）：GET 草稿在同事务内把 failed 重置为 draft（清提交租约、revision+1、写审计）；提交端点把 failed 视同 draft 允许重新发起提交。
- **来源**：`apps/miniapp/miniprogram/pages/other/index.js:70-71`；后端佐证：`apps/api/src/batch3/routes.js:101-108,159`
- **边界与例外**：failed 不产生 409，对用户表现为普通可编辑草稿+一条提示。

## R84-409 冲突透传
- **规则陈述**：给定任意请求 409：BusinessError(kind=conflict) 的 message 取后端 `error.message`（缺失时兜底"内容已更新，请刷新后重试"）原样透出，且 `requiresNewToken` 布尔从 `error.requiresNewToken` 原样携带。典型场景 `TASK_OVERDUE`（提交/开始时任务逾期）返回 409+文案"任务已逾期，请等待管理员延期后刷新任务"/"问卷已过最终截止时间…"并 `requiresNewToken:true`；提交页将其归入不可重试分支 → terminal_failed+清 token（R82），用户编辑或重进后自然以新 token 重试。客户端不读 requiresNewToken 做额外分支——清 token 已覆盖其语义。
- **来源**：`apps/miniapp/miniprogram/services/api.js:22-23`；`apps/miniapp/miniprogram/pages/other/index.js:171-174`；后端佐证：`apps/api/src/batch3/routes.js:68,161,236-244`
- **边界与例外**：409 在 presentError 中优先级低于 SMS_*/QUESTIONNAIRE_SUBMITTED/CAPTCHA_* 等码判断（R86）。

## R85-提交成功清理
- **规则陈述**：给定提交成功（含幂等回放）：清除该 attempt 的本地草稿键（`clearDraft`）、清脏、状态置 submitted、展示成功终态页"提交成功"+提交时间+"本次问卷已锁定，不能回看或修改。如需说明，请联系管理员。"+"确定"按钮（跳日程 Tab）；页面卸载不再持久化草稿。
- **来源**：`apps/miniapp/miniprogram/pages/other/index.js:206-211,220-223`；`apps/miniapp/miniprogram/store/survey.js:40`；`apps/miniapp/miniprogram/pages/other/index.wxml:13-19`
- **边界与例外**：submittedAt 缺失时不渲染时间行。

## R86-错误码→文案映射总表（presentError 全分支）
- **规则陈述**：给定非 2xx 响应，`presentError` 按**以下优先级**产出 BusinessError（kind/文案/标志），命中即返回：
  1. `SMS_CODE_INVALIDATED` 或 `SMS_CODE_ATTEMPTS_EXHAUSTED` → kind=sms_invalidated，"验证码已失效，请重新发送并完成人机验证"
  2. `QUESTIONNAIRE_SUBMITTED` → kind=questionnaire_submitted，"任务已提交，小票不可再查看或修改"
  3. `CAPTCHA_EXPIRED` → kind=captcha_rejected，"验证已过期，请重新验证"
  4. `CAPTCHA_REJECTED` 或 `CAPTCHA_CANCELLED` → kind=captcha_rejected，"验证未通过，请重新验证"
  5. 状态码 401 → kind=session，"登录已失效，请重新登录"（触发 R05）
  6. 状态码 403 → kind=forbidden，"你没有权限进行此操作"
  7. 状态码 409 → kind=conflict，文案透传后端 message（兜底"内容已更新，请刷新后重试"），携带 `requiresNewToken`（R84）
  8. 状态码 ≥500 → kind=service，"服务暂时不可用，请稍后重试"，`retryable=true`
  9. `RECEIPT_LIMIT_EXCEEDED` → kind=validation，"最多只能上传 9 张消费小票"
  10. `RECEIPT_FILE_INVALID` → kind=validation，"请选择 10MB 以内的图片"
  11. 兜底 → kind=validation，"操作未完成，请检查填写内容"
  BusinessError 构造：`retryable`/`requiresNewToken` 均由 details 布尔化。另有两处非映射错误：契约校验失败（R88）与网络失败（R87）。
- **来源**：`apps/miniapp/miniprogram/services/api.js:10-12,14-28`
- **边界与例外**：码判断先于状态码判断（如后端把 SMS_CODE_INVALIDATED 以 409/422 返回时仍映射为 sms_invalidated）；除上列 8/409 携带标志外其余分支 retryable=false。

## R87-网络错误二分类
- **规则陈述**：给定 `wx.request` 层失败：errMsg 含 "timeout" → BusinessError(kind=timeout, "请求超时，请检查网络后重试", retryable=true)；其他失败 → BusinessError(kind=network, "暂时无法连接服务，请检查网络后重试", retryable=true)；请求任务创建失败（task 为空）→ BusinessError(kind=network, "暂时无法连接服务，请稍后重试", retryable=true)。
- **来源**：`apps/miniapp/miniprogram/services/api.js:48-50`
- **边界与例外**：统一超时 12 秒（api.js:6）。

## R88-契约校验失败兜底
- **规则陈述**：给定 2xx 响应但 `validate`（各 assertXxx 契约函数）抛错：以 BusinessError(kind=contract, "服务返回的数据暂时无法使用，请稍后重试") reject（retryable=false）。各端点契约：assignment 列表须 items 数组且元素含非空 string id；start/questionnaire 须 attempt.id+非负整数 revision+questionnaireVersion.id；问卷另须 questions 数组与 answers 对象；上传初始化须 attachmentId+uploadTarget 对象；小票初始化另须 attachment.id+revision；小票列表须 items 数组+revision；OCR 任务须 id+string status；OCR 应用须 job+非空 dishes 数组+revision；提交须 string status；编辑会话须 id。
- **来源**：`apps/miniapp/miniprogram/services/api.js:45-46`；`apps/miniapp/miniprogram/services/contracts.generated.js:111-127`
- **边界与例外**：validate 传 falsy 时不校验直接透传（仅 client-config 路径，app.js 自行处理）。

## R89-页面侧技术信息过滤
- **规则陈述**：给定菜品页展示错误文案（safeMessage）：message 为字符串且不匹配 `/\/api\/|http\s*\d|token|revision|stack|provider|request.?id/i` 时原样展示，否则替换为调用方兜底文案（如"暂时无法加载菜品记录，请重试"）——即含 URL/token/revision/堆栈等技术词的后端错误不直接呈现给用户。
- **来源**：`apps/miniapp/miniprogram/pages/dishes/index.js:431`
- **边界与例外**：首页/日程页对无 kind 的异常同样换兜底文案"暂时无法加载任务，请重试"（home/index.js:58-61、schedule/index.js:32-36）。

## R90-日期时间安全展示
- **规则陈述**：给定展示层日期处理：无法解析/缺失的时间一律输出"时间待确认"（不出现 Invalid Date）；日期标题形如"N月N日 周X"；时间区间同天为"HH:MM–HH:MM"、结束缺失为"HH:MM 起"、跨天为"HH:MM 开始"（跨天截止日由 displayDueDate 单独展示）；提交时间形如"N月N日 HH:MM"。时区用设备本地时区。
- **来源**：`apps/miniapp/miniprogram/utils/presentation.js:9-43`
- **边界与例外**：`safeDate` 对空值/NaN 返回 null，是所有格式化函数的统一入口。

## R91-预算展示
- **规则陈述**：给定 `formatBudgetLabel(cents)`：非整数或 ≤0（含缺失）→ "未设置"；否则输出 `¥<元>.<两位分>`（分补零，向下取整元）。
- **来源**：`apps/miniapp/miniprogram/utils/presentation.js:46-49`；接点：`apps/miniapp/miniprogram/pages/task/index.js:54`
- **边界与例外**：金额数据本身来自任务预算上限分值。

## R92-任务状态展示映射
- **规则陈述**：给定 `mapAssignmentStatus(status)`：assigned→待开始/primary/"查看任务"；in_progress→进行中/dark/"继续填写"；overdue→已逾期/warning/"查看详情"；submitted→已提交/neutral/"查看状态"；cancelled→已取消/muted/"查看详情"；未知 status→"状态待确认"/muted/"查看详情" 且 isActionable=true。`taskTypeText`：secret→"暗访"、overt→"明察"、其他→空串。
- **来源**：`apps/miniapp/miniprogram/utils/presentation.js:51-64`
- **边界与例外**：isActionable 仅由状态枚举决定（五态均 true），页面可再按区域收紧（如问卷入口对 submitted/overdue 只读）。

## R93-任务列表投影与分组
- **规则陈述**：给定 `projectAssignmentForDisplay(assignment)`：产出仅展示字段——storeName 缺失→"门店待确认"、name 缺失→"任务待确认"、taskType 空串→"任务"、displayDate/displayTime/displayDueDate（仅跨天）/displaySubmittedAt、statusText/statusTone/actionText、isActionable（assigned/in_progress/overdue/submitted/cancelled 五态为 true）；原始 ISO 字段不直接进入视图层。`groupAssignmentsByDate` 保持服务端顺序按 displayDate 稳定分组，同组内保持原顺序。
- **来源**：`apps/miniapp/miniprogram/utils/presentation.js:66-104`；`apps/miniapp/miniprogram/utils/presentation.js:67`（注释明确 ISO 不得直接进 WXML）
- **边界与例外**：日程页直接消费分组结构渲染（schedule/index.wxml:48-70）。

## R94-首页下一任务与草稿进度
- **规则陈述**：给定首页加载任务列表：候选仅 assigned/in_progress（overdue/submitted/cancelled 不作为"下一项"），排序 in_progress 先于 assigned、同级按 dueAt 升序，取第一项为"下一项任务"；对其计算草稿进度文案——**前置条件为任务同时具备 `hasAttempt`、`attempt`、`questionnaireVersion` 三者，任一缺失进度文案为空串**，且当前 revision 匹配的本地草稿 answers 非空：题目总数 >0 → "已完成 min(已答数, 总数) / 总数 题"，否则 "已答 N 题"；草稿读取失败→空文案。统计卡固定展示 assigned/in_progress/overdue 三个计数。加载失败：业务/网络错误展示其文案，无 kind 异常展示兜底文案（R89 同语义）；已有内容时错误为非阻塞条。
- **来源**：`apps/miniapp/miniprogram/pages/home/index.js:7-9,25-36,44-63`
- **边界与例外**：首次加载才显示骨架，后台刷新不清空页面（home/index.js:45-46）。

## R95-日程页筛选与加载降级
- **规则陈述**：给定日程页：筛选 chips 固定为"全部"+按状态计数大于 0 的五个状态段（待开始/进行中/已逾期/已提交），筛选为纯本地过滤不重新请求；重复点击当前筛选忽略。下拉刷新走 `force:true` 跳过缓存（R09）；加载失败有旧内容→非阻塞错误条，无内容→完整错误态；任务卡跳转进行中（navigatingId 非空）时忽略再次点击。
- **来源**：`apps/miniapp/miniprogram/pages/schedule/index.js:7-12,41-51,58-71`；`apps/miniapp/miniprogram/pages/schedule/index.json`（enablePullDownRefresh）
- **边界与例外**：空态文案区分"当前筛选下没有任务"与"当前没有已分配任务"（wxml:43）。

## R96-定位说明页
- **规则陈述**：给定定位说明页：固定展示用途声明"位置仅用于判断是否到店打卡，不持续记录轨迹。"；点击定位：成功→状态 ready（`globalData.locationStatus="ready"`）、文案"定位可用。开始任务时还会重新获取最新位置。"且仅渲染"查看我的任务"（switchTab 日程）；失败→状态 blocked、文案"未能获取位置，你仍可查看任务说明，但不能开始探店。"并渲染"打开设置"（调系统设置）与"重新定位"。
- **来源**：`apps/miniapp/miniprogram/pages/location/index.js:4-16`；`apps/miniapp/miniprogram/pages/location/index.wxml`
- **边界与例外**：页面 onLoad 挂导航守卫（R02）；页面声明"不启动持续定位/最终范围由系统判定"。

## R97-个人资料页
- **规则陈述**：给定个人资料页 onShow（先过 R02 守卫）：显示 displayName（缺失→"探店员"）与首字符大写头像字（缺失→"探"）；账号状态映射 pending_approval→"申请正在审核中"/warning、approved_active→"已启用"/primary、rejected→"申请未通过"/warning、disabled→"已停用"/muted、未知→"账号状态待确认"/muted。"账号安全"入口被 `wx:if="{{false}}"` 永久隐藏（策略：登录态内不提供改密码）；退出按钮见 R08。
- **来源**：`apps/miniapp/miniprogram/pages/profile/index.js:5-24`；`apps/miniapp/miniprogram/pages/profile/index.wxml:16-22`
- **边界与例外**：openSecurity 逻辑保留但不可达；确认后跳 `login?mode=forgot`（profile/index.js:26-34）。

## R98-应用结构与验证码插件
- **规则陈述**：给定应用配置：注册页面共 11 个（login/location/home/schedule/profile/task/survey/issue/dishes/other/help），Tab 栏 3 个（首页/日程/我的，均挂 R02 守卫）；声明 `scope.userLocation` 用途文案与 `requiredPrivateInfos:["getLocation"]`；验证码插件固定 `captcha@2.1.4`（provider wx1fe8d9a3cb067a75）。菜品/其他记录页用自定义导航（navigationStyle custom），日程页启用下拉刷新，问卷页禁用下拉刷新。API Origin 由构建期生成（runtime-config），开发环境回退 `http://127.0.0.1:3000`。
- **来源**：`apps/miniapp/miniprogram/app.json:2-14,21-60`；`apps/miniapp/miniprogram/app.js:10-13`；`apps/miniapp/miniprogram/runtime-config.generated.js:4`
- **边界与例外**：H5 侧对应物为路由表与 Tab 布局，位置权限改为浏览器 Geolocation 授权（行为语义不变）。

## R99-录音/播放单例
- **规则陈述**：给定问题编辑页音频能力：全局 RecorderManager 是单例，`onStop` 回调只在首次使用时注册一次（避免重复监听导致同一段录音多次上传）；播放用单例 InnerAudioContext，页面卸载时 destroy 置空，不泄漏实例；无 path 且无 previewUrl 的项播放点击无效。
- **来源**：`apps/miniapp/miniprogram/pages/issue/index.js:27-33,55-57`
- **边界与例外**：录音中断/失败路径由 onStop 的时长校验兜底（R44）。

---

## 规则总数

**共 100 条规则（含补充 R0；主体 R01–R99）**，覆盖种子规则 11 项：

| 种子 | 对应规则 |
|---|---|
| 1. authSelfService 门控 | R12-R14 |
| 2. receiptOcr 门控 | R15-R16 |
| 3. 提交幂等 | R79、R81-R82、R11 |
| 4. failed 恢复 | R77-R78、R83 |
| 5. 编辑会话状态机 | R41-R42、R50 |
| 6. 证据上限 | R43-R46、R61-R62 |
| 7. 签到坐标语义 | R25-R26 |
| 8. 小票已提交 409 终态 | R31、R67、R86 |
| 9. Bearer 会话与 401 登出 | R01、R04-R05 |
| 10. 上传队列与取消 | R63-R64 |
| 11. BusinessError 映射 | R86-R89、R17-R18 |
