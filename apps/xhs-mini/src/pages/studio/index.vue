<template>
  <view class="page-container">
    <!-- 步骤 1: 逐人按用途授权 (B70-R02 / Product Invariant #2) -->
    <view class="card">
      <view class="step-header">
        <text class="step-title">1. 逐人按用途授权 (必填)</text>
        <text class="ai-badge">{{ consentReceipt ? '已授权' : '待授权' }}</text>
      </view>

      <view class="form-row">
        <text class="form-label">授权身份：</text>
        <view class="pill-group">
          <text
            v-for="cap in capacities"
            :key="cap.value"
            class="choice-pill"
            :class="{ active: grantorCapacity === cap.value }"
            @click="grantorCapacity = cap.value"
          >
            {{ cap.label }}
          </text>
        </view>
      </view>

      <view class="form-row">
        <text class="form-label">出镜人数声明（受所选模板上限约束，三代同堂支持最多4人）：</text>
        <view class="pill-group">
          <text
            v-for="cnt in [1, 2, 3, 4]"
            :key="cnt"
            class="choice-pill"
            :class="{
              active: participantCount === cnt,
              disabled: cnt > currentTemplate.max_participants,
            }"
            @click="handleSelectParticipantCount(cnt)"
          >
            {{ cnt }} 人{{ cnt > currentTemplate.max_participants ? ' (自动切合拍模板)' : '' }}
          </text>
        </view>
      </view>

      <view class="consent-check" @click="agreedToPolicy = !agreedToPolicy">
        <text class="checkbox">{{ agreedToPolicy ? '☑' : '☐' }}</text>
        <text class="consent-desc">
          我确认已获得全部出镜人（含未成年人监护人）针对“0—100岁AI艺术化影像生成”用途的明确授权，且知晓生成结果非真实容貌或寿命预测。
        </text>
      </view>

      <button class="btn-secondary" @click="handleGrantConsent">
        {{ consentReceipt ? `已签发授权凭证 (${consentReceipt.id})` : '签署逐人授权凭证' }}
      </button>
    </view>

    <!-- 步骤 2: 内置高定写真模板选择、当前年龄锚点与年龄阶段配置 (B08 / B14) -->
    <view class="card">
      <view class="step-header">
        <text class="step-title">2. 内置高定写真模板与年龄轴编排</text>
        <text class="step-sub">B08/B14 结构化光影配方</text>
      </view>

      <view class="form-label">选择内置商业级人像模板（共 {{ templates.length }} 套）：</view>
      <view class="template-list">
        <view
          v-for="tpl in templates"
          :key="tpl.template_id"
          class="template-card"
          :class="{ selected: selectedTemplateId === tpl.template_id }"
          @click="handleSelectTemplate(tpl)"
        >
          <view class="tpl-top">
            <text class="tpl-name">{{ tpl.name }}</text>
            <text class="tpl-badge">{{ tpl.badge }}</text>
          </view>
          <text class="tpl-sub">{{ tpl.subtitle }}</text>
          <view class="tpl-meta-row">
            <text class="tpl-chip">
              {{ tpl.optics_and_lighting.focal_length_mm }}mm {{ tpl.optics_and_lighting.aperture }}
            </text>
            <text class="tpl-chip">内置 {{ tpl.curated_gallery_shots.length }} 张精修分镜 (精选≥{{ tpl.min_curated_shots }}张)</text>
            <text class="tpl-chip">最多 {{ tpl.max_participants }} 人</text>
            <text class="tpl-chip">身份锁定 ≥ {{ tpl.quality_thresholds.min_identity_similarity }}</text>
          </view>
        </view>
      </view>

      <!-- 当前选中模板的摄影光学与肤质策略详情 -->
      <view class="optics-inspector">
        <view class="inspector-title">
          当前模板摄影规格：{{ currentTemplate.name }} (v{{ currentTemplate.version }})
        </view>
        <view class="inspector-line">
          <text class="inspector-key">镜头与布光：</text>
          <text class="inspector-val">
            {{ currentTemplate.optics_and_lighting.focal_length_mm }}mm
            {{ currentTemplate.optics_and_lighting.aperture }} ·
            {{ currentTemplate.optics_and_lighting.lighting_setup }}
          </text>
        </view>
        <view class="inspector-line">
          <text class="inspector-key">色彩与胶片：</text>
          <text class="inspector-val">
            {{ currentTemplate.optics_and_lighting.color_science }} ({{
              currentTemplate.optics_and_lighting.film_grain_profile
            }})
          </text>
        </view>
        <view class="inspector-line">
          <text class="inspector-key">真实肤质门控：</text>
          <text class="inspector-val">
            {{ currentTemplate.optics_and_lighting.skin_texture_policy }}
          </text>
        </view>
        <view
          v-for="(hl, idx) in currentTemplate.competitive_highlights"
          :key="idx"
          class="highlight-bullet"
        >
          ✦ {{ hl }}
        </view>
      </view>

      <view class="upload-box" @click="handlePickPhoto">
        <text v-if="!uploadSession" class="upload-placeholder">
          + 点击选择本地成年正脸主锚点原图并创建加密隔离上传会话
        </text>
        <view v-else class="upload-ready">
          <text class="upload-ok">已创建加密上传会话：{{ uploadSession.asset_id }}</text>
          <text class="upload-Note">短期签名过期时间：{{ uploadSession.expires_at }}</text>
        </view>
      </view>

      <!-- Pillar III: 3D 多角度骨相锚点 + 童年老照片双锚点融合开关 -->
      <view class="form-row">
        <text class="form-label">
          3D 骨相与童年双锚点加强（解决侧脸鼻梁塌陷与童年回溯不像本人问题）：
        </text>
        <view class="pill-group">
          <text
            class="choice-pill"
            :class="{ active: enableSideProfileAnchor }"
            @click="enableSideProfileAnchor = !enableSideProfileAnchor"
          >
            {{ enableSideProfileAnchor ? '✓ 已附 45° 侧脸骨相照 (+0.22 立体纵深)' : '+ 附加 45° 侧脸骨相照' }}
          </text>
          <text
            class="choice-pill"
            :class="{ active: enableChildhoodAnchor }"
            @click="enableChildhoodAnchor = !enableChildhoodAnchor"
          >
            {{ enableChildhoodAnchor ? '✓ 已附童年老照片双锚点 (3-8岁权重 0.72)' : '+ 附加真实童年老照片参考' }}
          </text>
        </view>
      </view>

      <!-- 当前年龄连续性锚点与出生年份年代推演引擎 (B08-R01 / B14-R01) -->
      <view class="form-row">
        <text class="form-label">
          当前真实年龄锚点（作为骨相基准向两端推演，小于此年龄自动标记为童年回溯创作）：
        </text>
        <view class="pill-group">
          <text
            v-for="anchor in anchorAgeOptions"
            :key="anchor"
            class="choice-pill"
            :class="{ active: currentAgeAnchor === anchor }"
            @click="handleSelectAnchorAge(anchor)"
          >
            当前 {{ anchor }} 岁
          </text>
        </view>
      </view>

      <view class="form-row">
        <text class="form-label">
          出生年份（自动计算「出生年份 + 目标年龄 = 对应年代场景/领口材质/自然窗光」）：
        </text>
        <view class="pill-group">
          <text
            v-for="by in birthYearOptions"
            :key="by"
            class="choice-pill"
            :class="{ active: birthYear === by }"
            @click="birthYear = by"
          >
            {{ by }}年出生
          </text>
        </view>
      </view>

      <!-- 输出画幅比例选择 (B08-R02) -->
      <view class="form-row">
        <text class="form-label">输出画幅比例：</text>
        <view class="pill-group">
          <text
            v-for="ratio in currentTemplate.supported_aspect_ratios"
            :key="ratio"
            class="choice-pill"
            :class="{ active: selectedAspectRatio === ratio }"
            @click="selectedAspectRatio = ratio"
          >
            {{ formatRatioLabel(ratio) }}
          </text>
        </view>
      </view>

      <!-- 内置 10 张大师精修分镜预览与快捷编排 (>=9张供精选) -->
      <view class="form-row">
        <view class="step-header">
          <text class="form-label">
            内置 {{ currentTemplate.curated_gallery_shots.length }} 张精修分镜脚本（满 {{ currentTemplate.min_curated_shots }} 张可精选成片）：
          </text>
          <text class="shot-toggle-link" @click="showCuratedShotPresets = !showCuratedShotPresets">
            {{ showCuratedShotPresets ? '收起分镜表 ▲' : '展开10镜脚本 ▼' }}
          </text>
        </view>
        <view class="pill-group" style="margin-bottom: 12rpx">
          <text class="choice-pill active" @click="applyRecommendedAges(10)">
            生成全套 10 张大师分镜（推荐，便于10选9）
          </text>
          <text class="choice-pill" @click="applyRecommendedAges(9)">
            仅生成默认 9 宫格分镜 (9张)
          </text>
        </view>
        <view v-if="showCuratedShotPresets" class="shot-preset-list">
          <view
            v-for="shot in currentTemplate.curated_gallery_shots"
            :key="shot.shot_id"
            class="shot-preset-item"
          >
            <view class="shot-preset-head">
              <text class="shot-preset-title">{{ shot.title }}</text>
              <text class="shot-preset-era">{{ birthYear + shot.target_age }}年</text>
            </view>
            <text class="shot-preset-detail">骨相/肌理：{{ shot.craniofacial_and_dermal_focus }}</text>
            <text class="shot-preset-detail">领口/布景：{{ shot.wardrobe_fabric_cue }} · {{ shot.backdrop_prop_cue }}</text>
          </view>
        </view>
      </view>

      <view class="age-selector-label">
        目标生成年龄节点（已选 {{ selectedAges.length }} 张，建议 ≥ 9 张以供九宫格/相册精选）：
      </view>
      <view class="pill-group">
        <text
          v-for="age in availableAges"
          :key="age"
          class="choice-pill"
          :class="{ active: selectedAges.includes(age) }"
          @click="toggleAge(age)"
        >
          {{ age }}岁 ({{ birthYear + age }}年)
        </text>
      </view>

      <button class="btn-primary" :disabled="isGenerating" @click="handleStartGeneration">
        {{
          isGenerating
            ? '正在编译光学计划与身份门控...'
            : `以「${currentTemplate.name.split('·')[0]}」启动时光生成`
        }}
      </button>
    </view>

    <!-- 独立分类工作台：世界名胜古迹 100 张实景旅拍合成 (上传本人照片合成全球著名景点) -->
    <view class="card">
      <view class="step-header">
        <text class="step-title">世界名胜古迹 · 100 张实景合成工作台 (独立分类)</text>
        <text class="step-sub">透视地平线对齐 + IC-Light 太阳重打光 + 足底阴影</text>
      </view>

      <view class="form-row">
        <text class="form-label">1. 按全球五大洲/文化区筛选名胜古迹模板：</text>
        <view class="pill-group">
          <text
            class="choice-pill"
            :class="{ active: selectedLandmarkRegion === 'all' }"
            @click="selectedLandmarkRegion = 'all'"
          >
            全球 100 张名胜
          </text>
          <text
            v-for="reg in landmarkRegions"
            :key="reg.region_id"
            class="choice-pill"
            :class="{ active: selectedLandmarkRegion === reg.region_id }"
            @click="selectedLandmarkRegion = reg.region_id"
          >
            {{ reg.badge }}
          </text>
        </view>
      </view>

      <view class="form-row">
        <text class="form-label">2. 快捷选择合成景点组合（已勾选 {{ selectedLandmarkIds.length }} / 100 张）：</text>
        <view class="pill-group">
          <text class="choice-pill active" @click="selectDefaultTenLandmarks">
            推荐全球10大代表名胜 (10选9九宫格)
          </text>
          <text class="choice-pill" @click="selectCurrentRegionLandmarks">
            勾选当前分区全部 ({{ filteredStudioLandmarks.length }}张)
          </text>
          <text class="choice-pill" @click="selectAllFiftyLandmarks">
            一键全选全球 100 张名胜古迹
          </text>
        </view>
      </view>

      <view class="form-row">
        <view class="pill-group">
          <text
            v-for="lmk in filteredStudioLandmarks"
            :key="lmk.landmark_id"
            class="choice-pill"
            :class="{ active: selectedLandmarkIds.includes(lmk.landmark_id) }"
            @click="toggleLandmarkSelection(lmk.landmark_id)"
          >
            #{{ String(lmk.index_number).padStart(3, '0') }} {{ lmk.name.split('·')[0] }} ({{ lmk.country_and_city.split(' · ')[0] }})
          </text>
        </view>
      </view>

      <button class="btn-primary" @click="handleSynthesizeWorldLandmarks">
        上传照片合成我的世界名胜实景大片 (已选 {{ selectedLandmarkIds.length }} 张景点)
      </button>

      <view v-if="landmarkSynthesisRun" style="margin-top: 20rpx">
        <view class="curation-summary-bar">
          <text class="curation-summary-title">
            实景旅拍合成完成 ({{ landmarkSynthesisRun.synthesis_run_id }}): 已生成 {{ landmarkSynthesisRun.passed_landmarks }} / {{ landmarkSynthesisRun.total_landmarks }} 张世界名胜实景大片（全部通过透视地平线与足底阴影校验）
          </text>
        </view>
        <view class="frames-grid">
          <view
            v-for="item in landmarkSynthesisRun.items"
            :key="item.synthesis_item_id"
            class="frame-card curated"
          >
            <view class="frame-top-row">
              <text class="frame-Age">#{{ String(item.landmark_index).padStart(3, '0') }} {{ item.landmark_name }}</text>
              <text class="curation-tag selected">{{ item.unesco_code }}</text>
            </view>
            <view class="frame-era-row">
              <text class="era-pill">{{ item.country_and_city }} · {{ item.region_label }}</text>
              <text class="era-pill">{{ formatShotScaleLabel(item.shot_scale) }}</text>
              <text class="era-pill">{{ formatGridPositionLabel(item.nine_grid_position) }}</text>
            </view>
            <view class="frame-optics">透视与镜头：{{ item.camera_optics_summary }}</view>
            <view class="frame-wardrobe">环境太阳重打光：{{ item.relighting_ibl_summary }}</view>
            <view class="frame-wardrobe">接触阴影与空气透视：{{ item.ground_shadow_and_haze_summary }}</view>
            <view class="score-row">
              <text class="score-pill">身份一致: {{ item.identity_similarity }}</text>
              <text class="score-pill">透视融合: {{ item.pose_background_coherence }}</text>
              <text class="score-pill">审美可用: {{ item.aesthetic_score }}</text>
            </view>
            <view class="frame-watermark">{{ item.ai_watermark_text }}</view>
          </view>
        </view>
      </view>
    </view>

    <!-- 一生拾忆时光机 P04/P08: 20 首发模板 × 5 风格确定性排版与 GB 45438 双标识导出 -->
    <view class="card">
      <view class="step-header">
        <text class="step-title">一生拾忆 · 20 模板 × 5 视觉风格卡片编排</text>
        <text class="step-sub">P04 确定性排版 + P08 显隐双标识</text>
      </view>
      <view class="form-row">
        <text class="form-label">当前选中卡片模板 ({{ currentTcCard.pricing_tier }})：</text>
        <view class="pill-group">
          <text
            v-for="tcTpl in tcTemplates"
            :key="tcTpl.id"
            class="choice-pill"
            :class="{ active: selectedTcCardId === tcTpl.id }"
            @click="handleSelectTcCard(tcTpl.id)"
          >
            {{ tcTpl.name }}
          </text>
        </view>
      </view>
      <view class="form-row">
        <text class="form-label">选择 5 套基础视觉风格：</text>
        <view class="pill-group">
          <text
            v-for="st in tcStyles"
            :key="st.id"
            class="choice-pill"
            :class="{ active: selectedTcStyleId === st.id }"
            @click="handleSelectTcStyle(st.id)"
          >
            {{ st.name }} ({{ st.description }})
          </text>
        </view>
      </view>
      <view class="optics-inspector">
        <view class="inspector-title">
          当前组合：{{ currentTcCard.name }} × {{ currentTcStyle.name }} (v{{ currentTcCard.version }})
        </view>
        <view class="inspector-line">
          <text class="inspector-key">画幅与槽位：</text>
          <text class="inspector-val">
            支持 {{ currentTcCard.sizes.join(' / ') }} · {{ currentTcCard.image_slots }} 张素材槽 · AI模式 {{ currentTcCard.ai_mode }}
          </text>
        </view>
        <view class="inspector-line">
          <text class="inspector-key">合规双标识：</text>
          <text class="inspector-val">
            显式角标「本作品含AI生成/合成内容」+ 隐式 PNG iTXt / RIFF WebP HMAC 签名元数据 (A09/A15)
          </text>
        </view>
      </view>

      <view class="form-row">
        <text class="form-label">卡片导出格式 (GB 45438-2025 隐式元数据封装)：</text>
        <view class="pill-group">
          <text
            v-for="fmt in (['PNG', 'WEBP'] as const)"
            :key="fmt"
            class="choice-pill"
            :class="{ active: selectedTcExportFormat === fmt }"
            @click="selectedTcExportFormat = fmt"
          >
            {{ fmt }} ({{ fmt === 'PNG' ? 'iTXt 签名块' : 'RIFF AIGC 签名块' }})
          </text>
        </view>
      </view>

      <button class="btn-secondary" :disabled="isRenderingTcCard" @click="handleRenderTimeCapsuleCard">
        {{
          isRenderingTcCard
            ? '正在排版并写入 GB 45438 双标识...'
            : `渲染导出「${currentTcCard.name} × ${currentTcStyle.name}」纪念卡`
        }}
      </button>

      <view v-if="renderedTcCard" class="share-status-box">
        <text class="share-info">排版摘要：{{ renderedTcCard.svg_preview_summary }}</text>
        <text class="share-info">显式标识：{{ renderedTcCard.explicit_visible_label }}</text>
        <text class="share-info">隐式元数据块：{{ renderedTcCard.implicit_metadata_chunk }}</text>
        <text class="share-info">Layout Digest：{{ renderedTcCard.layout_digest }}</text>
        <text class="share-info">HMAC-SHA256：{{ renderedTcCard.signature_hmac }}</text>
      </view>
    </view>

    <!-- 步骤 3: 生成进度、B15 质量门控分、>=9张成片精选、小红书分享与相册下单 -->
    <view v-if="activeJob" class="card">
      <view class="step-header">
        <text class="step-title">3. 时光画廊精选 (满9张成片) 与 B15 门控</text>
        <text class="ai-badge">状态: {{ activeJob.state }}</text>
      </view>

      <view class="curation-summary-bar">
        <text class="curation-summary-title">
          已精选 {{ curatedShotIds.length }} / {{ activeJob.frames?.length || 0 }} 张成片（至少精选 9 张可导出小红书九宫格或印制 99 元精装相册）
        </text>
        <view class="pill-group" style="margin-top: 10rpx">
          <text class="choice-pill active" @click="selectDefaultNineShots">一键勾选推荐 9 宫格</text>
          <text class="choice-pill" @click="selectAllGeneratedShots">全选全部成片 ({{ activeJob.frames?.length || 0 }}张)</text>
        </view>
      </view>

      <view class="prompt-toggle-bar" @click="showCompiledPrompts = !showCompiledPrompts">
        <text class="prompt-toggle-text">
          {{ showCompiledPrompts ? '收起骨相演进权重、多供应商参数与底层 Prompt ▲' : '展开查看每帧骨相演进矩阵、多供应商参数与反塑料感 Prompt ▼' }}
        </text>
      </view>

      <view class="frames-grid">
        <view
          v-for="frame in activeJob.frames"
          :key="frame.shot_id || frame.age"
          class="frame-card"
          :class="{ curated: isFrameCurated(frame.shot_id || String(frame.age)) }"
          @click="toggleCuratedFrame(frame.shot_id || String(frame.age))"
        >
          <view class="frame-top-row">
            <text class="frame-Age">{{ frame.shot_title || frame.label }}</text>
            <text
              class="curation-tag"
              :class="{ selected: isFrameCurated(frame.shot_id || String(frame.age)) }"
            >
              {{ isFrameCurated(frame.shot_id || String(frame.age)) ? '✓ 已精选' : '+ 待精选' }}
            </text>
          </view>

          <view class="frame-era-row">
            <text v-if="frame.calendar_year" class="era-pill">
              {{ frame.calendar_year }}年 · {{ frame.decade_label }}
            </text>
            <text v-if="frame.shot_scale" class="era-pill">
              {{ formatShotScaleLabel(frame.shot_scale) }}
            </text>
            <text v-if="frame.nine_grid_position" class="era-pill">
              {{ formatGridPositionLabel(frame.nine_grid_position) }}
            </text>
            <text v-if="frame.is_retroactive_simulation" class="retro-tag">回溯创作</text>
          </view>

          <view class="frame-optics">{{ frame.optics_summary }}</view>
          <view v-if="frame.collar_material_cue" class="frame-wardrobe">
            领口与环境：{{ frame.collar_material_cue }} · {{ frame.era_scene_cue }}
          </view>

          <view class="score-row">
            <text class="score-pill">身份一致: {{ frame.identity_score }}</text>
            <text class="score-pill">审美可用: {{ frame.aesthetic_score }}</text>
            <text v-if="frame.physiological_weights" class="score-pill">
              SSS皮下散射: {{ frame.physiological_weights.subsurface_scattering_strength }}
            </text>
          </view>

          <view v-if="frame.retroactive_disclosure" class="retro-note">
            {{ frame.retroactive_disclosure }}
          </view>

          <view class="frame-watermark">{{ frame.ai_watermark_text }}</view>
          <view class="frame-url">短期签名预览 (切后台自动清理)</view>

          <view v-if="showCompiledPrompts" class="prompt-detail-box">
            <text v-if="frame.physiological_weights" class="prompt-detail-line">
              生理演进权重：幼态={{ frame.physiological_weights.craniofacial_neoteny_weight }} | 胶原紧致={{ frame.physiological_weights.dermal_collagen_elasticity }} | 法令纹上限≤{{ frame.physiological_weights.nasolabial_fold_depth_limit }} | 银丝占比={{ frame.physiological_weights.silver_strand_ratio }} | 眼神光={{ frame.physiological_weights.eye_catchlight_clarity }}
            </text>
            <text v-if="frame.provider_payload" class="prompt-detail-line">
              多供应商管线：{{ frame.provider_payload.provider_id }} ({{ frame.provider_payload.identity_adapter }}, InstantID={{ frame.provider_payload.instantid_weight }}, PuLID={{ frame.provider_payload.pulid_weight }}, 出血位={{ frame.provider_payload.print_bleed_mm }}mm, {{ frame.provider_payload.cmyk_profile }})
            </text>
            <text v-if="frame.image_enhancement_pipeline" class="prompt-detail-line">
              4阶段物理画质管线：正侧双锚点={{ frame.image_enhancement_pipeline.multi_photo_anchor.dual_anchor_active ? '已激活' : '单锚点' }} (成年={{ frame.image_enhancement_pipeline.multi_photo_anchor.adult_anchor_weight }}/童年={{ frame.image_enhancement_pipeline.multi_photo_anchor.childhood_anchor_weight }}/3D侧颜加成=+{{ frame.image_enhancement_pipeline.multi_photo_anchor.profile_3d_depth_boost }}) | 重打光={{ frame.image_enhancement_pipeline.relighting_pass.normal_map_estimator }} ({{ frame.image_enhancement_pipeline.relighting_pass.fill_bounce_ratio }}) | 分频超分={{ frame.image_enhancement_pipeline.frequency_separated_skin_pass.tile_controlnet_weight }} (微特征={{ frame.image_enhancement_pipeline.frequency_separated_skin_pass.micro_features_injected.join('/') }}) | 银盐辉光={{ frame.image_enhancement_pipeline.optical_post_process.halation_strength }}
            </text>
            <text class="prompt-detail-line">正向配方：{{ frame.compiled_prompt }}</text>
            <text class="prompt-detail-neg">反塑料感负向约束：{{ frame.negative_prompt }}</text>
          </view>
        </view>
      </view>

      <view class="action-row">
        <button class="btn-secondary" @click="handleConfirmCuratedNineGrid">
          确认精选成片生成小红书九宫格 (已选{{ curatedShotIds.length }}张，需≥9张)
        </button>
        <button class="btn-secondary" @click="handlePreviewPhotobookLayout">
          生成 20 页蝴蝶对裱有声相册排版与印前工业预检
        </button>
        <button class="btn-secondary" @click="handleCreateShare">
          生成可撤销小红书分享短链
        </button>
        <button class="btn-primary" @click="handleOrderPhotoBook">
          以已精选 {{ curatedShotIds.length }} 张定制精装时光相册 (¥99.00)
        </button>
      </view>

      <view v-if="photobookManifest" class="share-status-box">
        <text class="share-info" style="font-weight: 600">
          20页蝴蝶对裱跨页有声相册排版清单 ({{ photobookManifest.manifest_id }} · {{ photobookManifest.page_count }}页 / {{ photobookManifest.spread_count }}跨页)
        </text>
        <text class="share-info">
          装帧与色彩：{{ photobookManifest.binding_type }} · {{ photobookManifest.preflight_report.cmyk_icc_profile }} · 暗部+{{ ((photobookManifest.preflight_report.shadow_gamma_lift - 1) * 100).toFixed(1) }}% Gamma 补偿 · TAC {{ photobookManifest.preflight_report.max_cmyk_tac_percent }}% ≤ {{ photobookManifest.preflight_report.tac_limit_percent }}%
        </text>
        <text class="share-info">
          印前工业预检：{{ photobookManifest.preflight_report.preflight_passed ? '✓ PASSED (300 DPI + 3mm出血 + 中缝±12mm零人脸折痕碰撞)' : '✗ FAILED' }} · 有声时光胶囊白名单二维码：{{ photobookManifest.acoustic_colophon.voice_qr_url }}
        </text>
      </view>

      <view v-if="curatedSelectionReceipt" class="share-status-box">
        <text class="share-info">
          精选回执 ({{ curatedSelectionReceipt.selection_id }}): 已锁定 {{ curatedSelectionReceipt.selected_count }} 张成片 ({{ curatedSelectionReceipt.selected_ages.join('岁 / ') }}岁)
        </text>
        <text class="share-info">
          导出模式: {{ curatedSelectionReceipt.export_mode }}
          {{ curatedSelectionReceipt.photobook_sku ? `· 关联 SKU: ${curatedSelectionReceipt.photobook_sku}` : '' }}
        </text>
      </view>

      <view v-if="activeShare && consentReceipt">
        <view class="share-status-box">
          <text class="share-info">分享短链 ({{ activeShare.status }}): {{ activeShare.url }}</text>
          <text class="share-info">溯源标识: {{ activeShare.provenance_id }}</text>
        </view>

        <!-- 小红书笔记挂载卡片组件 (B71-R03) -->
        <XhsNoteMountCard
          :share-id="activeShare.id"
          :consent-refs="[consentReceipt.id]"
          :contains-minor="grantorCapacity === 'guardian'"
        />
      </view>

      <view v-if="checkoutResult" class="share-status-box">
        <text class="share-info">
          服务端核价支付单: {{ checkoutResult.id }} (¥{{ (checkoutResult.amount_minor / 100).toFixed(2) }})
        </text>
        <text v-if="paymentGateReceipt" class="share-info">
          收银台门控状态: {{ paymentGateReceipt.status }} ({{ paymentGateReceipt.platform }})
        </text>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onHide, onShow, onUnload, onShareAppMessage } from '@dcloudio/uni-app';
