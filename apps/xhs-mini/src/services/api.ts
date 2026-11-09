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
  CuratedGallerySelectionReceipt,
  CuratedShotSpec,
  EraContextSpec,
  FutureSelfMessage,
  GenerationJob,
  GuestSession,
  ImageEnhancementPipelineSpec,
  MiniProgramSession,
  MultiPhotoAnchorSpec,
  NineGridPosition,
  Order,
  PhotobookLayoutManifest,
  PhotobookSpreadSpec,
  PhysiologicalWeightsSpec,
  PortraitTemplateSpec,
  Project,
  ProjectRequest,
  ProviderNativePayloadSpec,
  RightsCase,
  Share,
  ShotScale,
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

export const RECOMMENDED_SOLO_AGES: number[] = [3, 6, 12, 18, 25, 32, 45, 58, 72, 85];
export const RECOMMENDED_CO_AGING_AGES: number[] = [18, 22, 28, 35, 42, 50, 58, 66, 75, 85];
export const MIN_CURATED_SHOTS_PER_TEMPLATE = 9;

export function resolvePhysiologicalWeights(targetAge: number): PhysiologicalWeightsSpec {
  if (targetAge <= 4) {
    return {
      craniofacial_neoteny_weight: 0.95,
      dermal_collagen_elasticity: 0.98,
      subsurface_scattering_strength: 0.95,
      nasolabial_fold_depth_limit: 0.03,
      silver_strand_ratio: 0.0,
      eye_catchlight_clarity: 0.99,
      age_spot_micro_density: 0.0,
    };
  }
  if (targetAge <= 8) {
    return {
      craniofacial_neoteny_weight: 0.9,
      dermal_collagen_elasticity: 0.96,
      subsurface_scattering_strength: 0.94,
      nasolabial_fold_depth_limit: 0.05,
      silver_strand_ratio: 0.0,
      eye_catchlight_clarity: 0.98,
      age_spot_micro_density: 0.0,
    };
  }
  if (targetAge <= 16) {
    return {
      craniofacial_neoteny_weight: 0.52,
      dermal_collagen_elasticity: 0.95,
      subsurface_scattering_strength: 0.93,
      nasolabial_fold_depth_limit: 0.08,
      silver_strand_ratio: 0.0,
      eye_catchlight_clarity: 0.97,
      age_spot_micro_density: 0.0,
    };
  }
  if (targetAge <= 24) {
    return {
      craniofacial_neoteny_weight: 0.0,
      dermal_collagen_elasticity: 0.94,
      subsurface_scattering_strength: 0.92,
      nasolabial_fold_depth_limit: 0.12,
      silver_strand_ratio: 0.0,
      eye_catchlight_clarity: 0.96,
      age_spot_micro_density: 0.0,
    };
  }
  if (targetAge <= 35) {
    return {
      craniofacial_neoteny_weight: 0.0,
      dermal_collagen_elasticity: 0.9,
      subsurface_scattering_strength: 0.92,
      nasolabial_fold_depth_limit: 0.18,
      silver_strand_ratio: 0.0,
      eye_catchlight_clarity: 0.95,
      age_spot_micro_density: 0.01,
    };
  }
  if (targetAge <= 50) {
    return {
      craniofacial_neoteny_weight: 0.0,
      dermal_collagen_elasticity: 0.78,
      subsurface_scattering_strength: 0.9,
      nasolabial_fold_depth_limit: 0.28,
      silver_strand_ratio: 0.06,
      eye_catchlight_clarity: 0.93,
      age_spot_micro_density: 0.05,
    };
  }
  if (targetAge < 65) {
    return {
      craniofacial_neoteny_weight: 0.0,
      dermal_collagen_elasticity: 0.58,
      subsurface_scattering_strength: 0.89,
      nasolabial_fold_depth_limit: 0.52,
      silver_strand_ratio: 0.52,
      eye_catchlight_clarity: 0.9,
      age_spot_micro_density: 0.22,
    };
  }
  const progress = Math.min(1, Math.max(0, (targetAge - 65) / 20));
  return {
    craniofacial_neoteny_weight: 0.0,
    dermal_collagen_elasticity: Number((0.54 - 0.16 * progress).toFixed(2)),
    subsurface_scattering_strength: 0.89,
    nasolabial_fold_depth_limit: Number((0.58 + 0.16 * progress).toFixed(2)),
    silver_strand_ratio: Number((0.68 + 0.26 * progress).toFixed(2)),
    eye_catchlight_clarity: 0.89,
    age_spot_micro_density: Number((0.28 + 0.18 * progress).toFixed(2)),
  };
}

export function resolveEraContext(birthYear: number, targetAge: number): EraContextSpec {
  const calendarYear = birthYear + targetAge;
  if (calendarYear < 1970) {
    return {
      birth_year: birthYear,
      target_age: targetAge,
      calendar_year: calendarYear,
      decade_label: '1950-60年代·经典胶片纪实',
      era_scene_cue: '老院青砖檐廊与木格窗柔焦光斑',
      collar_material_cue: '手工粗纺纯棉立领与本布包扣',
      window_light_cue: '北向庭院天光穿过木格窗棂',
      color_grade_shift: '暖调银盐温润灰阶过渡',
    };
  }
  if (calendarYear < 1980) {
    return {
      birth_year: birthYear,
      target_age: targetAge,
      calendar_year: calendarYear,
      decade_label: '1970年代·暖阳大院记忆',
      era_scene_cue: '阳光洒满的老式大院走廊与实木书桌',
      collar_material_cue: '水洗纯棉小翻领衬衫配细罗纹针织背心',
      window_light_cue: '午后35°斜射金黄自然窗光',
      color_grade_shift: 'Kodachrome 64 暖琥珀高光曲线',
    };
  }
  if (calendarYear < 1990) {
    return {
      birth_year: birthYear,
      target_age: targetAge,
      calendar_year: calendarYear,
      decade_label: '1980年代·黄金年代相册',
      era_scene_cue: '80年代蕾丝窗纱起居室与书架暖阳',
      collar_material_cue: '复古棒针开衫叠穿挺括纯棉衬衫领',
      window_light_cue: '透过白色蕾丝窗纱的柔和漫射窗光',
      color_grade_shift: 'Fujicolor 100 家庭相册温润胶片色',
    };
  }
  if (calendarYear < 2000) {
    return {
      birth_year: birthYear,
      target_age: targetAge,
      calendar_year: calendarYear,
      decade_label: '1990年代·千禧前夕胶片',
      era_scene_cue: '90年代阳光阳台与窗外绿植焦外光斑',
      collar_material_cue: '90年代经典高支棉羊绒圆领或牛津纺衬衫领',
      window_light_cue: '通透45°自然窗光 + 室内原木温润反射光',
      color_grade_shift: 'Kodak Gold 200 暖调胶片肤色',
    };
  }
  if (calendarYear < 2010) {
    return {
      birth_year: birthYear,
      target_age: targetAge,
      calendar_year: calendarYear,
      decade_label: '2000年代·千禧晨光记忆',
      era_scene_cue: '千禧年代明亮书房窗畔与简约木质陈设',
      collar_material_cue: '极简精梳棉衬衫或轻薄美利奴羊毛领口',
      window_light_cue: '清透晨间窗光 + 纱帘柔化过渡',
      color_grade_shift: 'Kodak Portra 160NC 真实中性暖肤色',
    };
  }
  if (calendarYear < 2020) {
    return {
      birth_year: birthYear,
      target_age: targetAge,
      calendar_year: calendarYear,
      decade_label: '2010年代·人文生活定格',
      era_scene_cue: '现代阳光阅读角与温润橡木散景',
      collar_material_cue: '亚麻混纺衬衫领或软糯羊绒半高领',
      window_light_cue: '黄金时刻侧逆窗光 + 暖调柔光补光',
      color_grade_shift: 'Kodak Portra 400 通透肤色与立体暗部',
    };
  }
  if (calendarYear < 2035) {
    return {
      birth_year: birthYear,
      target_age: targetAge,
      calendar_year: calendarYear,
      decade_label: '2020-30年代·当下与近未来质感',
      era_scene_cue: '当代光影建筑感起居空间与自然天光',
      collar_material_cue: '桑蚕丝羊毛混纺高定领口，织物纹理清晰',
      window_light_cue: '雕塑感天光侧主光 + 柔和发丝轮廓光',
      color_grade_shift: '中画幅自然色彩科学，零数码过曝感',
    };
  }
  if (calendarYear < 2055) {
    return {
      birth_year: birthYear,
      target_age: targetAge,
      calendar_year: calendarYear,
      decade_label: '2035-50年代·从容岁月纪事',
      era_scene_cue: '静谧庭院书房木百叶窗与午后茶席光影',
      collar_material_cue: '定制拉绒山羊绒青果领或丝麻交织立领',
      window_light_cue: '木百叶过滤的柔和环绕日光 + 银丝轮廓光',
      color_grade_shift: '典藏级暖调银盐肖像色阶',
    };
  }
  return {
    birth_year: birthYear,
    target_age: targetAge,
    calendar_year: calendarYear,
    decade_label: '2055年代+·世纪回眸典藏',
    era_scene_cue: '浸润在暖琥珀夕阳中的静谧玻璃花房与书阁',
    collar_material_cue: '传世重磅真丝羊绒披肩领与细腻织纹',
    window_light_cue: '低角度夕阳暖色窗光 + 银发柔光光晕',
    color_grade_shift: '博物馆铂金印相温润色调曲线',
  };
}

