export type SupportedLocale = "zh-CN" | "zh-TW" | "en";
export type PortalId = "consumer" | "family" | "partner" | "studio" | "operations" | "support" | "developer";

export interface PortalDefinition {
  readonly id: PortalId;
  readonly title: Readonly<Record<SupportedLocale, string>>;
  readonly description: Readonly<Record<SupportedLocale, string>>;
}

export const PORTALS: readonly PortalDefinition[] = [
  {
    id: "consumer",
    title: { "zh-CN": "消费者", "zh-TW": "消費者", en: "Consumer" },
    description: {
      "zh-CN": "创建、生成、购买和跨移动端管理个人时光机作品。",
      "zh-TW": "建立、生成、購買和跨行動端管理個人時光機作品。",
      en: "Create, generate, purchase, and manage personal time-machine works across devices.",
    },
  },
  {
    id: "family",
    title: { "zh-CN": "家庭", "zh-TW": "家庭", en: "Family" },
    description: {
      "zh-CN": "管理家庭、监护授权、共同创作和未来自我互动。",
      "zh-TW": "管理家庭、監護授權、共同創作和未來自我互動。",
      en: "Manage households, guardian consent, co-creation, and future-self interactions.",
    },
  },
  {
    id: "partner",
    title: { "zh-CN": "伙伴", "zh-TW": "夥伴", en: "Partner" },
    description: {
      "zh-CN": "伙伴、门店、工作室和行业渠道的合同化业务工作台。",
      "zh-TW": "夥伴、門市、工作室和產業通路的合約化業務工作台。",
      en: "Contract-governed workflows for partners, stores, studios, and industry channels.",
    },
  },
  {
    id: "studio",
    title: { "zh-CN": "制作与供应链", "zh-TW": "製作與供應鏈", en: "Studio & Supply" },
    description: {
      "zh-CN": "印前、打样、生产、库存、配送、退货与供应商绩效。",
      "zh-TW": "印前、打樣、生產、庫存、配送、退貨與供應商績效。",
      en: "Preflight, proofing, production, inventory, delivery, returns, and vendor performance.",
    },
  },
  {
    id: "operations",
    title: { "zh-CN": "运营与治理", "zh-TW": "營運與治理", en: "Operations & Governance" },
    description: {
      "zh-CN": "平台、商业、增长、通知、财务、数据、安全、合规与发布控制。",
      "zh-TW": "平台、商業、成長、通知、財務、資料、安全、合規與發佈控制。",
      en: "Platform, commerce, growth, messaging, finance, data, security, compliance, and release controls.",
    },
  },
  {
    id: "support",
    title: { "zh-CN": "客服与成功", "zh-TW": "客服與成功", en: "Support & Success" },
    description: {
      "zh-CN": "工单、升级、知识、服务恢复和客户健康管理。",
      "zh-TW": "工單、升級、知識、服務復原和客戶健康管理。",
      en: "Cases, escalations, knowledge, service recovery, and customer health.",
    },
  },
  {
    id: "developer",
    title: { "zh-CN": "开发者", "zh-TW": "開發者", en: "Developer" },
    description: {
      "zh-CN": "API、OAuth、SDK、Webhook、连接器和伙伴集成认证。",
      "zh-TW": "API、OAuth、SDK、Webhook、連接器和夥伴整合認證。",
      en: "APIs, OAuth, SDKs, webhooks, connectors, and partner integration certification.",
    },
  },
] as const;

export function portalById(id: string): PortalDefinition | undefined {
  return PORTALS.find((portal) => portal.id === id);
}

