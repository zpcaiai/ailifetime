# Package Inventory

- Package: `ai-life-time-machine-commercial-project-factory`
- Version: `2.0.0`
- Skills: **22**
- Batches: **128 (B00–B127)**
- Requirements: **640**
- Profiles: **7**
- Stack profiles: **4**

## Skills

| Skill | Title | Batches | IDs |
|---|---|---:|---|
| `orchestrating-life-time-machine` | AI 人生时光机总控编排 | 2 | B00, B50 |
| `bootstrapping-life-time-machine-platform` | 平台与核心基础设施 | 7 | B01, B02, B03, B04, B05, B12, B13 |
| `building-consumer-time-machine` | 消费者人生时光机 | 6 | B06, B07, B08, B09, B10, B11 |
| `building-age-media-pipeline` | 年龄影像生成流水线 | 5 | B14, B15, B16, B17, B18 |
| `building-family-future-self` | 家庭关系与未来自我 | 6 | B19, B20, B21, B22, B23, B24 |
| `building-commerce-fulfillment` | 交易、订阅与履约 | 6 | B25, B26, B27, B28, B29, B30 |
| `building-partner-platform` | B2B2C 合作伙伴平台 | 4 | B31, B32, B33, B34 |
| `building-channel-solutions` | 渠道解决方案 | 4 | B35, B36, B37, B38 |
| `building-growth-data-loop` | 增长、留存与数据闭环 | 5 | B39, B40, B41, B42, B43 |
| `securing-operating-life-time-machine` | 安全、隐私与生产运营 | 4 | B44, B45, B46, B47 |
| `certifying-life-time-machine-release` | 商业闭环与生产发布认证 | 2 | B48, B49 |
| `designing-life-time-machine-experience` | 产品战略、研究、体验与设计系统 | 6 | B51, B52, B53, B54, B55, B56 |
| `building-marketing-content-platform` | 营销站、CMS、品牌与获客平台 | 6 | B57, B58, B59, B60, B61, B62 |
| `building-mobile-and-mini-programs` | iOS/Android App 与微信小程序 | 10 | B63, B64, B65, B66, B67, B68, B69, B70, B71, B72 |
| `building-notification-lifecycle-platform` | 消息通知与用户生命周期平台 | 6 | B73, B74, B75, B76, B77, B78 |
| `building-customer-support-success` | 帮助中心、客服、CRM 与客户成功 | 8 | B79, B80, B81, B82, B83, B84, B85, B86 |
| `building-finance-tax-operations` | 财务账本、对账、开票、税务与 FinOps | 8 | B87, B88, B89, B90, B91, B92, B93, B94 |
| `building-physical-supply-network` | 照片书、相框与实物供应链 | 8 | B95, B96, B97, B98, B99, B100, B101, B102 |
| `building-developer-integration-platform` | 开发者门户、SDK、Webhook 与连接器 | 8 | B103, B104, B105, B106, B107, B108, B109, B110 |
| `building-data-intelligence-platform` | 数据平台、指标、实验与模型评估 | 8 | B111, B112, B113, B114, B115, B116, B117, B118 |
| `hardening-enterprise-platform` | 企业级配置、韧性、性能与合规证据 | 6 | B119, B120, B121, B122, B123, B124 |
| `launching-complete-commercial-product` | 完整商业项目集成、E2E 与分阶段上线 | 3 | B125, B126, B127 |

## Batches

