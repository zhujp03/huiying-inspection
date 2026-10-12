# 规则 ↔ 断言映射表（docs/web/rules.md ↔ apps/web/tests/rules）

> 生成日期：2026-10-10。数据来源：`docs/web/rules.md`（定稿 100 条规则）与三个已验收的规则测试文件 `apps/web/tests/rules/r00-r33.test.js`（34 it）、`r34-r66.test.js`（39 it）、`r67-r99.test.js`（33 it）。映射由只读脚本从两处源文件程序化提取生成（脚本不入库）。

## 列与口径说明

- **it 名**：记录 it 名中冒号后的断言点；冒号前统一为 `R##-规则名`，与第 1、2 列重复，故省略。完整 it 名 = `R##-规则名` + `: ` + 本列内容。
- **断言层级**：一律以 it 内「层级：」注释为权威（三个文件的 106 个 it 均有显式标注），组合层级用 `+` 连接（如 `pure+manifest`）。describe 段仅作组织结构——其中 5 个 it（R36、R43、R44、R45、R63 第 2 it）的 describe 归属与其 it 内层级注释存在二义，一律以 it 内注释为准。R0 的 it 注释为「manifest/源码扫描」，记作 `manifest（源码扫描）`。
- **附加覆盖**：仅当 `pure/*.test.js` 或 `services/*.test.js` 中的**非规则命名**测试也覆盖了该规则语义时标注文件名（括号内为被测函数/分支）。已逐一打开核实；`manifest.test.js` 与 `anti-omission.test.js` 属导出/结构契约测试，不计入本列（其中与 R0 相关的「adapters/http.js 导出 request（零域名口径，R0）」声明见 `manifest.test.js`）。核实不了的留空，不臆测。
- 一条规则多个 it 时逐 it 一行（R34×3、R35×3、R63×3）。

## 映射总表（106 行 = 100 规则 + 6 条多 it 额外行）