import type {
  AspectRatio,
  CheckoutSession,
  ConsentReceipt,
  CuratedGallerySelectionReceipt,
  GenerationJob,
  GrantorCapacity,
  LandmarkSynthesisRunRecord,
  NineGridPosition,
  PhotobookLayoutManifest,
  PortraitTemplateSpec,
  Share,
  ShotScale,
  UploadSession,
  WorldLandmarkRegionId,
} from '@ailifetime/contracts';
import {
  apiClient,
  BUILTIN_PORTRAIT_TEMPLATES,
  TIMECAPSULE_STYLES,
  TIMECAPSULE_TEMPLATES,
  WORLD_LANDMARK_50_TEMPLATES,
  WORLD_LANDMARK_REGIONS,
  compilePhotobookLayoutManifest,
  getCurrentPlatformChannel,
  getPreferredTemplateId,
  getPreferredTimeCapsuleSelection,
  getTrackedShare,
  listWorldLandmarks,
  purgeEphemeralMediaCache,
  renderAndExportTimeCapsuleCard,
  saveCuratedGallerySelection,
  setPreferredTemplateId,
  setPreferredTimeCapsuleSelection,
  synthesizeUserAtWorldLandmarks,
  type TimeCapsuleCardRenderResult,
} from '../../services/api';
import {
  buildCompliantShareConfig,
  ensurePlatformPrivacyAuthorized,
  requestNativeMiniProgramPayment,
  type NativePaymentGateReceipt,
} from '../../utils/xhs-platform';
import XhsNoteMountCard from '../../components/XhsNoteMountCard.vue';

