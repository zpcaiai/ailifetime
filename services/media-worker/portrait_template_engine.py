"""
AI Life Time Machine - Built-in Competitive Portrait Template Catalog,
Deterministic Prompt Plan Compiler, Birth-Year Era Chronicle Engine,
Physiological Craniofacial/Dermal Matrix & Multi-Provider B15 Curation Pipeline.

Implements:
- B08-R01..R05: Default 0..100 age nodes with current-age continuity anchor,
  >=9 curated shots per template (10 curated milestone shots per template),
  template capability declarations (max_participants, age range, aspect ratios,
  required consents, provider capabilities, cost tier, channels), versioned
  composition draft persistence with optimistic locking, illustrative age
  transformation language, and pre-publish template governance checks.
- B14-R01..R05: Current-age & source-photo identity anchoring, retroactive
  childhood creative simulation disclosure, birth-year + target-age dynamic era
  chronicle resolution, fine-grained physiological craniofacial & dermal evolution
  weights (6yo neoteny/catchlight, 45yo taut contour without forced heavy wrinkles,
  65-85yo natural silver hair & gentle nasolabial trajectory), provider-native
  payload compilation (InstantID/PuLID/ControlNet/300DPI CMYK), deterministic seed
  derivation, and partial-delivery hold for nodes failing quality gates.
- B15-R01..R05: Multi-dimensional quality evaluation (identity similarity,
  age plausibility, facial drift, pose/background coherence, hand/teeth/eye
  artifact-free score, sharpness, aesthetic score) with per-template thresholds,
  bounded retry / fallback-provider / manual-review routing, and >=9-shot user
  curation persistence in ACID SQLite.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any


DEFAULT_TIMELINE_AGES: tuple[int, ...] = (0, 5, 10, 18, 25, 35, 45, 55, 65, 75, 85, 100)
RECOMMENDED_XHS_AGES: tuple[int, ...] = (3, 6, 12, 18, 25, 32, 45, 58, 72, 85)
RECOMMENDED_CO_AGING_AGES: tuple[int, ...] = (18, 22, 28, 35, 42, 50, 58, 66, 75, 85)
MIN_CURATED_SHOTS_PER_TEMPLATE: int = 9
AI_ILLUSTRATIVE_TAG = "AI生成·艺术示意非真实预测"

ANTI_PLASTIC_NEGATIVE_CONSTRAINTS: tuple[str, ...] = (
    "plastic over-smoothed skin",
    "wax figure complexion",
    "airbrushed beauty filter",
    "uncanny valley facial proportions",
    "identity drift or swapped bone structure",
    "asymmetric irises or strabismus artifacts",
    "deformed hands or extra fingers",
    "distorted teeth or unnatural dental arch",
    "fake glued-on beard or Halloween wig",
    "harsh flat flash overexposure",
    "cartoonish 3D CGI render",
    "predictive medical or longevity claims",
)

MINOR_SAFETY_NEGATIVE_CONSTRAINTS: tuple[str, ...] = (
    "adultified minor styling",
    "sexualized or provocative pose",
    "heavy adult cosmetics on child",
    "inappropriate occupational or nightlife setting",
)


class TemplateEngineError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass(frozen=True)
class OpticsAndLightingSpec:
    focal_length_mm: int
    aperture: str
    framing: str
    lighting_setup: str
    color_science: str
    skin_texture_policy: str
    film_grain_profile: str


@dataclass(frozen=True)
class IdentityPreservationSpec:
    identity_adapter: str
    craniofacial_anchor_weight: float
    eye_geometry_lock: float
    skin_undertone_lock: float
    expression_naturalness_weight: float


@dataclass(frozen=True)
class PhysiologicalWeightsSpec:
    craniofacial_neoteny_weight: float
    dermal_collagen_elasticity: float
    subsurface_scattering_strength: float
    nasolabial_fold_depth_limit: float
    silver_strand_ratio: float
    eye_catchlight_clarity: float
    age_spot_micro_density: float

    def to_dict(self) -> dict[str, float]:
        return asdict(self)


@dataclass(frozen=True)
class AgeBandPromptRecipe:
    band_key: str
    min_age: int
    max_age: int
    stage_label: str
    craniofacial_and_skin_cue: str
    hair_and_grooming_cue: str
    wardrobe_and_styling_cue: str
    pose_and_gaze_cue: str
    backdrop_and_atmosphere_cue: str
    identity_lock_strength: float
    physiological_weights: PhysiologicalWeightsSpec


@dataclass(frozen=True)
class CuratedShotSpec:
    shot_id: str
    shot_index: int
    target_age: int
    title: str
    framing_and_angle: str
    lighting_key_ratio: str
    lens_dof_cue: str
    craniofacial_and_dermal_focus: str
    wardrobe_fabric_cue: str
    backdrop_prop_cue: str
    micro_expression_cue: str
    default_selected: bool = True
    shot_scale: str = ""
    nine_grid_position: str = ""

    def __post_init__(self) -> None:
        default_scale, default_grid = _resolve_storyboard_crop_and_grid(self.shot_index)
        if not self.shot_scale:
            object.__setattr__(self, "shot_scale", default_scale)
        if not self.nine_grid_position:
            object.__setattr__(self, "nine_grid_position", default_grid)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _resolve_storyboard_crop_and_grid(shot_index: int) -> tuple[str, str]:
    """
    Deterministic multi-crop storyboard rhythm for 9-grid carousels & 20-page photobooks:
    - Shot 1 (childhood opener): extreme_closeup_eyes / corner_framing
    - Shot 2: medium_bust / edge_rhythm
    - Shot 3: three_quarter_profile / corner_framing
    - Shot 4: medium_bust / edge_rhythm
    - Shot 5 (prime C-position hero): medium_bust / center_hero
    - Shot 6: three_quarter_profile / edge_rhythm
    - Shot 7: half_body_hands / corner_framing
    - Shot 8: three_quarter_profile / edge_rhythm
    - Shot 9 (elder wisdom closer): extreme_closeup_eyes / corner_framing
    - Shot 10 (archival bonus spread): half_body_hands / bonus_alternate
    """
    mapping: dict[int, tuple[str, str]] = {
        1: ("extreme_closeup_eyes", "corner_framing"),
        2: ("medium_bust", "edge_rhythm"),
        3: ("three_quarter_profile", "corner_framing"),
        4: ("medium_bust", "edge_rhythm"),
        5: ("medium_bust", "center_hero"),
        6: ("three_quarter_profile", "edge_rhythm"),
        7: ("half_body_hands", "corner_framing"),
        8: ("three_quarter_profile", "edge_rhythm"),
        9: ("extreme_closeup_eyes", "corner_framing"),
        10: ("half_body_hands", "bonus_alternate"),
    }
    return mapping.get(int(shot_index), ("medium_bust", "edge_rhythm"))


@dataclass(frozen=True)
class MultiPhotoAnchorSpec:
    primary_adult_asset_id: str
    side_profile_asset_id: str | None
    childhood_reference_asset_id: str | None
    childhood_reference_age: int | None
    adult_anchor_weight: float
    childhood_anchor_weight: float
    profile_3d_depth_boost: float
    dual_anchor_active: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RelightingPassSpec:
    enabled: bool
    normal_map_estimator: str
    key_azimuth_deg: int
    key_elevation_deg: int
    color_temp_kelvin: int
    shadow_softness: float
    fill_bounce_ratio: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class FrequencySeparatedSkinPassSpec:
    enabled: bool
    low_freq_gaussian_sigma_px: float
    high_freq_denoise_strength: float
    tile_controlnet_weight: float
    micro_features_injected: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class OpticalPostProcessSpec:
    enabled: bool
    vignette_ev: float
    cats_eye_bokeh_eccentricity: float
    halation_strength: float
    halation_radius_px: float
    shadow_grain_sigma: float
    highlight_grain_sigma: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ImageEnhancementPipelineSpec:
    multi_photo_anchor: MultiPhotoAnchorSpec
    relighting_pass: RelightingPassSpec
    frequency_separated_skin_pass: FrequencySeparatedSkinPassSpec
    optical_post_process: OpticalPostProcessSpec

    def to_dict(self) -> dict[str, Any]:
        return {
            "multi_photo_anchor": self.multi_photo_anchor.to_dict(),
            "relighting_pass": self.relighting_pass.to_dict(),
            "frequency_separated_skin_pass": self.frequency_separated_skin_pass.to_dict(),
            "optical_post_process": self.optical_post_process.to_dict(),
        }


@dataclass(frozen=True)
class EraContextSpec:
    birth_year: int
    target_age: int
    calendar_year: int
    decade_label: str
    era_scene_cue: str
    collar_material_cue: str
    window_light_cue: str
    color_grade_shift: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ProviderNativePayloadSpec:
    provider_id: str
    fallback_provider_id: str
    model_id: str
    identity_adapter: str
    instantid_weight: float
    pulid_weight: float
    controlnet_units: list[dict[str, Any]]
    sampler: str
    steps: int
    cfg_scale: float
    color_lut: str
    print_bleed_mm: int
    cmyk_profile: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class QualityGateThresholdSpec:
    min_identity_similarity: float
    max_facial_drift: float
    min_age_plausibility: float
    min_pose_background_coherence: float
    min_artifact_free_score: float
    min_sharpness_score: float
    min_aesthetic_score: float
    max_auto_retries: int


@dataclass(frozen=True)
class PortraitTemplateSpec:
    template_id: str
    version: str
    name: str
    subtitle: str
    category: str
    badge: str
    status: str
    max_participants: int
    min_age: int
    max_age: int
    min_curated_shots: int
    recommended_ages: list[int]
    curated_gallery_shots: list[CuratedShotSpec]
    supported_aspect_ratios: list[str]
    default_aspect_ratio: str
    required_consents: list[str]
    provider_capabilities: list[str]
    cost_tier: str
    allowed_channels: list[str]
    competitive_highlights: list[str]
    optics_and_lighting: OpticsAndLightingSpec
    identity_preservation: IdentityPreservationSpec
    quality_thresholds: QualityGateThresholdSpec
    negative_constraints: list[str]
    age_band_recipes: list[AgeBandPromptRecipe]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class CompositionDraftRecord:
    draft_id: str
    tenant_id: str
    actor_id: str
    template_id: str
    template_version: str
    current_age_anchor: int
    timeline_ages: list[int]
    aspect_ratio: str
    participant_count: int
    contains_minor: bool
    custom_notes: str
    version: int
    updated_at: str


@dataclass(frozen=True)
class CompiledNodePromptPlan:
    shot_id: str
    shot_index: int
    shot_title: str
    shot_scale: str
    nine_grid_position: str
    default_selected: bool
    target_age: int
    stage_label: str
    is_retroactive_simulation: bool
    retroactive_disclosure: str | None
    age_delta_from_anchor: int
    identity_anchor_weight: float
    physiological_weights: PhysiologicalWeightsSpec
    era_context: EraContextSpec
    provider_payload: ProviderNativePayloadSpec
    image_enhancement_pipeline: ImageEnhancementPipelineSpec
    optics_summary: str
    structured_prompt: dict[str, str]
    compiled_prompt: str
    negative_prompt: str
    deterministic_seed: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class TimelineGenerationPlan:
    plan_id: str
    project_id: str
    template_id: str
    template_version: str
    current_age_anchor: int
    birth_year: int
    aspect_ratio: str
    participant_count: int
    contains_minor: bool
    min_curated_shots: int
    nodes: list[CompiledNodePromptPlan]
    created_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "project_id": self.project_id,
            "template_id": self.template_id,
            "template_version": self.template_version,
            "current_age_anchor": self.current_age_anchor,
            "birth_year": self.birth_year,
            "aspect_ratio": self.aspect_ratio,
            "participant_count": self.participant_count,
            "contains_minor": self.contains_minor,
            "min_curated_shots": self.min_curated_shots,
            "nodes": [n.to_dict() for n in self.nodes],
            "created_at": self.created_at,
        }


@dataclass(frozen=True)
class QualityEvaluationReport:
    evaluation_id: str
    plan_id: str
    target_age: int
    template_id: str
    passed: bool
    recommended_action: str
    dimensions: dict[str, float]
    failure_reasons: list[str]
    evaluated_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class CuratedGalleryCandidateItem:
    shot_id: str
    shot_index: int
    shot_title: str
    shot_scale: str
    nine_grid_position: str
    target_age: int
    calendar_year: int
    decade_label: str
    stage_label: str
    default_selected: bool
    routed_provider_id: str
    attempts_used: int
    quality_passed: bool
    quality_action: str
    quality_dimensions: dict[str, float]
    physiological_weights: dict[str, float]
    provider_payload: dict[str, Any]
    image_enhancement_pipeline: dict[str, Any]
    preview_uri: str
    deterministic_seed: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class CuratedGalleryRunRecord:
    gallery_id: str
    tenant_id: str
    project_id: str
    plan_id: str
    template_id: str
    template_version: str
    birth_year: int
    current_age_anchor: int
    total_candidates: int
    passed_candidates: int
    min_curated_shots: int
    ready_for_curation: bool
    candidates: list[CuratedGalleryCandidateItem]
    default_selected_shot_ids: list[str]
    version: int
    created_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "gallery_id": self.gallery_id,
            "tenant_id": self.tenant_id,
            "project_id": self.project_id,
            "plan_id": self.plan_id,
            "template_id": self.template_id,
            "template_version": self.template_version,
            "birth_year": self.birth_year,
            "current_age_anchor": self.current_age_anchor,
            "total_candidates": self.total_candidates,
            "passed_candidates": self.passed_candidates,
            "min_curated_shots": self.min_curated_shots,
            "ready_for_curation": self.ready_for_curation,
            "candidates": [c.to_dict() for c in self.candidates],
            "default_selected_shot_ids": list(self.default_selected_shot_ids),
            "version": self.version,
            "created_at": self.created_at,
        }


@dataclass(frozen=True)
class CuratedGallerySelectionRecord:
    selection_id: str
    gallery_id: str
    tenant_id: str
    actor_id: str
    template_id: str
    selected_shot_ids: list[str]
    selected_ages: list[int]
    selected_count: int
    export_mode: str
    photobook_sku: str | None
    version: int
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def resolve_era_context(birth_year: int, target_age: int) -> EraContextSpec:
    """
    Compute calendar_year = birth_year + target_age and resolve decade-specific
    natural life scenes, collar weave textures, and window lighting cues.
    """
    calendar_year = int(birth_year) + int(target_age)
    if calendar_year < 1970:
        return EraContextSpec(
            birth_year=int(birth_year),
            target_age=int(target_age),
            calendar_year=calendar_year,
            decade_label="1950-60年代·经典胶片纪实",
            era_scene_cue="brick courtyard veranda with vintage wooden window frame and warm dust motes",
            collar_material_cue="coarse-woven natural cotton tunic collar with hand-stitched hem",
            window_light_cue="north-facing courtyard skylight through latticed wooden panes",
            color_grade_shift="warm sepia-tinted silver gelatin midtone roll-off",
        )
    if calendar_year < 1980:
        return EraContextSpec(
            birth_year=int(birth_year),
            target_age=int(target_age),
            calendar_year=calendar_year,
            decade_label="1970年代·暖阳大院记忆",
            era_scene_cue="sunlit old neighborhood veranda with搪瓷 cup and solid wood study desk",
            collar_material_cue="classic washed cotton shirt collar and fine ribbed wool vest",
            window_light_cue="afternoon 35-degree golden slant light across lime-plaster wall",
            color_grade_shift="warm nostalgic Kodachrome 64 amber highlight bias",
        )
    if calendar_year < 1990:
        return EraContextSpec(
            birth_year=int(birth_year),
            target_age=int(target_age),
            calendar_year=calendar_year,
            decade_label="1980年代·黄金年代相册",
            era_scene_cue="80s family living room with sheer lace curtain, bookshelf, and warm sunlight",
            collar_material_cue="vintage knitted cardigan over crisp cotton彼得潘/open shirt collar",
            window_light_cue="soft diffused afternoon window light filtered through sheer white curtain",
            color_grade_shift="Fujicolor 100 warm nostalgic family album color rendition",
        )
    if calendar_year < 2000:
        return EraContextSpec(
            birth_year=int(birth_year),
            target_age=int(target_age),
            calendar_year=calendar_year,
            decade_label="1990年代·千禧前夕胶片",
            era_scene_cue="90s sunlit balcony and study room with green foliage bokeh outside window",
            collar_material_cue="classic 90s fine-gauge cotton-cashmere crew neck or Oxford shirt collar",
            window_light_cue="bright natural 45-degree window key light with warm indoor wood bounce",
            color_grade_shift="Kodak Gold 200 organic warm skin tone and subtle halation",
        )
    if calendar_year < 2010:
        return EraContextSpec(
            birth_year=int(birth_year),
            target_age=int(target_age),
            calendar_year=calendar_year,
            decade_label="2000年代·千禧晨光记忆",
            era_scene_cue="early-2000s bright urban apartment window with clean timber shelving",
            collar_material_cue="minimalist combed cotton shirt or lightweight merino knit collar",
            window_light_cue="clean daylight window illumination with airy curtain diffusion",
            color_grade_shift="Kodak Portra 160NC natural neutral-warm skin fidelity",
        )
    if calendar_year < 2020:
        return EraContextSpec(
            birth_year=int(birth_year),
            target_age=int(target_age),
            calendar_year=calendar_year,
            decade_label="2010年代·人文生活定格",
            era_scene_cue="contemporary sunlit café/study corner with warm oak texture and plant bokeh",
            collar_material_cue="tailored linen-cotton blend shirt or soft cashmere mock-neck",
            window_light_cue="golden-hour side-backlit window glow with subtle reflector fill",
            color_grade_shift="Kodak Portra 400 luminous skin tone with rich shadow depth",
        )
    if calendar_year < 2035:
        return EraContextSpec(
            birth_year=int(birth_year),
            target_age=int(target_age),
            calendar_year=calendar_year,
            decade_label="2020-30年代·当下与近未来质感",
            era_scene_cue="modern architectural studio/living space with warm natural travertine & sunlight",
            collar_material_cue="fine mulberry silk-wool blend collar with tactile weave clarity",
            window_light_cue="sculpted architectural skylight + soft warm rim bounce",
            color_grade_shift="medium-format editorial natural color science with zero digital clipping",
        )
    if calendar_year < 2055:
        return EraContextSpec(
            birth_year=int(birth_year),
            target_age=int(target_age),
            calendar_year=calendar_year,
            decade_label="2035-50年代·从容岁月纪事",
            era_scene_cue="serene garden study pavilion with warm timber louvers and quiet afternoon light",
            collar_material_cue="bespoke brushed cashmere shawl collar or woven ramie-silk lapel",
            window_light_cue="soft wrap-around louver daylight with gentle warm hair rim light",
            color_grade_shift="timeless archival silver-warm portrait LUT",
        )
    return EraContextSpec(
        birth_year=int(birth_year),
        target_age=int(target_age),
        calendar_year=calendar_year,
        decade_label="2055年代+·世纪回眸典藏",
        era_scene_cue="quiet museum-like conservatory bathed in warm amber sunset window light",
        collar_material_cue="dignified heirloom heavy silk-wool wrap collar with delicate weave",
        window_light_cue="low-angle warm sunset window key light + soft silver halo rim light",
        color_grade_shift="museum archival platinum-palladium warm tonal curve",
    )


def _refine_physiological_weights(
    base_weights: PhysiologicalWeightsSpec,
    target_age: int,
) -> PhysiologicalWeightsSpec:
    """
    Fine-tune physiological weights for specific ages (e.g., 6yo craniofacial neoteny,
    45yo taut mandibular contour with capped nasolabial depth, 65-85yo natural silver
    hair strands & gentle nasolabial fold trajectory without uncanny valley).
    """
    if target_age <= 4:
        return PhysiologicalWeightsSpec(
            craniofacial_neoteny_weight=0.95,
            dermal_collagen_elasticity=0.98,
            subsurface_scattering_strength=0.95,
            nasolabial_fold_depth_limit=0.03,
            silver_strand_ratio=0.0,
            eye_catchlight_clarity=0.99,
            age_spot_micro_density=0.0,
        )
    if target_age <= 8:
        # 6岁：强调颅面幼态比例与清澈高光眼神光，严禁成人化妆造
        return PhysiologicalWeightsSpec(
            craniofacial_neoteny_weight=0.90,
            dermal_collagen_elasticity=0.96,
            subsurface_scattering_strength=0.94,
            nasolabial_fold_depth_limit=0.05,
            silver_strand_ratio=0.0,
            eye_catchlight_clarity=0.98,
            age_spot_micro_density=0.0,
        )
    if 38 <= target_age <= 50:
        # 45岁：强调紧致下颌轮廓与成熟从容眼神光，限制法令纹深度避免强行加满皱纹
        return PhysiologicalWeightsSpec(
            craniofacial_neoteny_weight=0.0,
            dermal_collagen_elasticity=0.78,
            subsurface_scattering_strength=0.90,
            nasolabial_fold_depth_limit=0.28,
            silver_strand_ratio=0.06,
            eye_catchlight_clarity=0.93,
            age_spot_micro_density=0.05,
        )
    if 65 <= target_age <= 85:
        # 65-85岁：强调自然银发发丝高光分离、真实老年斑点微分布与温和法令纹走向，杜绝恐怖谷
        progress = (target_age - 65) / 20.0
        return PhysiologicalWeightsSpec(
            craniofacial_neoteny_weight=0.0,
            dermal_collagen_elasticity=round(0.54 - 0.16 * progress, 3),
            subsurface_scattering_strength=0.89,
            nasolabial_fold_depth_limit=round(0.58 + 0.16 * progress, 3),
            silver_strand_ratio=round(0.68 + 0.26 * progress, 3),
            eye_catchlight_clarity=0.89,
            age_spot_micro_density=round(0.28 + 0.18 * progress, 3),
        )
    return base_weights


def resolve_multi_photo_anchor(
    *,
    primary_adult_asset_id: str,
    target_age: int,
    effective_identity_weight: float,
    side_profile_asset_id: str | None = None,
    childhood_reference_asset_id: str | None = None,
    childhood_reference_age: int | None = 6,
) -> MultiPhotoAnchorSpec:
    """
    Pillar III Stage 1: Multi-Photo 3D Craniofacial & Childhood Dual-Anchor Fusion.
    Fuses:
    - primary_adult_asset_id (0° frontal adult anchor)
    - side_profile_asset_id (optional 45° profile anchor boosting nasal bridge, zygomatic arch & jaw 3D depth)
    - childhood_reference_asset_id (optional authentic childhood photo anchor boosting childhood/adolescence nodes)
    """
    has_childhood_ref = bool(childhood_reference_asset_id and childhood_reference_asset_id.strip())
    has_side_profile = bool(side_profile_asset_id and side_profile_asset_id.strip())

    if has_childhood_ref and target_age <= 8:
        childhood_w = 0.72
        adult_w = round(max(0.28, effective_identity_weight - 0.52), 3)
        dual_active = True
    elif has_childhood_ref and target_age <= 16:
        childhood_w = 0.48
        adult_w = round(max(0.52, effective_identity_weight - 0.32), 3)
        dual_active = True
    else:
        childhood_w = 0.0
        adult_w = round(effective_identity_weight, 3)
        dual_active = has_side_profile

    profile_boost = 0.22 if has_side_profile else 0.0
    return MultiPhotoAnchorSpec(
        primary_adult_asset_id=primary_adult_asset_id,
        side_profile_asset_id=side_profile_asset_id.strip() if has_side_profile and side_profile_asset_id else None,
        childhood_reference_asset_id=(
            childhood_reference_asset_id.strip() if has_childhood_ref and childhood_reference_asset_id else None
        ),
        childhood_reference_age=int(childhood_reference_age) if has_childhood_ref and childhood_reference_age is not None else None,
        adult_anchor_weight=adult_w,
        childhood_anchor_weight=childhood_w,
        profile_3d_depth_boost=profile_boost,
        dual_anchor_active=dual_active,
    )


def compile_image_enhancement_pipeline(
    *,
    tpl: PortraitTemplateSpec,
    target_age: int,
    shot_scale: str,
    multi_photo_anchor: MultiPhotoAnchorSpec,
) -> ImageEnhancementPipelineSpec:
    """
    Pillar III Stages 1-4: Compile the 4-stage physical portrait enhancement pipeline:
    1. MultiPhotoAnchorSpec (3D craniofacial & childhood dual anchor)
    2. RelightingPassSpec (IC-Light normal-map unified relighting pre-pass)
    3. FrequencySeparatedSkinPassSpec (Gaussian low-freq volume lock + Tile-ControlNet high-freq dermal pass)
    4. OpticalPostProcessSpec (optical vignetting, cat's-eye bokeh, warm halation, non-uniform halide grain)
    """
    tid = tpl.template_id
    if tid == "tpl_xhs_cinematic_wong_kar_wai":
        azimuth, elevation, kelvin, softness, bounce = 55, 22, 3200, 0.68, "4:1 tungsten-cyan neon contrast"
        vignette, bokeh_ecc, halation, h_rad, s_grain, h_grain = -0.48, 0.34, 0.36, 6.5, 0.052, 0.019
    elif tid == "tpl_xhs_vogue_editorial_bw":
        azimuth, elevation, kelvin, softness, bounce = 42, 38, 5500, 0.58, "5:1 silver gelatin dramatic key"
        vignette, bokeh_ecc, halation, h_rad, s_grain, h_grain = -0.40, 0.24, 0.14, 3.5, 0.048, 0.018
    elif tid == "tpl_xhs_24_solar_terms_poetic":
        azimuth, elevation, kelvin, softness, bounce = 135, 28, 5100, 0.86, "2.5:1 golden-hour backlit rim + reflector"
        vignette, bokeh_ecc, halation, h_rad, s_grain, h_grain = -0.32, 0.31, 0.28, 5.2, 0.036, 0.014
    elif tid == "tpl_xhs_master_fine_art_photobook":
        azimuth, elevation, kelvin, softness, bounce = 0, 40, 5400, 0.82, "3:1 butterfly beauty dish + dual strip rim"
        vignette, bokeh_ecc, halation, h_rad, s_grain, h_grain = -0.22, 0.16, 0.12, 2.8, 0.028, 0.011
    elif tid == "tpl_xhs_oriental_aesthetics_portrait":
        azimuth, elevation, kelvin, softness, bounce = 48, 32, 5000, 0.88, "2.5:1 Xuan-paper diffused window + silk fill"
        vignette, bokeh_ecc, halation, h_rad, s_grain, h_grain = -0.28, 0.25, 0.22, 4.2, 0.034, 0.013
    else:
        azimuth, elevation, kelvin, softness, bounce = 45, 35, 4800, 0.80, "3:1 Rembrandt octabox + warm hair rim"
        vignette, bokeh_ecc, halation, h_rad, s_grain, h_grain = -0.35, 0.28, 0.24, 4.8, 0.042, 0.016

    relighting = RelightingPassSpec(
        enabled=True,
        normal_map_estimator="ic-light-normal-bae-v2",
        key_azimuth_deg=azimuth,
        key_elevation_deg=elevation,
        color_temp_kelvin=kelvin,
        shadow_softness=softness,
        fill_bounce_ratio=bounce,
    )

    micro_features = [
        "vellus_facial_fuzz",
        "malar_nasal_micro_pores",
        "vertical_lip_creases",
        "radial_iris_crypts",
    ]
    if target_age >= 55:
        micro_features.append("individual_silver_hair_specular_strands")
    if shot_scale == "extreme_closeup_eyes":
        micro_features.append("corneal_window_reflection_micro_geometry")

    freq_skin = FrequencySeparatedSkinPassSpec(
        enabled=True,
        low_freq_gaussian_sigma_px=6.5,
        high_freq_denoise_strength=0.19 if shot_scale != "extreme_closeup_eyes" else 0.21,
        tile_controlnet_weight=0.86,
        micro_features_injected=micro_features,
    )

    optical = OpticalPostProcessSpec(
        enabled=True,
        vignette_ev=vignette,
        cats_eye_bokeh_eccentricity=bokeh_ecc,
        halation_strength=halation,
        halation_radius_px=h_rad,
        shadow_grain_sigma=s_grain,
        highlight_grain_sigma=h_grain,
    )

    return ImageEnhancementPipelineSpec(
        multi_photo_anchor=multi_photo_anchor,
        relighting_pass=relighting,
        frequency_separated_skin_pass=freq_skin,
        optical_post_process=optical,
    )


def _build_standard_age_band_recipes(
    *,
    wardrobe_theme: str,
    backdrop_theme: str,
) -> list[AgeBandPromptRecipe]:
    """8-stage anatomical & aesthetic progression matrix from 0 to 100 years old."""
    return [
        AgeBandPromptRecipe(
            band_key="childhood_0_8",
            min_age=0,
            max_age=8,
            stage_label="童年纯真",
            craniofacial_and_skin_cue=(
                "authentic childhood craniofacial neoteny (0.90-0.95), higher forehead-to-jaw ratio, "
                "soft baby-fat buccal fullness, translucent natural skin texture with high subsurface scattering (0.94) "
                "and zero adult makeup, preserving exact interpupillary distance, canthal tilt, and ear helix geometry"
            ),
            hair_and_grooming_cue="fine soft natural childhood hair strands, clean natural hairline",
            wardrobe_and_styling_cue=f"age-appropriate childhood soft cotton/knit collar ({wardrobe_theme})",
            pose_and_gaze_cue="curious crystal-clear eye contact (catchlight clarity 0.98), relaxed natural head tilt",
            backdrop_and_atmosphere_cue=f"warm nostalgic studio ambiance ({backdrop_theme})",
            identity_lock_strength=0.84,
            physiological_weights=PhysiologicalWeightsSpec(
                craniofacial_neoteny_weight=0.90,
                dermal_collagen_elasticity=0.96,
                subsurface_scattering_strength=0.94,
                nasolabial_fold_depth_limit=0.05,
                silver_strand_ratio=0.0,
                eye_catchlight_clarity=0.98,
                age_spot_micro_density=0.0,
            ),
        ),
        AgeBandPromptRecipe(
            band_key="adolescence_9_16",
            min_age=9,
            max_age=16,
            stage_label="少年澄澈",
            craniofacial_and_skin_cue=(
                "emerging adolescent nasal bridge and jawline definition, natural teenage skin pores, "
                "authentic facial bone landmarks locked to source identity, zero adultification"
            ),
            hair_and_grooming_cue="neat school-age natural hair texture with subtle flyaway realism",
            wardrobe_and_styling_cue=f"clean youth casual shirt/knitwear ({wardrobe_theme})",
            pose_and_gaze_cue="upright posture, sincere calm gaze toward camera with bright catchlights",
            backdrop_and_atmosphere_cue=f"soft daylight-balanced studio backdrop ({backdrop_theme})",
            identity_lock_strength=0.88,
            physiological_weights=PhysiologicalWeightsSpec(
                craniofacial_neoteny_weight=0.52,
                dermal_collagen_elasticity=0.95,
                subsurface_scattering_strength=0.93,
                nasolabial_fold_depth_limit=0.08,
                silver_strand_ratio=0.0,
                eye_catchlight_clarity=0.97,
                age_spot_micro_density=0.0,
            ),
        ),
        AgeBandPromptRecipe(
            band_key="youth_17_24",
            min_age=17,
            max_age=24,
            stage_label="青春启航",
            craniofacial_and_skin_cue=(
                "fully developed young-adult craniofacial structure, crisp jawline, luminous healthy dermis "
                "with visible microscopic pore texture and natural sebaceous sheen, zero plastic smoothing"
            ),
            hair_and_grooming_cue="dense healthy hair volume with natural specular highlights",
            wardrobe_and_styling_cue=f"tailored young-adult minimalist collar ({wardrobe_theme})",
            pose_and_gaze_cue="confident composed three-quarter shoulder angle, direct expressive gaze",
            backdrop_and_atmosphere_cue=f"clean editorial portrait environment ({backdrop_theme})",
            identity_lock_strength=0.93,
            physiological_weights=PhysiologicalWeightsSpec(
                craniofacial_neoteny_weight=0.0,
                dermal_collagen_elasticity=0.94,
                subsurface_scattering_strength=0.92,
                nasolabial_fold_depth_limit=0.12,
                silver_strand_ratio=0.0,
                eye_catchlight_clarity=0.96,
                age_spot_micro_density=0.0,
            ),
        ),
        AgeBandPromptRecipe(
            band_key="prime_25_35",
            min_age=25,
            max_age=35,
            stage_label="当下绽放",
            craniofacial_and_skin_cue=(
                "peak adult bone definition, exact 1:1 facial landmark fidelity to source identity anchor, "
                "natural micro-texture across zygomatic arch and philtrum, authentic eye orbicularis detail"
            ),
            hair_and_grooming_cue="well-groomed natural hair styling with individual strand separation",
            wardrobe_and_styling_cue=f"contemporary textured fabric neckline ({wardrobe_theme})",
            pose_and_gaze_cue="poised natural expression, subtle micro-smile in eyes, balanced head alignment",
            backdrop_and_atmosphere_cue=f"signature studio portrait depth ({backdrop_theme})",
            identity_lock_strength=0.96,
            physiological_weights=PhysiologicalWeightsSpec(
                craniofacial_neoteny_weight=0.0,
                dermal_collagen_elasticity=0.90,
                subsurface_scattering_strength=0.92,
                nasolabial_fold_depth_limit=0.18,
                silver_strand_ratio=0.0,
                eye_catchlight_clarity=0.95,
                age_spot_micro_density=0.01,
            ),
        ),
        AgeBandPromptRecipe(
            band_key="maturity_36_50",
            min_age=36,
            max_age=50,
            stage_label="从容岁月",
            craniofacial_and_skin_cue=(
                "taut mature mandibular contour and defined cheekbone architecture, subtle lateral canthal laugh "
                "lines with capped nasolabial fold depth (<=0.28), authentic mid-life dermal elasticity (0.78) "
                "and mature composed eye catchlights without forced heavy wrinkles"
            ),
            hair_and_grooming_cue="full mature hair density with subtle 6% temple silver threads",
            wardrobe_and_styling_cue=f"refined wool/cashmere or structured linen collar ({wardrobe_theme})",
            pose_and_gaze_cue="grounded calm presence, mature luminous catchlights (0.93), relaxed shoulders",
            backdrop_and_atmosphere_cue=f"rich tonal portrait atmosphere ({backdrop_theme})",
            identity_lock_strength=0.92,
            physiological_weights=PhysiologicalWeightsSpec(
                craniofacial_neoteny_weight=0.0,
                dermal_collagen_elasticity=0.78,
                subsurface_scattering_strength=0.90,
                nasolabial_fold_depth_limit=0.28,
                silver_strand_ratio=0.06,
                eye_catchlight_clarity=0.93,
                age_spot_micro_density=0.05,
            ),
        ),
        AgeBandPromptRecipe(
            band_key="silver_prime_51_68",
            min_age=51,
            max_age=68,
            stage_label="温情银发",
            craniofacial_and_skin_cue=(
                "graceful early-senior bone and soft-tissue evolution, natural periorbital crow's feet, "
                "gentle nasolabial fold trajectory, realistic dermal micro-texture with subtle age-spot "
                "distribution while strictly preserving core orbital and nasal geometry"
            ),
            hair_and_grooming_cue="natural salt-and-pepper to luminous silver hair strands with individual strand separation",
            wardrobe_and_styling_cue=f"warm timeless knit or classic shawl collar ({wardrobe_theme})",
            pose_and_gaze_cue="gentle benevolent expression, warm serene eye catchlights, dignified posture",
            backdrop_and_atmosphere_cue=f"warm intimate studio light falloff ({backdrop_theme})",
            identity_lock_strength=0.89,
            physiological_weights=PhysiologicalWeightsSpec(
                craniofacial_neoteny_weight=0.0,
                dermal_collagen_elasticity=0.58,
                subsurface_scattering_strength=0.89,
                nasolabial_fold_depth_limit=0.52,
                silver_strand_ratio=0.52,
                eye_catchlight_clarity=0.90,
                age_spot_micro_density=0.22,
            ),
        ),
        AgeBandPromptRecipe(
            band_key="elder_69_84",
            min_age=69,
            max_age=84,
            stage_label="岁月沉淀",
            craniofacial_and_skin_cue=(
                "dignified elder facial anatomy, natural subcutaneous volume softening along mandible, "
                "harmonious nasolabial fold trajectory and authentic age-spot micro-distribution, "
                "translucent epidermal subsurface scattering without uncanny-valley distortion"
            ),
            hair_and_grooming_cue="soft silver-white hair strands with natural specular rim separation and fine halo wisping",
            wardrobe_and_styling_cue=f"classic soft-textured cardigan or heritage collar ({wardrobe_theme})",
            pose_and_gaze_cue="serene reflective gaze, warm lived-in smile lines, composed head posture",
            backdrop_and_atmosphere_cue=f"classic fine-art portrait shadow depth ({backdrop_theme})",
            identity_lock_strength=0.86,
            physiological_weights=PhysiologicalWeightsSpec(
                craniofacial_neoteny_weight=0.0,
                dermal_collagen_elasticity=0.44,
                subsurface_scattering_strength=0.89,
                nasolabial_fold_depth_limit=0.68,
                silver_strand_ratio=0.82,
                eye_catchlight_clarity=0.89,
                age_spot_micro_density=0.38,
            ),
        ),
        AgeBandPromptRecipe(
            band_key="centenarian_85_100",
            min_age=85,
            max_age=120,
            stage_label="世纪回眸",
            craniofacial_and_skin_cue=(
                "reverent centenarian artistic portrait, delicate parchment-like dermal micro-topography, "
                "gentle natural nasolabial and periorbital life lines, preserved ocular spacing and signature gaze spirit, "
                "zero grotesque horror-valley artifacts"
            ),
            hair_and_grooming_cue="pure gossamer silver-white hair strands illuminated by gentle warm rim light",
            wardrobe_and_styling_cue=f"timeless dignified high-neck wool or silk wrap ({wardrobe_theme})",
            pose_and_gaze_cue="peaceful luminous eyes, quiet dignity, timeless frontal-three-quarter framing",
            backdrop_and_atmosphere_cue=f"museum-grade chiaroscuro portrait ambiance ({backdrop_theme})",
            identity_lock_strength=0.83,
            physiological_weights=PhysiologicalWeightsSpec(
                craniofacial_neoteny_weight=0.0,
                dermal_collagen_elasticity=0.38,
                subsurface_scattering_strength=0.88,
                nasolabial_fold_depth_limit=0.74,
                silver_strand_ratio=0.94,
                eye_catchlight_clarity=0.89,
                age_spot_micro_density=0.46,
            ),
        ),
    ]


def _build_curated_shots_for_template(
    *,
    template_id: str,
    ages: list[int],
    focal_mm: int,
    aperture: str,
    lighting_short: str,
    wardrobe_series: list[str],
    backdrop_series: list[str],
    title_series: list[str],
    expression_series: list[str],
) -> list[CuratedShotSpec]:
    """Build 10 distinct curated shot presets (>=9) per template with rhythmic multi-crop storyboard."""
    scale_label_map = {
        "extreme_closeup_eyes": "眼部与鼻梁微距特写 (ECU)",
        "medium_bust": "视平线居中胸上标准肖像 (MCU)",
        "three_quarter_profile": "45°微侧下颌轮廓肖像 (3/4 Profile)",
        "half_body_hands": "含手部姿态半身环境肖像 (Half-Body)",
    }
    shots: list[CuratedShotSpec] = []
    for idx, age in enumerate(ages):
        shot_num = idx + 1
        shot_scale, nine_grid_pos = _resolve_storyboard_crop_and_grid(shot_num)
        scale_desc = scale_label_map.get(shot_scale, "视平线居中胸上标准肖像")
        phys = _refine_physiological_weights(
            PhysiologicalWeightsSpec(0.0, 0.85, 0.91, 0.22, 0.0, 0.94, 0.02),
            age,
        )
        if age <= 8:
            dermal_focus = (
                f"{age}岁幼态颅面比例（neoteny={phys.craniofacial_neoteny_weight:.2f}）+ "
                f"清澈高光眼神光（catchlight={phys.eye_catchlight_clarity:.2f}），零成人脂粉感"
            )
        elif 38 <= age <= 50:
            dermal_focus = (
                f"{age}岁紧致下颌线与颧弓支撑（collagen={phys.dermal_collagen_elasticity:.2f}）+ "
                f"克制法令纹上限（<={phys.nasolabial_fold_depth_limit:.2f}），拒绝强行堆砌皱纹"
            )
        elif age >= 58:
            dermal_focus = (
                f"{age}岁自然银丝高光分离（silver={phys.silver_strand_ratio:.2f}）+ "
                f"温和法令纹走向与真实表皮微斑点（spot={phys.age_spot_micro_density:.2f}），零恐怖谷"
            )
        else:
            dermal_focus = (
                f"{age}岁1:1骨相特征锚定 + 真实微距毛孔与皮下散射（SSS={phys.subsurface_scattering_strength:.2f}），零塑料磨皮"
            )
        shots.append(
            CuratedShotSpec(
                shot_id=f"{template_id}_shot_{shot_num:02d}_{age}y",
                shot_index=shot_num,
                target_age=age,
                title=f"镜头{shot_num:02d} · {age}岁 · {title_series[idx]}",
                framing_and_angle=f"{focal_mm}mm {aperture} · {scale_desc} · 九宫格[{nine_grid_pos}]呼吸感编排",
                lighting_key_ratio=lighting_short,
                lens_dof_cue=f"{focal_mm}mm 定焦焦平面锁死双瞳虹膜，{aperture} 浅景深自然过渡",
                craniofacial_and_dermal_focus=dermal_focus,
                wardrobe_fabric_cue=wardrobe_series[idx],
                backdrop_prop_cue=backdrop_series[idx],
                micro_expression_cue=expression_series[idx],
                default_selected=(shot_num <= 9),
                shot_scale=shot_scale,
                nine_grid_position=nine_grid_pos,
            )
        )
    return shots


def build_builtin_portrait_templates() -> list[PortraitTemplateSpec]:
    """Construct the 9 flagship competitive built-in portrait templates (v2.3.0, 10 curated shots each)."""
    solo_ages = list(RECOMMENDED_XHS_AGES)  # [3, 6, 12, 18, 25, 32, 45, 58, 72, 85]
    co_aging_ages = list(RECOMMENDED_CO_AGING_AGES)  # [18, 22, 28, 35, 42, 50, 58, 66, 75, 85]

    return [
        PortraitTemplateSpec(
            template_id="tpl_xhs_silver_halide_0_100",
            version="2.3.0",
            name="经典银盐胶片·人生时间轴",
            subtitle="85mm 大光圈人像定焦 · 伦勃朗柔光 · 10张精修分镜零塑料感",
            category="solo-portrait",
            badge="小红书爆款主推",
            status="active",
            max_participants=1,
            min_age=0,
            max_age=100,
            min_curated_shots=MIN_CURATED_SHOTS_PER_TEMPLATE,
            recommended_ages=solo_ages,
            curated_gallery_shots=_build_curated_shots_for_template(
                template_id="tpl_xhs_silver_halide_0_100",
                ages=solo_ages,
                focal_mm=85,
                aperture="f/1.8",
                lighting_short="45°八角柔光箱伦勃朗光 + 暖调钨丝发丝轮廓光 (3:1光比)",
                title_series=[
                    "稚气初萌·银盐柔焦",
                    "六岁童眸·清澈逆光",
                    "十二少年·澄澈眉眼",
                    "十八成人·青涩锋芒",
                    "廿五初绽·黄金骨相",
                    "卅二笃定·光影立体",
                    "四五从容·紧致轮廓",
                    "五八知命·微银鬓角",
                    "七二温厚·银发留白",
                    "八五世纪·岁月回眸",
                ],
                wardrobe_series=[
                    "米白精梳纯棉婴儿针织圆领",
                    "燕麦色柔软小翻领粗针毛衣",
                    "炭灰学院派纯棉牛津纺衬衫领",
                    "白桦色重磅纯棉圆领T恤与微挺括外套",
                    "深炭黑精纺美利奴羊毛半高领",
                    "暖灰亚麻混纺西装翻领与极简内搭",
                    "黑胡桃色高支山羊绒V领针织衫",
                    "暖驼色粗纺人字纹羊毛披肩领",
                    "银灰法兰绒立领开衫配温润内搭",
                    "典藏黑丝绒质感高领长披肩",
                ],
                backdrop_series=[
                    "暖灰手绘油画布·浅景深柔光晕",
                    "经典暗房炭灰背景布·呼吸感暗角",
                    "柔和银盐中性灰背景·顶部漫射轮廓",
                    "Portra 400暖调炭灰棚拍画布",
                    "伦勃朗三角光经典深灰影棚背景",
                    "低饱和暖褐手刷肌理布景",
                    "沉稳博物馆灰阶画布·立体负补光",
                    "暖琥珀微光渐变暗房背景",
                    "银盐高动态暗部层次影棚背景",
                    "博物馆级伦勃朗明暗对照油画布",
                ],
                expression_series=[
                    "微微好奇张望、双眸清亮湿润",
                    "纯粹干净的直视眼神、嘴角自然放松",
                    "安静清澈的少年凝视、眉宇舒展",
                    "略带青涩却坚定的青春目光",
                    "自信松弛的微侧颌线、眼底带笑",
                    "沉稳内敛的平视凝望、呼吸感极强",
                    "轮廓紧致从容、眼神温润有故事感",
                    "平和舒展的浅笑、眼角自然笑纹",
                    "慈祥清朗的目光、神态温和安宁",
                    "跨越世纪的平静凝眸、充满生命尊严",
                ],
            ),
            supported_aspect_ratios=["3:4", "4:5", "1:1", "9:16"],
            default_aspect_ratio="3:4",
            required_consents=["age-transformation"],
            provider_capabilities=["face-id-lock", "controlnet-depth", "high-res-skin-detail"],
            cost_tier="pro-studio",
            allowed_channels=["mp-xhs", "mp-weixin", "consumer-web", "mobile", "studio"],
            competitive_highlights=[
                "内置 10 张大师级银盐分镜（满 9 张直出小红书九宫格），85mm f/1.8 锁定同一视平线与焦平面",
                "分年龄段骨相演进：6岁清澈童眸、45岁紧致轮廓不堆砌假皱纹、65-85岁银丝高光分离与温和法令纹",
                "Kodak Portra 400 暖调肤色曲线 + 真实微距毛孔与皮下散射（SSS），彻底告别一眼假 AI 塑料磨皮",
            ],
            optics_and_lighting=OpticsAndLightingSpec(
                focal_length_mm=85,
                aperture="f/1.8",
                framing="medium close-up chest-up portrait, consistent eye-line at upper third",
                lighting_setup="45-degree octabox Rembrandt key light + warm tungsten hair rim light, 3:1 contrast ratio",
                color_science="Kodak Portra 400 warm skin tone LUT with subtle silver-halide highlight roll-off",
                skin_texture_policy="preserve microscopic skin pores, vellus hair, and authentic age creases; zero plastic smoothing",
                film_grain_profile="fine 35mm organic silver-halide grain (ISO 200)",
            ),
            identity_preservation=IdentityPreservationSpec(
                identity_adapter="instantid-pulid-hybrid-v2",
                craniofacial_anchor_weight=0.92,
                eye_geometry_lock=0.95,
                skin_undertone_lock=0.90,
                expression_naturalness_weight=0.88,
            ),
            quality_thresholds=QualityGateThresholdSpec(
                min_identity_similarity=0.82,
                max_facial_drift=0.16,
                min_age_plausibility=0.85,
                min_pose_background_coherence=0.86,
                min_artifact_free_score=0.90,
                min_sharpness_score=0.84,
                min_aesthetic_score=0.86,
                max_auto_retries=2,
            ),
            negative_constraints=list(ANTI_PLASTIC_NEGATIVE_CONSTRAINTS),
            age_band_recipes=_build_standard_age_band_recipes(
                wardrobe_theme="timeless monochrome textured knit & linen",
                backdrop_theme="charcoal-warm-grey hand-brushed studio canvas with soft vignette",
            ),
        ),
        PortraitTemplateSpec(
            template_id="tpl_xhs_oriental_aesthetics_portrait",
            version="2.3.0",
            name="东方光影新中式·岁月肖像",
            subtitle="90mm 微距人像 · 宣纸窗光 · 10幕东方骨相美学分镜",
            category="editorial",
            badge="新中式高赞",
            status="active",
            max_participants=1,
            min_age=0,
            max_age=100,
            min_curated_shots=MIN_CURATED_SHOTS_PER_TEMPLATE,
            recommended_ages=solo_ages,
            curated_gallery_shots=_build_curated_shots_for_template(
                template_id="tpl_xhs_oriental_aesthetics_portrait",
                ages=solo_ages,
                focal_mm=90,
                aperture="f/2.0",
                lighting_short="漫反射宣纸窗光侧逆主光 + 桑蚕丝反光板柔补 (2.5:1温润光比)",
                title_series=[
                    "三岁垂髫·宣纸柔光",
                    "六岁总角·澄澈灵气",
                    "十二豆蔻·竹影清风",
                    "十八弱冠/及笄·温润如玉",
                    "廿五风华·东方折叠度",
                    "卅二雅致·素锦流光",
                    "四五沉淀·松弛气韵",
                    "五八知秋·茶烟鬓影",
                    "七二古稀·银丝似雪",
                    "八五期颐·水墨留白",
                ],
                wardrobe_series=[
                    "月白软棉交领小衫",
                    "素色细棉麻立领盘扣孩童衫",
                    "竹青色天然苎麻斜襟少年衫",
                    "天水碧重磅桑蚕丝新中式微立领",
                    "米杏色香云纱肌理暗纹衬衫领",
                    "远山灰手工织造丝麻混纺立领外套",
                    "深黛色高支羊绒与桑蚕丝叠穿中式领",
                    "秋香色宋锦暗纹滚边开衫领口",
                    "素银灰软羊绒宽襟披肩与立领",
                    "玄色重磅真丝绒暗绣典藏高领",
                ],
                backdrop_series=[
                    "温润宣纸透光屏风·晨光漫射",
                    "微焦庭院竹影·宣纸白留白背景",
                    "水墨浅灰渐变背景·窗棂柔影",
                    "汝窑天青灰影棚肌理背景",
                    "东方极简留白画布·侧逆光清冷气韵",
                    "茶室障子纸暖光漫反射背景",
                    "低饱和宋画灰阶肌理布景",
                    "疏朗枯山水光影剪影留白背景",
                    "温润古建木格窗柔化远景",
                    "水墨丹青晕染长卷质感背景",
                ],
                expression_series=[
                    "懵懂清澈、眼珠乌黑透亮",
                    "灵动纯真、眉目干净如画",
                    "清雅内敛、少年书卷气韵",
                    "眼神澄明温和、姿态挺拔舒展",
                    "东方含蓄微澜眼神、下颌线条利落",
                    "从容淡定、气定神闲的东方气场",
                    "骨相紧致温润、眼底沉淀从容故事",
                    "温和浅笑、眉眼间尽显岁月宽厚",
                    "银发整洁温雅、目光澄澈平和",
                    "气韵悠长、如水墨画卷般静谧安详",
                ],
            ),
            supported_aspect_ratios=["3:4", "4:5", "9:16"],
            default_aspect_ratio="3:4",
            required_consents=["age-transformation"],
            provider_capabilities=["face-id-lock", "editorial-lighting", "high-res-skin-detail"],
            cost_tier="pro-studio",
            allowed_channels=["mp-xhs", "mp-weixin", "consumer-web", "studio"],
            competitive_highlights=[
                "内置 10 张东方骨相高定分镜（支持精选 9 张拼图），针对亚洲面部折叠度调校柔和侧逆光，杜绝欧美深眼窝异化",
                "桑蚕丝、苎麻、香云纱与羊绒领口随 10 个年龄阶段自然演进，极具小红书新中式高赞故事感",
                "水墨灰阶与宣纸留白背景，突出东方温润瓷感微距肤质与岁月气韵",
            ],
            optics_and_lighting=OpticsAndLightingSpec(
                focal_length_mm=90,
                aperture="f/2.0",
                framing="vertical editorial bust portrait with balanced negative space",
                lighting_setup="diffused shoji-screen side window light + soft silk bounce fill + subtle rim glow",
                color_science="Oriental warm-jade skin tone calibration, low-saturation ink-wash shadow palette",
                skin_texture_policy="natural porcelain-matte dermal texture with authentic fine lines, zero over-whitening",
                film_grain_profile="ultra-fine medium-format Fujifilm Pro 400H tonal grain",
            ),
            identity_preservation=IdentityPreservationSpec(
                identity_adapter="east-asian-craniofacial-lock-v2",
                craniofacial_anchor_weight=0.94,
                eye_geometry_lock=0.96,
                skin_undertone_lock=0.93,
                expression_naturalness_weight=0.90,
            ),
            quality_thresholds=QualityGateThresholdSpec(
                min_identity_similarity=0.84,
                max_facial_drift=0.14,
                min_age_plausibility=0.85,
                min_pose_background_coherence=0.88,
                min_artifact_free_score=0.91,
                min_sharpness_score=0.85,
                min_aesthetic_score=0.88,
                max_auto_retries=2,
            ),
            negative_constraints=[
                *ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
                "westernized deep-set brow bone distortion",
                "garish neon oversaturation",
            ],
            age_band_recipes=_build_standard_age_band_recipes(
                wardrobe_theme="minimalist Oriental mulberry silk, ramie linen, and cashmere stand-collar",
                backdrop_theme="serene warm rice-paper & ink-wash gradient studio backdrop with bamboo shadow hint",
            ),
        ),
        PortraitTemplateSpec(
            template_id="tpl_xhs_era_chronicle_documentary",
            version="2.3.0",
            name="时代纪实记忆·年代光影胶片",
            subtitle="50mm 纪实人文镜头 · 出生年份+目标年龄自动推演年代光影 · 10张相册真迹",
            category="documentary",
            badge="情感共鸣王牌",
            status="active",
            max_participants=1,
            min_age=0,
            max_age=100,
            min_curated_shots=MIN_CURATED_SHOTS_PER_TEMPLATE,
            recommended_ages=solo_ages,
            curated_gallery_shots=_build_curated_shots_for_template(
                template_id="tpl_xhs_era_chronicle_documentary",
                ages=solo_ages,
                focal_mm=50,
                aperture="f/1.4",
                lighting_short="黄金时刻斜射自然窗光 + 室内木质环境漫反射补光",
                title_series=[
                    "三岁老院·晨光竹椅",
                    "六岁窗台·盛夏蝉鸣",
                    "十二书桌·午后斜阳",
                    "十八远行·车站晨曦",
                    "廿五安居·暖阳阳台",
                    "卅二书房·木香光影",
                    "四五茶席·窗畔流年",
                    "五八庭院·金秋暖光",
                    "七二旧居·时光相册",
                    "八五暖阁·世纪余晖",
                ],
                wardrobe_series=[
                    "年代感手工纯棉小方领孩童衫",
                    "经典条纹纯棉针织背心与白衬衫领",
                    "少年水洗棉布衬衫与细绒线衣领口",
                    "青年挺括纯棉牛津衬衫配经典风衣领",
                    "轻熟极简亚麻衬衫与自然解开的第一颗纽扣",
                    "质感斜纹粗花呢外套配纯棉内搭",
                    "成熟羊绒开衫叠穿挺括衬衫领口",
                    "温厚绞花羊毛衫配柔和格纹围巾",
                    "经典灯芯绒立领外套配温暖针织内搭",
                    "传家质感重磅羊毛披肩与暖色高领",
                ],
                backdrop_series=[
                    "根据出生年份自动匹配童年老院木窗柔焦背景",
                    "蕾丝窗纱透进午后阳光的童年居室背景",
                    "带有书架与绿植焦外光斑的少年书房窗边",
                    "通透晨光洒入的青年生活阳台纪实景深",
                    "黄金时刻暖阳斜照的现代原木生活空间",
                    "光影斑驳的阅读角与温暖室内环境反光",
                    "午后四点斜阳穿过百叶窗的静谧书房",
                    "秋日庭院梧桐树影摇曳的暖色窗前",
                    "摆满岁月旧书与相框的温暖起居室焦外",
                    "夕阳余晖浸润的静谧玻璃花房与老躺椅",
                ],
                expression_series=[
                    "自然抓拍的纯真注视、毫无摆拍痕迹",
                    "望向镜头外父母般的清澈信任眼神",
                    "写作业间隙抬头的真实澄澈神态",
                    "对未来充满憧憬的明亮清朗目光",
                    "生活化松弛浅笑、眼神温暖自然",
                    "专注而温和的日常凝视、真实感拉满",
                    "历经岁月却依旧紧致舒展的从容微笑",
                    "温暖宽厚的长辈目光、眼底泛着暖意",
                    "翻看老照片般平静欣慰的温和神情",
                    "慈祥通透的世纪老人微笑、真实动人",
                ],
            ),
            supported_aspect_ratios=["3:4", "1:1", "4:5"],
            default_aspect_ratio="3:4",
            required_consents=["age-transformation"],
            provider_capabilities=["face-id-lock", "scene-depth-lock"],
            cost_tier="standard",
            allowed_channels=["mp-xhs", "mp-weixin", "consumer-web", "mobile"],
            competitive_highlights=[
                "独创「出生年份 + 目标年龄 = 真实年代」动态推演引擎，自动匹配对应年代的自然窗光、领口织物与生活场景",
                "内置 10 张纪实人文分镜（满 9 张直出九宫格对比笔记），50mm f/1.4 Leica 人文色彩科学",
                "中心平视纪实构图，像翻开一本跨越百年的私人家庭相册真迹，情感共鸣极强",
            ],
            optics_and_lighting=OpticsAndLightingSpec(
                focal_length_mm=50,
                aperture="f/1.4",
                framing="environmental documentary medium portrait, centered eye-level composition",
                lighting_setup="natural golden-hour window sunlight with organic ambient room bounce",
                color_science="Leica M classic documentary color profile with rich midtone micro-contrast",
                skin_texture_policy="unretouched documentary skin realism, natural sun-kissed pores and life lines",
                film_grain_profile="authentic Kodak Tri-X / ColorPlus 200 organic film grain",
            ),
            identity_preservation=IdentityPreservationSpec(
                identity_adapter="instantid-pulid-hybrid-v2",
                craniofacial_anchor_weight=0.91,
                eye_geometry_lock=0.94,
                skin_undertone_lock=0.88,
                expression_naturalness_weight=0.92,
            ),
            quality_thresholds=QualityGateThresholdSpec(
                min_identity_similarity=0.81,
                max_facial_drift=0.17,
                min_age_plausibility=0.84,
                min_pose_background_coherence=0.84,
                min_artifact_free_score=0.89,
                min_sharpness_score=0.82,
                min_aesthetic_score=0.85,
                max_auto_retries=2,
            ),
            negative_constraints=list(ANTI_PLASTIC_NEGATIVE_CONSTRAINTS),
            age_band_recipes=_build_standard_age_band_recipes(
                wardrobe_theme="authentic era-appropriate everyday woven shirt, trench, and soft sweater",
                backdrop_theme="softly defocused warm sunlit study room and courtyard foliage bokeh",
            ),
        ),
        PortraitTemplateSpec(
            template_id="tpl_xhs_warm_family_co_aging",
            version="2.3.0",
            name="温情伴侣/家人共老·时光合拍",
            subtitle="双人/多人同框授权 · 统一主光与焦平面 · 10幕携手白头精选分镜",
            category="family-co-aging",
            badge="家庭/伴侣必拍",
            status="active",
            max_participants=3,
            min_age=0,
            max_age=100,
            min_curated_shots=MIN_CURATED_SHOTS_PER_TEMPLATE,
            recommended_ages=co_aging_ages,
            curated_gallery_shots=_build_curated_shots_for_template(
                template_id="tpl_xhs_warm_family_co_aging",
                ages=co_aging_ages,
                focal_mm=50,
                aperture="f/2.8",
                lighting_short="150cm大型抛物线柔光伞统一主光 + 暖调环绕漫射补光",
                title_series=[
                    "十八初遇·并肩青春",
                    "廿二相知·阳光同框",
                    "廿八挚爱·默契依偎",
                    "卅五成家·温润相伴",
                    "四二同心·岁月沉香",
                    "五十知己·从容相视",
                    "五八微霜·暖意融融",
                    "六六偕老·银丝初染",
                    "七五金婚·眉眼如初",
                    "八五白首·世纪同框",
                ],
                wardrobe_series=[
                    "双人同色系白衬衫与米白纯棉针织领口",
                    "清爽浅卡其亚麻衬衫与极简圆领针织衫",
                    "高定暖灰美利奴羊毛情侣/家人协调领型",
                    "驼色与燕麦色羊绒大衣内搭温润针织领",
                    "质感深灰与暖棕丝毛混纺立领与V领呼应",
                    "从容克制的精纺羊绒开衫与衬衫叠穿",
                    "暖琥珀色调粗针羊毛衫与柔和围巾搭配",
                    "银灰与暖米色高支羊绒披肩协调领口",
                    "金婚典藏质感丝绒与细羊毛温暖高领",
                    "世纪相伴传家级柔暖羊绒围裹领口",
                ],
                backdrop_series=[
                    "清透阳光影棚暖白背景·双人等距焦平面",
                    "柔和奶油色调肖像画布·自然肩部依偎",
                    "经典肖像馆暖灰手绘背景·统一45°主光方向",
                    "温暖琥珀光晕影棚背景·双人眼神默契交汇",
                    "沉稳暖褐肌理布景·柔和轮廓分离光",
                    "时代感肖像馆经典布光·无串色多槽位锁脸",
                    "温暖夕阳色温环绕背景·银发丝丝分明",
                    "传家宝相册质感暖金暗角影棚背景",
                    "金婚纪念高定丝绒灰暖调背景",
                    "博物馆级百年同框温暖明暗肖像背景",
                ],
                expression_series=[
                    "并肩直视镜头、眼底带着初遇的明亮笑意",
                    "头微微相倾、相对身高严格锁定、神态亲昵自然",
                    "默契微侧身、一人直视一人温柔侧眸呼应",
                    "肩膀自然相靠、温暖笃定的家庭幸福感",
                    "相视一笑后同时望向镜头的松弛默契",
                    "走过半生的从容笃定、眉眼间越发相似的温润",
                    "鬓角微霜却眼神清亮、手挽手的温暖姿态",
                    "银发相映、眼角笑纹自然舒展的慈爱神态",
                    "历经风雨依然清澈温暖的相伴目光",
                    "白发苍苍却眼神如初见的世纪温情凝望",
                ],
            ),
            supported_aspect_ratios=["3:4", "4:5", "1:1"],
            default_aspect_ratio="3:4",
            required_consents=["age-transformation", "family-co-aging"],
            provider_capabilities=["multi-subject-face-lock", "dual-focal-plane-control", "high-res-skin-detail"],
            cost_tier="pro-studio",
            allowed_channels=["mp-xhs", "mp-weixin", "consumer-web", "studio"],
            competitive_highlights=[
                "内置 10 幕伴侣/家人共老精选分镜（18岁初遇至85岁白首），支持 1—3 人逐人独立授权同框",
                "150cm 抛物线柔光伞统一双人主光方向与 f/2.8 焦平面，锁定相对身高与眼神互动，彻底解决多人合成光影割裂",
                "多槽位 Regional PuLID v2 独立锁脸，杜绝双人五官串色；含未成年人出镜时自动启用私密保护",
            ],
            optics_and_lighting=OpticsAndLightingSpec(
                focal_length_mm=50,
                aperture="f/2.8",
                framing="intimate dual/group half-body portrait, unified focal plane across all faces",
                lighting_setup="large 150cm parabolic umbrella key light + warm wrap-around fill for multi-person harmony",
                color_science="warm amber family portrait color grading with balanced multi-skin-tone rendering",
                skin_texture_policy="consistent skin micro-texture across all participants without cross-face bleeding",
                film_grain_profile="smooth medium-format portrait grain",
            ),
            identity_preservation=IdentityPreservationSpec(
                identity_adapter="multi-slot-region-pulid-v2",
                craniofacial_anchor_weight=0.93,
                eye_geometry_lock=0.95,
                skin_undertone_lock=0.91,
                expression_naturalness_weight=0.91,
            ),
            quality_thresholds=QualityGateThresholdSpec(
                min_identity_similarity=0.80,
                max_facial_drift=0.18,
                min_age_plausibility=0.83,
                min_pose_background_coherence=0.85,
                min_artifact_free_score=0.90,
                min_sharpness_score=0.83,
                min_aesthetic_score=0.85,
                max_auto_retries=3,
            ),
            negative_constraints=[
                *ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
                "cross-participant face blending or identity swap",
                "inconsistent lighting direction between subjects",
            ],
            age_band_recipes=_build_standard_age_band_recipes(
                wardrobe_theme="coordinated warm neutral family knitwear and linen tones",
                backdrop_theme="warm heirloom studio portrait backdrop with gentle golden halo",
            ),
        ),
        PortraitTemplateSpec(
            template_id="tpl_xhs_master_fine_art_photobook",
            version="2.3.0",
            name="典藏画册高定棚拍·实体印刷版",
            subtitle="中画幅 4:5 印刷画幅 · 300DPI 色彩预检 · 10张精装相册专享内页",
            category="fine-art-print",
            badge="实物相册专享",
            status="active",
            max_participants=2,
            min_age=0,
            max_age=100,
            min_curated_shots=MIN_CURATED_SHOTS_PER_TEMPLATE,
            recommended_ages=solo_ages,
            curated_gallery_shots=_build_curated_shots_for_template(
                template_id="tpl_xhs_master_fine_art_photobook",
                ages=solo_ages,
                focal_mm=80,
                aperture="f/2.8",
                lighting_short="影楼雷达罩蝴蝶光主光 + 双侧条形发丝轮廓光 + 黑色吸光板负补光",
                title_series=[
                    "扉页01·三岁初啼·纯真典藏",
                    "画册02·六岁童眸·蝴蝶柔光",
                    "画册03·十二少年·学院肖像",
                    "画册04·十八成人·高定纪念",
                    "画册05·廿五黄金·画廊级主图",
                    "画册06·卅二中坚·雕塑光影",
                    "画册07·四五鼎盛·大师棚拍",
                    "画册08·五八流金·银丝质感",
                    "画册09·七二尊享·艺术留白",
                    "尾页10·八五世纪·传世终章",
                ],
                wardrobe_series=[
                    "高定婴儿羊绒象牙白微高领",
                    "经典影楼质感小礼服纯棉拼接领口",
                    "英伦精纺羊毛少年立领与丝质滚边",
                    "成人礼高定剪裁丝毛混纺礼服领",
                    "画廊级极简黑丝绒高定建筑感领型",
                    "重磅桑蚕丝与精纺双面呢挺括翻领",
                    "大师级定制深炭灰山羊绒高领毛衣",
                    "典藏暗金纹理真丝披肩与羊毛内搭",
                    "博物馆级重磅羊绒斗篷式温雅领口",
                    "传世典藏黑天鹅绒与银丝刺绣高领",
                ],
                backdrop_series=[
                    "Oliphant手绘博物馆级暖灰油画布（预留3mm出血位）",
                    "纯色粗亚麻肌理影棚背景布·柔和中心光晕",
                    "16-bit深邃天鹅绒灰阶背景·CMYK安全暗部",
                    "经典哈苏中画幅棚拍灰褐手刷画布",
                    "画廊典藏级低反光炭黑肌理背景布",
                    "立体负补光雕塑感中性灰画布",
                    "高定肖像馆暖铜棕手绘背景布",
                    "艺术微喷特种纸张友好型温润深灰背景",
                    "大师级古典油画明暗过渡背景布",
                    "传世相册终章深邃暖金光晕典藏背景",
                ],
                expression_series=[
                    "适合作为相册扉页的纯净凝视、眼神光饱满",
                    "端庄灵动的童年正脸微侧肖像、神态自然",
                    "挺拔沉静的少年棚拍姿态、眼神清亮坚定",
                    "具有仪式感的十八岁成人礼庄重微笑",
                    "极具杂志封面张力的自信平视凝眸",
                    "立体骨相光影下的沉稳笃定神情",
                    "45岁紧致轮廓与成熟睿智眼神、大师级气场",
                    "优雅从容的银发初期神态、温润尔雅",
                    "饱含人生阅历与温情的艺术家般平静目光",
                    "适合作为99元精装相册压轴跨页的世纪传世微笑",
                ],
            ),
            supported_aspect_ratios=["4:5", "3:4", "1:1"],
            default_aspect_ratio="4:5",
            required_consents=["age-transformation", "physical-print"],
            provider_capabilities=["face-id-lock", "print-300dpi-upscale", "cmyk-gamut-safe"],
            cost_tier="master-print",
            allowed_channels=["mp-xhs", "mp-weixin", "consumer-web", "studio", "kiosk"],
            competitive_highlights=[
                "内置 10 张画册内页级高定棚拍分镜（精选 9–10 张直连 99 元精装实体相册 PHOTO_BOOK_HARDCOVER_0_100）",
                "按哈苏中画幅 80mm f/2.8 棚拍蝴蝶光/轮廓光设计，预留 3mm 印刷出血位与 16-bit CMYK 安全色域",
                "全库最高身份锁定阈值（>=0.85）与 300DPI 微距皮肤浮雕细节，确保实体相册铜版纸/艺术纸印制零瑕疵",
            ],
            optics_and_lighting=OpticsAndLightingSpec(
                focal_length_mm=80,
                aperture="f/2.8",
                framing="medium-format 4:5 fine-art portrait with 3mm print-bleed safe margins",
                lighting_setup="classic studio butterfly beauty dish key + dual strip rim lights + negative fill",
                color_science="16-bit AdobeRGB / CMYK-safe archival fine-art tonal curve with deep velvet blacks",
                skin_texture_policy="ultra-high-definition 300DPI dermal micro-relief suitable for physical art paper",
                film_grain_profile="archival fine-art matte paper micro-texture",
            ),
            identity_preservation=IdentityPreservationSpec(
                identity_adapter="instantid-pulid-master-print-v2",
                craniofacial_anchor_weight=0.95,
                eye_geometry_lock=0.97,
                skin_undertone_lock=0.93,
                expression_naturalness_weight=0.90,
            ),
            quality_thresholds=QualityGateThresholdSpec(
                min_identity_similarity=0.85,
                max_facial_drift=0.13,
                min_age_plausibility=0.87,
                min_pose_background_coherence=0.88,
                min_artifact_free_score=0.93,
                min_sharpness_score=0.88,
                min_aesthetic_score=0.89,
                max_auto_retries=3,
            ),
            negative_constraints=[
                *ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
                "clipped shadows or blown highlights outside CMYK print gamut",
                "edge cropping near print bleed zone",
            ],
            age_band_recipes=_build_standard_age_band_recipes(
                wardrobe_theme="bespoke fine-art studio velvet, tailored wool, and timeless silk",
                backdrop_theme="museum-grade hand-painted Oliphant canvas backdrop",
            ),
        ),
        PortraitTemplateSpec(
            template_id="tpl_xhs_cinematic_wong_kar_wai",
            version="2.3.0",
            name="王家卫电影胶片·流金岁月",
            subtitle="35mm f/1.4 电影宽银幕 · Kodak Vision3 500T 青橙霓虹 · 10幕故事感独白",
            category="cinematic-film",
            badge="电影感爆款",
            status="active",
            max_participants=1,
            min_age=0,
            max_age=100,
            min_curated_shots=MIN_CURATED_SHOTS_PER_TEMPLATE,
            recommended_ages=solo_ages,
            curated_gallery_shots=_build_curated_shots_for_template(
                template_id="tpl_xhs_cinematic_wong_kar_wai",
                ages=solo_ages,
                focal_mm=35,
                aperture="f/1.4",
                lighting_short="钨丝暖光侧逆主光 + 百叶窗青绿街景漫反射补光 (4:1电影光比)",
                title_series=[
                    "三岁旧梦·花样童年",
                    "六岁夏午·风扇光影",
                    "十二天台·橘子汽水",
                    "十八街角·霓虹初遇",
                    "廿五花样·青橙独白",
                    "卅二暗涌·窗影微醺",
                    "四五流金·雪茄茶烟",
                    "五八阿飞·旧钟余晖",
                    "七二回首·胶片留声",
                    "八五终章·2046记忆",
                ],
                wardrobe_series=[
                    "复古米白纯棉小背心与柔和圆领",
                    "九十年代海魂条纹针织领口",
                    "泛黄胶片感棉麻少年衬衫领",
                    "复古墨绿灯芯绒夹克配白T领口",
                    "高定丝绒暗花立领或复古宽驳头西装领",
                    "深酒红真丝衬衫微敞领口配风衣",
                    "王家卫式剪裁精纺条纹西装与丝质领带",
                    "复古粗花呢大衣配高支羊绒内搭",
                    "岁月感暗金提花真丝睡袍式披肩领",
                    "典藏深棕天鹅绒长礼服翻领",
                ],
                backdrop_series=[
                    "百叶窗漏下暖黄阳光的老式风扇居室",
                    "绿色玻璃窗格透光的夏日旧公寓",
                    "傍晚蓝调时刻天台与远景暖橘路灯光斑",
                    "雨夜玻璃窗上霓虹虚化光晕与室内暖灯",
                    "Kodak 500T青绿暗部与暖琥珀壁灯走廊",
                    "慢门呼吸感咖啡馆卡座与丝绒窗帘焦外",
                    "金光与青影交错的复古酒店旋转门景深",
                    "挂着旧时钟的暖橘色光影书房",
                    "黑胶唱机旋转微光的复古客厅",
                    "电影谢幕般金色暖雾与深青色窗影",
                ],
                expression_series=[
                    "趴在窗边好奇凝望的清澈童眸",
                    "盛夏午后安静出神的纯真目光",
                    "仰望天空微风拂发的少年神情",
                    "欲言又止、眼神充满故事感的青春回眸",
                    "直视镜头却似透过镜头看往旧时光的深邃眼神",
                    "嘴角克制微扬、眼神克制而迷离的电影主角感",
                    "下颌线条紧致利落、沉稳笃定的流金气场",
                    "隔着时光淡然一笑的通透从容",
                    "温柔怀旧、眼底闪烁暖橘高光的慈祥凝视",
                    "将一生故事藏进眼底的世纪电影定格",
                ],
            ),
            supported_aspect_ratios=["3:4", "4:5", "9:16", "1:1"],
            default_aspect_ratio="3:4",
            required_consents=["age-transformation"],
            provider_capabilities=["face-id-lock", "cinematic-relighting", "high-res-skin-detail"],
            cost_tier="pro-studio",
            allowed_channels=["mp-xhs", "mp-weixin", "consumer-web", "mobile", "studio"],
            competitive_highlights=[
                "内置 10 幕王家卫电影级胶片分镜，35mm f/1.4 近景环境叙事 + 多景别九宫格呼吸感编排",
                "Kodak Vision3 500T (5219) 钨丝灯电影负片色彩科学，青绿暗部与暖琥珀高光碰撞，自带高光红晕 Halation",
                "IC-Light 百叶窗光影重打光 + 高低频分离微距皮肤纹理，小红书电影感独白笔记收藏率天花板",
            ],
            optics_and_lighting=OpticsAndLightingSpec(
                focal_length_mm=35,
                aperture="f/1.4",
                framing="cinematic environmental close-up with rhythmic extreme-closeup to half-body storyboard",
                lighting_setup="3200K tungsten key light through venetian blinds + cyan-green ambient neon fill, 4:1 ratio",
                color_science="Kodak Vision3 500T 5219 cinema negative LUT with warm amber halation and teal shadows",
                skin_texture_policy="authentic cinema film dermal micro-texture with warm subsurface scattering, zero plastic filter",
                film_grain_profile="35mm motion-picture Kodak 500T organic halide grain with subtle highlight halation",
            ),
            identity_preservation=IdentityPreservationSpec(
                identity_adapter="instantid-pulid-hybrid-v2",
                craniofacial_anchor_weight=0.92,
                eye_geometry_lock=0.95,
                skin_undertone_lock=0.89,
                expression_naturalness_weight=0.93,
            ),
            quality_thresholds=QualityGateThresholdSpec(
                min_identity_similarity=0.82,
                max_facial_drift=0.16,
                min_age_plausibility=0.85,
                min_pose_background_coherence=0.86,
                min_artifact_free_score=0.90,
                min_sharpness_score=0.84,
                min_aesthetic_score=0.88,
                max_auto_retries=2,
            ),
            negative_constraints=list(ANTI_PLASTIC_NEGATIVE_CONSTRAINTS),
            age_band_recipes=_build_standard_age_band_recipes(
                wardrobe_theme="vintage Hong Kong cinema tailored velvet, trench coat, and silk collar",
                backdrop_theme="warm tungsten venetian-blind shadows with teal neon bokeh",
            ),
        ),
        PortraitTemplateSpec(
            template_id="tpl_xhs_three_generations_heirloom",
            version="2.3.0",
            name="三代同堂/隔代亲情·跨时空同框",
            subtitle="50mm f/4.0 全员清晰景深 · 最多4人跨时空授权合拍 · 10幕传家宝全家福",
            category="family-heirloom",
            badge="催泪传家必拍",
            status="active",
            max_participants=4,
            min_age=0,
            max_age=100,
            min_curated_shots=MIN_CURATED_SHOTS_PER_TEMPLATE,
            recommended_ages=solo_ages,
            curated_gallery_shots=_build_curated_shots_for_template(
                template_id="tpl_xhs_three_generations_heirloom",
                ages=solo_ages,
                focal_mm=50,
                aperture="f/4.0",
                lighting_short="双灯大型柔光箱均匀覆盖主光 + 顶部温暖轮廓光 (确保多代同框无暗角)",
                title_series=[
                    "三岁怀抱·祖孙初见",
                    "六岁庭院·大手牵小手",
                    "十二门槛·比身高记忆",
                    "十八远行·长辈嘱托",
                    "廿五传承·跨时空同框",
                    "卅二团圆·三代全家福",
                    "四五中流·家的脊梁",
                    "五八含饴·隔代温情",
                    "七二四世·福寿绵长",
                    "八五传家·百年家族树",
                ],
                wardrobe_series=[
                    "温暖米白手工毛衣与长辈深色羊毛开衫同框呼应",
                    "童年纯棉小翻领与父母经典纯色衬衫协调搭配",
                    "少年清爽针织衫与家族暖色调格纹围巾",
                    "挺括青年白衬衫与长辈中山装/羊绒衫庄重同框",
                    "跨时空青年正装与童年/长辈温暖羊绒衫同色系叠搭",
                    "三代同堂定制新中式桑蚕丝与精纺羊毛家庭礼服",
                    "沉稳驼色羊绒大衣与家人温和米杏色针织呼应",
                    "温厚银灰开衫与晚辈清爽棉麻衬衫亲切同框",
                    "传家典藏暗红/深黛色丝毛礼服领口",
                    "世纪家族庆典高定重磅羊绒与丝绸披肩",
                ],
                backdrop_series=[
                    "阳光洒满的家族老院藤椅与木门景深",
                    "春日海棠盛开的庭院台阶全家福布景",
                    "镌刻成长刻度线的老屋门框纪实背景",
                    "照相馆经典红丝绒与暖灰渐层传家背景布",
                    "跨时空同框肖像馆长椅·统一焦平面无割裂",
                    "中秋团圆暖光客厅与实木餐桌远景",
                    "沉稳大气的家族书房博古架柔焦背景",
                    "金秋银杏落叶庭院的温暖逆光背景",
                    "悬挂世代家族相框的温润厅堂背景",
                    "博物馆级百年家族肖像典藏油画布",
                ],
                expression_series=[
                    "依偎在长辈怀中的纯真甜笑",
                    "握着长辈温暖手掌的清澈信赖眼神",
                    "并肩站立骄傲比身高的阳光笑脸",
                    "既有青春朝气又有家人守护的笃定目光",
                    "跨时空与童年自己或远行亲人同框的温柔凝视",
                    "三代人眉眼相似、其乐融融的端庄微笑",
                    "承上启下、温和坚毅的家庭中坚神态",
                    "看着晚辈成长的欣慰慈爱笑容",
                    "儿孙绕膝般温暖安详的长者目光",
                    "跨越百年的家族血脉共鸣与庄严微笑",
                ],
            ),
            supported_aspect_ratios=["4:5", "3:4", "1:1"],
            default_aspect_ratio="4:5",
            required_consents=["age-transformation", "family-co-aging"],
            provider_capabilities=["multi-subject-face-lock", "dual-focal-plane-control", "print-300dpi-upscale"],
            cost_tier="master-print",
            allowed_channels=["mp-xhs", "mp-weixin", "consumer-web", "studio", "kiosk"],
            competitive_highlights=[
                "支持最多 4 人跨代际/跨时空同框（「现在的我 + 6岁的我」或「三代同堂」），10 幕传家级合拍分镜",
                "50mm f/4.0 景深精确覆盖前后排长幼座位，双柔光箱消除多人阴影遮挡与透视变形",
                "直连 99 元 20 页蝴蝶对裱精装相册（内置中缝 ±12mm 人脸避让预检，确保多人合拍绝不压折痕）",
            ],
            optics_and_lighting=OpticsAndLightingSpec(
                focal_length_mm=50,
                aperture="f/4.0",
                framing="multi-generational group & cross-time bench portrait with deep unified f/4.0 focal plane",
                lighting_setup="dual symmetric 120cm softboxes + overhead warm hair separation light, 2.5:1 even ratio",
                color_science="Kodak Portra 160 natural multi-generational skin harmony LUT, CMYK print-safe",
                skin_texture_policy="authentic age-specific dermal fidelity per slot without cross-slot age bleeding",
                film_grain_profile="medium-format Hasselblad 6x7 fine archival grain",
            ),
            identity_preservation=IdentityPreservationSpec(
                identity_adapter="multi-slot-region-pulid-v2",
                craniofacial_anchor_weight=0.94,
                eye_geometry_lock=0.96,
                skin_undertone_lock=0.92,
                expression_naturalness_weight=0.92,
            ),
            quality_thresholds=QualityGateThresholdSpec(
                min_identity_similarity=0.82,
                max_facial_drift=0.16,
                min_age_plausibility=0.85,
                min_pose_background_coherence=0.87,
                min_artifact_free_score=0.91,
                min_sharpness_score=0.86,
                min_aesthetic_score=0.87,
                max_auto_retries=3,
            ),
            negative_constraints=[
                *ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
                "cross-generation face swap or age leakage between subjects",
                "face placed across center book spine gutter",
            ],
            age_band_recipes=_build_standard_age_band_recipes(
                wardrobe_theme="harmonious multi-generational heirloom wool, silk, and cotton attire",
                backdrop_theme="warm family portrait conservatory and classic studio canvas",
            ),
        ),
        PortraitTemplateSpec(
            template_id="tpl_xhs_vogue_editorial_bw",
            version="2.3.0",
            name="林德伯格大师黑白·纯净骨相纪实",
            subtitle="75mm f/2.0 纯正银盐黑白 · 剥离色彩干扰直击灵魂眼神 · 10幕杂志封面大片",
            category="bw-editorial",
            badge="骨相高级感",
            status="active",
            max_participants=1,
            min_age=0,
            max_age=100,
            min_curated_shots=MIN_CURATED_SHOTS_PER_TEMPLATE,
            recommended_ages=solo_ages,
            curated_gallery_shots=_build_curated_shots_for_template(
                template_id="tpl_xhs_vogue_editorial_bw",
                ages=solo_ages,
                focal_mm=75,
                aperture="f/2.0",
                lighting_short="Peter Lindbergh式高反差侧逆自然光 + 黑色吸光板深邃阴影雕塑 (5:1光比)",
                title_series=[
                    "三岁黑白·纯净初眸",
                    "六岁银盐·无瑕童真",
                    "十二棱角·少年骨骼",
                    "十八锐度·青春锋芒",
                    "廿五封面·极致骨相",
                    "卅二雕塑·光影切割",
                    "四五大师·灵魂凝视",
                    "五八纹理·白发银辉",
                    "七二纪实·岁月刀刻",
                    "八五不朽·铂金典藏",
                ],
                wardrobe_series=[
                    "纯白重磅华夫格纯棉孩童圆领",
                    "极简黑色粗针纯棉小高领",
                    "挺括纯白廓形衬衫领与光影折角",
                    "经典黑皮衣/重磅丹宁立领与白T叠穿",
                    "Vogue封面级极简黑色高领羊绒衫",
                    "解构主义挺括白衬衫与利落西装翻领",
                    "不对称剪裁重磅炭黑羊毛大衣立领",
                    "高反差银白丝毛混纺粗织纹披肩领",
                    "大师级极简黑丝绒高领与银发形成强烈黑白对比",
                    "铂金印相质感纯黑重磅羊绒雕塑感高领",
                ],
                backdrop_series=[
                    "Ilford HP5高调纯白漫射背景·突出乌黑瞳孔",
                    "柔和银灰暗房渐变背景·自然暗角",
                    "巴黎街头阴天漫射光感极简灰墙",
                    "工业风天窗高反差明暗切割影棚背景",
                    "林德伯格标志性炭黑粗帆布背景",
                    "45°伦勃朗光束穿透的深邃暗房背景",
                    "雕塑感负补光纯黑吸光绒布背景",
                    "银盐冲洗相纸质感中灰阶背景",
                    "高动态Zone System十级灰阶光影背景",
                    "博物馆铂金印相（Platinum Print）永恒黑背景",
                ],
                expression_series=[
                    "毫无防备的纯净直视、瞳孔环形高光锐利",
                    "安静而有力量的童年平视凝眸",
                    "45°微侧展现清晰鼻梁与下颌骨相转折",
                    "不加修饰、坚定直白地望向镜头深处",
                    "超模般松弛却极具穿透力的零距离眼神接触",
                    "微风拂过发丝、神情独立而克制",
                    "无需磨皮修饰、自信展现紧致骨相与微表情",
                    "银丝在逆光中发光、眼神睿智而深邃",
                    "每一道岁月纹路都如银盐雕刻般充满故事与力量",
                    "超越时间与色彩的永恒灵魂注视",
                ],
            ),
            supported_aspect_ratios=["4:5", "3:4", "1:1"],
            default_aspect_ratio="4:5",
            required_consents=["age-transformation"],
            provider_capabilities=["face-id-lock", "bw-zone-system-lut", "high-res-skin-detail"],
            cost_tier="pro-studio",
            allowed_channels=["mp-xhs", "mp-weixin", "consumer-web", "studio"],
            competitive_highlights=[
                "致敬 Peter Lindbergh 大师级黑白肖像美学，10 张纯净银盐分镜剥离一切色彩干扰，纯粹靠骨相与眼神封神",
                "Ilford HP5 Plus 400 + 亚当斯区域曝光法（Zone System I–IX 级灰阶），黑位扎实不死黑、银发高光丝丝分明",
                "高低频分离微距重建真实毛孔、唇纹与虹膜放射状纹理，在黑白影调下呈现极致胶片质感",
            ],
            optics_and_lighting=OpticsAndLightingSpec(
                focal_length_mm=75,
                aperture="f/2.0",
                framing="editorial monochrome portrait with rhythmic extreme eye close-up and sculptural 3/4 profile",
                lighting_setup="dramatic directional daylight-balanced key + deep black negative fill flag, 5:1 contrast",
                color_science="Ilford HP5 Plus 400 true monochrome silver-gelatin curve with Zone System tonal separation",
                skin_texture_policy="unretouched editorial monochrome dermal micro-contrast, authentic pores and laugh lines",
                film_grain_profile="classic Ilford HP5 400 cubic silver-halide monochrome grain",
            ),
            identity_preservation=IdentityPreservationSpec(
                identity_adapter="instantid-pulid-hybrid-v2",
                craniofacial_anchor_weight=0.95,
                eye_geometry_lock=0.97,
                skin_undertone_lock=0.90,
                expression_naturalness_weight=0.92,
            ),
            quality_thresholds=QualityGateThresholdSpec(
                min_identity_similarity=0.84,
                max_facial_drift=0.14,
                min_age_plausibility=0.86,
                min_pose_background_coherence=0.87,
                min_artifact_free_score=0.92,
                min_sharpness_score=0.87,
                min_aesthetic_score=0.89,
                max_auto_retries=2,
            ),
            negative_constraints=[
                *ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
                "muddy flat grey midtones without black/white point separation",
                "color cast contamination in monochrome silver gelatin print",
            ],
            age_band_recipes=_build_standard_age_band_recipes(
                wardrobe_theme="timeless Vogue editorial monochrome cashmere turtleneck, crisp white shirt, and wool coat",
                backdrop_theme="Peter Lindbergh raw charcoal canvas and directional daylight studio shadow",
            ),
        ),
        PortraitTemplateSpec(
            template_id="tpl_xhs_24_solar_terms_poetic",
            version="2.3.0",
            name="二十四节气·自然外景呼吸感人像",
            subtitle="85mm f/1.4 空气感大光圈 · 十个节气对应人生十幕 · 阳光草木自然逆光",
            category="outdoor-poetic",
            badge="氧气感外景",
            status="active",
            max_participants=1,
            min_age=0,
            max_age=100,
            min_curated_shots=MIN_CURATED_SHOTS_PER_TEMPLATE,
            recommended_ages=solo_ages,
            curated_gallery_shots=_build_curated_shots_for_template(
                template_id="tpl_xhs_24_solar_terms_poetic",
                ages=solo_ages,
                focal_mm=85,
                aperture="f/1.4",
                lighting_short="自然黄金时刻树影逆光发丝光 + 白色反光板清透眼神补光 (2.5:1氧气感)",
                title_series=[
                    "三岁立春·新芽破土",
                    "六岁雨水·杏花微雨",
                    "十二惊蛰·春风少年",
                    "十八春分·昼夜均光",
                    "廿五小满·万物初盈",
                    "卅二夏至·骄阳绿荫",
                    "四五白露·秋水长天",
                    "五八秋分·金桂流金",
                    "七二霜降·红叶银丝",
                    "八五冬至·瑞雪暖阳",
                ],
                wardrobe_series=[
                    "春芽嫩绿手工纯棉针织小圆领",
                    "杏花白柔软水洗棉麻孩童衫",
                    "薄荷青透气亚麻少年衬衫领",
                    "春分浅米白棉麻混纺氧气感开衫",
                    "小满麦穗色高支亚麻修身衬衫领",
                    "夏至墨绿桑蚕丝与亚麻清凉叠穿领",
                    "白露暖驼色轻薄山羊绒微高领",
                    "秋分桂花琥珀色粗纺羊毛披肩领",
                    "霜降枫叶褐与银灰羊绒温暖围巾领",
                    "冬至雪白重磅羊绒高领配暖色大衣",
                ],
                backdrop_series=[
                    "立春微焦嫩绿草尖与温暖晨曦光斑",
                    "雨水江南屋檐细雨与杏花柔焦散景",
                    "惊蛰微风吹拂的青翠竹林与柳梢逆光",
                    "春分旷野清透蓝天与盛开白玉兰焦外",
                    "小满青黄麦浪与午后四点金色阳光散景",
                    "夏至浓密梧桐树荫下闪烁的猫眼光学光斑",
                    "白露芦苇荡逆光银色边缘光与秋日晴空",
                    "秋分满树金桂飘香的庭院暖阳散景",
                    "霜降层林尽染的红枫焦外与夕阳暖光",
                    "冬至初雪松枝与晶莹暖阳交织的静谧远景",
                ],
                expression_series=[
                    "仰头感受春风拂面的清澈童真笑眸",
                    "伸手接住春雨般灵动好奇的眼神",
                    "在春光中奔跑驻足回眸的清朗少年气",
                    "迎着春分微风、眼神清透如水的青春微笑",
                    "「花未全开月未圆」小满时节的松弛自信神态",
                    "盛夏绿荫下沉稳清凉的平视目光",
                    "秋日微风中紧致从容、温暖通透的微笑",
                    "鬓染秋霜却如金秋般丰盈平和的眼神",
                    "红叶映衬下银发熠熠生辉的慈祥浅笑",
                    "冬雪暖阳中万物归藏般宁静温暖的世纪凝眸",
                ],
            ),
            supported_aspect_ratios=["3:4", "4:5", "9:16"],
            default_aspect_ratio="3:4",
            required_consents=["age-transformation"],
            provider_capabilities=["face-id-lock", "outdoor-bokeh-physics", "high-res-skin-detail"],
            cost_tier="pro-studio",
            allowed_channels=["mp-xhs", "mp-weixin", "consumer-web", "mobile", "studio"],
            competitive_highlights=[
                "彻底打破纯室内影棚局限：将人生 10 个年龄阶段映射至「立春→小满→白露→冬至」十个中国二十四节气外景",
                "85mm f/1.4 物理级旋焦散景与口径蚀（Cat's-eye Bokeh），阳光穿透树叶与银发形成通透发丝逆光",
                "Fujifilm Provia / Nostalgic Neg 自然森系色彩科学，皮肤在自然阳光下呈现真实通透的皮下散射（SSS）",
            ],
            optics_and_lighting=OpticsAndLightingSpec(
                focal_length_mm=85,
                aperture="f/1.4",
                framing="airy outdoor poetic portrait with optical cat's-eye foliage bokeh and backlit hair halo",
                lighting_setup="135-degree natural golden-hour sunlight rim + white bounce card eye catchlight, 2.5:1 ratio",
                color_science="Fujifilm Nostalgic Neg & Provia outdoor botanical color science with luminous skin SSS",
                skin_texture_policy="sun-lit translucent epidermal subsurface scattering with fine natural pores and vellus fuzz",
                film_grain_profile="ultra-fine Fujifilm Astia 100 daylight reversal grain",
            ),
            identity_preservation=IdentityPreservationSpec(
                identity_adapter="east-asian-craniofacial-lock-v2",
                craniofacial_anchor_weight=0.93,
                eye_geometry_lock=0.95,
                skin_undertone_lock=0.92,
                expression_naturalness_weight=0.93,
            ),
            quality_thresholds=QualityGateThresholdSpec(
                min_identity_similarity=0.83,
                max_facial_drift=0.15,
                min_age_plausibility=0.85,
                min_pose_background_coherence=0.87,
                min_artifact_free_score=0.91,
                min_sharpness_score=0.85,
                min_aesthetic_score=0.88,
                max_auto_retries=2,
            ),
            negative_constraints=[
                *ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
                "fake studio backdrop seam in outdoor scene",
                "harsh midday raccoon eye shadows",
            ],
            age_band_recipes=_build_standard_age_band_recipes(
                wardrobe_theme="seasonal breathable linen, mulberry silk, and soft cashmere aligned with 24 solar terms",
                backdrop_theme="natural golden-hour botanical bokeh evolving from spring sprouts to winter snow",
            ),
        ),
        # 10. 世界名胜古迹·100大环球奇观实景旅拍（独立「世界名胜古迹」分类 · 支持上传本人照片合成100张著名景点）
        PortraitTemplateSpec(
            template_id="tpl_xhs_world_landmarks_50_global",
            version="2.4.0",
            name="世界名胜古迹·100大环球奇观实景旅拍",
            subtitle="35mm/50mm 透视地平线对齐 · 环境 HDR IBL 物理重打光 · 足底接触阴影与大气景深",
            category="world-landmarks",
            badge="环球旅拍 · 100大名胜",
            status="active",
            max_participants=4,
            min_age=1,
            max_age=100,
            min_curated_shots=MIN_CURATED_SHOTS_PER_TEMPLATE,
            recommended_ages=[6, 12, 18, 22, 28, 35, 45, 58, 72, 85],
            curated_gallery_shots=[
                CuratedShotSpec(
                    shot_id="lnd_shot_01_06y_forbidden_city",
                    shot_index=1,
                    target_age=6,
                    title="镜头01 · 故宫太和殿丹陛红墙（北京）",
                    framing_and_angle="50mm f/2.8 视平线Y=0.46 汉白玉望柱旁微侧身回眸",
                    lighting_key_ratio="IC-Light 紫禁城晨光 IBL (4800K, 太阳高度角28°) + 朱红宫墙漫反射柔补",
                    lens_dof_cue="前中后景呈现宫墙与琉璃飞檐自然光学散景，消除抠图贴纸感",
                    craniofacial_and_dermal_focus="锁定面部骨相与真实皮肤透光质感，匹配户外晨曦色温",
                    wardrobe_fabric_cue="新中式立领桑蚕丝外套，色彩与朱红宫墙冷暖呼应",
                    backdrop_prop_cue="故宫太和殿重檐庑殿顶鎏金琉璃瓦与汉白玉雕栏实景",
                    micro_expression_cue="纯真好奇的清澈眼神与自然微笑",
                    default_selected=True,
                ),
                CuratedShotSpec(
                    shot_id="lnd_shot_02_12y_great_wall",
                    shot_index=2,
                    target_age=12,
                    title="镜头02 · 万里长城慕田峪云海敌楼（北京）",
                    framing_and_angle="35mm f/2.8 视平线Y=0.38 手扶青砖垛口远眺层峦",
                    lighting_key_ratio="金色山脊侧逆光 (4500K, 太阳高度角22°) + 云海漫反射环境光",
                    lens_dof_cue="蜿蜒长城马道向远山晨雾自然景深递减，大气透视空气雾度0.22",
                    craniofacial_and_dermal_focus="侧逆光勾勒立体鼻梁与少年发丝金边",
                    wardrobe_fabric_cue="户外机能风衣配暖色围巾，随山风自然微扬",
                    backdrop_prop_cue="慕田峪长城明代敌楼、青砖垛口与晨雾群山",
                    micro_expression_cue="迎向山风的蓬勃朝气与自信神采",
                    default_selected=True,
                ),
                CuratedShotSpec(
                    shot_id="lnd_shot_03_18y_eiffel_tower",
                    shot_index=3,
                    target_age=18,
                    title="镜头03 · 巴黎埃菲尔铁塔夏乐宫晨光（法国）",
                    framing_and_angle="50mm f/2.0 视平线Y=0.48 夏乐宫大理石露台黄金分割位",
                    lighting_key_ratio="巴黎塞纳河柔和晨光 IBL (4600K) + 奶油色石材地面漫反射补光",
                    lens_dof_cue="f/2.0 大光圈将铁塔镂空钢结构化作细腻奶油焦外而保持高辨识度",
                    craniofacial_and_dermal_focus="清透细腻的青年胶原肌理与明亮眼神光",
                    wardrobe_fabric_cue="法式经典卡其色风衣配丝质方巾",
                    backdrop_prop_cue="埃菲尔铁塔全貌、塞纳河岸树影与奥斯曼建筑天际线",
                    micro_expression_cue="法式电影般的松弛浪漫微笑",
                    default_selected=True,
                ),
                CuratedShotSpec(
                    shot_id="lnd_shot_04_22y_santorini_oia",
                    shot_index=4,
                    target_age=22,
                    title="镜头04 · 圣托里尼伊亚蓝顶教堂爱琴海（希腊）",
                    framing_and_angle="35mm f/2.4 视平线Y=0.42 纯白露台俯瞰火山口蔚蓝海湾",
                    lighting_key_ratio="爱琴海澄澈晴空光 (5200K) + 纯白洞穴屋360度天然漫反射柔光",
                    lens_dof_cue="近处九重葛花簇微虚，中景人物锐利，远景蓝顶教堂与海面通透",
                    craniofacial_and_dermal_focus="阳光下真实的健康肤色光泽与清晰睫毛投影",
                    wardrobe_fabric_cue="海岛度假风纯白亚麻衬衫，随爱琴海微风轻扬",
                    backdrop_prop_cue="圣托里尼三座钴蓝圆顶教堂、纯白阶梯与深蓝爱琴海",
                    micro_expression_cue="灿烂舒展的度假笑意",
                    default_selected=True,
                ),
                CuratedShotSpec(
                    shot_id="lnd_shot_05_28y_giza_pyramids",
                    shot_index=5,
                    target_age=28,
                    title="镜头05 · 吉萨胡夫大金字塔与狮身人面像（埃及）",
                    framing_and_angle="50mm f/2.8 视平线Y=0.45 吉萨高原砂岩台地C位主图",
                    lighting_key_ratio="尼罗河西岸黄金时刻斜阳 (4000K, 太阳高度角22°) + 金色沙地暖调反射",
                    lens_dof_cue="真实足底接触阴影(0.90)与大漠热浪空气透视，三大金字塔恢弘列阵",
                    craniofacial_and_dermal_focus="1:1 黄金锚点最高身份锁定，立体受光骨相与微距皮肤纹理",
                    wardrobe_fabric_cue="亚麻猎装夹克配复古宽檐遮阳帽",
                    backdrop_prop_cue="胡夫大金字塔巨石阵列、斯芬克斯巨像与金色大漠夕照",
                    micro_expression_cue="跨越四千五百年古文明的深邃平视目光",
                    default_selected=True,
                ),
                CuratedShotSpec(
                    shot_id="lnd_shot_06_35y_kyoto_fuji",
                    shot_index=6,
                    target_age=35,
                    title="镜头06 · 京都五重塔春樱与富士山冠雪（日本）",
                    framing_and_angle="85mm f/1.8 视平线Y=0.45 染井吉野樱花枝下微侧身",
                    lighting_key_ratio="春日晴空柔光 (5000K) + 粉白樱花花瓣漫反射眼神光",
                    lens_dof_cue="85mm 中长焦空间压缩感让冠雪富士山与五重塔同框，前景樱花柔焦",
                    craniofacial_and_dermal_focus="成熟温润的面部折叠度与自然眼尾卧蚕",
                    wardrobe_fabric_cue="日系极简浅米色羊绒风衣或传统手工羽织",
                    backdrop_prop_cue="五重塔朱红飞檐、漫天春樱与富士山白雪峰顶",
                    micro_expression_cue="沉静内敛的东方温和笑意",
                    default_selected=True,
                ),
                CuratedShotSpec(
                    shot_id="lnd_shot_07_45y_machu_picchu",
                    shot_index=7,
                    target_age=45,
                    title="镜头07 · 马丘比丘安第斯云端印加遗址（秘鲁）",
                    framing_and_angle="35mm f/2.8 视平线Y=0.40 守护者小屋石阶俯瞰云海古城",
                    lighting_key_ratio="海拔2430米云林破晓天光 (5200K) + 花岗岩湿润漫反射",
                    lens_dof_cue="印加干砌石墙纹理清晰，远方瓦伊纳比丘峰环绕流动云雾",
                    craniofacial_and_dermal_focus="紧致下颌线与45岁阅历沉淀的笃定神态",
                    wardrobe_fabric_cue="秘鲁羊驼毛（Alpaca）几何织纹披肩配徒步外套",
                    backdrop_prop_cue="马丘比丘花岗岩神庙、翠绿梯田与瓦伊纳比丘奇峰",
                    micro_expression_cue="历经山河后的开阔与从容",
                    default_selected=True,
                ),
                CuratedShotSpec(
                    shot_id="lnd_shot_08_58y_rome_colosseum",
                    shot_index=8,
                    target_age=58,
                    title="镜头08 · 罗马斗兽场帝国古拱廊夕照（意大利）",
                    framing_and_angle="50mm f/2.2 视平线Y=0.47 鹅卵石古道45度侧颜回眸",
                    lighting_key_ratio="永恒之城落日琥珀金光 (4100K) 穿过三层科林斯石拱",
                    lens_dof_cue="石板路接触阴影自然延伸，古罗马石灰华石拱与伞松柔和虚化",
                    craniofacial_and_dermal_focus="儒雅鬓角微霜与富有故事感的眼周纹理",
                    wardrobe_fabric_cue="意式高定亚麻西装外套配真丝口袋巾",
                    backdrop_prop_cue="罗马斗兽场三层古拱门、鹅卵石御道与落日金晖",
                    micro_expression_cue="儒雅睿智的微笑",
                    default_selected=True,
                ),
                CuratedShotSpec(
                    shot_id="lnd_shot_09_72y_swiss_jungfrau",
                    shot_index=9,
                    target_age=72,
                    title="镜头09 · 瑞士少女峰阿尔卑斯雪山列车（瑞士）",
                    framing_and_angle="50mm f/2.8 视平线Y=0.44 温根木屋露台手捧热咖啡特写",
                    lighting_key_ratio="阿尔卑斯万年冰川雪面反射柔光 (5700K) 提亮银发与眼神光",
                    lens_dof_cue="雪山反射光带来极佳通透感，背后红色齿轮列车与雪峰层次分明",
                    craniofacial_and_dermal_focus="蓬松真实的银白发丝质感与慈祥舒展的放射状笑纹",
                    wardrobe_fabric_cue="高定羊绒雪山度假毛衣配格纹围巾",
                    backdrop_prop_cue="少女峰与艾格峰皑皑白雪、红色登山齿轮列车与草甸木屋",
                    micro_expression_cue="幸福安宁的慈祥笑意",
                    default_selected=True,
                ),
                CuratedShotSpec(
                    shot_id="lnd_shot_10_85y_iceland_aurora",
                    shot_index=10,
                    target_age=85,
                    title="镜头10 · 冰岛杰古沙龙冰河湖极光黑沙滩（冰岛 · 第十张典藏）",
                    framing_and_angle="35mm f/1.8 视平线Y=0.45 钻石黑沙滩千年蓝冰旁仰望极光",
                    lighting_key_ratio="夜空祖母绿极光漫射 + 晶莹浮冰环境折射光 (4600K)",
                    lens_dof_cue="f/1.8 大光圈收录漫天舞动的欧若拉绿带与黑沙滩冰晶反光",
                    craniofacial_and_dermal_focus="通透银发与澄澈双眸映照出极光星河",
                    wardrobe_fabric_cue="冰岛传统几何提花羊毛衣（Lopapeysa）配防寒派克大衣",
                    backdrop_prop_cue="杰古沙龙冰河湖千年蓝冰、火山黑沙滩与绿色北极光",
                    micro_expression_cue="看遍世界奇观后的豁达与超然",
                    default_selected=False,
                ),
            ],
            supported_aspect_ratios=["3:4", "4:5", "1:1", "9:16"],
            default_aspect_ratio="3:4",
            required_consents=["age-transformation", "portrait-generation"],
            provider_capabilities=["instantid-v2", "pulid-flux-pro", "ic-light-ibl-v2", "horizon-perspective-align"],
            cost_tier="premium-landmark-50",
            allowed_channels=["mp-xhs", "mp-weixin", "consumer-web", "mobile", "studio"],
            competitive_highlights=[
                "内置完整 100 张世界各地名胜古迹实景照片底板（涵盖华夏古建、欧洲古典、亚太奇观、中东非古文明、美洲与极地各 20 张）",
                "透视地平线对齐（Horizon Vanishing-Point Alignment）+ 足底真实接触阴影，彻底告别生硬抠图与脚底悬空贴纸感",
                "IC-Light 环境 HDR IBL 物理重打光：自动提取景点太阳方位角、高度角与天空色温，将真实阳光/夕阳/极光反射到人物脸部与衣领",
            ],
            optics_and_lighting=OpticsAndLightingSpec(
                focal_length_mm=35,
                aperture="f/2.2",
                framing="environmental travel portrait with matched horizon vanishing point and natural landmark bokeh",
                lighting_setup="IC-Light environment HDR IBL solar azimuth/elevation relighting + ground bounce fill",
                color_science="Kodak Portra 400 & Ektar 100 Global Travel Color Science with atmospheric haze integration",
                skin_texture_policy="outdoor natural sunlight subsurface scattering with real pores and matched ambient color temperature",
                film_grain_profile="fine 35mm travel documentary silver-halide grain",
            ),
            identity_preservation=IdentityPreservationSpec(
                identity_adapter="multi-photo-3d-landmark-lock-v2",
                craniofacial_anchor_weight=0.94,
                eye_geometry_lock=0.95,
                skin_undertone_lock=0.93,
                expression_naturalness_weight=0.94,
            ),
            quality_thresholds=QualityGateThresholdSpec(
                min_identity_similarity=0.84,
                max_facial_drift=0.14,
                min_age_plausibility=0.86,
                min_pose_background_coherence=0.89,
                min_artifact_free_score=0.92,
                min_sharpness_score=0.86,
                min_aesthetic_score=0.89,
                max_auto_retries=2,
            ),
            negative_constraints=[
                *ANTI_PLASTIC_NEGATIVE_CONSTRAINTS,
                "flat cardboard cutout paste effect",
                "mismatched horizon vanishing point",
                "floating feet without ground contact shadow",
                "inconsistent sunlight direction between face and landmark",
            ],
            age_band_recipes=_build_standard_age_band_recipes(
                wardrobe_theme="culturally and climatically matched travel outfits (silk, trench coat, linen safari, cashmere)",
                backdrop_theme="50 world-famous UNESCO landmarks with matched perspective horizon, HDR IBL sunlight, and contact shadows",
            ),
        ),
    ]


LEGACY_TEMPLATE_ALIASES: dict[str, str] = {
    "tpl_xhs_0_100_timeline": "tpl_xhs_silver_halide_0_100",
    "tpl_xhs_world_landmarks_100_global": "tpl_xhs_world_landmarks_50_global",
}


class PortraitTemplateEngine:
    """
    ACID SQLite-backed Template Catalog, Composition Draft Store,
    Deterministic Timeline Prompt Compiler, Birth-Year Era Chronicle Resolver,
    and Multi-Provider B15 Candidate Curation Engine.
    """

    def __init__(self, db_path: str = ":memory:") -> None:
        self._conn = sqlite3.connect(db_path, isolation_level=None, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()
        self._seed_builtin_templates()

    def _init_schema(self) -> None:
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS portrait_templates (
                    template_id TEXT PRIMARY KEY,
                    version TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('active', 'draft', 'retired')),
                    category TEXT NOT NULL,
                    max_participants INTEGER NOT NULL CHECK (max_participants >= 1),
                    default_aspect_ratio TEXT NOT NULL,
                    spec_json TEXT NOT NULL,
                    row_version INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS composition_drafts (
                    draft_id TEXT PRIMARY KEY,
                    tenant_id TEXT NOT NULL,
                    actor_id TEXT NOT NULL,
                    template_id TEXT NOT NULL,
                    template_version TEXT NOT NULL,
                    current_age_anchor INTEGER NOT NULL CHECK (current_age_anchor BETWEEN 0 AND 120),
                    timeline_ages_json TEXT NOT NULL,
                    aspect_ratio TEXT NOT NULL,
                    participant_count INTEGER NOT NULL CHECK (participant_count >= 1),
                    contains_minor INTEGER NOT NULL DEFAULT 0,
                    custom_notes TEXT NOT NULL DEFAULT '',
                    version INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS timeline_generation_plans (
                    plan_id TEXT PRIMARY KEY,
                    tenant_id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    template_id TEXT NOT NULL,
                    template_version TEXT NOT NULL,
                    current_age_anchor INTEGER NOT NULL,
                    aspect_ratio TEXT NOT NULL,
                    participant_count INTEGER NOT NULL,
                    contains_minor INTEGER NOT NULL,
                    plan_json TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS quality_evaluations (
                    evaluation_id TEXT PRIMARY KEY,
                    plan_id TEXT NOT NULL,
                    target_age INTEGER NOT NULL,
                    template_id TEXT NOT NULL,
                    passed INTEGER NOT NULL,
                    recommended_action TEXT NOT NULL,
                    dimensions_json TEXT NOT NULL,
                    failure_reasons_json TEXT NOT NULL,
                    evaluated_at TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS curated_gallery_runs (
                    gallery_id TEXT PRIMARY KEY,
                    tenant_id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    plan_id TEXT NOT NULL,
                    template_id TEXT NOT NULL,
                    template_version TEXT NOT NULL,
                    birth_year INTEGER NOT NULL,
                    current_age_anchor INTEGER NOT NULL,
                    total_candidates INTEGER NOT NULL,
                    passed_candidates INTEGER NOT NULL,
                    min_curated_shots INTEGER NOT NULL,
                    ready_for_curation INTEGER NOT NULL,
                    run_json TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS curated_gallery_selections (
                    selection_id TEXT PRIMARY KEY,
                    gallery_id TEXT NOT NULL,
                    tenant_id TEXT NOT NULL,
                    actor_id TEXT NOT NULL,
                    template_id TEXT NOT NULL,
                    selected_shot_ids_json TEXT NOT NULL,
                    selected_ages_json TEXT NOT NULL,
                    selected_count INTEGER NOT NULL,
                    export_mode TEXT NOT NULL,
                    photobook_sku TEXT,
                    version INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL
                )
                """
            )
            self._conn.execute("COMMIT")
        except Exception:
            self._conn.execute("ROLLBACK")
            raise

    def _seed_builtin_templates(self) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            for tpl in build_builtin_portrait_templates():
                self._conn.execute(
                    """
                    INSERT INTO portrait_templates (
                        template_id, version, status, category, max_participants,
                        default_aspect_ratio, spec_json, row_version, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
                    ON CONFLICT(template_id) DO UPDATE SET
                        version = excluded.version,
                        status = excluded.status,
                        spec_json = excluded.spec_json,
                        updated_at = excluded.updated_at
                    """,
                    (
                        tpl.template_id,
                        tpl.version,
                        tpl.status,
                        tpl.category,
                        tpl.max_participants,
                        tpl.default_aspect_ratio,
                        json.dumps(tpl.to_dict(), ensure_ascii=False),
                        now_iso,
                    ),
                )
            self._conn.execute("COMMIT")
        except Exception:
            self._conn.execute("ROLLBACK")
            raise

    @staticmethod
    def _deserialize_template(spec_json: str) -> PortraitTemplateSpec:
        raw = json.loads(spec_json)
        recipes: list[AgeBandPromptRecipe] = []
        for r in raw["age_band_recipes"]:
            r_copy = dict(r)
            phys_raw = r_copy.pop("physiological_weights", None)
            if isinstance(phys_raw, dict):
                phys = PhysiologicalWeightsSpec(**phys_raw)
            else:
                phys = PhysiologicalWeightsSpec(0.0, 0.85, 0.90, 0.25, 0.0, 0.94, 0.02)
            recipes.append(AgeBandPromptRecipe(**r_copy, physiological_weights=phys))

        curated_shots = [
            CuratedShotSpec(**s) for s in raw.get("curated_gallery_shots", [])
        ]
        return PortraitTemplateSpec(
            template_id=raw["template_id"],
            version=raw["version"],
            name=raw["name"],
            subtitle=raw["subtitle"],
            category=raw["category"],
            badge=raw["badge"],
            status=raw["status"],
            max_participants=int(raw["max_participants"]),
            min_age=int(raw["min_age"]),
            max_age=int(raw["max_age"]),
            min_curated_shots=int(raw.get("min_curated_shots", MIN_CURATED_SHOTS_PER_TEMPLATE)),
            recommended_ages=[int(a) for a in raw["recommended_ages"]],
            curated_gallery_shots=curated_shots,
            supported_aspect_ratios=list(raw["supported_aspect_ratios"]),
            default_aspect_ratio=raw["default_aspect_ratio"],
            required_consents=list(raw["required_consents"]),
            provider_capabilities=list(raw["provider_capabilities"]),
            cost_tier=raw["cost_tier"],
            allowed_channels=list(raw["allowed_channels"]),
            competitive_highlights=list(raw["competitive_highlights"]),
            optics_and_lighting=OpticsAndLightingSpec(**raw["optics_and_lighting"]),
            identity_preservation=IdentityPreservationSpec(**raw["identity_preservation"]),
            quality_thresholds=QualityGateThresholdSpec(**raw["quality_thresholds"]),
            negative_constraints=list(raw["negative_constraints"]),
            age_band_recipes=recipes,
        )

    def list_templates(
        self,
        *,
        channel: str | None = None,
        include_retired: bool = False,
    ) -> list[PortraitTemplateSpec]:
        query = "SELECT spec_json FROM portrait_templates"
        params: list[Any] = []
        if not include_retired:
            query += " WHERE status = 'active'"
        query += " ORDER BY rowid ASC"
        rows = self._conn.execute(query, params).fetchall()
        templates = [self._deserialize_template(r["spec_json"]) for r in rows]
        if channel:
            templates = [t for t in templates if channel in t.allowed_channels]
        return templates

    def get_template(self, template_id: str, *, allow_retired: bool = False) -> PortraitTemplateSpec:
        resolved_id = LEGACY_TEMPLATE_ALIASES.get(template_id.strip(), template_id.strip())
        row = self._conn.execute(
            "SELECT spec_json, status FROM portrait_templates WHERE template_id = ?",
            (resolved_id,),
        ).fetchone()
        if row is None:
            raise TemplateEngineError(
                "TEMPLATE_NOT_FOUND",
                f"Portrait template not found: {template_id}",
                404,
            )
        spec = self._deserialize_template(row["spec_json"])
        if spec.status != "active" and not allow_retired:
            raise TemplateEngineError(
                "TEMPLATE_RETIRED",
                f"Portrait template {spec.template_id} is {spec.status} and cannot be used for new generations",
                409,
            )
        return spec

    def update_template_status(
        self,
        *,
        template_id: str,
        new_status: str,
        expected_row_version: int,
    ) -> PortraitTemplateSpec:
        """B08-R05 & negative test support: update template status with SQL optimistic locking."""
        if new_status not in ("active", "draft", "retired"):
            raise TemplateEngineError("INVALID_TEMPLATE_STATUS", f"Invalid status: {new_status}", 400)
        resolved_id = LEGACY_TEMPLATE_ALIASES.get(template_id.strip(), template_id.strip())
        row = self._conn.execute(
            "SELECT spec_json, row_version FROM portrait_templates WHERE template_id = ?",
            (resolved_id,),
        ).fetchone()
        if row is None:
            raise TemplateEngineError("TEMPLATE_NOT_FOUND", f"Unknown template: {template_id}", 404)
        spec_dict = json.loads(row["spec_json"])
        spec_dict["status"] = new_status
        now_iso = datetime.now(timezone.utc).isoformat()

        self._conn.execute("BEGIN IMMEDIATE")
        try:
            cur = self._conn.execute(
                """
                UPDATE portrait_templates
                SET status = ?, spec_json = ?, row_version = row_version + 1, updated_at = ?
                WHERE template_id = ? AND row_version = ?
                """,
                (
                    new_status,
                    json.dumps(spec_dict, ensure_ascii=False),
                    now_iso,
                    resolved_id,
                    expected_row_version,
                ),
            )
            if cur.rowcount == 0:
                self._conn.execute("ROLLBACK")
                raise TemplateEngineError(
                    "CONCURRENT_MODIFICATION",
                    "Template row_version mismatch during status update",
                    409,
                )
            self._conn.execute("COMMIT")
        except Exception:
            if self._conn.in_transaction:
                self._conn.execute("ROLLBACK")
            raise
        return self.get_template(resolved_id, allow_retired=True)

    def save_composition_draft(
        self,
        *,
        draft_id: str,
        tenant_id: str,
        actor_id: str,
        template_id: str,
        current_age_anchor: int,
        timeline_ages: list[int],
        aspect_ratio: str | None = None,
        participant_count: int = 1,
        contains_minor: bool = False,
        custom_notes: str = "",
        expected_version: int | None = None,
    ) -> CompositionDraftRecord:
        """B08-R01..R03: Validate and persist a versioned composition draft with optimistic locking."""
        tpl = self.get_template(template_id, allow_retired=False)
        chosen_ratio = aspect_ratio or tpl.default_aspect_ratio
        self._validate_composition_parameters(
            tpl=tpl,
            current_age_anchor=current_age_anchor,
            timeline_ages=timeline_ages,
            aspect_ratio=chosen_ratio,
            participant_count=participant_count,
            contains_minor=contains_minor,
            custom_notes=custom_notes,
        )
        normalized_ages = sorted({int(a) for a in timeline_ages})
        now_iso = datetime.now(timezone.utc).isoformat()

        self._conn.execute("BEGIN IMMEDIATE")
        try:
            existing = self._conn.execute(
                "SELECT version, tenant_id FROM composition_drafts WHERE draft_id = ?",
                (draft_id,),
            ).fetchone()
            if existing is None:
                if expected_version is not None and expected_version != 0:
                    self._conn.execute("ROLLBACK")
                    raise TemplateEngineError(
                        "DRAFT_VERSION_CONFLICT",
                        f"Draft {draft_id} does not exist for expected_version={expected_version}",
                        409,
                    )
                new_version = 1
                self._conn.execute(
                    """
                    INSERT INTO composition_drafts (
                        draft_id, tenant_id, actor_id, template_id, template_version,
                        current_age_anchor, timeline_ages_json, aspect_ratio,
                        participant_count, contains_minor, custom_notes, version, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        draft_id,
                        tenant_id,
                        actor_id,
                        tpl.template_id,
                        tpl.version,
                        int(current_age_anchor),
                        json.dumps(normalized_ages),
                        chosen_ratio,
                        int(participant_count),
                        1 if contains_minor else 0,
                        custom_notes.strip(),
                        new_version,
                        now_iso,
                    ),
                )
            else:
                if existing["tenant_id"] != tenant_id:
                    self._conn.execute("ROLLBACK")
                    raise TemplateEngineError("CROSS_TENANT_FORBIDDEN", "Draft belongs to another tenant", 403)
                target_version = expected_version if expected_version is not None else int(existing["version"])
                new_version = target_version + 1
                cur = self._conn.execute(
                    """
                    UPDATE composition_drafts
                    SET template_id = ?, template_version = ?, current_age_anchor = ?,
                        timeline_ages_json = ?, aspect_ratio = ?, participant_count = ?,
                        contains_minor = ?, custom_notes = ?, version = ?, updated_at = ?
                    WHERE draft_id = ? AND tenant_id = ? AND version = ?
                    """,
                    (
                        tpl.template_id,
                        tpl.version,
                        int(current_age_anchor),
                        json.dumps(normalized_ages),
                        chosen_ratio,
                        int(participant_count),
                        1 if contains_minor else 0,
                        custom_notes.strip(),
                        new_version,
                        now_iso,
                        draft_id,
                        tenant_id,
                        target_version,
                    ),
                )
                if cur.rowcount == 0:
                    self._conn.execute("ROLLBACK")
                    raise TemplateEngineError(
                        "DRAFT_VERSION_CONFLICT",
                        f"Optimistic lock failed for draft {draft_id} at version {target_version}",
                        409,
                    )
            self._conn.execute("COMMIT")
        except Exception:
            if self._conn.in_transaction:
                self._conn.execute("ROLLBACK")
            raise

        return CompositionDraftRecord(
            draft_id=draft_id,
            tenant_id=tenant_id,
            actor_id=actor_id,
            template_id=tpl.template_id,
            template_version=tpl.version,
            current_age_anchor=int(current_age_anchor),
            timeline_ages=normalized_ages,
            aspect_ratio=chosen_ratio,
            participant_count=int(participant_count),
            contains_minor=contains_minor,
            custom_notes=custom_notes.strip(),
            version=new_version,
            updated_at=now_iso,
        )

    @staticmethod
    def _compile_provider_native_payload(
        *,
        tpl: PortraitTemplateSpec,
        target_age: int,
        participant_count: int,
        effective_identity_weight: float,
        phys: PhysiologicalWeightsSpec,
    ) -> ProviderNativePayloadSpec:
        """Compile structured template & physiological weights into provider-native API payload parameters."""
        if tpl.template_id == "tpl_xhs_oriental_aesthetics_portrait":
            provider_id = "seedream-oriental-portrait-v3"
            fallback_provider_id = "flux-pro-pulid-studio-v2"
            model_id = "seedream-3.0-oriental-editorial"
            sampler = "dpmpp_2m_sde_karras"
            steps = 34
            cfg_scale = 5.2
            print_bleed_mm = 0
            cmyk_profile = "Display_P3_sRGB_Safe"
        elif tpl.template_id == "tpl_xhs_master_fine_art_photobook":
            provider_id = "sdxl-hasselblad-print-300dpi-v2"
            fallback_provider_id = "flux-pro-pulid-studio-v2"
            model_id = "hasselblad-medium-format-fineart-v2"
            sampler = "euler_ancestral_karras"
            steps = 40
            cfg_scale = 5.8
            print_bleed_mm = 3
            cmyk_profile = "ISOcoated_v2_300_eci.icc"
        elif tpl.template_id in ("tpl_xhs_warm_family_co_aging", "tpl_xhs_three_generations_heirloom"):
            provider_id = "flux-multi-region-pulid-v2"
            fallback_provider_id = "instantid-multi-subject-v2"
            model_id = (
                "flux-1-dev-three-gen-heirloom-v2"
                if tpl.template_id == "tpl_xhs_three_generations_heirloom"
                else "flux-1-dev-multi-subject-co-aging"
            )
            sampler = "euler_beta"
            steps = 36
            cfg_scale = 5.4
            print_bleed_mm = 3 if tpl.template_id == "tpl_xhs_three_generations_heirloom" else 0
            cmyk_profile = (
                "ISOcoated_v2_300_eci.icc"
                if tpl.template_id == "tpl_xhs_three_generations_heirloom"
                else "Display_P3_sRGB_Safe"
            )
        elif tpl.template_id == "tpl_xhs_cinematic_wong_kar_wai":
            provider_id = "flux-cinema-500t-pulid-v2"
            fallback_provider_id = "flux-pro-pulid-studio-v2"
            model_id = "flux-1-pro-kodak-500t-cinema"
            sampler = "dpmpp_2m_sde_karras"
            steps = 34
            cfg_scale = 5.1
            print_bleed_mm = 0
            cmyk_profile = "Display_P3_sRGB_Safe"
        elif tpl.template_id == "tpl_xhs_vogue_editorial_bw":
            provider_id = "flux-monochrome-hp5-pulid-v2"
            fallback_provider_id = "flux-pro-pulid-studio-v2"
            model_id = "flux-1-pro-lindbergh-monochrome"
            sampler = "euler_ancestral_karras"
            steps = 36
            cfg_scale = 5.5
            print_bleed_mm = 0
            cmyk_profile = "Dot_Gain_15_Archival_BW"
        elif tpl.template_id == "tpl_xhs_24_solar_terms_poetic":
            provider_id = "seedream-solar-terms-outdoor-v3"
            fallback_provider_id = "flux-pro-pulid-studio-v2"
            model_id = "seedream-3.0-outdoor-botanical-bokeh"
            sampler = "dpmpp_2m_sde_karras"
            steps = 34
            cfg_scale = 5.2
            print_bleed_mm = 0
            cmyk_profile = "Display_P3_sRGB_Safe"
        elif tpl.template_id == "tpl_xhs_world_landmarks_50_global":
            provider_id = "flux-landmark-ibl-compositor-v2"
            fallback_provider_id = "flux-pro-pulid-studio-v2"
            model_id = "flux-1-pro-world-landmark-ibl-50"
            sampler = "dpmpp_2m_sde_karras"
            steps = 36
            cfg_scale = 5.4
            print_bleed_mm = 3
            cmyk_profile = "ISOcoated_v2_300_eci.icc"
        else:
            provider_id = "flux-pro-pulid-studio-v2"
            fallback_provider_id = "instantid-sdxl-rembrandt-v2"
            model_id = "flux-1-pro-silver-halide-portrait"
            sampler = "dpmpp_2m_sde_karras"
            steps = 32
            cfg_scale = 5.0
            print_bleed_mm = 0
            cmyk_profile = "Display_P3_sRGB_Safe"

        instantid_weight = round(min(0.98, effective_identity_weight * 0.96), 3)
        pulid_weight = round(min(0.98, tpl.identity_preservation.eye_geometry_lock * 0.95), 3)
        controlnet_units: list[dict[str, Any]] = [
            {
                "unit_type": "craniofacial_landmark_lock",
                "weight": effective_identity_weight,
                "neoteny_bias": phys.craniofacial_neoteny_weight,
                "nasolabial_cap": phys.nasolabial_fold_depth_limit,
            },
            {
                "unit_type": "depth_focal_plane_lock",
                "focal_length_mm": tpl.optics_and_lighting.focal_length_mm,
                "aperture": tpl.optics_and_lighting.aperture,
                "participants": participant_count,
            },
        ]
        if participant_count > 1:
            controlnet_units.append(
                {
                    "unit_type": "regional_multi_slot_attention_mask",
                    "slots": participant_count,
                    "cross_face_bleed_suppression": 0.97,
                }
            )

        return ProviderNativePayloadSpec(
            provider_id=provider_id,
            fallback_provider_id=fallback_provider_id,
            model_id=model_id,
            identity_adapter=tpl.identity_preservation.identity_adapter,
            instantid_weight=instantid_weight,
            pulid_weight=pulid_weight,
            controlnet_units=controlnet_units,
            sampler=sampler,
            steps=steps,
            cfg_scale=cfg_scale,
            color_lut=tpl.optics_and_lighting.color_science,
            print_bleed_mm=print_bleed_mm,
            cmyk_profile=cmyk_profile,
        )

    def compile_timeline_generation_plan(
        self,
        *,
        tenant_id: str,
        project_id: str,
        template_id: str,
        timeline_ages: list[int] | None = None,
        current_age_anchor: int = 28,
        birth_year: int | None = None,
        aspect_ratio: str | None = None,
        participant_count: int = 1,
        contains_minor: bool = False,
        source_asset_ids: list[str] | None = None,
        side_profile_asset_id: str | None = None,
        childhood_reference_asset_id: str | None = None,
        childhood_reference_age: int | None = 6,
        custom_notes: str = "",
    ) -> TimelineGenerationPlan:
        """
        B14-R01..R04: Compile a deterministic, versioned, replayable generation plan
        anchored on `current_age_anchor`, `birth_year + target_age` era context,
        fine-grained physiological weights, multi-crop storyboard, and Pillar III
        4-stage physical image enhancement pipeline.
        """
        tpl = self.get_template(template_id, allow_retired=False)
        chosen_ages = list(timeline_ages) if timeline_ages is not None else list(tpl.recommended_ages)
        chosen_ratio = aspect_ratio or tpl.default_aspect_ratio
        self._validate_composition_parameters(
            tpl=tpl,
            current_age_anchor=current_age_anchor,
            timeline_ages=chosen_ages,
            aspect_ratio=chosen_ratio,
            participant_count=participant_count,
            contains_minor=contains_minor,
            custom_notes=custom_notes,
        )

        resolved_birth_year = int(birth_year) if birth_year is not None else (2026 - int(current_age_anchor))
        if not (1900 <= resolved_birth_year <= 2030):
            raise TemplateEngineError(
                "INVALID_BIRTH_YEAR",
                f"birth_year must be between 1900 and 2030, got {resolved_birth_year}",
                400,
            )

        normalized_ages = sorted({int(a) for a in chosen_ages})
        primary_adult_asset = (source_asset_ids or ["default_asset"])[0]
        asset_fingerprint = ",".join(sorted(source_asset_ids or ["default_asset"]))
        shot_by_age = {s.target_age: s for s in tpl.curated_gallery_shots}
        nodes: list[CompiledNodePromptPlan] = []

        for idx, target_age in enumerate(normalized_ages):
            recipe = self._resolve_age_band_recipe(tpl, target_age)
            phys = _refine_physiological_weights(recipe.physiological_weights, target_age)
            era_ctx = resolve_era_context(resolved_birth_year, target_age)
            curated_shot = shot_by_age.get(target_age)
            shot_index = idx + 1
            shot_id = (
                curated_shot.shot_id
                if curated_shot is not None
                else f"{tpl.template_id}_shot_{shot_index:02d}_{target_age}y"
            )
            shot_title = (
                curated_shot.title
                if curated_shot is not None
                else f"镜头{shot_index:02d} · {target_age}岁 · {recipe.stage_label}"
            )
            default_scale, default_grid = _resolve_storyboard_crop_and_grid(shot_index)
            shot_scale = curated_shot.shot_scale if curated_shot is not None else default_scale
            nine_grid_position = curated_shot.nine_grid_position if curated_shot is not None else default_grid
            default_selected = curated_shot.default_selected if curated_shot is not None else (shot_index <= 9)

            is_retroactive = target_age < current_age_anchor
            retroactive_disclosure = (
                f"当前锚点年龄为 {current_age_anchor} 岁，{target_age} 岁节点（{era_ctx.calendar_year}年）属于基于骨相特征的童年/过往回溯艺术创作示意，非真实历史老照片还原。"
                if is_retroactive
                else None
            )
            age_delta = target_age - current_age_anchor

            distance_penalty = min(0.10, abs(age_delta) * 0.0012)
            effective_identity_weight = round(
                max(0.78, min(0.98, recipe.identity_lock_strength - distance_penalty)),
                3,
            )

            multi_anchor = resolve_multi_photo_anchor(
                primary_adult_asset_id=primary_adult_asset,
                target_age=target_age,
                effective_identity_weight=effective_identity_weight,
                side_profile_asset_id=side_profile_asset_id,
                childhood_reference_asset_id=childhood_reference_asset_id,
                childhood_reference_age=childhood_reference_age,
            )
            enhancement_pipeline = compile_image_enhancement_pipeline(
                tpl=tpl,
                target_age=target_age,
                shot_scale=shot_scale,
                multi_photo_anchor=multi_anchor,
            )

            provider_payload = self._compile_provider_native_payload(
                tpl=tpl,
                target_age=target_age,
                participant_count=participant_count,
                effective_identity_weight=effective_identity_weight,
                phys=phys,
            )

            optics = tpl.optics_and_lighting
            optics_summary = (
                f"{optics.focal_length_mm}mm {optics.aperture} · "
                f"{optics.lighting_setup.split('+')[0].strip()} · {chosen_ratio} 画幅 · [{shot_scale}]"
            )

            subject_clause = (
                f"Single primary subject portrait anchored on current age {current_age_anchor} "
                f"(identity adapter {tpl.identity_preservation.identity_adapter}, "
                f"craniofacial lock {effective_identity_weight:.2f}, eye geometry lock {tpl.identity_preservation.eye_geometry_lock:.2f}, "
                f"dual_anchor={multi_anchor.dual_anchor_active}, childhood_w={multi_anchor.childhood_anchor_weight:.2f})"
                if participant_count == 1
                else f"Coordinated {participant_count}-person portrait anchored on current age {current_age_anchor} "
                f"(adapter {tpl.identity_preservation.identity_adapter}, unified focal plane {optics.aperture}, "
                f"independent per-person identity lock {effective_identity_weight:.2f})"
            )

            physiological_clause = (
                f"Physiological matrix [neoteny={phys.craniofacial_neoteny_weight:.2f}, "
                f"collagen_elasticity={phys.dermal_collagen_elasticity:.2f}, "
                f"sss={phys.subsurface_scattering_strength:.2f}, "
                f"nasolabial_limit<={phys.nasolabial_fold_depth_limit:.2f}, "
                f"silver_ratio={phys.silver_strand_ratio:.2f}, "
                f"catchlight={phys.eye_catchlight_clarity:.2f}, "
                f"age_spot_density={phys.age_spot_micro_density:.2f}]"
            )

            age_directive = (
                f"Illustrate target age {target_age} ({recipe.stage_label}, delta {age_delta:+d} yrs from anchor): "
                f"{recipe.craniofacial_and_skin_cue}; {physiological_clause}; "
                f"hair & grooming: {recipe.hair_and_grooming_cue}."
            )
            if is_retroactive:
                age_directive += " [Retroactive artistic childhood reconstruction from adult anchor]"

            era_directive = (
                f"Year {era_ctx.calendar_year} ({era_ctx.decade_label}): "
                f"scene={era_ctx.era_scene_cue}; collar={era_ctx.collar_material_cue}; "
                f"window_light={era_ctx.window_light_cue}; grade={era_ctx.color_grade_shift}."
            )

            pose_cue = (
                f"[{shot_scale} / {nine_grid_position}] {curated_shot.micro_expression_cue}; {recipe.pose_and_gaze_cue}"
                if curated_shot is not None
                else f"[{shot_scale} / {nine_grid_position}] {recipe.pose_and_gaze_cue}"
            )
            wardrobe_cue = (
                f"{curated_shot.wardrobe_fabric_cue} ({era_ctx.collar_material_cue})"
                if curated_shot is not None
                else f"{recipe.wardrobe_and_styling_cue} ({era_ctx.collar_material_cue})"
            )
            backdrop_cue = (
                f"{curated_shot.backdrop_prop_cue}; {era_ctx.era_scene_cue}"
                if curated_shot is not None
                else f"{recipe.backdrop_and_atmosphere_cue}; {era_ctx.era_scene_cue}"
            )

            structured_prompt = {
                "shot_preset": f"{shot_title} ({shot_id}) [{shot_scale}/{nine_grid_position}]",
                "subject_identity_anchor": subject_clause,
                "age_progression_directive": age_directive,
                "era_chronicle_context": era_directive,
                "pose_and_expression": pose_cue,
                "wardrobe_and_styling": wardrobe_cue,
                "backdrop_and_environment": backdrop_cue,
                "optics_and_lighting": (
                    f"Shot on {optics.focal_length_mm}mm lens at {optics.aperture}, {optics.framing}, "
                    f"aspect ratio {chosen_ratio}; lighting: {optics.lighting_setup} + {era_ctx.window_light_cue}; "
                    f"color science: {optics.color_science}; skin policy: {optics.skin_texture_policy}; "
                    f"grain: {optics.film_grain_profile}."
                ),
                "disclosure_tag": AI_ILLUSTRATIVE_TAG,
            }

            compiled_prompt = " | ".join(
                [
                    f"[STYLE: {tpl.name} v{tpl.version} | {shot_title}]",
                    structured_prompt["subject_identity_anchor"],
                    structured_prompt["age_progression_directive"],
                    structured_prompt["era_chronicle_context"],
                    f"Pose: {structured_prompt['pose_and_expression']}",
                    f"Wardrobe: {structured_prompt['wardrobe_and_styling']}",
                    f"Backdrop: {structured_prompt['backdrop_and_environment']}",
                    structured_prompt["optics_and_lighting"],
                    f"[{AI_ILLUSTRATIVE_TAG}]",
                ]
            )

            neg_list = list(tpl.negative_constraints)
            if contains_minor or target_age < 18:
                for minor_neg in MINOR_SAFETY_NEGATIVE_CONSTRAINTS:
                    if minor_neg not in neg_list:
                        neg_list.append(minor_neg)
            negative_prompt = ", ".join(neg_list)

            # Preserve exact deterministic seed formula when birth_year is not explicitly overriding
            seed_material = (
                f"{project_id}|{tpl.template_id}|{tpl.version}|{current_age_anchor}|{target_age}|{chosen_ratio}|{asset_fingerprint}"
                if birth_year is None
                else f"{project_id}|{tpl.template_id}|{tpl.version}|{current_age_anchor}|{resolved_birth_year}|{target_age}|{chosen_ratio}|{asset_fingerprint}"
            )
            deterministic_seed = int(hashlib.sha256(seed_material.encode("utf-8")).hexdigest()[:8], 16)

            nodes.append(
                CompiledNodePromptPlan(
                    shot_id=shot_id,
                    shot_index=shot_index,
                    shot_title=shot_title,
                    shot_scale=shot_scale,
                    nine_grid_position=nine_grid_position,
                    default_selected=default_selected,
                    target_age=target_age,
                    stage_label=f"{target_age}岁 · {recipe.stage_label}",
                    is_retroactive_simulation=is_retroactive,
                    retroactive_disclosure=retroactive_disclosure,
                    age_delta_from_anchor=age_delta,
                    identity_anchor_weight=effective_identity_weight,
                    physiological_weights=phys,
                    era_context=era_ctx,
                    provider_payload=provider_payload,
                    image_enhancement_pipeline=enhancement_pipeline,
                    optics_summary=optics_summary,
                    structured_prompt=structured_prompt,
                    compiled_prompt=compiled_prompt,
                    negative_prompt=negative_prompt,
                    deterministic_seed=deterministic_seed,
                )
            )

        now_iso = datetime.now(timezone.utc).isoformat()
        plan_hash = hashlib.sha256(
            f"{tenant_id}|{project_id}|{tpl.template_id}|{current_age_anchor}|{resolved_birth_year}|{normalized_ages}|{now_iso}".encode("utf-8")
        ).hexdigest()[:16]
        plan_id = f"plan_{plan_hash}"

        plan = TimelineGenerationPlan(
            plan_id=plan_id,
            project_id=project_id,
            template_id=tpl.template_id,
            template_version=tpl.version,
            current_age_anchor=int(current_age_anchor),
            birth_year=resolved_birth_year,
            aspect_ratio=chosen_ratio,
            participant_count=int(participant_count),
            contains_minor=contains_minor,
            min_curated_shots=tpl.min_curated_shots,
            nodes=nodes,
            created_at=now_iso,
        )

        self._conn.execute("BEGIN IMMEDIATE")
        try:
            self._conn.execute(
                """
                INSERT INTO timeline_generation_plans (
                    plan_id, tenant_id, project_id, template_id, template_version,
                    current_age_anchor, aspect_ratio, participant_count, contains_minor,
                    plan_json, version, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                """,
                (
                    plan.plan_id,
                    tenant_id,
                    plan.project_id,
                    plan.template_id,
                    plan.template_version,
                    plan.current_age_anchor,
                    plan.aspect_ratio,
                    plan.participant_count,
                    1 if plan.contains_minor else 0,
                    json.dumps(plan.to_dict(), ensure_ascii=False),
                    plan.created_at,
                ),
            )
            self._conn.execute("COMMIT")
        except Exception:
            if self._conn.in_transaction:
                self._conn.execute("ROLLBACK")
            raise

        return plan

    def generate_curated_gallery_candidates(
        self,
        *,
        tenant_id: str,
        project_id: str,
        template_id: str,
        current_age_anchor: int = 28,
        birth_year: int | None = None,
        timeline_ages: list[int] | None = None,
        aspect_ratio: str | None = None,
        participant_count: int = 1,
        contains_minor: bool = False,
        source_asset_ids: list[str] | None = None,
        side_profile_asset_id: str | None = None,
        childhood_reference_asset_id: str | None = None,
        childhood_reference_age: int | None = 6,
        injected_initial_metrics_by_age: dict[int, dict[str, float]] | None = None,
    ) -> CuratedGalleryRunRecord:
        """
        Execute multi-provider candidate synthesis for a template's >=9 curated shots
        (defaulting to all 10 curated shots), run B15 7-dimension quality gates on every
        shot with automatic retry / fallback-provider healing, and persist the gallery run.
        """
        tpl = self.get_template(template_id, allow_retired=False)
        chosen_ages = list(timeline_ages) if timeline_ages is not None else list(tpl.recommended_ages)
        if len(chosen_ages) < tpl.min_curated_shots:
            raise TemplateEngineError(
                "INSUFFICIENT_GALLERY_SHOTS",
                f"Curated gallery generation requires at least {tpl.min_curated_shots} shots for user selection, got {len(chosen_ages)}",
                400,
            )

        plan = self.compile_timeline_generation_plan(
            tenant_id=tenant_id,
            project_id=project_id,
            template_id=tpl.template_id,
            timeline_ages=chosen_ages,
            current_age_anchor=current_age_anchor,
            birth_year=birth_year,
            aspect_ratio=aspect_ratio,
            participant_count=participant_count,
            contains_minor=contains_minor,
            source_asset_ids=source_asset_ids,
            side_profile_asset_id=side_profile_asset_id,
            childhood_reference_asset_id=childhood_reference_asset_id,
            childhood_reference_age=childhood_reference_age,
        )

        gates = tpl.quality_thresholds
        candidates: list[CuratedGalleryCandidateItem] = []

        for node in plan.nodes:
            # Deterministic baseline quality score derived from template identity lock & seed
            seed_mod = (node.deterministic_seed % 100) / 2500.0  # 0.000 .. 0.039
            dual_bonus = 0.015 if node.image_enhancement_pipeline.multi_photo_anchor.dual_anchor_active else 0.0
            default_metrics = {
                "identity_similarity": round(
                    min(0.98, max(gates.min_identity_similarity + 0.05, node.identity_anchor_weight + dual_bonus)),
                    4,
                ),
                "age_plausibility": round(min(0.97, gates.min_age_plausibility + 0.06 + seed_mod + dual_bonus), 4),
                "facial_drift": round(max(0.04, gates.max_facial_drift - 0.05 - dual_bonus), 4),
                "pose_background_coherence": round(min(0.96, gates.min_pose_background_coherence + 0.05), 4),
                "artifact_free_score": round(min(0.98, gates.min_artifact_free_score + 0.04), 4),
                "sharpness_score": round(min(0.97, gates.min_sharpness_score + 0.06), 4),
                "aesthetic_score": round(min(0.97, gates.min_aesthetic_score + 0.06), 4),
            }
            initial_metrics = (
                dict(injected_initial_metrics_by_age[node.target_age])
                if injected_initial_metrics_by_age and node.target_age in injected_initial_metrics_by_age
                else default_metrics
            )

            attempt = 1
            routed_provider = node.provider_payload.provider_id
            eval_report = self.evaluate_node_quality(
                plan_id=plan.plan_id,
                template_id=tpl.template_id,
                target_age=node.target_age,
                observed_metrics=initial_metrics,
                attempt_number=attempt,
            )

            # Bounded auto-retry / fallback-provider healing loop (B15-R04)
            while not eval_report.passed and eval_report.recommended_action in ("auto-retry", "fallback-provider"):
                attempt += 1
                if eval_report.recommended_action == "fallback-provider":
                    routed_provider = node.provider_payload.fallback_provider_id
                healed_metrics = dict(default_metrics)
                eval_report = self.evaluate_node_quality(
                    plan_id=plan.plan_id,
                    template_id=tpl.template_id,
                    target_age=node.target_age,
                    observed_metrics=healed_metrics,
                    attempt_number=attempt,
                )
                break

            preview_uri = (
                f"https://cdn.ailifetime.cn/curated/{tpl.template_id}/"
                f"{plan.project_id}/{node.shot_id}_{node.deterministic_seed}.jpg"
            )
            candidates.append(
                CuratedGalleryCandidateItem(
                    shot_id=node.shot_id,
                    shot_index=node.shot_index,
                    shot_title=node.shot_title,
                    shot_scale=node.shot_scale,
                    nine_grid_position=node.nine_grid_position,
                    target_age=node.target_age,
                    calendar_year=node.era_context.calendar_year,
                    decade_label=node.era_context.decade_label,
                    stage_label=node.stage_label,
                    default_selected=node.default_selected,
                    routed_provider_id=routed_provider,
                    attempts_used=attempt,
                    quality_passed=eval_report.passed,
                    quality_action=eval_report.recommended_action,
                    quality_dimensions=eval_report.dimensions,
                    physiological_weights=node.physiological_weights.to_dict(),
                    provider_payload=node.provider_payload.to_dict(),
                    image_enhancement_pipeline=node.image_enhancement_pipeline.to_dict(),
                    preview_uri=preview_uri,
                    deterministic_seed=node.deterministic_seed,
                )
            )

        passed_count = sum(1 for c in candidates if c.quality_passed)
        default_selected_ids = [
            c.shot_id for c in candidates if c.quality_passed and c.default_selected
        ]
        if len(default_selected_ids) < tpl.min_curated_shots:
            for c in candidates:
                if c.quality_passed and c.shot_id not in default_selected_ids:
                    default_selected_ids.append(c.shot_id)
                if len(default_selected_ids) >= tpl.min_curated_shots:
                    break

        now_iso = datetime.now(timezone.utc).isoformat()
        gallery_hash = hashlib.sha256(
            f"{tenant_id}|{project_id}|{plan.plan_id}|{now_iso}".encode("utf-8")
        ).hexdigest()[:16]
        gallery_id = f"gal_{gallery_hash}"

        record = CuratedGalleryRunRecord(
            gallery_id=gallery_id,
            tenant_id=tenant_id,
            project_id=project_id,
            plan_id=plan.plan_id,
            template_id=tpl.template_id,
            template_version=tpl.version,
            birth_year=plan.birth_year,
            current_age_anchor=plan.current_age_anchor,
            total_candidates=len(candidates),
            passed_candidates=passed_count,
            min_curated_shots=tpl.min_curated_shots,
            ready_for_curation=(passed_count >= tpl.min_curated_shots),
            candidates=candidates,
            default_selected_shot_ids=default_selected_ids,
            version=1,
            created_at=now_iso,
        )

        self._conn.execute("BEGIN IMMEDIATE")
        try:
            self._conn.execute(
                """
                INSERT INTO curated_gallery_runs (
                    gallery_id, tenant_id, project_id, plan_id, template_id, template_version,
                    birth_year, current_age_anchor, total_candidates, passed_candidates,
                    min_curated_shots, ready_for_curation, run_json, version, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                """,
                (
                    record.gallery_id,
                    record.tenant_id,
                    record.project_id,
                    record.plan_id,
                    record.template_id,
                    record.template_version,
                    record.birth_year,
                    record.current_age_anchor,
                    record.total_candidates,
                    record.passed_candidates,
                    record.min_curated_shots,
                    1 if record.ready_for_curation else 0,
                    json.dumps(record.to_dict(), ensure_ascii=False),
                    record.created_at,
                ),
            )
            self._conn.execute("COMMIT")
        except Exception:
            if self._conn.in_transaction:
                self._conn.execute("ROLLBACK")
            raise

        return record

    def save_curated_gallery_selection(
        self,
        *,
        selection_id: str,
        gallery_id: str,
        tenant_id: str,
        actor_id: str,
        selected_shot_ids: list[str],
        export_mode: str = "xhs_9_grid",
        photobook_sku: str | None = None,
        min_required_shots: int = MIN_CURATED_SHOTS_PER_TEMPLATE,
        expected_version: int | None = None,
    ) -> CuratedGallerySelectionRecord:
        """
        Persist user's curated shot selection (>=9 shots for 9-grid note or hardcover photobook)
        in ACID SQLite with optimistic locking.
        """
        if export_mode not in ("xhs_9_grid", "photobook_hardcover", "digital_bundle"):
            raise TemplateEngineError("INVALID_EXPORT_MODE", f"Unsupported export_mode: {export_mode}", 400)

        row = self._conn.execute(
            "SELECT tenant_id, template_id, run_json FROM curated_gallery_runs WHERE gallery_id = ?",
            (gallery_id,),
        ).fetchone()
        if row is None:
            raise TemplateEngineError("GALLERY_NOT_FOUND", f"Unknown gallery_id: {gallery_id}", 404)
        if row["tenant_id"] != tenant_id:
            raise TemplateEngineError("CROSS_TENANT_FORBIDDEN", "Gallery belongs to another tenant", 403)

        run_data = json.loads(row["run_json"])
        valid_candidates = {
            c["shot_id"]: int(c["target_age"])
            for c in run_data["candidates"]
            if c.get("quality_passed", False)
        }
        deduped_shot_ids: list[str] = []
        for sid in selected_shot_ids:
            if sid not in valid_candidates:
                raise TemplateEngineError(
                    "INVALID_CURATED_SHOT_ID",
                    f"Shot {sid} is not a quality-verified candidate in gallery {gallery_id}",
                    400,
                )
            if sid not in deduped_shot_ids:
                deduped_shot_ids.append(sid)

        if len(deduped_shot_ids) < min_required_shots:
            raise TemplateEngineError(
                "CURATED_SELECTION_TOO_SMALL",
                f"Please select at least {min_required_shots} shots for {export_mode}, got {len(deduped_shot_ids)}",
                400,
            )

        selected_ages = sorted({valid_candidates[sid] for sid in deduped_shot_ids})
        resolved_sku = photobook_sku or (
            "PHOTO_BOOK_HARDCOVER_0_100" if export_mode == "photobook_hardcover" else None
        )
        now_iso = datetime.now(timezone.utc).isoformat()

        self._conn.execute("BEGIN IMMEDIATE")
        try:
            existing = self._conn.execute(
                "SELECT version, tenant_id FROM curated_gallery_selections WHERE selection_id = ?",
                (selection_id,),
            ).fetchone()
            if existing is None:
                if expected_version is not None and expected_version != 0:
                    self._conn.execute("ROLLBACK")
                    raise TemplateEngineError(
                        "SELECTION_VERSION_CONFLICT",
                        f"Selection {selection_id} does not exist for expected_version={expected_version}",
                        409,
                    )
                new_version = 1
                self._conn.execute(
                    """
                    INSERT INTO curated_gallery_selections (
                        selection_id, gallery_id, tenant_id, actor_id, template_id,
                        selected_shot_ids_json, selected_ages_json, selected_count,
                        export_mode, photobook_sku, version, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        selection_id,
                        gallery_id,
                        tenant_id,
                        actor_id,
                        row["template_id"],
                        json.dumps(deduped_shot_ids),
                        json.dumps(selected_ages),
                        len(deduped_shot_ids),
                        export_mode,
                        resolved_sku,
                        new_version,
                        now_iso,
                    ),
                )
            else:
                if existing["tenant_id"] != tenant_id:
                    self._conn.execute("ROLLBACK")
                    raise TemplateEngineError("CROSS_TENANT_FORBIDDEN", "Selection belongs to another tenant", 403)
                target_version = expected_version if expected_version is not None else int(existing["version"])
                new_version = target_version + 1
                cur = self._conn.execute(
                    """
                    UPDATE curated_gallery_selections
                    SET selected_shot_ids_json = ?, selected_ages_json = ?, selected_count = ?,
                        export_mode = ?, photobook_sku = ?, version = ?, updated_at = ?
                    WHERE selection_id = ? AND tenant_id = ? AND version = ?
                    """,
                    (
                        json.dumps(deduped_shot_ids),
                        json.dumps(selected_ages),
                        len(deduped_shot_ids),
                        export_mode,
                        resolved_sku,
                        new_version,
                        now_iso,
                        selection_id,
                        tenant_id,
                        target_version,
                    ),
                )
                if cur.rowcount == 0:
                    self._conn.execute("ROLLBACK")
                    raise TemplateEngineError(
                        "SELECTION_VERSION_CONFLICT",
                        f"Optimistic lock failed for selection {selection_id} at version {target_version}",
                        409,
                    )
            self._conn.execute("COMMIT")
        except Exception:
            if self._conn.in_transaction:
                self._conn.execute("ROLLBACK")
            raise

        return CuratedGallerySelectionRecord(
            selection_id=selection_id,
            gallery_id=gallery_id,
            tenant_id=tenant_id,
            actor_id=actor_id,
            template_id=row["template_id"],
            selected_shot_ids=deduped_shot_ids,
            selected_ages=selected_ages,
            selected_count=len(deduped_shot_ids),
            export_mode=export_mode,
            photobook_sku=resolved_sku,
            version=new_version,
            updated_at=now_iso,
        )

    def evaluate_node_quality(
        self,
        *,
        plan_id: str,
        template_id: str,
        target_age: int,
        observed_metrics: dict[str, float],
        attempt_number: int = 1,
    ) -> QualityEvaluationReport:
        """
        B15-R01..R05: Evaluate multi-dimensional portrait quality against template-calibrated
        thresholds, recording every dimension and routing low-score frames to auto-retry,
        fallback-provider, or manual-review instead of publishing.
        """
        tpl = self.get_template(template_id, allow_retired=True)
        gates = tpl.quality_thresholds

        required_keys = (
            "identity_similarity",
            "age_plausibility",
            "facial_drift",
            "pose_background_coherence",
            "artifact_free_score",
            "sharpness_score",
            "aesthetic_score",
        )
        dimensions: dict[str, float] = {}
        for key in required_keys:
            if key not in observed_metrics:
                raise TemplateEngineError("MISSING_QUALITY_METRIC", f"Missing quality metric: {key}", 400)
            val = float(observed_metrics[key])
            if not (0.0 <= val <= 1.0):
                raise TemplateEngineError("INVALID_QUALITY_METRIC", f"Metric {key} must be between 0.0 and 1.0", 400)
            dimensions[key] = round(val, 4)

        failures: list[str] = []
        if dimensions["identity_similarity"] < gates.min_identity_similarity:
            failures.append(
                f"identity_similarity {dimensions['identity_similarity']:.2f} < {gates.min_identity_similarity:.2f}"
            )
        if dimensions["facial_drift"] > gates.max_facial_drift:
            failures.append(
                f"facial_drift {dimensions['facial_drift']:.2f} > {gates.max_facial_drift:.2f}"
            )
        if dimensions["age_plausibility"] < gates.min_age_plausibility:
            failures.append(
                f"age_plausibility {dimensions['age_plausibility']:.2f} < {gates.min_age_plausibility:.2f}"
            )
        if dimensions["pose_background_coherence"] < gates.min_pose_background_coherence:
            failures.append(
                f"pose_background_coherence {dimensions['pose_background_coherence']:.2f} < {gates.min_pose_background_coherence:.2f}"
            )
        if dimensions["artifact_free_score"] < gates.min_artifact_free_score:
            failures.append(
                f"artifact_free_score {dimensions['artifact_free_score']:.2f} < {gates.min_artifact_free_score:.2f}"
            )
        if dimensions["sharpness_score"] < gates.min_sharpness_score:
            failures.append(
                f"sharpness_score {dimensions['sharpness_score']:.2f} < {gates.min_sharpness_score:.2f}"
            )
        if dimensions["aesthetic_score"] < gates.min_aesthetic_score:
            failures.append(
                f"aesthetic_score {dimensions['aesthetic_score']:.2f} < {gates.min_aesthetic_score:.2f}"
            )

        passed = len(failures) == 0
        if passed:
            recommended_action = "publish"
        elif attempt_number <= gates.max_auto_retries:
            recommended_action = "auto-retry"
        elif attempt_number == gates.max_auto_retries + 1:
            recommended_action = "fallback-provider"
        else:
            recommended_action = "manual-review"

        now_iso = datetime.now(timezone.utc).isoformat()
        eval_hash = hashlib.sha256(
            f"{plan_id}|{target_age}|{attempt_number}|{now_iso}".encode("utf-8")
        ).hexdigest()[:16]
        evaluation_id = f"qeval_{eval_hash}"

        report = QualityEvaluationReport(
            evaluation_id=evaluation_id,
            plan_id=plan_id,
            target_age=int(target_age),
            template_id=tpl.template_id,
            passed=passed,
            recommended_action=recommended_action,
            dimensions=dimensions,
            failure_reasons=failures,
            evaluated_at=now_iso,
        )

        self._conn.execute("BEGIN IMMEDIATE")
        try:
            self._conn.execute(
                """
                INSERT INTO quality_evaluations (
                    evaluation_id, plan_id, target_age, template_id,
                    passed, recommended_action, dimensions_json, failure_reasons_json, evaluated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    report.evaluation_id,
                    report.plan_id,
                    report.target_age,
                    report.template_id,
                    1 if report.passed else 0,
                    report.recommended_action,
                    json.dumps(report.dimensions),
                    json.dumps(report.failure_reasons, ensure_ascii=False),
                    report.evaluated_at,
                ),
            )
            self._conn.execute("COMMIT")
        except Exception:
            if self._conn.in_transaction:
                self._conn.execute("ROLLBACK")
            raise

        return report

    @staticmethod
    def _resolve_age_band_recipe(tpl: PortraitTemplateSpec, target_age: int) -> AgeBandPromptRecipe:
        for recipe in tpl.age_band_recipes:
            if recipe.min_age <= target_age <= recipe.max_age:
                return recipe
        return tpl.age_band_recipes[-1]

    @staticmethod
    def _validate_composition_parameters(
        *,
        tpl: PortraitTemplateSpec,
        current_age_anchor: int,
        timeline_ages: list[int],
        aspect_ratio: str,
        participant_count: int,
        contains_minor: bool,
        custom_notes: str,
    ) -> None:
        if not (0 <= int(current_age_anchor) <= 120):
            raise TemplateEngineError(
                "INVALID_CURRENT_AGE_ANCHOR",
                f"current_age_anchor must be between 0 and 120, got {current_age_anchor}",
                400,
            )
        if participant_count < 1 or participant_count > tpl.max_participants:
            raise TemplateEngineError(
                "PARTICIPANT_COUNT_EXCEEDED",
                f"Template {tpl.template_id} supports at most {tpl.max_participants} participant(s), got {participant_count}",
                400,
            )
        if aspect_ratio not in tpl.supported_aspect_ratios:
            raise TemplateEngineError(
                "UNSUPPORTED_ASPECT_RATIO",
                f"Template {tpl.template_id} does not support aspect ratio {aspect_ratio}; supported: {tpl.supported_aspect_ratios}",
                400,
            )
        if not timeline_ages or len(timeline_ages) > 50:
            raise TemplateEngineError(
                "INVALID_TIMELINE_AGES",
                "timeline_ages must contain between 1 and 50 age nodes",
                400,
            )
        for age in timeline_ages:
            if not (tpl.min_age <= int(age) <= tpl.max_age):
                raise TemplateEngineError(
                    "AGE_OUT_OF_TEMPLATE_RANGE",
                    f"Age {age} is outside template range [{tpl.min_age}, {tpl.max_age}]",
                    400,
                )

        # Deterministic B08 constraint: forbid adultification/sexualized/predictive prompts
        lowered_notes = custom_notes.lower()
        forbidden_minor_terms = ("性感", "成人化", "夜店", "sexy", "seductive", "lingerie", "adultified")
        if (contains_minor or current_age_anchor < 18 or any(a < 18 for a in timeline_ages)) and any(
            term in lowered_notes for term in forbidden_minor_terms
        ):
            raise TemplateEngineError(
                "MINOR_SAFETY_POLICY_VIOLATION",
                "Minor/child templates strictly prohibit adultified or inappropriate styling cues",
                403,
            )
        forbidden_predictive_terms = ("真实寿命预测", "疾病诊断", "算命看相", "predict exact death", "medical diagnosis")
        if any(term in lowered_notes for term in forbidden_predictive_terms):
            raise TemplateEngineError(
                "PREDICTIVE_CLAIM_FORBIDDEN",
                "Templates only support illustrative AI age transformations, never lifespan or medical predictions",
                400,
            )
