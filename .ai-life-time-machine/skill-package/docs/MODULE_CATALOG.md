# 商业级模块目录

参考模块不是强制目录。B00/B01 必须先映射既有仓库；模块名用于定义能力边界和所有权。

## AI 人生时光机总控编排

Skill: `orchestrating-life-time-machine`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B00 | 仓库发现、现状审计与可执行基线 | `tools/repo-inspector`, `docs/baseline`, `evidence/baseline`, `scripts/dev-doctor` | git status/diff/log, build manifests, test commands, runtime health endpoints |
| B50 | 多 Agent、Worktree、PR 与断点续作编排 | `scripts/orchestrate-batches`, `orchestration/state`, `orchestration/locks`, `templates/agent-handoff` | batch state file, worktree plan, completion report, PR metadata |

## 平台与核心基础设施

Skill: `bootstrapping-life-time-machine-platform`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B01 | Monorepo、服务边界与本地开发底座 | `apps/consumer-web`, `apps/partner-portal`, `apps/admin-console`, `services/control-plane`, `services/media-worker`, `packages/contracts`, `infra/local` | Gradle/npm/pnpm/uv workspaces, Docker Compose, health/readiness endpoints |
| B02 | 领域模型、数据库、API 与事件契约 | `packages/contracts`, `services/control-plane/domain`, `db/migrations`, `contracts/openapi`, `contracts/events` | OpenAPI 3.1, JSON Schema, CloudEvents-like envelope, PostgreSQL migrations |
| B03 | 身份认证、RBAC/ABAC 与租户隔离 | `services/identity`, `services/authorization`, `packages/auth-client`, `apps/*/middleware`, `db/rls` | OIDC/OAuth2, session API, service credentials, permission decision API |
| B04 | 同意、肖像授权、监护与数据主体权利 | `services/consent`, `services/privacy-rights`, `apps/consent-ui`, `packages/policy-engine` | consent API, guardian verification, rights request API, consent receipt |
| B05 | 媒体资产生命周期、加密与可验证删除 | `services/media-vault`, `services/deletion-orchestrator`, `storage/policies`, `packages/signed-url` | multipart upload, signed URL, asset manifest, deletion receipt API |
| B12 | 图像/视频/LLM/审核供应商抽象与路由 | `services/provider-gateway`, `packages/provider-contracts`, `services/model-registry`, `services/provider-evals` | generate image/video/text, moderate, delete asset, health/capability API |
| B13 | 持久化工作流、队列与补偿事务 | `services/workflow`, `services/queue`, `packages/idempotency`, `services/scheduler` | workflow commands, activity contracts, dead-letter/replay API, scheduler |

## 消费者人生时光机

Skill: `building-consumer-time-machine`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B06 | 获客落地页、匿名体验与账户升级 | `apps/consumer-web/landing`, `services/guest-session`, `packages/attribution`, `packages/feature-flags` | guest session API, campaign attribution, consent preflight, deep links |
| B07 | 照片采集、人物检测与质量预检 | `apps/consumer-web/uploader`, `services/media-preflight`, `services/quality-check`, `packages/capture-guide` | upload session API, quality score API, participant declaration |
| B08 | 年龄轴编辑器、模板与场景编排 | `apps/consumer-web/editor`, `services/template-catalog`, `packages/composition-schema`, `apps/admin/template-studio` | template API, composition draft API, preview manifest |
| B09 | 生成任务、进度、取消与恢复 | `services/generation-control`, `apps/consumer-web/job-status`, `packages/job-state-machine`, `services/notification` | generation jobs API, SSE/WebSocket/polling, cancel/retry API |
| B10 | 作品导出、可撤销分享与 AI 标识 | `services/share`, `services/export`, `packages/provenance`, `apps/consumer-web/gallery` | share API, export API, revocation endpoint, metadata verifier |
| B11 | 账户、家庭作品库与资产归档 | `services/library`, `apps/consumer-web/library`, `services/household`, `packages/storage-quota` | library API, album API, household invitation, quota API |

## 年龄影像生成流水线

