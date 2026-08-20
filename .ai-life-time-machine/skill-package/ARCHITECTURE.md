# 参考架构与适配原则

## 1. 架构目标

系统必须同时支持：高成本异步 AI 媒体、逐人授权与删除、家庭协作、多租户 B2B2C、支付/账本、实物供应链、多端客户端、伙伴 API，以及可审计上线。参考采用“模块化单体/有限服务 + 持久工作流 + 事件契约”，而不是默认过度微服务化。

## 2. 逻辑平面

```text
Experience Plane
  marketing / consumer web / mobile / mini-program / kiosk
  partner / admin / support / developer / finance / vendor portals

Control Plane
  identity / tenant / consent / family / projects / catalog / entitlements
  orders / support / partner / notification / policy / configuration

Media Plane
  intake / preprocessing / age generation / quality / video / moderation
  provenance / asset lifecycle / deletion propagation

Commercial Truth Plane
  payments / immutable ledger / invoice-tax / revenue / payouts
  vendor purchase orders / fulfillment / returns / claims

Integration Plane
  API gateway / OAuth / SDK / webhook / connectors / provider adapters

Data & Operations Plane
  event registry / pipelines / warehouse / semantic layer / experiments
  observability / SLO / security / DR / compliance evidence / release
```

## 3. 推荐仓库布局

```text
apps/
  marketing-site consumer-web partner-portal admin-console
  developer-portal mobile wechat-mini kiosk
services/
  control-plane media-worker notification-worker billing-worker
  fulfillment-worker integration-gateway analytics-pipeline
packages/
  contracts design-system policy-sdk auth-sdk test-kit
  sdk-ts sdk-java sdk-python
infra/
  local iac kubernetes observability security
contracts/ schemas/ migrations/ docs/ evidence/
```

这只是能力地图。既有仓库必须由 B00/B01 做映射，不得为了匹配目录而重写稳定系统。

## 4. 数据与状态真相

- 领域数据库保存用户、家庭、授权、项目、订单、伙伴和运营状态；
- 对象存储保存加密媒体，访问使用短期签名 URL；
- 持久工作流保存异步处理、重试、取消和补偿；
- 不可变复式账本是收入/退款/分成/供应商成本的会计真相；
- 数仓和仪表板用于分析，不得覆盖交易/账本事实；
- 每个外部回调保留原始签名事实、规范化事件和幂等结果。

## 5. 必须版本化的契约

OpenAPI、事件、数据库迁移、权限、错误码、同意政策、产品/价格快照、AI provider request/response、SDK、Webhook、通知模板、分析事件、财务分录、供应商任务和 release manifest。旧移动端、旧小程序、伙伴 SDK 和进行中工作流必须有兼容窗口。

## 6. 安全与隐私

服务端计算 actor/tenant/resource/purpose/consent/entitlement；客户端隐藏按钮不是授权。原图、衍生图、人脸特征、业务数据、账本和日志分层治理。真实客户媒体不得进入开发、测试、分析或 Agent 证据。删除链路覆盖 CDN、缓存、供应商、连接器、搜索索引和备份索引，并输出机器可查的删除收据。

## 7. 部署与韧性

本地以可替换沙箱启动；生产通过 IaC、密钥管理、SBOM、签名制品、数据库兼容迁移、特性开关、灰度/回滚、容量和灾备门。多区域设计要明确数据驻留、控制面/媒体面位置、CDN、DNS、支付/短信/AI/印刷供应商可用区和故障切换。