const ZH_CN = {
  appSubtitle: "本地商业能力控制台",
  skipMain: "跳到主要内容",
  language: "界面语言",
  consoleViews: "控制台视图",
  businessPortals: "业务门户",
  connecting: "正在连接",
  online: "本地运行正常",
  offline: "本地 API 未启动",
  authenticated: "身份已由服务器验证",
  authRequired: "需要登录",
  authRequiredDescription: "未建立服务器验证会话，业务工作台已失败关闭。请使用安全登录。",
  signIn: "登录",
  signOut: "退出",
  signingIn: "正在通过安全身份提供商登录",
  signedOut: "已退出；内存会话已清除",
  authenticationFailed: "登录失败，工作台已安全关闭",
  heroLine1: "让未来成为一种",
  heroLine2: "可以共同珍藏的想象",
  disclaimer: "年龄变化、家庭场景与未来自我内容均为 AI 艺术化示意，不是对真实容貌、寿命、健康、职业或人生结果的预测。",
  boundaryTitle: "不可关闭的产品边界",
  boundaryConsent: "每位可识别参与者按用途授权",
  boundaryMinor: "儿童内容默认私密并采用更严格策略",
  boundaryDeletion: "分享可撤回，删除传播到全部副本",
  boundaryProvenance: "AI 标识与来源信息始终保留",
  tabJourney: "核心旅程",
  tabWorkspaces: "业务工作台",
  tabCapabilities: "128 项能力",
  tabOperations: "运行状态",
  journeyTitle: "合成数据核心旅程",
  syntheticOnly: "不会上传真实照片",
  tenant: "租户标识",
  actor: "操作者标识",
  age: "当前年龄",
  ageNodes: "示意性节点",
  consent: "我确认仅使用合成人物，并同意本次本地测试用途",
  create: "创建安全时间轴计划",
  waiting: "等待开始",
  waitingDescription: "授权通过后，系统会创建可审计、可重放的时间轴计划。",
  workspaceTitle: "角色化业务工作台",
  stableLinks: "每项能力都有稳定深链",
  workspaceDescription: "按消费者、家庭、伙伴、制作、运营、客服和开发者边界组织全部业务能力。生产环境仍由服务端权限决定可见范围。",
  capabilityTitle: "能力注册表",
  filter: "筛选",
  filterPlaceholder: "批次、领域或操作",
  operationsTitle: "运行与认证边界",
  codeBatches: "代码级批次",
  codeBatchesDescription: "必须与 B00—B127 清单逐项一致。",
  localEnvironment: "当前环境",
  localEnvironmentDescription: "只允许合成数据和沙箱提供商。",
  productionRelease: "生产发布",
  productionReleaseDescription: "真实支付、商店、税务、供应链和外部审查仍需独立证据。",
  local: "本地",
  uncertified: "未认证",
  footer: "隐私优先 · 合成数据 · 可审计",
  view: "查看",
  externalGate: "外部证据门",
  externalEvidenceCount: "需要可信外部证据",
  registeredBatches: "已注册批次",
  skillDomains: "技能领域",
  closeDetails: "关闭能力详情",
  startApi: "请先运行 pnpm dev 启动本地 API",
  syntheticConfirm: "必须确认合成数据与本地测试用途",
  completeJourney: "请完整填写旅程参数",
  creating: "正在创建…",
  policyCheck: "执行授权与策略检查。",
  timelineCreated: "本地计划已生成（未提交）",
  timelineCreatedDescription: "生产提交必须先完成服务端媒体入口、B07 安全批准和参与者用途授权；此页面不会伪造资产或成功状态。",
  safeStop: "安全停止",
  noMatch: "没有匹配的能力。",
  stableEndpoint: "稳定 API 入口",
  executionMode: "执行模式",
  atomicRequirements: "原子需求",
  externalRequired: "生产外部证据必需。",
  externalRequiredDescription: "未配置可信签发者、签名、作用域和有效期时，此操作会失败关闭。",
  protectedOperation: "该操作由租户、权限、幂等、审计和持久化控制保护。",
} as const;

export type CopyKey = keyof typeof ZH_CN;

