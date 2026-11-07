"""
AI Life Time Machine - Built-in Competitive Portrait Template Catalog,
Deterministic Prompt Plan Compiler & Multi-Dimensional Quality Gate Engine.

Implements:
- B08-R01..R05: Default 0..100 age nodes with current-age continuity anchor,
  template capability declarations (max_participants, age range, aspect ratios,
  required consents, provider capabilities, cost tier, channels), versioned
  composition draft persistence with optimistic locking, illustrative age
  transformation language, and pre-publish template governance checks.
- B14-R01..R05: Current-age & source-photo identity anchoring, retroactive
  childhood creative simulation disclosure, structured versioned prompt plan
  (separating identity, age progression, pose, wardrobe, backdrop, optics/lighting,
  and negative constraints), deterministic seed derivation, and partial-delivery
  hold for nodes failing quality gates.
- B15-R01..R05: Multi-dimensional quality evaluation (identity similarity,
  age plausibility, facial drift, pose/background coherence, hand/teeth/eye
  artifact-free score, sharpness, aesthetic score) with per-template thresholds
  and bounded retry / fallback-provider / manual-review routing.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any


DEFAULT_TIMELINE_AGES: tuple[int, ...] = (0, 5, 10, 18, 25, 35, 45, 55, 65, 75, 85, 100)
RECOMMENDED_XHS_AGES: tuple[int, ...] = (6, 18, 28, 45, 65, 85)
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
    recommended_ages: list[int]
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
    target_age: int
    stage_label: str
    is_retroactive_simulation: bool
    retroactive_disclosure: str | None
    age_delta_from_anchor: int
    identity_anchor_weight: float
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
    aspect_ratio: str
    participant_count: int
    contains_minor: bool
    nodes: list[CompiledNodePromptPlan]
    created_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "project_id": self.project_id,
            "template_id": self.template_id,
            "template_version": self.template_version,
            "current_age_anchor": self.current_age_anchor,
            "aspect_ratio": self.aspect_ratio,
            "participant_count": self.participant_count,
            "contains_minor": self.contains_minor,
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
                "authentic childhood craniofacial neoteny, higher forehead-to-jaw ratio, "
                "soft baby-fat buccal fullness, translucent natural skin texture with zero adult makeup, "
                "preserving exact interpupillary distance, canthal tilt, and ear helix geometry"
            ),
            hair_and_grooming_cue="fine soft natural childhood hair strands, clean natural hairline",
            wardrobe_and_styling_cue=f"age-appropriate childhood soft cotton/knit collar ({wardrobe_theme})",
            pose_and_gaze_cue="curious clear eye contact, relaxed natural head tilt, bright catchlights",
            backdrop_and_atmosphere_cue=f"warm nostalgic studio ambiance ({backdrop_theme})",
            identity_lock_strength=0.84,
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
            pose_and_gaze_cue="upright posture, sincere calm gaze toward camera",
            backdrop_and_atmosphere_cue=f"soft daylight-balanced studio backdrop ({backdrop_theme})",
            identity_lock_strength=0.88,
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
        ),
        AgeBandPromptRecipe(
            band_key="maturity_36_50",
            min_age=36,
            max_age=50,
            stage_label="从容岁月",
            craniofacial_and_skin_cue=(
                "composed mid-life facial maturity, subtle natural lateral canthal laugh lines and gentle "
                "nasolabial fold deepening, refined cheekbone contour, authentic mid-life skin elasticity "
                "without exaggerated premature aging"
            ),
            hair_and_grooming_cue="mature hair density with occasional subtle temple silver threads",
            wardrobe_and_styling_cue=f"refined wool/cashmere or structured linen collar ({wardrobe_theme})",
            pose_and_gaze_cue="grounded calm presence, warm experienced gaze, relaxed shoulders",
            backdrop_and_atmosphere_cue=f"rich tonal portrait atmosphere ({backdrop_theme})",
            identity_lock_strength=0.92,
        ),
        AgeBandPromptRecipe(
            band_key="silver_prime_51_68",
            min_age=51,
            max_age=68,
            stage_label="温情银发",
            craniofacial_and_skin_cue=(
                "graceful early-senior bone and soft-tissue evolution, natural periorbital crow's feet, "
                "authentic forehead and nasolabial expression lines, realistic dermal texture with subtle "
                "age pigment micro-variation while strictly preserving core eye and nose geometry"
            ),
            hair_and_grooming_cue="natural salt-and-pepper to luminous silver hair strands with realistic texture",
            wardrobe_and_styling_cue=f"warm timeless knit or classic shawl collar ({wardrobe_theme})",
            pose_and_gaze_cue="gentle benevolent expression, warm eye catchlights, dignified posture",
            backdrop_and_atmosphere_cue=f"warm intimate studio light falloff ({backdrop_theme})",
            identity_lock_strength=0.89,
        ),
        AgeBandPromptRecipe(
            band_key="elder_69_84",
            min_age=69,
            max_age=84,
            stage_label="岁月沉淀",
            craniofacial_and_skin_cue=(
                "dignified elder facial anatomy, natural subcutaneous volume softening along mandible, "
                "authentic multi-layered fine and deep skin creases, realistic translucent epidermal texture, "
                "unmistakably the same person's orbital socket, nasal bridge, and gaze character"
            ),
            hair_and_grooming_cue="soft silver-white hair with natural thinning and fine halo wisping",
            wardrobe_and_styling_cue=f"classic soft-textured cardigan or heritage collar ({wardrobe_theme})",
            pose_and_gaze_cue="serene reflective gaze, warm lived-in smile lines, composed head posture",
            backdrop_and_atmosphere_cue=f"classic fine-art portrait shadow depth ({backdrop_theme})",
            identity_lock_strength=0.86,
        ),
        AgeBandPromptRecipe(
            band_key="centenarian_85_100",
            min_age=85,
            max_age=120,
            stage_label="世纪回眸",
            craniofacial_and_skin_cue=(
                "reverent centenarian artistic portrait, delicate parchment-like dermal micro-topography, "
                "deeply etched yet harmonious life lines, preserved ocular spacing and signature gaze spirit, "
                "free of grotesque distortion or horror-valley artifacts"
            ),
            hair_and_grooming_cue="pure gossamer silver-white hair illuminated by gentle rim light",
            wardrobe_and_styling_cue=f"timeless dignified high-neck wool or silk wrap ({wardrobe_theme})",
            pose_and_gaze_cue="peaceful luminous eyes, quiet dignity, timeless frontal-three-quarter framing",
            backdrop_and_atmosphere_cue=f"museum-grade chiaroscuro portrait ambiance ({backdrop_theme})",
            identity_lock_strength=0.83,
        ),
    ]


def build_builtin_portrait_templates() -> list[PortraitTemplateSpec]:
    """Construct the 5 flagship competitive built-in portrait templates."""
    return [
        PortraitTemplateSpec(
            template_id="tpl_xhs_silver_halide_0_100",
            version="2.1.0",
            name="经典银盐胶片·人生时间轴",
            subtitle="85mm 大光圈人像定焦 · 伦勃朗柔光 · 真实肌理零塑料感",
            category="solo-portrait",
            badge="小红书爆款主推",
            status="active",
            max_participants=1,
            min_age=0,
            max_age=100,
            recommended_ages=list(RECOMMENDED_XHS_AGES),
            supported_aspect_ratios=["3:4", "4:5", "1:1", "9:16"],
            default_aspect_ratio="3:4",
            required_consents=["age-transformation"],
            provider_capabilities=["face-id-lock", "controlnet-depth", "high-res-skin-detail"],
            cost_tier="pro-studio",
            allowed_channels=["mp-xhs", "mp-weixin", "consumer-web", "mobile", "studio"],
            competitive_highlights=[
                "85mm f/1.8 黄金人像焦段，锁定同一视平线与焦平面，6 张拼图如同一位摄影师跨越半世纪跟拍",
                "真实皮肤微孔与皮下散射（SSS）质感，严禁廉价磨皮与假胡子贴图",
                "以用户当前真实年龄为骨相锚点向两端自然推演，支持童年回溯创作标注",
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
            version="2.1.0",
            name="东方光影新中式·岁月肖像",
            subtitle="90mm 微距人像 · 宣纸窗光 · 温润东方骨相美学",
            category="editorial",
            badge="新中式高赞",
            status="active",
            max_participants=1,
            min_age=0,
            max_age=100,
            recommended_ages=list(RECOMMENDED_XHS_AGES),
            supported_aspect_ratios=["3:4", "4:5", "9:16"],
            default_aspect_ratio="3:4",
            required_consents=["age-transformation"],
            provider_capabilities=["face-id-lock", "editorial-lighting", "high-res-skin-detail"],
            cost_tier="pro-studio",
            allowed_channels=["mp-xhs", "mp-weixin", "consumer-web", "studio"],
            competitive_highlights=[
                "针对亚洲面部骨相与折叠度专门调校的柔和侧逆光，避免欧美模型常见的深眼窝异化",
                "桑蚕丝、苎麻与羊绒领口质感随年龄阶段自然演进，极具小红书高赞清冷故事感",
                "水墨灰阶留白背景，突出人物眼神流转与岁月从容气韵",
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
            version="2.1.0",
            name="时代纪实记忆·年代光影胶片",
            subtitle="50mm 纪实人文镜头 · 跨年代生活光影 · 家庭相册真迹感",
            category="documentary",
            badge="情感共鸣王牌",
            status="active",
            max_participants=1,
            min_age=0,
            max_age=100,
            recommended_ages=list(RECOMMENDED_XHS_AGES),
            supported_aspect_ratios=["3:4", "1:1", "4:5"],
            default_aspect_ratio="3:4",
            required_consents=["age-transformation"],
            provider_capabilities=["face-id-lock", "scene-depth-lock"],
            cost_tier="standard",
            allowed_channels=["mp-xhs", "mp-weixin", "consumer-web", "mobile"],
            competitive_highlights=[
                "50mm f/1.4 经典人文视角，呈现真实生活环境光（阳光书房、老院子、暖光窗边）",
                "像翻开一本跨越百年的私人家庭纪实相册，极具真实感与情绪感染力",
                "严格锁定视线高度与中心构图，非常适合制作滑动对比或宫格卡点笔记",
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
            version="2.1.0",
            name="温情伴侣/家人共老·时光合拍",
            subtitle="双人/多人同框授权 · 统一主光与焦平面 · 跨越半世纪的陪伴",
            category="family-co-aging",
            badge="家庭/伴侣必拍",
            status="active",
            max_participants=3,
            min_age=0,
            max_age=100,
            recommended_ages=[18, 28, 45, 65, 85],
            supported_aspect_ratios=["3:4", "4:5", "1:1"],
            default_aspect_ratio="3:4",
            required_consents=["age-transformation", "family-co-aging"],
            provider_capabilities=["multi-subject-face-lock", "dual-focal-plane-control", "high-res-skin-detail"],
            cost_tier="pro-studio",
            allowed_channels=["mp-xhs", "mp-weixin", "consumer-web", "studio"],
            competitive_highlights=[
                "支持 1—3 人逐人独立授权合拍，自动对齐多人面部光照方向与 f/2.8 景深平面",
                "解决多人合成常见的“各看各的、光影割裂、头身比失调”痛点",
                "内置未成年人保护策略：含未成年人出镜时默认私密并禁止公开挂载",
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
            version="2.1.0",
            name="典藏画册高定棚拍·实体印刷版",
            subtitle="中画幅 4:5 印刷画幅 · 300DPI 色彩预检 · 专供精装时光相册",
            category="fine-art-print",
            badge="实物相册专享",
            status="active",
            max_participants=2,
            min_age=0,
            max_age=100,
            recommended_ages=list(RECOMMENDED_XHS_AGES),
            supported_aspect_ratios=["4:5", "3:4", "1:1"],
            default_aspect_ratio="4:5",
            required_consents=["age-transformation", "physical-print"],
            provider_capabilities=["face-id-lock", "print-300dpi-upscale", "cmyk-gamut-safe"],
            cost_tier="master-print",
            allowed_channels=["mp-xhs", "mp-weixin", "consumer-web", "studio", "kiosk"],
            competitive_highlights=[
                "按商业影楼中画幅（Hasselblad 80mm）棚拍标准设计，暗部层次针对实体相册纸张油墨优化",
                "预留 3mm 印刷出血位安全构图，直连 99 元典藏精装时光相册（PHOTO_BOOK_HARDCOVER_0_100）",
                "最高的身份相似度（>=0.85）与审美门控阈值，确保实物印刷零瑕疵",
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
    ]


LEGACY_TEMPLATE_ALIASES: dict[str, str] = {
    "tpl_xhs_0_100_timeline": "tpl_xhs_silver_halide_0_100",
}


class PortraitTemplateEngine:
    """
    ACID SQLite-backed Template Catalog, Composition Draft Store,
    Deterministic Timeline Prompt Compiler, and B15 Quality Gate Evaluator.
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
            recommended_ages=[int(a) for a in raw["recommended_ages"]],
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
            age_band_recipes=[AgeBandPromptRecipe(**r) for r in raw["age_band_recipes"]],
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

    def compile_timeline_generation_plan(
        self,
        *,
        tenant_id: str,
        project_id: str,
        template_id: str,
        timeline_ages: list[int],
        current_age_anchor: int = 28,
        aspect_ratio: str | None = None,
        participant_count: int = 1,
        contains_minor: bool = False,
        source_asset_ids: list[str] | None = None,
        custom_notes: str = "",
    ) -> TimelineGenerationPlan:
        """
        B14-R01..R04: Compile a deterministic, versioned, replayable generation plan
        anchored on `current_age_anchor` and structured photography prompt components.
        """
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
        asset_fingerprint = ",".join(sorted(source_asset_ids or ["default_asset"]))
        nodes: list[CompiledNodePromptPlan] = []

        for target_age in normalized_ages:
            recipe = self._resolve_age_band_recipe(tpl, target_age)
            is_retroactive = target_age < current_age_anchor
            retroactive_disclosure = (
                f"当前锚点年龄为 {current_age_anchor} 岁，{target_age} 岁节点属于基于骨相特征的童年/过往回溯艺术创作示意，非真实历史老照片还原。"
                if is_retroactive
                else None
            )
            age_delta = target_age - current_age_anchor

            # Adjust identity lock weight smoothly around the current-age anchor
            distance_penalty = min(0.10, abs(age_delta) * 0.0012)
            effective_identity_weight = round(
                max(0.78, min(0.98, recipe.identity_lock_strength - distance_penalty)),
                3,
            )

            optics = tpl.optics_and_lighting
            optics_summary = (
                f"{optics.focal_length_mm}mm {optics.aperture} · "
                f"{optics.lighting_setup.split('+')[0].strip()} · { chosen_ratio } 画幅"
            )

            subject_clause = (
                f"Single primary subject portrait anchored on current age {current_age_anchor} "
                f"(identity adapter {tpl.identity_preservation.identity_adapter}, "
                f"craniofacial lock {effective_identity_weight:.2f}, eye geometry lock {tpl.identity_preservation.eye_geometry_lock:.2f})"
                if participant_count == 1
                else f"Coordinated {participant_count}-person portrait anchored on current age {current_age_anchor} "
                f"(adapter {tpl.identity_preservation.identity_adapter}, unified focal plane {optics.aperture}, "
                f"independent per-person identity lock {effective_identity_weight:.2f})"
            )

            age_directive = (
                f"Illustrate target age {target_age} ({recipe.stage_label}, delta {age_delta:+d} yrs from anchor): "
                f"{recipe.craniofacial_and_skin_cue}; hair & grooming: {recipe.hair_and_grooming_cue}."
            )
            if is_retroactive:
                age_directive += " [Retroactive artistic childhood reconstruction from adult anchor]"

            structured_prompt = {
                "subject_identity_anchor": subject_clause,
                "age_progression_directive": age_directive,
                "pose_and_expression": recipe.pose_and_gaze_cue,
                "wardrobe_and_styling": recipe.wardrobe_and_styling_cue,
                "backdrop_and_environment": recipe.backdrop_and_atmosphere_cue,
                "optics_and_lighting": (
                    f"Shot on {optics.focal_length_mm}mm lens at {optics.aperture}, {optics.framing}, "
                    f"aspect ratio {chosen_ratio}; lighting: {optics.lighting_setup}; "
                    f"color science: {optics.color_science}; skin policy: {optics.skin_texture_policy}; "
                    f"grain: {optics.film_grain_profile}."
                ),
                "disclosure_tag": AI_ILLUSTRATIVE_TAG,
            }

            compiled_prompt = " | ".join(
                [
                    f"[STYLE: {tpl.name} v{tpl.version}]",
                    structured_prompt["subject_identity_anchor"],
                    structured_prompt["age_progression_directive"],
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

            seed_material = f"{project_id}|{tpl.template_id}|{tpl.version}|{current_age_anchor}|{target_age}|{chosen_ratio}|{asset_fingerprint}"
            deterministic_seed = int(hashlib.sha256(seed_material.encode("utf-8")).hexdigest()[:8], 16)

            nodes.append(
                CompiledNodePromptPlan(
                    target_age=target_age,
                    stage_label=f"{target_age}岁 · {recipe.stage_label}",
                    is_retroactive_simulation=is_retroactive,
                    retroactive_disclosure=retroactive_disclosure,
                    age_delta_from_anchor=age_delta,
                    identity_anchor_weight=effective_identity_weight,
                    optics_summary=optics_summary,
                    structured_prompt=structured_prompt,
                    compiled_prompt=compiled_prompt,
                    negative_prompt=negative_prompt,
                    deterministic_seed=deterministic_seed,
                )
            )

        now_iso = datetime.now(timezone.utc).isoformat()
        plan_hash = hashlib.sha256(
            f"{tenant_id}|{project_id}|{tpl.template_id}|{current_age_anchor}|{normalized_ages}|{now_iso}".encode("utf-8")
        ).hexdigest()[:16]
        plan_id = f"plan_{plan_hash}"

        plan = TimelineGenerationPlan(
            plan_id=plan_id,
            project_id=project_id,
            template_id=tpl.template_id,
            template_version=tpl.version,
            current_age_anchor=int(current_age_anchor),
            aspect_ratio=chosen_ratio,
            participant_count=int(participant_count),
            contains_minor=contains_minor,
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
        if not timeline_ages or len(timeline_ages) > 12:
            raise TemplateEngineError(
                "INVALID_TIMELINE_AGES",
                "timeline_ages must contain between 1 and 12 age nodes",
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