| R## | 规则名 | 测试文件（相对 apps/web/tests/） | it 名（冒号后断言点） | 断言层级 | 附加覆盖 |
|---|---|---|---|---|---|
| R0 | 零域名约束 | rules/r00-r33.test.js | src 与构建产物零域名字面量、零构建期 API 地址变量（API 一律同源相对路径） | manifest（源码扫描） | services/uploads-and-config.test.js（预签名绝对 URL 为运行时数据的例外语义） |
| R01 | 会话本地存储 | rules/r00-r33.test.js | saveSession 持久化到 junde:session，未登录/清除后 getSession 返回 null | pure |  |
| R02 | 导航守卫 | rules/r00-r33.test.js | approved_active+accessToken 放行返回会话，否则判定 redirect /login | pure | pure/navigation-guards.test.js |
| R03 | 冷启动会话探测 | rules/r00-r33.test.js | coldStartRoute 已登录分流 /home，未登录留守 /login | pure | pure/navigation-guards.test.js |
| R04 | Bearer 头注入 | rules/r00-r33.test.js | 有 accessToken 注入 Authorization，无则三个 JSON 头之外不带 | service | services/auth.test.js（无会话不携带 authorization 头） |
| R05 | 401 统一登出 | rules/r00-r33.test.js | 任意请求 401 → kind session 固定文案 + 会话清空（getSession null） | service | pure/navigation-guards.test.js、pure/errors.test.js（401→session 分支）、services/auth.test.js、services/drafts.test.js（401 清会话） |
| R06 | 登录成功流转 | rules/r00-r33.test.js | login 成功持久化会话且 getSession 返回登录响应 | service | services/auth.test.js（login 成功后响应写入会话） |
| R07 | 登录后账号状态展示 | rules/r00-r33.test.js | login 页声明为账号状态步承载页 | manifest |  |
| R08 | 退出登录 | rules/r00-r33.test.js | 接口失败（finally 语义）仍清空会话 | service | services/auth.test.js（logout 服务端 500 仍清会话） |
| R09 | 任务列表短时缓存 | rules/r00-r33.test.js | 15s TTL 命中、过期惰性删除、force 跳过读取、按 userId 隔离 | pure | services/assignments.test.js（缓存命中/force 跳过） |
| R10 | 任务缓存失效时机 | rules/r00-r33.test.js | 登录/退出/401 三处之后 getMyAssignments 重新 fetch（mock 计数） | service | services/assignments.test.js |
| R11 | 请求并发去重 | rules/r00-r33.test.js | 同 dedupeKey 并发调用复用同一 Promise，仅一次 fetch | service | services/assignments.test.js（getAssignment 并发去重） |
| R12 | 公共配置拉取与重试 | rules/r00-r33.test.js | 非 200/非对象/网络失败 → null，200 对象原样返回且无 Bearer | service | services/uploads-and-config.test.js（loadPublicConfig 五分支） |
| R13 | 自助服务 UI 门控 | rules/r00-r33.test.js | authSelfService falsy → isSelfServiceEnabled false（入口保守隐藏） | pure+manifest | pure/feature-flags.test.js（isSelfServiceEnabled 表驱动） |
| R14 | 自助服务端点休眠 | rules/r00-r33.test.js | 自助端点 503（服务未配置）→ kind service retryable | service | pure/errors.test.js（≥500→service retryable 分支） |
| R15 | OCR 入口门控 | rules/r00-r33.test.js | receiptOcr falsy → isReceiptOcrEnabled false（OCR 面板保守隐藏） | pure+manifest | pure/feature-flags.test.js（isReceiptOcrEnabled 表驱动） |
| R16 | OCR 开关动态同步 | rules/r00-r33.test.js | 每次调用按传入 publicConfig 重新求值（配置晚到可补显） | pure |  |
| R17 | 验证码票据获取守卫 | rules/r00-r33.test.js | adapter 非函数→captcha 兜底文案；空 ticket→未完成文案；成功→{ticket, randstr} | adapter |  |
| R18 | 验证码宿主异常转业务错误 | rules/r00-r33.test.js | captcha 服务与 login 页声明就绪 | manifest |  |
| R19 | 登录表单本地校验 | rules/r00-r33.test.js | auth.login 服务声明（空账号不发请求为页面编排） | manifest |  |
| R20 | 注册表单本地校验 | rules/r00-r33.test.js | 注册发码与注册服务声明（手机号/密码本地校验为页面编排） | manifest |  |
| R21 | 短信验证码格式校验 | rules/r00-r33.test.js | 三个 sms 确认链服务声明（6 位数字校验为页面编排） | manifest |  |
| R22 | 验证码重发倒计时 | rules/r00-r33.test.js | 两条发码链服务声明（resendAfterSeconds 倒计时为页面编排） | manifest |  |
| R23 | 忘记密码三步流 | rules/r00-r33.test.js | 发码→验码换 token→重置 三端点顺序可达 | service |  |
| R24 | 被拒注册重交流 | rules/r00-r33.test.js | resubmitRegistration 端点 POST /api/auth/registration/resubmit | service |  |
| R25 | 定位采集语义 | rules/r00-r33.test.js | getCurrentLocation 返回 GCJ02 {latitude, longitude, accuracy}，失败 reject | adapter | pure/coordinates.test.js（wgs84→gcj02 转换数学，gcj02 语义底座） |
| R26 | 签到判定在服务端 | rules/r00-r33.test.js | checkIn 发送坐标四字段 body，客户端不做半径判断 | service |  |
| R27 | 开始流程阶段机 | rules/r00-r33.test.js | startAssignment 端点 POST /api/assignments/:id/start | service |  |
| R28 | 不可开始的任务状态 | rules/r00-r33.test.js | startAssignment 409 TASK_OVERDUE → kind conflict + 后端文案与 requiresNewToken 透传 | service | pure/errors.test.js（409→conflict 透传分支） |
| R29 | 继续填写入口 | rules/r00-r33.test.js | task/survey 页声明承载继续填写链路 | manifest |  |
| R30 | 任务详情加载 | rules/r00-r33.test.js | getAssignment 与 getQuestionnaire 端点可达（详情与问卷数据源） | service |  |
| R31 | 问卷已提交终态拦截 | rules/r00-r33.test.js | getDraft 409 QUESTIONNAIRE_SUBMITTED → kind questionnaire_submitted 固定文案 | service | pure/errors.test.js（QUESTIONNAIRE_SUBMITTED→固定文案分支） |
| R32 | 问卷路由一致性校验 | rules/r00-r33.test.js | survey 页声明承载路由参数校验 | manifest |  |
| R33 | 分类动态下发与兜底 | rules/r00-r33.test.js | getDraft 空骨架兜底字段齐全（服务端数据缺失时的回落基座） | pure |  |
| R34 | 本地草稿作用域隔离 | rules/r34-r66.test.js | 任一作用域要素（含 userId）缺失抛 DRAFT_SCOPE_MISSING 且不落盘 | pure |  |
| R34 | 本地草稿作用域隔离 | rules/r34-r66.test.js | 键为四元组 encodeURIComponent 拼接，saveDraft 合并 patch 强制 synced=false 记 savedAt 并登记草稿索引，不同 userId 互不可见 | pure |  |
| R34 | 本地草稿作用域隔离 | rules/r34-r66.test.js | getDraft 仅 revision 相等返回内容否则空骨架，peekDraft 不过滤 revision，markDraftSynced 推进 revision | pure |  |
| R35 | 草稿合并规则 | rules/r34-r66.test.js | 无本地草稿或 synced!==false → 直接采用服务端 answers、无冲突、无补发 | pure |  |
| R35 | 草稿合并规则 | rules/r34-r66.test.js | 同 revision 且 synced=false → 本地覆盖同题（服务端空 {} 不清本地）+ pendingResync 为 scored 且不同的题（answer+remark 空串归一） | pure |  |
| R35 | 草稿合并规则 | rules/r34-r66.test.js | serverRevision 更大 → conflict 且不覆盖本地；本地 revision 更大 → 以本地为准无冲突 | pure |  |
| R36 | 合并后逐题补发 | rules/r34-r66.test.js | 补发单题按 saveAnswer PUT {answer:'scored', revision} 调用，survey 页声明承载逐题循环 | service+manifest |  |
| R37 | 得分作答乐观更新 | rules/r34-r66.test.js | 本地先行（saveDraft 落盘 synced=false），成功后 markDraftSynced 推进 revision；回滚编排以 survey 页兜底 | pure+manifest |  |
| R38 | 得分/不得分切换走问题页 | rules/r34-r66.test.js | survey/issue 页声明，切换双向经编辑会话链 | manifest |  |
| R39 | 完成度统计口径 | rules/r34-r66.test.js | survey 页声明承载完成度统计（只统计当前题目集合内答案为页面编排） | manifest |  |
| R40 | 进菜品页全题守卫 | rules/r34-r66.test.js | firstIncompleteQuestion 命中未作答/非法答案/空备注/缺必备证据，缺号兜底返回首题分类，全完成返回 undefined | pure | pure/business.test.js（firstIncompleteQuestion 全分支） |
| R41 | 编辑会话开启 | rules/r34-r66.test.js | createEditSession 以 baseAnswerRevision+targetAnswer 建会话，409 EDIT_SESSION_EXISTS → kind conflict + 后端文案与 requiresNewToken 透传 | service |  |
| R42 | 编辑会话状态机 | rules/r34-r66.test.js | confirm/cancel 端点可达，过期/已关闭的 409 后端文案透传（cancel 不做过期拦截由服务端保证） | service |  |
| R43 | 图片证据数量上限 | rules/r34-r66.test.js | issue 页与证据上传链声明（imageMaxCount 余量计算与 toast 为页面编排） | manifest |  |
| R44 | 音频证据上限与时长 | rules/r34-r66.test.js | issue 页声明承载录音上限与时长截断编排 | manifest |  |
| R45 | 证据单文件 10MB | rules/r34-r66.test.js | issue 页声明承载入队前体积守卫（与小票上限数值一致但入口独立） | manifest |  |
| R46 | 证据上传三步链 | rules/r34-r66.test.js | init（payload 透传）→ 预签名直传 → complete（uploadToken/sizeBytes/durationSeconds）端点序列逐笔钉定 | service+adapter | services/uploads-and-config.test.js（直传中间腿）、services/drafts.test.js（init/complete 端点载荷） |
| R47 | 证据失败重试 | rules/r34-r66.test.js | 重试以 secureUuid 重新生成 clientFileId（每次新值、UUIDv4 形状），issue 页声明承载重试编排 | pure+manifest |  |
| R48 | 证据删除分流 | rules/r34-r66.test.js | 服务端附件先调 removeEvidence DELETE 端点，local- 前缀本地直接移除为页面分流 | service |  |
| R49 | 不得分保存必填校验 | rules/r34-r66.test.js | unscored 必填备注、imageRequired/audioRequired 须有 active 未移除证据（问卷侧同语义口径） | pure | pure/business.test.js（active 证据判定共用口径） |
| R50 | 编辑会话确认与取消 | rules/r34-r66.test.js | 先 PATCH 写 draftIssueRemark 再 confirm 提交 {answer, revision}，两步载荷逐字钉定 | service |  |
| R51 | 菜品初始行构建 | rules/r34-r66.test.js | dishes 页与 saveDishes 声明（从 dishRequirements 派生初始行为页面编排） | manifest |  |
| R52 | 本地未同步菜品优先 | rules/r34-r66.test.js | synced=false 且有行时本地 dishes 为渲染数据源，服务端落盘后 markDraftSynced 置同步 | pure |  |
| R53 | 菜品状态选项推导 | rules/r34-r66.test.js | dishes 页声明承载状态选项动态推导 | manifest |  |
| R54 | 菜品字段校验 | rules/r34-r66.test.js | validateDish 九分支逐一命中固定文案，全通过返回空串 | pure | pure/business.test.js（validateDish 九分支） |
| R55 | 状态切换字段清理 | rules/r34-r66.test.js | dishes 页声明承载切换清理矩阵 | manifest |  |
| R56 | 金额分转元解析 | rules/r34-r66.test.js | parseYuanToCents 拒绝负数/科学计数/三位小数/整数超 7 位，合法值精确转分；formatCentsToYuan 反向归一 | pure | pure/receipt-ocr.test.js（parseYuanToCents/formatCentsToYuan） |
| R57 | 行总价推导 | rules/r34-r66.test.js | 显式行总价优先；数量非正整数或单价非整数不推导；否则数量×单价精确推导，溢出抛错 | pure | pure/receipt-ocr.test.js（deriveLineTotal） |
| R58 | 数量校验 | rules/r34-r66.test.js | dishes 页声明承载数量失焦校验（1–999 整数） | manifest |  |
| R59 | 额外菜品创建与空白拦截 | rules/r34-r66.test.js | isBlankExtraDish 空白判定全字段，secureUuid 无安全随机源抛 SECURE_RANDOM_UNAVAILABLE | pure | pure/business.test.js（isBlankExtraDish、secureUuid） |
| R60 | 要求菜品不可删除 | rules/r34-r66.test.js | dishes 页声明承载删除守卫（requirementId 行无删除入口为页面编排） | manifest |  |
| R61 | 小票数量上限与占用计数 | rules/r34-r66.test.js | 上限固定 9，占用=服务端条数+无 attachmentId 或不在服务端集合的待传项，占用+新选>9 拒绝 | pure | pure/receipt-ocr.test.js（readyReceiptCount/occupiedReceiptCount） |
| R62 | 小票文件校验 | rules/r34-r66.test.js | 仅 jpeg/png（类型或路径后缀）且 10MB 内，任一不满足整批拒绝 | pure | pure/receipt-ocr.test.js（validateReceiptFiles） |
| R63 | 小票上传流水线 | rules/r34-r66.test.js | init（{fileMeta,revision}）→ 预签名直传（ETag 捕获）→ complete（{fileMeta+etag,revision}）三步端点序列 | service+adapter | services/uploads-and-config.test.js（直传四类错误与 ETag 捕获） |
| R63 | 小票上传流水线 | rules/r34-r66.test.js | 直传入参校验失败（过期 expiresAt）→ kind upload 唯一不可重试分支且不发起直传 | adapter | services/uploads-and-config.test.js（直传四类错误与 ETag 捕获） |
| R63 | 小票上传流水线 | rules/r34-r66.test.js | 响应契约校验（init 须 attachmentId+uploadTarget、列表/变更 revision 非负整数）不满足 → kind contract | service | services/uploads-and-config.test.js（直传四类错误与 ETag 捕获） |
| R64 | 小票上传取消语义 | rules/r34-r66.test.js | 取消集合 add 后 has 恒真、delete 为唯一复活通道、size 计数去重 | pure | pure/upload-queue.test.js（createCancelledUploads） |
| R65 | 失败小票换图重传 | rules/r34-r66.test.js | 先以 dishHandling=keep_as_manual 删旧附件（DELETE 携带 revision），dishes 页声明承载换图编排 | service |  |
| R66 | 小票删除选项推导 | rules/r34-r66.test.js | 按 dishImpact/appliedDishCount 推导 1 或 2 个选项，确认删除携带 dishHandling+revision 调 DELETE 端点 | pure+service | pure/receipt-ocr.test.js（receiptDeletionOptions） |
| R67 | 已提交后小票面板锁定 | rules/r67-r99.test.js | 小票列表 409 QUESTIONNAIRE_SUBMITTED → kind questionnaire_submitted 固定文案且不可重试 | service | pure/errors.test.js（QUESTIONNAIRE_SUBMITTED→固定文案分支） |
| R68 | OCR 任务创建与恢复 | rules/r67-r99.test.js | createReceiptOcrJob POST body {attachmentIds,idempotencyKey,revision}；getReceiptOcrJob GET 恢复通道 | service |  |
| R69 | OCR 轮询退避 | rules/r67-r99.test.js | nextPollDelay 按 1s/2s/3s 递进并在 5s 封顶 | pure | pure/receipt-ocr.test.js（nextPollDelay） |
| R70 | OCR 只应用一次与必点保护 | rules/r67-r99.test.js | appliedJobIds 幂等跳过；必点缺失/改名 throw 保护文案且不落数据 | pure | pure/receipt-ocr.test.js（applyOcrDishesOnce、markDishEdited） |
| R71 | OCR 状态文案映射 | rules/r67-r99.test.js | 各任务状态给出固定 label/tone/terminal | pure | pure/receipt-ocr.test.js（ocrStatusView） |
| R72 | 菜品页离开持久化 | rules/r67-r99.test.js | dishes 页声明承载离开持久化链路 | manifest |  |
| R73 | 菜品页下一步校验顺序 | rules/r67-r99.test.js | dishes 页声明承载五道校验链 | manifest | pure/receipt-ocr.test.js（requiredReviewMessage） |
| R74 | 菜品页返回答题守卫 | rules/r67-r99.test.js | dishes 页声明承载返回链路与空白额外菜品拦截 | manifest |  |
| R75 | 菜品保存与 revision 推进 | rules/r67-r99.test.js | saveDishes PUT 端点、body {dishes,revision}、服务端 revision 透传供推进 | service |  |
| R76 | attempt 提交中终态关闭 | rules/r67-r99.test.js | dishes/other 页声明承载终态拦截 | manifest |  |
| R77 | 其他记录加载 | rules/r67-r99.test.js | saveOtherRecords PUT 端点与 body 透传（加载编排的服务底座） | service |  |
| R78 | 编辑重置提交状态 | rules/r67-r99.test.js | token 更换后 dedupeKey 随之变化（新 token 必然重新发请求） | service |  |
| R79 | 提交幂等 token | rules/r67-r99.test.js | submitQuestionnaire POST 端点，dedupeKey 含 submitToken（同 token 并发仅一次 fetch） | service |  |
| R80 | 提交确认与闪光点必填 | rules/r67-r99.test.js | other 页声明承载提交确认链 | manifest |  |
| R81 | 提交 processing 轮询 | rules/r67-r99.test.js | 200 {status:processing} 原样透传供页面续轮询；409 SUBMIT_PROCESSING → kind conflict 文案透传 | service | pure/errors.test.js（409→conflict 透传分支） |
| R82 | 提交失败二分 | rules/r67-r99.test.js | retryable=true 上抛（页面保 token）；非 retryable 上抛（页面清 token） | service |  |
| R83 | failed attempt 双保险恢复 | rules/r67-r99.test.js | 重开草稿重新拉取 getDraft 端点（failed 由服务端同事务重置回 draft） | service |  |
| R84 | 409 冲突透传 | rules/r67-r99.test.js | kind conflict、文案取后端 error.message、requiresNewToken 布尔透传 | service | pure/errors.test.js（409 分支三则：文案兜底/requiresNewToken 透传） |
| R85 | 提交成功清理 | rules/r67-r99.test.js | 提交成功响应原样透传（页面据以清草稿并展示成功终态） | service |  |
| R86 | 错误码→文案映射总表 | rules/r67-r99.test.js | presentError 按优先级逐码产出 kind/文案/标志 | pure | pure/errors.test.js（11 分支+优先级）、services/assignments.test.js、services/auth.test.js、services/drafts.test.js（401→session，标注 R05/R86） |
| R87 | 网络错误二分类 | rules/r67-r99.test.js | 超时→kind timeout、其他失败→kind network，文案与 retryable 固定 | service | services/assignments.test.js（12 秒超时→timeout） |
| R88 | 契约校验失败兜底 | rules/r67-r99.test.js | 2xx 响应不合契约 → kind contract 固定文案 | service |  |
| R89 | 页面侧技术信息过滤 | rules/r67-r99.test.js | dishes 页声明承载 safeMessage 过滤（首页/日程页同语义兜底） | manifest |  |
| R90 | 日期时间安全展示 | rules/r67-r99.test.js | 无效值一律「时间待确认」，不出现 Invalid Date | pure | pure/presentation.test.js（safeDate/formatDateHeading/formatTimeRange/formatSubmittedAt） |
| R91 | 预算展示 | rules/r67-r99.test.js | 非正整数/0/缺失为「未设置」，否则「¥x.xx」两位小数 | pure | pure/presentation.test.js（formatBudgetLabel） |
| R92 | 任务状态展示映射 | rules/r67-r99.test.js | 五态固定映射+未知态「状态待确认」兜底，taskType 暗访/明察 | pure | pure/presentation.test.js（mapAssignmentStatus/taskTypeText） |
| R93 | 任务列表投影与分组 | rules/r67-r99.test.js | 展示字段集中生成（原始 ISO 不外泄）、按 displayDate 稳定分组 | pure | pure/presentation.test.js（projectAssignmentForDisplay/groupAssignmentsByDate） |
| R94 | 首页下一任务与草稿进度 | rules/r67-r99.test.js | home 页声明承载下一任务与草稿进度编排 | manifest |  |
| R95 | 日程页筛选与加载降级 | rules/r67-r99.test.js | schedule 页声明承载本地筛选与降级 | manifest |  |
| R96 | 定位说明页 | rules/r67-r99.test.js | location 页声明承载定位成功/失败分支 | manifest |  |
| R97 | 个人资料页 | rules/r67-r99.test.js | profile 页声明承载状态映射与退出链 | manifest |  |
| R98 | 应用结构与验证码插件 | rules/r67-r99.test.js | 11 页面、3 Tab、captcha 域注册 | manifest |  |
| R99 | 录音/播放单例 | rules/r67-r99.test.js | issue 页声明承载录音与播放链 | manifest |  |