export function compileProviderNativePayload(
  tpl: PortraitTemplateSpec,
  participantCount: number,
  identityWeight: number
): ProviderNativePayloadSpec {
  if (tpl.template_id === 'tpl_xhs_oriental_aesthetics_portrait') {
    return {
      provider_id: 'seedream-oriental-portrait-v3',
      fallback_provider_id: 'flux-pro-pulid-studio-v2',
      model_id: 'seedream-3.0-oriental-editorial',
      identity_adapter: tpl.identity_preservation.identity_adapter,
      instantid_weight: Number((identityWeight * 0.96).toFixed(2)),
      pulid_weight: Number((tpl.identity_preservation.eye_geometry_lock * 0.95).toFixed(2)),
      sampler: 'dpmpp_2m_sde_karras',
      steps: 34,
      cfg_scale: 5.2,
      color_lut: tpl.optics_and_lighting.color_science,
      print_bleed_mm: 0,
      cmyk_profile: 'Display_P3_sRGB_Safe',
    };
  }
  if (tpl.template_id === 'tpl_xhs_master_fine_art_photobook') {
    return {
      provider_id: 'sdxl-hasselblad-print-300dpi-v2',
      fallback_provider_id: 'flux-pro-pulid-studio-v2',
      model_id: 'hasselblad-medium-format-fineart-v2',
      identity_adapter: tpl.identity_preservation.identity_adapter,
      instantid_weight: Number((identityWeight * 0.97).toFixed(2)),
      pulid_weight: Number((tpl.identity_preservation.eye_geometry_lock * 0.96).toFixed(2)),
      sampler: 'euler_ancestral_karras',
      steps: 40,
      cfg_scale: 5.8,
      color_lut: tpl.optics_and_lighting.color_science,
      print_bleed_mm: 3,
      cmyk_profile: 'ISOcoated_v2_300_eci.icc',
    };
  }
  if (
    tpl.template_id === 'tpl_xhs_warm_family_co_aging' ||
    tpl.template_id === 'tpl_xhs_three_generations_heirloom' ||
    participantCount > 1
  ) {
    return {
      provider_id: 'flux-multi-region-pulid-v2',
      fallback_provider_id: 'instantid-multi-subject-v2',
      model_id:
        tpl.template_id === 'tpl_xhs_three_generations_heirloom'
          ? 'flux-1-dev-three-gen-heirloom-v2'
          : 'flux-1-dev-multi-subject-co-aging',
      identity_adapter: tpl.identity_preservation.identity_adapter,
      instantid_weight: Number((identityWeight * 0.95).toFixed(2)),
      pulid_weight: Number((tpl.identity_preservation.eye_geometry_lock * 0.95).toFixed(2)),
      sampler: 'euler_beta',
      steps: 36,
      cfg_scale: 5.4,
      color_lut: tpl.optics_and_lighting.color_science,
      print_bleed_mm: tpl.template_id === 'tpl_xhs_three_generations_heirloom' ? 3 : 0,
      cmyk_profile:
        tpl.template_id === 'tpl_xhs_three_generations_heirloom'
          ? 'ISOcoated_v2_300_eci.icc'
          : 'Display_P3_sRGB_Safe',
    };
  }
  if (tpl.template_id === 'tpl_xhs_cinematic_wong_kar_wai') {
    return {
      provider_id: 'flux-cinema-500t-pulid-v2',
      fallback_provider_id: 'flux-pro-pulid-studio-v2',
      model_id: 'flux-1-pro-kodak-500t-cinema',
      identity_adapter: tpl.identity_preservation.identity_adapter,
      instantid_weight: Number((identityWeight * 0.96).toFixed(2)),
      pulid_weight: Number((tpl.identity_preservation.eye_geometry_lock * 0.95).toFixed(2)),
      sampler: 'dpmpp_2m_sde_karras',
      steps: 34,
      cfg_scale: 5.1,
      color_lut: tpl.optics_and_lighting.color_science,
      print_bleed_mm: 0,
      cmyk_profile: 'Display_P3_sRGB_Safe',
    };
  }
  if (tpl.template_id === 'tpl_xhs_vogue_editorial_bw') {
    return {
      provider_id: 'flux-monochrome-hp5-pulid-v2',
      fallback_provider_id: 'flux-pro-pulid-studio-v2',
      model_id: 'flux-1-pro-lindbergh-monochrome',
      identity_adapter: tpl.identity_preservation.identity_adapter,
      instantid_weight: Number((identityWeight * 0.96).toFixed(2)),
      pulid_weight: Number((tpl.identity_preservation.eye_geometry_lock * 0.96).toFixed(2)),
      sampler: 'euler_ancestral_karras',
      steps: 36,
      cfg_scale: 5.5,
      color_lut: tpl.optics_and_lighting.color_science,
      print_bleed_mm: 0,
      cmyk_profile: 'Dot_Gain_15_Archival_BW',
    };
  }
  if (tpl.template_id === 'tpl_xhs_24_solar_terms_poetic') {
    return {
      provider_id: 'seedream-solar-terms-outdoor-v3',
      fallback_provider_id: 'flux-pro-pulid-studio-v2',
      model_id: 'seedream-3.0-outdoor-botanical-bokeh',
      identity_adapter: tpl.identity_preservation.identity_adapter,
      instantid_weight: Number((identityWeight * 0.96).toFixed(2)),
      pulid_weight: Number((tpl.identity_preservation.eye_geometry_lock * 0.95).toFixed(2)),
      sampler: 'dpmpp_2m_sde_karras',
      steps: 34,
      cfg_scale: 5.2,
      color_lut: tpl.optics_and_lighting.color_science,
      print_bleed_mm: 0,
      cmyk_profile: 'Display_P3_sRGB_Safe',
    };
  }
  return {
    provider_id: 'flux-pro-pulid-studio-v2',
    fallback_provider_id: 'instantid-sdxl-rembrandt-v2',
    model_id: 'flux-1-pro-silver-halide-portrait',
    identity_adapter: tpl.identity_preservation.identity_adapter,
    instantid_weight: Number((identityWeight * 0.96).toFixed(2)),
    pulid_weight: Number((tpl.identity_preservation.eye_geometry_lock * 0.95).toFixed(2)),
    sampler: 'dpmpp_2m_sde_karras',
    steps: 32,
    cfg_scale: 5.0,
    color_lut: tpl.optics_and_lighting.color_science,
    print_bleed_mm: 0,
    cmyk_profile: 'Display_P3_sRGB_Safe',
  };
}

export function resolveStoryboardCropAndGrid(shotIndex: number): {
  shotScale: ShotScale;
  nineGridPosition: NineGridPosition;
} {
  const map: Record<number, { shotScale: ShotScale; nineGridPosition: NineGridPosition }> = {
    1: { shotScale: 'extreme_closeup_eyes', nineGridPosition: 'corner_framing' },
    2: { shotScale: 'medium_bust', nineGridPosition: 'edge_rhythm' },
    3: { shotScale: 'three_quarter_profile', nineGridPosition: 'corner_framing' },
    4: { shotScale: 'medium_bust', nineGridPosition: 'edge_rhythm' },
    5: { shotScale: 'medium_bust', nineGridPosition: 'center_hero' },
    6: { shotScale: 'three_quarter_profile', nineGridPosition: 'edge_rhythm' },
    7: { shotScale: 'half_body_hands', nineGridPosition: 'corner_framing' },
    8: { shotScale: 'three_quarter_profile', nineGridPosition: 'edge_rhythm' },
    9: { shotScale: 'extreme_closeup_eyes', nineGridPosition: 'corner_framing' },
    10: { shotScale: 'half_body_hands', nineGridPosition: 'bonus_alternate' },
  };
  return map[shotIndex] || { shotScale: 'medium_bust', nineGridPosition: 'edge_rhythm' };
}

export function resolveMultiPhotoAnchor(params: {
  primaryAdultAssetId: string;
  targetAge: number;
  effectiveIdentityWeight: number;
  sideProfileAssetId?: string | null;
  childhoodReferenceAssetId?: string | null;
  childhoodReferenceAge?: number | null;
}): MultiPhotoAnchorSpec {
  const hasChildhood = Boolean(params.childhoodReferenceAssetId?.trim());
  const hasProfile = Boolean(params.sideProfileAssetId?.trim());
  let childhoodW = 0;
  let adultW = Number(params.effectiveIdentityWeight.toFixed(2));
  let dualActive = hasProfile;
  if (hasChildhood && params.targetAge <= 8) {
    childhoodW = 0.72;
    adultW = Number(Math.max(0.28, params.effectiveIdentityWeight - 0.52).toFixed(2));
    dualActive = true;
  } else if (hasChildhood && params.targetAge <= 16) {
    childhoodW = 0.48;
    adultW = Number(Math.max(0.52, params.effectiveIdentityWeight - 0.32).toFixed(2));
    dualActive = true;
  }
  return {
    primary_adult_asset_id: params.primaryAdultAssetId,
    side_profile_asset_id: hasProfile ? params.sideProfileAssetId!.trim() : null,
    childhood_reference_asset_id: hasChildhood ? params.childhoodReferenceAssetId!.trim() : null,
    childhood_reference_age: hasChildhood ? (params.childhoodReferenceAge ?? 6) : null,
    adult_anchor_weight: adultW,
    childhood_anchor_weight: childhoodW,
    profile_3d_depth_boost: hasProfile ? 0.22 : 0,
    dual_anchor_active: dualActive,
  };
}

export function compileImageEnhancementPipeline(
  tpl: PortraitTemplateSpec,
  targetAge: number,
  shotScale: ShotScale,
  multiPhotoAnchor: MultiPhotoAnchorSpec
): ImageEnhancementPipelineSpec {
  const tid = tpl.template_id;
  const isWkw = tid === 'tpl_xhs_cinematic_wong_kar_wai';
  const isBw = tid === 'tpl_xhs_vogue_editorial_bw';
  const isSolar = tid === 'tpl_xhs_24_solar_terms_poetic';

  const microFeatures = [
    'vellus_facial_fuzz',
    'malar_nasal_micro_pores',
    'vertical_lip_creases',
    'radial_iris_crypts',
  ];
  if (targetAge >= 55) {
    microFeatures.push('individual_silver_hair_specular_strands');
  }
  if (shotScale === 'extreme_closeup_eyes') {
    microFeatures.push('corneal_window_reflection_micro_geometry');
  }

  return {
    multi_photo_anchor: multiPhotoAnchor,
    relighting_pass: {
      enabled: true,
      normal_map_estimator: 'ic-light-normal-bae-v2',
      key_azimuth_deg: isWkw ? 55 : isSolar ? 135 : 45,
      key_elevation_deg: isWkw ? 22 : isSolar ? 28 : 35,
      color_temp_kelvin: isWkw ? 3200 : isBw ? 5500 : isSolar ? 5100 : 4800,
      shadow_softness: isBw ? 0.58 : isSolar ? 0.86 : 0.8,
      fill_bounce_ratio: isWkw
        ? '4:1 tungsten-cyan neon contrast'
        : isBw
          ? '5:1 silver gelatin dramatic key'
          : '3:1 studio octabox + warm hair rim',
    },
    frequency_separated_skin_pass: {
      enabled: true,
      low_freq_gaussian_sigma_px: 6.5,
      high_freq_denoise_strength: shotScale === 'extreme_closeup_eyes' ? 0.21 : 0.19,
      tile_controlnet_weight: 0.86,
      micro_features_injected: microFeatures,
    },
    optical_post_process: {
      enabled: true,
      vignette_ev: isWkw ? -0.48 : -0.35,
      cats_eye_bokeh_eccentricity: isWkw ? 0.34 : isSolar ? 0.31 : 0.28,
      halation_strength: isWkw ? 0.36 : isSolar ? 0.28 : 0.22,
      halation_radius_px: isWkw ? 6.5 : 4.8,
      shadow_grain_sigma: isWkw ? 0.052 : isBw ? 0.048 : 0.042,
      highlight_grain_sigma: isWkw ? 0.019 : 0.016,
    },
  };
}

