# 正式 B15：可执行修复与剩余门槛

基线提交：`f0da9c1275afb46cb9d74ddb67b8ab369a34c034`。本轮为现有评分路径维护，正式 B15 仍为 **BLOCKED_INCOMPLETE**，没有调用收费模型或使用真实人物照片。

## 已修复

Vercel 入口把 `PostgresGeneratedMedia` 作为评分器的私有读取器。原 `TimelinePhotoQualityService.evaluate` 没有传入所属账号，真实私有读取在推理前报 `AUTH_FORBIDDEN: generated photo owner is required`。现在从已授权的 B14 命令取得 owner，与当前租户一同传给原图、候选图及换装参考图的读取器。空 owner 拒绝；推理前、缓存返回前和落库前还会复核 owner、计划及授权，不能用调用者提交的 owner 替代。

新增测试使用实际 PostgreSQL 元数据、私有文件对象与真实 HTTP 传输；服务账号与照片所属账号不同。无 owner、错误租户/账号仍被拒绝；重建服务后复用持久报告不重复推理。原图为已接受 B07 的合成 JPEG，测试显式登记其私有对象；这不代表生产上传/原图登记适配器已完成。

`SeedreamImageGenerator` 只生成候选图，未发现该方法直接把候选图认证为 B14 可发布结果。正式交付仍需签名 B14、质量及安全链路；真实供应商、原图存储登记和调度的端到端验收未执行。

## 本地证据

相关 SQL/HTTP/21张/情侣/换装/撤权用例18/18；当前9个包整体677/677，无跳过、失败或取消。原严格检查器覆盖本轮2个代码文件，0违规。DP 状态引擎的切片和当前完整回归实际执行通过。首次旧编译产物与第二次非空测试数据库造成的失败输出保留，未改断言、阈值、超时或原门禁。

使用原 `tools/repository-baseline.mjs --output evidence/baseline --run lint,typecheck` 补齐 inventory、128批次依赖计划、风险及命令记录。其状态为 `OBSERVED`，lint/typecheck实跑通过；该工具记录中的 build/test未在该次收集器运行、test:e2e脚本缺失仍原样保留。另行的当前workspace build和677项测试证据见 `evidence/B15/formal-gap-evidence.json`，不能冒充收集器内已执行。

基线扫描原样保留 `services/integration-gateway/src/config.test.ts:52` 的1个匹配项：拒绝内联密钥的测试只含 PEM 头、没有密钥载荷，并已有 allow-test-fixture 标记。未改扫描器，也没有把 `OBSERVED` 当作正式 B00 通过报告。

## 正式验收仍缺什么

| 项目 | 当前状态 | 责任与可观察解锁条件 |
| --- | --- | --- |
| B00/B14 前置 | 正式报告不存在；B15依赖仍为空 | 基线及生成链路验收方提供经原脚本验证的报告、B14上游依赖和证据摘要；观察基线不等于通过报告 |
| R01/R02 | 真实评分和分层校准未验收 | 模型及质量负责人提供实际评分服务、固定权重/版本和分层校准证据；不使用合成测量值代替 |
| R03 | 授权金标集缺失 | 产品/数据授权方提供用途授权、覆盖清单和可审计真实样片；不得抓取或挪用客户照片 |
| R04 | 有本地失败恢复，生产复核/修复未验收 | 流水线维护者接入可审计人工复核/修复路径与明确成本/次数上限，并实测撤权、误点通过及重试恢复 |
| R05 | 有维度/版本记录，生产质量回归停流未接线 | 流水线与质量验收方提供已校准回归规则，并在实际模型/模板流量路径验证自动停流和恢复授权 |
| 真机权限 | NOT_RUN | 小程序/部署方提供合法HTTPS服务、测试账号和真实设备，执行允许、拒绝及原图保存 |

原规范 `building-age-media-pipeline/references/B15-identity-consistency-quality.md` 要求："Use this Batch only after the dependency completion reports have passed schema and evidence validation." 本轮没有伪造 B00/B14 成功、把 result_commit 填成未来提交，或修改 verify_release。正式门禁实际运行，不能由本地传输测试推导真实照片的身份、年龄或逼真度效果。

## 重现

先在隔离 checkout 执行 `pnpm install --frozen-lockfile` 与 `pnpm run build`，提供已迁移、可丢弃的真实 PostgreSQL 测试环境（core runtime/admin及photo测试地址），设置 `APP_ENV=test`。执行 `node --test services/api/test/photo-quality-private-reader.test.mjs` 以及仓库原有相关包测试；勿指向业务数据库。正式检查命令是 `python3 .ai-life-time-machine/skill-package/scripts/verify_release.py --repo . --batch B15`，目前预期失败并列出阻塞；不把此失败改成通过。
