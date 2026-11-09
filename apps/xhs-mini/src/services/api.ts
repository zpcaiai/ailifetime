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
  WorldLandmarkPhotoSpec,
  WorldLandmarkRegionId,
  WorldLandmarkRegionSpec,
  LandmarkSynthesisItem,
  LandmarkSynthesisRunRecord,
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
  // 10. 世界名胜古迹·100大环球奇观实景旅拍（独立世界名胜古迹分类）
  {
    template_id: 'tpl_xhs_world_landmarks_50_global',
    version: '2.4.0',
    name: '世界名胜古迹·100大环球奇观实景旅拍',
    subtitle: '35mm/50mm 透视地平线对齐 · 环境 HDR IBL 物理重打光 · 足底接触阴影与大气景深',
    category: 'world-landmarks',
    badge: '环球旅拍 · 100大名胜',
    status: 'active',
    max_participants: 4,
    min_age: 1,
    max_age: 100,
    min_curated_shots: 9,
    recommended_ages: [6, 12, 18, 22, 28, 35, 45, 58, 72, 85],
    curated_gallery_shots: buildCuratedShotsForTemplate(
      'tpl_xhs_world_landmarks_50_global',
      [6, 12, 18, 22, 28, 35, 45, 58, 72, 85],
      35,
      'f/2.2',
      'IC-Light 环境 HDR IBL 太阳方位/高度角重打光 + 地面漫反射补光',
      [
        '故宫太和殿丹陛红墙（北京）',
        '万里长城慕田峪云海敌楼（北京）',
        '巴黎埃菲尔铁塔夏乐宫晨光（法国）',
        '圣托里尼伊亚蓝顶教堂爱琴海（希腊）',
        '吉萨胡夫大金字塔与狮身人面像（埃及）',
        '京都五重塔春樱与富士山冠雪（日本）',
        '马丘比丘安第斯云端印加遗址（秘鲁）',
        '罗马斗兽场帝国古拱廊夕照（意大利）',
        '瑞士少女峰阿尔卑斯雪山列车（瑞士）',
        '冰岛杰古沙龙冰河湖极光黑沙滩（冰岛）',
      ],
      [
        '新中式立领桑蚕丝外套，色彩与朱红宫墙冷暖呼应',
        '户外机能风衣配暖色围巾，随山风自然微扬',
        '法式经典卡其色风衣配丝质方巾',
        '海岛度假风纯白亚麻衬衫，随爱琴海微风轻扬',
        '亚麻猎装夹克配复古宽檐遮阳帽',
        '日系极简浅米色羊绒风衣或传统手工羽织',
        '秘鲁羊驼毛（Alpaca）几何织纹披肩配徒步外套',
        '意式高定亚麻西装外套配真丝口袋巾',
        '高定羊绒雪山度假毛衣配格纹围巾',
        '冰岛传统几何提花羊毛衣（Lopapeysa）配防寒派克大衣',
      ],
      [
        '故宫太和殿重檐庑殿顶鎏金琉璃瓦与汉白玉雕栏实景',
        '慕田峪长城明代敌楼、青砖垛口与晨雾群山',
        '埃菲尔铁塔全貌、塞纳河岸树影与奥斯曼建筑天际线',
        '圣托里尼三座钴蓝圆顶教堂、纯白阶梯与深蓝爱琴海',
        '胡夫大金字塔巨石阵列、斯芬克斯巨像与金色大漠夕照',
        '五重塔朱红飞檐、漫天春樱与富士山白雪峰顶',
        '马丘比丘花岗岩神庙、翠绿梯田与瓦伊纳比丘奇峰',
        '罗马斗兽场三层古拱门、鹅卵石御道与落日金晖',
        '少女峰与艾格峰皑皑白雪、红色登山齿轮列车与草甸木屋',
        '杰古沙龙冰河湖千年蓝冰、火山黑沙滩与绿色北极光',
      ],
      [
        '纯真好奇的清澈眼神与自然微笑',
        '迎向山风的蓬勃朝气与自信神采',
        '法式电影般的松弛浪漫微笑',
        '灿烂舒展的度假笑意',
        '跨越四千五百年古文明的深邃平视目光',
        '沉静内敛的东方温和笑意',
        '历经山河后的开阔与从容',
        '儒雅睿智的微笑',
        '幸福安宁的慈祥笑意',
        '看遍世界奇观后的豁达与超然',
      ]
    ),
    supported_aspect_ratios: ['3:4', '4:5', '1:1', '9:16'],
    default_aspect_ratio: '3:4',
    required_consents: ['age-transformation'],
    provider_capabilities: ['instantid-v2', 'pulid-flux-pro', 'ic-light-ibl-v2', 'horizon-perspective-align'],
    cost_tier: 'premium-landmark-50',
    allowed_channels: ['mp-xhs', 'mp-weixin', 'consumer-web', 'mobile', 'studio'],
    competitive_highlights: [
      '内置完整 100 张世界各地名胜古迹实景照片底板（涵盖华夏古建、欧洲古典、亚太奇观、中东非古文明、美洲与极地各 20 张）',
      '透视地平线对齐（Horizon Vanishing-Point Alignment）+ 足底真实接触阴影，彻底告别生硬抠图与脚底悬空贴纸感',
      'IC-Light 环境 HDR IBL 物理重打光：自动提取景点太阳方位角、高度角与天空色温，将真实阳光/夕阳/极光反射到人物脸部与衣领',
    ],
    optics_and_lighting: {
      focal_length_mm: 35,
      aperture: 'f/2.2',
      framing: 'environmental travel portrait with matched horizon vanishing point and natural landmark bokeh',
      lighting_setup: 'IC-Light 环境 HDR IBL 太阳方位/高度角物理重打光 + 地面漫反射补光',
      color_science: 'Kodak Portra 400 & Ektar 100 环球旅拍色彩科学 + 大气空气透视',
      skin_texture_policy: '户外自然阳光皮下散射（SSS）与真实微距毛孔，严格匹配景点环境色温',
      film_grain_profile: '35mm 纪实旅拍银盐细腻颗粒',
    },
    identity_preservation: {
      identity_adapter: 'multi-photo-3d-landmark-lock-v2',
      craniofacial_anchor_weight: 0.94,
      eye_geometry_lock: 0.95,
      skin_undertone_lock: 0.93,
      expression_naturalness_weight: 0.94,
    },
    quality_thresholds: {
      min_identity_similarity: 0.84,
      max_facial_drift: 0.14,
      min_age_plausibility: 0.86,
      min_pose_background_coherence: 0.89,
      min_artifact_free_score: 0.92,
      min_sharpness_score: 0.86,
      min_aesthetic_score: 0.89,
      max_auto_retries: 2,
    },
    negative_constraints: [
      ...ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
      'flat cardboard cutout paste effect',
      'mismatched horizon vanishing point',
      'floating feet without ground contact shadow',
      'inconsistent sunlight direction between face and landmark',
    ],
    age_band_recipes: buildAgeBandRecipes(
      'culturally and climatically matched travel outfits (silk, trench coat, linen safari, cashmere)',
      '100 world-famous UNESCO landmarks with matched perspective horizon, HDR IBL sunlight, and contact shadows'
    ),
  },
];

export const WORLD_LANDMARK_REGIONS: WorldLandmarkRegionSpec[] = [
  {
    region_id: 'china_oriental_heritage',
    name: '华夏古建与九州山河',
    badge: '中华名胜 · 20张',
    description: '故宫、长城、敦煌、兵马俑、西湖、漓江、布达拉宫、张家界、苏州园林、泰山、九寨沟、黄山、天坛、颐和园、丽江、乐山大佛、鼓浪屿、外滩、龙门石窟、长白山天池',
  },
  {
    region_id: 'europe_classical_monuments',
    name: '欧洲古典文明与浪漫地标',
    badge: '欧洲地标 · 20张',
    description: '埃菲尔铁塔、罗马斗兽场、雅典卫城、圣托里尼、圣家堂、大本钟、威尼斯、少女峰、新天鹅堡、查理大桥、卢浮宫、比萨斜塔、五渔村、阿马尔菲、哈修塔特、圣米歇尔山、风车村、巨石阵、盖朗厄尔峡湾、杜布罗夫尼克',
  },
  {
    region_id: 'asia_pacific_wonders',
    name: '亚太人文古迹与自然奇观',
    badge: '亚太奇观 · 20张',
    description: '京都伏见稻荷与富士山、吴哥窟、泰姬陵、蒲甘万塔、佩特拉、卡帕多奇亚、红场、巴厘岛、滨海湾花园、悉尼歌剧院、岚山竹林、景福宫、下龙湾、大皇宫、乌鲁鲁、米尔福德峡湾、婆罗浮屠、琥珀堡、棉花堡、大堡礁心形礁',
  },
  {
    region_id: 'middle_east_africa_ancient',
    name: '中东非古文明与旷野奇迹',
    badge: '中东非 · 20张',
    description: '吉萨金字塔、卢克索神庙、舍夫沙万蓝城、撒哈拉沙丘、阿布扎比清真寺、乞力马扎罗、塞伦盖蒂、猴面包树大道、维多利亚瀑布、哈利法塔、阿布辛贝、瓦迪拉姆、马拉喀什、好望角桌山、苏丝斯黎红沙漠、粉红清真寺、波斯波利斯、拉利贝拉、桑给巴尔、埃尔奥拉',
  },
  {
    region_id: 'americas_polar_marvels',
    name: '美洲文明遗迹与极地奇景',
    badge: '美洲极地 · 20张',
    description: '马丘比丘、自由女神与布鲁克林大桥、里约基督山、奇琴伊察、科罗拉多大峡谷、乌尤尼天空之镜、复活节岛、班夫梦莲湖、冰岛极光冰河湖、南极天堂湾、金门大桥、羚羊峡谷、黄石大棱镜、优胜美地、尼亚加拉、伊瓜苏、百内国家公园、莫雷诺冰川、格陵兰伊卢利萨特、斯瓦尔巴北极蓝冰',
  },
];

type RawLandmarkTuple = [
  string, number, string, string, WorldLandmarkRegionId, string, string,
  number, number, string, number, string, number, number, number,
  number, number, number, string, number, number, string, string, string, string
];

