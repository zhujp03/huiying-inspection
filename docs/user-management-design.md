# 用户管理设计 v2（管理员手动建号 + 账号设置控制）

> 状态：设计稿 v2（已按确认意见修订），未实施。日期：2026-08-12。
> 已确认决策：① 用户类型 = user_roles 角色类型（admin/inspector 两种），不是"有/无"；② 密码默认 8-15 位含大写+英文符号，管理员创建/重置豁免；③ 手动建探员直接激活；④ 保留小程序注册+审批；⑤ 无 super_admin 层级，所有管理员权限相同、可管理所有账号。

## 1. 角色模型（修订核心）

**两种角色**（roles 表新增，替代旧的四角色分层）：

| 角色 | code | 权限 | 说明 |
|---|---|---|---|
| 管理员 | `admin` | 全部权限码（含用户管理） | 所有管理员权限相同，无层级；可管理所有账号（含其他管理员） |
| 探员 | `inspector` | 无后台权限 | 小程序端执行暗访任务 |

- **用户类型判定**：`user_roles` 中角色的类型 —— `admin` = 管理员，`inspector` = 探员。两种角色都有 user_roles 记录（探员不再"无角色"）；
- **旧角色兼容**：现有 4 个旧角色（super_admin/operations_admin/reviewer/store_manager）数据保留，`user_roles` 挂旧角色的用户一律判定为**管理员**（代码判定：`role.code IN (旧4角色, 'admin')` = 管理员；`'inspector'` = 探员）；新用户只创建 admin/inspector 两种角色；
- **迁移**：roles 表插入 `admin`（挂全部权限码）/`inspector` 两个角色；现有已激活探员（有 `inspector_registrations` 且无角色）补写 `inspector` 角色；现有 admin 用户保持原角色（判定为管理员）；
- **前端角色标签**：管理员统一显示"管理员"，不再展示四个旧角色名。

## 2. 密码策略与自助路径边界（修订）

**自助路径仅两项：注册、找回密码**（小程序端）。
- 注册：新用户**只能注册为探员（inspector 角色），无角色选择**；管理员账号只能由管理员在后台创建；
- 找回密码 = 修改密码的唯一自助通道（输入手机号 → 验证码 → 重置新密码）；**不提供登录态内修改密码**（profile 页已引导走忘记密码，保持一致）；
- 修改密码的两个通道：① 用户自助：找回密码流程；② 管理员：后台重置任意账号密码。

| 场景 | 策略 |
|---|---|
| 小程序注册 / 找回密码重置 | **8-15 位，必须含大写字母和英文符号**（`PasswordSchema` 修改） |
| 管理员创建账号 / 后台重置任意账号密码 | **豁免**：无复杂度要求，仅限 1-64 位非空 |

- 豁免仅限"管理员操作"路径（POST/PATCH 用户接口）；自助路径一律强策略；
- 重置密码后该用户 `session_version+1`，所有会话立即失效。

## 3. API 设计

### 3.1 权限

新增权限码 `user:manage`（查看/创建/编辑/启停/重置密码）：

| 角色 | 探员管理 | 管理员管理 |
|---|---|---|
| admin（含旧四角色） | ✅ | ✅（无层级，可管所有管理员） |
| inspector | ❌ | ❌ |

保护规则（服务端强制，与层级无关的硬约束）：
- 不能停用自己、不能把自己降为探员；
- 不能移除最后一名管理员（事务内计数校验）。

### 3.2 接口

**GET `/api/admin/users?kind=admin|inspector&status=&cursor=&limit=`**（改造现有）
- 返回：`{ id, username, displayName, maskedPhone, roleCode(admin|inspector), scopeLabel?, source: manual|registration, status, revision }`；
- `kind=admin`：`user_roles JOIN roles WHERE code 为管理员类`；
- `kind=inspector`：`JOIN roles WHERE code='inspector'`（含迁移后的存量探员）；
- 权限：`user:manage`。

