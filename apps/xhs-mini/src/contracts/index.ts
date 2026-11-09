/**
 * AI Life Time Machine - Shared OpenAPI 3.1.0 & Domain Contracts
 * Generated from contracts/openapi.yaml & product invariants (B70/B71/B72)
 */

export const AI_SIMULATION_DISCLOSURE =
  '本服务生成的 0—100 岁影像与未来自我对话均为 AI 艺术化示意，不构成对真实容貌、健康、寿命、职业、财富或人生结果的预测。';

export const DEFAULT_TIMELINE_AGES = [0, 5, 10, 18, 25, 35, 45, 55, 65, 75, 85, 100] as const;

export type AspectRatio = '3:4' | '4:5' | '1:1' | '9:16';
export type TemplateCostTier = 'standard' | 'pro-studio' | 'master-print';

export interface OpticsAndLightingSpec {
  focal_length_mm: number;
  aperture: string;
  framing: string;
  lighting_setup: string;
  color_science: string;
  skin_texture_policy: string;
  film_grain_profile: string;
}

export interface IdentityPreservationSpec {
  identity_adapter: string;
  craniofacial_anchor_weight: number;
  eye_geometry_lock: number;
  skin_undertone_lock: number;
  expression_naturalness_weight: number;
}

export interface PhysiologicalWeightsSpec {
  craniofacial_neoteny_weight: number;
  dermal_collagen_elasticity: number;
  subsurface_scattering_strength: number;
  nasolabial_fold_depth_limit: number;
  silver_strand_ratio: number;
  eye_catchlight_clarity: number;
  age_spot_micro_density: number;
}

export type ShotScale =
  | 'extreme_closeup_eyes'
  | 'medium_bust'
  | 'three_quarter_profile'
  | 'half_body_hands';

export type NineGridPosition =
  | 'center_hero'
  | 'corner_framing'
  | 'edge_rhythm'
  | 'bonus_alternate';

export interface CuratedShotSpec {
  shot_id: string;
  shot_index: number;
  target_age: number;
  title: string;
  framing_and_angle: string;
  lighting_key_ratio: string;
  lens_dof_cue: string;
  craniofacial_and_dermal_focus: string;
  wardrobe_fabric_cue: string;
  backdrop_prop_cue: string;
  micro_expression_cue: string;
  default_selected: boolean;
  shot_scale?: ShotScale;
  nine_grid_position?: NineGridPosition;
}

export interface MultiPhotoAnchorSpec {
  primary_adult_asset_id: string;
  side_profile_asset_id: string | null;
  childhood_reference_asset_id: string | null;
  childhood_reference_age: number | null;
  adult_anchor_weight: number;
  childhood_anchor_weight: number;
  profile_3d_depth_boost: number;
  dual_anchor_active: boolean;
}

export interface RelightingPassSpec {
  enabled: boolean;
  normal_map_estimator: string;
  key_azimuth_deg: number;
  key_elevation_deg: number;
  color_temp_kelvin: number;
  shadow_softness: number;
  fill_bounce_ratio: string;
}

export interface FrequencySeparatedSkinPassSpec {
  enabled: boolean;
  low_freq_gaussian_sigma_px: number;
  high_freq_denoise_strength: number;
  tile_controlnet_weight: number;
  micro_features_injected: string[];
}

export interface OpticalPostProcessSpec {
  enabled: boolean;
  vignette_ev: number;
  cats_eye_bokeh_eccentricity: number;
  halation_strength: number;
  halation_radius_px: number;
  shadow_grain_sigma: number;
  highlight_grain_sigma: number;
}

export interface ImageEnhancementPipelineSpec {
  multi_photo_anchor: MultiPhotoAnchorSpec;
  relighting_pass: RelightingPassSpec;
  frequency_separated_skin_pass: FrequencySeparatedSkinPassSpec;
  optical_post_process: OpticalPostProcessSpec;
}

export interface AcousticVoiceprintColophonSpec {
  audio_memory_id: string;
  voice_qr_url: string;
  duration_seconds: number;
  voiceprint_bars: number[];
  caption: string;
  qr_whitelisted: boolean;
}

export interface PhotobookSpreadSpec {
  spread_index: number;
  left_page_number: number;
  right_page_number: number;
  layout_archetype: string;
  paper_stock: string;
  finish_craft: string;
  whitespace_ratio: number;
  shot_ids: string[];
  target_ages: number[];
  calendar_years: number[];
  era_watermarks: string[];
  narrative_quote: string;
  face_bbox_x_mm: number[];
  gutter_safe_verified: boolean;
}