const capacities: { label: string; value: GrantorCapacity }[] = [
  { label: '本人出镜', value: 'self' },
  { label: '未成年人监护人', value: 'guardian' },
  { label: '获授权家庭代表', value: 'authorized-agent' },
];

const templates = ref<PortraitTemplateSpec[]>(BUILTIN_PORTRAIT_TEMPLATES);
const selectedTemplateId = ref<string>(getPreferredTemplateId());
const tcTemplates = ref(TIMECAPSULE_TEMPLATES);
const tcStyles = ref(TIMECAPSULE_STYLES);
const initialTc = getPreferredTimeCapsuleSelection();
const selectedTcCardId = ref<string>(initialTc.cardId);
const selectedTcStyleId = ref<string>(initialTc.styleId);
const selectedTcExportFormat = ref<'PNG' | 'WEBP'>('PNG');
const isRenderingTcCard = ref(false);
const renderedTcCard = ref<TimeCapsuleCardRenderResult | null>(null);
const paymentGateReceipt = ref<NativePaymentGateReceipt | null>(null);

const currentTcCard = computed(() => {
  return (
    tcTemplates.value.find((c) => c.id === selectedTcCardId.value) ||
    tcTemplates.value[0]
  );
});

const currentTcStyle = computed(() => {
  return (
    tcStyles.value.find((s) => s.id === selectedTcStyleId.value) ||
    tcStyles.value[0]
  );
});

