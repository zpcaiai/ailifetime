# 本轮本地修复（2026-11-04）

评分算法结果 ID 已升级为 `photo-quality-v2-`。旧 SQL 报告保持原样，重新评估使用新 ID，不会复用旧版可能误放行的判定；新报告仍须通过既有用途授权，不自动补授权。真实 SQL 测试保留旧 pass，并验证同一候选图重新评分为 retry，重启后只复用当前版本判定。已发布历史内容没有被这次 ID 迁移自动重新认证。

Vercel 项目 `ltm-album-save-test-01a1a064` 原配置引用未进入 Git 的 `tools/native-album-build.mjs`。已从原隔离测试部署产物恢复构建器、`api/native-album.mjs`、Serverless 适配器及根配置；真实 API 代码参与构建，公开目录只允许说明页。临时身份仅由私有环境配置提供，代码不含令牌。该入口仅提供合成图片、只读相册联调，不是生产出图 API；缺配置、过期、错误用途、Origin/Cookie、写入及未知路径均拒绝。

B15 换装评分曾用逐人服装匹配分覆盖整图服装匹配分。现取两者最低值，整图或任一人低分都会进入 retry；覆盖单人和情侣、整图/逐人/区域保持的独立失败。新增 0–100 岁每 5 年、单人和情侣共 42 个年龄场景，逐项验证身份、年龄、逼真度低分、年龄不确定转 review、503/错误模型恢复、稳定推理键、SQL 重启复用和取消后拒绝。合成像素与测试测量值只证明协议和门控，不能证明真实模型效果。

复现：`pnpm install --frozen-lockfile && pnpm run build`；`APP_ENV=test node --test services/api/test/photo-score-age-coverage.test.mjs services/api/test/photo-score-wardrobe-contract.test.mjs tools/native-album-serverless.test.mjs tools/native-album-build.test.mjs`。PostgreSQL 私有媒体测试另需已迁移的独立数据库，使用仓库既有测试环境变量，禁止复用生产库。

原正式 B15 仍为 BLOCKED_INCOMPLETE：B00/B14 正式依赖报告、独立审美可用性维度的版本化协议、真实金标/分层校准、生产复核/修复与持久回归停流尚未验收。不得把这次现有路径维护当作正式批次验收。没有付费出图；真实模型 NOT_RUN、逼真度 NOT_CERTIFIED、当前构建真机权限 NOT_RUN。

恢复依据是原相册测试部署源码，不修改原任务工作副本；本轮恢复文件哈希、命令 PID、退出码和原始日志 SHA256 保存于当前会话 `vercel-b15-resume-20261104` 归档。回滚只允许对照前像撤销本轮未被后续修改的文件，保留私有数据库和历史失败证据，不回滚其他任务修改。