export interface PhotobookPreflightReport {
  preflight_passed: boolean;
  dpi_verified: number;
  bleed_mm: number;
  cmyk_icc_profile: string;
  max_cmyk_tac_percent: number;
  tac_limit_percent: number;
  shadow_gamma_lift: number;
  black_point_compensation_ire: number;
  spine_center_x_mm: number;
  gutter_safe_margin_mm: number;
  gutter_face_collisions: number;
  warnings: string[];
}

export interface PhotobookLayoutManifest {
  manifest_id: string;
  project_id: string;
  gallery_id: string;
  template_id: string;
  sku_code: string;
  title: string;
  subtitle: string;
  binding_type: string;
  page_count: number;
  spread_count: number;
  selected_shot_count: number;
  vellum_frontispiece_enabled: boolean;
  gold_foil_emboss_enabled: boolean;
  spreads: PhotobookSpreadSpec[];
  acoustic_colophon: AcousticVoiceprintColophonSpec;
  preflight_report: PhotobookPreflightReport;
  updated_at: string;
}

export interface EraContextSpec {
  birth_year: number;
  target_age: number;
  calendar_year: number;
  decade_label: string;
  era_scene_cue: string;
  collar_material_cue: string;
  window_light_cue: string;
  color_grade_shift: string;
}

export interface ProviderNativePayloadSpec {
  provider_id: string;
  fallback_provider_id: string;
  model_id: string;
  identity_adapter: string;
  instantid_weight: number;
  pulid_weight: number;
  sampler: string;
  steps: number;
  cfg_scale: number;
  color_lut: string;
  print_bleed_mm: number;
  cmyk_profile: string;
}

export interface AgeBandPromptRecipe {
  band_key: string;
  min_age: number;
  max_age: number;
  stage_label: string;
  craniofacial_and_skin_cue: string;
  hair_and_grooming_cue: string;
  wardrobe_and_styling_cue: string;
  pose_and_gaze_cue: string;
  backdrop_and_atmosphere_cue: string;
  identity_lock_strength: number;
  physiological_weights?: PhysiologicalWeightsSpec;
}

export interface QualityGateThresholdSpec {
  min_identity_similarity: number;
  max_facial_drift: number;
  min_age_plausibility: number;
  min_pose_background_coherence: number;
  min_artifact_free_score: number;
  min_sharpness_score: number;
  min_aesthetic_score: number;
  max_auto_retries: number;
}

export type TemplateCategory =
  | 'solo-portrait'
  | 'editorial'
  | 'documentary'
  | 'family-co-aging'
  | 'fine-art-print'
  | 'cinematic-film'
  | 'family-heirloom'
  | 'bw-editorial'
  | 'outdoor-poetic';

export interface PortraitTemplateSpec {
  template_id: string;
  version: string;
  name: string;
  subtitle: string;
  category: TemplateCategory;
  badge: string;
  status: 'active' | 'draft' | 'retired';
  max_participants: number;
  min_age: number;
  max_age: number;
  min_curated_shots: number;
  recommended_ages: number[];
  curated_gallery_shots: CuratedShotSpec[];
  supported_aspect_ratios: AspectRatio[];
  default_aspect_ratio: AspectRatio;
  required_consents: ConsentPurpose[];
  provider_capabilities: string[];
  cost_tier: TemplateCostTier;
  allowed_channels: string[];
  competitive_highlights: string[];
  optics_and_lighting: OpticsAndLightingSpec;
  identity_preservation: IdentityPreservationSpec;
  quality_thresholds: QualityGateThresholdSpec;
  negative_constraints: string[];
  age_band_recipes: AgeBandPromptRecipe[];
}

export interface CompiledNodePromptPlan {
  shot_id?: string;
  shot_index?: number;
  shot_title?: string;
  shot_scale?: ShotScale;
  nine_grid_position?: NineGridPosition;
  default_selected?: boolean;
  target_age: number;
  stage_label: string;
  is_retroactive_simulation: boolean;
  retroactive_disclosure: string | null;
  age_delta_from_anchor: number;
  identity_anchor_weight: number;
  physiological_weights?: PhysiologicalWeightsSpec;
  era_context?: EraContextSpec;
  provider_payload?: ProviderNativePayloadSpec;
  image_enhancement_pipeline?: ImageEnhancementPipelineSpec;
  optics_summary: string;
  structured_prompt: {
    subject_identity_anchor: string;
    age_progression_directive: string;
    pose_and_expression: string;
    wardrobe_and_styling: string;
    backdrop_and_environment: string;
    optics_and_lighting: string;
    disclosure_tag: string;
  };
  compiled_prompt: string;
  negative_prompt: string;
  deterministic_seed: number;
}