function handleSelectTcCard(cardId: string) {
  selectedTcCardId.value = cardId;
  setPreferredTimeCapsuleSelection(cardId, selectedTcStyleId.value);
}

function handleSelectTcStyle(styleId: string) {
  selectedTcStyleId.value = styleId;
  setPreferredTimeCapsuleSelection(selectedTcCardId.value, styleId);
}

const currentTemplate = computed<PortraitTemplateSpec>(() => {
  return (
    templates.value.find((t) => t.template_id === selectedTemplateId.value) ||
    templates.value[0]
  );
});

const grantorCapacity = ref<GrantorCapacity>('self');
const participantCount = ref(1);
const agreedToPolicy = ref(false);
const consentReceipt = ref<ConsentReceipt | null>(null);
const uploadSession = ref<UploadSession | null>(null);
const enableSideProfileAnchor = ref(true);
const enableChildhoodAnchor = ref(true);

const anchorAgeOptions = [18, 25, 28, 32, 38, 45, 55];
const birthYearOptions = [1971, 1981, 1988, 1994, 1998, 2001, 2008];
const currentAgeAnchor = ref<number>(28);
const birthYear = ref<number>(1998);
const selectedAspectRatio = ref<AspectRatio>('3:4');
const showCuratedShotPresets = ref(true);