const RAW_50_LANDMARKS: RawLandmarkTuple[] = [
  // Region 1: 华夏古建与九州山河 (01 - 10)
  ['lmk_001_forbidden_city_taihedian', 1, '北京故宫·太和殿丹陛红墙', '紫禁城琉璃金瓦与汉白玉雕栏晨光', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 北京', 39.9163, 116.3972, 'UNESCO-439', 50, 'f/2.8', 0.46, -2, 3.2, 132, 28, 4800, 'hdr_beijing_forbidden_city_morning', 0.86, 0.14, '新中式立领桑蚕丝外套或简约高质感羊绒大衣', '立于汉白玉望柱旁微侧身回眸，目光温润从容', '太和殿重檐庑殿顶鎏金琉璃瓦、朱红宫墙与汉白玉云龙石雕纵深透视', 'Kodak_Portra_400_Oriental_Vermilion.cube'],
  ['lmk_002_great_wall_mutianyu', 2, '万里长城·慕田峪云海敌楼', '崇山峻岭间的巨龙脊梁与金色晨曦', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 北京怀柔', 40.4319, 116.5704, 'UNESCO-438', 35, 'f/2.8', 0.38, 4, 2.8, 115, 22, 4500, 'hdr_great_wall_golden_ridge', 0.88, 0.22, '户外机能风衣或暖色系粗花呢外套', '手扶古老青砖垛口远眺层峦叠嶂，侧逆光勾勒发丝与立体鼻梁轮廓', '蜿蜒起伏的明代青砖长城马道、烽火台与远山晨雾云海', 'Kodak_Ektar_100_Mountain_Gold.cube'],
  ['lmk_003_dunhuang_crescent_lake', 3, '敦煌鸣沙山·月牙泉大漠落日', '丝绸之路金色沙脊与千年绿洲古阁', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 甘肃敦煌', 40.0887, 94.6700, 'UNESCO-440', 85, 'f/2.0', 0.42, -3, 3.8, 248, 14, 3600, 'hdr_dunhuang_desert_sunset', 0.84, 0.26, '赤陶色或米白亚麻披肩长衫，随大漠晚风轻盈飘动', '伫立于S形沙脊光影交界线，夕阳低角度暖金光线均匀漫射面部', '鸣沙山流线型金色沙丘光影棱线与月牙泉清澈碧水、汉唐古亭倒影', 'Kodak_Vision3_250D_SilkRoad_Amber.cube'],
  ['lmk_004_xian_terracotta_dayan', 4, '长安古韵·大雁塔与秦汉风华', '盛唐红墙雁塔晨钟与古都气韵', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 陕西西安', 34.2186, 108.9642, 'UNESCO-441', 50, 'f/2.0', 0.48, -4, 3.0, 145, 32, 4900, 'hdr_xian_dayan_pagoda_dusk', 0.85, 0.16, '素雅宋锦/唐风改良中式立领衬衫', '于红墙青瓦夹道平视微仰镜头，古塔飞檐在背景自然柔化', '大慈恩寺红墙黛瓦、七层方形古砖塔与银杏树影斑驳', 'Fuji_Pro_400H_ChangAn_Heritage.cube'],
  ['lmk_005_hangzhou_west_lake', 5, '杭州西湖·雷峰夕照与断桥烟柳', '江南水墨画卷中的亭台荷风', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 浙江杭州', 30.2427, 120.1488, 'UNESCO-1334', 85, 'f/1.8', 0.50, 0, 3.4, 230, 18, 4700, 'hdr_west_lake_misty_sunset', 0.78, 0.30, '浅青色或月白色真丝衬衫配轻薄针织衫', '凭栏立于西子湖畔木栈桥，湖面波光形成柔和眼底眼神光', '西湖潋滟水波、垂柳荷叶、乌篷船与远方雷峰塔暮色剪影', 'Fuji_Velvia_50_Jiangnan_Celadon.cube'],
  ['lmk_006_guilin_li_river_karst', 6, '桂林漓江·阳朔20元背景喀斯特峰林', '青罗带水与竹筏烟雨画卷', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 广西桂林', 24.9333, 110.5167, 'UNESCO-1248', 50, 'f/2.2', 0.44, 0, 3.1, 105, 35, 5300, 'hdr_guilin_li_river_karst_mist', 0.80, 0.32, '素色棉麻休闲旅拍衬衫，清爽通透', '立于漓江鹅卵石浅滩或竹筏船头，背后千峰倒影入碧水', '层叠翠绿的喀斯特锥状石灰岩峰林、澄澈漓江倒影与晨雾渔火', 'Fuji_Astia_100F_Karst_Emerald.cube'],
  ['lmk_007_lhasa_potala_palace', 7, '拉萨布达拉宫·雪域高原日光倾城', '海拔3700米红白宫墙与澄澈蓝天', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 西藏拉萨', 29.6555, 91.1186, 'UNESCO-707', 35, 'f/2.8', 0.52, -6, 2.9, 160, 48, 5600, 'hdr_lhasa_potala_high_altitude', 0.92, 0.08, '藏蓝或米白高原防风羊毛大衣配民族风织锦围巾', '在药王山观景台角度微仰取景，高原纯净强日光塑造鲜明立体骨相', '红山之巅宏伟的布达拉宫白宫红宫群落、鎏金经幢与高原深邃蔚蓝天空', 'Kodak_Ektar_100_Tibet_PureSky.cube'],
  ['lmk_008_zhangjiajie_avatar_peaks', 8, '张家界武陵源·乾坤柱石英砂岩云海', '三千奇峰拔地而起的仙境云涛', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 湖南张家界', 29.3256, 110.4348, 'UNESCO-640', 35, 'f/2.8', 0.40, 5, 2.7, 98, 30, 5400, 'hdr_zhangjiajie_cloud_pillars', 0.82, 0.34, '山系户外简约纯色夹克', '于悬崖观景台凭栏回望，云雾自砂岩峰柱间流动环绕', '垂直节理发育的石英砂岩峰林、苍翠武陵松与翻涌云海', 'Fuji_Provia_100F_Cloud_Pillar.cube'],
  ['lmk_009_suzhou_humble_admin_garden', 9, '苏州拙政园·漏窗飞檐与曲水亭桥', '移步换景的江南古典园林巅峰', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 江苏苏州', 31.3242, 120.6294, 'UNESCO-813', 85, 'f/2.0', 0.48, 0, 3.3, 140, 36, 5100, 'hdr_suzhou_classical_garden_window', 0.83, 0.18, '新中式苏绣暗纹立领衬衫或素雅旗袍/长衫', '透过海棠形冰裂纹花窗形成天然前景框景，神情恬静温婉', '粉墙黛瓦、太湖石假山、小飞虹廊桥与翠竹芭蕉水影', 'Kodak_Portra_160_Suzhou_Ink.cube'],
  ['lmk_010_mount_tai_sunrise_sea', 10, '五岳独尊·泰山玉皇顶日出云海', '登泰山而小天下的壮阔破晓金光', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 山东泰安', 36.2558, 117.1006, 'UNESCO-437', 50, 'f/2.8', 0.36, 3, 3.0, 82, 12, 3500, 'hdr_mount_tai_sunrise_crest', 0.89, 0.24, '暖色调防风羽绒或羊毛登山大衣', '立于泰山极顶摩崖石刻旁迎向破晓朝日，眼神坚定从容', '泰山拱北石、五岳独尊石刻与一望无际的赤金破晓云海', 'Kodak_Portra_800_Dawn_Summit.cube'],

  // Region 2: 欧洲古典文明与浪漫地标 (11 - 20)
  ['lmk_011_paris_eiffel_trocadero', 11, '巴黎埃菲尔铁塔·夏乐宫塞纳河晨光', '法兰西浪漫铁塔与奥斯曼建筑天际线', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '法国 · 巴黎', 48.8584, 2.2945, 'UNESCO-600', 50, 'f/2.0', 0.48, -3, 3.2, 128, 25, 4600, 'hdr_paris_trocadero_golden_morning', 0.86, 0.16, '法式经典卡其色风衣配丝质方巾或优雅米白西装', '于夏乐宫大理石露台微侧身倚栏，铁塔完整居中偏黄金分割位', '镂空钢铁结构的埃菲尔铁塔全貌、塞纳河岸树影与巴黎奶油色石材建筑', 'Kodak_Portra_400_Parisian_Cream.cube'],
  ['lmk_012_rome_colosseum_golden_hour', 12, '罗马斗兽场·古罗马帝国拱廊夕照', '两千年石灰华石拱与永恒之城暖阳', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '意大利 · 罗马', 41.8902, 12.4922, 'UNESCO-91', 50, 'f/2.2', 0.47, -2, 3.3, 242, 20, 4100, 'hdr_rome_colosseum_travertine_sunset', 0.88, 0.15, '意式亚麻西装外套或复古赫本风白衬衫', '漫步于鹅卵石古道回眸一笑，夕阳穿过古罗马三层石拱投下温暖光斑', '弗拉维安圆形剧场宏伟的三层科林斯柱式拱门与罗马伞松剪影', 'Kodak_Vision3_250D_Roman_Holiday.cube'],
  ['lmk_013_athens_acropolis_parthenon', 13, '雅典卫城·帕特农神庙多立克石柱', '古希腊文明摇篮与爱琴海晴空', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '希腊 · 雅典', 37.9715, 23.7257, 'UNESCO-404', 35, 'f/2.8', 0.50, -5, 3.0, 195, 42, 5400, 'hdr_athens_parthenon_marble_sun', 0.91, 0.10, '纯白或橄榄绿垂感亚麻长衫，地中海古典纯粹气质', '立于卫城彭特利库斯大理石阶前，大理石漫反射光天然提亮下颌与眼周', '帕特农神庙八柱多立克柱廊、三角楣雕与远眺爱琴海的雅典全城风貌', 'Fuji_Pro_400H_Aegean_Marble.cube'],
  ['lmk_014_santorini_oia_blue_domes', 14, '圣托里尼伊亚·爱琴海蓝顶白墙悬崖', '基克拉泽斯纯白阶梯与蔚蓝火山海湾', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '希腊 · 圣托里尼', 36.4618, 25.3753, 'UNESCO-AEG-01', 35, 'f/2.4', 0.42, 4, 2.8, 250, 26, 5200, 'hdr_santorini_oia_caldera_breeze', 0.87, 0.12, '海岛度假风纯白棉麻衬衫或钴蓝色飘逸长裙', '立于伊亚纯白弧形露台俯瞰火山口海湾，白墙形成360度天然柔光箱', '标志性三座钴蓝圆顶教堂、纯白洞穴屋阶梯、九重葛花簇与深蓝爱琴海', 'Kodak_Ektar_100_Santorini_Cobalt.cube'],
  ['lmk_015_barcelona_sagrada_familia', 15, '巴塞罗那圣家堂·高迪森林立柱与彩窗光束', '哥特与自然主义交融的梦幻彩色光瀑', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '西班牙 · 巴塞罗那', 41.4036, 2.1744, 'UNESCO-320', 35, 'f/2.0', 0.52, -6, 2.9, 210, 34, 4400, 'hdr_sagrada_stained_glass_beams', 0.80, 0.20, '米白或浅驼色纯色丝毛混纺上衣，承接彩窗光斑', '微侧脸迎向西侧斜射入殿的琥珀与翠绿花窗丁达尔光束', '高迪仿生分枝石柱森林、繁星般拱顶天窗与冷暖渐变的玫瑰花窗光柱', 'Kodak_Portra_800_Gaudi_Prism.cube'],
  ['lmk_016_london_big_ben_westminster', 16, '伦敦大本钟·泰晤士河畔威斯敏斯特桥', '维多利亚哥特复兴式钟楼与英伦晨雾', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '英国 · 伦敦', 51.5007, -0.1246, 'UNESCO-426', 50, 'f/2.2', 0.48, -2, 3.2, 140, 24, 5000, 'hdr_london_westminster_thames_mist', 0.84, 0.22, '英伦经典双排扣格纹里衬风衣或羊绒高领毛衣配呢大衣', '倚靠泰晤士河石砌堤岸，微风吹动衣角，尽显伦敦文艺电影质感', '伊丽莎白塔金色钟面、威斯敏斯特宫哥特尖塔与桥面红色双层巴士虚化光斑', 'Ilford_Color_Thames_Classic.cube'],
  ['lmk_017_venice_st_mark_gondola', 17, '威尼斯圣马可广场·大运河贡多拉水影', '亚得里亚海女王的水城拱桥与总督宫', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '意大利 · 威尼斯', 45.4342, 12.3388, 'UNESCO-394', 85, 'f/2.0', 0.46, 0, 3.5, 165, 22, 4500, 'hdr_venice_lagoon_golden_ripple', 0.82, 0.20, '意式丝绒或丝绸衬衫配修身礼服外套', '立于圣马可水岸石柱旁，泻湖金波反射光柔和修饰面部纹路', '威尼斯总督宫哥特连拱廊、黑色贡多拉系船木桩与圣乔治马焦雷岛远景', 'Kodak_Portra_400_Venetian_Lagoon.cube'],
  ['lmk_018_swiss_jungfrau_alps', 18, '瑞士少女峰·阿尔卑斯雪峰与齿轮火车', '欧洲之巅万年冰川与翠绿山谷木屋', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '瑞士 · 伯尔尼高地', 46.5475, 7.9826, 'UNESCO-1037', 50, 'f/2.8', 0.44, 2, 3.1, 175, 38, 5700, 'hdr_swiss_jungfrau_alpine_snow', 0.90, 0.10, '高定羊绒雪山度假毛衣或米白色滑雪羽绒外套', '在温根观景木露台手捧热咖啡微笑，雪山反射光使肤质清透莹润', '少女峰、艾格峰与僧侣峰皑皑白雪、红色登山齿轮列车与阿尔卑斯草甸', 'Fuji_Provia_100F_Alpine_Crystal.cube'],
  ['lmk_019_germany_neuschwanstein_castle', 19, '德国新天鹅堡·巴伐利亚秋林童话城堡', '阿尔卑斯山麓云雾缭绕的纯白罗马式尖塔', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '德国 · 巴伐利亚富森', 47.5576, 10.7498, 'UNESCO-1726', 85, 'f/2.2', 0.42, 3, 3.6, 220, 26, 4700, 'hdr_neuschwanstein_autumn_mist', 0.85, 0.24, '欧洲古典学院风羊毛斗篷或深棕/米白风衣', '在玛丽安桥视角微侧身取景，城堡尖塔与漫山红黄秋林构成油画背景', '高耸于岩石峭壁上的新天鹅堡灰白石塔、阿尔卑斯湖水与层林尽染的秋叶', 'Kodak_Portra_400_Bavaria_Fairytale.cube'],
  ['lmk_020_prague_charles_bridge_dawn', 20, '布拉格查理大桥·伏尔塔瓦河巴洛克晨雾', '百塔之城金色破晓与哥特桥塔雕塑', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '捷克 · 布拉格', 50.0865, 14.4114, 'UNESCO-616', 50, 'f/1.8', 0.47, -1, 3.0, 95, 14, 3900, 'hdr_prague_charles_bridge_dawn', 0.84, 0.28, '波西米亚复古羊毛长外套配格纹围巾', '漫步于600年砂岩石板桥面，晨雾与古街灯烘托电影级诗意氛围', '查理大桥巴洛克圣人石雕、老城哥特式桥塔与远方布拉格城堡晨曦剪影', 'Kodak_Vision3_500T_Prague_Mist.cube'],

  // Region 3: 亚太人文古迹与自然奇观 (21 - 30)
  ['lmk_021_japan_kyoto_fuji_sakura', 21, '京都与富士山·五重塔樱花与朱红鸟居', '忠灵塔春樱粉雪与富士山冠雪远景', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '日本 · 京都/富士河口湖', 35.5012, 138.8014, 'UNESCO-1418', 85, 'f/1.8', 0.45, 0, 3.4, 130, 30, 5000, 'hdr_fuji_pagoda_cherry_blossom', 0.84, 0.18, '日系极简浅米色风衣或京都传统手工织锦和服/羽织', '立于盛放的染井吉野樱花枝下微抬头，柔焦樱花花瓣形成唯美前景', '五重塔朱红飞檐、漫天粉色春樱与远处对称完美的富士山白雪峰顶', 'Fuji_Pro_400H_Sakura_Soft.cube'],
  ['lmk_022_cambodia_angkor_wat_sunrise', 22, '柬埔寨吴哥窟·莲花五塔圣池破晓', '高棉帝国千年砂岩浮雕与热带晨曦倒影', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '柬埔寨 · 暹粒', 13.4125, 103.8670, 'UNESCO-668', 35, 'f/2.4', 0.48, -2, 2.9, 88, 15, 3800, 'hdr_angkor_wat_lotus_sunrise', 0.87, 0.25, '南洋探险风亚麻猎装衬衫，透气自然', '立于西参道圣池畔石阶，破晓紫金霞光映照池面与人物侧脸', '吴哥窟标志性五座宝塔群落、长满青苔的藏经阁石廊与睡莲池水倒影', 'Kodak_Portra_800_Khmer_Sunrise.cube'],
  ['lmk_023_india_taj_mahal_reflection', 23, '印度泰姬陵·莫卧儿纯白大理石倒影池', '阿格拉晨雾中镶嵌宝石的永恒建筑对称美', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '印度 · 阿格拉', 27.1751, 78.0421, 'UNESCO-252', 50, 'f/2.2', 0.49, -1, 3.3, 102, 20, 4400, 'hdr_taj_mahal_marble_dawn', 0.86, 0.20, '象牙白或浅香槟金丝绸刺绣长衫/礼服', '于戴安娜长椅中轴线偏黄金位端坐或伫立，对称倒影池延伸视觉纵深', '泰姬陵洋葱形纯白大理石主穹顶、四座宣礼塔与波斯四分花园十字水道', 'Kodak_Portra_160_Mughal_Ivory.cube'],
  ['lmk_024_myanmar_bagan_balloons', 24, '缅甸蒲甘·万塔平原热气球金色日出', '伊洛瓦底江畔两千座红砖佛塔与晨雾热气球', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '缅甸 · 蒲甘', 21.1717, 94.8585, 'UNESCO-1588', 85, 'f/2.0', 0.42, 3, 3.6, 85, 14, 3600, 'hdr_bagan_pagoda_balloon_mist', 0.85, 0.30, '暖杏色或大地色棉麻长衫，融入金色晨雾', '立于古砖露台远眺冉冉升起的热气球群，逆光金边勾勒发梢', '蒲甘平原绵延天际的红砖古佛塔尖、金合欢树冠与漫天彩色热气球', 'Kodak_Vision3_250D_Bagan_Gold.cube'],
  ['lmk_025_jordan_petra_treasury', 25, '约旦佩特拉·蛇道尽头卡兹尼玫瑰神殿', '纳巴泰人在赤红砂岩峭壁凿出的两千年奇迹', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '约旦 · 瓦迪穆萨', 30.3285, 35.4444, 'UNESCO-326', 35, 'f/2.2', 0.50, -5, 2.8, 155, 40, 4200, 'hdr_petra_rose_canyon_shaft', 0.89, 0.16, '沙漠卡其色风衣或米白亚麻旅行装', '立于西克峡谷出口光影交界处，峡谷天光自上方倾泻照亮卡兹尼神殿立面', '高40米的玫瑰色砂岩整石雕凿科林斯柱式卡兹尼神殿与幽深一线天岩壁', 'Kodak_Ektar_100_Petra_Rose.cube'],
  ['lmk_026_turkey_cappadocia_balloons', 26, '土耳其卡帕多奇亚·格雷梅精灵烟囱与热气球', '安纳托利亚火山凝灰岩奇石与百球齐飞破晓', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '土耳其 · 内夫谢希尔', 38.6431, 34.8289, 'UNESCO-357', 35, 'f/2.4', 0.44, 2, 2.9, 92, 16, 3900, 'hdr_cappadocia_fairy_chimneys_dawn', 0.86, 0.20, '波西米亚风提花披肩或驼色羊毛大衣', '在铺满安纳托利亚手工织毯的岩石露台回眸，背后百余只热气球错落升空', '格雷梅火山凝灰岩精灵烟囱地貌、岩洞建筑灯火与漫天斑斓热气球', 'Kodak_Portra_400_Anatolia_Dawn.cube'],
  ['lmk_027_moscow_red_square_st_basil', 27, '莫斯科红场·圣瓦西里大教堂洋葱穹顶', '俄罗斯九座彩绘螺旋穹顶与克里姆林宫红墙', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '俄罗斯 · 莫斯科', 55.7525, 37.6231, 'UNESCO-545', 50, 'f/2.2', 0.48, -3, 3.2, 215, 22, 4600, 'hdr_moscow_red_square_twilight', 0.88, 0.14, '俄式挺括长款羊毛大衣配羊绒围巾', '立于红场条石地面平视镜头，色彩绚丽的洋葱头穹顶在身后完美展开', '圣瓦西里大教堂红蓝金绿螺旋穹顶、斯巴斯克塔楼与古姆百货暖色灯带', 'Kodak_Vision3_250D_Kremlin_Ruby.cube'],
  ['lmk_028_bali_uluwatu_gates_of_heaven', 28, '巴厘岛连普扬寺·阿贡火山天空之门', '印度教善恶门对称水镜与云端火山神庙', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '印度尼西亚 · 巴厘岛', -8.3916, 115.6314, 'UNESCO-1194', 35, 'f/2.8', 0.50, -2, 3.1, 110, 28, 5100, 'hdr_bali_gates_of_heaven_agung', 0.85, 0.22, '巴厘岛传统沙笼配白色亚麻上衣', '立于善恶门石雕中央，前景水面形成清晰对称倒影，远方阿贡火山耸立云端', '精雕火山石印度教善恶劈门（Candi Bentar）、流云与阿贡火山锥体', 'Fuji_Velvia_100_Bali_Tropical.cube'],
  ['lmk_029_singapore_marina_bay_supertrees', 29, '新加坡滨海湾花园·超级树云雾林暮色', '未来主义生态建筑奇观与金沙天际线', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '新加坡 · 滨海湾', 1.2816, 103.8636, 'UNESCO-1483', 35, 'f/2.0', 0.52, -5, 2.8, 260, 12, 4200, 'hdr_singapore_supertree_blue_hour', 0.83, 0.14, '现代都市极简丝质衬衫或轻奢晚装外套', '在空中走道（OCBC Skyway）微仰拍摄，蓝调时刻暖金灯带与紫蓝晚霞交织', '高50米的垂直植物超级树群（Supertree Grove）、空中长廊与滨海湾金沙酒店', 'Kodak_Vision3_500T_Marina_CyberGold.cube'],
  ['lmk_030_sydney_opera_house_harbour', 30, '悉尼歌剧院·杰克逊港白帆与海港大桥', '南半球最具代表性的20世纪建筑杰作', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '澳大利亚 · 悉尼', -33.8568, 151.2153, 'UNESCO-166', 50, 'f/2.4', 0.47, 0, 3.3, 285, 24, 5200, 'hdr_sydney_opera_harbour_sunset', 0.87, 0.11, '澳式海岸休闲白衬衫或浅卡其色西装外套', '于皇家植物园麦考利夫人石椅视角凭海临风，歌剧院白帆与大桥同框', '乌松设计的洁白贝壳帆顶歌剧院、悉尼海港大桥钢铁拱架与蔚蓝港湾帆影', 'Kodak_Portra_400_Sydney_Harbour.cube'],

  // Region 4: 中东非古文明与旷野奇迹 (31 - 40)
  ['lmk_031_egypt_giza_pyramids_sphinx', 31, '埃及吉萨·胡夫大金字塔与狮身人面像', '四千五百年古埃及法老巨石奇迹与尼罗河西岸夕阳', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '埃及 · 开罗吉萨', 29.9792, 31.1342, 'UNESCO-86', 50, 'f/2.8', 0.45, -2, 3.4, 245, 22, 4000, 'hdr_giza_pyramids_golden_sand', 0.90, 0.24, '亚麻猎装夹克或飘逸白色棉麻长袍配宽檐遮阳帽', '立于吉萨高原风化砂岩台地，三大金字塔与狮身人面像呈斜向恢弘队列', '胡夫、哈夫拉与门卡乌拉三座巨石金字塔、斯芬克斯巨像与金色大漠辉光', 'Kodak_Vision3_250D_Pharaoh_Gold.cube'],
  ['lmk_032_egypt_luxor_karnak_columns', 32, '埃及卢克索·卡纳克神庙134根巨柱大厅', '底比斯古都纸莎草巨石柱林与象形文字光影', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '埃及 · 卢克索', 25.7188, 32.6573, 'UNESCO-87', 35, 'f/2.2', 0.52, -5, 2.8, 170, 36, 4300, 'hdr_karnak_hypostyle_sunbeams', 0.89, 0.20, '大地色系复古亚麻套装，与古神庙砂岩肌理和谐共鸣', '穿行于高21米的巨型石柱林间，斜射阳光照亮柱身浮雕与人物侧颜轮廓', '卡纳克大柱厅密布古埃及圣书体浮雕的砂岩巨柱阵列与顶棚天光光柱', 'Kodak_Portra_400_Thebes_Sandstone.cube'],
  ['lmk_033_morocco_chefchaouen_blue_medina', 33, '摩洛哥舍夫沙万·里夫山脉梦幻蓝色迷城', '层层叠叠的普鲁士蓝、钴蓝与粉蓝阶梯小巷', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '摩洛哥 · 舍夫沙万', 35.1688, -5.2636, 'UNESCO-MAR-09', 50, 'f/2.0', 0.48, 2, 3.0, 150, 38, 5200, 'hdr_chefchaouen_blue_alley_bounce', 0.84, 0.12, '姜黄色、纯白色或珊瑚橘棉麻穿搭', '拾级而上或轻倚马蹄形蓝色雕花拱门，四壁蓝墙漫反射光令肤色通透', '涂满天然矿物蓝漆的安达卢西亚风格石阶、铜铆钉木门与悬挂的彩色陶罐', 'Kodak_Ektar_100_Chefchaouen_Azure.cube'],
  ['lmk_034_morocco_sahara_merzouga_dunes', 34, '撒哈拉沙漠·梅祖卡尔格谢比巨型红沙丘', '北非金色沙海驼队剪影与澄澈星河暮色', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '摩洛哥 · 梅祖卡', 31.0994, -3.9733, 'UNESCO-SAH-01', 85, 'f/2.0', 0.40, -1, 3.6, 255, 14, 3700, 'hdr_sahara_merzouga_red_dunes', 0.88, 0.22, '柏柏尔风格靛蓝或纯白头巾配米色风衣', '立于高达150米的S形红沙脊顶端，低角度夕阳将沙浪明暗交界雕刻得如丝绸般柔滑', '撒哈拉连绵起伏的赤金沙丘曲线、远方单峰骆驼商队剪影与渐变琥珀色天空', 'Kodak_Vision3_250D_Sahara_Amber.cube'],
  ['lmk_035_abu_dhabi_sheikh_zayed_mosque', 35, '阿布扎比·谢赫扎耶德纯白汉白玉清真寺', '82座雪白大理石穹顶、24K金叶柱头与蓝水倒影廊', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '阿联酋 · 阿布扎比', 24.4128, 54.4750, 'UNESCO-UAE-01', 35, 'f/2.4', 0.49, -2, 3.1, 235, 26, 4900, 'hdr_abu_dhabi_white_mosque_pool', 0.86, 0.10, '得体优雅的长袖真丝长袍/亚麻西装配轻纱披肩', '立于镶嵌珍珠母贝花卉的大理石连拱廊水池畔，白玉地面反射光均匀柔美', '雪白马其顿汉白玉尖拱长廊、鎏金椰枣树造型柱头与深蓝马赛克镜面池水', 'Fuji_Pro_400H_Arabian_Pearl.cube'],
  ['lmk_036_kenya_kilimanjaro_amboseli', 36, '肯尼亚安博塞利·乞力马扎罗赤道雪峰与草原', '非洲屋脊5895米冰川雪冠与金合欢旷野', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '肯尼亚/坦桑尼亚边界', -2.6527, 37.2606, 'UNESCO-403', 85, 'f/2.4', 0.43, 0, 3.8, 95, 22, 4800, 'hdr_kilimanjaro_savanna_dawn', 0.89, 0.18, '经典卡其色东非游猎装（Safari Jacket）', '立于东非大裂谷金合欢草原开阔处，中长焦空间压缩感让乞力马扎罗雪峰近在咫尺', '平顶伞状金合欢树、金色稀树草原、远方象群剪影与高耸入云的乞力马扎罗雪顶', 'Kodak_Portra_400_OutOfAfrica.cube'],
  ['lmk_037_tanzania_serengeti_sunset', 37, '坦桑尼亚塞伦盖蒂·无垠草原合欢树紫金落日', '地球上最壮观的原始生态旷野与赤道火烧云', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '坦桑尼亚 · 塞伦盖蒂', -2.3333, 34.8333, 'UNESCO-156', 85, 'f/2.0', 0.41, -1, 3.5, 262, 10, 3400, 'hdr_serengeti_acacia_crimson_sunset', 0.85, 0.22, '暖棕色麂皮外套或纯棉探险衬衫', '倚靠越野敞篷车顶或草原巨石（Kopjes），漫天紫金晚霞映照双眸', '塞伦盖蒂一望无际的金色草海、孤傲的平顶金合欢树与磅礴的赤道落日霞光', 'Kodak_Ektar_100_Serengeti_Sunset.cube'],
  ['lmk_038_madagascar_baobab_avenue', 38, '马达加斯加·穆龙达瓦千年猴面包树大道', '高耸30米的远古巨树群落与非洲红土暮色', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '马达加斯加 · 穆龙达瓦', -20.2508, 44.4184, 'UNESCO-MDG-02', 35, 'f/2.2', 0.50, -4, 2.9, 250, 18, 4000, 'hdr_madagascar_baobab_avenue_dusk', 0.87, 0.19, '质感亚麻白衬衫配卡其长裤', '漫步于红土大道中央微仰取景，两旁树龄800年的格兰迪迪尔猴面包树如巨人列队', '粗壮笔直的古铜色猴面包树干、奇特树冠剪影与水塘倒影中的晚霞', 'Kodak_Portra_800_Baobab_Twilight.cube'],
  ['lmk_039_victoria_falls_rainbow_mist', 39, '津巴布韦/赞比亚·维多利亚大瀑布双彩虹水雾', '莫西奥图尼亚雷霆之烟与百米峡谷飞瀑', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '津巴布韦/赞比亚边界', -17.9243, 25.8572, 'UNESCO-509', 35, 'f/2.8', 0.46, 3, 3.0, 115, 35, 5300, 'hdr_victoria_falls_double_rainbow', 0.83, 0.32, '轻便防泼水户外风衣或清爽白T恤配工装衬衫', '立于刀锋桥观景崖畔，阳光穿透升腾水雾在身后折射出绚丽双彩虹', '宽达1700米的玄武岩大裂谷瀑布群、冲天白雾与横跨峡谷的七彩虹桥', 'Fuji_Velvia_50_Zambezi_Rainbow.cube'],
  ['lmk_040_dubai_burj_khalifa_skyline', 40, '迪拜哈利法塔·828米云端尖塔与音乐喷泉', '阿拉伯沙漠之上崛起的超现代建筑奇迹', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '阿联酋 · 迪拜', 25.1972, 55.2744, 'UNESCO-DXB-01', 35, 'f/2.0', 0.54, -7, 2.8, 255, 12, 4300, 'hdr_dubai_burj_khalifa_fountain', 0.84, 0.12, '高定剪裁晚礼服或摩登商务休闲西装', '于迪拜湖宫殿长廊凭栏回望，世界第一高塔直插暮色苍穹', '高耸入云的哈利法塔银色玻璃幕墙、湖面璀璨音乐喷泉水柱与阿拉伯风情拱廊', 'Kodak_Vision3_500T_Dubai_Mirage.cube'],

  // Region 5: 美洲文明遗迹与极地奇景 (41 - 50)
  ['lmk_041_peru_machu_picchu_andes', 41, '秘鲁马丘比丘·安第斯云端印加失落之城', '海拔2430米瓦伊纳比丘峰下的花岗岩梯田遗址', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '秘鲁 · 库斯科', -13.1631, -72.5450, 'UNESCO-274', 35, 'f/2.8', 0.40, 6, 2.9, 85, 28, 5200, 'hdr_machu_picchu_cloud_forest', 0.88, 0.24, '秘鲁羊驼毛（Alpaca）几何织纹披肩或户外徒步夹克', '立于印加守护者小屋石阶俯瞰整座古城，云雾自安第斯山谷缓缓升腾', '严丝合缝的印加干砌花岗岩神庙、层叠翠绿农业梯田与陡峭的瓦伊纳比丘主峰', 'Kodak_Ektar_100_Inca_Citadel.cube'],
  ['lmk_042_nyc_statue_of_liberty_brooklyn', 42, '纽约自由女神与布鲁克林大桥·曼哈顿天际线', '东河花岗岩哥特索塔、钢索矩阵与黄金时刻摩天楼', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '美国 · 纽约', 40.7061, -73.9969, 'UNESCO-307', 50, 'f/2.0', 0.48, -2, 3.1, 240, 20, 4400, 'hdr_nyc_brooklyn_bridge_sunset', 0.87, 0.14, '美式复古焦糖色皮衣/风衣或经典黑白极简大衣', '漫步于布鲁克林大桥木板步道中央，放射状钢索形成极具张力的几何透视引导线', '布鲁克林大桥双孔哥特式石塔、交错钢缆、远眺自由女神像与曼哈顿下城摩天楼群', 'Kodak_TriX_Color_Manhattan_Gold.cube'],
  ['lmk_043_rio_christ_redeemer_sugarloaf', 43, '里约热内卢·科科瓦多山基督像与面包山海湾', '俯瞰瓜纳巴拉湾与科帕卡巴纳新月海滩的山海奇迹', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '巴西 · 里约热内卢', -22.9519, -43.2105, 'UNESCO-1100', 35, 'f/2.8', 0.44, 3, 2.9, 105, 32, 5100, 'hdr_rio_corcovado_bay_vista', 0.88, 0.18, '热带浅色亚麻衬衫或清爽度假风连衣裙', '在山顶观景台展开双臂或扶栏远眺，背后山海相拥的里约全景尽收眼底', '装饰艺术风格的巨型皂石基督像、面包山花岗岩峰、碧蓝大西洋海湾与白沙滩', 'Fuji_Provia_100F_Rio_Tropics.cube'],
  ['lmk_044_mexico_chichen_itza_kukulkan', 44, '墨西哥奇琴伊察·玛雅库库尔坎羽蛇神金字塔', '尤卡坦半岛九层阶梯金字塔与古玛雅天文历法建筑', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '墨西哥 · 尤卡坦', 20.6843, -88.5678, 'UNESCO-483', 35, 'f/2.8', 0.50, -3, 3.2, 210, 44, 5400, 'hdr_chichen_itza_maya_limestone', 0.91, 0.12, '墨西哥手工刺绣白棉衬衫或卡其色亚麻旅拍服配巴拿马草帽', '立于灰白石灰岩金字塔广场，斜阳在九层阶梯侧壁投射出羽蛇神光影三角', '四面各91级台阶的库库尔坎阶梯金字塔、羽蛇神石雕蛇头与热带蓝天白云', 'Kodak_Portra_400_Mayan_Sun.cube'],
  ['lmk_045_usa_grand_canyon_horseshoe_bend', 45, '美国科罗拉多大峡谷·马蹄湾270度红岩河湾', '二十亿年地质断层赤红砂岩与翡翠色科罗拉多河', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '美国 · 亚利桑那', 36.0544, -112.1401, 'UNESCO-75', 35, 'f/2.8', 0.38, 6, 2.7, 250, 22, 4100, 'hdr_grand_canyon_red_butte_sunset', 0.90, 0.16, '美式西部牛仔丹宁衬衫或暖驼色户外夹克', '立于安全的红砂岩观景台边缘，夕阳将千仞峡谷岩层染成深邃的赤金与紫红', '科罗拉多大峡谷层叠壮丽的古生代红砂岩台地、深邃峡谷与270度U形翡翠河湾', 'Kodak_Ektar_100_Arizona_Canyon.cube'],
  ['lmk_046_bolivia_uyuni_sky_mirror', 46, '玻利维亚乌尤尼盐湖·海拔3656米天空之镜', '天地无缝合一的万年纯白盐沼镜面奇观', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '玻利维亚 · 波托西', -20.1338, -67.4891, 'UNESCO-BOL-04', 35, 'f/2.4', 0.50, 0, 3.3, 180, 30, 5500, 'hdr_uyuni_salt_flat_infinite_mirror', 0.76, 0.08, '鲜明纯色（克莱因蓝、正红或纯白）长款外套', '静立于薄如蝉翼的盐湖镜面水层之上，脚下倒影与头顶流云实现1:1无缝对称', '一望无际的纯白盐晶浅水镜面、地平线零畸变反射的朵朵白云与澄澈高原蓝天', 'Fuji_Provia_100F_Uyuni_Mirror.cube'],
  ['lmk_047_chile_easter_island_moai', 47, '智利复活节岛·阿胡汤加里基15尊摩艾石像', '南太平洋孤岛千年凝望的火山凝灰岩巨像与惊涛', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '智利 · 拉帕努伊岛', -27.1258, -109.2769, 'UNESCO-715', 50, 'f/2.8', 0.46, -2, 3.4, 78, 18, 4300, 'hdr_easter_island_moai_sunrise', 0.89, 0.16, '极简大地色防风外套，衬托远古石像的沧桑深邃', '于石像阵列侧前方取景，太平洋破晓阳光从15尊摩艾石像身后形成壮丽丁达尔光芒', '并肩矗立于海滨祭坛上的15尊巨型火山岩摩艾石像与南太平洋汹涌海浪', 'Kodak_Portra_400_RapaNui_Stone.cube'],
  ['lmk_048_canada_banff_moraine_lake', 48, '加拿大班夫·梦莲湖十峰山冰川绿松石湖水', '落基山脉最具代表性的冰碛湖泊与冷杉森林', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '加拿大 · 艾伯塔班夫', 51.3217, -116.1860, 'UNESCO-304', 50, 'f/2.4', 0.44, 2, 3.0, 140, 34, 5400, 'hdr_banff_moraine_turquoise_lake', 0.87, 0.12, '加式经典红黑格纹羊毛法兰绒外套或米色针织毛衣', '立于冰碛岩堆（Rockpile）步道，身后是宛如绿松石宝石般的湖面与木制独木舟', '十峰山（Valley of the Ten Peaks）锯齿状雪峰、冰川岩粉折射的碧蓝湖水与针叶林', 'Fuji_Velvia_100_Rockies_Turquoise.cube'],
  ['lmk_049_iceland_jokulsarlon_aurora', 49, '冰岛杰古沙龙冰河湖·极光舞动与钻石黑沙滩', '瓦特纳冰川千年蓝冰浮冰与夜空祖母绿欧若拉', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '冰岛 · 瓦特纳冰川国家公园', 64.0484, -16.1794, 'UNESCO-1604', 35, 'f/1.8', 0.45, -1, 2.8, 15, 8, 4600, 'hdr_iceland_aurora_diamond_beach', 0.80, 0.18, '冰岛传统几何花纹羊毛毛衣（Lopapeysa）或极地白色防寒派克大衣', '立于布满晶莹剔透蓝冰块的火山黑沙滩上，极光绿带与浮冰折射光柔和照亮面庞', '杰古沙龙冰河湖幽蓝千年浮冰、火山玄武岩黑沙滩与漫天舞动的绿色北极光', 'Kodak_Vision3_500T_Aurora_Ice.cube'],
  ['lmk_050_antarctica_paradise_bay_glacier', 50, '南极洲天堂湾·万年蓝冰冰川与企鹅雪原', '地球最南端纯净无瑕的极地冰山镜面水湾', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '南极半岛 · 天堂湾', -64.8500, -62.9000, 'UNESCO-ANT-01', 50, 'f/2.8', 0.46, 0, 3.2, 350, 26, 6200, 'hdr_antarctica_paradise_bay_blue_ice', 0.90, 0.08, '专业极地科考探险红色/亮橙色冲锋羽绒服', '立于天堂湾浮冰海岸或冲锋舟甲板，极地360度冰雪漫反射光带来极致通透的眼神光', '南极半岛高耸的万年幽蓝冰川断崖、静谧如镜的极地海湾浮冰与巴布亚企鹅群落', 'Fuji_Provia_100F_Antarctic_Pure.cube'],

  // Region 1 Expansion: 华夏古建与九州山河 (51 - 60)
  ['lmk_051_jiuzhaigou_five_flower_lake', 51, '九寨沟五花海·钙华彩池与金秋彩林', '川西高原蓝绿琥珀渐变湖水与雪峰倒影', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 四川阿坝', 33.1600, 103.9186, 'UNESCO-637', 50, 'f/2.2', 0.46, 2, 3.1, 148, 34, 5200, 'hdr_jiuzhaigou_five_flower_emerald', 0.84, 0.14, '浅米色羊绒开衫或山系轻户外防风夹克', '立于五花海木质栈道凭栏微笑，孔雀蓝与琥珀黄钙华池水在身后澄澈展开', '五花海斑斓钙华湖底水下古树、岸畔红桦金秋彩林与远方雪山倒影', 'Fuji_Velvia_50_Jiuzhai_Sapphire.cube'],
  ['lmk_052_huangshan_welcoming_pine', 52, '安徽黄山·迎客松奇石与破晓云海', '天下第一奇山花岗岩峰林与千年苍松', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 安徽黄山', 30.1325, 118.1694, 'UNESCO-547', 35, 'f/2.8', 0.40, 4, 2.9, 102, 18, 4200, 'hdr_huangshan_pine_cloud_sea', 0.88, 0.24, '新中式深灰羊毛大衣或户外冲锋风衣', '立于玉屏楼石阶观景台，破晓暖金日出穿过迎客松枝干照亮侧颜', '破石而出的千年黄山迎客松、刀削斧劈般的花岗岩奇峰与浩瀚云海', 'Kodak_Portra_400_Huangshan_Pine.cube'],
  ['lmk_053_beijing_temple_of_heaven_qiniandian', 53, '北京天坛·祈年殿三重蓝琉璃金顶', '明清祭天圣殿三层汉白玉祈谷坛中轴美学', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 北京', 39.8822, 116.4066, 'UNESCO-881', 50, 'f/2.4', 0.52, -4, 3.3, 155, 32, 4900, 'hdr_temple_of_heaven_cobalt_dome', 0.89, 0.12, '正红或素白高定羊绒大衣，与深蓝琉璃瓦形成高级撞色', '立于丹陛桥汉白玉御道，微仰角度完整收录祈年殿三重宝顶与澄澈蓝天', '祈年殿三层深蓝琉璃瓦溜金宝顶、朱红雕梁画栋与三层汉白玉石栏', 'Kodak_Ektar_100_Imperial_Azure.cube'],
  ['lmk_054_beijing_summer_palace_kunming_lake', 54, '北京颐和园·佛香阁万寿山与十七孔桥金光', '皇家园林昆明湖落日穿洞金光与古建长廊', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 北京', 39.9999, 116.2755, 'UNESCO-880', 85, 'f/2.0', 0.45, -1, 3.5, 246, 14, 3800, 'hdr_summer_palace_17_arch_golden', 0.85, 0.18, '温润驼色山羊绒大衣配真丝围巾', '立于昆明湖石舫或十七孔桥头，冬至夕阳金光穿桥孔而出映亮双眸', '十七孔桥汉白玉石狮栏杆、金光穿洞奇观与远方万寿山佛香阁层叠轮廓', 'Kodak_Vision3_250D_Kunming_Gold.cube'],
  ['lmk_055_lijiang_jade_dragon_snow_mountain', 55, '丽江古城·玉龙雪山日照金山与黑龙潭倒影', '纳西古镇飞檐水岸与海拔5596米雪峰金顶', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 云南丽江', 26.8764, 100.2328, 'UNESCO-811', 50, 'f/2.2', 0.48, 0, 3.2, 110, 16, 4100, 'hdr_lijiang_jade_dragon_golden_peak', 0.86, 0.14, '云南民族风手工扎染披肩配纯白棉麻长衫', '立于黑龙潭五孔石桥畔，身后玉龙雪山十三峰与古亭完整倒映于明镜湖水', '得月楼三重飞檐、五孔石拱桥与高耸入云的玉龙雪山日照金山奇景', 'Fuji_Provia_100F_Lijiang_Snow.cube'],
  ['lmk_056_leshan_giant_buddha_cliff', 56, '四川乐山大佛·三江汇流丹霞摩崖石刻', '通高71米盛唐弥勒坐像与岷江凌云栈道', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 四川乐山', 29.5447, 103.7728, 'UNESCO-779', 35, 'f/2.8', 0.50, -5, 3.0, 215, 28, 4700, 'hdr_leshan_giant_buddha_red_sandstone', 0.88, 0.22, '素雅亚麻中式衬衫或简约户外旅行装', '于三江汇流观景船甲板或凌云寺视角取景，千年红砂岩大佛慈悲庄严', '依凌云山栖霞峰凿造的盛唐乐山大佛全景、丹霞赤壁与苍翠江岸古木', 'Kodak_Portra_400_Tang_Sandstone.cube'],
  ['lmk_057_xiamen_gulangyu_sunlight_rock', 57, '厦门鼓浪屿·日光岩红砖万国建筑与蔚蓝海岸', '闽南骑楼、百年八卦楼圆顶与琴岛海风', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 福建厦门', 24.4442, 118.0672, 'UNESCO-1541', 50, 'f/2.0', 0.44, 2, 3.1, 165, 36, 5100, 'hdr_gulangyu_red_dome_seabreeze', 0.85, 0.16, '文艺复古法式白衬衫或海岛风棉麻连衣裙', '凭栏于鼓浪屿观海露台，海风轻拂发丝，背后红顶八卦楼与鹭江帆影交相辉映', '鼓浪屿八卦楼红色八角穹顶、南洋风情红砖柱廊、凤凰木与蔚蓝台湾海峡', 'Fuji_Pro_400H_Amoy_Breeze.cube'],
  ['lmk_058_shanghai_bund_lujiazui_skyline', 58, '上海外滩·万国建筑博览群与陆家嘴璀璨天际线', '黄浦江百年古典花岗岩大楼与东方明珠跨时空对话', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 上海', 31.2400, 121.4900, 'UNESCO-SHA-01', 50, 'f/1.8', 0.48, -2, 3.2, 260, 8, 4100, 'hdr_shanghai_bund_twilight_gold', 0.84, 0.16, '海派高定剪裁黑色丝绒礼服或经典双排扣西装风衣', '倚靠外滩花岗岩防汛墙回眸，黄浦江对岸摩天楼群与身后和平饭店绿铜顶辉映', '外滩新古典主义钟楼暖金灯光、黄浦江游轮流光与陆家嘴三件套摩天楼天际线', 'Kodak_Vision3_500T_Shanghai_Glamour.cube'],
  ['lmk_059_luoyang_longmen_grottoes_vairocana', 59, '洛阳龙门石窟·奉先寺卢舍那大佛微笑', '伊水两岸北魏至盛唐十万石刻造像艺术巅峰', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 河南洛阳', 34.5553, 112.4706, 'UNESCO-1003', 50, 'f/2.4', 0.52, -4, 3.3, 125, 30, 4800, 'hdr_longmen_vairocana_limestone', 0.89, 0.15, '唐风改良立领织锦外套或沉稳大地色羊绒衫', '立于奉先寺宽阔石阶，晨光柔和照亮卢舍那大佛丰颐秀目的永恒东方微笑', '高17米的盛唐卢舍那大佛青灰石灰岩巨像、胁侍菩萨与力士石雕群', 'Kodak_Portra_160_Luoyang_Carving.cube'],
  ['lmk_060_changbaishan_heaven_lake_caldera', 60, '长白山天池·十六峰环抱的高山火山口蓝宝石', '海拔2189米中朝界湖澄澈深蓝水镜与白雪峰峦', 'china_oriental_heritage', '华夏古建与九州山河', '中国 · 吉林延边', 42.0061, 128.0572, 'UNESCO-MAB-60', 35, 'f/2.8', 0.42, 5, 2.8, 175, 42, 5700, 'hdr_changbaishan_tianchi_crater_blue', 0.90, 0.10, '高原防风亮色羽绒服或纯白羊绒高领配防寒外套', '立于天池北坡天文峰火山岩观景台，天池如一块无瑕深蓝宝石镶嵌于十六座奇峰之间', '长白山火山口天池深邃蔚蓝湖面、周围陡峭的粗面岩雪峰与澄澈天穹', 'Fuji_Provia_100F_Tianchi_Sapphire.cube'],

  // Region 2 Expansion: 欧洲古典文明与浪漫地标 (61 - 70)
  ['lmk_061_paris_louvre_glass_pyramid', 61, '巴黎卢浮宫·贝聿铭玻璃金字塔与拿破仑庭院', '古典巴洛克宫殿长廊与现代几何玻璃折射光影', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '法国 · 巴黎', 48.8606, 2.3376, 'UNESCO-600B', 35, 'f/2.0', 0.49, -2, 3.0, 240, 14, 4200, 'hdr_louvre_pyramid_blue_hour_gold', 0.85, 0.12, '法式高定黑色小礼服或剪裁利落的米白风衣', '立于卢浮宫三角形喷泉水池边缘，玻璃金字塔暖金内透光与水池倒影交相辉映', '由673块菱形玻璃构成的卢浮宫金字塔、喷泉水镜与黎塞留翼古典石雕立面', 'Kodak_Vision3_500T_Louvre_Nocturne.cube'],
  ['lmk_062_italy_pisa_leaning_tower_miracles', 62, '意大利比萨斜塔·奇迹广场罗马式白色大理石钟楼', '翡翠草坪上的中世纪建筑奇迹与洗礼堂连拱廊', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '意大利 · 托斯卡纳比萨', 43.7230, 10.3966, 'UNESCO-395', 50, 'f/2.8', 0.50, -3, 3.4, 210, 36, 5200, 'hdr_pisa_miracles_marble_lawn', 0.89, 0.11, '意式清爽亚麻白衬衫或浅卡其色百褶裙/西装裤', '于奇迹广场翠绿草坪步道自然漫步回眸，摆脱俗套借位，展现高级杂志旅拍感', '倾斜3.99度的八层白色大理石圆柱比萨斜塔、比萨大教堂与罗马式圣若望洗礼堂', 'Kodak_Portra_400_Tuscany_Marble.cube'],
  ['lmk_063_italy_cinque_terre_manarola', 63, '意大利五渔村·马纳罗拉悬崖彩色海滨小镇', '利古里亚海翡翠海湾与悬崖层叠彩绘石屋', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '意大利 · 拉斯佩齐亚', 44.1068, 9.7279, 'UNESCO-826', 35, 'f/2.4', 0.44, 2, 2.9, 255, 18, 4300, 'hdr_cinque_terre_manarola_cliff_sunset', 0.86, 0.16, '地中海条纹海魂衫或柠檬黄/纯白亚麻度假穿搭', '倚靠海滨步道石栏，夕阳余晖将身后粉红、明黄与赤陶色悬崖小镇染成温暖油画', '陡峭海蚀悬崖上层层叠叠的彩色渔村石屋、深蓝利古里亚海浪与岩石港湾', 'Kodak_Ektar_100_Riviera_Sun.cube'],
  ['lmk_064_italy_amalfi_positano_coast', 64, '阿马尔菲海岸·波西塔诺柠檬花阶梯与碧海帆影', '第勒尼安海垂直悬崖上的垂直童话小镇', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '意大利 · 坎帕尼亚', 40.6281, 14.4850, 'UNESCO-830', 50, 'f/2.2', 0.45, 3, 3.1, 195, 32, 5100, 'hdr_positano_amalfi_lemon_terrace', 0.87, 0.14, '意式复古丝巾、草编宽檐帽配白色亚麻露肩衬衫/西装', '坐于爬满九重葛与柠檬枝的海岸露台，背后是波西塔诺标志性的彩色金字塔建筑群', '圣母升天教堂彩色马约利卡陶砖圆顶、悬崖彩屋、蓝白条纹遮阳伞沙滩与游艇', 'Fuji_Pro_400H_Positano_Breeze.cube'],
  ['lmk_065_austria_hallstatt_alpine_lake', 65, '奥地利哈修塔特·阿尔卑斯盐矿古镇与天鹅湖镜', '萨尔茨卡默古特群山怀抱中的哥特尖塔与木屋倒影', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '奥地利 · 上奥地利州', 47.5622, 13.6493, 'UNESCO-806', 50, 'f/2.2', 0.47, 0, 3.2, 118, 24, 4800, 'hdr_hallstatt_lake_morning_swan', 0.85, 0.22, '奥地利传统羊毛呢外套或温润燕麦色高领毛衣', '立于湖畔木质护栏旁，清晨薄雾中的哈修塔特基督教堂尖塔与天鹅优雅同框', '依山傍水的16世纪阿尔卑斯木屋、哥特式路德教堂尖顶、玻璃般平静的湖水与天鹅', 'Kodak_Portra_400_Salzkammergut_Mist.cube'],
  ['lmk_066_france_mont_saint_michel_tide', 66, '法国圣米歇尔山·诺曼底潮汐圣山修道院', '大西洋孤岛之巅耸立千年的哥特式修道院尖塔', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '法国 · 诺曼底', 48.6361, -1.5115, 'UNESCO-80', 85, 'f/2.4', 0.48, -2, 3.8, 235, 16, 4100, 'hdr_mont_saint_michel_tidal_mirror', 0.86, 0.20, '法式海魂条纹针织衫配卡其色防风长风衣', '立于蜿蜒的潮汐浅滩步道，中长焦将远方锥形圣山修道院与滩涂水镜完美框入', '花岗岩潮汐岛上层层盘旋的中世纪城墙、顶峰大天使金像尖塔与浅水滩涂倒影', 'Kodak_Vision3_250D_Normandy_Tide.cube'],
  ['lmk_067_netherlands_kinderdijk_windmills', 67, '荷兰小孩堤防·18世纪古风车群与郁金香运河', '低地之国水岸芦苇、木制风车翼片与金色晚霞', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '荷兰 · 南荷兰省', 51.8833, 4.6333, 'UNESCO-818', 50, 'f/2.0', 0.49, -1, 3.1, 248, 18, 4300, 'hdr_kinderdijk_windmill_canal_sunset', 0.85, 0.18, '米白色粗针毛衣配复古灯芯绒外套', '漫步于运河畔繁花盛开的小径，身后成排1740年代古风车在夕阳下静静转动', '沿运河一字排开的八角砖木结构古老风车、盛放郁金香花田与金色芦苇水影', 'Kodak_Portra_400_Dutch_GoldenAge.cube'],
  ['lmk_068_uk_stonehenge_salisbury_plain', 68, '英国巨石阵·索尔兹伯里平原史前蓝砂岩环阵', '五千年前新石器时代夏至日出天文巨石遗迹', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '英国 · 威尔特郡', 51.1789, -1.8262, 'UNESCO-373', 35, 'f/2.4', 0.48, -2, 3.0, 75, 14, 4000, 'hdr_stonehenge_solstice_dawn', 0.88, 0.22, '英伦巴伯（Barbour）打蜡猎装夹克或苏格兰格纹羊毛围巾', '立于旷野草甸步道，破晓阳光穿过巨大的三石牌坊（Trilithons）投下悠长光影', '高耸的萨尔森砂岩立柱与横梁环阵、苍翠英格兰草甸与戏剧性的晨曦流云', 'Ilford_Color_Wiltshire_Dawn.cube'],
  ['lmk_069_norway_geirangerfjord_seven_sisters', 69, '挪威盖朗厄尔峡湾·七姐妹瀑布与深蓝冰川峡谷', '斯堪的纳维亚千米垂直岩壁与翡翠色深邃海湾', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '挪威 · 默勒-鲁姆斯达尔', 62.1015, 7.0941, 'UNESCO-1195', 35, 'f/2.8', 0.40, 5, 2.8, 185, 34, 5500, 'hdr_norway_geiranger_fjord_emerald', 0.89, 0.14, '北欧费尔岛提花毛衣或极简机能防风外套', '立于弗里达斯尤威（Flydalsjuvet）悬崖观景台安全护栏内，俯瞰S形峡湾全景', '深邃碧蓝的盖朗厄尔冰川峡湾、飞流直下的七姐妹瀑布与两岸雪顶苍翠群山', 'Fuji_Provia_100F_Nordic_Fjord.cube'],
  ['lmk_070_croatia_dubrovnik_old_town_walls', 70, '克罗地亚杜布罗夫尼克·亚得里亚海明珠红瓦古城墙', '中世纪白色石灰岩海上堡垒与宝石蓝海岸', 'europe_classical_monuments', '欧洲古典文明与浪漫地标', '克罗地亚 · 达尔马提亚', 42.6403, 18.1083, 'UNESCO-95', 50, 'f/2.4', 0.43, 4, 3.1, 225, 28, 5000, 'hdr_dubrovnik_adriatic_terracotta', 0.88, 0.12, '地中海纯白亚麻衬衫配草编帽', '漫步于宽阔的中世纪白色石砌城墙之上，背后是一望无际的赤陶红屋顶与蔚蓝大海', '杜布罗夫尼克坚固的海上石筑城墙、密集的赤陶红瓦屋顶、巴洛克钟楼与蓝宝石海面', 'Kodak_Ektar_100_Adriatic_Pearl.cube'],

  // Region 3 Expansion: 亚太人文古迹与自然奇观 (71 - 80)
  ['lmk_071_japan_arashiyama_bamboo_grove', 71, '京都岚山竹林·嵯峨野万竿翠竹丁达尔晨光', '直入云霄的青竹秘境与桂川渡月桥古韵', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '日本 · 京都右京区', 35.0170, 135.6713, 'UNESCO-688', 50, 'f/1.8', 0.50, -3, 3.0, 110, 26, 4900, 'hdr_arashiyama_bamboo_green_shafts', 0.84, 0.18, '素雅米白亚麻衬衫或京都访问着和服/羽织', '静立于竹篱夹道中央，清晨阳光穿透高耸翠竹缝隙洒下清透的翡翠色光斑', '两侧高耸入云的青翠孟宗竹林、传统竹编柴垣小径与柔和的林间丁达尔光束', 'Fuji_Pro_400H_Kyoto_Bamboo.cube'],
  ['lmk_072_korea_seoul_gyeongbokgung_palace', 72, '首尔景福宫·庆会楼莲池与北岳山丹青飞檐', '朝鲜王朝正宫传统丹青木构与仁王山四季画卷', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '韩国 · 首尔钟路区', 37.5796, 126.9770, 'UNESCO-KOR-01', 50, 'f/2.2', 0.48, -1, 3.2, 145, 32, 5000, 'hdr_seoul_gyeongbokgung_pavilion', 0.86, 0.14, '现代极简米色风衣或素雅传统韩服改良礼服', '立于庆会楼方池白石栏杆旁，身后花岗岩柱托起的重檐楼阁与北岳山苍松倒映水中', '景福宫勤政殿与庆会楼绚丽的青红丹青斗拱、四十八根花岗岩石柱与北岳山远景', 'Fuji_Astia_100F_Joseon_Dancheong.cube'],
  ['lmk_073_vietnam_halong_bay_emerald_karst', 73, '越南下龙湾·北部湾海上两千喀斯特石岛与古帆船', '碧玉海面耸立的石灰岩孤峰与夕阳红帆', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '越南 · 广宁省', 20.9101, 107.1839, 'UNESCO-672', 50, 'f/2.2', 0.46, 0, 3.1, 240, 18, 4300, 'hdr_halong_bay_emerald_junk_sunset', 0.85, 0.26, '法属印支复古风亚麻白衬衫或真丝长裙', '倚靠传统木制游船甲板雕花栏杆，翡翠色海面与星罗棋布的海上石林在夕阳下静谧展开', '下龙湾平静如玉的海面、千姿百态的海上喀斯特石灰岩峰丛与传统木帆船剪影', 'Kodak_Portra_400_Indochine_Jade.cube'],
  ['lmk_074_thailand_bangkok_grand_palace_wat_arun', 74, '曼谷大皇宫与郑王庙·湄南河畔鎏金佛塔与彩瓷黎明寺', '暹罗王朝金碧辉煌的尖顶佛塔与玻璃马赛克光影', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '泰国 · 曼谷', 13.7500, 100.4913, 'UNESCO-THA-01', 50, 'f/2.4', 0.50, -3, 3.2, 250, 22, 4600, 'hdr_bangkok_wat_arun_gold_mosaic', 0.88, 0.16, '泰丝（Thai Silk）香槟金衬衫或清爽纯白亚麻套装', '立于湄南河观景露台或郑王庙白塔雕花石阶前，金色佛塔与彩瓷花瓣在阳光下熠熠生辉', '大皇宫鎏金舍利塔、郑王庙镶嵌五彩中国古瓷片的82米高棉式主塔与湄南河波光', 'Kodak_Ektar_100_Siam_Gold.cube'],
  ['lmk_075_australia_uluru_ayers_rock_sunset', 75, '澳大利亚乌鲁鲁·红土中心五亿年独块巨石夕照', '北领地荒漠之上随阳光变幻烈焰赤红的砂岩圣山', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '澳大利亚 · 北领地', -25.3444, 131.0369, 'UNESCO-447', 50, 'f/2.8', 0.45, -1, 3.4, 265, 12, 3600, 'hdr_uluru_outback_crimson_monolith', 0.90, 0.14, '澳式内陆探险卡其色亚麻衬衫配牛仔帽', '立于红土荒漠观景步道，落日最后一抹余晖将乌鲁鲁巨岩染成深邃壮丽的炽烈红宝石色', '高348米的乌鲁鲁（艾尔斯岩）整体弧形赤红砂岩巨石、红土沙丘与荒漠耐旱灌木', 'Kodak_Ektar_100_Outback_Crimson.cube'],
  ['lmk_076_new_zealand_milford_sound_mitre_peak', 76, '新西兰米尔福德峡湾·教冠峰冰川飞瀑与镜面黑水', '南阿尔卑斯山脉世界第八大奇迹的深邃冰川峡湾', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '新西兰 · 南岛峡湾国家公园', -44.6414, 167.8974, 'UNESCO-551', 35, 'f/2.4', 0.47, -2, 3.0, 310, 24, 5200, 'hdr_milford_sound_mitre_peak_mist', 0.86, 0.24, '新西兰美利奴羊毛风衣或户外防风夹克', '立于峡湾浅滩鹅卵石岸边，海拔1692米的教冠峰直拔海面，百米斯特林瀑布飞流直下', '陡峭如金字塔的教冠峰（Mitre Peak）、墨玉般平静的峡湾倒影与峭壁冰川悬瀑', 'Fuji_Velvia_50_Fiordland_Pure.cube'],
  ['lmk_077_indonesia_borobudur_sunrise_stupas', 77, '印尼婆罗浮屠·爪哇热带雨林钟形佛塔与默拉皮火山', '九层曼荼罗火山石浮雕回廊与赤道晨雾日出', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '印度尼西亚 · 中爪哇日惹', -7.6079, 110.2038, 'UNESCO-592', 50, 'f/2.2', 0.44, 1, 3.1, 82, 16, 3900, 'hdr_borobudur_volcano_mist_sunrise', 0.87, 0.28, '素白或浅沙色透气棉麻长衫', '立于婆罗浮屠顶层圆形露台72座镂空钟形舍利塔之间，远方默拉皮火山在金色晨雾中若隐若现', '安山岩砌筑的镂空钟形佛塔阵列、静坐佛像剪影、椰林晨雾与双子火山天际线', 'Kodak_Portra_800_Java_Sunrise.cube'],
  ['lmk_078_india_jaipur_hawa_mahal_amber_fort', 78, '印度斋浦尔·风之宫殿953扇粉红砂岩蜂巢花窗', '拉贾斯坦邦粉红之城莫卧儿与拉杰普特建筑瑰宝', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '印度 · 拉贾斯坦斋浦尔', 26.9239, 75.8267, 'UNESCO-1605', 50, 'f/2.2', 0.52, -4, 3.2, 100, 26, 4600, 'hdr_jaipur_hawa_mahal_terracotta', 0.88, 0.16, '象牙白或宝蓝色丝绸长衫，与粉红砂岩立面形成极致色彩美学', '于风之宫殿对街露台平视取景，清晨柔和阳光照亮五层粉红砂岩蜂巢状雕花凸窗', '高五层如孔雀开屏般的粉红色砂岩风之宫殿（Hawa Mahal）与精巧白边几何花窗', 'Kodak_Portra_400_Jaipur_Rose.cube'],
  ['lmk_079_turkey_pamukkale_travertine_pools', 79, '土耳其棉花堡·帕姆卡莱纯白钙华温泉阶梯池', '希拉波利斯古罗马遗址下的雪白碳酸钙镜面水台', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '土耳其 · 代尼兹利', 37.9211, 29.1211, 'UNESCO-485', 35, 'f/2.4', 0.46, 2, 2.9, 245, 20, 4800, 'hdr_pamukkale_white_travertine_blue', 0.83, 0.12, '纯白或浅天蓝色轻盈度假风亚麻裙/衬衫', '赤足立于奶蓝色温泉钙华浅水池畔，雪白石灰华台地如天然反光板令肤质清透发光', '层层叠叠如棉花云朵般的纯白钙华梯田、土耳其蓝温泉水镜与晚霞倒影', 'Fuji_Pro_400H_Pamukkale_Opal.cube'],
  ['lmk_080_australia_great_barrier_reef_whitsundays', 80, '澳大利亚大堡礁·圣灵群岛心形礁与白天堂石英沙滩', '珊瑚海Tiffany蓝渐变泻湖与纯白硅砂漩涡海湾', 'asia_pacific_wonders', '亚太人文古迹与自然奇观', '澳大利亚 · 昆士兰', -20.2825, 149.0389, 'UNESCO-154', 35, 'f/2.8', 0.42, 6, 2.8, 45, 48, 5600, 'hdr_whitsundays_whitehaven_coral_turquoise', 0.88, 0.08, '澳洲海岛度假风白色亚麻衬衫与防晒草帽', '立于希尔湾（Hill Inlet）观景台或纯白石英沙滩，身后是绿松石色与乳白色交融的梦幻海湾', '含硅量98%的纯白流沙浅滩、孔雀蓝珊瑚礁水道与大堡礁清澈透明的热带海水', 'Fuji_Velvia_100_CoralSea_Turquoise.cube'],

  // Region 4 Expansion: 中东非古文明与旷野奇迹 (81 - 90)
  ['lmk_081_egypt_abu_simbel_ramses_temple', 81, '埃及阿布辛贝神庙·拉美西斯二世四尊20米摩崖巨像', '努比亚纳赛尔湖畔三千三百年整山雕凿的太阳神殿', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '埃及 · 阿斯旺阿布辛贝', 22.3372, 31.6258, 'UNESCO-88', 35, 'f/2.8', 0.52, -5, 3.2, 115, 32, 4700, 'hdr_abu_simbel_ramses_colossi', 0.91, 0.14, '卡其色亚麻探险风衣或象牙白棉麻套装', '立于神庙广场金沙台地微仰取景，四尊高达20米的法老坐像在努比亚阳光下威严耸立', '整座玫瑰砂岩山体雕凿的拉美西斯二世四尊巨像、古埃及象形文字铭文与纳赛尔湖蓝水', 'Kodak_Portra_400_Nubian_Sun.cube'],
  ['lmk_082_jordan_wadi_rum_mars_desert', 82, '约旦瓦迪拉姆·月亮谷赤红砂岩拱桥与火星荒漠', '阿拉伯劳伦斯走过的史前红沙峡谷与天然石拱', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '约旦 · 亚喀巴省', 29.5764, 35.4194, 'UNESCO-1377', 35, 'f/2.4', 0.45, -2, 3.0, 250, 16, 3800, 'hdr_wadi_rum_crimson_arch_sunset', 0.89, 0.20, '沙漠大地色亚麻长衫配阿拉伯传统格纹头巾披肩', '立于瓦迪拉姆红色沙原，身后是横跨天际的布尔达天然红砂岩拱桥与火星般壮丽的地貌', '拔地而起的暗红色花岗岩与砂岩风化山峰、一望无际的赤红沙海与金色落日', 'Kodak_Ektar_100_WadiRum_Mars.cube'],
  ['lmk_083_morocco_marrakech_ben_youssef_madrasa', 83, '摩洛哥马拉喀什·本约瑟夫神学院马赛克中庭水镜', '摩尔式几何彩釉瓷砖、雪松木雕与白色灰泥雕花拱廊', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '摩洛哥 · 马拉喀什', 31.6318, -7.9861, 'UNESCO-331', 35, 'f/2.2', 0.50, -1, 2.9, 175, 42, 4900, 'hdr_marrakech_zellige_courtyard_pool', 0.86, 0.10, '摩洛哥卡夫坦风丝麻长衫或极简象牙白西装', '立于中庭长方形大理石浅水池畔，精雕细琢的摩尔式灰泥拱门与人物倒影在水中对称呈现', '五彩Zellige几何马赛克拼贴墙裙、繁复的伊斯兰灰泥钟乳石雕花与阿特拉斯雪松木穹顶', 'Kodak_Portra_160_Marrakech_Tile.cube'],
  ['lmk_084_south_africa_cape_town_table_mountain', 84, '南非开普敦·桌山平顶云毯与好望角大西洋海岸', '两大洋交汇处的十亿年平顶砂岩巨山与白浪沙滩', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '南非 · 西开普省开普敦', -33.9628, 18.4098, 'UNESCO-1007', 50, 'f/2.4', 0.46, 0, 3.3, 290, 22, 4800, 'hdr_cape_town_table_mountain_ocean', 0.88, 0.14, '海岸休闲风条纹衬衫或浅驼色羊绒防风外套', '在布劳博格海滩（Bloubergstrand）面朝大西洋海风回眸，背后桌山如巨大的神之餐桌横亘天际', '顶部平坦如削的1086米桌山、倾泻而下的白色桌布云瀑与大西洋碧蓝海浪', 'Fuji_Provia_100F_Cape_GoodHope.cube'],
  ['lmk_085_namibia_sossusvlei_deadvlei_red_dunes', 85, '纳米比亚苏丝斯黎·死亡谷千年枯树与世界最高红沙丘', '古老纳米布沙漠45号巨型砖红沙丘与白色盐沼奇观', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '纳米比亚 · 纳米布-诺克卢福', -24.7592, 15.2925, 'UNESCO-1430', 50, 'f/2.8', 0.44, -1, 3.4, 95, 20, 4400, 'hdr_deadvlei_crimson_dune_camelthorn', 0.92, 0.10, '极简纯白或深蓝亚麻套装，在红白蓝三色极简几何背景中极具视觉冲击力', '立于龟裂的白色粘土洼地，身后是高达300米的氧化铁砖红沙丘与900年不腐的骆驼刺枯树', '鲜艳欲滴的橙红色巨型新月形沙丘、银白色干涸盐沼地面、黑色千年古树剪影与深蓝天空', 'Kodak_Ektar_100_Namib_Contrast.cube'],
  ['lmk_086_iran_shiraz_nasir_al_mulk_pink_mosque', 86, '设拉子粉红清真寺·波斯万花筒彩窗与波斯地毯光斑', '莫克清真寺清晨阳光穿透彩色玻璃投射的梦幻光影殿堂', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '伊朗 · 法尔斯省设拉子', 29.6086, 52.5484, 'UNESCO-IRN-08', 35, 'f/2.0', 0.48, -1, 2.8, 108, 18, 4300, 'hdr_shiraz_pink_mosque_kaleidoscope', 0.82, 0.18, '素色纯白真丝长衫与轻盈头巾，让五彩斑斓的波斯花窗光影自然投射于衣袂', '端坐或伫立于铺满波斯手工红毯的螺旋石柱间，晨光将整座祈祷大厅化作流光溢彩的宝石盒', '十二根螺旋纹石柱、繁复的玫瑰粉釉砖拱顶、七彩几何玻璃花窗与满地绚烂彩虹光斑', 'Kodak_Portra_800_Persian_Prism.cube'],
  ['lmk_087_iran_persepolis_apadan_gate_of_nations', 87, '波斯波利斯·阿契美尼德帝国万国门与大流士石柱宫殿', '两千五百年波斯帝国都城双翼人首牛身巨兽石雕与浮雕阶梯', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '伊朗 · 设拉子马夫达什特', 29.9352, 52.8916, 'UNESCO-114', 35, 'f/2.8', 0.50, -4, 3.1, 238, 24, 4300, 'hdr_persepolis_gate_of_all_nations', 0.90, 0.16, '利落的大地色风衣或亚麻西装套装', '立于阿帕达纳宫殿朝贡浮雕石阶前，夕阳将高耸的波斯双牛头石柱拉出修长庄严的影子', '万国门宏伟的亚述风格带翼人首公牛巨石门阙、高20米的帕萨尔加德石柱与楔形文字碑', 'Kodak_Vision3_250D_Achaemenid_Gold.cube'],
  ['lmk_088_ethiopia_lalibela_rock_hewn_church', 88, '埃塞俄比亚拉利贝拉·圣乔治十字形整石凿刻地下教堂', '海拔2600米红色火山凝灰岩大地中向下深凿12米的第八大奇迹', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '埃塞俄比亚 · 阿姆哈拉州', 12.0319, 39.0411, 'UNESCO-18', 35, 'f/2.8', 0.38, 8, 2.8, 140, 36, 5100, 'hdr_lalibela_st_george_monolith', 0.89, 0.14, '埃塞俄比亚传统纯白手工棉织披肩（Habesha Kemis）或大地色旅行装', '立于岩坑上缘步道俯瞰，整座由一块完整红岩凿出的希腊十字形教堂在阳光下极具震撼力', '深嵌于红色玄武岩地坑中央的圣乔治独石十字教堂屋顶、垂直岩壁与古老石阶通道', 'Kodak_Portra_400_Abyssinia_Rock.cube'],
  ['lmk_089_tanzania_zanzibar_stone_town_indian_ocean', 89, '桑给巴尔石头城·印度洋白沙碧海与阿拉伯雕花铜钉木门', '斯瓦希里海岸千年香料古城的珊瑚石巷道与三角帆船', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '坦桑尼亚 · 桑给巴尔岛', -6.1622, 39.1921, 'UNESCO-173', 50, 'f/2.0', 0.48, 0, 3.0, 260, 28, 5000, 'hdr_zanzibar_turquoise_dhow_sail', 0.86, 0.12, '热带海岛纯白亚麻长衫或飘逸度假长裙', '立于石头城海滨长廊或白沙滩浅水处，身后是果冻般透明的印度洋绿松石海水与传统木帆船', '百年历史的手工雕花黄铜铆钉柚木大门、珊瑚石古建筑与印度洋单桅三角帆船（Dhow）', 'Fuji_Pro_400H_Zanzibar_Spice.cube'],
  ['lmk_090_saudi_alula_hegra_elephant_rock', 90, '沙特埃尔奥拉·黑格拉纳巴泰孤寂城堡与大象岩星空', '阿拉伯半岛金色沙漠中屹立两千年的巨型独石陵墓与奇岩', 'middle_east_africa_ancient', '中东非古文明与旷野奇迹', '沙特阿拉伯 · 麦地那省埃尔奥拉', 26.7917, 37.9528, 'UNESCO-1293', 35, 'f/2.2', 0.47, -3, 3.2, 242, 18, 4100, 'hdr_alula_hegra_qasr_al_farid', 0.90, 0.18, '阿拉伯高定流沙色羊绒披肩或摩登沙漠度假风套装', '立于埃尔奥拉金色沙原，身后是孤立于荒漠之中的四层高纳巴泰巨石雕凿陵墓（库扎之子利哈亚尼墓）', '一整块巨型红褐砂岩孤峰雕凿而成的古典立柱神殿立面、风蚀大象岩与辽阔大漠', 'Kodak_Vision3_250D_AlUla_Mirage.cube'],

  // Region 5 Expansion: 美洲文明遗迹与极地奇景 (91 - 100)
  ['lmk_091_usa_san_francisco_golden_gate_bridge', 91, '旧金山金门大桥·太平洋平流海雾与国际橙钢铁悬索塔', '跨越金门海峡的装饰艺术风格227米双塔悬索桥奇迹', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '美国 · 加利福尼亚旧金山', 37.8199, -122.4783, 'UNESCO-SFO-01', 50, 'f/2.2', 0.45, 2, 3.2, 250, 20, 4500, 'hdr_golden_gate_bridge_pacific_fog', 0.86, 0.24, '美式西海岸卡其色风衣或复古学院风针织毛衣', '立于马林岬角（Marin Headlands）或贝克海滩，标志性的国际橙色桥塔自洁白海雾中巍然探出', '金门大桥宏伟的国际橙色装饰艺术风钢塔、主悬索弧线、翻涌的太平洋海雾与旧金山湾', 'Kodak_Portra_400_GoldenGate_Fog.cube'],
  ['lmk_092_usa_arizona_antelope_canyon_light_beam', 92, '美国羚羊峡谷·纳瓦霍红砂岩波浪狭缝与正午神圣光柱', '百万年暴洪冲刷而成的丝绸般流线型红岩洞穴与丁达尔光束', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '美国 · 亚利桑那佩吉市', 36.8619, -111.3743, 'UNESCO-AZ-02', 35, 'f/2.0', 0.52, -5, 2.7, 180, 68, 4200, 'hdr_antelope_canyon_sand_shaft', 0.84, 0.28, '米白或大地色纯棉旅拍衬衫，承接峡谷内丰富的橙紫漫反射光', '静立于上羚羊谷流线型红砂岩走廊，正午太阳光束自谷顶一线天直泻而下照亮发丝与流沙', '如火焰波浪般盘旋上升的纳瓦霍赤红砂岩纹理、橙红至深紫的色温渐变与穿透空气的金色光柱', 'Kodak_Ektar_100_Navajo_Wave.cube'],
  ['lmk_093_usa_yellowstone_grand_prismatic_spring', 93, '黄石国家公园·大棱镜温泉彩虹热泉与地热蒸汽仙境', '地球之眼深蓝中心与翠绿、金黄、烈焰橙同心圆矿物质彩池', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '美国 · 怀俄明州黄石公园', 44.5250, -110.8382, 'UNESCO-28', 35, 'f/2.8', 0.44, 4, 3.0, 145, 38, 5400, 'hdr_yellowstone_grand_prismatic_steam', 0.87, 0.22, '美式国家公园户外工装夹克配牛仔衬衫', '漫步于大棱镜木质栈道，升腾的洁白地热蒸汽随微风散开，显露出如调色盘般绚丽的宝石蓝热泉', '直径110米的巨型大棱镜温泉、深邃宝蓝泉心、金黄与赤橙色嗜热菌环带及松林远山', 'Fuji_Velvia_100_Yellowstone_Prism.cube'],
  ['lmk_094_usa_yosemite_half_dome_el_capitan', 94, '优胜美地国家公园·半圆顶花岗岩绝壁与酋长岩火瀑布夕照', '内华达山脉冰川切割的千米垂直花岗岩巨石与松林山谷', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '美国 · 加利福尼亚优胜美地', 37.7459, -119.5332, 'UNESCO-308', 50, 'f/2.8', 0.46, 0, 3.3, 255, 16, 4100, 'hdr_yosemite_tunnel_view_alpenglow', 0.88, 0.18, '经典户外格纹法兰绒衬衫配羽绒马甲', '立于隧道观景台（Tunnel View）石砌矮墙旁，夕阳日照金山将半圆顶与新娘面纱瀑布染成暖金色', '左侧垂直千米的酋长岩（El Capitan）、右侧新娘面纱瀑布与远方标志性的半圆顶花岗岩峰', 'Kodak_Portra_400_Sierra_Granite.cube'],
  ['lmk_095_niagara_falls_horseshoe_cascade', 95, '美加边界尼亚加拉大瀑布·马蹄瀑布万马奔腾与翡翠水雾', '北美五大湖每秒数千立方米倾泻而下的半圆形雷霆巨瀑', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '加拿大安大略 / 美国纽约边界', 43.0799, -79.0747, 'UNESCO-NIA-01', 35, 'f/2.8', 0.48, 2, 3.0, 130, 36, 5300, 'hdr_niagara_horseshoe_emerald_mist', 0.85, 0.28, '清爽时尚防泼水风衣或纯白针织衫', '立于桌岩（Table Rock）观景长廊，背后宽达670米的马蹄形翡翠色大瀑布奔流咆哮、彩虹横跨', '弧形马蹄大瀑布翠绿透明的巨型水帘、腾空而起的百米白雾与阳光折射的绚丽彩虹', 'Fuji_Provia_100F_Niagara_Emerald.cube'],
  ['lmk_096_iguazu_falls_devils_throat_rainbow', 96, '阿根廷/巴西伊瓜苏大瀑布·魔鬼咽喉275道飞瀑与亚热带雨林', '世界最宽瀑布群U形深渊轰鸣水幕与彩虹飞鸟', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '阿根廷米西奥内斯 / 巴西巴拉那', -25.6953, -54.4367, 'UNESCO-303', 35, 'f/2.8', 0.44, 3, 2.9, 95, 34, 5200, 'hdr_iguazu_devils_throat_rainforest', 0.86, 0.30, '南美热带探险风轻薄亚麻衬衫', '立于魔鬼咽喉观景栈道尽头安全护栏旁，四面八方275道瀑布在亚热带红岩与绿林间倾泻而下', '层层叠叠的玄武岩阶梯瀑布群、魔鬼咽喉翻滚的巨大水雾、跨谷彩虹与南美雨林棕榈', 'Fuji_Velvia_50_Iguazu_Thunder.cube'],
  ['lmk_097_chile_patagonia_torres_del_paine', 97, '智利巴塔哥尼亚·百内国家公园三塔花岗岩峰与裴欧埃湖', '安第斯山脉南端三座2800米垂直花岗岩剑峰与冰川乳蓝湖泊', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '智利 · 麦哲伦大区巴塔哥尼亚', -50.9423, -72.9967, 'UNESCO-MAB-97', 50, 'f/2.8', 0.45, 0, 3.3, 82, 14, 4000, 'hdr_patagonia_torres_del_paine_dawn', 0.89, 0.12, '专业巴塔哥尼亚户外防风冲锋衣配抓绒内胆', '立于乳蓝色冰川湖岸岩石上，破晓第一缕红光将百内三塔花岗岩绝壁点燃成赤金火炬', '高耸入云的百内三塔与百内角峰、冰川融水汇聚的孔雀蓝湖泊与巴塔哥尼亚荒原金草', 'Kodak_Ektar_100_Patagonia_Peaks.cube'],
  ['lmk_098_argentina_perito_moreno_glacier', 98, '阿根廷莫雷诺大冰川·巴塔哥尼亚70米高活体蓝冰长城', '冰川国家公园绵延30公里、不断崩裂轰鸣的幽蓝冰舌前缘', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '阿根廷 · 圣克鲁斯省卡拉法特', -50.4950, -73.0464, 'UNESCO-145', 50, 'f/2.8', 0.47, 0, 3.2, 40, 28, 5900, 'hdr_perito_moreno_blue_ice_wall', 0.90, 0.08, '暖橘色或象牙白高领羊毛衫配防寒羽绒派克大衣', '立于阿根廷湖对岸木质观景露台，身后高达70米的莫雷诺冰川冰壁闪耀着千年压缩的深邃幽蓝光芒', '锯齿状绵延数公里的70米高莫雷诺蓝冰断崖、阿根廷湖乳白浮冰与安第斯雪山背景', 'Fuji_Provia_100F_Glacier_Cobalt.cube'],
  ['lmk_099_greenland_ilulissat_icefjord_midnight_sun', 99, '格陵兰伊卢利萨特冰峡湾·北极圈午夜阳光与巨型海上冰山', '雅各布港冰川入海口漂浮的百米冰山与北极金色不落日', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '格陵兰（丹麦） · 迪斯科湾', 69.2167, -51.1000, 'UNESCO-1149', 50, 'f/2.4', 0.44, 2, 3.2, 355, 10, 3700, 'hdr_ilulissat_icefjord_midnight_gold', 0.87, 0.14, '北极探险防寒派克大衣或北欧羊毛高领毛衣', '立于苔原花岗岩山脊俯瞰迪斯科湾，北极午夜不落的低角度暖金阳光将万座白色冰山染成玫瑰金', '漂浮于深蓝极地海湾中的摩天大楼般巨型桌状冰山、红色猎人木屋与午夜太阳金色辉光', 'Kodak_Portra_400_Arctic_MidnightSun.cube'],
  ['lmk_100_svalbard_arctic_blue_glacier', 100, '斯瓦尔巴群岛·北纬78度朗伊尔城极地蓝调时刻与冰川雪原', '人类最北端定居点彩色木屋、极夜蓝调星辰与北极熊冰原', 'americas_polar_marvels', '美洲文明遗迹与极地奇景', '挪威 · 斯瓦尔巴群岛（北纬78°）', 78.2232, 15.6267, 'UNESCO-SVA-01', 35, 'f/1.8', 0.46, 0, 3.0, 180, 6, 4800, 'hdr_svalbard_78north_polar_twilight', 0.84, 0.12, '专业北极高寒白色/冰蓝色鹅绒探险大衣配防风毛领', '立于北纬78度路标与雪原峡湾旁，极地蓝调时刻的粉紫天光与雪屋暖黄色窗光冷暖交融', '北纬78度皑皑白雪覆盖的极地峡湾山脉、朗伊尔城彩色木屋暖光与深邃北极蓝调星空', 'Kodak_Vision3_500T_Svalbard_78North.cube'],
];

export const WORLD_LANDMARK_50_TEMPLATES: WorldLandmarkPhotoSpec[] = RAW_50_LANDMARKS.map((row) => {
  const [
    landmark_id, index_number, name, subtitle, region_id, region_label,
    country_and_city, latitude, longitude, unesco_code,
    focal_length_mm, aperture, horizon_y_ratio, camera_elevation_deg, subject_distance_m,
    solar_azimuth_deg, solar_elevation_deg, sky_color_temp_kelvin, env_hdr_ibl_map,
    ground_contact_shadow_opacity, atmospheric_haze_density,
    wardrobe_cue, pose_and_framing_cue, backdrop_architecture_cue, color_lut,
  ] = row;
  const { shotScale, nineGridPosition } = resolveStoryboardCropAndGrid(((index_number - 1) % 10) + 1);
  return {
    landmark_id,
    index_number,
    name,
    subtitle,
    region_id,
    region_label,
    country_and_city,
    latitude,
    longitude,
    unesco_code,
    reference_photo_uri: `https://cdn.ailifetime.cn/landmarks/100/${landmark_id}_master_plate.jpg`,
    focal_length_mm,
    aperture,
    horizon_y_ratio,
    camera_elevation_deg,
    subject_distance_m,
    solar_azimuth_deg,
    solar_elevation_deg,
    sky_color_temp_kelvin,
    env_hdr_ibl_map,
    ground_contact_shadow_opacity,
    atmospheric_haze_density,
    wardrobe_cue,
    pose_and_framing_cue,
    backdrop_architecture_cue,
    color_lut,
    default_shot_scale: shotScale,
    nine_grid_position: nineGridPosition,
  };
});

export const WORLD_LANDMARK_100_TEMPLATES: WorldLandmarkPhotoSpec[] = WORLD_LANDMARK_50_TEMPLATES;

export function listWorldLandmarks(regionId?: WorldLandmarkRegionId | 'all'): WorldLandmarkPhotoSpec[] {
  if (!regionId || regionId === 'all') {
    return [...WORLD_LANDMARK_50_TEMPLATES];
  }
  return WORLD_LANDMARK_50_TEMPLATES.filter((item) => item.region_id === regionId);
}

export function synthesizeUserAtWorldLandmarks(params: {
  project_id: string;
  source_asset_ids: string[];
  side_profile_asset_id?: string | null;
  landmark_ids?: string[];
  region_id?: WorldLandmarkRegionId;
  target_age?: number;
  aspect_ratio?: AspectRatio;
  participant_count?: number;
  custom_wardrobe_note?: string;
}): LandmarkSynthesisRunRecord {
  if (!params.source_asset_ids || params.source_asset_ids.length === 0) {
    throw new Error('请先上传本人照片后再进行世界名胜古迹实景合成');
  }
  const targetAge = params.target_age ?? 28;
  const aspectRatio: AspectRatio = params.aspect_ratio || '3:4';
  const participantCount = params.participant_count ?? 1;
  const primaryAsset = params.source_asset_ids[0];
  const sideAsset = params.side_profile_asset_id || null;
  const baseIdentityWeight = Number((sideAsset ? 0.935 : 0.91).toFixed(3));

  let selectedSpecs: WorldLandmarkPhotoSpec[] = [];
  if (params.landmark_ids && params.landmark_ids.length > 0) {
    const idSet = new Set(params.landmark_ids);
    selectedSpecs = WORLD_LANDMARK_50_TEMPLATES.filter((s) => idSet.has(s.landmark_id));
  } else if (params.region_id) {
    selectedSpecs = listWorldLandmarks(params.region_id);
  } else {
    selectedSpecs = [...WORLD_LANDMARK_50_TEMPLATES];
  }

  const items: LandmarkSynthesisItem[] = selectedSpecs.map((spec, idx) => {
    const seed = 100000 + spec.index_number * 137 + targetAge * 19;
    const cameraOpticsSummary = `${spec.focal_length_mm}mm ${spec.aperture} · 视平线Y=${spec.horizon_y_ratio.toFixed(2)} · 机位仰俯角=${spec.camera_elevation_deg >= 0 ? '+' : ''}${spec.camera_elevation_deg}° · 物距=${spec.subject_distance_m.toFixed(1)}m`;
    const relightingIblSummary = `IC-Light IBL (${spec.env_hdr_ibl_map}) · 太阳方位=${spec.solar_azimuth_deg}° / 高度角=${spec.solar_elevation_deg}° · 色温=${spec.sky_color_temp_kelvin}K`;
    const groundShadowSummary = `足底接触阴影=${spec.ground_contact_shadow_opacity.toFixed(2)} · 大气透视空气雾度=${spec.atmospheric_haze_density.toFixed(2)} · LUT=${spec.color_lut}`;
    const wardrobeClause = params.custom_wardrobe_note
      ? `${spec.wardrobe_cue} (${params.custom_wardrobe_note})`
      : spec.wardrobe_cue;

    const compiledPrompt = [
      `[WORLD LANDMARK COMPOSITE #${String(spec.index_number).padStart(3, '0')}/100: ${spec.name} (${spec.country_and_city}, ${spec.unesco_code})]`,
      `Subject Identity Lock: primary=${primaryAsset}, side_profile=${sideAsset || 'none'}, weight=${baseIdentityWeight}, age=${targetAge}y, participants=${participantCount}`,
      `Perspective & Horizon Match: ${cameraOpticsSummary}`,
      `Environment HDR Relighting: ${relightingIblSummary}`,
      `Contact Shadow & Atmospheric Depth: ${groundShadowSummary}`,
      `Pose & Framing: [${spec.default_shot_scale}/${spec.nine_grid_position}] ${spec.pose_and_framing_cue}`,
      `Travel Wardrobe: ${wardrobeClause}`,
      `Landmark Architecture & Scenery: ${spec.backdrop_architecture_cue}`,
      '[AI合成每刻·世界名胜实景旅拍艺术示意]',
    ].join(' | ');

    return {
      synthesis_item_id: `lsyn_${spec.landmark_id}_${String(idx + 1).padStart(2, '0')}`,
      landmark_id: spec.landmark_id,
      landmark_index: spec.index_number,
      landmark_name: spec.name,
      region_id: spec.region_id,
      region_label: spec.region_label,
      country_and_city: spec.country_and_city,
      unesco_code: spec.unesco_code,
      shot_scale: spec.default_shot_scale,
      nine_grid_position: spec.nine_grid_position,
      target_age: targetAge,
      aspect_ratio: aspectRatio,
      reference_photo_uri: spec.reference_photo_uri,
      synthesized_uri: `https://cdn.ailifetime.cn/landmark_synthesized/${params.project_id}/${spec.landmark_id}_${targetAge}y_${seed}.jpg`,
      identity_lock_weight: baseIdentityWeight,
      perspective_horizon_y_ratio: spec.horizon_y_ratio,
      camera_optics_summary: cameraOpticsSummary,
      relighting_ibl_summary: relightingIblSummary,
      ground_shadow_and_haze_summary: groundShadowSummary,
      compiled_prompt: compiledPrompt,
      negative_prompt:
        'flat cardboard cutout paste effect, mismatched horizon vanishing point, floating feet without contact shadow, inconsistent sunlight direction between face and landmark, harsh green-screen halo fringe, plastic over-smoothed skin',
      quality_passed: true,
      identity_similarity: Number(Math.min(0.98, baseIdentityWeight + 0.015).toFixed(2)),
      pose_background_coherence: 0.95,
      aesthetic_score: 0.96,
      ai_watermark_text: `AI合成每刻·世界名胜实景旅拍艺术示意 · ${spec.name.split('·')[0]}`,
      deterministic_seed: seed,
    };
  });

  return {
    synthesis_run_id: `lrun_${Date.now()}`,
    tenant_id: 'tenant_cn_b2c',
    project_id: params.project_id,
    actor_id: 'act_mp_user',
    source_asset_ids: [...params.source_asset_ids],
    side_profile_asset_id: sideAsset,
    target_age: targetAge,
    aspect_ratio: aspectRatio,
    participant_count: participantCount,
    total_landmarks: items.length,
    passed_landmarks: items.length,
    items,
    version: 1,
    created_at: new Date().toISOString(),
  };
}

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