Skill: `building-age-media-pipeline`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B14 | 0–100 岁示意性年龄时间轴生成 | `services/media-worker/age-timeline`, `services/prompt-policy`, `packages/timeline-plan`, `services/result-assembler` | timeline plan schema, provider image API, generation artifact manifest |
| B15 | 身份一致性、年龄合理性与质量门控 | `services/quality-engine`, `services/identity-consistency`, `apps/admin/quality-review`, `evals/golden-set` | quality report schema, publish gate API, review queue |
| B16 | 年龄变化视频、音频与字幕流水线 | `services/media-worker/video`, `services/media-worker/audio`, `packages/timeline-renderer`, `services/transcode` | render job API, audio/caption manifest, transcode profiles |
| B17 | 内容安全、来源证明与生成合成标识 | `services/safety-policy`, `services/provenance`, `services/moderation`, `packages/content-label` | preflight moderation, post-generation moderation, C2PA/metadata adapter, report API |
| B18 | 成本、延迟、配额与安全缓存 | `services/cost-engine`, `services/quota`, `services/cache`, `apps/admin/cost-console` | cost estimate API, quota reservation, provider budget policy, usage ledger |

## 家庭关系与未来自我

Skill: `building-family-future-self`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B19 | 家庭关系图、成员邀请与逐人同意 | `services/family-graph`, `apps/consumer-web/family`, `services/invitations`, `packages/relationship-policy` | family graph API, participant invitation, consent status matrix |
| B20 | 多人家庭场景与共同变老作品 | `services/media-worker/multi-person`, `services/scene-layout`, `apps/consumer-web/family-composer`, `evals/family-golden-set` | participant slot schema, scene generation API, multi-person quality report |
| B21 | 儿童与青少年专属安全机制 | `services/child-safety`, `packages/age-assurance`, `apps/guardian-center`, `services/child-retention` | guardian consent API, minor policy decision, restricted share API |
| B22 | 未来自我故事、信件与目标可视化 | `services/future-self`, `services/narrative-policy`, `apps/consumer-web/time-capsule`, `packages/story-schema` | future-self profile API, narrative generation, time-capsule schedule |
| B23 | 未来自我对话与拟人化交互安全 | `services/future-dialogue`, `services/dialogue-safety`, `apps/consumer-web/dialogue`, `services/crisis-routing` | conversation API, memory controls, safety classifier, session limits |
| B24 | 年度更新、家庭仪式与长期档案 | `services/rituals`, `services/annual-refresh`, `apps/consumer-web/archive`, `services/scheduler` | ritual subscription API, annual refresh job, archive export |

## 交易、订阅与履约

Skill: `building-commerce-fulfillment`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B25 | 商品目录、套餐、定价与权益 | `services/catalog`, `services/pricing`, `apps/admin/catalog`, `packages/entitlements` | catalog API, price quote API, entitlement schema, promotion rules |
| B26 | 结账、支付、退款与财务一致性 | `services/checkout`, `services/payment`, `services/ledger`, `apps/consumer-web/checkout` | checkout session API, payment provider webhooks, refund API, ledger entries |
| B27 | 订阅、额度、礼品码与权益生命周期 | `services/subscription`, `services/credits`, `services/gifts`, `apps/consumer-web/billing` | subscription API, credit ledger, gift redemption, billing portal |
| B28 | 订单、数字作品交付与许可证 | `services/order`, `services/delivery`, `apps/consumer-web/orders`, `packages/license-policy` | order API, delivery manifest, download entitlement, invoice receipt |
| B29 | 照片书、相框、卡片与实物履约 | `services/print-preflight`, `services/fulfillment`, `services/shipping`, `apps/consumer-web/product-customizer` | print-ready manifest, vendor order API, shipment webhooks, reprint API |
| B30 | 客服、退款、争议与补救工作台 | `apps/admin/support`, `services/case-management`, `services/refund-policy`, `packages/redaction` | support case API, customer timeline, compensation decision, audit trail |

## B2B2C 合作伙伴平台

