# 腾讯云短信 + 验证码：控制台办理与 .env 填写清单

> 适用：汇盈探店 开发版/生产版 的注册验证码与找回密码验证码（方案 A）。
> 代码侧零改动；本文件只覆盖「腾讯云控制台操作 + `.env` 填写 + 联调验证」。
> 本文档仅在 AUTH_SELF_SERVICE=enabled 时适用；disabled 时无需办理短信/验证码，相关 `.env` 键必须留空。

## 1. 前置

- 腾讯云账号已完成**企业/主体实名认证**（个人实名无法开通短信）。
- 小程序 AppID：`wx35690c1079fb5a5d`（签名与验证码实例都要关联它）。

## 2. 短信控制台（console.cloud.tencent.com/sms）

1. **申请签名**：签名内容如「汇盈探店」；签名类型选「小程序」；按要求上传小程序后台截图/营业执照。
2. **申请两个模板**（代码只传一个变量 `{1}`＝验证码，模板里不得出现第二个变量）：

   | 用途 key | 建议模板内容 |
   |---|---|
   | `registration` | 您的注册验证码为{1}，5分钟内有效，请勿泄露给他人。 |
   | `passwordReset` | 您的找回密码验证码为{1}，5分钟内有效，请勿泄露给他人。 |

3. 两个模板都显示「已通过」后，记录：
   - `SDKAppID`（应用列表里的 AppID）
   - 签名名称（与申请内容完全一致）
   - 两个模板的模板 ID（数字串）

## 3. 验证码控制台（console.cloud.tencent.com/captcha）

1. 创建验证实例，类型选**「微信小程序」**（代码使用 DescribeCaptchaMiniResult，CaptchaType=9）。
2. 记录 `CaptchaAppId`（十进制正整数）与 `AppSecretKey`。
3. 用子账号/独立 API 密钥创建最小权限凭据（CAPTCHA 相关权限），记录
   `SecretId` 与 `SecretKey`。
4. ⚠️ 四组值**禁止相同**（`CAPTCHA_APP_ID` 除外，它是公开值）：
   `APP_SECRET_KEY` ≠ `API_SECRET_ID` ≠ `API_SECRET_KEY`；代码启动与预检都会强制校验。

## 4. 填写 `.env`

```dotenv
AUTH_PROVIDER_MODE=tencent

CAPTCHA_APP_ID=<第3步 CaptchaAppId>
CAPTCHA_APP_SECRET_KEY=<第3步 AppSecretKey>
CAPTCHA_API_SECRET_ID=<第3步 API SecretId>
CAPTCHA_API_SECRET_KEY=<第3步 API SecretKey>
CAPTCHA_REGION=            # 可留空，验证码接口默认地域

SMS_SECRET_ID=<第2步账号 SecretId（可与 CAPTCHA_API_SECRET_ID 同账号，但模板/签名是短信侧资源）>
SMS_SECRET_KEY=<对应 SecretKey>
SMS_SDK_APP_ID=<第2步 SDKAppID>
SMS_SIGN_NAME=<签名内容，如 汇盈探店>
SMS_TEMPLATE_IDS={"registration":"<注册模板ID>","passwordReset":"<找回模板ID>"}
```

## 5. 开发期免费联调（不用等真实扣费）

- 短信控制台 →「国际/港澳台短信/国内短信」→ 应用管理 → 找到「测试手机号」白名单：
  把你的手机号加进去，**模板未过审也能收码**，适合开发联调。
- 微信开发者工具里验证码插件需要先在公众平台添加插件（见下）。

## 6. 微信公众平台

1. 「设置 → 第三方设置 → 插件管理」：添加腾讯验证码插件
   （`app.json` 已声明 provider `wx1fe8d9a3cb067a75`、版本 `2.1.4`）。
2. 「开发管理 → 开发设置 → 服务器域名」：request 合法域名填开发 API 域名。

## 7. 联调验证顺序

```bash
# 1) 填完 .env 后重启 API（本机：kill 旧进程后）
node --env-file=.env apps/api/src/server.js

# 2) 小程序开发者工具打开 apps/miniapp：
#    注册页 → 输手机号 → 滑验证码 → 收短信 → 提交注册 → 看到“申请已提交，请等待审核”

# 3) 确认公开配置接口返回真实 CaptchaAppId：
curl -s http://127.0.0.1:3000/api/public/client-config
# 期望：{"captchaAppId":"<数字>","tencentMapKey":...,"features":{"receiptOcr":...}}
```

常见失败对照：

| 现象 | 原因 |
|---|---|
| 验证码组件不出现 / 加载失败 | 插件未在公众平台添加授权；或开发者工具未登录该 AppID |
| 收不到短信、返回 `SMS_SEND_REJECTED_*` | 签名/模板未过审、手机号不在测试白名单、签名名称与申请不一致 |
| `CAPTCHA_NOT_CONFIGURED` (503) | 四键未填全 |
| 验证码总提示「验证未通过」 | AppSecretKey 与 API 凭据填错/互换了 |

## 8. 生产切换时的额外要求

- 生产 `.env` 之外，`verify:external` 还会要求：真实 CAPTCHA 弹窗/二次校验、
  真实短信白名单与两个模板、真机验收（`REAL_DEVICE_ACCEPTED=yes`）、
  ≥100 组脱敏小票 OCR 基准（`OCR_BASELINE_ACCEPTED=yes`）与 staging P1 计划。
- 生产与开发**不得共用**同一短信签名/模板配额内的测试白名单和验证码实例
  （BACKEND_DESIGN 3.1 环境隔离）。
