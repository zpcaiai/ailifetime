# 一生拾忆时光机 / TimeCapsule — Industrial Implementation Skills v1.0

**交付类型**：可执行的 Codex/Antigravity 实施蓝图、Skill 指令、机器可读契约、模板目录、测试与验收脚手架；**不是已部署完成的 App**。

## 内容与原则
- 12 类主题、20 个首发模板、5 个视觉风格；以「模板类型 × 风格 × 用户数据」组合，非一次性硬编码图片。
- 微信小程序优先，后端 API 与 renderer 独立，预留 H5/uni-app adapter。
- AI 只负责图像变换；姓名、描述、日期、金额、二维码等确定性字段由可信排版引擎渲染。
- 图片生成 / 付费 / 导出使用持久化状态机、幂等键、对象存储、异步作业和可审计证据。
- 默认私有；用户可以撤回肖像授权并申请删除；付费交付遵循可对账、可退款、可申诉。
- 生成合成内容采用显式与隐式标识；发布前由合规负责人根据实际业务模式确认法律适用。

## 目录
- `AGENTS.md`：Codex 主执行指令；`IMPLEMENTATION_PLAN.md`：分阶段工作切片和 DoD。
- `skills/*/SKILL.md`：12 个专用技能，明确输入、输出、测试和失败策略。
- `contracts/`：JSON Schema、OpenAPI、状态机、渲染布局和策略。
- `catalog/`：20 个主题模板、5 种风格、分类体系、定价候选。
- `database/`：PostgreSQL 建表迁移示例（投产前需要审核与迁移测试）。
- `tests/`：独立运行的静态验收与性质测试脚手架。
- `docs/`：架构、威胁模型、隐私、成本、SLO、运营、合规检查与验证计划。
- `examples/`：结构化样例，全部为虚构信息。

## 快速验收（Python 3.10+，仅标准库）
```bash
python3 tests/validate_package.py
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

## Codex 使用方式
1. 将整个文件夹拷贝到仓库内 `spec/timecapsule/`，阅读 `AGENTS.md`。
2. 按 `IMPLEMENTATION_PLAN.md` 的 Phase 0→1→2... 实施，不要无序并行。
3. 每次提交必须附可复现验证命令、测试报告、失败与证据链接；不能把 mock PASS 写作 E3/E4 PASS。
4. 对接真实供应商时必须使用环境变量及密钥管理，禁止把 API Key 或商户证书提交进仓库。

## 完成度声明
提供规范、模型、任务切片、静态校验及 SQL/API 草案；并未包含完整前后端生产系统、真实生图服务或支付凭证。`tests/` PASS 只代表**交付包内部一致性**，不代表业务 E3/E4 通过。
