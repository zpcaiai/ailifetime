# 21 张年龄照片链路审查与本地修复

> 最新进展（2026-11-02）：已接入提供的 AppID、单人/情侣与单年龄/21 年龄玩法。本文保留历史审查记录；当前验证与未完成边界见 [年龄玩法与验收状态](AGE_PLAY_MODES.md)。新 AppID 的合法域名联调受阻，真实模型与逼真度仍未验收。

日期：2026-11-02。基线：`edb00095629844e72d3ba516ba89ed9a55c3f3f0`，开始时工作区干净。
范围：微信小程序，一张授权原图，0、5、10……100 岁，共 21 张。用户明确选择“先完成本地修复与测试，暂不付费出图”。本次没有调用付费图像服务，没有访问真实客户照片，也没有部署或提交 Git。

**结论：请求、授权、防误通过和本地结果汇总方面的修复已落地；真实 21 张照片的生成、逐张质量验收和展示仍为 `BLOCKED_INCOMPLETE` / `NOT_RUN`，逼真度 `NOT_CERTIFIED`。**

## 实际运行链路

1. `apps/wechat-mini/miniprogram/pages/capture/index.js`、`services/upload.js`：选择一张图片，压缩，JPEG/分辨率/大小预检，流式 SHA256、分片上传、完成后取得 assetId。这里不生成照片，也不证明人脸清晰度或身份一致性。
2. `services/api/src/server.ts:702`、`:716`：B07 请求只接受资产/参与者 ID，通过可信上传 broker 解析检查结果；不信任客户端提交的“照片检查通过”。
3. `apps/wechat-mini/miniprogram/pages/editor/index.js:53`：逐目的同意 → B07 → B08 草稿 → B14 生成意图。现在默认 21 点，包含原照片年龄、所选模板和完整时间轴 profile。
4. `packages/capabilities/src/domains/building-age-media-pipeline.ts:35`：B14 在服务端构建版本化计划，保留原图身份锚点。原有 intake、人物同意和幂等持久化仍由既有框架执行。
5. `services/workers/src/index.ts:175`、`:180`：worker 通过已配置的批次适配器发送完整持久化数据。出站受理回执只推进 `acknowledged`；终态由可信签名回调决定。这是一个外部协议接口，不是仓库内的人脸年龄生成模型。
6. `packages/core/src/external-command-callbacks.ts:52`、`packages/capabilities/src/external-business-event-reducers.ts:210`、`:532`：B14 当前使用通用终态回调，保留 provider 状态及回调摘要；没有逐年龄输出资产清单、逐张质量报告或 21 图验收汇总。
7. `apps/wechat-mini/miniprogram/pages/job/index.js`：查询命令状态。现在明确显示“服务商处理结束，照片交付待核验”，不把处理成功当作照片验收。
8. `apps/wechat-mini/miniprogram/pages/library/index.js:18`、`:24`：读取命令记录，期待单个短期 previewUrl；当前回调 reducer 并不生成这些预览字段。`library/index.wxml:8` 也是单张预览，没有完整 21 图时间轴与高清逐张下载。

`services/experience-platform/src/media-pipeline.ts` 的 AgeTimelineService 和 QualityGateService 是独立的参考领域服务；检索到的调用者只有该包的测试，不能把它们当作已接入 B14/worker/API 的运行链路。它们的本地状态也不是生产持久化或分布式质量熔断证据。

## 已按优先级修复

| 优先级 | 问题与实际修复 | 代码/验证 |
|---|---|---|
| P0 | 普通消费者原可用 B15 写自己的分数/阈值，用 B17 写安全/来源声明；现在分别需要 `media.quality.evaluate`、`media.safety.certify`。专用服务仍须获得既有记录/同意权限。 | building-age-media-pipeline.ts；真实 SQLite 权限负例、HTTP 403 测试 |
| P0 | 通用 record.create/update/delete 可以绕过专用入口写质量/安全集合；现在对所有网络调用者禁止这些通用写入，包括有通用记录权限的管理员。 | services/api/src/dispatch.ts:42；实际 loopback HTTP 测试 |
| P0 | 质量分数缺失、NaN、Infinity、超范围可能误通过；参考质量服务现在要求全部 10 个维度，含 photorealism，完整且有限。B15 兼容的旧 6 维接口也拒绝非有限值。 | media-pipeline.ts；media-quality.test.ts；age-generation-plan.test.ts |
| P0 | 质量评估原只收到输出图，无法明确比较原图与目标年龄；现在接口必须同时收到原图、输出图和 targetAge，报告绑定实际字节 SHA256、模型、各维分数和阈值。 | QualityEvaluator / QualityGateService；真实判定代码的故障注入测试，非图像模型验收 |
| P0 | 身份、年龄、五官漂移、伪影、眼牙手、逼真度关键失败或已触发熔断，不能被备注强制放行；重试预算耗尽进入人工复核，不再自动建议无预算的替代生成。 | QualityGateService / B15；关键维度与熔断负例 |
| P0 | 结果汇总按输出行数判断齐全；同一年龄重复输出可以掩盖缺失节点。现在按计划版本、节点最新结果和精确缺失集合汇总，禁止重复目标年龄；返回计划的修改也不会篡改内部计划。 | AgeTimelineService；21 行但只含 20 年龄的负例、版本隔离测试。仅参考汇总层，尚未接入线上 |
| P1 | 小程序默认只有 4 个年龄，共享服务默认只有 12 个；现在统一为 0..100 每 5 岁共 21 个。完整 profile 在服务端检查唯一参与者、原图年龄和精确有序年龄集合，保留旧版自定义年龄请求。 | editor/index.js / consumer.ts / age-generation-plan.ts |
| P1 | B14 只有散列字段，没有可重放的分节点约束；现在生成服务端计划，所有节点锚定原始照片，包含目标年龄变化说明、统一构图/背景/光线/衣着、负面约束和独立稳定种子。 | age-generation-plan.ts。约束计划不是出图效果证据 |
| P1 | 所选模板只进入草稿，B14 丢失；现在 B14 与生成计划保留 templateId，模板变化进入种子绑定。 | B14 / editor；模板传递与重放测试 |
| P1 | 连点、网络失败重试会生成新任务；现在同一编辑页保留请求快照、原任务 ID/种子/幂等键，未知副作用时禁止改参数另起任务。 | editor；网络失败/同请求重放负例。尚不提供应用进程销毁后的意图恢复 |
| P1 | 页面返回前台不恢复轮询，后台迟到响应可能重启定时器；现在处理前台恢复和请求 epoch，失败/取消/补偿不展示结果 CTA。 | job；前后台、迟到响应、终态测试 |