Skill: `building-partner-platform`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B31 | 伙伴组织、多租户控制面与数据隔离 | `services/partner`, `services/tenant-config`, `apps/partner-portal`, `db/partner-rls` | partner API, organization hierarchy, tenant policy, partner audit API |
| B32 | 伙伴入驻、合同、配置与品牌化 | `services/partner-onboarding`, `apps/partner-portal/onboarding`, `services/config-approval`, `templates/partner-launch` | onboarding checklist, contract metadata API, brand assets API, launch gate |
| B33 | 伙伴 API、SDK、Webhook 与 SSO | `services/partner-api`, `sdk/typescript`, `sdk/java`, `sdk/python`, `services/webhook`, `services/sso` | OAuth2 client credentials, REST API, signed webhooks, OIDC/SAML SSO |
| B34 | 用量计量、伙伴结算与收入分成 | `services/metering`, `services/settlement`, `services/reconciliation`, `apps/partner-portal/finance` | usage ledger, settlement statement API, invoice export, adjustment workflow |

## 渠道解决方案

Skill: `building-channel-solutions`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B35 | 影楼工作台、门店流程与自助终端 | `apps/partner-portal/studio`, `apps/kiosk`, `services/studio-workflow`, `services/device-management` | studio session API, kiosk pairing, customer approval link, batch order API |
| B36 | 纪念礼品、电商与零售渠道方案 | `services/gift-channel`, `apps/gift-builder`, `services/recipient-consent`, `packages/memorial-policy` | gift order API, recipient claim link, occasion templates, memorial review |
| B37 | 保险与养老平台的未来自我教育场景 | `services/retirement-education`, `apps/partner-portal/education`, `packages/regulated-boundary`, `services/content-review` | education session API, scenario library, lead consent boundary, compliance review |
| B38 | 明确同意的 CRM 线索交接与销售边界 | `services/lead-consent`, `services/crm-handoff`, `apps/partner-portal/leads`, `packages/marketing-policy` | lead request API, CRM connector, consent receipt, suppression API |

## 增长、留存与数据闭环

Skill: `building-growth-data-loop`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B39 | 推荐、联盟、UGC 分享与反作弊 | `services/referral`, `services/affiliate`, `services/ugc`, `services/abuse-detection` | referral API, affiliate attribution, reward ledger, UGC moderation |
| B40 | 生命周期消息、年度回访与流失挽回 | `services/lifecycle`, `services/notification-preferences`, `services/campaigns`, `apps/admin/campaign-builder` | preference center, campaign eligibility, message send API, suppression events |
| B41 | 分析语义层、漏斗与单位经济 | `services/analytics`, `warehouse/semantic-layer`, `apps/admin/analytics`, `packages/event-quality` | analytics events, metric definitions, finance reconciliation, privacy-safe exports |
| B42 | 个性化、推荐与受控实验 | `services/personalization`, `services/experimentation`, `packages/decision-log`, `apps/admin/experiments` | decision API, experiment assignment, feature store policy, experiment analysis |
| B43 | 运营后台、审核、风控与内部治理 | `apps/admin-console`, `services/moderation-queue`, `services/fraud`, `services/config-governance` | admin API, case queue, policy decision, configuration change request |

## 安全、隐私与生产运营

Skill: `securing-operating-life-time-machine`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B44 | 隐私工程、安全基线与合规控制 | `services/policy-engine`, `security/threat-models`, `privacy/ropa`, `security/scanners`, `compliance/control-matrix` | policy decision API, data map, PIA/DPIA templates, control evidence |
| B45 | 可观测性、SLO、容量与成本运营 | `observability/otel`, `services/slo`, `apps/admin/operations`, `services/cost-alerting` | OpenTelemetry traces/metrics/logs, SLO definitions, alert routes, runbooks |
| B46 | 备份、灾备、事件响应与删除证明 | `infra/backup`, `infra/dr`, `security/incident-response`, `services/deletion-verifier` | backup catalog, restore test, incident workflow, deletion verification report |
| B47 | CI/CD、IaC、供应链与可回滚发布 | `.github/workflows`, `infra/iac`, `scripts/release`, `security/supply-chain`, `deploy/manifests` | CI checks, artifact registry, migration gate, deployment API |

## 商业闭环与生产发布认证

Skill: `certifying-life-time-machine-release`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B48 | 端到端商业闭环、渠道与滥用认证 | `e2e/business-loop`, `e2e/channel`, `e2e/abuse`, `e2e/recovery`, `fixtures/synthetic` | browser/API E2E, payment sandbox, provider stubs, partner sandbox |
| B49 | 发布证据、清洁室复现与生产认证 | `evidence/release`, `scripts/verify-release`, `templates/release-certificate`, `docs/traceability` | completion reports, evidence index, release certificate, risk acceptance |

