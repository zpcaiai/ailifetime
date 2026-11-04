# B15 审美协议、人工复核与回归停流（本地范围）

这是现有出图链路的本地维护，正式 B15 仍为 **BLOCKED_INCOMPLETE**。没有付费出图，没有使用真人样片。真实评分/生成模型 **NOT_RUN**，逼真度 **NOT_CERTIFIED**，当前构建真机权限 **NOT_RUN**。本文的 SQL、HTTP 和合成像素测试只验证门控和恢复逻辑。

## 版本化评分协议

v1 原样兼容；v2 必须由服务端校准配置显式启用 `protocolVersion: 2`，并提供正数 `thresholds.aestheticUsability` 和完整 `regression`。无默认生产阈值，也不自动切换模型。原有配置入口仍使用 `LTM_PHOTO_SCORER_*` 环境配置，详见 `PHOTO_SCORER_LOCAL.md`。

| 字段 | v2 约束与含义 |
| --- | --- |
| 请求/响应版本 | `ltm.photo-score.request.v2` / `ltm.photo-score.response.v2`；不接受降级 v1 |
| `imageScores.aestheticUsability` | 有限数 0–1，越高越可用；独立于 `photorealism`，不取平均掩盖低分 |
| 审美评估范围 | 构图和裁切、视线/主体重心、光线与肤色自然度、色彩协调、场景协调、服装与主题的整体可用性；正常年龄特征和衰老本身不作为审美缺陷 |
| 固定评估依据 | 原图与候选图原始字节、目标年龄、有序人物身份/位置、模板/渠道/单人或情侣/年龄或换装上下文；换装另含被编辑照片和所选服装 |
| 版本与校准绑定 | request/response SHA256、模型版本及权重 SHA256、校准 ID 和完整配置快照 SHA256；不能由调用者临时指定阈值或分数 |
| `regression.windowSize` | 整数 2–100；当前窗口最多保留这么多观测用于统计 |
| `regression.minimumSamples` | 整数 2–windowSize；达到样本数后才判断失败率 |
| `regression.maximumFailureRate` | 有限正数 ≤1；达到或超过时停流。必须与业务校准同时确定 |

模型端应按固定 rubric 产生审美值，并以授权真实金标数据校准。当前仓库没有可以证明该分数有效的真实模型/权重或审美金标，测试中的 0.8/0.95 等数值只属于明确标识的合成边界，禁止当作上线建议。缺失审美项、未知项、NaN、越界、错误模型/请求或校准均拒绝。

身份、年龄合理性、面部漂移、姿态、伪影、清晰度、背景、手牙眼、逼真度及换装匹配/区域保持依旧逐项门控，情侣每个人都必须通过。仅审美低分进入 `review`；任何关键项低分不能通过人工复核改写。年龄低置信度也不能人工放行。

## 人工复核

只有真人 `moderator` 或 `platform_admin`，具备 `media.quality.review`、step-up 和相应记录权限时可使用接口；consumer 和 service_account 一律拒绝。推荐用途为 `quality_assurance`，跨原年龄任务读取需要既有 `record:purpose:cross` 权限。权限不会因角色名称或浏览器请求头自动补齐。

1. `GET /v1/quality/reviews` 返回最小队列：case/report ID、版本、目标年龄、原分数/阈值、状态和提案。不返回人物特征、图片字节、存储键或公共 URL。
2. `GET /v1/quality/reviews/{caseId}/preview/reference` 和 `/preview/output` 读取私有原图/候选图。使用可信 B14 owner，逐次复查用途授权、命令状态、测量指纹和文件 SHA256/长度；响应为 `private, no-store`、inline。
3. `POST /v1/quality/reviews/{caseId}/decisions` 必须携带 `Idempotency-Key`，请求仅允许 `action`、`decision`、`expectedVersion`、`reason`、`ticket`。先 `propose`，再由另一人以相同 ticket/decision 和新 case 版本 `confirm`。decision 为 `approve` / `reject` / `retry`。
4. approve 仅适用于审美这一项不达标。原测量值、模型、校准和字节指纹不变，在原报告记录双人 case 证据及理由。拒绝/重试只记录处置，不触发生成或费用，也不放宽原有重试次数/成本边界。

复核 case 和报告写入之间中断可用原确认请求重试；SQL 中持久化的精确 CAS 意图和幂等键完成剩余写入。换 payload 复用 key、过期版本、自我确认、撤权、取消/冻结/补偿任务均拒绝。批准本身不等于发布，B17 和签名 B14 回调仍必需。

