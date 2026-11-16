# AI 人生时光机 · 小红书小程序 (`@ailifetime/xhs-mini`)

基于 **[uni-app](https://uniapp.dcloud.net.cn/quickstart.html) (Vue 3 + TypeScript + Vite)** 构建的 AI 人生时光机小红书小程序（同时支持通过 [uni-app 条件编译](https://uniapp.dcloud.net.cn/tutorial/platform.html) 输出微信小程序与 H5）。

## 1. 目录与架构设计

本项目位于 `ailifetime` Monorepo 的 `apps/xhs-mini` 下，直接复用工作区内的契约与 SDK：

- **共享契约层** (`@ailifetime/contracts` → `src/contracts/index.ts`)：严格对齐 `contracts/openapi.yaml` 的数据类型、错误结构与强制 AI 艺术示意声明。
- **共享 SDK 层** (`@ailifetime/sdk-ts` → `src/sdk/index.ts`)：统一封装 `/v1/guest-sessions`、`/v1/consents`、`/v1/upload-sessions`、`/v1/projects`、`/v1/generation-jobs`、`/v1/shares`、`/v1/checkout-sessions`、`/v1/orders`、`/v1/future-self/messages` 与 `/v1/data-rights/requests`，自动注入符合规范的 `Idempotency-Key`（16—128 字符）。
- **小红书多端适配层** (`src/utils/xhs-platform.ts` & `src/services/api.ts`)：
  - 使用 `#ifdef MP-XHS` 条件编译处理小红书登录与启动参数（遵循 `B70-R01` 不把 `openid` 当作跨主体身份）。
  - 在 `onHide` / `onUnload` 生命周期自动清理短期签名预览媒体缓存（遵循 `B70-R03`）。
  - 分享卡片强制注入 `【AI艺术示意】` 标识与可撤销短链参数（遵循 `B71-R03` 与 [uni-app 分享规范](https://uniapp.dcloud.net.cn/api/plugins/share.html)）。
  - 本地预览使用模拟数据（`VITE_SANDBOX_MODE=true`），可检查界面和交互。

## 2. 核心页面

1. **时光首页 (`src/pages/index/index.vue`)**：展示强制 AI 艺术化示意声明横幅、0—100 岁阶段概览、小红书时光仪式场景与安全会话初始化。
2. **时光工坊 (`src/pages/studio/index.vue`)**：本地模式使用演示数据。小红书正式配置下启用本人单张照片流程，调用实际身份、媒体、授权和照片订单接口。相册创建订单、多人和结果下载仍待接入。
3. **未来自我 (`src/pages/future-self/index.vue`)**：强制披露虚构 AI 身份（`disclosure_ack: true`），支持切换记忆模式（`off` / `session` / `explicit`）。
4. **隐私与订单 (`src/pages/profile/index.vue`)**：支持实物订单查询、一键撤销分享短链及发起全链路数据删除并获取机器可查收据。

## 3. 本地开发与构建命令

在 Monorepo 根目录 `/Users/stephen/Documents/Projects/python/ailifetime` 下执行：

```bash
# 1. 安装小红书工作区的冻结依赖
pnpm --dir apps/xhs-mini install --frozen-lockfile --registry=https://registry.npmjs.org

# 2. 启动小红书小程序开发编译（实时监听）
pnpm dev:xhs

# 3. 编译小红书预览产物
pnpm build:xhs

# 4. 类型检查、两个 uni-app 目标构建及产物回归
pnpm verify:miniprograms
```

产物位于 `apps/xhs-mini/dist/dev/mp-xhs` 或 `apps/xhs-mini/dist/build/mp-xhs`。本地模式默认启用。运行验证命令会输出 `LOCAL_ARTIFACTS_VALIDATED` 和平台验收状态。

生成带正式配置的候选包时，从 `.env.production.example` 创建本地 `.env.production`，将 `VITE_SANDBOX_MODE` 设为 `false`，填写备案且已在平台登记的 `VITE_API_BASE_URL` 和目标平台的 AppID。小红书还须提供实际的 `VITE_XHS_IDENTITY_ORIGIN`。构建工具把 AppID 写入产物的 `project.config.json`，将业务和身份源与 API 编译文件的 SHA-256 记录在 `release-build.json`。平台密钥和商户凭据由服务端保管。

小红书登录使用一次性原生 code，从专用身份源取得短效会话。工作坊在用户确认本人授权后，通过小红书原生相册、文件信息及读取 API 上传 JPEG。上传支持压缩后不超过 4 MiB、至少 512×512 的照片，最低文件 API 基础库为 3.125.4。消费 API 绑定该资产与服务端核实的本人身份，再进行授权、媒体审核和报价；生成提交仅对经服务端确认付款的订单开放。

在小红书开发者工具生成体验码前，从仓库根目录运行以下命令。环境变量填写该产物绑定的实际 AppID、业务 HTTPS 源和身份 HTTPS 源。

```sh
LTM_XHS_APP_ID="$VITE_XHS_MINI_APPID" \
  LTM_PRODUCTION_API_ORIGIN="$VITE_API_BASE_URL" \
  LTM_XHS_IDENTITY_ORIGIN="$VITE_XHS_IDENTITY_ORIGIN" \
  node apps/xhs-mini/tools/validate-launch-readiness.mjs --experience
```

收到 `EXPERIENCE_API_READY` 后，用本次核对的产物生成体验码。预检要求实际 `GET /health/ready` 返回 HTTP 200 和 JSON `ready: true`。正式上线还需完成官方登录、逐人授权、照片上传、生成、分享撤销与删除的真机验收。相册下单还需确认平台开通的交易能力，并验证支付、退款、对账及履约。

### 小红书自定义交易组件

平台订单详情页使用 `/pages/profile/index?order_id=<商户订单ID>`。小程序向 API 的 `GET /v1/orders/{id}` 请求订单。服务端必须从小红书身份会话校验订单归属，只为待支付订单返回短效的 `xhs_custom_checkout`，并将其中的商户订单 ID、金额、币种绑定至同一订单。支付参数包含小红书订单 ID、支付令牌、秒级到期时间及获批收单渠道的 HTTPS 地址。

客户端使用小红书原生自定义交易组件，返回后重新查询订单。付款和履约状态由服务端依据已验证的商户通知和查单结果更新。商户签名材料、收银台地址和支付令牌不得写进源码、页面路由或日志。
