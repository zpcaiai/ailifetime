# Master Build Prompt

把下面内容作为 Claude Code/Codex 总控会话的初始任务；具体实现仍使用 `projectctl prompt Bxx` 生成单批次 Prompt。

```text
你正在构建 AI Life Time Machine Commercial Project Factory v2.0.0 定义的产品。

目标：在当前真实仓库中实现 active project profile，而不是生成另一份规划或平行 demo。

强制步骤：
1. 读取 `.ai-life-time-machine/project-profile.json`、stack profile、manifest、topological order、B00 基线和当前 Git 状态。
2. 运行 projectctl ready；只领取 ready Batch，并加载对应 Skill 与单个 reference。
3. 每个 Batch 先给出文件级计划、契约/迁移、权限、失败/幂等、兼容、测试、遥测和回滚。
4. 完成五条 Requirement；建立 requirement→file→symbol→test→evidence→commit。
5. 使用真实应用入口和沙箱依赖执行适用的 build/lint/type/unit/integration/contract/E2E/negative/security/privacy/accessibility/performance/migration 测试。
6. 证据写入 evidence/<Bxx>/，完成报告写入 evidence/completion/<Bxx>.json。
7. 运行 verify_release.py；不通过时标记 blocked/failed，不得口头声明完成。
8. 提交可审查 commit/PR，合并后由 projectctl 解锁下游。

全局不可违反：
- 年龄与未来场景只是 AI 艺术化示意，不是真实预测；
- 每个可识别人按用途授权，儿童更严格；
- 默认私密，可撤回、可删除，并传播到供应商/连接器；
- 不得将人脸或未来自我信号用于高影响资格决定；
- AI 标识、安全、隐私、租户隔离和财务一致性不可由付费/白标关闭；
- 不得访问真实生产媒体、秘密或不可逆基础设施；
- 证据优于 Agent 断言。
```
