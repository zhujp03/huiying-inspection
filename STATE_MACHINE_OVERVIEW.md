# 暗访问卷状态机总览

> 文档性质：跨角色、跨模块的统一可视化索引。  
> 作用：帮助产品、前端、后端、测试和运维快速理解状态及守卫。  
> 约束：本文件不创建新的字段或 API；发生文字差异时，业务边界以 `project_boundary.md` 为准，业务状态与所有权以 `assignment_spec.md` 为准，接口以 `packages/contracts/endpoint-registry.js` 为准，后端事务与存储以 `BACKEND_DESIGN.md` 为准。  
> 2026-08-10 全栈收口确认：本轮实现未引入任何新状态或新转换，四张状态图与当前代码（账号/父任务/分配/问卷/证据/OCR）一致，无漂移。

## 0. 阅读约定

- 图中的英文是数据库或共享契约状态；中文是用户可理解的动作或守卫。
- 实线箭头表示允许的状态转换；没有画出的箭头一律不允许靠客户端自行跳转。
- `revision` 负责阻止并发覆盖，`Idempotency-Key` / `submitToken` 负责安全重试，两者不能互相替代。
- 账号、父任务、单人分配、问卷实例、编辑会话、附件和 OCR job 是不同聚合，不允许把一个对象的状态直接写进另一个对象。
- 所有时间、权限、所有权、距离、证据完整性和提交完整性都由服务端再次校验。

## 1. 账号与访问状态

```mermaid
stateDiagram-v2
    direction LR
    [*] --> unregistered
    unregistered --> pending_approval: 行为验证、短信验证、提交注册
    pending_approval --> approved_active: 管理员批准
    pending_approval --> rejected: 管理员拒绝并填写原因
    rejected --> pending_approval: 用户修改后重提或管理员重新打开
    approved_active --> disabled: 管理员停用并撤销全部会话
    disabled --> approved_active: 管理员启用，用户必须重新登录

    state pending_approval {
        [*] --> application_status_only
    }
    state rejected {
        [*] --> rejection_visible
    }
    state approved_active {
        [*] --> business_login_allowed
    }
    state disabled {
        [*] --> business_access_blocked
    }
```

关键守卫：

- `pending_approval` 和 `rejected` 只能得到申请状态会话，不能访问任务和问卷。
- `rejected` 不能直接变为 `approved_active`，必须重新进入待审批。
- 停用在同一事务中增加 `session_version` 并撤销现有会话；启用不会恢复旧会话。
- 忘记密码是凭据流程，不新增账号状态：行为验证 → 短信验证码（最多错误 3 次）→ 单次 reset token → 重置密码并撤销旧会话。重置密码不会绕过待审批、拒绝或停用状态。（2026-08-13：小程序端 UI 入口已隐藏，后端流程保留。）后端可通过 AUTH_SELF_SERVICE=disabled 使相关接口休眠（503），启用自助注册/找回时须置 enabled 并配齐密钥。

## 2. 父任务、单人分配与问卷提交状态

```mermaid
flowchart TB
    subgraph Campaign["父任务 audit_campaign"]
        CD["draft"] -->|"发布至少一条合法分配"| CP["published"]
        CP -->|"任一分配开始、逾期或部分终结"| CIP["in_progress"]
        CP -->|"全部分配均 submitted / cancelled"| CC["completed"]
        CIP -->|"全部分配均 submitted / cancelled"| CC
        CD -->|"管理员整体取消"| CX["cancelled"]
        CP -->|"管理员整体取消"| CX
        CIP -->|"管理员整体取消剩余分配"| CX
    end

    subgraph Assignment["每名探店员独立 audit_assignment"]
        AD["draft"] -->|"父任务发布"| AA["assigned"]
        AA -->|"有效打卡或豁免，幂等 start"| AI["in_progress"]
        AA -->|"超过 due_at"| AO["overdue"]
        AI -->|"超过 due_at"| AO
        AO -->|"延期到未来且无问卷"| AA
        AO -->|"延期到未来且已有草稿"| AI
        AA -->|"管理员取消"| AX["cancelled"]
        AI -->|"管理员取消，且无有效 submitting 租约"| AX
        AO -->|"管理员取消"| AX
        AI -->|"提交最终化事务成功"| AS["submitted"]
    end

    subgraph Attempt["唯一 survey_attempt"]
        AN["不存在"] -->|"start 只创建一次"| ATD["draft"]
        ATD -->|"取得 submitToken 租约"| ATS["submitting"]
        ATF["failed"] -->|"原 token 可安全重试或修正后新 token"| ATS
        ATF -->|"探店员重新打开草稿：事务重置回 draft（attempt_recovered）"| ATD
        ATS -->|"原子快照成功"| ATOK["submitted"]
        ATS -->|"确认无不可逆结果后恢复"| ATF
    end

    AA -. "同一事务创建问卷" .-> ATD
    ATD -. "分配保持进行中" .-> AI
    ATOK -. "同一最终化事务" .-> AS
    AS -. "触发同一事务聚合" .-> Recalc{"父任务是否全部终态"}
    AX -. "触发同一事务聚合" .-> Recalc
    Recalc -->|"是"| CC
    Recalc -->|"否"| CIP
    AO -. "逾期不是终态" .-> CIP
```