## 产品战略、研究、体验与设计系统

Skill: `designing-life-time-machine-experience`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B51 | 产品配置档、范围治理与成功指标 | `docs/product-profile`, `config/product-profile`, `tools/profile-validator` | project-profile schema, module catalog, KPI contract, release scope |
| B52 | 用户研究、角色画像与服务蓝图 | `docs/research`, `docs/personas`, `docs/service-blueprints` | research repository, persona schema, journey map, service recovery map |
| B53 | 信息架构、导航与内容模型 | `packages/information-architecture`, `packages/content-model`, `docs/navigation` | route map, content schema, entity glossary, permission-aware navigation |
| B54 | 设计系统、设计令牌与组件库 | `packages/design-tokens`, `packages/web-ui`, `packages/mobile-ui`, `apps/storybook` | design tokens, component API, icon system, storybook/catalog |
| B55 | 无障碍、响应式、本地化与时区货币 | `packages/i18n`, `packages/accessibility`, `packages/locale-runtime` | translation catalog, locale negotiation, currency/time formatting, accessibility test harness |
| B56 | 体验治理、可用性、文案与视觉质量门 | `docs/ux-governance`, `tests/visual`, `tests/usability`, `packages/copy-registry` | UX review gate, copy registry, visual baselines, task success metrics |

## 营销站、CMS、品牌与获客平台

Skill: `building-marketing-content-platform`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B57 | 营销官网、SEO、性能与落地页构建器 | `apps/marketing-web`, `packages/landing-builder`, `packages/seo` | CMS page contract, SEO metadata, structured data, lead/guest session |
| B58 | Headless CMS、博客与编辑工作流 | `services/content`, `apps/editorial-console`, `packages/content-sdk` | content API, workflow state machine, preview tokens, translation jobs |
| B59 | 同意管理、Cookie、像素与隐私归因 | `packages/consent-manager`, `services/attribution`, `apps/privacy-center` | CMP API, consent string, tag manager policy, attribution event |
| B60 | 活动、深链、UTM、二维码与渠道归因 | `services/campaign`, `packages/deep-links`, `apps/campaign-console` | campaign API, deep-link resolver, QR token, attribution handoff |
| B61 | 社交分享、OG、UGC 模板与媒体素材 | `services/share-card`, `packages/og-renderer`, `apps/media-kit` | share manifest, OG renderer, UGC template, revocation endpoint |
| B62 | 品牌中心、信任中心、状态页与销售资料 | `apps/trust-center`, `apps/status-page`, `apps/brand-center`, `docs/sales-enablement` | status API, security document catalog, brand asset API, sales content approval |

## iOS/Android App 与微信小程序

Skill: `building-mobile-and-mini-programs`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B63 | 移动端架构、认证、导航与离线基础 | `apps/mobile`, `packages/mobile-core`, `packages/mobile-api-client` | mobile session API, navigation manifest, offline cache, remote config |
| B64 | 移动端拍摄、质量预检与断点上传 | `apps/mobile/features/capture`, `packages/mobile-upload`, `services/upload-session` | camera/photo picker, quality preflight, multipart upload, background task |
| B65 | 移动端编辑、生成进度、作品库与导出 | `apps/mobile/features/editor`, `apps/mobile/features/library`, `packages/mobile-media-player` | timeline contract, generation status stream, library API, share/export manifest |
| B66 | 移动端内购、订阅与权益恢复 | `apps/mobile/features/paywall`, `services/iap-verification`, `packages/entitlements` | store product mapping, receipt verification, server notifications, restore purchases |
| B67 | 移动推送、深链、组件与分享扩展 | `apps/mobile/push`, `apps/mobile/widgets`, `apps/mobile/share-extension`, `services/deep-link` | device token registry, push payload, universal/app links, widget snapshot |
| B68 | 移动端隐私、安全、性能与无障碍加固 | `apps/mobile/security`, `apps/mobile/performance`, `tests/mobile-security` | certificate pinning policy, secure storage, privacy manifest, device test matrix |
| B69 | 应用商店打包、审核与发布流水线 | `infra/mobile-release`, `docs/app-store`, `pipelines/mobile` | signing assets, store metadata, release train, crash/rollout gates |
| B70 | 微信小程序登录、上传、编辑与生成 | `apps/wechat-mini-program`, `services/wechat-session`, `packages/mini-api-client` | WeChat login, upload session, timeline API, generation status |
| B71 | 微信支付、分享、客服与服务通知 | `services/wechat-pay`, `apps/wechat-mini-program/commerce`, `services/wechat-messaging` | JSAPI payment, payment callback, share card, customer service handoff, subscription message |
| B72 | 小程序隐私、合规、审核与发布 | `docs/wechat-release`, `pipelines/mini-program`, `apps/wechat-mini-program/privacy` | privacy interface, release metadata, review account, version rollout |

