# 技术栈配置档

| Stack | 用途 | 关键选择 |
|---|---|---|
| `reference-polyglot` | 中大型专业团队 | Next.js、Java Spring、Python workers、Flutter、Taro、PostgreSQL、Redis、对象存储、Temporal、OpenTelemetry |
| `all-typescript` | 小团队快速统一 | Next.js、NestJS/Fastify、Node workers、React Native/Expo、Taro、Temporal TS |
| `existing-repository-adapter` | 既有系统 | 不预设语言；B00 发现、B01 最小适配 |
| `china-cloud-native` | 中国大陆部署 | 保留供应商抽象，适配国内云、短信、支付、小程序和网络环境 |

参考栈不是授权 Agent 重写已有代码。实际选择顺序是：现有生产系统与团队能力 → 非功能要求 → 数据/安全/合规边界 → 成本和供应商可替换性 → 参考栈。