关键守卫：

- 不存在 `overdue → submitted`；管理员必须先延期，客户端刷新 `revision` 并生成新 `submitToken`。
- 同一分配最多一个 `survey_attempt`；重复开始返回原实例。
- 提交进入 `submitting` 后，答案、证据、菜品、小票和 OCR 应用全部停止写入。
- 成功提交后只有管理员只读查看；第一阶段探店员不能回看或修改。
- 同一父任务下的分配数据仍完全隔离，但状态变化会短暂串行锁定同一父任务行以安全更新聚合状态。
- `failed` 不是死局：worker 租约过期把 `submitting` 置为 `failed` 后，探店员重新打开草稿会在同一事务内重置回 `draft`（清空提交租约并写 `attempt_recovered` 审计）；提交接口亦视 `failed` 同 `draft`，可直接重新发起提交。

## 3. 问题证据、小票 OCR 与人工校对状态

```mermaid
flowchart LR
    Draft["survey_attempt = draft / failed"]
    Barrier["survey_attempt = submitting / submitted\n所有普通写接口拒绝"]

    subgraph Evidence["不得分答案与问题证据"]
        Stable["稳定答案\n未答 / scored / unscored"] -->|"打开不得分或编辑"| Open["edit_session = open"]
        Open -->|"初始化并直传"| EU["attachment = staged_uploading"]
        EU -->|"COS 内容校验通过"| ER["staged_ready"]
        EU -->|"校验失败"| EF["failed"]
        EF -->|"新 attachment 重试"| EU
        Open -->|"记录删除意图，不立即删原件"| Removal["pending removal"]
        ER --> Confirm{"说明及所需图片/音频是否齐全"}
        Removal --> Confirm
        Open -->|"无新文件也可确认"| Confirm
        Confirm -->|"是：一个事务激活新证据并保存答案"| EC["edit_session = confirmed\nattachment = active"]
        Confirm -->|"否"| Open
        Open -->|"取消"| EX["edit_session = cancelled\n原答案和原附件不变"]
        Open -->|"30 分钟到期"| EE["edit_session = expired\n暂存对象排队清理"]
        EC --> Stable
        EX --> Stable
        EE --> Stable
    end

    subgraph Receipt["消费小票、OCR 候选与菜品"]
        RU["receipt = uploading"] -->|"COS 内容校验通过"| RR["ready 原图"]
        RU -->|"失败"| RF["failed"]
        RF -->|"新 attachment 重试"| RU
        RR -->|"固定附件快照与 input_hash"| OQ["OCR job = queued"]
        OQ -->|"worker 取得租约"| OP["processing"]
        OP -->|"完整候选"| OS["succeeded"]
        OP -->|"部分候选或需核对"| OPA["partial"]
        OP -->|"无法识别且达到重试条件"| OF["failed"]
        OP -->|"删除来源或提交开始"| OC["cancelled"]
        OS -->|"幂等 apply + revision"| Applied["写 receipt_ocr_application\n合并到 dish_records"]
        OPA -->|"幂等 apply + revision"| Applied
        Applied --> Manual["探店员人工核对、修改、删除或补充"]
        OF -->|"不阻塞手工录入"| Manual
        RR -->|"不使用 OCR"| Manual
    end

    Draft -. "允许进入" .-> Stable
    Draft -. "允许进入" .-> RU
    Draft -. "允许编辑" .-> Manual
    Stable -. "开始提交" .-> Barrier
    Manual -. "开始提交" .-> Barrier
```