## 消息通知与用户生命周期平台

Skill: `building-notification-lifecycle-platform`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B73 | 通知偏好、同意、安静时段与频控 | `services/notification-preferences`, `apps/notification-center`, `packages/contact-policy` | preference API, purpose consent, quiet-hours policy, contact eligibility |
| B74 | 邮件、短信、推送、微信与站内信供应商路由 | `services/notification-router`, `adapters/email`, `adapters/sms`, `adapters/push`, `adapters/wechat` | send command, provider callback, delivery event, routing policy |
| B75 | 通知模板、变量安全、本地化与渲染 | `services/template-renderer`, `apps/template-console`, `packages/message-schemas` | template API, typed variables, render preview, approval workflow |
| B76 | 生命周期旅程、调度与状态编排 | `services/journey-orchestrator`, `apps/journey-console`, `packages/audience-evaluator` | journey definition, trigger event, wait state, exit criteria |
| B77 | 送达率、退信投诉与供应商故障治理 | `services/deliverability`, `apps/deliverability-console`, `runbooks/notifications` | suppression list, domain health, provider health, delivery SLO |
| B78 | 通知分析、实验、频率与增量效果 | `analytics/notifications`, `services/contact-frequency`, `apps/message-insights` | message fact table, holdout assignment, frequency ledger, incrementality report |

## 帮助中心、客服、CRM 与客户成功

Skill: `building-customer-support-success`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B79 | 帮助中心、FAQ、搜索与自助排障 | `apps/help-center`, `services/help-search`, `packages/help-widget` | help content API, search index, contextual help, article feedback |
| B80 | 客服工单、全渠道收件箱、SLA 与路由 | `services/support`, `apps/support-console`, `packages/support-routing` | ticket API, inbound adapters, SLA policy, assignment event |
| B81 | 站内帮助、客服机器人与人工接管 | `services/support-assistant`, `apps/support-widget`, `packages/handoff` | knowledge retrieval, support tool API, handoff summary, conversation retention |
| B82 | 客户 360、时间线与受控代操作 | `services/customer-360`, `apps/support-console/customer`, `packages/impersonation-control` | customer summary API, timeline event, field masking, support session |
| B83 | 客服动作、退款补发与数据权利协同 | `services/support-actions`, `apps/support-console/actions`, `workflows/remediation` | action preview, approval policy, ledger/order command, data-rights handoff |
| B84 | 伙伴销售 CRM、线索、商机与报价 | `services/partner-crm`, `apps/sales-console`, `packages/quote-engine` | lead API, opportunity stage, quote/version, sales activity |
| B85 | 客户成功、伙伴启用、健康度与续约 | `services/customer-success`, `apps/cs-console`, `packages/account-health` | onboarding plan, account health, QBR report, renewal event |
| B86 | CSAT、NPS、VOC 与客服质量管理 | `services/feedback`, `apps/quality-console`, `analytics/voc` | survey API, quality rubric, root-cause taxonomy, improvement backlog |

## 财务账本、对账、开票、税务与 FinOps

