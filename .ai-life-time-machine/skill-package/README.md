# AI 人生时光机完整商业级项目工厂 v2.0.0

这是供 **Claude Code 与 Codex** 在真实代码仓库中执行的商业级 Skills Package。它围绕以下产品战略建立完整工程闭环：

> **以 0—100 岁照片和视频作为传播入口，以家庭关系和未来自我作为核心价值，以影楼、纪念礼品、保险养老平台的 B2B2C 合作完成商业化。**

本包不是已经编译好的最终 App，也不是一份只描述愿景的 PRD。它提供项目配置档、22 个领域 Skills、B00—B127 共 128 个可独立实现/验收批次、640 条强制需求、仓库脚手架、依赖编排、批次 Prompt、证据追踪、商业 E2E 和分阶段上线认证。Claude Code/Codex 仍需在你的目标仓库中逐批生成和验证真实产品代码。

## 包含什么

- **22 个顶层 Skills**：核心产品、AI 媒体、家庭未来自我、交易履约、伙伴渠道、营销内容、多端 App、小程序、通知、客服 CRM、财务税务、实物供应链、开发者平台、数据智能、企业安全与最终上线。
- **128 个 Atomic Batches**：每个批次有目标、依赖、五条强制需求、接口、权限、幂等、异常、测试、证据和完成定义。
- **640 条 Requirement IDs**：全部要求 `requirement → source → symbol → test → runtime evidence → commit`。
- **7 个产品配置档**：从精简付费 MVP 到完整商业级项目，自动计算依赖闭包。
- **4 个技术栈配置档**：参考多语言栈、全 TypeScript、既有仓库适配、中国云原生。
- **项目工厂工具链**：安全安装/卸载、新建/适配脚手架、状态机、Worktree 计划、Prompt 生成、完成报告校验和 profile 证书。
- **周边商业系统**：营销站/CMS、移动端/小程序、消息中心、帮助中心、工单、CRM、客户成功、账本/对账/开票/月结、供应商/物流/退换货、SDK/Webhook/连接器、数仓/实验/模型评测、合规证据与灰度发布。

## 最快开始：生成一个新项目

```bash
unzip ai-life-time-machine-commercial-project-factory-v2.0.0.zip
cd ai-life-time-machine-commercial-project-factory-v2.0.0

python3 scripts/validate_package.py --root .
python3 -m unittest discover -s tests -v

python3 scripts/scaffold_project.py   --target /absolute/path/to/new-project   --mode new   --profile full-commercial   --stack reference-polyglot   --host both   --project-name "AI Life Time Machine"
```

脚手架会：

1. 创建非生产性的 monorepo 起始结构；
2. 安装 Codex Skills 到 `.agents/skills/`；
3. 安装 Claude Code Skills 到 `.claude/skills/`；
4. 把完整支持包放到 `.ai-life-time-machine/skill-package/`；
5. 固化 active profile/stack；
6. 初始化 B00—B127 状态机，首个 ready Batch 为 B00。

查看可执行批次：

```bash
cd /absolute/path/to/new-project
python3 .ai-life-time-machine/skill-package/scripts/projectctl.py --repo . ready
```

生成 B00 的 Codex Prompt：

```bash
python3 .ai-life-time-machine/skill-package/scripts/projectctl.py   --repo . prompt B00 --host codex   --output evidence/prompts/B00-codex.md
```

Claude Code：

```bash
python3 .ai-life-time-machine/skill-package/scripts/projectctl.py   --repo . prompt B00 --host claude   --output evidence/prompts/B00-claude.md
```

## 适配已有仓库

```bash
python3 scripts/scaffold_project.py   --target /absolute/path/to/existing-repository   --mode adapt   --profile full-commercial   --stack existing-repository-adapter   --host both
```

`adapt` 模式不会另建一套平行业务架构。B00 先发现现有应用、服务、数据库、契约、构建、测试、部署和风险；B01 再决定复用、扩展、迁移或新增。

## 产品配置档