**POST `/api/admin/users`**（创建，仅管理员后台使用）
```json
{ "kind": "admin|inspector",
  "username": "4-32 位字母数字下划线中文",
  "displayName": "姓名",
  "phone": "11 位手机号",
  "password": "1-64 位任意（管理员创建豁免策略）",
  "scopeType"?: "admin 可选：all|region|store", "regionId"?: uuid, "storeId"?: uuid }
```
- 校验：username/phone 全局唯一 → 409；探员建号直接 `approved_active`（跳过审批）；写 `user_roles`（admin 或 inspector）；管理员默认 scope=all，可选按区域/门店；
- 审计：`user_created`（kind/scopeType）。
- **小程序自助注册与本接口无关**：注册接口固定创建 inspector 角色、状态 pending_approval（走审批），角色不可选。

**PATCH `/api/admin/users/:id`**（账号设置，子集必填）
```json
{ "displayName"?: string, "status"?: "approved_active|disabled",
  "kind"?: "admin|inspector", "scopeType"?: string, "regionId"?: uuid, "storeId"?: uuid,
  "password"?: string }
```
- `kind` 变更 = 换角色（admin ↔ inspector，受保护规则约束）；
- 重置密码（豁免策略）、停用 → 会话全部失效；启用恢复；
- 审计：`user_updated`（记录变更字段名，不含密码）。

**保留现有接口**：注册审批流（`inspector-registrations`）、`disable/enable`（兼容）。

### 3.3 安全

- 密码仅存 argon2id hash，接口永不返回；手机号密文存储，列表返回掩码；
- 全部写操作 CSRF + 幂等键（复用现有 adminSession）；
- 审计覆盖：建号/改密/启停/角色变更。

## 4. 前端设计（用户管理页）

**导航**：现有「注册审批」菜单改造为「**用户管理**」（admin 类角色可见；inspector 无后台登录）。

```
用户管理
├── Tab「探员管理」
│   ├── 待审批区：注册申请的 待审核/未通过/已停用 + 批准/驳回（注册入口保留）
│   ├── 探员列表：用户名/姓名/手机号(掩码)/来源(注册|手动)/状态/操作
│   └── 操作：新建探员 / 编辑 / 重置密码 / 停用 / 启用
└── Tab「管理员管理」
    ├── 管理员列表：用户名/姓名/数据范围/状态/操作
    └── 操作：新建管理员 / 改数据范围 / 重置密码 / 停用 / 启用
```

- 新建/编辑弹窗表单（沿用 Modal + run 模式）；数据范围沿用省市区三级组件；
- 密码字段：新建时必填（豁免策略，提示"管理员创建可任意，建议≥8位"）；重置密码弹窗；
- 危险操作二次确认；前端仅控件投影，服务端权限为准。

## 5. 迁移清单

1. `roles` 插入 `admin`（复制全部权限码绑定）/`inspector` 两角色；
2. 现有已激活探员（有 approved registration、无 user_roles）补写 `inspector` 角色；
3. 现有 admin 用户（挂旧角色）不动（判定兼容为管理员）；
4. `PasswordSchema` 改为 8-15 位 + 大写 + 英文符号（影响注册/找回/改密自助路径；需同步检查受影响的现有测试）；
5. 现有 `GET /api/admin/users`（探员下拉，供任务分配用）改为按 `inspector` 角色查询，保持返回契约不变（AssignmentEditor 依赖）。

## 6. 测试与验收

- **后端集成测试（独立测试库）**：双角色建号、唯一性冲突、改密踢会话、停用踢会话、不能停用自己、最后一名管理员保护、注册审批通过后自动挂 inspector 角色、审计落库；
- **前端 E2E（fixture）**：双 Tab、新建探员/管理员、密码豁免提示、角色投影；
- **手动验收**：admin 登录 → 手动建探员（短密码可建）→ 探员小程序登录 → 重置密码 → 旧会话失效 → 建第二个管理员 → 新管理员可登录且可管理所有。

## 7. 未决（默认按上述设计，如需调整请指出）

- 旧四角色在**前端下拉/标签**中不再出现（历史数据仅兼容判定）；
- 管理员创建管理员时默认 scope=all（个人使用场景默认全量），可选收窄。