Skill: `building-finance-tax-operations`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B87 | 复式账本、业务分录与不可变审计 | `services/ledger`, `packages/money`, `apps/finance-console` | journal entry, account chart, posting rule, balance query |
| B88 | 支付、伙伴结算与银行对账 | `services/reconciliation`, `apps/finance-console/reconciliation`, `adapters/payment-statements` | statement import, matching rule, reconciliation case, cash settlement |
| B89 | 发票、收据、电子发票与税务配置 | `services/invoicing`, `apps/billing-portal`, `adapters/e-invoice` | tax profile, invoice request, invoice document, credit note |
| B90 | 收入确认、递延收入、额度与礼品负债 | `services/revenue-recognition`, `analytics/revenue`, `apps/finance-console/revenue` | performance obligation, recognition schedule, credit liability, contract modification |
| B91 | 拒付、争议、欺诈损失与准备金 | `services/disputes`, `apps/risk-console`, `analytics/loss-reserve` | dispute case, evidence packet, risk signal, reserve entry |
| B92 | 伙伴付款、佣金、分成与扣缴单据 | `services/payouts`, `apps/partner-portal/payouts`, `apps/finance-console/payouts` | commission rule, payout statement, payment instruction, withholding document |
| B93 | 预算、FinOps、成本分摊与盈利分析 | `services/cost-allocation`, `analytics/finops`, `apps/finance-console/budget` | cost event, allocation rule, budget policy, profitability cube |
| B94 | 月结、审计导出与会计系统集成 | `services/finance-close`, `adapters/accounting`, `docs/finance-runbooks` | close checklist, trial balance export, journal export, audit package |

## 照片书、相框与实物供应链

Skill: `building-physical-supply-network`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B95 | 印刷商品配置器、版式、出血与色彩预检 | `packages/print-configurator`, `services/render-preflight`, `apps/product-designer` | product specification, layout document, print-ready asset, preflight report |
| B96 | 供应商入驻、目录、价格、产能与 SLA | `services/vendor-management`, `apps/vendor-portal`, `packages/vendor-capabilities` | vendor profile, capability catalog, price book, capacity calendar, SLA contract |
| B97 | 生产打样、校样与客户批准 | `services/proofing`, `apps/proof-approval`, `workflows/production-approval` | proof asset, approval decision, change request, production lock |
| B98 | 订单路由、采购单与供应商生产任务 | `services/fulfillment-router`, `services/purchase-orders`, `workflows/vendor-job` | routing decision, purchase order, vendor job API, production event |
| B99 | 地址校验、承运商、发货与物流追踪 | `services/shipping`, `adapters/carriers`, `apps/order-tracking` | address validation, shipping quote, label purchase, tracking event |
| B100 | 库存、耗材、可售量与预售 | `services/inventory`, `apps/vendor-portal/inventory`, `packages/availability` | stock item, reservation, availability promise, inventory adjustment |
| B101 | 退货、补发、破损、丢件与理赔 | `services/returns`, `workflows/replacement`, `apps/support-console/physical-claims` | return authorization, claim evidence, replacement order, carrier/vendor claim |
| B102 | 供应商质量、SLA、评分与结算协同 | `analytics/vendor-performance`, `services/vendor-scorecard`, `apps/vendor-portal/quality` | quality event, SLA calculation, scorecard, service credit |

## 开发者门户、SDK、Webhook 与连接器

Skill: `building-developer-integration-platform`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B103 | 开发者门户、API 文档与沙箱 | `apps/developer-portal`, `services/developer-sandbox`, `docs/api` | OpenAPI docs, sandbox tenant, sample data, quickstart |
| B104 | API 密钥、OAuth、服务账户与细粒度 Scope | `services/developer-identity`, `apps/developer-portal/credentials`, `packages/scopes` | API key, OAuth client, service account, token scope, credential rotation |
| B105 | 多语言 SDK 生成、版本与示例工程 | `sdks/typescript`, `sdks/java`, `sdks/python`, `sdks/mobile`, `examples/integrations` | SDK generator, semantic version, retry/idempotency middleware, sample app |
| B106 | Webhook 控制台、签名、重放与死信 | `services/webhook-delivery`, `apps/developer-portal/webhooks`, `packages/webhook-signing` | endpoint registry, signed delivery, attempt log, replay request, DLQ |
| B107 | 连接器框架与集成市场 | `platform/connectors`, `apps/integration-marketplace`, `services/connector-runtime` | connector manifest, OAuth install, sync job, mapping schema, health event |
| B108 | CRM、CDP、营销、客服与会计适配器 | `connectors/crm`, `connectors/cdp`, `connectors/marketing`, `connectors/support`, `connectors/accounting` | contact/lead mapping, event export, ticket sync, journal/invoice export |
| B109 | 伙伴测试工具、合成数据与集成认证 | `tools/partner-test-harness`, `services/sandbox-scenarios`, `apps/developer-portal/certification` | scenario catalog, test run, conformance report, certification record |
| B110 | API 生命周期、弃用、变更日志与支持 SLA | `services/api-governance`, `apps/developer-portal/changelog`, `docs/deprecation` | compatibility report, deprecation notice, version usage, partner support SLA |