export interface TimelineGenerationPlan {
  plan_id: string;
  project_id: string;
  template_id: string;
  template_version: string;
  current_age_anchor: number;
  aspect_ratio: AspectRatio;
  participant_count: number;
  contains_minor: boolean;
  nodes: CompiledNodePromptPlan[];
  created_at: string;
}

export interface QualityEvaluationReport {
  target_age: number;
  template_id: string;
  passed: boolean;
  recommended_action: 'publish' | 'auto-retry' | 'fallback-provider' | 'manual-review';
  dimensions: {
    identity_similarity: number;
    age_plausibility: number;
    facial_drift: number;
    pose_background_coherence: number;
    artifact_free_score: number;
    sharpness_score: number;
    aesthetic_score: number;
  };
  failure_reasons: string[];
}

export type GrantorCapacity = 'self' | 'guardian' | 'authorized-agent';
export type ConsentPurpose =
  | 'age-transformation'
  | 'family-co-aging'
  | 'future-self-dialogue'
  | 'public-share'
  | 'physical-print';

export interface ApiError {
  code: string;
  message: string;
  request_id: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
}

export interface GuestSession {
  id: string;
  expires_at: string;
  consent_preflight_version: string;
}

export interface MiniProgramSessionExchangeRequest {
  platform: 'mp-xhs' | 'mp-weixin';
  js_code: string;
  merge_guest_session_id?: string | null;
}

export interface MiniProgramSession {
  session_id: string;
  actor_pseudonym: string;
  platform: 'mp-xhs' | 'mp-weixin';
  access_token: string;
  expires_at: string;
}

export interface XhsNoteMountRequest {
  share_id: string;
  title: string;
  topic_tags: string[];
  participant_consent_refs: string[];
  contains_minor?: boolean;
}

export interface XhsNoteMountCard {
  mount_id: string;
  share_id: string;
  xhs_path: string;
  enforced_title: string;
  ai_watermark_badge: 'AI生成·艺术示意非真实预测';
  topic_tags: string[];
  expires_at: string;
}

export interface XhsPaymentWebhookPayload {
  event_id: string;
  out_trade_no: string;
  xhs_trade_no: string;
  amount_minor: number;
  currency: string;
  status: 'PAID' | 'REFUNDED' | 'CLOSED';
  timestamp: string;
  nonce: string;
  signature: string;
}

export interface XhsPaymentWebhookReceipt {
  event_id: string;
  order_id: string;
  state: string;
  deduplicated: boolean;
  ledger_entry_id: string;
}

export interface UploadSessionRequest {
  purpose: ConsentPurpose | string;
  declared_participant_count: number;
  content_type: string;
  size_bytes: number;
  sha256?: string;
}

export interface UploadSession {
  id: string;
  asset_id: string;
  upload_url: string;
  expires_at: string;
  required_headers?: Record<string, string>;
}

export interface ConsentRequest {
  participant_id: string;
  grantor_capacity: GrantorCapacity;
  purpose: ConsentPurpose | string;
  scope: {
    allow_public_share?: boolean;
    allow_physical_print?: boolean;
    allow_long_term_memory?: boolean;
    is_minor?: boolean;
  };
  policy_version: string;
  expires_at?: string | null;
  evidence: Record<string, unknown>;
}

export interface ConsentReceipt {
  id: string;
  status: 'active' | 'pending-verification';
  evidence_hash: string;
  granted_at: string;
}

export interface ParticipantSlot {
  participant_id: string;
  source_asset_ids: string[];
  consent_refs: string[];
}

export interface ProjectRequest {
  template_id: string;
  participant_slots: ParticipantSlot[];
  timeline_ages: number[];
  visibility: 'private' | 'household';
  current_age?: number;
  birth_year?: number;
  aspect_ratio?: AspectRatio;
  side_profile_asset_id?: string | null;
  childhood_reference_asset_id?: string | null;
  childhood_reference_age?: number | null;
  options?: Record<string, unknown>;
}