const availableAges = [3, 6, 12, 18, 22, 25, 28, 32, 35, 42, 45, 50, 58, 66, 72, 75, 85, 100];
const selectedAges = ref<number[]>([...BUILTIN_PORTRAIT_TEMPLATES[0].recommended_ages]);
const isGenerating = ref(false);
const activeJob = ref<GenerationJob | null>(null);
const activeProjectId = ref<string>('');
const curatedShotIds = ref<string[]>([]);
const curatedSelectionReceipt = ref<CuratedGallerySelectionReceipt | null>(null);
const photobookManifest = ref<PhotobookLayoutManifest | null>(null);
const activeShare = ref<Share | null>(null);
const checkoutResult = ref<CheckoutSession | null>(null);
const showCompiledPrompts = ref(false);

const landmarkRegions = ref(WORLD_LANDMARK_REGIONS);
const selectedLandmarkRegion = ref<WorldLandmarkRegionId | 'all'>('all');
const filteredStudioLandmarks = computed(() =>
  listWorldLandmarks(selectedLandmarkRegion.value)
);
const DEFAULT_TEN_LANDMARK_IDS = [
  'lmk_001_forbidden_city_taihedian',
  'lmk_002_great_wall_mutianyu',
  'lmk_011_paris_eiffel_trocadero',
  'lmk_014_santorini_oia_blue_domes',
  'lmk_031_egypt_giza_pyramids_sphinx',
  'lmk_021_japan_kyoto_fuji_sakura',
  'lmk_041_peru_machu_picchu_andes',
  'lmk_012_rome_colosseum_golden_hour',
  'lmk_018_swiss_jungfrau_alps',
  'lmk_049_iceland_jokulsarlon_aurora',
];
const selectedLandmarkIds = ref<string[]>([...DEFAULT_TEN_LANDMARK_IDS]);
const landmarkSynthesisRun = ref<LandmarkSynthesisRunRecord | null>(null);

function toggleLandmarkSelection(landmarkId: string) {
  if (selectedLandmarkIds.value.includes(landmarkId)) {
    if (selectedLandmarkIds.value.length > 1) {
      selectedLandmarkIds.value = selectedLandmarkIds.value.filter(
        (id) => id !== landmarkId
      );
    }
  } else {
    selectedLandmarkIds.value = [...selectedLandmarkIds.value, landmarkId];
  }
}

function selectDefaultTenLandmarks() {
  selectedLandmarkIds.value = [...DEFAULT_TEN_LANDMARK_IDS];
}

function selectCurrentRegionLandmarks() {
  selectedLandmarkIds.value = filteredStudioLandmarks.value.map(
    (item) => item.landmark_id
  );
}

function selectAllFiftyLandmarks() {
  selectedLandmarkIds.value = WORLD_LANDMARK_50_TEMPLATES.map(
    (item) => item.landmark_id
  );
}

function handleSynthesizeWorldLandmarks() {
  if (!consentReceipt.value || !uploadSession.value) {
    uni.showToast({
      title: '请先完成第 1 步逐人授权与第 2 步上传本人照片',
      icon: 'none',
    });
    return;
  }
  const assetId = uploadSession.value.asset_id;
  landmarkSynthesisRun.value = synthesizeUserAtWorldLandmarks({
    project_id: activeProjectId.value || `proj_lmk_${Date.now()}`,
    source_asset_ids: [assetId],
    side_profile_asset_id: enableSideProfileAnchor.value
      ? `${assetId}_side45`
      : null,
    landmark_ids: selectedLandmarkIds.value,
    target_age: currentAgeAnchor.value,
    aspect_ratio: selectedAspectRatio.value,
    participant_count: participantCount.value,
  });
  uni.showToast({
    title: `已合成 ${landmarkSynthesisRun.value.total_landmarks} 张世界名胜大片`,
    icon: 'success',
  });
}

