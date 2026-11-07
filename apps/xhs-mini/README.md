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
  - 内置本地确定性沙箱（`VITE_SANDBOX_MODE=true`），无需启动后端即可在小红书开发者工具中完整体验全流程。

## 2. 核心页面

1. **时光首页 (`src/pages/index/index.vue`)**：展示强制 AI 艺术化示意声明横幅、0—100 岁阶段概览、小红书时光仪式场景与安全会话初始化。
2. **时光工坊 (`src/pages/studio/index.vue`)**：实现「逐人按用途授权 → 隔离签名上传会话 → 0—100 岁阶段生成 → 可撤销小红书分享短链 → 服务端核价精装相册下单」闭环。
3. **未来自我 (`src/pages/future-self/index.vue`)**：强制披露虚构 AI 身份（`disclosure_ack: true`），支持切换记忆模式（`off` / `session` / `explicit`）。
4. **隐私与订单 (`src/pages/profile/index.vue`)**：支持实物订单查询、一键撤销分享短链及发起全链路数据删除并获取机器可查收据。

## 3. 本地开发与构建命令

在 Monorepo 根目录 `/Users/stephen/Documents/Projects/python/ailifetime` 下执行：

```bash
# 1. 安装依赖（已配置 .npmrc shamefully-hoist=true 适配小红书开发者工具）
pnpm install

# 2. 启动小红书小程序开发编译（实时监听）
pnpm dev:xhs

# 3. 生产构建小红书小程序
pnpm build:xhs

# 4. TypeScript 类型检查
pnpm typecheck:xhs
```

编译产物位于 `apps/xhs-mini/dist/dev/mp-xhs`（开发模式）或 `apps/xhs-mini/dist/build/mp-xhs`（生产模式）。打开**小红书开发者工具**，导入该目录并在 `src/manifest.json` 的 `mp-xhs.appid` 中填入你的小红书小程序 AppID 即可真机预览。