## 数据平台、指标、实验与模型评估

Skill: `building-data-intelligence-platform`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B111 | 事件分类、埋点 SDK 与 Schema Registry | `packages/analytics-schema`, `packages/tracking-web`, `packages/tracking-mobile`, `services/event-registry` | event schema, tracking context, schema compatibility, data contract |
| B112 | 数据采集、仓库、转换与语义层 | `data/ingestion`, `data/warehouse`, `data/dbt`, `data/semantic-layer` | source connector, raw/staging/mart models, metric definition, incremental cursor |
| B113 | 产品、交易、伙伴与运营仪表板 | `apps/analytics-portal`, `data/marts`, `docs/dashboard-catalog` | dashboard definition, metric query, row-level security, alert subscription |
| B114 | 归因、队列、留存与 LTV 分析 | `data/marts/growth`, `analytics/attribution`, `analytics/cohorts` | attribution model, cohort definition, retention curve, LTV model |
| B115 | 收入、AI/履约成本与单位经济 | `data/marts/unit-economics`, `analytics/margin`, `services/cost-insights` | unit economics model, cost allocation, contribution margin, scenario input |
| B116 | 实验平台、统计与安全护栏 | `services/experimentation`, `packages/assignment-sdk`, `apps/experiment-console` | experiment definition, assignment, exposure event, analysis plan |
| B117 | 数据质量、血缘、目录与 PII 治理 | `data/catalog`, `data/quality`, `services/data-governance` | asset catalog, lineage graph, quality rule, access policy, deletion propagation |
| B118 | AI 模型评测、漂移、基准与人工评分 | `evals/model-benchmarks`, `services/model-registry`, `apps/ai-quality-console` | model version, evaluation dataset, grader result, production drift, human review |

## 企业级配置、韧性、性能与合规证据

Skill: `hardening-enterprise-platform`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B119 | 环境、配置、秘密与租户设置治理 | `platform/config`, `platform/secrets`, `apps/admin/config` | configuration schema, secret reference, tenant override, change approval |
| B120 | 多区域、中国/全球拓扑、CDN 与域名 | `infra/regions`, `infra/cdn`, `infra/dns`, `docs/data-residency` | region routing, data residency policy, asset replication, domain/certificate lifecycle |
| B121 | 性能、压力、容量与自动扩缩容 | `tests/performance`, `infra/autoscaling`, `docs/capacity-model` | load profile, capacity forecast, autoscaling policy, performance budget |
| B122 | 韧性、混沌、依赖故障与切换 | `tests/chaos`, `platform/failover`, `runbooks/dependencies` | fault scenario, recovery objective, failover policy, game-day evidence |
| B123 | 软件供应链、SBOM、SAST/DAST 与渗透测试 | `security/scanners`, `security/pentest`, `pipelines/security` | SBOM, SAST/SCA/secret scan, DAST/API scan, mobile scan, finding lifecycle |
| B124 | 合规证据、记录、备案评估与审计导出 | `compliance/control-library`, `apps/compliance-console`, `evidence/compliance` | control record, evidence artifact, applicability assessment, audit export |

## 完整商业项目集成、E2E 与分阶段上线

Skill: `launching-complete-commercial-product`

| Batch | 能力 | 参考模块 | 关键接口 |
|---|---|---|---|
| B125 | 商业运营、政策、团队与供应商上线准备 | `docs/commercial-readiness`, `runbooks/launch`, `evidence/readiness` | readiness checklist, RACI, policy publication, vendor/partner approval |
| B126 | 全终端、全渠道与周边系统商业 E2E 认证 | `e2e/full-commercial`, `evidence/commercial-e2e`, `tools/clean-room` | scenario suite, cross-system assertion, financial control total, deletion proof |
| B127 | 分阶段生产发布、市场上线与最终证书 | `pipelines/release-train`, `evidence/release`, `docs/go-live` | release manifest, rollout wave, go/no-go decision, commercial certificate |