function formatRatioLabel(ratio: AspectRatio): string {
  const labels: Record<AspectRatio, string> = {
    '3:4': '3:4 小红书竖版',
    '4:5': '4:5 精装画册版',
    '1:1': '1:1 经典方画幅',
    '9:16': '9:16 全屏故事版',
  };
  return labels[ratio] || ratio;
}

function formatShotScaleLabel(scale?: ShotScale): string {
  const labels: Record<ShotScale, string> = {
    extreme_closeup_eyes: '眼部微距特写',
    medium_bust: '标准胸像',
    three_quarter_profile: '45°侧颜轮廓',
    half_body_hands: '半身环境含手部',
  };
  return scale ? labels[scale] || scale : '标准胸像';
}

function formatGridPositionLabel(pos?: NineGridPosition): string {
  const labels: Record<NineGridPosition, string> = {
    center_hero: '九宫格C位主图',
    corner_framing: '九宫格四角压阵',
    edge_rhythm: '九宫格十字呼吸位',
    bonus_alternate: '第十张典藏替补',
  };
  return pos ? labels[pos] || pos : '九宫格节奏位';
}

function handleSelectAnchorAge(anchor: number) {
  currentAgeAnchor.value = anchor;
  birthYear.value = 2026 - anchor;
}

function applyRecommendedAges(limitCount: number) {
  selectedAges.value = currentTemplate.value.recommended_ages.slice(0, limitCount);
}

function isFrameCurated(shotId: string): boolean {
  return curatedShotIds.value.includes(shotId);
}

function toggleCuratedFrame(shotId: string) {
  if (curatedShotIds.value.includes(shotId)) {
    curatedShotIds.value = curatedShotIds.value.filter((id) => id !== shotId);
  } else {
    curatedShotIds.value = [...curatedShotIds.value, shotId];
  }
}

function selectDefaultNineShots() {
  const frames = activeJob.value?.frames || [];
  curatedShotIds.value = frames
    .filter((f) => f.default_selected !== false)
    .slice(0, 9)
    .map((f) => f.shot_id || String(f.age));
}

function selectAllGeneratedShots() {
  const frames = activeJob.value?.frames || [];
  curatedShotIds.value = frames.map((f) => f.shot_id || String(f.age));
}

function handleSelectTemplate(tpl: PortraitTemplateSpec) {
  selectedTemplateId.value = tpl.template_id;
  setPreferredTemplateId(tpl.template_id);
  if (!tpl.supported_aspect_ratios.includes(selectedAspectRatio.value)) {
    selectedAspectRatio.value = tpl.default_aspect_ratio;
  }
  if (participantCount.value > tpl.max_participants) {
    participantCount.value = tpl.max_participants;
  }
  selectedAges.value = [...tpl.recommended_ages];
}

function handleSelectParticipantCount(cnt: number) {
  if (cnt > currentTemplate.value.max_participants) {
    const targetId =
      cnt >= 4
        ? 'tpl_xhs_three_generations_heirloom'
        : 'tpl_xhs_warm_family_co_aging';
    const targetName =
      cnt >= 4 ? '三代同堂/隔代亲情·跨时空同框' : '温情伴侣/家人共老';
    uni.showToast({
      title: `当前模板最多支持 ${currentTemplate.value.max_participants} 人，已为您切换至「${targetName}」模板`,
      icon: 'none',
    });
    const familyTpl = templates.value.find((t) => t.template_id === targetId);
    if (familyTpl) {
      handleSelectTemplate(familyTpl);
    }
  }
  participantCount.value = cnt;
}

function toggleAge(age: number) {
  if (selectedAges.value.includes(age)) {
    if (selectedAges.value.length > 1) {
      selectedAges.value = selectedAges.value.filter((a) => a !== age);
    }
  } else {
    selectedAges.value = [...selectedAges.value, age].sort((a, b) => a - b);
  }
}

async function handleGrantConsent() {
  if (!agreedToPolicy.value) {
    uni.showToast({ title: '请先勾选逐人授权确认项', icon: 'none' });
    return;
  }
  const privacyCheck = await ensurePlatformPrivacyAuthorized();
  if (!privacyCheck.authorized) {
    uni.showToast({ title: '请先同意小程序隐私保护指引', icon: 'none' });
    return;
  }
  const receipt = await apiClient.grantConsent({
    participant_id: `part_${Date.now()}`,
    grantor_capacity: grantorCapacity.value,
    purpose: 'age-transformation',
    scope: {
      allow_public_share: false,
      allow_physical_print: true,
      is_minor: grantorCapacity.value === 'guardian',
    },
    policy_version: '2026.11-cn',
    evidence: {
      declared_participant_count: participantCount.value,
      channel: getCurrentPlatformChannel(),
      template_id: currentTemplate.value.template_id,
      privacy_contract: privacyCheck.privacyContractName,
    },
  });
  consentReceipt.value = receipt;
  uni.showToast({ title: '授权凭证已签发', icon: 'success' });
}

async function handleRenderTimeCapsuleCard() {
  isRenderingTcCard.value = true;
  try {
    const card = currentTcCard.value;
    const style = currentTcStyle.value;
    const result = await renderAndExportTimeCapsuleCard({
      template_id: card.id,
      style_id: style.id,
      size: card.sizes[0],
      export_format: selectedTcExportFormat.value,
      title: card.name,
      subtitle: `${style.name} · 拾忆典藏`,
      display_name: '一生拾忆体验官',
      event_date: '2026-11-07',
    });
    renderedTcCard.value = result;
    uni.showToast({ title: '卡片渲染与双标识签名完成', icon: 'success' });
  } finally {
    isRenderingTcCard.value = false;
  }
}

async function handlePickPhoto() {
  if (!consentReceipt.value) {
    uni.showToast({ title: '请先完成第 1 步逐人授权', icon: 'none' });
    return;
  }
  const privacyCheck = await ensurePlatformPrivacyAuthorized();
  if (!privacyCheck.authorized) {
    uni.showToast({ title: '请先完成相册/媒体隐私授权', icon: 'none' });
    return;
  }
  const session = await apiClient.createUploadSession({
    purpose: 'age-transformation',
    declared_participant_count: participantCount.value,
    content_type: 'image/jpeg',
    size_bytes: 1048576,
  });
  uploadSession.value = session;
  uni.showToast({ title: '加密上传会话就绪', icon: 'success' });
}

async function handleStartGeneration() {
  if (!consentReceipt.value || !uploadSession.value) {
    uni.showToast({ title: '请先完成逐人授权与照片选择', icon: 'none' });
    return;
  }
  isGenerating.value = true;
  try {
    const assetId = uploadSession.value.asset_id;
    const consentId = consentReceipt.value.id;
    const slots = Array.from({ length: participantCount.value }, (_, idx) => ({
      participant_id: idx === 0 ? 'part_primary' : `part_member_${idx + 1}`,
      source_asset_ids: [assetId],
      consent_refs: [consentId],
    }));
    const project = await apiClient.createProject({
      template_id: currentTemplate.value.template_id,
      participant_slots: slots,
      timeline_ages: selectedAges.value,
      visibility: 'private',
      current_age: currentAgeAnchor.value,
      birth_year: birthYear.value,
      aspect_ratio: selectedAspectRatio.value,
      side_profile_asset_id: enableSideProfileAnchor.value ? `${assetId}_side45` : undefined,
      childhood_reference_asset_id: enableChildhoodAnchor.value ? `${assetId}_child6` : undefined,
      childhood_reference_age: 6,
    });
    activeProjectId.value = project.id;

    const job = await apiClient.startGenerationJob({
      project_id: project.id,
      quote_id: `quo_free_preview_${Date.now()}`,
      entitlement_id: `ent_xhs_${Date.now()}`,
    });
    activeJob.value = job;
    selectDefaultNineShots();
    curatedSelectionReceipt.value = null;
    photobookManifest.value = null;
    uni.showToast({ title: `已生成 ${job.frames?.length || 10} 张精修底片，请精选 ≥9 张`, icon: 'success' });
  } finally {
    isGenerating.value = false;
  }
}