export interface Project {
  id: string;
  state: 'draft' | 'ready' | 'locked' | 'archived';
  version: number;
  template_id?: string;
  template_version?: string;
  current_age_anchor?: number;
  birth_year?: number;
  aspect_ratio?: AspectRatio;
  policy_summary?: Record<string, unknown>;
}

export interface GenerationJobRequest {
  project_id: string;
  quote_id: string;
  entitlement_id: string;
  client_request_id?: string;
}

export type GenerationJobState =
  | 'queued'
  | 'preflight'
  | 'running'
  | 'quality-review'
  | 'ready'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface GenerationJobProgress {
  stage?: string;
  completed_units?: number;
  total_units?: number | null;
}

export interface AgeFramePreview {
  age: number;
  label: string;
  signed_preview_url: string;
  expires_at: string;
  ai_watermark_text: string;
  shot_id?: string;
  shot_index?: number;
  shot_title?: string;
  shot_scale?: ShotScale;
  nine_grid_position?: NineGridPosition;
  default_selected?: boolean;
  template_id?: string;
  stage_label?: string;
  calendar_year?: number;
  decade_label?: string;
  era_scene_cue?: string;
  collar_material_cue?: string;
  window_light_cue?: string;
  is_retroactive_simulation?: boolean;
  retroactive_disclosure?: string | null;
  optics_summary?: string;
  compiled_prompt?: string;
  negative_prompt?: string;
  identity_score?: number;
  aesthetic_score?: number;
  quality_passed?: boolean;
  physiological_weights?: PhysiologicalWeightsSpec;
  provider_payload?: ProviderNativePayloadSpec;
  image_enhancement_pipeline?: ImageEnhancementPipelineSpec;
}

export interface CuratedGallerySelectionReceipt {
  selection_id: string;
  project_id: string;
  template_id: string;
  selected_shot_ids: string[];
  selected_ages: number[];
  selected_count: number;
  export_mode: 'xhs_9_grid' | 'photobook_hardcover' | 'digital_bundle';
  photobook_sku: string | null;
  updated_at: string;
}

export interface GenerationJob {
  id: string;
  state: GenerationJobState;
  progress: GenerationJobProgress;
  result_manifest_url?: string | null;
  frames?: AgeFramePreview[];
  error?: ApiError | null;
  created_at: string;
  updated_at?: string;
}

export interface ShareRequest {
  artifact_ids: string[];
  access: 'private-link' | 'public';
  expires_at: string;
  allow_download?: boolean;
  participant_consent_refs?: string[];
}

export interface Share {
  id: string;
  url: string;
  status: 'active' | 'revoked' | 'expired' | 'reported';
  expires_at: string;
  provenance_id?: string;
}

export interface CheckoutItem {
  sku: string;
  quantity: number;
  project_id?: string | null;
}

export interface CheckoutRequest {
  items: CheckoutItem[];
  currency: string;
  promotion_code?: string | null;
  return_url: string;
}

export interface CheckoutSession {
  id: string;
  quote_id: string;
  amount_minor: number;
  currency: string;
  payment_url: string;
  expires_at: string;
}

export type OrderState =
  | 'awaiting-consent'
  | 'paid'
  | 'processing'
  | 'partial'
  | 'fulfilled'
  | 'cancelled'
  | 'refunded'
  | 'disputed';

export interface Order {
  id: string;
  state: OrderState;
  items: Record<string, unknown>[];
  amount_minor: number;
  currency: string;
  delivery_manifest_url?: string | null;
}

export interface FutureSelfMessageRequest {
  conversation_id: string;
  message: string;
  disclosure_ack: true;
  memory_mode?: 'off' | 'session' | 'explicit';
}

export interface FutureSelfMessage {
  message_id: string;
  role_disclosure: string;
  content: string;
  safety_state: 'normal' | 'dependency-warning' | 'crisis-handoff' | 'blocked';
  resources?: Record<string, unknown>[];
}

export interface RightsRequest {
  type:
    | 'access'
    | 'export'
    | 'correct'
    | 'withdraw-consent'
    | 'restrict'
    | 'delete'
    | 'appeal';
  scope: Record<string, unknown>;
  verification_method: string;
  reason?: string | null;
}

export interface RightsCase {
  id: string;
  state:
    | 'verification'
    | 'in-progress'
    | 'waiting-downstream'
    | 'completed'
    | 'partially-completed'
    | 'denied'
    | 'appealed';
  submitted_at: string;
  target_at: string;
  receipt_url?: string | null;
}