## 距离真实闭环仍缺什么

以下是明确保留的缺口，不因本地测试通过而关闭。没有为了展示成功而新建沙箱照片、硬编码分数、关闭安全门或填充虚假 URL。

| 顺序 | 缺口与完成条件 | 状态 / 解锁依赖 |
|---|---|---|
| 1 / P0 | 原生图像供应商适配器：取到授权原图实际字节，明确支持参考图身份保持与跨年龄编辑；记录真实模型版本、调用成本、幂等键和回执。当前 ProviderPorts 仅有 fail-closed 与 synthetic sandbox；worker 的 B14 HTTPS 外部协议不自动提供此能力。 | `BLOCKED_EXTERNAL`。产品/集成负责人需确定供应商、模型/接口合同、区域与保留政策、托管凭据和成本上限；本次用户不授权付费运行。 |
| 2 / P0 | 可执行的图像质量测量与校准：原图对输出的人脸相似、目标年龄、五官漂移、照片纹理/伪影和跨节点连贯性；需有授权样本、不同年龄跨度的阈值、盲评与失败样片。 | `NOT_RUN`。QualityEvaluator 目前仍是接口；本次只修了判定逻辑和绑定，没有真实 evaluator，也没有把参考服务接入 B14。B15 的旧 6 维管理员声明仍不能充当真实测量或照片发布许可。 |
| 3 / P0 | 供应商结果协议与持久化汇总：签名回调必须绑定计划版本、原图/同意、21 个不同目标年龄、每张输出资产与摘要、真实模型与种子、可信安全/质量证据。缺失、重复、错人、错误年龄、撤回同意的节点不得发布。 | `BLOCKED_DEPENDENCY`。需与第 1、2 项的真实供应商/质量权威协议一起确定并接入；当前通用终态回调没有这个合同。不能把 providerState=succeeded 当作交付完成。 |
| 4 / P1 | 21 图作品查询与展示：从已验收的逐年龄资产获取可续期签名 URL，按年龄滑动、放大、高清保存、标明缺失节点；按单节点恢复、费用/退款权益关联。 | `NOT_RUN`。依赖第 3 项；当前作品库只消费单张 previewUrl，参考汇总层尚未与 API/持久化工单相连。 |
| 5 / P1 | 跨进程任务恢复、持久化质量熔断、微信开发者工具/真机与弱网验收、PostgreSQL 回归。 | `NOT_RUN`。本次页内重放与 Node 页面脚本测试不是应用重启恢复或真机证据；两个 PG 测试需 `LTM_TEST_POSTGRES_URL` 指向已迁移的可丢弃测试库。 |

## 验证与证据边界

执行了 capabilities、experience-platform、wechat-mini-core、workers、api 五包串行原生 build/test；最终命令与每次失败、修复后重跑、PID、退出码、完整输出 SHA256 保存在本次聊天附件目录的 `age-chain-audit/`。最终计数见 `SUMMARY.json`。

新增质量测试通过受控 evaluator 响应向真实判定实现注入缺失维度、非法数值、低分、预算耗尽、输入突变和熔断等故障；它们不测量照片逼真度。持久化测试运行真实 SQLite，HTTP 测试启动实际 loopback 服务；它们不是 PostgreSQL、原生图像模型或微信真机验收。

未修改的 `certification/strict_zero_fake_industrial_evaluator.py --strict-slice` 扫描本次 12 个 `.ts/.js` 变更文件，0 违规；该工具不扫描 `.mjs`/WXML，相关测试通过 Node 测试与小程序结构检查验证。此检查也不是 B14/B15/B70 的独立认证。

基线测试中的旧 12 年龄期望已按用户的 21 年龄合同更新为精确列表，没有删除/跳过该断言。初次 TypeScript 类型错误和旧期望导致的失败输出均保留。两项 PG 跳过保留为 `NOT_RUN`，没有从原始分母删除。

回滚前像和每个文件的 SHA256 位于聊天附件目录 `age-chain-audit/preimages/` 和清单中；只能在当前文件仍匹配本次后像时回滚，不能覆盖并发修改。未新增模型供应商绑定，未运行付费推理，未宣称修复已提高真人样片逼真度，未生成 B14/B15/B70 或生产通过证书。