function handleConfirmCuratedNineGrid() {
  if (!activeJob.value) return;
  try {
    const frames = activeJob.value.frames || [];
    const selectedAgesList = frames
      .filter((f) => curatedShotIds.value.includes(f.shot_id || String(f.age)))
      .map((f) => f.age);
    curatedSelectionReceipt.value = saveCuratedGallerySelection({
      project_id: activeProjectId.value || activeJob.value.id,
      template_id: currentTemplate.value.template_id,
      selected_shot_ids: curatedShotIds.value,
      selected_ages: selectedAgesList,
      export_mode: 'xhs_9_grid',
    });
    uni.showToast({ title: '已锁定 9 宫格精选成片', icon: 'success' });
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '请至少选择 9 张成片',
      icon: 'none',
    });
  }
}

function handlePreviewPhotobookLayout() {
  if (!activeJob.value) return;
  try {
    const frames = activeJob.value.frames || [];
    const selectedAgesList = frames
      .filter((f) => curatedShotIds.value.includes(f.shot_id || String(f.age)))
      .map((f) => f.age);
    photobookManifest.value = compilePhotobookLayoutManifest({
      project_id: activeProjectId.value || activeJob.value.id,
      template_id: currentTemplate.value.template_id,
      selected_shot_ids: curatedShotIds.value,
      selected_ages: selectedAgesList,
      birth_year: birthYear.value,
    });
    uni.showToast({ title: '20页蝴蝶对裱相册印前预检通过', icon: 'success' });
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '请至少精选 9 张成片后再预览相册排版',
      icon: 'none',
    });
  }
}

async function handleCreateShare() {
  if (!activeJob.value || !consentReceipt.value) return;
  const share = await apiClient.createShare({
    artifact_ids: [activeJob.value.id],
    access: 'private-link',
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    allow_download: false,
    participant_consent_refs: [consentReceipt.value.id],
  });
  activeShare.value = share;
  uni.showToast({ title: '可撤销分享链已生成', icon: 'success' });
}

async function handleOrderPhotoBook() {
  if (!activeJob.value) return;
  try {
    const frames = activeJob.value.frames || [];
    const selectedAgesList = frames
      .filter((f) => curatedShotIds.value.includes(f.shot_id || String(f.age)))
      .map((f) => f.age);
    curatedSelectionReceipt.value = saveCuratedGallerySelection({
      project_id: activeProjectId.value || activeJob.value.id,
      template_id: currentTemplate.value.template_id,
      selected_shot_ids: curatedShotIds.value,
      selected_ages: selectedAgesList,
      export_mode: 'photobook_hardcover',
    });
    photobookManifest.value = compilePhotobookLayoutManifest({
      project_id: activeProjectId.value || activeJob.value.id,
      template_id: currentTemplate.value.template_id,
      selected_shot_ids: curatedShotIds.value,
      selected_ages: selectedAgesList,
      birth_year: birthYear.value,
    });
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '印制精装相册请至少精选 9 张成片',
      icon: 'none',
    });
    return;
  }
  const channel = getCurrentPlatformChannel();
  const schemePrefix = channel === 'mp-weixin' ? 'weixin' : channel === 'mp-xhs' ? 'xhs' : 'https';
  const session = await apiClient.createCheckoutSession({
    items: [
      {
        sku: 'PHOTO_BOOK_HARDCOVER_0_100',
        quantity: 1,
        project_id: activeJob.value.id,
      },
    ],
    currency: 'CNY',
    return_url: `${schemePrefix}://pages/profile/index`,
  });
  checkoutResult.value = session;
  paymentGateReceipt.value = await requestNativeMiniProgramPayment({
    checkoutId: session.id,
    paymentUrl: session.payment_url,
  });
  uni.showToast({ title: '服务端核价订单已创建', icon: 'success' });
}

onShow(() => {
  const preferred = getPreferredTemplateId();
  if (preferred && preferred !== selectedTemplateId.value) {
    const found = templates.value.find((t) => t.template_id === preferred);
    if (found) {
      handleSelectTemplate(found);
    }
  }
  const tcSelection = getPreferredTimeCapsuleSelection();
  selectedTcCardId.value = tcSelection.cardId;
  selectedTcStyleId.value = tcSelection.styleId;
  if (activeShare.value) {
    const tracked = getTrackedShare(activeShare.value.id);
    if (tracked) {
      activeShare.value = tracked;
    }
  }
});

onHide(() => {
  // B70-R03: TabBar 页面切走或切后台时立即清理短期预览媒体引用
  purgeEphemeralMediaCache();
});

onShareAppMessage(() => {
  return buildCompliantShareConfig({
    title: `我的 0—100 岁 AI 人生胶片（${currentTemplate.value.name.split('·')[0]}）`,
    path: '/pages/index/index',
    shareUrl: activeShare.value?.url || 'https://share.ailifetime.local/s/demo',
    provenanceId: activeShare.value?.provenance_id || 'prov_default_ai_watermark',
  });
});

onUnload(() => {
  // B70-R03: 页面卸载时清理短期预览媒体引用
  purgeEphemeralMediaCache();
});
</script>

<style scoped lang="scss">
.page-container {
  padding: 24rpx;
}

.step-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20rpx;
}

.step-title {
  font-size: 30rpx;
  font-weight: 700;
}

.step-sub {
  font-size: 22rpx;
  color: #888888;
}

.form-row {
  margin-bottom: 20rpx;
}

.form-label {
  font-size: 26rpx;
  color: #444444;
  display: block;
  margin-bottom: 12rpx;
  font-weight: 600;
}

.pill-group {
  display: flex;
  flex-wrap: wrap;
  gap: 14rpx;
}

.choice-pill {
  padding: 10rpx 24rpx;
  border-radius: 999rpx;
  background-color: #f4f4f7;
  color: #444444;
  font-size: 24rpx;
  border: 1rpx solid transparent;
}

.choice-pill.active {
  background-color: #fff0f3;
  color: #ff2442;
  border-color: #ff2442;
  font-weight: 600;
}

.choice-pill.disabled {
  opacity: 0.65;
}

.template-list {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
  margin-bottom: 20rpx;
}

.template-card {
  padding: 20rpx;
  border-radius: 18rpx;
  background-color: #f9f9fb;
  border: 2rpx solid #ececf2;
}

.template-card.selected {
  background-color: #fff6f8;
  border-color: #ff2442;
}

.tpl-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6rpx;
}

.tpl-name {
  font-size: 28rpx;
  font-weight: 700;
  color: #1f1f24;
}

