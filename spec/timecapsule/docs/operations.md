# 生产运维与故障预案

## 建议初始 SLO（上线后以实际数据校准）
- API 成功率 >= 99.9%（排除有效 4xx）；模板目录 p95 < 400ms（服务端）。
- 作业进入队列 p95 < 2s；GPU 生图时长单独按供应商测量，不承诺统一秒数。
- 作业逻辑重复生成率 <= 0.1%；成功支付重复发放权益 = 0。
- 孤儿 S3 对象和待清理记录每天对账；删除完成时长按产品公布的保留政策测量。

## 观测字段
trace_id, request_id, job_id, user_pseudonym, template_id, template_version, provider, model_version, unit_cost_estimated, unit_cost_actual, moderation_result, export_label_verified, payment_event_id_hash。日志禁止原图、身份证、电话、支付证书及完整 prompt 中的私人数据。

## Runbooks
- AI provider 故障：熔断+切换可用 provider；预算超过阈值暂停新付费生成，未履约订单退款/补偿。
- 消息重复：消费幂等；检查 outbox backlog 与唯一索引；不可人工重发权益。
- 支付通知延迟：后台主动查询、订单标记 PROCESSING，不用客户端成功回执作为唯一事实。
- 标识验证失败：禁止发布/导出，把产物隔离并生成审计事件。
- 隐私泄露：关闭相关分享链接、轮换密钥、暂停功能、依规响应安全事件。
- 回滚：数据库兼容式迁移，开关退回上一版模板和 renderer；已付款交易保持履约对账。
