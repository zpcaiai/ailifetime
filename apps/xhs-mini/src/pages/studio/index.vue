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
        <text class="form-label">出镜人数声明（受所选模板上限约束）：</text>
        <view class="pill-group">
          <text
            v-for="cnt in [1, 2, 3]"
            :key="cnt"
            class="choice-pill"
            :class="{
              active: participantCount === cnt,
              disabled: cnt > currentTemplate.max_participants,
            }"
            @click="handleSelectParticipantCount(cnt)"
          >
            {{ cnt }} 人{{ cnt > currentTemplate.max_participants ? ' (需选多人合拍模板)' : '' }}
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
          + 点击选择本地原图并创建加密隔离上传会话
        </text>
        <view v-else class="upload-ready">
          <text class="upload-ok">已创建加密上传会话：{{ uploadSession.asset_id }}</text>
          <text class="upload-Note">短期签名过期时间：{{ uploadSession.expires_at }}</text>
        </view>
      </view>

      <!-- 当前年龄连续性锚点 (B08-R01 / B14-R01) -->
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
            @click="currentAgeAnchor = anchor"
          >
            当前 {{ anchor }} 岁
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

      <view class="age-selector-label">目标生成年龄节点（支持 0—100 岁全周期多选）：</view>
      <view class="pill-group">
        <text
          v-for="age in availableAges"
          :key="age"
          class="choice-pill"
          :class="{ active: selectedAges.includes(age) }"
          @click="toggleAge(age)"
        >
          {{ age }}岁
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

    <!-- 步骤 3: 生成进度、B15 质量门控分、光学 Prompt 检视、小红书分享与相册下单 -->
    <view v-if="activeJob" class="card">
      <view class="step-header">
        <text class="step-title">3. 时光画廊与 B15 质量门控报告</text>
        <text class="ai-badge">状态: {{ activeJob.state }}</text>
      </view>

      <view class="prompt-toggle-bar" @click="showCompiledPrompts = !showCompiledPrompts">
        <text class="prompt-toggle-text">
          {{ showCompiledPrompts ? '收起底层结构化摄影 Prompt 配方 ▲' : '展开查看每帧底层摄影 Prompt 与反塑料感约束 ▼' }}
        </text>
      </view>

      <view class="frames-grid">
        <view v-for="frame in activeJob.frames" :key="frame.age" class="frame-card">
          <view class="frame-top-row">
            <text class="frame-Age">{{ frame.label }}</text>
            <text v-if="frame.is_retroactive_simulation" class="retro-tag">回溯创作</text>
          </view>

          <view class="frame-optics">{{ frame.optics_summary }}</view>

          <view class="score-row">
            <text class="score-pill">身份一致: {{ frame.identity_score }}</text>
            <text class="score-pill">审美可用: {{ frame.aesthetic_score }}</text>
          </view>

          <view v-if="frame.retroactive_disclosure" class="retro-note">
            {{ frame.retroactive_disclosure }}
          </view>

          <view class="frame-watermark">{{ frame.ai_watermark_text }}</view>
          <view class="frame-url">短期签名预览 (切后台自动清理)</view>

          <view v-if="showCompiledPrompts" class="prompt-detail-box">
            <text class="prompt-detail-line">正向配方：{{ frame.compiled_prompt }}</text>
            <text class="prompt-detail-neg">反塑料感负向约束：{{ frame.negative_prompt }}</text>
          </view>
        </view>
      </view>

      <view class="action-row">
        <button class="btn-secondary" @click="handleCreateShare">
          生成可撤销小红书分享短链
        </button>
        <button class="btn-primary" @click="handleOrderPhotoBook">
          定制精装时光相册 (¥99.00)
        </button>
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
  GenerationJob,
  GrantorCapacity,
  PortraitTemplateSpec,
  Share,
  UploadSession,
} from '@ailifetime/contracts';
import {
  apiClient,
  BUILTIN_PORTRAIT_TEMPLATES,
  getCurrentPlatformChannel,
  getPreferredTemplateId,
  getTrackedShare,
  purgeEphemeralMediaCache,
  setPreferredTemplateId,
} from '../../services/api';
import { buildCompliantShareConfig } from '../../utils/xhs-platform';
import XhsNoteMountCard from '../../components/XhsNoteMountCard.vue';

const capacities: { label: string; value: GrantorCapacity }[] = [
  { label: '本人出镜', value: 'self' },
  { label: '未成年人监护人', value: 'guardian' },
  { label: '获授权家庭代表', value: 'authorized-agent' },
];

const templates = ref<PortraitTemplateSpec[]>(BUILTIN_PORTRAIT_TEMPLATES);
const selectedTemplateId = ref<string>(getPreferredTemplateId());

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

const anchorAgeOptions = [18, 25, 28, 35, 45, 55];
const currentAgeAnchor = ref<number>(28);
const selectedAspectRatio = ref<AspectRatio>('3:4');

const availableAges = [0, 6, 12, 18, 25, 28, 35, 45, 55, 65, 75, 85, 100];
const selectedAges = ref<number[]>([6, 18, 28, 45, 65, 85]);
const isGenerating = ref(false);
const activeJob = ref<GenerationJob | null>(null);
const activeShare = ref<Share | null>(null);
const checkoutResult = ref<CheckoutSession | null>(null);
const showCompiledPrompts = ref(false);

function formatRatioLabel(ratio: AspectRatio): string {
  const labels: Record<AspectRatio, string> = {
    '3:4': '3:4 小红书竖版',
    '4:5': '4:5 精装画册版',
    '1:1': '1:1 经典方画幅',
    '9:16': '9:16 全屏故事版',
  };
  return labels[ratio] || ratio;
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
    uni.showToast({
      title: `当前模板最多支持 ${currentTemplate.value.max_participants} 人，已为您切换至「温情伴侣/家人共老」合拍模板`,
      icon: 'none',
    });
    const familyTpl = templates.value.find(
      (t) => t.template_id === 'tpl_xhs_warm_family_co_aging'
    );
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
    },
  });
  consentReceipt.value = receipt;
  uni.showToast({ title: '授权凭证已签发', icon: 'success' });
}

async function handlePickPhoto() {
  if (!consentReceipt.value) {
    uni.showToast({ title: '请先完成第 1 步逐人授权', icon: 'none' });
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
      aspect_ratio: selectedAspectRatio.value,
    });

    const job = await apiClient.startGenerationJob({
      project_id: project.id,
      quote_id: `quo_free_preview_${Date.now()}`,
      entitlement_id: `ent_xhs_${Date.now()}`,
    });
    activeJob.value = job;
    uni.showToast({ title: '高定光影影像生成完成', icon: 'success' });
  } finally {
    isGenerating.value = false;
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
