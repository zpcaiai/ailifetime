# TimeCapsule (一生拾忆时光机) — Implementation Intent & ADR (P00–P14)

## 1. 概述与架构定位 (ADR-TC-001)

根据 `spec/timecapsule/AGENTS.md`、`spec/timecapsule/README.md` 与 `spec/timecapsule/IMPLEMENTATION_PLAN.md`，本模块将 `TimeCapsule_Industrial_Skills_v1_0` 作为「一生拾忆时光机」的独立业务领域包（位于 `spec/timecapsule/` 与 `services/timecapsule/`），在不破坏既有 `@ltm/*` 全栈工作区与微信小程序静态门禁的前提下，完整实现 **P00–P14** 共 15 个纵向切片。

### 受影响组件
- **契约与规范基线 (`spec/timecapsule/`)**：原样保留 44 个规范文件（12 个 Skill、20 个首发模板、12 个分类、5 套视觉风格、6 份 JSON Schema、OpenAPI 3.0.3、作业与订单状态机、PostgreSQL 初始迁移草案、E0/E1 校验脚本），全部通过 `MANIFEST.sha256.json` 校验。
- **领域持久化与身份同意层 (`services/timecapsule/db_and_identity.py` — P00, P01)**：基于真实 SQLite/PostgreSQL ACID 事务（`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`）与乐观锁（`version`）实现 `app_user`、`consent_record`、`privacy_deletion_request`、登录会话续期与草稿保留（`A01`）、撤回同意与异步删除回执链（`A07`, `A10`）。
- **模板目录与媒体安全保险箱 (`services/timecapsule/catalog_service.py`, `services/timecapsule/media_vault.py` — P02, P03)**：编译 12 分类 × 20 模板 × 5 风格（100 种组合），支持模板版本演进与停用（`A12`）；提供私有预签名上传意图、真实文件头 MIME 嗅探、JPEG/PNG EXIF 隐私元数据剥离、SHA-256 寻址与孤儿对象扫描清理（`A05`, `A14`）。
- **确定性卡片排版与渲染引擎 (`services/timecapsule/deterministic_renderer.py` — P04)**：支持 `3:4` (`1080x1440`)、`9:16` (`1080x1920`)、`1:1` (`1080x1080`) 归一化布局计算、人像安全边距防遮挡、CJK/Emoji/RTL 混排自动换行与字号自适应（`A06`）、域名白名单二维码矩阵生成，以及带版本摘要的确定性 SVG + PNG 离屏光栅渲染。
- **AI Provider 异步编排与持久化作业状态机 (`services/timecapsule/ai_orchestrator.py` — P05, P06)**：实现 `{submit, poll, cancel, quote_cost}` 接口、429/5xx/超时退避与熔断切换（不改变用户已确认价格 `A03`）、单日配额与全局预算上限（`A13`）、100 次并发幂等键去重（`A02`）、生成中撤回同意阻断（`A07`），以及 `transactional_outbox` 事务发件箱投递与重放（`A04`）。
- **可信导出与 GB 45438 合成标识、支付权益与退款对账 (`services/timecapsule/export_labeling.py`, `services/timecapsule/payments_entitlement.py` — P08, P09)**：强制显式水印与隐式 PNG `iTXt`/签名元数据标识、转码保真验证（`A09`）与防绕过门禁（`A15`）；服务端不可变价格快照、微信支付回调验签、100 次重复/乱序通知幂等入账（`A08`）、复式记账台账、权益唯一发放与退款回收。
- **数字人生档案、可撤销分享、内容审核与申诉 (`services/timecapsule/timeline_moderation.py` — P10, P11)**：私有画廊、0–100 岁时间轴版本管理、历史模板版本绑定（`A12`）、可撤销分享短链（`A11`）、未成年人公开分享阻断、提示词注入拦截与人工复审/申诉 SLA。
- **小程序首发页面控制器、H5 适配器、纪念套装视频管线、可观测性与 OpenAPI HTTP 服务 (`services/timecapsule/multiplatform_and_album.py`, `services/timecapsule/http_server.py` — P07, P12, P13, P14)**：完整实现 OpenAPI v1 路由、微信小程序 6 大首发页面状态机、H5 多端权限适配、纪念相册/多帧字幕视频异步合成与脱敏 SLO 指标监控。
- **独立验证与 E0–E5 证据运行器 (`services/timecapsule/evidence_runner.py`)**：执行 `A01–A15` 全部验收与故障注入场景，输出符合 `evidence.schema.json` 的证据清单。

## 2. 数据分类与隐私保护边界 (P00)

| 数据类别 | 敏感级别 | 存储与访问策略 | 日志与训练策略 |
|---|---|---|---|
| 用户标识与登录态 (`app_user`, `user_session`) | PII (中) | HMAC 假名化标识，内存态 Bearer Token，跨租户/跨用户严格 403 | 仅记录 `user_pseudonym` |
| 肖像授权与未成年人监护人许可 (`consent_record`) | 高敏合规凭据 | 强制绑定 `policy_revision` 与 `evidence_ref`，未成年人必须具备 `guardian_evidence_ref` | 审计保留，不可篡改 |
| 人像原图与儿童照片 (`media_asset`) | 极高敏生物特征相关 | 私有桶存储、入库前强制剥离 EXIF/GPS、对象级 owner ACL、撤回后进入 `DELETING -> DELETED` | 严禁入日志；严禁默认用于 AI 模型训练 |
| 生成作品与时间轴 (`work`, `timeline_entry`) | 个人隐私资产 | 默认私有；分享仅通过可撤销不透明 `share_token`；AI 模式强制显式+隐式标识 | 审计哈希上链/归档 |
| 订单、支付回调与权益账本 (`customer_order`, `payment_event`, `entitlement_grant`) | 金融交易数据 | 服务端定价快照、回调验签、事件唯一键幂等、复式记账对账 | 依规保留交易凭据，日志仅记录 `payment_event_id_hash` |

## 3. 非目标与真实性边界 (Anti-Fake Governance)

1. **绝不伪造 E3/E4/E5 外部联调通过**：本地自动化验证完整覆盖 `E0`（静态契约与 Schema）、`E1`（单元与状态机不变量）、`E2`（API 契约、SQLite ACID 事务、幂等、故障注入 `A01–A15`）。当缺少外部生产级 PostgreSQL/S3 集群、真实微信支付商户号私钥或真机设备时，`evidence_runner.py` 严格将 `E3`/`E4`/`E5` 标记为 `BLOCKED` 并指明解锁条件。
2. **禁止客户端决定价格、身份或存储路径**：所有价格由服务端 `product_price` 快照决定，所有用户身份由服务端 Bearer Session 解析，所有导出必须通过 AI 标识校验。

## 4. 回滚策略 (Rollback Plan)

- **数据库层**：采用向前兼容的增量表结构（`001_init.sql` 扩展字段均带默认值或独立表），支持通过特性开关切回上一版 `template_revision` 与 `renderer_revision`。
- **业务与资金层**：回滚模板或渲染器版本时，已支付订单与 `entitlement_grant` 保持不可变并继续支持对账或自动退款补偿。