## 完备性核对（程序化，2026-10-10 实跑）

核对方法：只读 node 脚本（未入库）做三件事——① 用 `/^\| (R\d+) \| /` 从 rules.md 目录表提取规则编号全集；② 用 `/^\s*it\("([^"]+)"/` 扫描三个规则测试文件提取全部 it 名，按 `^(R\d+)-` 取前缀；③ 解析本文件的映射总表行做双向比对。

结果：

1. **规则全覆盖：100/100。** rules.md 目录 100 个编号（R0 与 R01–R99）在映射表中各有 ≥1 行，缺失列表为空。
2. **无幽灵编号：0 个。** 三个规则测试文件共 106 个 it，其 `R##` 前缀全部存在于 rules.md，无一悬空；反向（rules.md 有编号但无任何 it 前缀）也为 0。
3. **统计：**
   - 规则总数：**100**（R0 + R01–R99）。
   - 规则测试 it 总数：**106**（r00-r33：34；r34-r66：39；r67-r99：33）。
   - 层级分布（按 106 个 it 的「层级：」注释真值逐行计数，组合层级行按其首个层级归并）：**pure 35、service 37、adapter 3、manifest 31**，合计 106。组合行明细：pure+manifest 4（R13/R15/R37/R47）、pure+service 1（R66）、service+manifest 1（R36）、service+adapter 2（R46、R63 第 1 it）；adapter 单列 3（R17/R25/R63 第 2 it）；manifest 含 R0 的 1 条「manifest（源码扫描）」。
   - 多 it 规则：R34×3、R35×3、R63×3（故映射表 106 行 = 100 + 6 额外行），与映射表逐行一致。
   - 附加覆盖列命中 42 条规则（见总表末列非空行）。