| Profile | 定位 | 必需批次 | 发布门 | 范围 |
|---|---|---:|---|---|
| `b2b2c-standard` | B2B2C 标准商业版 | 104 | `B124` | 覆盖消费者、影楼、纪念礼品、保险养老教育、伙伴门户、开发者平台、销售/客户成功、结算和企业治理。 |
| `china-commercial` | 中国大陆完整商业版 | 128 | `B127` | 面向中国大陆市场的 Web、App、微信小程序、微信/支付宝支付、电子发票、影楼/礼品/保险养老伙伴和本地运营全闭环。 |
| `consumer-web` | 消费者 Web 商业版 | 104 | `B124` | 覆盖个人、家庭、未来自我、数字/实物商品、增长、运营、客服、财务、数据和生产级 Web 平台。 |
| `full-b2c` | 完整 B2C 多端版 | 114 | `B124` | 在消费者 Web 商业版上增加 iOS/Android、微信小程序、全渠道通知、实物礼品和商店发布。 |
| `full-commercial` | 完整商业级项目 | 128 | `B127` | 实现 B00–B127：消费者、家庭、未来自我、Web/App/小程序、B2B2C、支付财务、供应链、客服、数据、企业安全和分阶段上线全部能力。 |
| `global-enterprise` | 全球企业商业版 | 111 | `B124` | 面向多地区、多品牌、企业 SSO、API/SDK、数据治理、多区域韧性和审计的完整 B2B2C 平台；微信小程序可作为可选渠道。 |
| `lean-mvp` | 精简付费 MVP | 87 | `profile-certificate` | 以 Web 单人年龄时间轴、数字交付、基础支付、分享、通知、客服、财务和可信上线为范围，适合验证需求与单位经济。 |

选择 `full-commercial` 时，必须实现依赖拓扑中的全部 **128 个批次**。其他 Profile 是经过依赖闭包计算的可交付子集，不允许关闭同意、隐私、AI 标识、删除、安全或财务一致性等不可豁免控制。

## 22 个 Skills

| Skill | 领域 | 批次数 | Batches |
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

## 一次 Batch 的正确执行方式

```bash
# 1. 查看 ready
python3 .ai-life-time-machine/skill-package/scripts/projectctl.py --repo . ready

# 2. 生成 worktree 命令
python3 .ai-life-time-machine/skill-package/scripts/projectctl.py --repo . worktree-plan B06

# 3. 领取批次
python3 .ai-life-time-machine/skill-package/scripts/projectctl.py   --repo . start B06   --owner codex   --worktree ../project-b06   --branch feat/ai-life-time-machine-b06

# 4. Agent 实现后验证完成报告
python3 .ai-life-time-machine/skill-package/scripts/projectctl.py   --repo . finish B06   --report evidence/completion/B06.json

# 5. 审核合并后解锁下游
python3 .ai-life-time-machine/skill-package/scripts/projectctl.py   --repo . mark-merged B06 --commit <sha>
```

## 强制证据门

`verify_release.py` 会拒绝：

- 未运行、失败、跳过、空断言或被 mock 掉的关键测试；
- completion report 缺少依赖报告或哈希不匹配；
- 需求没有映射到真实文件、符号、测试、证据和 Git commit；
- 生产路径含 `TODO`、`FIXME`、`NotImplemented` 或硬编码成功；
- 证据逃逸仓库、包含真实客户媒体/秘密，或 commit 不存在；
- 同意、儿童保护、AI 标识、租户隔离、支付/账本、删除、供应商副本、回滚等关键闭环未通过。

完整 Profile 认证：

```bash
python3 .ai-life-time-machine/skill-package/scripts/projectctl.py   --repo . certify-profile   --reports-dir evidence/completion   --certificate evidence/release/full-commercial-certificate.json
```

## 核心边界

- 年龄照片、视频、未来人生场景和未来自我内容始终是 **AI 艺术化示意**，不是对真实容貌、寿命、健康、职业、财富或人生结果的预测。
- 每个可识别人必须按用途授权；多人照片、儿童、公开分享、营销复用、声音、长期记忆分别控制。
- 人脸、质量分、情绪或未来自我交互不得用于保险承保/定价/理赔、信贷、就业、医疗或其他高影响资格决定。
- AI 标识、来源证明、隐私/删除、安全和财务一致性不能被付费、白标或伙伴合同关闭。
- 本包提供工程控制与证据框架，但不替代上线地区的专业法律、税务、会计、安全、无障碍、应用商店或行业监管审查。

## 阅读顺序

1. `docs/COMPLETE_PROJECT_SCOPE.md` — 完整商业系统边界；
2. `docs/MODULE_CATALOG.md` — 所有前台/后台/平台模块；
3. `docs/PROFILE_GUIDE.md` — 选择配置档；
4. `ARCHITECTURE.md` — 参考架构与适配原则；
5. `ROADMAP_AND_DEPENDENCIES.md` — 阶段与拓扑；
6. `MASTER_BUILD_PROMPT.md` — 总控 Prompt；
7. `INVENTORY.md` — 22 Skills 与 128 Batches 索引；
8. 对应 `skills/<skill>/SKILL.md` 和 `references/Bxx-*.md`。
