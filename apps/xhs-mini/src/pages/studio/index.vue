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
        <text class="form-label">出镜人数声明：</text>
        <view class="pill-group">
          <text
            v-for="cnt in [1, 2, 3]"
            :key="cnt"
            class="choice-pill"
            :class="{ active: participantCount === cnt }"
            @click="participantCount = cnt"
          >
            {{ cnt }} 人
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

    <!-- 步骤 2: 选择照片、预检与年龄轴配置 -->
    <view class="card">
      <view class="step-header">
        <text class="step-title">2. 照片加密上传与年龄阶段选择</text>
        <text class="step-sub">短期签名隔离上传</text>
      </view>

      <view class="upload-box" @click="handlePickPhoto">
        <text v-if="!uploadSession" class="upload-placeholder">
          + 点击选择本地照片并创建隔离上传会话
        </text>
        <view v-else class="upload-ready">
          <text class="upload-ok">已创建加密上传会话：{{ uploadSession.asset_id }}</text>
          <text class="upload-Note">过期时间：{{ uploadSession.expires_at }}</text>
        </view>
      </view>

      <view class="age-selector-label">目标生成年龄节点（可多选）：</view>
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
        {{ isGenerating ? '正在创建持久工作流...' : '启动 0—100 岁时光生成任务' }}
      </button>
    </view>

    <!-- 步骤 3: 生成进度、AI水印作品预览、小红书可撤销分享与实物相册下单 -->
    <view v-if="activeJob" class="card">
      <view class="step-header">
        <text class="step-title">3. 时光画廊与小红书分享</text>
        <text class="ai-badge">状态: {{ activeJob.state }}</text>
      </view>

      <view class="frames-grid">
        <view v-for="frame in activeJob.frames" :key="frame.age" class="frame-card">
          <view class="frame-Age">{{ frame.label }}</view>
          <view class="frame-watermark">{{ frame.ai_watermark_text }}</view>
          <view class="frame-url">短期签名预览 (切后台自动清理)</view>
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
import { ref } from 'vue';
import { onHide, onShow, onUnload, onShareAppMessage } from '@dcloudio/uni-app';
import type {
  CheckoutSession,
  ConsentReceipt,
  GenerationJob,
  GrantorCapacity,
  Share,
  UploadSession,
} from '@ailifetime/contracts';
import {
  apiClient,
  getCurrentPlatformChannel,
  getTrackedShare,
  purgeEphemeralMediaCache,
} from '../../services/api';
import { buildCompliantShareConfig } from '../../utils/xhs-platform';
import XhsNoteMountCard from '../../components/XhsNoteMountCard.vue';

const capacities: { label: string; value: GrantorCapacity }[] = [
  { label: '本人出镜', value: 'self' },
  { label: '未成年人监护人', value: 'guardian' },
  { label: '获授权家庭代表', value: 'authorized-agent' },
];

const grantorCapacity = ref<GrantorCapacity>('self');
const participantCount = ref(1);
const agreedToPolicy = ref(false);
const consentReceipt = ref<ConsentReceipt | null>(null);
const uploadSession = ref<UploadSession | null>(null);

const availableAges = [6, 18, 28, 45, 65, 85];
const selectedAges = ref<number[]>([6, 18, 28, 45, 65, 85]);
const isGenerating = ref(false);
const activeJob = ref<GenerationJob | null>(null);
const activeShare = ref<Share | null>(null);
const checkoutResult = ref<CheckoutSession | null>(null);

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
      template_id: 'tpl_xhs_0_100_timeline',
      participant_slots: slots,
      timeline_ages: selectedAges.value,
      visibility: 'private',
    });

    const job = await apiClient.startGenerationJob({
      project_id: project.id,
      quote_id: `quo_free_preview_${Date.now()}`,
      entitlement_id: `ent_xhs_${Date.now()}`,
    });
    activeJob.value = job;
    uni.showToast({ title: '时光影像生成完成', icon: 'success' });
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

onShareAppMessage(() => {
  return buildCompliantShareConfig({
    title: '我的 0—100 岁 AI 人生时光胶片',
    path: '/pages/index/index',
    shareUrl: activeShare.value?.url || 'https://share.ailifetime.local/s/demo',
    provenanceId: activeShare.value?.provenance_id || 'prov_default_ai_watermark',
  });
});

onShow(() => {
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

.frame-Age {
  font-size: 28rpx;
  font-weight: 700;
  color: #1f1f24;
}

.frame-watermark {
  font-size: 20rpx;
  color: #ff2442;
  margin-top: 6rpx;
}

.frame-url {
  font-size: 20rpx;
  color: #888888;
  margin-top: 8rpx;
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
