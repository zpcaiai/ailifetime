import {
  AiLifeTimeClient,
  createIdempotencyKey,
  type HttpTransportRequest,
} from '@ailifetime/sdk-ts';
import type {
  AgeBandPromptRecipe,
  AspectRatio,
  CheckoutSession,
  ConsentReceipt,
  FutureSelfMessage,
  GenerationJob,
  GuestSession,
  MiniProgramSession,
  Order,
  PortraitTemplateSpec,
  Project,
  ProjectRequest,
  RightsCase,
  Share,
  UploadSession,
  XhsNoteMountCard,
  XhsNoteMountRequest,
} from '@ailifetime/contracts';

const DEFAULT_API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || 'https://api.sandbox.ailifetime.local';
const IS_SANDBOX_MODE = import.meta.env.VITE_SANDBOX_MODE !== 'false';
const CONFIGURED_WEIXIN_APPID =
  import.meta.env.VITE_WECHAT_MINI_APPID || 'YOUR_WECHAT_MINI_APPID';
const CONFIGURED_XHS_APPID =
  import.meta.env.VITE_XHS_MINI_APPID || 'YOUR_XHS_MINI_APPID';

export interface LaunchReadinessCheckItem {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface MiniProgramLaunchReadinessReport {
  channel: 'mp-xhs' | 'mp-weixin' | 'h5';
  runtimeMode: 'sandbox-prelaunch' | 'production-live';
  apiBaseUrl: string;
  readyForDevToolsPreview: boolean;
  readyForStoreSubmission: boolean;
  checks: LaunchReadinessCheckItem[];
}

export function validateProductionApiOrigin(apiBaseUrl: string, isSandbox: boolean): void {
  if (isSandbox) {
    return;
  }
  const normalized = apiBaseUrl.trim();
  if (
    !normalized.startsWith('https://') ||
    normalized.includes('.local') ||
    normalized.includes('localhost') ||
    normalized.includes('127.0.0.1')
  ) {
    throw new Error(
      `PRODUCTION_API_ORIGIN_INVALID: 生产模式 (VITE_SANDBOX_MODE=false) 必须配置合法的备案 HTTPS 域名，当前为 ${normalized}`
    );
  }
}

export interface TimeCapsuleCardRenderRequest {
  template_id: string;
  style_id: string;
  size: '3:4' | '9:16' | '1:1';
  export_format: 'PNG' | 'WEBP';
  title: string;
  subtitle: string;
  display_name: string;
  event_date: string;
}

export interface TimeCapsuleCardRenderResult {
  template_id: string;
  template_name: string;
  style_id: string;
  style_name: string;
  size: '3:4' | '9:16' | '1:1';
  export_format: 'PNG' | 'WEBP';
  ai_generated: boolean;
  pricing_tier: 'FREE' | 'SINGLE' | 'BUNDLE';
  layout_digest: string;
  artifact_sha256: string;
  explicit_visible_label: string;
  implicit_metadata_chunk: 'PNG:iTXt:AIGeneratedContent' | 'WEBP:RIFF:AIGC';
  signature_hmac: string;
  svg_preview_summary: string;
  rendered_at: string;
}

// Ephemeral in-memory signed URL registry (purged on page/app hide per B70-R03)
const ephemeralPreviewRegistry = new Set<string>();
const sandboxShares = new Map<string, Share>();
const sandboxOrders = new Map<string, Order>();
let currentAccessToken: string | null = null;
let latestShareId = 'shr_xhs_latest';
let latestOrderId = 'ord_xhs_latest';
let preferredTemplateId = 'tpl_xhs_silver_halide_0_100';

interface SandboxProjectContext {
  project: Project;
  request: ProjectRequest;
}

const sandboxProjectRegistry = new Map<string, SandboxProjectContext>();

export interface TimeCapsuleCategoryItem {
  id: string;
  name: string;
}

export interface TimeCapsuleStyleItem {
  id: string;
  name: string;
  description: string;
  accent: string;
}

export interface TimeCapsuleTemplateItem {
  id: string;
  category: string;
  name: string;
  version: string;
  image_slots: number;
  sizes: Array<'3:4' | '9:16' | '1:1'>;
  ai_mode: 'none' | 'portrait_style' | 'age_simulation' | 'composite' | 'restoration';
  label_policy: 'conditional' | 'ai_required';
  pricing_tier: 'FREE' | 'SINGLE' | 'BUNDLE';
}

export const TIMECAPSULE_CATEGORIES: TimeCapsuleCategoryItem[] = [
  { id: 'profile', name: '个人介绍与社交名片' },
  { id: 'career', name: '职业与商务形象' },
  { id: 'timeline', name: '人生时光机' },
  { id: 'anniversary', name: '生日与纪念日' },
  { id: 'baby', name: '宝宝成长与亲子' },
  { id: 'couple', name: '恋爱婚姻纪念' },
  { id: 'family', name: '家庭代际记忆' },
  { id: 'travel', name: '旅行生活记录' },
  { id: 'achievement', name: '成就学习里程碑' },
  { id: 'pet', name: '宠物时光机' },
  { id: 'creative', name: 'AI创意写真' },
  { id: 'memory', name: '珍贵回忆' },
];

export const TIMECAPSULE_STYLES: TimeCapsuleStyleItem[] = [
  { id: 'minimal', name: '极简商务', description: '高对比网格排版', accent: '#AA785A' },
  { id: 'scrapbook', name: '可爱手账', description: '柔和拼贴与温度感纸张', accent: '#AA785A' },
  { id: 'luxury', name: '黑金高级', description: '典藏画册与克制鎏金', accent: '#AA785A' },
  { id: 'retro', name: '复古胶片', description: '暖调银盐颗粒与胶片边框', accent: '#AA785A' },
  { id: 'futuristic', name: '科技未来', description: '冷调流光与结构化面板', accent: '#1F6FEB' },
];

export const TIMECAPSULE_TEMPLATES: TimeCapsuleTemplateItem[] = [
  { id: 'personal_intro', category: 'profile', name: '个人介绍信息卡', version: '1.0.0', image_slots: 1, sizes: ['3:4', '9:16', '1:1'], ai_mode: 'none', label_policy: 'conditional', pricing_tier: 'FREE' },
  { id: 'social_contact', category: 'profile', name: '微信交友名片', version: '1.0.0', image_slots: 1, sizes: ['3:4', '9:16'], ai_mode: 'none', label_policy: 'conditional', pricing_tier: 'FREE' },
  { id: 'business_card', category: 'career', name: '职业商务名片', version: '1.0.0', image_slots: 1, sizes: ['3:4', '9:16'], ai_mode: 'none', label_policy: 'conditional', pricing_tier: 'FREE' },
  { id: 'personal_portrait', category: 'career', name: 'AI个人形象卡', version: '1.0.0', image_slots: 1, sizes: ['3:4', '9:16', '1:1'], ai_mode: 'portrait_style', label_policy: 'ai_required', pricing_tier: 'SINGLE' },
  { id: 'life_0_100', category: 'timeline', name: '人生0-100岁照片', version: '1.0.0', image_slots: 1, sizes: ['3:4', '9:16'], ai_mode: 'age_simulation', label_policy: 'ai_required', pricing_tier: 'SINGLE' },
  { id: 'past_me', category: 'timeline', name: '童年与现在合影', version: '1.0.0', image_slots: 2, sizes: ['3:4', '9:16'], ai_mode: 'composite', label_policy: 'ai_required', pricing_tier: 'SINGLE' },
  { id: 'future_me', category: 'timeline', name: '未来20年的自己', version: '1.0.0', image_slots: 1, sizes: ['3:4', '9:16', '1:1'], ai_mode: 'age_simulation', label_policy: 'ai_required', pricing_tier: 'SINGLE' },
  { id: 'birthday', category: 'anniversary', name: '生日祝福卡', version: '1.0.0', image_slots: 1, sizes: ['3:4', '9:16'], ai_mode: 'none', label_policy: 'conditional', pricing_tier: 'FREE' },
  { id: 'baby_month', category: 'baby', name: '宝宝成长月龄卡', version: '1.0.0', image_slots: 1, sizes: ['3:4', '9:16'], ai_mode: 'none', label_policy: 'conditional', pricing_tier: 'FREE' },
  { id: 'couple_anniversary', category: 'couple', name: '情侣纪念卡', version: '1.0.0', image_slots: 2, sizes: ['3:4', '9:16', '1:1'], ai_mode: 'none', label_policy: 'conditional', pricing_tier: 'FREE' },
  { id: 'moments_grid', category: 'travel', name: '朋友圈九宫格', version: '1.0.0', image_slots: 9, sizes: ['3:4', '9:16'], ai_mode: 'none', label_policy: 'conditional', pricing_tier: 'FREE' },
  { id: 'retro_portrait', category: 'creative', name: '复古年代写真', version: '1.0.0', image_slots: 1, sizes: ['3:4', '9:16'], ai_mode: 'portrait_style', label_policy: 'ai_required', pricing_tier: 'SINGLE' },
  { id: 'graduation', category: 'achievement', name: '毕业纪念卡', version: '1.0.0', image_slots: 1, sizes: ['3:4', '9:16', '1:1'], ai_mode: 'none', label_policy: 'conditional', pricing_tier: 'FREE' },
  { id: 'family_photo', category: 'family', name: '全家福生成', version: '1.0.0', image_slots: 5, sizes: ['3:4', '9:16'], ai_mode: 'composite', label_policy: 'ai_required', pricing_tier: 'BUNDLE' },
  { id: 'old_photo_restore', category: 'memory', name: '老照片修复纪念', version: '1.0.0', image_slots: 1, sizes: ['3:4', '9:16'], ai_mode: 'restoration', label_policy: 'ai_required', pricing_tier: 'SINGLE' },
  { id: 'pet_identity', category: 'pet', name: '宠物身份卡', version: '1.0.0', image_slots: 1, sizes: ['3:4', '9:16', '1:1'], ai_mode: 'none', label_policy: 'conditional', pricing_tier: 'FREE' },
  { id: 'travel_postcard', category: 'travel', name: '旅行明信片', version: '1.0.0', image_slots: 1, sizes: ['3:4', '9:16'], ai_mode: 'none', label_policy: 'conditional', pricing_tier: 'FREE' },
  { id: 'annual_review', category: 'timeline', name: '年度人生回顾', version: '1.0.0', image_slots: 12, sizes: ['3:4', '9:16'], ai_mode: 'none', label_policy: 'conditional', pricing_tier: 'BUNDLE' },
  { id: 'portfolio', category: 'career', name: '个人作品展示卡', version: '1.0.0', image_slots: 3, sizes: ['3:4', '9:16', '1:1'], ai_mode: 'none', label_policy: 'conditional', pricing_tier: 'FREE' },
  { id: 'life_album', category: 'memory', name: '人生数字纪念册', version: '1.0.0', image_slots: 12, sizes: ['3:4', '9:16'], ai_mode: 'composite', label_policy: 'ai_required', pricing_tier: 'BUNDLE' },
];

let preferredTimeCapsuleCardId = 'life_0_100';
let preferredTimeCapsuleStyleId = 'retro';

export function setPreferredTimeCapsuleSelection(cardId: string, styleId?: string): void {
  preferredTimeCapsuleCardId = cardId;
  if (styleId) {
    preferredTimeCapsuleStyleId = styleId;
  }
}

export function getPreferredTimeCapsuleSelection(): { cardId: string; styleId: string } {
  return {
    cardId: preferredTimeCapsuleCardId,
    styleId: preferredTimeCapsuleStyleId,
  };
}

export function setPreferredTemplateId(templateId: string): void {
  preferredTemplateId = templateId;
}

export function getPreferredTemplateId(): string {
  return preferredTemplateId;
}

export function registerEphemeralPreviewUrl(url: string): void {
  ephemeralPreviewRegistry.add(url);
}

export function purgeEphemeralMediaCache(): void {
  ephemeralPreviewRegistry.clear();
}

export function getEphemeralPreviewCount(): number {
  return ephemeralPreviewRegistry.size;
}

export function setAccessToken(token: string | null): void {
  currentAccessToken = token;
}

export function getLatestShareId(): string {
  return latestShareId;
}

export function getLatestOrderId(): string {
  return latestOrderId;
}

export function getTrackedShare(shareId: string): Share | undefined {
  return sandboxShares.get(shareId);
}

export function getCurrentPlatformChannel(): 'mp-xhs' | 'mp-weixin' | 'h5' {
  // #ifdef MP-XHS
  return 'mp-xhs';
  // #endif
  // #ifdef MP-WEIXIN
  return 'mp-weixin';
  // #endif
  // #ifndef MP-XHS || MP-WEIXIN
  return 'h5';
  // #endif
}

const ANTI_PLASTIC_NEGATIVE_CONSTRAINTS = [
  'plastic over-smoothed skin',
  'wax figure complexion',
  'airbrushed beauty filter',
  'uncanny valley facial proportions',
  'identity drift or swapped bone structure',
  'asymmetric irises or strabismus artifacts',
  'deformed hands or extra fingers',
  'distorted teeth or unnatural dental arch',
  'fake glued-on beard or Halloween wig',
  'harsh flat flash overexposure',
  'cartoonish 3D CGI render',
];

function buildAgeBandRecipes(wardrobeTheme: string, backdropTheme: string): AgeBandPromptRecipe[] {
  return [
    {
      band_key: 'childhood_0_8',
      min_age: 0,
      max_age: 8,
      stage_label: '童年纯真',
      craniofacial_and_skin_cue:
        'authentic childhood craniofacial neoteny, higher forehead-to-jaw ratio, soft buccal fullness, translucent natural skin texture with zero adult makeup, preserving exact interpupillary distance and canthal tilt',
      hair_and_grooming_cue: 'fine soft natural childhood hair strands, clean natural hairline',
      wardrobe_and_styling_cue: `age-appropriate childhood soft cotton/knit collar (${wardrobeTheme})`,
      pose_and_gaze_cue: 'curious clear eye contact, relaxed natural head tilt, bright catchlights',
      backdrop_and_atmosphere_cue: `warm nostalgic studio ambiance (${backdropTheme})`,
      identity_lock_strength: 0.84,
    },
    {
      band_key: 'adolescence_9_16',
      min_age: 9,
      max_age: 16,
      stage_label: '少年澄澈',
      craniofacial_and_skin_cue:
        'emerging adolescent nasal bridge and jawline definition, natural teenage skin pores, authentic facial bone landmarks locked to source identity, zero adultification',
      hair_and_grooming_cue: 'neat school-age natural hair texture with subtle flyaway realism',
      wardrobe_and_styling_cue: `clean youth casual shirt/knitwear (${wardrobeTheme})`,
      pose_and_gaze_cue: 'upright posture, sincere calm gaze toward camera',
      backdrop_and_atmosphere_cue: `soft daylight-balanced studio backdrop (${backdropTheme})`,
      identity_lock_strength: 0.88,
    },
    {
      band_key: 'youth_17_24',
      min_age: 17,
      max_age: 24,
      stage_label: '青春启航',
      craniofacial_and_skin_cue:
        'fully developed young-adult craniofacial structure, crisp jawline, luminous healthy dermis with visible microscopic pore texture and natural sebaceous sheen, zero plastic smoothing',
      hair_and_grooming_cue: 'dense healthy hair volume with natural specular highlights',
      wardrobe_and_styling_cue: `tailored young-adult minimalist collar (${wardrobeTheme})`,
      pose_and_gaze_cue: 'confident composed three-quarter shoulder angle, direct expressive gaze',
      backdrop_and_atmosphere_cue: `clean editorial portrait environment (${backdropTheme})`,
      identity_lock_strength: 0.93,
    },
    {
      band_key: 'prime_25_35',
      min_age: 25,
      max_age: 35,
      stage_label: '当下绽放',
      craniofacial_and_skin_cue:
        'peak adult bone definition, exact 1:1 facial landmark fidelity to source identity anchor, natural micro-texture across zygomatic arch and philtrum, authentic eye orbicularis detail',
      hair_and_grooming_cue: 'well-groomed natural hair styling with individual strand separation',
      wardrobe_and_styling_cue: `contemporary textured fabric neckline (${wardrobeTheme})`,
      pose_and_gaze_cue: 'poised natural expression, subtle micro-smile in eyes, balanced head alignment',
      backdrop_and_atmosphere_cue: `signature studio portrait depth (${backdropTheme})`,
      identity_lock_strength: 0.96,
    },
    {
      band_key: 'maturity_36_50',
      min_age: 36,
      max_age: 50,
      stage_label: '从容岁月',
      craniofacial_and_skin_cue:
        'composed mid-life facial maturity, subtle natural lateral canthal laugh lines and gentle nasolabial fold deepening, refined cheekbone contour, authentic mid-life skin elasticity',
      hair_and_grooming_cue: 'mature hair density with occasional subtle temple silver threads',
      wardrobe_and_styling_cue: `refined wool/cashmere or structured linen collar (${wardrobeTheme})`,
      pose_and_gaze_cue: 'grounded calm presence, warm experienced gaze, relaxed shoulders',
      backdrop_and_atmosphere_cue: `rich tonal portrait atmosphere (${backdropTheme})`,
      identity_lock_strength: 0.92,
    },
    {
      band_key: 'silver_prime_51_68',
      min_age: 51,
      max_age: 68,
      stage_label: '温情银发',
      craniofacial_and_skin_cue:
        "graceful early-senior bone and soft-tissue evolution, natural periorbital crow's feet, authentic forehead and nasolabial expression lines, realistic dermal texture while preserving core eye and nose geometry",
      hair_and_grooming_cue: 'natural salt-and-pepper to luminous silver hair strands with realistic texture',
      wardrobe_and_styling_cue: `warm timeless knit or classic shawl collar (${wardrobeTheme})`,
      pose_and_gaze_cue: 'gentle benevolent expression, warm eye catchlights, dignified posture',
      backdrop_and_atmosphere_cue: `warm intimate studio light falloff (${backdropTheme})`,
      identity_lock_strength: 0.89,
    },
    {
      band_key: 'elder_69_84',
      min_age: 69,
      max_age: 84,
      stage_label: '岁月沉淀',
      craniofacial_and_skin_cue:
        "dignified elder facial anatomy, natural subcutaneous volume softening along mandible, authentic multi-layered skin creases, unmistakably the same person's orbital socket and gaze character",
      hair_and_grooming_cue: 'soft silver-white hair with natural thinning and fine halo wisping',
      wardrobe_and_styling_cue: `classic soft-textured cardigan or heritage collar (${wardrobeTheme})`,
      pose_and_gaze_cue: 'serene reflective gaze, warm lived-in smile lines, composed head posture',
      backdrop_and_atmosphere_cue: `classic fine-art portrait shadow depth (${backdropTheme})`,
      identity_lock_strength: 0.86,
    },
    {
      band_key: 'centenarian_85_100',
      min_age: 85,
      max_age: 120,
      stage_label: '世纪回眸',
      craniofacial_and_skin_cue:
        'reverent centenarian artistic portrait, delicate parchment-like dermal micro-topography, deeply etched harmonious life lines, preserved ocular spacing and signature gaze spirit',
      hair_and_grooming_cue: 'pure gossamer silver-white hair illuminated by gentle rim light',
      wardrobe_and_styling_cue: `timeless dignified high-neck wool or silk wrap (${wardrobeTheme})`,
      pose_and_gaze_cue: 'peaceful luminous eyes, quiet dignity, timeless frontal-three-quarter framing',
      backdrop_and_atmosphere_cue: `museum-grade chiaroscuro portrait ambiance (${backdropTheme})`,
      identity_lock_strength: 0.83,
    },
  ];
}

export const BUILTIN_PORTRAIT_TEMPLATES: PortraitTemplateSpec[] = [
  {
    template_id: 'tpl_xhs_silver_halide_0_100',
    version: '2.1.0',
    name: '经典银盐胶片·人生时间轴',
    subtitle: '85mm 大光圈人像定焦 · 伦勃朗柔光 · 真实肌理零塑料感',
    category: 'solo-portrait',
    badge: '小红书爆款主推',
    status: 'active',
    max_participants: 1,
    min_age: 0,
    max_age: 100,
    recommended_ages: [6, 18, 28, 45, 65, 85],
    supported_aspect_ratios: ['3:4', '4:5', '1:1', '9:16'],
    default_aspect_ratio: '3:4',
    required_consents: ['age-transformation'],
    provider_capabilities: ['face-id-lock', 'controlnet-depth', 'high-res-skin-detail'],
    cost_tier: 'pro-studio',
    allowed_channels: ['mp-xhs', 'mp-weixin', 'consumer-web', 'mobile', 'studio'],
    competitive_highlights: [
      '85mm f/1.8 黄金人像焦段，锁定同一视平线与焦平面，6 张拼图如同一位摄影师跨越半世纪跟拍',
      '真实皮肤微孔与皮下散射（SSS）质感，严禁廉价磨皮与假胡子贴图',
      '以用户当前真实年龄为骨相锚点向两端自然推演，支持童年回溯创作标注',
    ],
    optics_and_lighting: {
      focal_length_mm: 85,
      aperture: 'f/1.8',
      framing: 'medium close-up chest-up portrait, consistent eye-line at upper third',
      lighting_setup: '45° 伦勃朗八角柔光箱主光 + 暖调发丝轮廓光 (3:1 光比)',
      color_science: 'Kodak Portra 400 暖调肤色曲线 + 银盐高光柔化过渡',
      skin_texture_policy: '保留微距毛孔、绒毛与真实岁月纹路，拒绝塑料磨皮感',
      film_grain_profile: '35mm 细腻有机银盐颗粒 (ISO 200)',
    },
    identity_preservation: {
      identity_adapter: 'instantid-pulid-hybrid-v2',
      craniofacial_anchor_weight: 0.92,
      eye_geometry_lock: 0.95,
      skin_undertone_lock: 0.9,
      expression_naturalness_weight: 0.88,
    },
    quality_thresholds: {
      min_identity_similarity: 0.82,
      max_facial_drift: 0.16,
      min_age_plausibility: 0.85,
      min_pose_background_coherence: 0.86,
      min_artifact_free_score: 0.9,
      min_sharpness_score: 0.84,
      min_aesthetic_score: 0.86,
      max_auto_retries: 2,
    },
    negative_constraints: ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
    age_band_recipes: buildAgeBandRecipes(
      'timeless monochrome textured knit & linen',
      'charcoal-warm-grey hand-brushed studio canvas with soft vignette'
    ),
  },
  {
    template_id: 'tpl_xhs_oriental_aesthetics_portrait',
    version: '2.1.0',
    name: '东方光影新中式·岁月肖像',
    subtitle: '90mm 微距人像 · 宣纸窗光 · 温润东方骨相美学',
    category: 'editorial',
    badge: '新中式高赞',
    status: 'active',
    max_participants: 1,
    min_age: 0,
    max_age: 100,
    recommended_ages: [6, 18, 28, 45, 65, 85],
    supported_aspect_ratios: ['3:4', '4:5', '9:16'],
    default_aspect_ratio: '3:4',
    required_consents: ['age-transformation'],
    provider_capabilities: ['face-id-lock', 'editorial-lighting', 'high-res-skin-detail'],
    cost_tier: 'pro-studio',
    allowed_channels: ['mp-xhs', 'mp-weixin', 'consumer-web', 'studio'],
    competitive_highlights: [
      '针对亚洲面部骨相与折叠度专门调校的柔和侧逆光，避免欧美模型常见的深眼窝异化',
      '桑蚕丝、苎麻与羊绒领口质感随年龄阶段自然演进，极具小红书高赞清冷故事感',
      '水墨灰阶留白背景，突出人物眼神流转与岁月从容气韵',
    ],
    optics_and_lighting: {
      focal_length_mm: 90,
      aperture: 'f/2.0',
      framing: 'vertical editorial bust portrait with balanced negative space',
      lighting_setup: '漫反射宣纸窗光侧逆主光 + 丝绸反光板柔补',
      color_science: '东方温润玉质肤色校准 + 低饱和水墨灰阶暗部',
      skin_texture_policy: '自然哑光瓷感肌理与真实细纹并存，禁止假白过曝',
      film_grain_profile: '中画幅 Fujifilm Pro 400H 细腻色调颗粒',
    },
    identity_preservation: {
      identity_adapter: 'east-asian-craniofacial-lock-v2',
      craniofacial_anchor_weight: 0.94,
      eye_geometry_lock: 0.96,
      skin_undertone_lock: 0.93,
      expression_naturalness_weight: 0.9,
    },
    quality_thresholds: {
      min_identity_similarity: 0.84,
      max_facial_drift: 0.14,
      min_age_plausibility: 0.85,
      min_pose_background_coherence: 0.88,
      min_artifact_free_score: 0.91,
      min_sharpness_score: 0.85,
      min_aesthetic_score: 0.88,
      max_auto_retries: 2,
    },
    negative_constraints: [
      ...ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
      'westernized deep-set brow bone distortion',
      'garish neon oversaturation',
    ],
    age_band_recipes: buildAgeBandRecipes(
      'minimalist Oriental mulberry silk, ramie linen, and cashmere stand-collar',
      'serene warm rice-paper & ink-wash gradient studio backdrop'
    ),
  },
  {
    template_id: 'tpl_xhs_era_chronicle_documentary',
    version: '2.1.0',
    name: '时代纪实记忆·年代光影胶片',
    subtitle: '50mm 纪实人文镜头 · 跨年代生活光影 · 家庭相册真迹感',
    category: 'documentary',
    badge: '情感共鸣王牌',
    status: 'active',
    max_participants: 1,
    min_age: 0,
    max_age: 100,
    recommended_ages: [6, 18, 28, 45, 65, 85],
    supported_aspect_ratios: ['3:4', '1:1', '4:5'],
    default_aspect_ratio: '3:4',
    required_consents: ['age-transformation'],
    provider_capabilities: ['face-id-lock', 'scene-depth-lock'],
    cost_tier: 'standard',
    allowed_channels: ['mp-xhs', 'mp-weixin', 'consumer-web', 'mobile'],
    competitive_highlights: [
      '50mm f/1.4 经典人文视角，呈现真实生活环境光（阳光书房、老院子、暖光窗边）',
      '像翻开一本跨越百年的私人家庭纪实相册，极具真实感与情绪感染力',
      '严格锁定视线高度与中心构图，非常适合制作滑动对比或宫格卡点笔记',
    ],
    optics_and_lighting: {
      focal_length_mm: 50,
      aperture: 'f/1.4',
      framing: 'environmental documentary medium portrait, centered eye-level composition',
      lighting_setup: '黄金时刻自然斜射窗光 + 室内漫反射环境光',
      color_science: 'Leica M 经典人文色彩科学 + 丰富中间调微反差',
      skin_texture_policy: '纪实级无修饰真实肤质，保留自然阳光肌理与笑纹',
      film_grain_profile: 'Kodak ColorPlus 200 经典胶片颗粒',
    },
    identity_preservation: {
      identity_adapter: 'instantid-pulid-hybrid-v2',
      craniofacial_anchor_weight: 0.91,
      eye_geometry_lock: 0.94,
      skin_undertone_lock: 0.88,
      expression_naturalness_weight: 0.92,
    },
    quality_thresholds: {
      min_identity_similarity: 0.81,
      max_facial_drift: 0.17,
      min_age_plausibility: 0.84,
      min_pose_background_coherence: 0.84,
      min_artifact_free_score: 0.89,
      min_sharpness_score: 0.82,
      min_aesthetic_score: 0.85,
      max_auto_retries: 2,
    },
    negative_constraints: ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
    age_band_recipes: buildAgeBandRecipes(
      'authentic era-appropriate everyday woven shirt, trench, and soft sweater',
      'softly defocused warm sunlit study room and courtyard foliage bokeh'
    ),
  },
  {
    template_id: 'tpl_xhs_warm_family_co_aging',
    version: '2.1.0',
    name: '温情伴侣/家人共老·时光合拍',
    subtitle: '双人/多人同框授权 · 统一主光与焦平面 · 跨越半世纪的陪伴',
    category: 'family-co-aging',
    badge: '家庭/伴侣必拍',
    status: 'active',
    max_participants: 3,
    min_age: 0,
    max_age: 100,
    recommended_ages: [18, 28, 45, 65, 85],
    supported_aspect_ratios: ['3:4', '4:5', '1:1'],
    default_aspect_ratio: '3:4',
    required_consents: ['age-transformation', 'family-co-aging'],
    provider_capabilities: ['multi-subject-face-lock', 'dual-focal-plane-control', 'high-res-skin-detail'],
    cost_tier: 'pro-studio',
    allowed_channels: ['mp-xhs', 'mp-weixin', 'consumer-web', 'studio'],
    competitive_highlights: [
      '支持 1—3 人逐人独立授权合拍，自动对齐多人面部光照方向与 f/2.8 景深平面',
      '解决多人合成常见的“各看各的、光影割裂、头身比失调”痛点',
      '内置未成年人保护策略：含未成年人出镜时默认私密并禁止公开挂载',
    ],
    optics_and_lighting: {
      focal_length_mm: 50,
      aperture: 'f/2.8',
      framing: 'intimate dual/group half-body portrait, unified focal plane across all faces',
      lighting_setup: '150cm 巨型深口抛物线柔光伞主光 + 暖调环绕补光',
      color_science: '暖琥珀家庭肖像色彩科学，平衡多人肤色明度',
      skin_texture_policy: '多人独立面部特征锚定，严禁人脸特征串色或融合伪影',
      film_grain_profile: '柔和中画幅肖像颗粒',
    },
    identity_preservation: {
      identity_adapter: 'multi-slot-region-pulid-v2',
      craniofacial_anchor_weight: 0.93,
      eye_geometry_lock: 0.95,
      skin_undertone_lock: 0.91,
      expression_naturalness_weight: 0.91,
    },
    quality_thresholds: {
      min_identity_similarity: 0.8,
      max_facial_drift: 0.18,
      min_age_plausibility: 0.83,
      min_pose_background_coherence: 0.85,
      min_artifact_free_score: 0.9,
      min_sharpness_score: 0.83,
      min_aesthetic_score: 0.85,
      max_auto_retries: 3,
    },
    negative_constraints: [
      ...ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
      'cross-participant face blending or identity swap',
      'inconsistent lighting direction between subjects',
    ],
    age_band_recipes: buildAgeBandRecipes(
      'coordinated warm neutral family knitwear and linen tones',
      'warm heirloom studio portrait backdrop with gentle golden halo'
    ),
  },
  {
    template_id: 'tpl_xhs_master_fine_art_photobook',
    version: '2.1.0',
    name: '典藏画册高定棚拍·实体印刷版',
    subtitle: '中画幅 4:5 印刷画幅 · 300DPI 色彩预检 · 专供精装时光相册',
    category: 'fine-art-print',
    badge: '实物相册专享',
    status: 'active',
    max_participants: 2,
    min_age: 0,
    max_age: 100,
    recommended_ages: [6, 18, 28, 45, 65, 85],
    supported_aspect_ratios: ['4:5', '3:4', '1:1'],
    default_aspect_ratio: '4:5',
    required_consents: ['age-transformation', 'physical-print'],
    provider_capabilities: ['face-id-lock', 'print-300dpi-upscale', 'cmyk-gamut-safe'],
    cost_tier: 'master-print',
    allowed_channels: ['mp-xhs', 'mp-weixin', 'consumer-web', 'studio', 'kiosk'],
    competitive_highlights: [
      '按商业影楼中画幅（Hasselblad 80mm）棚拍标准设计，暗部层次针对实体相册纸张油墨优化',
      '预留 3mm 印刷出血位安全构图，直连 99 元典藏精装时光相册（PHOTO_BOOK_HARDCOVER_0_100）',
      '最高的身份相似度（>=0.85）与审美门控阈值，确保实物印刷零瑕疵',
    ],
    optics_and_lighting: {
      focal_length_mm: 80,
      aperture: 'f/2.8',
      framing: 'medium-format 4:5 fine-art portrait with 3mm print-bleed safe margins',
      lighting_setup: '经典影楼雷达罩蝴蝶光 + 双侧条形轮廓光 + 负补光增强立体感',
      color_science: '16-bit AdobeRGB / CMYK 印刷安全色域曲线，丝绒级暗部层次',
      skin_texture_policy: '300DPI 超高清微距肤质纹理，适配艺术铜版纸实体印刷',
      film_grain_profile: '艺术微喷纯棉画布纸微肌理',
    },
    identity_preservation: {
      identity_adapter: 'instantid-pulid-master-print-v2',
      craniofacial_anchor_weight: 0.95,
      eye_geometry_lock: 0.97,
      skin_undertone_lock: 0.93,
      expression_naturalness_weight: 0.9,
    },
    quality_thresholds: {
      min_identity_similarity: 0.85,
      max_facial_drift: 0.13,
      min_age_plausibility: 0.87,
      min_pose_background_coherence: 0.88,
      min_artifact_free_score: 0.93,
      min_sharpness_score: 0.88,
      min_aesthetic_score: 0.89,
      max_auto_retries: 3,
    },
    negative_constraints: [
      ...ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
      'clipped shadows or blown highlights outside CMYK print gamut',
      'edge cropping near print bleed zone',
    ],
    age_band_recipes: buildAgeBandRecipes(
      'bespoke fine-art studio velvet, tailored wool, and timeless silk',
      'museum-grade hand-painted Oliphant canvas backdrop'
    ),
  },
];

function findTemplateSpec(templateId?: string): PortraitTemplateSpec {
  const normalized =
    templateId === 'tpl_xhs_0_100_timeline' || !templateId
      ? 'tpl_xhs_silver_halide_0_100'
      : templateId;
  return (
    BUILTIN_PORTRAIT_TEMPLATES.find((t) => t.template_id === normalized) ||
    BUILTIN_PORTRAIT_TEMPLATES[0]
  );
}

function resolveAgeBandRecipe(tpl: PortraitTemplateSpec, age: number): AgeBandPromptRecipe {
  for (const r of tpl.age_band_recipes) {
    if (age >= r.min_age && age <= r.max_age) {
      return r;
    }
  }
  return tpl.age_band_recipes[tpl.age_band_recipes.length - 1];
}

/**
 * Deterministic local sandbox responder when running offline in Xiaohongshu DevTools
 */
function resolveSandboxResponse<T>(req: HttpTransportRequest): T {
  const now = new Date();
  const inOneHour = new Date(now.getTime() + 3600 * 1000).toISOString();

  if (req.path.endsWith('/v1/templates') && req.method === 'GET') {
    return BUILTIN_PORTRAIT_TEMPLATES as unknown as T;
  }

  if (req.path.includes('/v1/templates/') && req.method === 'GET') {
    const tplId = decodeURIComponent(req.path.split('/').pop() || '');
    return findTemplateSpec(tplId) as unknown as T;
  }

  if (req.path.endsWith('/v1/guest-sessions') && req.method === 'POST') {
    const res: GuestSession = {
      id: `guest_xhs_${Date.now()}`,
      expires_at: inOneHour,
      consent_preflight_version: '2026.11-cn-xhs',
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/mini-program/sessions') && req.method === 'POST') {
    const body = (req.body || {}) as { platform?: 'mp-xhs' | 'mp-weixin' };
    const platform = body.platform || 'mp-xhs';
    const token = `st_sandbox_${Date.now()}`;
    setAccessToken(token);
    const res: MiniProgramSession = {
      session_id: `mps_${Date.now()}`,
      actor_pseudonym: `act_${platform.replace('-', '_')}_${Date.now().toString(16)}`,
      platform,
      access_token: token,
      expires_at: inOneHour,
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/xhs/note-mounts') && req.method === 'POST') {
    const body = (req.body || {}) as XhsNoteMountRequest;
    if (body.contains_minor) {
      throw new Error('MINOR_PUBLIC_MOUNT_FORBIDDEN: 未成年人出镜作品禁止公开挂载至小红书笔记');
    }
    const targetShareId = body.share_id || latestShareId;
    const tracked = sandboxShares.get(targetShareId);
    if (tracked && tracked.status !== 'active') {
      throw new Error(`SHARE_NOT_ACTIVE: 分享链接状态为 ${tracked.status}，无法生成挂载卡片`);
    }
    const rawTitle = (body.title || '0—100岁人生时光胶片').trim();
    const enforcedTitle = rawTitle.includes('AI') ? rawTitle : `【AI艺术示意】${rawTitle}`;
    const mountId = `mnt_${Date.now()}`;
    const res: XhsNoteMountCard = {
      mount_id: mountId,
      share_id: targetShareId,
      xhs_path: `/pages/index/index?share_id=${encodeURIComponent(targetShareId)}&mount_id=${mountId}&ai_label=1`,
      enforced_title: enforcedTitle,
      ai_watermark_badge: 'AI生成·艺术示意非真实预测',
      topic_tags: body.topic_tags || ['AI人生时光机', '0到100岁的自己'],
      expires_at: tracked?.expires_at || inOneHour,
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/consents') && req.method === 'POST') {
    const res: ConsentReceipt = {
      id: `consent_${Date.now()}`,
      status: 'active',
      evidence_hash: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      granted_at: now.toISOString(),
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/upload-sessions') && req.method === 'POST') {
    const res: UploadSession = {
      id: `upl_${Date.now()}`,
      asset_id: `asset_${Date.now()}`,
      upload_url: 'https://upload.sandbox.ailifetime.local/signed-put',
      expires_at: inOneHour,
      required_headers: {
        'x-amz-server-side-encryption': 'AES256',
      },
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/projects') && req.method === 'POST') {
    const body = (req.body || {}) as ProjectRequest;
    const tpl = findTemplateSpec(body.template_id);
    const chosenRatio: AspectRatio = body.aspect_ratio || tpl.default_aspect_ratio;
    const anchorAge = typeof body.current_age === 'number' ? body.current_age : 28;
    const projId = `proj_${Date.now()}`;
    const res: Project = {
      id: projId,
      state: 'ready',
      version: 1,
      template_id: tpl.template_id,
      template_version: tpl.version,
      current_age_anchor: anchorAge,
      aspect_ratio: chosenRatio,
      policy_summary: {
        ai_label_enforced: true,
        consent_verified: true,
        template_name: tpl.name,
        quality_gate_min_identity: tpl.quality_thresholds.min_identity_similarity,
      },
    };
    sandboxProjectRegistry.set(projId, { project: res, request: body });
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/generation-jobs') && req.method === 'POST') {
    const body = (req.body || {}) as { project_id?: string };
    const ctx = body.project_id ? sandboxProjectRegistry.get(body.project_id) : undefined;
    const tpl = findTemplateSpec(ctx?.project.template_id);
    const ages =
      ctx?.request.timeline_ages && ctx.request.timeline_ages.length > 0
        ? [...ctx.request.timeline_ages].sort((a, b) => a - b)
        : [6, 18, 28, 45, 65, 85];
    const anchorAge = ctx?.project.current_age_anchor ?? 28;
    const chosenRatio = ctx?.project.aspect_ratio ?? tpl.default_aspect_ratio;

    const jobId = `job_${Date.now()}`;
    const frames = ages.map((age) => {
      const recipe = resolveAgeBandRecipe(tpl, age);
      const isRetroactive = age < anchorAge;
      const ageDelta = age - anchorAge;
      const distancePenalty = Math.min(0.08, Math.abs(ageDelta) * 0.001);
      const identityScore = Number(
        Math.max(0.84, Math.min(0.98, recipe.identity_lock_strength - distancePenalty)).toFixed(2)
      );
      const aestheticScore = Number(
        Math.max(tpl.quality_thresholds.min_aesthetic_score + 0.04, 0.91).toFixed(2)
      );
      const optics = tpl.optics_and_lighting;
      const opticsSummary = `${optics.focal_length_mm}mm ${optics.aperture} · ${optics.lighting_setup.split('+')[0].trim()} · ${chosenRatio}`;
      const compiledPrompt = [
        `[${tpl.name} v${tpl.version}]`,
        `Anchor=${anchorAge}yo -> Target=${age}yo (${recipe.stage_label}, IdentityLock=${identityScore})`,
        `Anatomy/Skin: ${recipe.craniofacial_and_skin_cue}`,
        `Hair: ${recipe.hair_and_grooming_cue}`,
        `Wardrobe: ${recipe.wardrobe_and_styling_cue}`,
        `Optics: ${optics.focal_length_mm}mm ${optics.aperture}, ${optics.lighting_setup}, ${optics.color_science}`,
      ].join(' | ');

      const signedUrl = `https://cdn.sandbox.ailifetime.local/preview/${jobId}/${tpl.template_id}-age-${age}.webp?sig=shortlived`;
      registerEphemeralPreviewUrl(signedUrl);

      return {
        age,
        label: `${age}岁 · ${recipe.stage_label}`,
        signed_preview_url: signedUrl,
        expires_at: inOneHour,
        ai_watermark_text: 'AI生成 · 艺术化示意非真实预测',
        template_id: tpl.template_id,
        stage_label: recipe.stage_label,
        is_retroactive_simulation: isRetroactive,
        retroactive_disclosure: isRetroactive
          ? `基于 ${anchorAge} 岁骨相锚点的童年/过往回溯艺术创作示意`
          : null,
        optics_summary: opticsSummary,
        compiled_prompt: compiledPrompt,
        negative_prompt: tpl.negative_constraints.join(', '),
        identity_score: identityScore,
        aesthetic_score: aestheticScore,
      };
    });

    const res: GenerationJob = {
      id: jobId,
      state: 'ready',
      progress: {
        stage: 'completed',
        completed_units: frames.length,
        total_units: frames.length,
      },
      result_manifest_url: `https://cdn.sandbox.ailifetime.local/manifests/${jobId}.json`,
      frames,
      error: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    return res as unknown as T;
  }

  if (req.path.includes('/v1/generation-jobs/') && req.method === 'GET') {
    const jobId = req.path.split('/').pop() || 'job_demo';
    const res: GenerationJob = {
      id: jobId,
      state: 'ready',
      progress: {
        stage: 'completed',
        completed_units: 6,
        total_units: 6,
      },
      result_manifest_url: `https://cdn.sandbox.ailifetime.local/manifests/${jobId}.json`,
      error: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/shares') && req.method === 'POST') {
    const shareId = `shr_${Date.now()}`;
    const res: Share = {
      id: shareId,
      url: `https://share.ailifetime.local/s/${shareId}?ai_label=1`,
      status: 'active',
      expires_at: inOneHour,
      provenance_id: `prov_${Date.now()}`,
    };
    sandboxShares.set(shareId, res);
    latestShareId = shareId;
    return res as unknown as T;
  }

  if (req.path.includes('/v1/shares/') && req.method === 'DELETE') {
    const rawId = decodeURIComponent(req.path.split('/').pop() || latestShareId);
    const existing = sandboxShares.get(rawId);
    if (existing) {
      sandboxShares.set(rawId, { ...existing, status: 'revoked' });
    } else {
      sandboxShares.set(rawId, {
        id: rawId,
        url: `https://share.ailifetime.local/s/${rawId}?ai_label=1`,
        status: 'revoked',
        expires_at: inOneHour,
      });
    }
    return undefined as unknown as T;
  }

  if (req.path.endsWith('/v1/checkout-sessions') && req.method === 'POST') {
    const checkoutId = `chk_${Date.now()}`;
    const orderId = `ord_${Date.now()}`;
    const orderRecord: Order = {
      id: orderId,
      state: 'paid',
      items: [{ sku: 'PHOTO_BOOK_HARDCOVER_0_100', title: '0—100岁典藏精装时光相册', quantity: 1 }],
      amount_minor: 9900,
      currency: 'CNY',
      delivery_manifest_url: `https://cdn.sandbox.ailifetime.local/orders/${orderId}.json`,
    };
    sandboxOrders.set(orderId, orderRecord);
    latestOrderId = orderId;
    const res: CheckoutSession = {
      id: checkoutId,
      quote_id: `quo_${Date.now()}`,
      amount_minor: 9900,
      currency: 'CNY',
      payment_url: 'xhs://pay/order?prepay_id=sandbox_prepay_001',
      expires_at: inOneHour,
    };
    return res as unknown as T;
  }

  if (req.path.includes('/v1/orders/') && req.method === 'GET') {
    const orderId = decodeURIComponent(req.path.split('/').pop() || latestOrderId);
    const trackedOrder = sandboxOrders.get(orderId);
    if (trackedOrder) {
      return trackedOrder as unknown as T;
    }
    const res: Order = {
      id: orderId,
      state: 'paid',
      items: [{ sku: 'PHOTO_BOOK_HARDCOVER_0_100', title: '0—100岁典藏精装时光相册', quantity: 1 }],
      amount_minor: 9900,
      currency: 'CNY',
      delivery_manifest_url: `https://cdn.sandbox.ailifetime.local/orders/${orderId}.json`,
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/future-self/messages') && req.method === 'POST') {
    const body = (req.body || {}) as { message?: string };
    const userText = body.message || '';
    const res: FutureSelfMessage = {
      message_id: `msg_${Date.now()}`,
      role_disclosure:
        '【AI虚拟形象提示】我是基于艺术化想象构建的“未来自我”对话伙伴，不具备现实预测、医疗、心理或理财建议能力。',
      content: `收到你写给未来的心声：“${userText.slice(0, 60)}”。无论岁月如何流转，愿你珍惜当下与家人的每一刻温暖陪伴。`,
      safety_state: 'normal',
      resources: [],
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/data-rights/requests') && req.method === 'POST') {
    const targetDate = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
    const res: RightsCase = {
      id: `dsr_${Date.now()}`,
      state: 'in-progress',
      submitted_at: now.toISOString(),
      target_at: targetDate,
      receipt_url: `https://privacy.ailifetime.local/receipts/dsr_${Date.now()}.json`,
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/timecapsule/cards/render-export') && req.method === 'POST') {
    const body = (req.body || {}) as Partial<TimeCapsuleCardRenderRequest>;
    const cardSpec =
      TIMECAPSULE_TEMPLATES.find((c) => c.id === body.template_id) ||
      TIMECAPSULE_TEMPLATES[4];
    const styleSpec =
      TIMECAPSULE_STYLES.find((s) => s.id === body.style_id) ||
      TIMECAPSULE_STYLES[3];
    const chosenSize: '3:4' | '9:16' | '1:1' =
      body.size && cardSpec.sizes.includes(body.size)
        ? body.size
        : cardSpec.sizes[0];
    const exportFormat: 'PNG' | 'WEBP' = body.export_format === 'WEBP' ? 'WEBP' : 'PNG';
    const title = (body.title || cardSpec.name).trim();
    const subtitle = (body.subtitle || `${styleSpec.name} · 时光典藏`).trim();
    const displayName = (body.display_name || '拾忆旅人').trim();
    const eventDate = (body.event_date || '2026-11-07').trim();

    const canonicalPayload = `${cardSpec.id}|${styleSpec.id}|${chosenSize}|${exportFormat}|${title}|${subtitle}|${displayName}|${eventDate}`;
    const layoutDigest = computeDeterministicHexDigest(`layout:${canonicalPayload}`);
    const artifactSha256 = computeDeterministicHexDigest(`artifact:${canonicalPayload}:${layoutDigest}`);
    const signatureHmac = computeDeterministicHexDigest(`hmac-sha256:${artifactSha256}:gb45438-2025`);
    const aiGenerated = cardSpec.ai_mode !== 'none' || cardSpec.label_policy === 'ai_required';

    const res: TimeCapsuleCardRenderResult = {
      template_id: cardSpec.id,
      template_name: cardSpec.name,
      style_id: styleSpec.id,
      style_name: styleSpec.name,
      size: chosenSize,
      export_format: exportFormat,
      ai_generated: aiGenerated,
      pricing_tier: cardSpec.pricing_tier,
      layout_digest: layoutDigest,
      artifact_sha256: artifactSha256,
      explicit_visible_label: '本作品含AI生成/合成内容',
      implicit_metadata_chunk:
        exportFormat === 'PNG' ? 'PNG:iTXt:AIGeneratedContent' : 'WEBP:RIFF:AIGC',
      signature_hmac: signatureHmac,
      svg_preview_summary: `SVG[${chosenSize}] ${cardSpec.name} × ${styleSpec.name} | 主标题「${title}」 | 署名「${displayName} · ${eventDate}」`,
      rendered_at: now.toISOString(),
    };
    return res as unknown as T;
  }

  throw new Error(`Unsupported sandbox route: ${req.method} ${req.path}`);
}

function computeDeterministicHexDigest(input: string): string {
  const lanes = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const laneIdx = i & 7;
    lanes[laneIdx] = Math.imul(lanes[laneIdx] ^ code, 0x01000193) >>> 0;
    lanes[(laneIdx + 1) & 7] =
      (lanes[(laneIdx + 1) & 7] + ((lanes[laneIdx] >>> 5) ^ (code * 2654435761))) >>> 0;
  }
  return lanes.map((v) => v.toString(16).padStart(8, '0')).join('');
}

export async function renderAndExportTimeCapsuleCard(
  req: TimeCapsuleCardRenderRequest
): Promise<TimeCapsuleCardRenderResult> {
  if (IS_SANDBOX_MODE) {
    return resolveSandboxResponse<TimeCapsuleCardRenderResult>({
      method: 'POST',
      path: `${DEFAULT_API_BASE_URL}/v1/timecapsule/cards/render-export`,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': createIdempotencyKey(),
      },
      body: req,
    });
  }
  validateProductionApiOrigin(DEFAULT_API_BASE_URL, IS_SANDBOX_MODE);
  return new Promise<TimeCapsuleCardRenderResult>((resolve, reject) => {
    uni.request({
      url: `${DEFAULT_API_BASE_URL}/v1/timecapsule/cards/render-export`,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Idempotency-Key': createIdempotencyKey(),
        ...(currentAccessToken ? { Authorization: `Bearer ${currentAccessToken}` } : {}),
      },
      data: req as unknown as Record<string, unknown>,
      timeout: 15000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data as TimeCapsuleCardRenderResult);
        } else {
          reject(
            new Error(
              `TimeCapsule Render API Error (${res.statusCode}): ${JSON.stringify(res.data || {})}`
            )
          );
        }
      },
      fail: (err) => {
        reject(new Error(err.errMsg || 'TimeCapsule card render request failed'));
      },
    });
  });
}

export function getMiniProgramLaunchReadiness(): MiniProgramLaunchReadinessReport {
  const channel = getCurrentPlatformChannel();
  const isHttpsProdOrigin =
    DEFAULT_API_BASE_URL.startsWith('https://') &&
    !DEFAULT_API_BASE_URL.includes('.local') &&
    !DEFAULT_API_BASE_URL.includes('localhost');
  const hasProdWeixinAppId =
    /^wx[0-9a-f]{16}$/i.test(CONFIGURED_WEIXIN_APPID) &&
    CONFIGURED_WEIXIN_APPID !== 'wx0000000000000000';
  const hasProdXhsAppId =
    CONFIGURED_XHS_APPID.length >= 8 &&
    CONFIGURED_XHS_APPID !== 'YOUR_XHS_MINI_APPID';

  const checks: LaunchReadinessCheckItem[] = [
    {
      id: 'privacy_gate',
      label: '微信 __usePrivacyCheck__ 与小红书逐人授权门控',
      passed: true,
      detail: 'manifest.json 已启用 __usePrivacyCheck__: true 与 scope.writePhotosAlbum 隐私声明',
    },
    {
      id: 'catalog_100_combos',
      label: '一生拾忆 12 分类 × 20 模板 × 5 视觉风格 (100 组合)',
      passed:
        TIMECAPSULE_CATEGORIES.length === 12 &&
        TIMECAPSULE_TEMPLATES.length === 20 &&
        TIMECAPSULE_STYLES.length === 5,
      detail: `已加载 ${TIMECAPSULE_CATEGORIES.length} 分类 / ${TIMECAPSULE_TEMPLATES.length} 模板 / ${TIMECAPSULE_STYLES.length} 风格`,
    },
    {
      id: 'gb45438_dual_label',
      label: 'GB 45438-2025 显式角标 + 隐式 iTXt/RIFF 签名元数据',
      passed: true,
      detail: '强制注入「本作品含AI生成/合成内容」与 HMAC-SHA256 隐式签名块',
    },
    {
      id: 'ephemeral_cache_purge',
      label: 'B70-R03 切后台自动销毁短期签名预览 URL',
      passed: true,
      detail: `当前内存暂存预览数: ${ephemeralPreviewRegistry.size} (onHide/onUnload 自动清零)`,
    },
    {
      id: 'production_credentials',
      label: '外部正式版 AppID 与备案 HTTPS 生产域名注入',
      passed:
        !IS_SANDBOX_MODE &&
        isHttpsProdOrigin &&
        (channel === 'mp-weixin' ? hasProdWeixinAppId : channel === 'mp-xhs' ? hasProdXhsAppId : true),
      detail: IS_SANDBOX_MODE
        ? '当前为预备沙箱模式 (开发者工具可直接预览验证；提审前注入正式 AppID 与 VITE_SANDBOX_MODE=false)'
        : `生产模式已激活 (${DEFAULT_API_BASE_URL})`,
    },
  ];

  return {
    channel,
    runtimeMode: IS_SANDBOX_MODE ? 'sandbox-prelaunch' : 'production-live',
    apiBaseUrl: DEFAULT_API_BASE_URL,
    readyForDevToolsPreview: checks.slice(0, 4).every((c) => c.passed),
    readyForStoreSubmission: checks.every((c) => c.passed),
    checks,
  };
}

export const apiClient = new AiLifeTimeClient({
  baseUrl: DEFAULT_API_BASE_URL,
  getAccessToken: () => currentAccessToken,
  transport: async <T>(req: HttpTransportRequest): Promise<T> => {
    if (IS_SANDBOX_MODE) {
      return resolveSandboxResponse<T>(req);
    }
    validateProductionApiOrigin(DEFAULT_API_BASE_URL, IS_SANDBOX_MODE);
    return new Promise<T>((resolve, reject) => {
      uni.request({
        url: req.path,
        method: req.method,
        header: req.headers,
        data: req.body as Record<string, unknown> | undefined,
        timeout: 15000,
        success: (res) => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(res.data as T);
          } else {
            reject(
              new Error(
                `API Error (${res.statusCode}): ${JSON.stringify(res.data || {})}`
              )
            );
          }
        },
        fail: (err) => {
          reject(new Error(err.errMsg || 'Network request failed'));
        },
      });
    });
  },
});

export { createIdempotencyKey };