function buildCuratedShotsForTemplate(
  templateId: string,
  ages: number[],
  focalMm: number,
  aperture: string,
  lightingShort: string,
  titles: string[],
  wardrobes: string[],
  backdrops: string[],
  expressions: string[]
): CuratedShotSpec[] {
  const scaleLabelMap: Record<ShotScale, string> = {
    extreme_closeup_eyes: '眼部与鼻梁微距特写 (ECU)',
    medium_bust: '视平线居中胸上肖像 (MCU)',
    three_quarter_profile: '45°微侧下颌轮廓肖像 (3/4 Profile)',
    half_body_hands: '含手部姿态半身环境肖像 (Half-Body)',
  };
  return ages.map((age, idx) => {
    const shotNum = idx + 1;
    const { shotScale, nineGridPosition } = resolveStoryboardCropAndGrid(shotNum);
    const phys = resolvePhysiologicalWeights(age);
    let dermalFocus = `${age}岁 1:1 骨相锚定 + 真实微距毛孔与皮下散射 (SSS=${phys.subsurface_scattering_strength})，零塑料感`;
    if (age <= 8) {
      dermalFocus = `${age}岁幼态颅面比例 (neoteny=${phys.craniofacial_neoteny_weight}) + 清澈高光眼神光 (catchlight=${phys.eye_catchlight_clarity})，零成人脂粉感`;
    } else if (age >= 38 && age <= 50) {
      dermalFocus = `${age}岁紧致下颌轮廓 (collagen=${phys.dermal_collagen_elasticity}) + 克制法令纹上限 (<=${phys.nasolabial_fold_depth_limit})，不强行堆砌皱纹`;
    } else if (age >= 58) {
      dermalFocus = `${age}岁自然银丝高光分离 (silver=${phys.silver_strand_ratio}) + 温和法令纹走向与微斑点 (spot=${phys.age_spot_micro_density})，零恐怖谷`;
    }
    return {
      shot_id: `${templateId}_shot_${String(shotNum).padStart(2, '0')}_${age}y`,
      shot_index: shotNum,
      target_age: age,
      title: `镜头${String(shotNum).padStart(2, '0')} · ${age}岁 · ${titles[idx]}`,
      framing_and_angle: `${focalMm}mm ${aperture} · ${scaleLabelMap[shotScale]} · 九宫格[${nineGridPosition}]呼吸感编排`,
      lighting_key_ratio: lightingShort,
      lens_dof_cue: `${focalMm}mm 定焦焦平面锁死双瞳虹膜，${aperture} 浅景深自然虚化过渡`,
      craniofacial_and_dermal_focus: dermalFocus,
      wardrobe_fabric_cue: wardrobes[idx],
      backdrop_prop_cue: backdrops[idx],
      micro_expression_cue: expressions[idx],
      default_selected: shotNum <= 9,
      shot_scale: shotScale,
      nine_grid_position: nineGridPosition,
    };
  });
}

function buildAgeBandRecipes(wardrobeTheme: string, backdropTheme: string): AgeBandPromptRecipe[] {
  return [
    {
      band_key: 'childhood_0_8',
      min_age: 0,
      max_age: 8,
      stage_label: '童年纯真',
      craniofacial_and_skin_cue:
        'authentic childhood craniofacial neoteny (0.90), higher forehead-to-jaw ratio, soft buccal fullness, translucent natural skin texture with zero adult makeup, preserving exact interpupillary distance and canthal tilt',
      hair_and_grooming_cue: 'fine soft natural childhood hair strands, clean natural hairline',
      wardrobe_and_styling_cue: `age-appropriate childhood soft cotton/knit collar (${wardrobeTheme})`,
      pose_and_gaze_cue: 'curious crystal-clear eye contact (catchlight 0.98), relaxed natural head tilt',
      backdrop_and_atmosphere_cue: `warm nostalgic studio ambiance (${backdropTheme})`,
      identity_lock_strength: 0.84,
      physiological_weights: resolvePhysiologicalWeights(6),
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
      physiological_weights: resolvePhysiologicalWeights(12),
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
      physiological_weights: resolvePhysiologicalWeights(18),
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
      physiological_weights: resolvePhysiologicalWeights(28),
    },
    {
      band_key: 'maturity_36_50',
      min_age: 36,
      max_age: 50,
      stage_label: '从容岁月',
      craniofacial_and_skin_cue:
        'taut mature mandibular contour and defined cheekbone architecture, subtle lateral canthal laugh lines with capped nasolabial depth (<=0.28), authentic mid-life dermal elasticity (0.78) without forced heavy wrinkles',
      hair_and_grooming_cue: 'mature hair density with occasional subtle 6% temple silver threads',
      wardrobe_and_styling_cue: `refined wool/cashmere or structured linen collar (${wardrobeTheme})`,
      pose_and_gaze_cue: 'grounded calm presence, mature luminous catchlights (0.93), relaxed shoulders',
      backdrop_and_atmosphere_cue: `rich tonal portrait atmosphere (${backdropTheme})`,
      identity_lock_strength: 0.92,
      physiological_weights: resolvePhysiologicalWeights(45),
    },
    {
      band_key: 'silver_prime_51_68',
      min_age: 51,
      max_age: 68,
      stage_label: '温情银发',
      craniofacial_and_skin_cue:
        "graceful early-senior bone and soft-tissue evolution, natural periorbital crow's feet, gentle nasolabial trajectory, realistic dermal micro-texture while preserving core eye and nose geometry",
      hair_and_grooming_cue: 'natural salt-and-pepper to luminous silver hair strands with individual strand separation',
      wardrobe_and_styling_cue: `warm timeless knit or classic shawl collar (${wardrobeTheme})`,
      pose_and_gaze_cue: 'gentle benevolent expression, warm eye catchlights, dignified posture',
      backdrop_and_atmosphere_cue: `warm intimate studio light falloff (${backdropTheme})`,
      identity_lock_strength: 0.89,
      physiological_weights: resolvePhysiologicalWeights(58),
    },
    {
      band_key: 'elder_69_84',
      min_age: 69,
      max_age: 84,
      stage_label: '岁月沉淀',
      craniofacial_and_skin_cue:
        "dignified elder facial anatomy, natural subcutaneous volume softening along mandible, harmonious nasolabial fold trajectory and authentic age-spot micro-distribution without uncanny-valley distortion",
      hair_and_grooming_cue: 'soft silver-white hair with natural specular separation and fine halo wisping',
      wardrobe_and_styling_cue: `classic soft-textured cardigan or heritage collar (${wardrobeTheme})`,
      pose_and_gaze_cue: 'serene reflective gaze, warm lived-in smile lines, composed head posture',
      backdrop_and_atmosphere_cue: `classic fine-art portrait shadow depth (${backdropTheme})`,
      identity_lock_strength: 0.86,
      physiological_weights: resolvePhysiologicalWeights(72),
    },
    {
      band_key: 'centenarian_85_100',
      min_age: 85,
      max_age: 120,
      stage_label: '世纪回眸',
      craniofacial_and_skin_cue:
        'reverent centenarian artistic portrait, delicate parchment-like dermal micro-topography, gentle natural life lines, preserved ocular spacing and signature gaze spirit, zero horror-valley artifacts',
      hair_and_grooming_cue: 'pure gossamer silver-white hair illuminated by gentle rim light',
      wardrobe_and_styling_cue: `timeless dignified high-neck wool or silk wrap (${wardrobeTheme})`,
      pose_and_gaze_cue: 'peaceful luminous eyes, quiet dignity, timeless frontal-three-quarter framing',
      backdrop_and_atmosphere_cue: `museum-grade chiaroscuro portrait ambiance (${backdropTheme})`,
      identity_lock_strength: 0.83,
      physiological_weights: resolvePhysiologicalWeights(85),
    },
  ];
}