高清预览与原图下载共享分块和背压处理，全部验证完成后才发送首块，避免整体缓冲返回造成的大图限制。SQLite 和 PostgreSQL 的 HTTP 用例均使用超过 7 MB 的实际合成 PNG，检查流式传输、原始字节/SHA256、重启和撤权；这仍不代表 Vercel 生产照片服务或真机效果已验收。

## 自动停流与恢复

控制、观测索引、窗口、复核及人工操作意图使用既有 SQLite/PostgreSQL 事务、CAS、审计链和幂等记录，不存在内存降级。所有 `media.quality-*` 管理集合和 `media.qsample.*` 集合均禁止通用 HTTP record 写入/读取（原质量报告读取保留既有授权），防止伪造状态。

控制标识由模型版本/权重 SHA256 和 provider/template/channel/subjectMode/operation 生成，跨年龄校准层共享。相同流配置不同的回归规则会拒绝。每个 command/目标年龄/原图 SHA/输出 SHA 只计一个观测；重复请求或变更校准后重评同一照片不增加独立样本。第一次观测的报告与 epoch 保留，人工放行不会擦除原始失败。

达到规则后 `stopped` 为持久锁存状态；后续高分、重启、重新校准或旧请求回放都不能自行清除。分页最多读取 1000 条，超过容量停流，不能截断历史假装健康。历史不删除，需要后续容量/归档运维计划。

停流检查已接到以下实际路径：

- `TimelinePhotoQualityService` 新评分推理前；已持久报告可复用并补偿中断的统计/入队步骤，不再调用模型。
- `TimelineSeedreamService` 原图读取前、调用前、`beforeSubmit` 及返回候选图前。
- `ProductionExternalCommandPublisher` 实际外部发送前。
- 签名 B14 最终发布事务：SHARE 锁定质量、安全、人工 case 和共享控制，验证当前 active、模型/上下文及双人证据。

生成入口按相关模板、人数模式和业务类型保守拦截；同模板下其他模型/渠道尚有停流控制时，不会因为只恢复一个控制就自动出站。内部控制、复核、样本和操作意图的普通 outbox 投影由 worker 本地消费并保留审计，不发给供应商，也不形成无效批次重试。

一个完整 v2 相册固定一个模型流，允许该模型下不同年龄分层校准。21 张最多 42 个评分/安全记录 + 21 个复核记录 + 1 个共享控制，恰为原门禁 64 行上限；不放宽门禁，混用控制流拒绝。

恢复接口为 `GET /v1/quality/controls` 和 `POST /v1/quality/controls/{id}/resume`，要求真人 `media.quality.control`、step-up。请求仅允许 action、expectedVersion、reason、ticket；两人 propose/confirm 必须对应同一停流窗口。新观测改变窗口会使确认失效。成功后 epoch 加一，以新窗口开始，旧观测重放不污染新窗口；旧恢复请求重放返回当前控制状态，不能掩盖新一轮停流。

已经发出的外部请求无法撤回，停流后不返回/发布它的候选结果。发生结果不确定的生成意图继续保持原有 `reconciliation_required`，不自动再发 POST 或收费；质量恢复不绕过原命令的冻结、死信和对账要求。已发布历史相册不因本次变更自动重新认证，v1 也未被宣称完成真实审美验收。

## 本地复现与待验收边界

准备可丢弃的已迁移 PostgreSQL，使用既有 `LTM_TEST_POSTGRES_URL`（非超级用户、无 BYPASSRLS）、`LTM_TEST_POSTGRES_ADMIN_URL`、`LTM_PHOTO_TEST_POSTGRES_URL`，再执行 `pnpm run build`。CI source job 通过 `tools/b15-postgres-test-setup.mjs` 在独立 loopback 测试库执行原七项迁移和最小权限授权；仅用于可丢弃测试库，禁止指向业务库。临时连接串仅写私有环境文件。

```sh
APP_ENV=test node --test --test-concurrency=1 services/api/test/photo-score-v2.test.mjs services/api/test/photo-quality-*.test.mjs
pnpm --filter @ltm/core --filter @ltm/capabilities --filter @ltm/api --filter @ltm/workers -r test
pnpm check
```

本轮证据见 `evidence/B15/quality-operations-local.json`，包括实际 PID、命令、退出码、原始输出路径及 SHA256。测试使用实际 SQL、文件、HTTP 和签名/用途授权，但外部模型测量为受控合成边界。

正式 B15 仍缺 B00/B14 有效依赖报告、授权真人金标、真实评分和出图模型/权重校验、分层校准/偏差与审美/逼真度效果、实际人员复核及生产流量停流演练。真机相册授权仍需合法 HTTPS 服务和真实设备。必须独立取得这些证据，不能用本地通过率替代。