.tpl-badge {
  font-size: 20rpx;
  color: #ff2442;
  background-color: #ffe6eb;
  padding: 4rpx 14rpx;
  border-radius: 999rpx;
  font-weight: 600;
}

.tpl-sub {
  font-size: 23rpx;
  color: #555555;
  display: block;
  margin-bottom: 12rpx;
}

.tpl-meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10rpx;
}

.tpl-chip {
  font-size: 20rpx;
  color: #333333;
  background-color: #ffffff;
  border: 1rpx solid #e2e2ea;
  padding: 4rpx 12rpx;
  border-radius: 8rpx;
}

.optics-inspector {
  background-color: #1f1f28;
  color: #f5f5f7;
  padding: 20rpx;
  border-radius: 16rpx;
  margin-bottom: 24rpx;
}

.inspector-title {
  font-size: 25rpx;
  font-weight: 700;
  color: #ffb5c2;
  margin-bottom: 10rpx;
}

.inspector-line {
  font-size: 22rpx;
  line-height: 1.5;
  margin-bottom: 6rpx;
}

.inspector-key {
  color: #a6a6b8;
  font-weight: 600;
}

.inspector-val {
  color: #ffffff;
}

.highlight-bullet {
  font-size: 21rpx;
  color: #ffd6df;
  margin-top: 6rpx;
  line-height: 1.4;
}

.consent-check {
  display: flex;
  align-items: flex-start;
  gap: 12rpx;
  background-color: #f8f8fa;
  padding: 16rpx;
  border-radius: 14rpx;
  margin: 20rpx 0;
}

.checkbox {
  font-size: 32rpx;
  color: #ff2442;
  line-height: 1.2;
}

.consent-desc {
  font-size: 24rpx;
  color: #555555;
}

.upload-box {
  border: 2rpx dashed #ffb5c2;
  background-color: #fff9fa;
  border-radius: 20rpx;
  padding: 36rpx 24rpx;
  text-align: center;
  margin-bottom: 24rpx;
}

.upload-placeholder {
  font-size: 28rpx;
  color: #ff2442;
  font-weight: 600;
}

.upload-ready {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.upload-ok {
  font-size: 26rpx;
  color: #1a7f37;
  font-weight: 600;
}

.upload-Note {
  font-size: 22rpx;
  color: #666666;
}

.age-selector-label {
  font-size: 26rpx;
  color: #444444;
  margin-bottom: 12rpx;
  font-weight: 600;
}

.btn-primary {
  background-color: #ff2442;
  color: #ffffff;
  border-radius: 999rpx;
  font-size: 28rpx;
  font-weight: 600;
  margin-top: 24rpx;
}

.btn-secondary {
  background-color: #fff0f3;
  color: #ff2442;
  border: 1rpx solid #ff2442;
  border-radius: 999rpx;
  font-size: 26rpx;
  font-weight: 600;
}

.prompt-toggle-bar {
  background-color: #f3f4f8;
  padding: 12rpx 18rpx;
  border-radius: 12rpx;
  margin-bottom: 16rpx;
  text-align: center;
}

.prompt-toggle-text {
  font-size: 22rpx;
  color: #3344aa;
  font-weight: 600;
}

.frames-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16rpx;
  margin-bottom: 24rpx;
}

.frame-card {
  background-color: #f8f8fa;
  border-radius: 16rpx;
  padding: 20rpx;
  border: 1rpx solid #ececf2;
}

.frame-top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.frame-Age {
  font-size: 26rpx;
  font-weight: 700;
  color: #1f1f24;
}

.retro-tag {
  font-size: 18rpx;
  color: #8a5a00;
  background-color: #fff3cd;
  padding: 2rpx 10rpx;
  border-radius: 999rpx;
}

.frame-optics {
  font-size: 20rpx;
  color: #444455;
  margin-top: 6rpx;
  font-weight: 600;
}

.score-row {
  display: flex;
  gap: 8rpx;
  margin-top: 8rpx;
  flex-wrap: wrap;
}

.score-pill {
  font-size: 18rpx;
  color: #1a7f37;
  background-color: #e6f6ec;
  padding: 2rpx 10rpx;
  border-radius: 6rpx;
}

.retro-note {
  font-size: 18rpx;
  color: #8a5a00;
  margin-top: 6rpx;
  line-height: 1.3;
}

.frame-watermark {
  font-size: 20rpx;
  color: #ff2442;
  margin-top: 6rpx;
}

.frame-url {
  font-size: 20rpx;
  color: #888888;
  margin-top: 6rpx;
}

.prompt-detail-box {
  margin-top: 10rpx;
  padding: 10rpx;
  background-color: #ffffff;
  border-radius: 10rpx;
  border: 1rpx solid #e2e2ea;
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.prompt-detail-line {
  font-size: 18rpx;
  color: #333333;
  word-break: break-all;
}

.prompt-detail-neg {
  font-size: 18rpx;
  color: #a12622;
  word-break: break-all;
}

.shot-toggle-link {
  font-size: 22rpx;
  color: #ff2442;
  font-weight: 600;
}

.shot-preset-list {
  display: flex;
  flex-direction: column;
  gap: 10rpx;
  background-color: #f8f8fb;
  padding: 16rpx;
  border-radius: 14rpx;
  border: 1rpx solid #e8e8f0;
}

.shot-preset-item {
  padding: 12rpx;
  background-color: #ffffff;
  border-radius: 10rpx;
  border: 1rpx solid #efeff5;
  display: flex;
  flex-direction: column;
  gap: 4rpx;
}

.shot-preset-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.shot-preset-title {
  font-size: 23rpx;
  font-weight: 700;
  color: #1f1f24;
}

.shot-preset-era {
  font-size: 20rpx;
  color: #1f4f99;
  background-color: #eef4ff;
  padding: 2rpx 10rpx;
  border-radius: 999rpx;
}

.shot-preset-detail {
  font-size: 20rpx;
  color: #555555;
}

.curation-summary-bar {
  background-color: #fff6f8;
  border: 1rpx solid #ffd6df;
  border-radius: 14rpx;
  padding: 16rpx;
  margin-bottom: 16rpx;
}

.curation-summary-title {
  font-size: 23rpx;
  font-weight: 600;
  color: #b0122a;
  display: block;
}

.frame-card.curated {
  border: 2rpx solid #ff2442;
  background-color: #fffafb;
}

.curation-tag {
  font-size: 19rpx;
  padding: 2rpx 12rpx;
  border-radius: 999rpx;
  background-color: #ebebf0;
  color: #555555;
}

.curation-tag.selected {
  background-color: #ff2442;
  color: #ffffff;
  font-weight: 600;
}

.frame-era-row {
  display: flex;
  align-items: center;
  gap: 8rpx;
  margin-top: 6rpx;
  flex-wrap: wrap;
}

.era-pill {
  font-size: 18rpx;
  color: #1f4f99;
  background-color: #eaf2ff;
  padding: 2rpx 10rpx;
  border-radius: 6rpx;
}

.frame-wardrobe {
  font-size: 19rpx;
  color: #555566;
  margin-top: 4rpx;
}

.action-row {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.share-status-box {
  margin-top: 20rpx;
  padding: 16rpx;
  background-color: #f4f8ff;
  border-radius: 14rpx;
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.share-info {
  font-size: 22rpx;
  color: #245bdb;
  word-break: break-all;
}
</style>