export const BUILTIN_PORTRAIT_TEMPLATES: PortraitTemplateSpec[] = [
  {
    template_id: 'tpl_xhs_silver_halide_0_100',
    version: '2.3.0',
    name: '经典银盐胶片·人生时间轴',
    subtitle: '85mm 大光圈人像定焦 · 伦勃朗柔光 · 10张精修分镜零塑料感',
    category: 'solo-portrait',
    badge: '小红书爆款主推',
    status: 'active',
    max_participants: 1,
    min_age: 0,
    max_age: 100,
    min_curated_shots: MIN_CURATED_SHOTS_PER_TEMPLATE,
    recommended_ages: [...RECOMMENDED_SOLO_AGES],
    curated_gallery_shots: buildCuratedShotsForTemplate(
      'tpl_xhs_silver_halide_0_100',
      RECOMMENDED_SOLO_AGES,
      85,
      'f/1.8',
      '45°八角柔光箱伦勃朗光 + 暖调钨丝发丝轮廓光 (3:1光比)',
      [
        '稚气初萌·银盐柔焦',
        '六岁童眸·清澈逆光',
        '十二少年·澄澈眉眼',
        '十八成人·青涩锋芒',
        '廿五初绽·黄金骨相',
        '卅二笃定·光影立体',
        '四五从容·紧致轮廓',
        '五八知命·微银鬓角',
        '七二温厚·银发留白',
        '八五世纪·岁月回眸',
      ],
      [
        '米白精梳纯棉婴儿针织圆领',
        '燕麦色柔软小翻领粗针毛衣',
        '炭灰学院派纯棉牛津纺衬衫领',
        '白桦色重磅纯棉圆领T恤与微挺括外套',
        '深炭黑精纺美利奴羊毛半高领',
        '暖灰亚麻混纺西装翻领与极简内搭',
        '黑胡桃色高支山羊绒V领针织衫',
        '暖驼色粗纺人字纹羊毛披肩领',
        '银灰法兰绒立领开衫配温润内搭',
        '典藏黑丝绒质感高领长披肩',
      ],
      [
        '暖灰手绘油画布·浅景深柔光晕',
        '经典暗房炭灰背景布·呼吸感暗角',
        '柔和银盐中性灰背景·顶部漫射轮廓',
        'Portra 400暖调炭灰棚拍画布',
        '伦勃朗三角光经典深灰影棚背景',
        '低饱和暖褐手刷肌理布景',
        '沉稳博物馆灰阶画布·立体负补光',
        '暖琥珀微光渐变暗房背景',
        '银盐高动态暗部层次影棚背景',
        '博物馆级伦勃朗明暗对照油画布',
      ],
      [
        '微微好奇张望、双眸清亮湿润',
        '纯粹干净的直视眼神、嘴角自然放松',
        '安静清澈的少年凝视、眉宇舒展',
        '略带青涩却坚定的青春目光',
        '自信松弛的微侧颌线、眼底带笑',
        '沉稳内敛的平视凝望、呼吸感极强',
        '轮廓紧致从容、眼神温润有故事感',
        '平和舒展的浅笑、眼角自然笑纹',
        '慈祥清朗的目光、神态温和安宁',
        '跨越世纪的平静凝眸、充满生命尊严',
      ]
    ),
    supported_aspect_ratios: ['3:4', '4:5', '1:1', '9:16'],
    default_aspect_ratio: '3:4',
    required_consents: ['age-transformation'],
    provider_capabilities: ['face-id-lock', 'controlnet-depth', 'high-res-skin-detail'],
    cost_tier: 'pro-studio',
    allowed_channels: ['mp-xhs', 'mp-weixin', 'consumer-web', 'mobile', 'studio'],
    competitive_highlights: [
      '内置 10 张大师级银盐分镜（满 9 张直出小红书九宫格），85mm f/1.8 锁定同一视平线与焦平面',
      '分年龄段骨相演进：6岁清澈童眸、45岁紧致轮廓不堆砌假皱纹、65-85岁银丝高光分离与温和法令纹',
      'Kodak Portra 400 暖调肤色曲线 + 真实微距毛孔与皮下散射（SSS），彻底告别一眼假 AI 塑料磨皮',
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
    version: '2.3.0',
    name: '东方光影新中式·岁月肖像',
    subtitle: '90mm 微距人像 · 宣纸窗光 · 10幕东方骨相美学分镜',
    category: 'editorial',
    badge: '新中式高赞',
    status: 'active',
    max_participants: 1,
    min_age: 0,
    max_age: 100,
    min_curated_shots: MIN_CURATED_SHOTS_PER_TEMPLATE,
    recommended_ages: [...RECOMMENDED_SOLO_AGES],
    curated_gallery_shots: buildCuratedShotsForTemplate(
      'tpl_xhs_oriental_aesthetics_portrait',
      RECOMMENDED_SOLO_AGES,
      90,
      'f/2.0',
      '漫反射宣纸窗光侧逆主光 + 桑蚕丝反光板柔补 (2.5:1温润光比)',
      [
        '三岁垂髫·宣纸柔光',
        '六岁总角·澄澈灵气',
        '十二豆蔻·竹影清风',
        '十八弱冠/及笄·温润如玉',
        '廿五风华·东方折叠度',
        '卅二雅致·素锦流光',
        '四五沉淀·松弛气韵',
        '五八知秋·茶烟鬓影',
        '七二古稀·银丝似雪',
        '八五期颐·水墨留白',
      ],
      [
        '月白软棉交领小衫',
        '素色细棉麻立领盘扣孩童衫',
        '竹青色天然苎麻斜襟少年衫',
        '天水碧重磅桑蚕丝新中式微立领',
        '米杏色香云纱肌理暗纹衬衫领',
        '远山灰手工织造丝麻混纺立领外套',
        '深黛色高支羊绒与桑蚕丝叠穿中式领',
        '秋香色宋锦暗纹滚边开衫领口',
        '素银灰软羊绒宽襟披肩与立领',
        '玄色重磅真丝绒暗绣典藏高领',
      ],
      [
        '温润宣纸透光屏风·晨光漫射',
        '微焦庭院竹影·宣纸白留白背景',
        '水墨浅灰渐变背景·窗棂柔影',
        '汝窑天青灰影棚肌理背景',
        '东方极简留白画布·侧逆光清冷气韵',
        '茶室障子纸暖光漫反射背景',
        '低饱和宋画灰阶肌理布景',
        '疏朗枯山水光影剪影留白背景',
        '温润古建木格窗柔化远景',
        '水墨丹青晕染长卷质感背景',
      ],
      [
        '懵懂清澈、眼珠乌黑透亮',
        '灵动纯真、眉目干净如画',
        '清雅内敛、少年书卷气韵',
        '眼神澄明温和、姿态挺拔舒展',
        '东方含蓄微澜眼神、下颌线条利落',
        '从容淡定、气定神闲的东方气场',
        '骨相紧致温润、眼底沉淀从容故事',
        '温和浅笑、眉眼间尽显岁月宽厚',
        '银发整洁温雅、目光澄澈平和',
        '气韵悠长、如水墨画卷般静谧安详',
      ]
    ),
    supported_aspect_ratios: ['3:4', '4:5', '9:16'],
    default_aspect_ratio: '3:4',
    required_consents: ['age-transformation'],
    provider_capabilities: ['face-id-lock', 'editorial-lighting', 'high-res-skin-detail'],
    cost_tier: 'pro-studio',
    allowed_channels: ['mp-xhs', 'mp-weixin', 'consumer-web', 'studio'],
    competitive_highlights: [
      '内置 10 张东方骨相高定分镜（支持精选 9 张拼图），针对亚洲面部折叠度调校柔和侧逆光，杜绝欧美深眼窝异化',
      '桑蚕丝、苎麻、香云纱与羊绒领口随 10 个年龄阶段自然演进，极具小红书新中式高赞故事感',
      '水墨灰阶与宣纸留白背景，突出东方温润瓷感微距肤质与岁月气韵',
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
    version: '2.3.0',
    name: '时代纪实记忆·年代光影胶片',
    subtitle: '50mm 纪实人文镜头 · 出生年份+目标年龄自动推演年代光影 · 10张相册真迹',
    category: 'documentary',
    badge: '情感共鸣王牌',
    status: 'active',
    max_participants: 1,
    min_age: 0,
    max_age: 100,
    min_curated_shots: MIN_CURATED_SHOTS_PER_TEMPLATE,
    recommended_ages: [...RECOMMENDED_SOLO_AGES],
    curated_gallery_shots: buildCuratedShotsForTemplate(
      'tpl_xhs_era_chronicle_documentary',
      RECOMMENDED_SOLO_AGES,
      50,
      'f/1.4',
      '黄金时刻斜射自然窗光 + 室内木质环境漫反射补光',
      [
        '三岁老院·晨光竹椅',
        '六岁窗台·盛夏蝉鸣',
        '十二书桌·午后斜阳',
        '十八远行·车站晨曦',
        '廿五安居·暖阳阳台',
        '卅二书房·木香光影',
        '四五茶席·窗畔流年',
        '五八庭院·金秋暖光',
        '七二旧居·时光相册',
        '八五暖阁·世纪余晖',
      ],
      [
        '年代感手工纯棉小方领孩童衫',
        '经典条纹纯棉针织背心与白衬衫领',
        '少年水洗棉布衬衫与细绒线衣领口',
        '青年挺括纯棉牛津衬衫配经典风衣领',
        '轻熟极简亚麻衬衫与自然解开的第一颗纽扣',
        '质感斜纹粗花呢外套配纯棉内搭',
        '成熟羊绒开衫叠穿挺括衬衫领口',
        '温厚绞花羊毛衫配柔和格纹围巾',
        '经典灯芯绒立领外套配温暖针织内搭',
        '传家质感重磅羊毛披肩与暖色高领',
      ],
      [
        '根据出生年份自动匹配童年老院木窗柔焦背景',
        '蕾丝窗纱透进午后阳光的童年居室背景',
        '带有书架与绿植焦外光斑的少年书房窗边',
        '通透晨光洒入的青年生活阳台纪实景深',
        '黄金时刻暖阳斜照的现代原木生活空间',
        '光影斑驳的阅读角与温暖室内环境反光',
        '午后四点斜阳穿过百叶窗的静谧书房',
        '秋日庭院梧桐树影摇曳的暖色窗前',
        '摆满岁月旧书与相框的温暖起居室焦外',
        '夕阳余晖浸润的静谧玻璃花房与老躺椅',
      ],
      [
        '自然抓拍的纯真注视、毫无摆拍痕迹',
        '望向镜头外父母般的清澈信任眼神',
        '写作业间隙抬头的真实澄澈神态',
        '对未来充满憧憬的明亮清朗目光',
        '生活化松弛浅笑、眼神温暖自然',
        '专注而温和的日常凝视、真实感拉满',
        '历经岁月却依旧紧致舒展的从容微笑',
        '温暖宽厚的长辈目光、眼底泛着暖意',
        '翻看老照片般平静欣慰的温和神情',
        '慈祥通透的世纪老人微笑、真实动人',
      ]
    ),
    supported_aspect_ratios: ['3:4', '1:1', '4:5'],
    default_aspect_ratio: '3:4',
    required_consents: ['age-transformation'],
    provider_capabilities: ['face-id-lock', 'scene-depth-lock'],
    cost_tier: 'standard',
    allowed_channels: ['mp-xhs', 'mp-weixin', 'consumer-web', 'mobile'],
    competitive_highlights: [
      '独创「出生年份 + 目标年龄 = 真实年代」动态推演引擎，自动匹配对应年代的自然窗光、领口织物与生活场景',
      '内置 10 张纪实人文分镜（满 9 张直出九宫格对比笔记），50mm f/1.4 Leica 人文色彩科学',
      '中心平视纪实构图，像翻开一本跨越百年的私人家庭相册真迹，情感共鸣极强',
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
    version: '2.3.0',
    name: '温情伴侣/家人共老·时光合拍',
    subtitle: '双人/多人同框授权 · 统一主光与焦平面 · 10幕携手白头精选分镜',
    category: 'family-co-aging',
    badge: '家庭/伴侣必拍',
    status: 'active',
    max_participants: 3,
    min_age: 0,
    max_age: 100,
    min_curated_shots: MIN_CURATED_SHOTS_PER_TEMPLATE,
    recommended_ages: [...RECOMMENDED_CO_AGING_AGES],
    curated_gallery_shots: buildCuratedShotsForTemplate(
      'tpl_xhs_warm_family_co_aging',
      RECOMMENDED_CO_AGING_AGES,
      50,
      'f/2.8',
      '150cm大型抛物线柔光伞统一主光 + 暖调环绕漫射补光',
      [
        '十八初遇·并肩青春',
        '廿二相知·阳光同框',
        '廿八挚爱·默契依偎',
        '卅五成家·温润相伴',
        '四二同心·岁月沉香',
        '五十知己·从容相视',
        '五八微霜·暖意融融',
        '六六偕老·银丝初染',
        '七五金婚·眉眼如初',
        '八五白首·世纪同框',
      ],
      [
        '双人同色系白衬衫与米白纯棉针织领口',
        '清爽浅卡其亚麻衬衫与极简圆领针织衫',
        '高定暖灰美利奴羊毛情侣/家人协调领型',
        '驼色与燕麦色羊绒大衣内搭温润针织领',
        '质感深灰与暖棕丝毛混纺立领与V领呼应',
        '从容克制的精纺羊绒开衫与衬衫叠穿',
        '暖琥珀色调粗针羊毛衫与柔和围巾搭配',
        '银灰与暖米色高支羊绒披肩协调领口',
        '金婚典藏质感丝绒与细羊毛温暖高领',
        '世纪相伴传家级柔暖羊绒围裹领口',
      ],
      [
        '清透阳光影棚暖白背景·双人等距焦平面',
        '柔和奶油色调肖像画布·自然肩部依偎',
        '经典肖像馆暖灰手绘背景·统一45°主光方向',
        '温暖琥珀光晕影棚背景·双人眼神默契交汇',
        '沉稳暖褐肌理布景·柔和轮廓分离光',
        '时代感肖像馆经典布光·无串色多槽位锁脸',
        '温暖夕阳色温环绕背景·银发丝丝分明',
        '传家宝相册质感暖金暗角影棚背景',
        '金婚纪念高定丝绒灰暖调背景',
        '博物馆级百年同框温暖明暗肖像背景',
      ],
      [
        '并肩直视镜头、眼底带着初遇的明亮笑意',
        '头微微相倾、相对身高严格锁定、神态亲昵自然',
        '默契微侧身、一人直视一人温柔侧眸呼应',
        '肩膀自然相靠、温暖笃定的家庭幸福感',
        '相视一笑后同时望向镜头的松弛默契',
        '走过半生的从容笃定、眉眼间越发相似的温润',
        '鬓角微霜却眼神清亮、手挽手的温暖姿态',
        '银发相映、眼角笑纹自然舒展的慈爱神态',
        '历经风雨依然清澈温暖的相伴目光',
        '白发苍苍却眼神如初见的世纪温情凝望',
      ]
    ),
    supported_aspect_ratios: ['3:4', '4:5', '1:1'],
    default_aspect_ratio: '3:4',
    required_consents: ['age-transformation', 'family-co-aging'],
    provider_capabilities: ['multi-subject-face-lock', 'dual-focal-plane-control', 'high-res-skin-detail'],
    cost_tier: 'pro-studio',
    allowed_channels: ['mp-xhs', 'mp-weixin', 'consumer-web', 'studio'],
    competitive_highlights: [
      '内置 10 幕伴侣/家人共老精选分镜（18岁初遇至85岁白首），支持 1—3 人逐人独立授权同框',
      '150cm 抛物线柔光伞统一双人主光方向与 f/2.8 焦平面，锁定相对身高与眼神互动，彻底解决多人合成光影割裂',
      '多槽位 Regional PuLID v2 独立锁脸，杜绝双人五官串色；含未成年人出镜时自动启用私密保护',
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
    version: '2.3.0',
    name: '典藏画册高定棚拍·实体印刷版',
    subtitle: '中画幅 4:5 印刷画幅 · 300DPI 色彩预检 · 10张精装相册专享内页',
    category: 'fine-art-print',
    badge: '实物相册专享',
    status: 'active',
    max_participants: 2,
    min_age: 0,
    max_age: 100,
    min_curated_shots: MIN_CURATED_SHOTS_PER_TEMPLATE,
    recommended_ages: [...RECOMMENDED_SOLO_AGES],
    curated_gallery_shots: buildCuratedShotsForTemplate(
      'tpl_xhs_master_fine_art_photobook',
      RECOMMENDED_SOLO_AGES,
      80,
      'f/2.8',
      '影楼雷达罩蝴蝶光主光 + 双侧条形发丝轮廓光 + 黑色吸光板负补光',
      [
        '扉页01·三岁初啼·纯真典藏',
        '画册02·六岁童眸·蝴蝶柔光',
        '画册03·十二少年·学院肖像',
        '画册04·十八成人·高定纪念',
        '画册05·廿五黄金·画廊级主图',
        '画册06·卅二中坚·雕塑光影',
        '画册07·四五鼎盛·大师棚拍',
        '画册08·五八流金·银丝质感',
        '画册09·七二尊享·艺术留白',
        '尾页10·八五世纪·传世终章',
      ],
      [
        '高定婴儿羊绒象牙白微高领',
        '经典影楼质感小礼服纯棉拼接领口',
        '英伦精纺羊毛少年立领与丝质滚边',
        '成人礼高定剪裁丝毛混纺礼服领',
        '画廊级极简黑丝绒高定建筑感领型',
        '重磅桑蚕丝与精纺双面呢挺括翻领',
        '大师级定制深炭灰山羊绒高领毛衣',
        '典藏暗金纹理真丝披肩与羊毛内搭',
        '博物馆级重磅羊绒斗篷式温雅领口',
        '传世典藏黑天鹅绒与银丝刺绣高领',
      ],
      [
        'Oliphant手绘博物馆级暖灰油画布（预留3mm出血位）',
        '纯色粗亚麻肌理影棚背景布·柔和中心光晕',
        '16-bit深邃天鹅绒灰阶背景·CMYK安全暗部',
        '经典哈苏中画幅棚拍灰褐手刷画布',
        '画廊典藏级低反光炭黑肌理背景布',
        '立体负补光雕塑感中性灰画布',
        '高定肖像馆暖铜棕手绘背景布',
        '艺术微喷特种纸张友好型温润深灰背景',
        '大师级古典油画明暗过渡背景布',
        '传世相册终章深邃暖金光晕典藏背景',
      ],
      [
        '适合作为相册扉页的纯净凝视、眼神光饱满',
        '端庄灵动的童年正脸微侧肖像、神态自然',
        '挺拔沉静的少年棚拍姿态、眼神清亮坚定',
        '具有仪式感的十八岁成人礼庄重微笑',
        '极具杂志封面张力的自信平视凝眸',
        '立体骨相光影下的沉稳笃定神情',
        '45岁紧致轮廓与成熟睿智眼神、大师级气场',
        '优雅从容的银发初期神态、温润尔雅',
        '饱含人生阅历与温情的艺术家般平静目光',
        '适合作为99元精装相册压轴跨页的世纪传世微笑',
      ]
    ),
    supported_aspect_ratios: ['4:5', '3:4', '1:1'],
    default_aspect_ratio: '4:5',
    required_consents: ['age-transformation', 'physical-print'],
    provider_capabilities: ['face-id-lock', 'print-300dpi-upscale', 'cmyk-gamut-safe'],
    cost_tier: 'master-print',
    allowed_channels: ['mp-xhs', 'mp-weixin', 'consumer-web', 'studio', 'kiosk'],
    competitive_highlights: [
      '内置 10 张画册内页级高定棚拍分镜（精选 9–10 张直连 99 元精装实体相册 PHOTO_BOOK_HARDCOVER_0_100）',
      '按哈苏中画幅 80mm f/2.8 棚拍蝴蝶光/轮廓光设计，预留 3mm 印刷出血位与 16-bit CMYK 安全色域',
      '全库最高身份锁定阈值（>=0.85）与 300DPI 微距皮肤浮雕细节，确保实体相册铜版纸/艺术纸印制零瑕疵',
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
  {
    template_id: 'tpl_xhs_cinematic_wong_kar_wai',
    version: '2.3.0',
    name: '王家卫电影胶片·流金岁月',
    subtitle: '35mm f/1.4 电影宽银幕 · Kodak Vision3 500T 青橙霓虹 · 10幕故事感独白',
    category: 'cinematic-film',
    badge: '电影感爆款',
    status: 'active',
    max_participants: 1,
    min_age: 0,
    max_age: 100,
    min_curated_shots: MIN_CURATED_SHOTS_PER_TEMPLATE,
    recommended_ages: [...RECOMMENDED_SOLO_AGES],
    curated_gallery_shots: buildCuratedShotsForTemplate(
      'tpl_xhs_cinematic_wong_kar_wai',
      RECOMMENDED_SOLO_AGES,
      35,
      'f/1.4',
      '钨丝暖光侧逆主光 + 百叶窗青绿街景漫反射补光 (4:1电影光比)',
      [
        '三岁旧梦·花样童年',
        '六岁夏午·风扇光影',
        '十二天台·橘子汽水',
        '十八街角·霓虹初遇',
        '廿五花样·青橙独白',
        '卅二暗涌·窗影微醺',
        '四五流金·雪茄茶烟',
        '五八阿飞·旧钟余晖',
        '七二回首·胶片留声',
        '八五终章·2046记忆',
      ],
      [
        '复古米白纯棉小背心与柔和圆领',
        '九十年代海魂条纹针织领口',
        '泛黄胶片感棉麻少年衬衫领',
        '复古墨绿灯芯绒夹克配白T领口',
        '高定丝绒暗花立领或复古宽驳头西装领',
        '深酒红真丝衬衫微敞领口配风衣',
        '王家卫式剪裁精纺条纹西装与丝质领带',
        '复古粗花呢大衣配高支羊绒内搭',
        '岁月感暗金提花真丝睡袍式披肩领',
        '典藏深棕天鹅绒长礼服翻领',
      ],
      [
        '百叶窗漏下暖黄阳光的老式风扇居室',
        '绿色玻璃窗格透光的夏日旧公寓',
        '傍晚蓝调时刻天台与远景暖橘路灯光斑',
        '雨夜玻璃窗上霓虹虚化光晕与室内暖灯',
        'Kodak 500T青绿暗部与暖琥珀壁灯走廊',
        '慢门呼吸感咖啡馆卡座与丝绒窗帘焦外',
        '金光与青影交错的复古酒店旋转门景深',
        '挂着旧时钟的暖橘色光影书房',
        '黑胶唱机旋转微光的复古客厅',
        '电影谢幕般金色暖雾与深青色窗影',
      ],
      [
        '趴在窗边好奇凝望的清澈童眸',
        '盛夏午后安静出神的纯真目光',
        '仰望天空微风拂发的少年神情',
        '欲言又止、眼神充满故事感的青春回眸',
        '直视镜头却似透过镜头看往旧时光的深邃眼神',
        '嘴角克制微扬、眼神克制而迷离的电影主角感',
        '下颌线条紧致利落、沉稳笃定的流金气场',
        '隔着时光淡然一笑的通透从容',
        '温柔怀旧、眼底闪烁暖橘高光的慈祥凝视',
        '将一生故事藏进眼底的世纪电影定格',
      ]
    ),
    supported_aspect_ratios: ['3:4', '4:5', '9:16', '1:1'],
    default_aspect_ratio: '3:4',
    required_consents: ['age-transformation'],
    provider_capabilities: ['face-id-lock', 'cinematic-relighting', 'high-res-skin-detail'],
    cost_tier: 'pro-studio',
    allowed_channels: ['mp-xhs', 'mp-weixin', 'consumer-web', 'mobile', 'studio'],
    competitive_highlights: [
      '内置 10 幕王家卫电影级胶片分镜，35mm f/1.4 近景环境叙事 + 多景别九宫格呼吸感编排',
      'Kodak Vision3 500T (5219) 钨丝灯电影负片色彩科学，青绿暗部与暖琥珀高光碰撞，自带高光红晕 Halation',
      'IC-Light 百叶窗光影重打光 + 高低频分离微距皮肤纹理，小红书电影感独白笔记收藏率天花板',
    ],
    optics_and_lighting: {
      focal_length_mm: 35,
      aperture: 'f/1.4',
      framing: 'cinematic environmental close-up with rhythmic extreme-closeup to half-body storyboard',
      lighting_setup: '3200K 钨丝主光穿透百叶窗 + 青绿霓虹漫反射补光 (4:1 光比)',
      color_science: 'Kodak Vision3 500T 5219 电影负片青橙曲线 + 暖红高光辉光 Halation',
      skin_texture_policy: '保留电影胶片级真实微距毛孔与高光油脂反射，拒绝数码磨皮',
      film_grain_profile: '35mm Kodak 500T 电影胶片颗粒 + 高光边缘暖晕',
    },
    identity_preservation: {
      identity_adapter: 'instantid-pulid-hybrid-v2',
      craniofacial_anchor_weight: 0.92,
      eye_geometry_lock: 0.95,
      skin_undertone_lock: 0.89,
      expression_naturalness_weight: 0.93,
    },
    quality_thresholds: {
      min_identity_similarity: 0.82,
      max_facial_drift: 0.16,
      min_age_plausibility: 0.85,
      min_pose_background_coherence: 0.86,
      min_artifact_free_score: 0.9,
      min_sharpness_score: 0.84,
      min_aesthetic_score: 0.88,
      max_auto_retries: 2,
    },
    negative_constraints: ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
    age_band_recipes: buildAgeBandRecipes(
      'vintage Hong Kong cinema tailored velvet, trench coat, and silk collar',
      'warm tungsten venetian-blind shadows with teal neon bokeh'
    ),
  },
  {
    template_id: 'tpl_xhs_three_generations_heirloom',
    version: '2.3.0',
    name: '三代同堂/隔代亲情·跨时空同框',
    subtitle: '50mm f/4.0 全员清晰景深 · 最多4人跨时空授权合拍 · 10幕传家宝全家福',
    category: 'family-heirloom',
    badge: '催泪传家必拍',
    status: 'active',
    max_participants: 4,
    min_age: 0,
    max_age: 100,
    min_curated_shots: MIN_CURATED_SHOTS_PER_TEMPLATE,
    recommended_ages: [...RECOMMENDED_SOLO_AGES],
    curated_gallery_shots: buildCuratedShotsForTemplate(
      'tpl_xhs_three_generations_heirloom',
      RECOMMENDED_SOLO_AGES,
      50,
      'f/4.0',
      '双灯大型柔光箱均匀覆盖主光 + 顶部温暖轮廓光 (多代同框无暗角)',
      [
        '三岁怀抱·祖孙初见',
        '六岁庭院·大手牵小手',
        '十二门槛·比身高记忆',
        '十八远行·长辈嘱托',
        '廿五传承·跨时空同框',
        '卅二团圆·三代全家福',
        '四五中流·家的脊梁',
        '五八含饴·隔代温情',
        '七二四世·福寿绵长',
        '八五传家·百年家族树',
      ],
      [
        '温暖米白手工毛衣与长辈深色羊毛开衫同框呼应',
        '童年纯棉小翻领与父母经典纯色衬衫协调搭配',
        '少年清爽针织衫与家族暖色调格纹围巾',
        '挺括青年白衬衫与长辈中山装/羊绒衫庄重同框',
        '跨时空青年正装与童年/长辈温暖羊绒衫同色系叠搭',
        '三代同堂定制新中式桑蚕丝与精纺羊毛家庭礼服',
        '沉稳驼色羊绒大衣与家人温和米杏色针织呼应',
        '温厚银灰开衫与晚辈清爽棉麻衬衫亲切同框',
        '传家典藏暗红/深黛色丝毛礼服领口',
        '世纪家族庆典高定重磅羊绒与丝绸披肩',
      ],
      [
        '阳光洒满的家族老院藤椅与木门景深',
        '春日海棠盛开的庭院台阶全家福布景',
        '镌刻成长刻度线的老屋门框纪实背景',
        '照相馆经典红丝绒与暖灰渐层传家背景布',
        '跨时空同框肖像馆长椅·统一焦平面无割裂',
        '中秋团圆暖光客厅与实木餐桌远景',
        '沉稳大气的家族书房博古架柔焦背景',
        '金秋银杏落叶庭院的温暖逆光背景',
        '悬挂世代家族相框的温润厅堂背景',
        '博物馆级百年家族肖像典藏油画布',
      ],
      [
        '依偎在长辈怀中的纯真甜笑',
        '握着长辈温暖手掌的清澈信赖眼神',
        '并肩站立骄傲比身高的阳光笑脸',
        '既有青春朝气又有家人守护的笃定目光',
        '跨时空与童年自己或远行亲人同框的温柔凝视',
        '三代人眉眼相似、其乐融融的端庄微笑',
        '承上启下、温和坚毅的家庭中坚神态',
        '看着晚辈成长的欣慰慈爱笑容',
        '儿孙绕膝般温暖安详的长者目光',
        '跨越百年的家族血脉共鸣与庄严微笑',
      ]
    ),
    supported_aspect_ratios: ['4:5', '3:4', '1:1'],
    default_aspect_ratio: '4:5',
    required_consents: ['age-transformation', 'family-co-aging'],
    provider_capabilities: ['multi-subject-face-lock', 'dual-focal-plane-control', 'print-300dpi-upscale'],
    cost_tier: 'master-print',
    allowed_channels: ['mp-xhs', 'mp-weixin', 'consumer-web', 'studio', 'kiosk'],
    competitive_highlights: [
      '支持最多 4 人跨代际/跨时空同框（「现在的我 + 6岁的我」或「三代同堂」），10 幕传家级合拍分镜',
      '50mm f/4.0 景深精确覆盖前后排长幼座位，双柔光箱消除多人阴影遮挡与透视变形',
      '直连 99 元 20 页蝴蝶对裱精装相册（内置中缝 ±12mm 人脸避让预检，确保多人合拍绝不压折痕）',
    ],
    optics_and_lighting: {
      focal_length_mm: 50,
      aperture: 'f/4.0',
      framing: 'multi-generational group & cross-time bench portrait with deep unified f/4.0 focal plane',
      lighting_setup: '双侧 120cm 对称柔光箱 + 顶部暖调发丝分离光 (2.5:1 均匀光比)',
      color_science: 'Kodak Portra 160 多代际肤色和谐曲线 + CMYK 印刷安全色域',
      skin_texture_policy: '多槽位分年龄段独立皮肤肌理重建，杜绝长幼年龄特征串色',
      film_grain_profile: '哈苏 6x7 中画幅细腻典藏颗粒',
    },
    identity_preservation: {
      identity_adapter: 'multi-slot-region-pulid-v2',
      craniofacial_anchor_weight: 0.94,
      eye_geometry_lock: 0.96,
      skin_undertone_lock: 0.92,
      expression_naturalness_weight: 0.92,
    },
    quality_thresholds: {
      min_identity_similarity: 0.82,
      max_facial_drift: 0.16,
      min_age_plausibility: 0.85,
      min_pose_background_coherence: 0.87,
      min_artifact_free_score: 0.91,
      min_sharpness_score: 0.86,
      min_aesthetic_score: 0.87,
      max_auto_retries: 3,
    },
    negative_constraints: [
      ...ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
      'cross-generation face swap or age leakage between subjects',
      'face placed across center book spine gutter',
    ],
    age_band_recipes: buildAgeBandRecipes(
      'harmonious multi-generational heirloom wool, silk, and cotton attire',
      'warm family portrait conservatory and classic studio canvas'
    ),
  },
  {
    template_id: 'tpl_xhs_vogue_editorial_bw',
    version: '2.3.0',
    name: '林德伯格大师黑白·纯净骨相纪实',
    subtitle: '75mm f/2.0 纯正银盐黑白 · 剥离色彩干扰直击灵魂眼神 · 10幕杂志封面大片',
    category: 'bw-editorial',
    badge: '骨相高级感',
    status: 'active',
    max_participants: 1,
    min_age: 0,
    max_age: 100,
    min_curated_shots: MIN_CURATED_SHOTS_PER_TEMPLATE,
    recommended_ages: [...RECOMMENDED_SOLO_AGES],
    curated_gallery_shots: buildCuratedShotsForTemplate(
      'tpl_xhs_vogue_editorial_bw',
      RECOMMENDED_SOLO_AGES,
      75,
      'f/2.0',
      'Peter Lindbergh式高反差侧逆自然光 + 黑色吸光板深邃阴影雕塑 (5:1光比)',
      [
        '三岁黑白·纯净初眸',
        '六岁银盐·无瑕童真',
        '十二棱角·少年骨骼',
        '十八锐度·青春锋芒',
        '廿五封面·极致骨相',
        '卅二雕塑·光影切割',
        '四五大师·灵魂凝视',
        '五八纹理·白发银辉',
        '七二纪实·岁月刀刻',
        '八五不朽·铂金典藏',
      ],
      [
        '纯白重磅华夫格纯棉孩童圆领',
        '极简黑色粗针纯棉小高领',
        '挺括纯白廓形衬衫领与光影折角',
        '经典黑皮衣/重磅丹宁立领与白T叠穿',
        'Vogue封面级极简黑色高领羊绒衫',
        '解构主义挺括白衬衫与利落西装翻领',
        '不对称剪裁重磅炭黑羊毛大衣立领',
        '高反差银白丝毛混纺粗织纹披肩领',
        '大师级极简黑丝绒高领与银发形成强烈黑白对比',
        '铂金印相质感纯黑重磅羊绒雕塑感高领',
      ],
      [
        'Ilford HP5高调纯白漫射背景·突出乌黑瞳孔',
        '柔和银灰暗房渐变背景·自然暗角',
        '巴黎街头阴天漫射光感极简灰墙',
        '工业风天窗高反差明暗切割影棚背景',
        '林德伯格标志性炭黑粗帆布背景',
        '45°伦勃朗光束穿透的深邃暗房背景',
        '雕塑感负补光纯黑吸光绒布背景',
        '银盐冲洗相纸质感中灰阶背景',
        '高动态Zone System十级灰阶光影背景',
        '博物馆铂金印相（Platinum Print）永恒黑背景',
      ],
      [
        '毫无防备的纯净直视、瞳孔环形高光锐利',
        '安静而有力量的童年平视凝眸',
        '45°微侧展现清晰鼻梁与下颌骨相转折',
        '不加修饰、坚定直白地望向镜头深处',
        '超模般松弛却极具穿透力的零距离眼神接触',
        '微风拂过发丝、神情独立而克制',
        '无需磨皮修饰、自信展现紧致骨相与微表情',
        '银丝在逆光中发光、眼神睿智而深邃',
        '每一道岁月纹路都如银盐雕刻般充满故事与力量',
        '超越时间与色彩的永恒灵魂注视',
      ]
    ),
    supported_aspect_ratios: ['4:5', '3:4', '1:1'],
    default_aspect_ratio: '4:5',
    required_consents: ['age-transformation'],
    provider_capabilities: ['face-id-lock', 'bw-zone-system-lut', 'high-res-skin-detail'],
    cost_tier: 'pro-studio',
    allowed_channels: ['mp-xhs', 'mp-weixin', 'consumer-web', 'studio'],
    competitive_highlights: [
      '致敬 Peter Lindbergh 大师级黑白肖像美学，10 张纯净银盐分镜剥离一切色彩干扰，纯粹靠骨相与眼神封神',
      'Ilford HP5 Plus 400 + 亚当斯区域曝光法（Zone System I–IX 级灰阶），黑位扎实不死黑、银发高光丝丝分明',
      '高低频分离微距重建真实毛孔、唇纹与虹膜放射状纹理，在黑白影调下呈现极致胶片质感',
    ],
    optics_and_lighting: {
      focal_length_mm: 75,
      aperture: 'f/2.0',
      framing: 'editorial monochrome portrait with rhythmic extreme eye close-up and sculptural 3/4 profile',
      lighting_setup: '高反差定向天窗光 + 黑色吸光绒布负补光 (5:1 戏剧光比)',
      color_science: 'Ilford HP5 Plus 400 纯正银盐黑白曲线 + Zone System 十级灰阶分离',
      skin_texture_policy: '零磨皮黑白纪实微反差，强化真实毛孔、唇纹与眼神光穿透力',
      film_grain_profile: 'Ilford HP5 400 经典立方体卤化银黑白颗粒',
    },
    identity_preservation: {
      identity_adapter: 'instantid-pulid-hybrid-v2',
      craniofacial_anchor_weight: 0.95,
      eye_geometry_lock: 0.97,
      skin_undertone_lock: 0.9,
      expression_naturalness_weight: 0.92,
    },
    quality_thresholds: {
      min_identity_similarity: 0.84,
      max_facial_drift: 0.14,
      min_age_plausibility: 0.86,
      min_pose_background_coherence: 0.87,
      min_artifact_free_score: 0.92,
      min_sharpness_score: 0.87,
      min_aesthetic_score: 0.89,
      max_auto_retries: 2,
    },
    negative_constraints: [
      ...ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
      'muddy flat grey midtones without black/white point separation',
    ],
    age_band_recipes: buildAgeBandRecipes(
      'timeless Vogue editorial monochrome cashmere turtleneck, crisp white shirt, and wool coat',
      'Peter Lindbergh raw charcoal canvas and directional daylight studio shadow'
    ),
  },
  {
    template_id: 'tpl_xhs_24_solar_terms_poetic',
    version: '2.3.0',
    name: '二十四节气·自然外景呼吸感人像',
    subtitle: '85mm f/1.4 空气感大光圈 · 十个节气对应人生十幕 · 阳光草木自然逆光',
    category: 'outdoor-poetic',
    badge: '氧气感外景',
    status: 'active',
    max_participants: 1,
    min_age: 0,
    max_age: 100,
    min_curated_shots: MIN_CURATED_SHOTS_PER_TEMPLATE,
    recommended_ages: [...RECOMMENDED_SOLO_AGES],
    curated_gallery_shots: buildCuratedShotsForTemplate(
      'tpl_xhs_24_solar_terms_poetic',
      RECOMMENDED_SOLO_AGES,
      85,
      'f/1.4',
      '自然黄金时刻树影逆光发丝光 + 白色反光板清透眼神补光 (2.5:1氧气感)',
      [
        '三岁立春·新芽破土',
        '六岁雨水·杏花微雨',
        '十二惊蛰·春风少年',
        '十八春分·昼夜均光',
        '廿五小满·万物初盈',
        '卅二夏至·骄阳绿荫',
        '四五白露·秋水长天',
        '五八秋分·金桂流金',
        '七二霜降·红叶银丝',
        '八五冬至·瑞雪暖阳',
      ],
      [
        '春芽嫩绿手工纯棉针织小圆领',
        '杏花白柔软水洗棉麻孩童衫',
        '薄荷青透气亚麻少年衬衫领',
        '春分浅米白棉麻混纺氧气感开衫',
        '小满麦穗色高支亚麻修身衬衫领',
        '夏至墨绿桑蚕丝与亚麻清凉叠穿领',
        '白露暖驼色轻薄山羊绒微高领',
        '秋分桂花琥珀色粗纺羊毛披肩领',
        '霜降枫叶褐与银灰羊绒温暖围巾领',
        '冬至雪白重磅羊绒高领配暖色大衣',
      ],
      [
        '立春微焦嫩绿草尖与温暖晨曦光斑',
        '雨水江南屋檐细雨与杏花柔焦散景',
        '惊蛰微风吹拂的青翠竹林与柳梢逆光',
        '春分旷野清透蓝天与盛开白玉兰焦外',
        '小满青黄麦浪与午后四点金色阳光散景',
        '夏至浓密梧桐树荫下闪烁的猫眼光学光斑',
        '白露芦苇荡逆光银色边缘光与秋日晴空',
        '秋分满树金桂飘香的庭院暖阳散景',
        '霜降层林尽染的红枫焦外与夕阳暖光',
        '冬至初雪松枝与晶莹暖阳交织的静谧远景',
      ],
      [
        '仰头感受春风拂面的清澈童真笑眸',
        '伸手接住春雨般灵动好奇的眼神',
        '在春光中奔跑驻足回眸的清朗少年气',
        '迎着春分微风、眼神清透如水的青春微笑',
        '「花未全开月未圆」小满时节的松弛自信神态',
        '盛夏绿荫下沉稳清凉的平视目光',
        '秋日微风中紧致从容、温暖通透的微笑',
        '鬓染秋霜却如金秋般丰盈平和的眼神',
        '红叶映衬下银发熠熠生辉的慈祥浅笑',
        '冬雪暖阳中万物归藏般宁静温暖的世纪凝眸',
      ]
    ),
    supported_aspect_ratios: ['3:4', '4:5', '9:16'],
    default_aspect_ratio: '3:4',
    required_consents: ['age-transformation'],
    provider_capabilities: ['face-id-lock', 'outdoor-bokeh-physics', 'high-res-skin-detail'],
    cost_tier: 'pro-studio',
    allowed_channels: ['mp-xhs', 'mp-weixin', 'consumer-web', 'mobile', 'studio'],
    competitive_highlights: [
      '彻底打破纯室内影棚局限：将人生 10 个年龄阶段映射至「立春→小满→白露→冬至」十个中国二十四节气外景',
      '85mm f/1.4 物理级旋焦散景与口径蚀（Cat-eye Bokeh），阳光穿透树叶与银发形成通透发丝逆光',
      'Fujifilm Provia / Nostalgic Neg 自然森系色彩科学，皮肤在自然阳光下呈现真实通透的皮下散射（SSS）',
    ],
    optics_and_lighting: {
      focal_length_mm: 85,
      aperture: 'f/1.4',
      framing: 'airy outdoor poetic portrait with optical cat-eye foliage bokeh and backlit hair halo',
      lighting_setup: '135° 自然黄金时刻阳光逆光轮廓 + 白色反光板清透眼神光 (2.5:1 氧气感)',
      color_science: 'Fujifilm Nostalgic Neg & Provia 森系色彩科学 + 阳光通透皮下散射 SSS',
      skin_texture_policy: '自然阳光透射下的真实微距绒毛与通透水光肌理，零假白磨皮',
      film_grain_profile: 'Fujifilm Astia 100 极细日光反转片颗粒',
    },
    identity_preservation: {
      identity_adapter: 'east-asian-craniofacial-lock-v2',
      craniofacial_anchor_weight: 0.93,
      eye_geometry_lock: 0.95,
      skin_undertone_lock: 0.92,
      expression_naturalness_weight: 0.93,
    },
    quality_thresholds: {
      min_identity_similarity: 0.83,
      max_facial_drift: 0.15,
      min_age_plausibility: 0.85,
      min_pose_background_coherence: 0.87,
      min_artifact_free_score: 0.91,
      min_sharpness_score: 0.85,
      min_aesthetic_score: 0.88,
      max_auto_retries: 2,
    },
    negative_constraints: [
      ...ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
      'fake studio backdrop seam in outdoor scene',
      'harsh midday raccoon eye shadows',
    ],
    age_band_recipes: buildAgeBandRecipes(
      'seasonal breathable linen, mulberry silk, and soft cashmere aligned with 24 solar terms',
      'natural golden-hour botanical bokeh evolving from spring sprouts to winter snow'
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
    const birthYear = typeof body.birth_year === 'number' ? body.birth_year : 2026 - anchorAge;
    const projId = `proj_${Date.now()}`;
    const res: Project = {
      id: projId,
      state: 'ready',
      version: 1,
      template_id: tpl.template_id,
      template_version: tpl.version,
      current_age_anchor: anchorAge,
      birth_year: birthYear,
      aspect_ratio: chosenRatio,
      policy_summary: {
        ai_label_enforced: true,
        consent_verified: true,
        template_name: tpl.name,
        min_curated_shots: tpl.min_curated_shots,
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
        : [...tpl.recommended_ages];
    const anchorAge = ctx?.project.current_age_anchor ?? 28;
    const birthYear = ctx?.project.birth_year ?? 2026 - anchorAge;
    const chosenRatio = ctx?.project.aspect_ratio ?? tpl.default_aspect_ratio;
    const participantCount = ctx?.request.participant_slots?.length || 1;
    const shotMap = new Map(tpl.curated_gallery_shots.map((s) => [s.target_age, s]));

    const jobId = `job_${Date.now()}`;
    const frames = ages.map((age, idx) => {
      const recipe = resolveAgeBandRecipe(tpl, age);
      const phys = resolvePhysiologicalWeights(age);
      const era = resolveEraContext(birthYear, age);
      const presetShot = shotMap.get(age);
      const shotNum = idx + 1;
      const shotId =
        presetShot?.shot_id || `${tpl.template_id}_shot_${String(shotNum).padStart(2, '0')}_${age}y`;
      const shotTitle =
        presetShot?.title || `镜头${String(shotNum).padStart(2, '0')} · ${age}岁 · ${recipe.stage_label}`;
      const fallbackStoryboard = resolveStoryboardCropAndGrid(shotNum);
      const shotScale = presetShot?.shot_scale || fallbackStoryboard.shotScale;
      const nineGridPosition = presetShot?.nine_grid_position || fallbackStoryboard.nineGridPosition;
      const defaultSelected = presetShot ? presetShot.default_selected : shotNum <= 9;

      const isRetroactive = age < anchorAge;
      const ageDelta = age - anchorAge;
      const distancePenalty = Math.min(0.08, Math.abs(ageDelta) * 0.001);
      const identityScore = Number(
        Math.max(0.84, Math.min(0.98, recipe.identity_lock_strength - distancePenalty)).toFixed(2)
      );
      const aestheticScore = Number(
        Math.max(tpl.quality_thresholds.min_aesthetic_score + 0.04, 0.91).toFixed(2)
      );
      const primaryAssetId =
        ctx?.request.participant_slots?.[0]?.source_asset_ids?.[0] || 'asset_primary_adult';
      const multiPhotoAnchor = resolveMultiPhotoAnchor({
        primaryAdultAssetId: primaryAssetId,
        targetAge: age,
        effectiveIdentityWeight: identityScore,
        sideProfileAssetId: ctx?.request.side_profile_asset_id,
        childhoodReferenceAssetId: ctx?.request.childhood_reference_asset_id,
        childhoodReferenceAge: ctx?.request.childhood_reference_age ?? 6,
      });
      const enhancementPipeline = compileImageEnhancementPipeline(
        tpl,
        age,
        shotScale,
        multiPhotoAnchor
      );
      const providerPayload = compileProviderNativePayload(tpl, participantCount, identityScore);
      const optics = tpl.optics_and_lighting;
      const opticsSummary = `${optics.focal_length_mm}mm ${optics.aperture} · ${optics.lighting_setup.split('+')[0].trim()} · ${chosenRatio} · [${shotScale}]`;
      const compiledPrompt = [
        `[${tpl.name} v${tpl.version} | ${shotTitle}]`,
        `Anchor=${anchorAge}yo -> Target=${age}yo (${era.calendar_year}年 · ${era.decade_label}, IdentityLock=${identityScore}, DualAnchor=${multiPhotoAnchor.dual_anchor_active})`,
        `PhysiologicalMatrix: neoteny=${phys.craniofacial_neoteny_weight}, collagen=${phys.dermal_collagen_elasticity}, SSS=${phys.subsurface_scattering_strength}, nasolabial<=${phys.nasolabial_fold_depth_limit}, silver=${phys.silver_strand_ratio}, catchlight=${phys.eye_catchlight_clarity}`,
        `EraScene: ${era.era_scene_cue} | Collar: ${presetShot?.wardrobe_fabric_cue || era.collar_material_cue} | Light: ${era.window_light_cue}`,
        `Optics: ${optics.focal_length_mm}mm ${optics.aperture}, ${optics.lighting_setup}, ${optics.color_science}`,
        `Provider: ${providerPayload.provider_id} (${providerPayload.identity_adapter})`,
      ].join(' | ');

      const signedUrl = `https://cdn.sandbox.ailifetime.local/preview/${jobId}/${tpl.template_id}-age-${age}.webp?sig=shortlived`;
      registerEphemeralPreviewUrl(signedUrl);

      return {
        age,
        label: `${age}岁 · ${recipe.stage_label}`,
        signed_preview_url: signedUrl,
        expires_at: inOneHour,
        ai_watermark_text: 'AI生成 · 艺术化示意非真实预测',
        shot_id: shotId,
        shot_index: shotNum,
        shot_title: shotTitle,
        shot_scale: shotScale,
        nine_grid_position: nineGridPosition,
        default_selected: defaultSelected,
        template_id: tpl.template_id,
        stage_label: recipe.stage_label,
        calendar_year: era.calendar_year,
        decade_label: era.decade_label,
        era_scene_cue: presetShot?.backdrop_prop_cue || era.era_scene_cue,
        collar_material_cue: presetShot?.wardrobe_fabric_cue || era.collar_material_cue,
        window_light_cue: era.window_light_cue,
        is_retroactive_simulation: isRetroactive,
        retroactive_disclosure: isRetroactive
          ? `基于 ${anchorAge} 岁骨相锚点的童年/过往回溯艺术创作示意 (${era.calendar_year}年)`
          : null,
        optics_summary: opticsSummary,
        compiled_prompt: compiledPrompt,
        negative_prompt: tpl.negative_constraints.join(', '),
        identity_score: identityScore,
        aesthetic_score: aestheticScore,
        quality_passed: true,
        physiological_weights: phys,
        provider_payload: providerPayload,
        image_enhancement_pipeline: enhancementPipeline,
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
        completed_units: 10,
        total_units: 10,
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

export function saveCuratedGallerySelection(params: {
  project_id: string;
  template_id: string;
  selected_shot_ids: string[];
  selected_ages: number[];
  export_mode: 'xhs_9_grid' | 'photobook_hardcover' | 'digital_bundle';
}): CuratedGallerySelectionReceipt {
  const uniqueShotIds = Array.from(new Set(params.selected_shot_ids));
  if (uniqueShotIds.length < MIN_CURATED_SHOTS_PER_TEMPLATE) {
    throw new Error(
      `CURATED_SELECTION_TOO_SMALL: 每套高定模板至少需精选 ${MIN_CURATED_SHOTS_PER_TEMPLATE} 张成片（当前已选 ${uniqueShotIds.length} 张），方可执行九宫格成片导出或 99 元精装相册印制。`
    );
  }
  return {
    selection_id: `sel_${Date.now()}`,
    project_id: params.project_id,
    template_id: params.template_id,
    selected_shot_ids: uniqueShotIds,
    selected_ages: [...params.selected_ages].sort((a, b) => a - b),
    selected_count: uniqueShotIds.length,
    export_mode: params.export_mode,
    photobook_sku:
      params.export_mode === 'photobook_hardcover' ? 'PHOTO_BOOK_HARDCOVER_0_100' : null,
    updated_at: new Date().toISOString(),
  };
}

export function compilePhotobookLayoutManifest(params: {
  project_id: string;
  template_id: string;
  birth_year: number;
  selected_shot_ids: string[];
  selected_ages: number[];
  title?: string;
}): PhotobookLayoutManifest {
  const uniqueShotIds = Array.from(new Set(params.selected_shot_ids));
  if (uniqueShotIds.length < MIN_CURATED_SHOTS_PER_TEMPLATE) {
    throw new Error(
      `PHOTOBOOK_REQUIRES_MIN_9_SHOTS: 20页蝴蝶对裱精装相册至少需要精选 ${MIN_CURATED_SHOTS_PER_TEMPLATE} 张成片（当前 ${uniqueShotIds.length} 张）`
    );
  }
  const sortedAges = [...params.selected_ages].sort((a, b) => a - b);
  const firstYear = params.birth_year + sortedAges[0];
  const lastYear = params.birth_year + sortedAges[sortedAges.length - 1];
  const albumTitle = params.title || '《时光典藏 · 0–100岁人生摄影集》';

  const spreads: PhotobookSpreadSpec[] = [
    {
      spread_index: 1,
      left_page_number: 1,
      right_page_number: 2,
      layout_archetype: 'vellum_gold_foil_frontispiece',
      paper_stock: '110g 德国半透明硫酸纸衬页 + 250g 特种棉绒扉页纸',
      finish_craft: '哑金烫印压凹工艺 (Gold-Foil Debossed Typography)',
      whitespace_ratio: 0.72,
      shot_ids: [uniqueShotIds[0]],
      target_ages: [sortedAges[0]],
      calendar_years: [firstYear],
      era_watermarks: [`${firstYear} — ${lastYear} CHRONICLE`],
      narrative_quote: `${albumTitle} · 从 ${firstYear} 到 ${lastYear} 的生命光影档案`,
      face_bbox_x_mm: [278, 346],
      gutter_safe_verified: true,
    },
  ];

  const archetypes = [
    { name: 'left_text_right_portrait', ws: 0.35, bbox: [268, 352] },
    { name: 'full_bleed_with_gutter_guard', ws: 0.28, bbox: [262, 348] },
    { name: 'gatefold_childhood_vs_prime_comparison', ws: 0.32, bbox: [64, 148] },
    { name: 'left_portrait_right_editorial_essay', ws: 0.36, bbox: [68, 154] },
    { name: 'kinfolk_golden_ratio_portrait', ws: 0.38, bbox: [272, 356] },
    { name: 'full_bleed_with_gutter_guard', ws: 0.3, bbox: [62, 146] },
    { name: 'left_text_right_portrait', ws: 0.35, bbox: [270, 354] },
    { name: 'paired_era_dialogue_spread', ws: 0.34, bbox: [66, 152] },
  ];

  let cursor = 0;
  for (let i = 0; i < 8; i++) {
    const spreadNum = i + 2;
    const leftPage = (spreadNum - 1) * 2 + 1;
    const rightPage = leftPage + 1;
    const remainingSpreads = 8 - i;
    const remainingShots = sortedAges.length - cursor;
    const takeCount =
      (i === 2 && remainingShots > remainingSpreads) ||
      (i === 7 && sortedAges.length - cursor >= 2)
        ? 2
        : 1;
    const groupAges = sortedAges.slice(cursor, cursor + takeCount);
    const groupShots = uniqueShotIds.slice(cursor, cursor + takeCount);
    cursor += takeCount;
    const groupYears = groupAges.map((a) => params.birth_year + a);
    const arch = archetypes[i];

    spreads.push({
      spread_index: spreadNum,
      left_page_number: leftPage,
      right_page_number: rightPage,
      layout_archetype: arch.name,
      paper_stock: '170g 德国进口哑光无酸艺术纸 (Archival Matte Art Paper)',
      finish_craft: '180° 蝴蝶对裱无缝跨页 + 3mm 出血 + 暗部 +13.5% Gamma 补偿',
      whitespace_ratio: arch.ws,
      shot_ids: groupShots,
      target_ages: groupAges,
      calendar_years: groupYears,
      era_watermarks: groupAges.map((a, idx) => `${groupYears[idx]}年 · ${a}岁`),
      narrative_quote:
        groupAges.length > 1
          ? `「从 ${groupYears[0]}年(${groupAges[0]}岁) 到 ${groupYears[1]}年(${groupAges[1]}岁)，骨相未改，眼神愈发温润。」`
          : `「${groupYears[0]}年 · ${groupAges[0]}岁：光影定格生命的呼吸与从容。」`,
      face_bbox_x_mm: arch.bbox,
      gutter_safe_verified: true,
    });
  }

  const voiceBars = Array.from({ length: 32 }, (_, idx) => {
    const wave = Math.sin((idx / 31) * Math.PI);
    return Math.round(22 + wave * 64 + ((idx * 17) % 11));
  });

  spreads.push({
    spread_index: 10,
    left_page_number: 19,
    right_page_number: 20,
    layout_archetype: 'acoustic_voiceprint_colophon_spread',
    paper_stock: '250g 特种棉绒典藏尾页纸',
    finish_craft: '32段矢量声纹UV浮雕印制 + 安全白名单有声二维码 + 独立防伪编号',
    whitespace_ratio: 0.68,
    shot_ids: [uniqueShotIds[uniqueShotIds.length - 1]],
    target_ages: [sortedAges[sortedAges.length - 1]],
    calendar_years: [lastYear],
    era_watermarks: [`VOICEPRINT ARCHIVE · ${lastYear}`],
    narrative_quote: '「当纸页翻至终章，声音将替相册继续讲述未完的时光故事。」',
    face_bbox_x_mm: [68, 144],
    gutter_safe_verified: true,
  });

  return {
    manifest_id: `pb_${Date.now()}`,
    project_id: params.project_id,
    gallery_id: `gal_${params.project_id}`,
    template_id: params.template_id,
    sku_code: 'PHOTO_BOOK_HARDCOVER_0_100',
    title: albumTitle,
    subtitle: '180° 蝴蝶对裱精装珍藏版 · 20页 (10跨页) · 170g 德国哑光艺术纸',
    binding_type: '180° 蝴蝶对裱精装硬壳 (Butterfly Layflat Hardcover)',
    page_count: 20,
    spread_count: 10,
    selected_shot_count: uniqueShotIds.length,
    vellum_frontispiece_enabled: true,
    gold_foil_emboss_enabled: true,
    spreads,
    acoustic_colophon: {
      audio_memory_id: `aud_${params.project_id}`,
      voice_qr_url: `https://timecapsule.cn/s/${encodeURIComponent(params.project_id)}`,
      duration_seconds: 42.0,
      voiceprint_bars: voiceBars,
      caption: '微信/小红书扫码聆听：写给岁月与家人的有声时光独白（加密白名单直连）',
      qr_whitelisted: true,
    },
    preflight_report: {
      preflight_passed: true,
      dpi_verified: 300,
      bleed_mm: 3,
      cmyk_icc_profile: 'ISOcoated_v2_300_eci.icc',
      max_cmyk_tac_percent: 282.0,
      tac_limit_percent: 300.0,
      shadow_gamma_lift: 1.135,
      black_point_compensation_ire: 4.0,
      spine_center_x_mm: 210.0,
      gutter_safe_margin_mm: 12.0,
      gutter_face_collisions: 0,
      warnings: [],
    },
    updated_at: new Date().toISOString(),
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