const ZH_TW: Readonly<Record<CopyKey, string>> = {
  appSubtitle: "本機商業能力控制台", skipMain: "跳到主要內容", language: "介面語言", consoleViews: "控制台視圖", businessPortals: "業務入口", connecting: "正在連線", online: "本機運行正常", offline: "本機 API 未啟動", authenticated: "身分已由伺服器驗證", authRequired: "需要登入", authRequiredDescription: "未建立伺服器驗證工作階段，業務工作台已失敗關閉。請使用安全登入。", signIn: "登入", signOut: "退出", signingIn: "正在透過安全身分提供者登入", signedOut: "已退出；記憶體工作階段已清除", authenticationFailed: "登入失敗，工作台已安全關閉",
  heroLine1: "讓未來成為一種", heroLine2: "可以共同珍藏的想像", disclaimer: "年齡變化、家庭場景與未來自我內容均為 AI 藝術化示意，不是對真實容貌、壽命、健康、職業或人生結果的預測。",
  boundaryTitle: "不可關閉的產品邊界", boundaryConsent: "每位可識別參與者按用途授權", boundaryMinor: "兒童內容預設私密並採用更嚴格策略", boundaryDeletion: "分享可撤回，刪除傳播到全部副本", boundaryProvenance: "AI 標識與來源資訊始終保留",
  tabJourney: "核心旅程", tabWorkspaces: "業務工作台", tabCapabilities: "128 項能力", tabOperations: "運行狀態", journeyTitle: "合成資料核心旅程", syntheticOnly: "不會上傳真實照片",
  tenant: "租戶標識", actor: "操作者標識", age: "目前年齡", ageNodes: "示意性節點", consent: "我確認僅使用合成人物，並同意本次本機測試用途", create: "建立安全時間軸計畫", waiting: "等待開始", waitingDescription: "授權通過後，系統會建立可稽核、可重播的時間軸計畫。",
  workspaceTitle: "角色化業務工作台", stableLinks: "每項能力都有穩定深連結", workspaceDescription: "按消費者、家庭、夥伴、製作、營運、客服和開發者邊界組織全部業務能力。生產環境仍由服務端權限決定可見範圍。",
  capabilityTitle: "能力註冊表", filter: "篩選", filterPlaceholder: "批次、領域或操作", operationsTitle: "運行與認證邊界", codeBatches: "程式碼級批次", codeBatchesDescription: "必須與 B00—B127 清單逐項一致。",
  localEnvironment: "目前環境", localEnvironmentDescription: "只允許合成資料和沙箱供應商。", productionRelease: "生產發佈", productionReleaseDescription: "真實支付、商店、稅務、供應鏈和外部審查仍需獨立證據。", local: "本機", uncertified: "未認證", footer: "隱私優先 · 合成資料 · 可稽核",
  view: "查看", externalGate: "外部證據門", externalEvidenceCount: "需要可信外部證據", registeredBatches: "已註冊批次", skillDomains: "技能領域", closeDetails: "關閉能力詳情",
  startApi: "請先運行 pnpm dev 啟動本機 API", syntheticConfirm: "必須確認合成資料與本機測試用途", completeJourney: "請完整填寫旅程參數", creating: "正在建立…", policyCheck: "建立不提交的本機計畫。", timelineCreated: "本機計畫已產生（未提交）", timelineCreatedDescription: "生產提交必須先完成伺服器媒體入口、B07 安全批准和參與者用途授權；此頁不會偽造資產或成功狀態。", safeStop: "安全停止", noMatch: "沒有匹配的能力。", stableEndpoint: "穩定 API 入口", executionMode: "執行模式", atomicRequirements: "原子需求", externalRequired: "生產外部證據必需。", externalRequiredDescription: "未設定可信簽發者、簽章、作用域和有效期時，此操作會失敗關閉。", protectedOperation: "該操作由租戶、權限、冪等、稽核和持久化控制保護。",
};

