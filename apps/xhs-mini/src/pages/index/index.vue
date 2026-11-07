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
        <text class="hero-title">看见 0—100 岁的自己与家人</text>
        <text class="hero-subtitle">小红书专属时光机的温暖记忆 · 逐人授权 · 随时可撤回</text>
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

      <button class="btn-primary" @click="goToStudio">立即进入时光工坊（需逐人授权）</button>
    </view>

    <!-- 小红书种草灵感与家庭仪式场景 -->
    <view class="card">
      <view class="section-title">小红书热门时光仪式</view>
      <view v-for="scene in xhsScenes" :key="scene.id" class="scene-item" @click="goToStudio">
        <view class="scene-main">
          <text class="scene-name">{{ scene.title }}</text>
          <text class="scene-summary">{{ scene.desc }}</text>
        </view>
        <text class="scene-tag">{{ scene.badge }}</text>
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
import { ref, onMounted } from 'vue';
import { AI_SIMULATION_DISCLOSURE } from '@ailifetime/contracts';
import { apiClient } from '../../services/api';
import { performPlatformLogin } from '../../utils/xhs-platform';

const disclosureText = ref(AI_SIMULATION_DISCLOSURE);
const sessionStatus = ref('初始化中...');

const ageMilestones = [
  { age: 6, tag: '童年纯真' },
  { age: 18, tag: '青春启航' },
  { age: 28, tag: '当下绽放' },
  { age: 45, tag: '从容岁月' },
  { age: 65, tag: '温情银发' },
  { age: 85, tag: '世纪回眸' },
];

const xhsScenes = [
  {
    id: 'solo-timeline',
    title: '0—100岁人生胶片时间轴',
    desc: '一张照片生成 6 个年龄阶段的高身份一致性艺术写真',
    badge: '笔记爆款',
  },
  {
    id: 'family-co-aging',
    title: '和父母/伴侣一起慢慢变老',
    desc: '双人或家庭逐人独立授权，定格跨越半个世纪的陪伴',
    badge: '家庭合拍',
  },
  {
    id: 'memorial-book',
    title: '典藏精装时光照片书定制',
    desc: '连接影楼与纪念礼品供应链，把数字记忆变成实物相册',
    badge: '实物履约',
  },
];

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

function goToStudio() {
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
</style>
