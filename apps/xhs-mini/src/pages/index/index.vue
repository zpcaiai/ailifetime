<template>
  <view class="page-container">
    <!-- 顶部强制 AI 艺术示意合规横幅 (Product Invariant #1) -->
    <view class="disclosure-banner">
      <text class="ai-badge">AI 艺术示意</text>
      <text class="disclosure-text">{{ disclosureText }}</text>
    </view>

    <!-- 英雄主视觉卡片 -->
    <view class="card hero-card">
      <view class="hero-header">
        <text class="hero-title">看见 0—100 岁的自己与世界名胜旅拍</text>
        <text class="hero-subtitle">10 大高定系列 (v2.4.0) · 独立「世界名胜古迹 50 张」实景合成 · 4 阶物理级光影 · 20 页蝴蝶对裱有声相册</text>
      </view>

      <view class="age-pillars">
        <view v-for="item in ageMilestones" :key="item.age" class="age-pill">
          <text class="age-num">{{ item.age }}岁</text>
          <text class="age-desc">{{ item.tag }}</text>
        </view>
      </view>

      <view class="session-bar">
        <text class="session-label">当前伪名化会话：{{ sessionStatus }}</text>
        <button class="btn-outline" size="mini" @click="handleInitSession">刷新安全会话</button>
      </view>

      <button class="btn-primary" @click="goToStudio()">立即进入时光工坊（需逐人授权）</button>
    </view>

    <!-- 内置 5 大商业级高定摄影模板展示 (B08 / B14 / B15) -->
    <view class="card">
      <view class="section-title">内置高定人像模板库（点击直达同款）</view>
      <view
        v-for="tpl in builtinTemplates"
        :key="tpl.template_id"
        class="scene-item"
        @click="goToStudio(tpl.template_id)"
      >
        <view class="scene-main">
          <text class="scene-name">{{ tpl.name }}</text>
          <text class="scene-summary">{{ tpl.subtitle }}</text>
          <text class="scene-optics">
            {{ tpl.optics_and_lighting.focal_length_mm }}mm {{ tpl.optics_and_lighting.aperture }} ·
            内置{{ tpl.curated_gallery_shots.length }}张精选分镜(≥{{ tpl.min_curated_shots }}张成片) · 身份锁≥{{
              tpl.quality_thresholds.min_identity_similarity
            }}
          </text>
        </view>
        <text class="scene-tag">{{ tpl.badge }}</text>
      </view>
    </view>

    <!-- 独立分类：世界名胜古迹 · 100 张环球奇观实景合成模板库 -->
    <view class="card">
      <view class="section-title">
        世界名胜古迹 · 100 张环球旅拍实景模板库（上传本人照片合成 · 透视与阳光自动匹配）
      </view>
      <view class="pill-wrap">
        <text
          class="filter-pill"
          :class="{ active: selectedLandmarkRegion === 'all' }"
          @click="selectedLandmarkRegion = 'all'"
        >
          全部名胜 (100张)
        </text>
        <text
          v-for="reg in landmarkRegions"
          :key="reg.region_id"
          class="filter-pill"
          :class="{ active: selectedLandmarkRegion === reg.region_id }"
          @click="selectedLandmarkRegion = reg.region_id"
        >
          {{ reg.badge }} · {{ reg.name.split('与')[0] }}
        </text>
      </view>
      <view
        v-for="lmk in filteredLandmarks"
        :key="lmk.landmark_id"
        class="scene-item"
        @click="goToStudio('tpl_xhs_world_landmarks_50_global')"
      >
        <view class="scene-main">
          <text class="scene-name">#{{ String(lmk.index_number).padStart(3, '0') }} {{ lmk.name }}</text>
          <text class="scene-summary">{{ lmk.country_and_city }} · {{ lmk.subtitle }}</text>
          <text class="scene-optics">
            {{ lmk.focal_length_mm }}mm {{ lmk.aperture }} · 视平线Y={{ lmk.horizon_y_ratio }} · 太阳高度角{{ lmk.solar_elevation_deg }}° ({{ lmk.sky_color_temp_kelvin }}K) · 足底阴影={{ lmk.ground_contact_shadow_opacity }}
          </text>
        </view>
        <text class="scene-tag">{{ lmk.unesco_code }}</text>
      </view>
    </view>

    <!-- 一生拾忆时光机 P02: 12 大分类 × 20 首发模板 × 5 视觉风格 (100 种组合) -->
    <view class="card">
      <view class="section-title">
        一生拾忆 · 12 大分类 / 20 首发模板 / 5 风格 ({{ tcTemplates.length * tcStyles.length }} 种组合)
      </view>
      <view class="pill-wrap">
        <text
          v-for="styleItem in tcStyles"
          :key="styleItem.id"
          class="filter-pill"
          :class="{ active: selectedTcStyleId === styleItem.id }"
          @click="selectedTcStyleId = styleItem.id"
        >
          风格：{{ styleItem.name }}
        </text>
      </view>
      <view class="pill-wrap">
        <text
          class="filter-pill"
          :class="{ active: selectedTcCategory === 'all' }"
          @click="selectedTcCategory = 'all'"
        >
          全部 (20)
        </text>
        <text
          v-for="cat in tcCategories"
          :key="cat.id"
          class="filter-pill"
          :class="{ active: selectedTcCategory === cat.id }"
          @click="selectedTcCategory = cat.id"
        >
          {{ cat.name }}
        </text>
      </view>
      <view
        v-for="cardTpl in filteredTcTemplates"
        :key="cardTpl.id"
        class="scene-item"
        @click="goToTimeCapsuleCard(cardTpl.id)"
      >
        <view class="scene-main">
          <text class="scene-name">{{ cardTpl.name }} ({{ cardTpl.id }})</text>
          <text class="scene-summary">
            画幅 {{ cardTpl.sizes.join(' / ') }} · {{ cardTpl.image_slots }} 张素材槽 ·
            {{ cardTpl.label_policy === 'ai_required' ? 'GB 45438 显隐双标识必选' : '确定性排版卡片' }}
          </text>
        </view>
        <text class="scene-tag">{{ cardTpl.pricing_tier }}</text>
      </view>
    </view>

    <!-- 隐私与安全承诺卡 -->
    <view class="card safety-card">
      <view class="section-title">四大隐私与安全承诺 (B70/B72)</view>
      <view class="safety-item">1. 逐人按用途授权：多人合影、未成年人监护人授权独立校验。</view>
      <view class="safety-item">2. 默认私密与短期签名：前端切后台自动清理预览缓存，日志绝不记录原图。</view>
      <view class="safety-item">3. 强制 AI 标识：所有生成影像与分享卡片均携带不可移除的 AI 艺术示意水印。</view>
      <view class="safety-item">4. 可验证删除：支持一键撤销分享短链及发起全链路删除收据。</view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import {
  AI_SIMULATION_DISCLOSURE,
  type PortraitTemplateSpec,
  type WorldLandmarkRegionId,
} from '@ailifetime/contracts';
import {
  apiClient,
  BUILTIN_PORTRAIT_TEMPLATES,
  TIMECAPSULE_CATEGORIES,
  TIMECAPSULE_STYLES,
  TIMECAPSULE_TEMPLATES,
  WORLD_LANDMARK_50_TEMPLATES,
  WORLD_LANDMARK_REGIONS,
  setPreferredTemplateId,
  setPreferredTimeCapsuleSelection,
} from '../../services/api';
import { performPlatformLogin } from '../../utils/xhs-platform';

const disclosureText = ref(AI_SIMULATION_DISCLOSURE);
const sessionStatus = ref('初始化中...');

const ageMilestones = [
  { age: 3, tag: '稚气初萌' },
  { age: 6, tag: '清澈童眸' },
  { age: 12, tag: '少年澄澈' },
  { age: 18, tag: '青春启航' },
  { age: 25, tag: '黄金骨相' },
  { age: 32, tag: '光影笃定' },
  { age: 45, tag: '紧致从容' },
  { age: 58, tag: '微银知命' },
  { age: 72, tag: '银丝温厚' },
  { age: 85, tag: '世纪回眸' },
];

const builtinTemplates = ref<PortraitTemplateSpec[]>(BUILTIN_PORTRAIT_TEMPLATES);
const landmarkRegions = ref(WORLD_LANDMARK_REGIONS);
const selectedLandmarkRegion = ref<WorldLandmarkRegionId | 'all'>('all');
const filteredLandmarks = computed(() => {
  if (selectedLandmarkRegion.value === 'all') {
    return WORLD_LANDMARK_50_TEMPLATES;
  }
  return WORLD_LANDMARK_50_TEMPLATES.filter(
    (item) => item.region_id === selectedLandmarkRegion.value
  );
});

const tcCategories = ref(TIMECAPSULE_CATEGORIES);
const tcStyles = ref(TIMECAPSULE_STYLES);
const tcTemplates = ref(TIMECAPSULE_TEMPLATES);
const selectedTcCategory = ref<string>('all');
const selectedTcStyleId = ref<string>('retro');

const filteredTcTemplates = computed(() => {
  if (selectedTcCategory.value === 'all') {
    return tcTemplates.value;
  }
  return tcTemplates.value.filter((item) => item.category === selectedTcCategory.value);
});

async function handleInitSession() {
  try {
    const loginInfo = await performPlatformLogin();
    const guest = await apiClient.createGuestSession();
    const platformTarget = loginInfo.platform === 'mp-weixin' ? 'mp-weixin' : 'mp-xhs';
    const mpSession = await apiClient.exchangeMiniProgramSession({
      platform: platformTarget,
      js_code: loginInfo.code,
      merge_guest_session_id: guest.id,
    });
    sessionStatus.value = `${mpSession.platform} (${mpSession.actor_pseudonym.slice(0, 18)}...)`;
  } catch (err) {
    sessionStatus.value = '本地受控沙箱模式';
  }
}

function goToStudio(templateId?: string) {
  if (templateId) {
    setPreferredTemplateId(templateId);
  }
  uni.switchTab({
    url: '/pages/studio/index',
  });
}

function goToTimeCapsuleCard(cardId: string) {
  setPreferredTimeCapsuleSelection(cardId, selectedTcStyleId.value);
  uni.switchTab({
    url: '/pages/studio/index',
  });
}

onMounted(() => {
  handleInitSession();
});
</script>

<style scoped lang="scss">
.page-container {
  padding: 24rpx;
}

.disclosure-banner {
  background-color: #fff8e6;
  border: 1rpx solid #ffe0a3;
  border-radius: 16rpx;
  padding: 16rpx 20rpx;
  margin-bottom: 24rpx;
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.disclosure-text {
  font-size: 24rpx;
  color: #8a5a00;
}

.hero-card {
  background: linear-gradient(135deg, #fff0f3 0%, #ffffff 100%);
  border: 1rpx solid #ffd6df;
}

.hero-title {
  font-size: 38rpx;
  font-weight: 700;
  color: #1f1f24;
  display: block;
}

.hero-subtitle {
  font-size: 26rpx;
  color: #666666;
  margin-top: 8rpx;
  display: block;
}

.age-pillars {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16rpx;
  margin: 28rpx 0;
}

.age-pill {
  background-color: #ffffff;
  border-radius: 16rpx;
  padding: 16rpx;
  text-align: center;
  border: 1rpx solid #f0f0f5;
}

.age-num {
  font-size: 30rpx;
  font-weight: 700;
  color: #ff2442;
  display: block;
}

.age-desc {
  font-size: 22rpx;
  color: #666666;
}

.session-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20rpx;
  padding: 12rpx 16rpx;
  background-color: #f8f8fa;
  border-radius: 12rpx;
}

.session-label {
  font-size: 22rpx;
  color: #555555;
}

.btn-primary {
  background-color: #ff2442;
  color: #ffffff;
  border-radius: 999rpx;
  font-size: 30rpx;
  font-weight: 600;
}

.btn-outline {
  border: 1rpx solid #ff2442;
  color: #ff2442;
  background-color: #ffffff;
  margin: 0;
}

.section-title {
  font-size: 32rpx;
  font-weight: 700;
  margin-bottom: 20rpx;
  color: #1f1f24;
}

.scene-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20rpx 0;
  border-bottom: 1rpx solid #f2f2f5;
}

.scene-main {
  display: flex;
  flex-direction: column;
  gap: 6rpx;
  padding-right: 16rpx;
}

.scene-name {
  font-size: 28rpx;
  font-weight: 600;
}

.scene-summary {
  font-size: 24rpx;
  color: #666666;
}

.scene-optics {
  font-size: 21rpx;
  color: #1f4f99;
  font-weight: 500;
}

.scene-tag {
  font-size: 22rpx;
  color: #ff2442;
  background-color: #fff0f3;
  padding: 6rpx 16rpx;
  border-radius: 999rpx;
  white-space: nowrap;
}

.safety-item {
  font-size: 24rpx;
  color: #444444;
  margin-bottom: 10rpx;
}

.pill-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
  margin-bottom: 16rpx;
}

.filter-pill {
  font-size: 22rpx;
  padding: 8rpx 18rpx;
  border-radius: 999rpx;
  background-color: #f4f4f8;
  color: #444444;
}

.filter-pill.active {
  background-color: #ff2442;
  color: #ffffff;
  font-weight: 600;
}
</style>
