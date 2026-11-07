# E0–E5 可信验证矩阵

| 级别 | 验证环境 | 必须证据 |
|---|---|---|
| E0 | JSON schema/静态语义 | schema 版本、hash、lint 报告 |
| E1 | 单元测试 + property-based | 文字准确性、状态机不变量、错误码 |
| E2 | mock provider/contract | API兼容、幂等、错误注入、outbox 重播 |
| E3 | 独立真实 PG+S3+队列 | 数据竞争、恢复、删除、批处理、故障重启 |
| E4 | 独立 QA + 真机+真模型+合规支付测试 | 真实渲染 OCR/人工校对、费用与标识、安全签核 |
| E5 | 灰度真实用户 | SLO曲线、投诉率、转化/成本、回滚记录 |

注意：E4 的 OCR 可辅助检测，但姓名/电话等高风险字段应进行程序化 glyph/文本层验证及视觉人工抽检；不存在 OCR 100% 保证。

证据 manifest：execution_id、commit_sha、environment_digest、contract_rev、test_data_rev、tool_versions、test_outputs_uri、artifacts_sha256、reviewer、pass_fail、exceptions、timestamp。

阻断规则：支付/越权/泄露/未标识重大失败绝不放行，即使视觉效果评分高。
