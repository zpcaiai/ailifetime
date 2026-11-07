# 架构与边界

**前端**：微信原生小程序或 uni-app 微信端（决策前做相册 API、canvas 文字、支付、分享能力的 PoC）；管理后台可用 Vue/React。不要把小程序的用户隐私授权简单等同于业务授权。

**后端建议**：Java 21 + Spring Boot（以目标兼容版本为准），PostgreSQL、Redis（非真相源）、S3 兼容私有桶、持久化消息队列（可用 NATS JetStream 或 RabbitMQ）、OpenTelemetry。

**服务边界**：Identity/Consent、Template Catalog、Media Vault、Generation Orchestrator、Deterministic Renderer、Orders & Entitlement、Archive & Timeline、Content Safety、Admin/Audit。首期模块化单体 + 独立 worker 即可；不先拆 9 个微服务。

**流程**：Upload→Scan→Consent verification→GenerationJob→AI provider→Quality gate→Text overlay→AI labeling→Private storage→Preview→Payment entitlement check→Export→Audit & Evidence。

**AI provider**：provider interface `{submit, poll/getResult, cancel, quoteCost}`；带模型标识、版本、PromptTemplate 修订、地域、数据处理条款、费用预估；失败回退不能改变用户已确认的费用。

**渲染**：模板 manifest + field schema + layout + style tokens + user data + raster media → output PNG/WebP/PDF(optional)。必须使用离屏实际尺寸渲染、确定性字体、二维码库和布局测量；输出带 template_revision、renderer_revision、input_digest、media_digest。

**多端扩展**：API/领域规则在后端；端能力由 adapter 判断，不允许前端越权启用支付或分享。

**数据一致性**：Postgres 真相源；事务 outbox 发送消息，worker 幂等消费；S3 对象内容寻址/版本索引，不依赖数据库事务跨 S3 原子提交，使用 saga 与清理补偿。