关键守卫：

- `unscored` 永远要求非空问题说明；题库若要求图片或音频，对应类型至少一份 `active` 证据。
- `cancel`/`expired` 不删除原答案或原附件；只清理本次会话产生的暂存对象。
- OCR job 的终态仍是 `succeeded | partial | failed | cancelled`；“已应用”由独立 application 记录表达，不能篡改 OCR 原始候选。
- OCR 永远不能直接覆盖管理员要求行或人工新修改；`apply` 通过 `revision` 冲突要求刷新。
- 小票最多 9 张的计数、同文件去重和上传完成都由服务端事务再次校验。

## 4. 端到端整体流程

```mermaid
flowchart TD
    Register["探店员注册\n行为验证 + 短信"] --> Approval{"管理员审批"}
    Approval -->|"拒绝"| Resubmit["查看原因并重新提交"]
    Resubmit --> Approval
    Approval -->|"批准"| Login["登录并取得业务会话"]

    AdminSetup["管理员配置门店坐标、题库版本、证据规则和菜品要求"] --> Publish["创建父任务与单人分配并发布"]
    Login --> Mine["读取自己的 0 / 1 / 多个可执行分配"]
    Publish --> Mine
    Mine --> Location["获取 GCJ-02 位置并向服务端打卡"]
    Location -->|"范围外、过旧或精度不足"| LocationRetry["重试定位，或管理员创建短时豁免"]
    LocationRetry --> Location
    Location -->|"通过或原子消费豁免"| Start["幂等开始：创建唯一问卷与菜品要求快照"]

    Start --> Questions["完成全部启用题\n不得分说明及条件证据"]
    Questions --> Receipts["上传最多 9 张小票"]
    Receipts --> OcrChoice{"OCR 是否成功"}
    OcrChoice -->|"成功或部分成功"| Review["自动带入后人工核对菜名、数量和金额"]
    OcrChoice -->|"失败或不用 OCR"| Manual["完全手工录入"]
    Review --> Other["闪光点与其他建议"]
    Manual --> Other

    Other --> Submit{"最终完整性与截止时间校验"}
    Submit -->|"已逾期"| Extend["管理员延期；客户端刷新并生成新 token"]
    Extend --> Submit
    Submit -->|"确定性缺项"| Fix["恢复草稿并修正；使用新 token"]
    Fix --> Questions
    Submit -->|"瞬时失败且未产生结果"| Retry["原 token 按租约恢复"]
    Retry --> Submit
    Submit -->|"原子成功"| Snapshot["不可变提交快照\n所有写接口关闭"]

    Snapshot --> AdminRead["管理员按权限只读查看全部题目、证据、小票与菜品比对"]
    Snapshot --> Export["异步导出、审计、保留和备份"]
    Worker["后台 Worker\n逾期、OCR、恢复、清理"] -. "异步推进，不绕过事务守卫" .-> OcrChoice
    Worker -. "修复 stale 状态" .-> Submit
```

## 5. 并发阅读提示

- 不同父任务、不同分配和不同问卷可以并行处理。
- 同一问卷只有一个业务所有者；重复设备请求通过 `revision`、唯一约束和幂等键裁决，不做多人合并。
- 同一父任务下多个分配同时开始、提交或取消时，会短暂竞争父任务聚合行；这是保证父任务统计一致性的有界串行点，不代表答案数据共享。
- 管理员与探店员同时操作同一资源时，状态守卫和锁顺序为：`idempotency → campaign → assignment → attempt → edit_session/OCR job → UUID 排序的子项`。
- 外部短信、验证码、COS 和 PaddleOCR 调用不得发生在持有数据库事务锁期间。
- “支持并发”必须同时通过数据库竞争测试和目标环境压测，不能仅凭图或代码评审宣称。