## 套件清单（apps/web/tests/ 全部文件，it 数为静态定义点数）

统计口径：`grep -cE '^\s*it\(|it\.each\('`，一个 `it.each(...)` 定义点记 1（不按展开后的用例数计）。

| 文件（相对 apps/web/tests/） | it 数 | 说明 |
|---|---|---|
| manifest.test.js | 29 | app-manifest 结构契约 + src 24 模块加载/导出契约 |
| anti-omission.test.js | 5 | 反遗漏断言：api.js ↔ app-manifest ↔ srcPathList 双向对齐 |
| rules/r00-r33.test.js | 34 | R0–R33，每规则 ≥1 it |
| rules/r34-r66.test.js | 39 | R34–R66，每规则 ≥1 it（R34/R35/R63 各 3） |
| rules/r67-r99.test.js | 33 | R67–R99，每规则 ≥1 it |
| pure/business.test.js | 22 | validateDish / firstIncompleteQuestion / isBlankExtraDish / secureUuid |
| pure/coordinates.test.js | 6 | wgs84ToGcj02 参考点向量 |
| pure/errors.test.js | 21 | BusinessError 构造 + presentError 11 分支与优先级 |
| pure/feature-flags.test.js | 4 | isSelfServiceEnabled / isReceiptOcrEnabled 表驱动（模块级 ×2 循环，运行时 8 例） |
| pure/navigation-guards.test.js | 6 | requireApprovedSession / coldStartRoute / handleUnauthorized |
| pure/presentation.test.js | 23 | safeDate 系 4 函数 / 预算 / 状态映射 / 投影与分组 |
| pure/receipt-ocr.test.js | 28 | 常量与 11 个函数（含 2 处 it.each 定义点，展开后运行时 +10 例） |
| pure/upload-queue.test.js | 5 | createCancelledUploads |
| services/assignments.test.js | 10 | 任务域 5 端点 + 缓存/去重/超时/401 |
| services/auth.test.js | 13 | 认证域 8 端点 + 会话写入/清理 + 无会话头 |
| services/drafts.test.js | 13 | 草稿域 12 端点 + 401 |
| services/receipts.test.js | 7 | 小票域 7 端点 |
| services/uploads-and-config.test.js | 11 | uploadToSignedTarget 直传 + loadPublicConfig |
| **合计（18 个测试文件）** | **309** | |

非测试文件：

- `helpers/contract-paths.js`：非测试，统一的 `loadSrc()` src 模块加载入口，钉定 24 项 `srcPathList`（与 docs/web/module-contracts.md 对应），禁止用例手写 `../src` 相对路径；不参与 vitest 计数。
- `apps/web/vitest.config.js`：`environment: "node"`，`include: ["apps/web/tests/**/*.test.js"]`——上表 18 文件全部入套件。

> 口径注：309 为静态 it/it.each 定义点数。运行时用例数因表驱动略有放大（pure/feature-flags.test.js ×2 = 8；pure/receipt-ocr.test.js 两处 it.each 展开 4+6 = 10），不影响映射表的 106 口径（规则测试文件无表驱动）。