| Batch | Phase | Skill | Title | Dependencies |
|---|---|---|---|---|
| B00 | P0-discovery | `orchestrating-life-time-machine` | 仓库发现、现状审计与可执行基线 | none |
| B01 | P1-foundation | `bootstrapping-life-time-machine-platform` | Monorepo、服务边界与本地开发底座 | B00 |
| B02 | P1-foundation | `bootstrapping-life-time-machine-platform` | 领域模型、数据库、API 与事件契约 | B01 |
| B03 | P1-foundation | `bootstrapping-life-time-machine-platform` | 身份认证、RBAC/ABAC 与租户隔离 | B01, B02 |
| B04 | P1-foundation | `bootstrapping-life-time-machine-platform` | 同意、肖像授权、监护与数据主体权利 | B02, B03 |
| B05 | P1-foundation | `bootstrapping-life-time-machine-platform` | 媒体资产生命周期、加密与可验证删除 | B01, B02, B04 |
| B06 | P2-consumer | `building-consumer-time-machine` | 获客落地页、匿名体验与账户升级 | B02, B03, B04 |
| B07 | P2-consumer | `building-consumer-time-machine` | 照片采集、人物检测与质量预检 | B05, B06 |
| B08 | P2-consumer | `building-consumer-time-machine` | 年龄轴编辑器、模板与场景编排 | B07 |
| B09 | P2-consumer | `building-consumer-time-machine` | 生成任务、进度、取消与恢复 | B08, B12, B13 |
| B10 | P2-consumer | `building-consumer-time-machine` | 作品导出、可撤销分享与 AI 标识 | B09, B17 |
| B11 | P2-consumer | `building-consumer-time-machine` | 账户、家庭作品库与资产归档 | B03, B10 |
| B12 | P1-foundation | `bootstrapping-life-time-machine-platform` | 图像/视频/LLM/审核供应商抽象与路由 | B01, B02 |
| B13 | P1-foundation | `bootstrapping-life-time-machine-platform` | 持久化工作流、队列与补偿事务 | B01, B02, B12 |
| B14 | P3-media | `building-age-media-pipeline` | 0–100 岁示意性年龄时间轴生成 | B07, B12, B13 |
| B15 | P3-media | `building-age-media-pipeline` | 身份一致性、年龄合理性与质量门控 | B14 |
| B16 | P3-media | `building-age-media-pipeline` | 年龄变化视频、音频与字幕流水线 | B14, B15 |
| B17 | P3-media | `building-age-media-pipeline` | 内容安全、来源证明与生成合成标识 | B04, B05, B14, B16 |
| B18 | P3-media | `building-age-media-pipeline` | 成本、延迟、配额与安全缓存 | B12, B13, B14, B15, B16 |
| B19 | P4-family | `building-family-future-self` | 家庭关系图、成员邀请与逐人同意 | B04, B11 |
| B20 | P4-family | `building-family-future-self` | 多人家庭场景与共同变老作品 | B15, B19 |
| B21 | P4-family | `building-family-future-self` | 儿童与青少年专属安全机制 | B04, B17, B19 |
| B22 | P4-family | `building-family-future-self` | 未来自我故事、信件与目标可视化 | B11, B17 |
| B23 | P4-family | `building-family-future-self` | 未来自我对话与拟人化交互安全 | B17, B22 |
| B24 | P4-family | `building-family-future-self` | 年度更新、家庭仪式与长期档案 | B11, B20, B22, B23 |
| B25 | P5-commerce | `building-commerce-fulfillment` | 商品目录、套餐、定价与权益 | B02, B03 |
| B26 | P5-commerce | `building-commerce-fulfillment` | 结账、支付、退款与财务一致性 | B13, B25 |
| B27 | P5-commerce | `building-commerce-fulfillment` | 订阅、额度、礼品码与权益生命周期 | B25, B26 |
| B28 | P5-commerce | `building-commerce-fulfillment` | 订单、数字作品交付与许可证 | B09, B10, B26, B27 |
| B29 | P5-commerce | `building-commerce-fulfillment` | 照片书、相框、卡片与实物履约 | B28 |
| B30 | P5-commerce | `building-commerce-fulfillment` | 客服、退款、争议与补救工作台 | B26, B28, B29 |
| B31 | P6-partner | `building-partner-platform` | 伙伴组织、多租户控制面与数据隔离 | B02, B03, B04 |
| B32 | P6-partner | `building-partner-platform` | 伙伴入驻、合同、配置与品牌化 | B31, B04, B05 |
| B33 | P6-partner | `building-partner-platform` | 伙伴 API、SDK、Webhook 与 SSO | B13, B31, B32 |
| B34 | P6-partner | `building-partner-platform` | 用量计量、伙伴结算与收入分成 | B25, B26, B31, B33 |
| B35 | P7-channels | `building-channel-solutions` | 影楼工作台、门店流程与自助终端 | B08, B28, B31, B32, B33 |
| B36 | P7-channels | `building-channel-solutions` | 纪念礼品、电商与零售渠道方案 | B24, B28, B29, B31, B32 |
| B37 | P7-channels | `building-channel-solutions` | 保险与养老平台的未来自我教育场景 | B22, B23, B31, B32 |
| B38 | P7-channels | `building-channel-solutions` | 明确同意的 CRM 线索交接与销售边界 | B31, B32, B33, B37 |
| B39 | P8-growth | `building-growth-data-loop` | 推荐、联盟、UGC 分享与反作弊 | B10, B27, B31, B33 |
| B40 | P8-growth | `building-growth-data-loop` | 生命周期消息、年度回访与流失挽回 | B24, B27 |
| B41 | P8-growth | `building-growth-data-loop` | 分析语义层、漏斗与单位经济 | B02, B26, B34, B39, B40 |
| B42 | P8-growth | `building-growth-data-loop` | 个性化、推荐与受控实验 | B18, B41 |
| B43 | P8-growth | `building-growth-data-loop` | 运营后台、审核、风控与内部治理 | B17, B30, B39 |
| B44 | P9-trust-ops | `securing-operating-life-time-machine` | 隐私工程、安全基线与合规控制 | B04, B05, B17, B21, B23, B31 |
| B45 | P9-trust-ops | `securing-operating-life-time-machine` | 可观测性、SLO、容量与成本运营 | B09, B13, B18, B44 |
| B46 | P9-trust-ops | `securing-operating-life-time-machine` | 备份、灾备、事件响应与删除证明 | B05, B13, B44, B45 |
| B47 | P9-trust-ops | `securing-operating-life-time-machine` | CI/CD、IaC、供应链与可回滚发布 | B01, B44, B45, B46 |
| B48 | P10-certification | `certifying-life-time-machine-release` | 端到端商业闭环、渠道与滥用认证 | B10, B24, B30, B35, B36, B37, B38, B39, B40, B47 |
| B49 | P10-certification | `certifying-life-time-machine-release` | 发布证据、清洁室复现与生产认证 | B41, B43, B44, B45, B46, B47, B48, B50 |
| B50 | P1-foundation | `orchestrating-life-time-machine` | 多 Agent、Worktree、PR 与断点续作编排 | B00, B01, B02, B13 |
| B51 | P11-product-experience | `designing-life-time-machine-experience` | 产品配置档、范围治理与成功指标 | B00 |
| B52 | P11-product-experience | `designing-life-time-machine-experience` | 用户研究、角色画像与服务蓝图 | B51 |
| B53 | P11-product-experience | `designing-life-time-machine-experience` | 信息架构、导航与内容模型 | B52, B06, B19, B31 |
| B54 | P11-product-experience | `designing-life-time-machine-experience` | 设计系统、设计令牌与组件库 | B01, B53 |
| B55 | P11-product-experience | `designing-life-time-machine-experience` | 无障碍、响应式、本地化与时区货币 | B54 |
| B56 | P11-product-experience | `designing-life-time-machine-experience` | 体验治理、可用性、文案与视觉质量门 | B41, B54, B55 |
| B57 | P12-marketing-content | `building-marketing-content-platform` | 营销官网、SEO、性能与落地页构建器 | B06, B41, B54 |
| B58 | P12-marketing-content | `building-marketing-content-platform` | Headless CMS、博客与编辑工作流 | B53, B54, B57 |
| B59 | P12-marketing-content | `building-marketing-content-platform` | 同意管理、Cookie、像素与隐私归因 | B04, B41, B57 |
| B60 | P12-marketing-content | `building-marketing-content-platform` | 活动、深链、UTM、二维码与渠道归因 | B39, B57, B59 |
| B61 | P12-marketing-content | `building-marketing-content-platform` | 社交分享、OG、UGC 模板与媒体素材 | B10, B39, B57 |
| B62 | P12-marketing-content | `building-marketing-content-platform` | 品牌中心、信任中心、状态页与销售资料 | B32, B44, B45, B57, B58 |
| B63 | P13-mobile-mini | `building-mobile-and-mini-programs` | 移动端架构、认证、导航与离线基础 | B01, B03, B54 |
| B64 | P13-mobile-mini | `building-mobile-and-mini-programs` | 移动端拍摄、质量预检与断点上传 | B05, B07, B63 |
| B65 | P13-mobile-mini | `building-mobile-and-mini-programs` | 移动端编辑、生成进度、作品库与导出 | B08, B09, B10, B11, B64 |
| B66 | P13-mobile-mini | `building-mobile-and-mini-programs` | 移动端内购、订阅与权益恢复 | B25, B26, B27, B63 |
| B67 | P13-mobile-mini | `building-mobile-and-mini-programs` | 移动推送、深链、组件与分享扩展 | B40, B63, B65 |
| B68 | P13-mobile-mini | `building-mobile-and-mini-programs` | 移动端隐私、安全、性能与无障碍加固 | B21, B44, B55, B63, B64, B65, B66, B67 |
| B69 | P13-mobile-mini | `building-mobile-and-mini-programs` | 应用商店打包、审核与发布流水线 | B47, B56, B68 |
| B70 | P13-mobile-mini | `building-mobile-and-mini-programs` | 微信小程序登录、上传、编辑与生成 | B03, B04, B07, B08, B09, B54 |
| B71 | P13-mobile-mini | `building-mobile-and-mini-programs` | 微信支付、分享、客服与服务通知 | B10, B25, B26, B27, B39, B70 |
| B72 | P13-mobile-mini | `building-mobile-and-mini-programs` | 小程序隐私、合规、审核与发布 | B44, B47, B55, B70, B71 |
| B73 | P14-notifications | `building-notification-lifecycle-platform` | 通知偏好、同意、安静时段与频控 | B03, B04, B40 |
| B74 | P14-notifications | `building-notification-lifecycle-platform` | 邮件、短信、推送、微信与站内信供应商路由 | B12, B13, B73 |
| B75 | P14-notifications | `building-notification-lifecycle-platform` | 通知模板、变量安全、本地化与渲染 | B55, B74 |
| B76 | P14-notifications | `building-notification-lifecycle-platform` | 生命周期旅程、调度与状态编排 | B24, B27, B40, B74, B75 |
| B77 | P14-notifications | `building-notification-lifecycle-platform` | 送达率、退信投诉与供应商故障治理 | B45, B74, B75, B76 |
| B78 | P14-notifications | `building-notification-lifecycle-platform` | 通知分析、实验、频率与增量效果 | B41, B42, B73, B76, B77 |
| B79 | P15-support-success | `building-customer-support-success` | 帮助中心、FAQ、搜索与自助排障 | B58, B75 |
| B80 | P15-support-success | `building-customer-support-success` | 客服工单、全渠道收件箱、SLA 与路由 | B03, B30, B43, B74 |
| B81 | P15-support-success | `building-customer-support-success` | 站内帮助、客服机器人与人工接管 | B23, B75, B79, B80 |
| B82 | P15-support-success | `building-customer-support-success` | 客户 360、时间线与受控代操作 | B03, B04, B11, B30, B43 |
| B83 | P15-support-success | `building-customer-support-success` | 客服动作、退款补发与数据权利协同 | B28, B29, B30, B44, B80, B82 |
| B84 | P15-support-success | `building-customer-support-success` | 伙伴销售 CRM、线索、商机与报价 | B31, B32, B38, B62, B80 |
| B85 | P15-support-success | `building-customer-support-success` | 客户成功、伙伴启用、健康度与续约 | B34, B41, B76, B82, B84 |
| B86 | P15-support-success | `building-customer-support-success` | CSAT、NPS、VOC 与客服质量管理 | B41, B42, B80, B81, B85 |
| B87 | P16-finance | `building-finance-tax-operations` | 复式账本、业务分录与不可变审计 | B26, B34 |
| B88 | P16-finance | `building-finance-tax-operations` | 支付、伙伴结算与银行对账 | B26, B34, B87 |
| B89 | P16-finance | `building-finance-tax-operations` | 发票、收据、电子发票与税务配置 | B25, B26, B31, B87 |
| B90 | P16-finance | `building-finance-tax-operations` | 收入确认、递延收入、额度与礼品负债 | B27, B28, B34, B87, B89 |
| B91 | P16-finance | `building-finance-tax-operations` | 拒付、争议、欺诈损失与准备金 | B26, B30, B43, B87, B88 |
| B92 | P16-finance | `building-finance-tax-operations` | 伙伴付款、佣金、分成与扣缴单据 | B34, B87, B88, B89 |
| B93 | P16-finance | `building-finance-tax-operations` | 预算、FinOps、成本分摊与盈利分析 | B18, B41, B45, B87, B90, B92 |
| B94 | P16-finance | `building-finance-tax-operations` | 月结、审计导出与会计系统集成 | B88, B89, B90, B91, B92, B93 |
| B95 | P17-physical-supply | `building-physical-supply-network` | 印刷商品配置器、版式、出血与色彩预检 | B08, B25, B29, B54 |
| B96 | P17-physical-supply | `building-physical-supply-network` | 供应商入驻、目录、价格、产能与 SLA | B29, B31, B32, B95 |
| B97 | P17-physical-supply | `building-physical-supply-network` | 生产打样、校样与客户批准 | B28, B29, B95, B96 |
| B98 | P17-physical-supply | `building-physical-supply-network` | 订单路由、采购单与供应商生产任务 | B13, B29, B96, B97 |
| B99 | P17-physical-supply | `building-physical-supply-network` | 地址校验、承运商、发货与物流追踪 | B29, B74, B98 |
| B100 | P17-physical-supply | `building-physical-supply-network` | 库存、耗材、可售量与预售 | B25, B96, B98 |
| B101 | P17-physical-supply | `building-physical-supply-network` | 退货、补发、破损、丢件与理赔 | B30, B80, B83, B99, B100 |
| B102 | P17-physical-supply | `building-physical-supply-network` | 供应商质量、SLA、评分与结算协同 | B34, B41, B92, B96, B98, B99, B101 |
| B103 | P18-developer-platform | `building-developer-integration-platform` | 开发者门户、API 文档与沙箱 | B33, B54, B58 |
| B104 | P18-developer-platform | `building-developer-integration-platform` | API 密钥、OAuth、服务账户与细粒度 Scope | B03, B31, B33, B103 |
| B105 | P18-developer-platform | `building-developer-integration-platform` | 多语言 SDK 生成、版本与示例工程 | B33, B103, B104 |
| B106 | P18-developer-platform | `building-developer-integration-platform` | Webhook 控制台、签名、重放与死信 | B13, B33, B43, B103, B104 |
| B107 | P18-developer-platform | `building-developer-integration-platform` | 连接器框架与集成市场 | B12, B13, B33, B103, B104, B106 |
| B108 | P18-developer-platform | `building-developer-integration-platform` | CRM、CDP、营销、客服与会计适配器 | B38, B60, B80, B84, B94, B107 |
| B109 | P18-developer-platform | `building-developer-integration-platform` | 伙伴测试工具、合成数据与集成认证 | B33, B43, B103, B104, B105, B106, B107 |
| B110 | P18-developer-platform | `building-developer-integration-platform` | API 生命周期、弃用、变更日志与支持 SLA | B45, B62, B103, B105, B106, B109 |
| B111 | P19-data-intelligence | `building-data-intelligence-platform` | 事件分类、埋点 SDK 与 Schema Registry | B02, B41, B54 |
| B112 | P19-data-intelligence | `building-data-intelligence-platform` | 数据采集、仓库、转换与语义层 | B41, B111 |
| B113 | P19-data-intelligence | `building-data-intelligence-platform` | 产品、交易、伙伴与运营仪表板 | B34, B43, B45, B87, B112 |
| B114 | P19-data-intelligence | `building-data-intelligence-platform` | 归因、队列、留存与 LTV 分析 | B39, B40, B59, B60, B78, B112 |
| B115 | P19-data-intelligence | `building-data-intelligence-platform` | 收入、AI/履约成本与单位经济 | B18, B34, B87, B93, B102, B112 |
| B116 | P19-data-intelligence | `building-data-intelligence-platform` | 实验平台、统计与安全护栏 | B42, B56, B78, B111, B112 |
| B117 | P19-data-intelligence | `building-data-intelligence-platform` | 数据质量、血缘、目录与 PII 治理 | B44, B46, B111, B112 |
| B118 | P19-data-intelligence | `building-data-intelligence-platform` | AI 模型评测、漂移、基准与人工评分 | B14, B15, B16, B17, B18, B43, B112, B117 |
| B119 | P20-enterprise-hardening | `hardening-enterprise-platform` | 环境、配置、秘密与租户设置治理 | B03, B31, B44, B47 |
| B120 | P20-enterprise-hardening | `hardening-enterprise-platform` | 多区域、中国/全球拓扑、CDN 与域名 | B05, B44, B45, B46, B47, B119 |
| B121 | P20-enterprise-hardening | `hardening-enterprise-platform` | 性能、压力、容量与自动扩缩容 | B18, B45, B47, B120 |
| B122 | P20-enterprise-hardening | `hardening-enterprise-platform` | 韧性、混沌、依赖故障与切换 | B13, B45, B46, B47, B74, B98, B120, B121 |
| B123 | P20-enterprise-hardening | `hardening-enterprise-platform` | 软件供应链、SBOM、SAST/DAST 与渗透测试 | B44, B47, B103, B119 |
| B124 | P20-enterprise-hardening | `hardening-enterprise-platform` | 合规证据、记录、备案评估与审计导出 | B44, B46, B49, B89, B94, B110, B117, B123 |
| B125 | P21-commercial-launch | `launching-complete-commercial-product` | 商业运营、政策、团队与供应商上线准备 | B56, B59, B60, B61, B62, B78, B86, B94, B102, B108, B110, B113, B114, B115, B116, B118, B120, B121, B122, B124 |
| B126 | P21-commercial-launch | `launching-complete-commercial-product` | 全终端、全渠道与周边系统商业 E2E 认证 | B48, B49, B69, B72, B125 |
| B127 | P21-commercial-launch | `launching-complete-commercial-product` | 分阶段生产发布、市场上线与最终证书 | B126 |

## Key directories

```text
skills/                 Skill entrypoints and 128 detailed references
profiles/               Product scope profiles
stack-profiles/         Technology profiles
manifests/              Skills, batches, requirements, DAG, modules
contracts/              API/event/permission/data/finance/fulfillment contracts
schemas/                Evidence and domain JSON Schemas
scripts/                Scaffold, install, orchestrate, prompt, verify, doctor
starter/                Safe non-production repository skeleton
templates/              Completion, release, incident, vendor, finance templates
evals/                  Trigger, E2E, abuse, mobile, finance, supply, API/data evals
docs/                   Scope, module, surface, profile, architecture, release docs
tests/                  Package and toolchain regression tests
```