const EN: Readonly<Record<CopyKey, string>> = {
  appSubtitle: "Local commercial capability console", skipMain: "Skip to main content", language: "Interface language", consoleViews: "Console views", businessPortals: "Business portals", connecting: "Connecting", online: "Local runtime ready", offline: "Local API is not running", authenticated: "Identity verified by the server", authRequired: "Sign-in required", authRequiredDescription: "No server-verified session exists, so the business workspace has failed closed. Use secure sign-in.", signIn: "Sign in", signOut: "Sign out", signingIn: "Signing in through the trusted identity provider", signedOut: "Signed out; the in-memory session was cleared", authenticationFailed: "Sign-in failed; the workspace is safely closed",
  heroLine1: "Make the future an imagination", heroLine2: "worth preserving together", disclaimer: "Age transformations, family scenes, and future-self content are illustrative AI artwork, not predictions of real appearance, lifespan, health, career, or life outcomes.",
  boundaryTitle: "Non-negotiable product boundaries", boundaryConsent: "Every identifiable participant authorizes each purpose", boundaryMinor: "Children's content is private by default with stricter safeguards", boundaryDeletion: "Sharing is revocable and deletion propagates to every copy", boundaryProvenance: "AI labels and provenance always remain attached",
  tabJourney: "Core journey", tabWorkspaces: "Business workspaces", tabCapabilities: "128 capabilities", tabOperations: "Runtime status", journeyTitle: "Synthetic-data core journey", syntheticOnly: "No real photo is uploaded",
  tenant: "Tenant", actor: "Actor", age: "Current age", ageNodes: "Illustrative milestones", consent: "I confirm that I am using a synthetic person and consent to this local test purpose", create: "Create safe timeline plan", waiting: "Ready to begin", waitingDescription: "After authorization, the system creates an auditable, replay-safe timeline plan.",
  workspaceTitle: "Role-aware business workspaces", stableLinks: "Every capability has a stable deep link", workspaceDescription: "All business capabilities are organized across consumer, family, partner, studio, operations, support, and developer boundaries. Server-side authorization remains authoritative in production.",
  capabilityTitle: "Capability registry", filter: "Filter", filterPlaceholder: "Batch, domain, or operation", operationsTitle: "Runtime and certification boundary", codeBatches: "Code-level batches", codeBatchesDescription: "Must match the B00—B127 catalog exactly.",
  localEnvironment: "Current environment", localEnvironmentDescription: "Synthetic data and sandbox providers only.", productionRelease: "Production release", productionReleaseDescription: "Real payments, stores, tax, supply chain, and external reviews still require independent evidence.", local: "Local", uncertified: "Not certified", footer: "Privacy first · Synthetic data · Auditable",
  view: "View", externalGate: "External evidence gate", externalEvidenceCount: "Require trusted external evidence", registeredBatches: "Registered batches", skillDomains: "Skill domains", closeDetails: "Close capability details",
  startApi: "Run pnpm dev to start the local API", syntheticConfirm: "Confirm synthetic data and the local test purpose", completeJourney: "Complete all journey parameters", creating: "Creating…", policyCheck: "Building a local, non-submitted plan.", timelineCreated: "Local plan generated (not submitted)", timelineCreatedDescription: "Production submission first requires server media intake, B07 safety approval, and purpose-scoped participant consent; this page does not fabricate an asset or success state.", safeStop: "Safely stopped", noMatch: "No matching capability.", stableEndpoint: "Stable API endpoint", executionMode: "Execution mode", atomicRequirements: "Atomic requirements", externalRequired: "Production external evidence is required.", externalRequiredDescription: "The operation fails closed without a trusted issuer, signature, exact scope, and validity period.", protectedOperation: "Tenant, authorization, idempotency, audit, and durable storage controls protect this operation.",
};

const COPY: Readonly<Record<SupportedLocale, Readonly<Record<CopyKey, string>>>> = { "zh-CN": ZH_CN, "zh-TW": ZH_TW, en: EN };

export function translate(locale: SupportedLocale, key: CopyKey): string {
  const result = COPY[locale][key];
  if (result.trim() === "") throw new Error(`Missing ${locale} translation for ${key}`);
  return result;
}

export function normalizeLocale(value: string | null | undefined): SupportedLocale {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "zh-tw" || normalized === "zh-hk" || normalized === "zh-hant") return "zh-TW";
  if (normalized?.startsWith("en")) return "en";
  return "zh-CN";
}

export function localized(value: Readonly<Record<SupportedLocale, string>>, locale: SupportedLocale): string {
  const result = value[locale];
  if (result.trim() === "") throw new Error(`Missing ${locale} product copy`);
  return result;
}
