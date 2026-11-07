<template>
  <view class="page-container">
    <!-- 订单与实物相册履约查询 -->
    <view class="card">
      <view class="section-title">实物照片书与数字订单 (B71)</view>
      <view v-if="currentOrder" class="order-box">
        <text class="order-line">订单号：{{ currentOrder.id }}</text>
        <text class="order-line">状态：{{ currentOrder.state }}</text>
        <text class="order-line">金额：¥{{ (currentOrder.amount_minor / 100).toFixed(2) }}</text>
      </view>
      <button class="btn-secondary" @click="handleQueryOrder">查询最近订单与履约状态</button>
    </view>

    <!-- 分享短链即时撤销 -->
    <view class="card">
      <view class="section-title">分享短链与边缘缓存撤销 (B71-R03)</view>
      <text class="card-desc">
        撤销后，小红书私信或笔记挂载的短链立即失效，且自动触发 CDN 边缘缓存清理。
      </text>
      <button class="btn-secondary" @click="handleRevokeShare">
        {{ shareRevoked ? '已撤销分享并清理边缘缓存' : '一键撤销最近分享短链' }}
      </button>
    </view>

    <!-- 数据权利与全链路删除收据 (B70-R03 / B72-R05) -->
    <view class="card">
      <view class="section-title">隐私权、撤回同意与全链路删除</view>
      <text class="card-desc">
        提交删除请求后，系统将级联清除原图、衍生图、缓存、供应商副本及备份索引，并出具可机器校验的删除收据。
      </text>

      <view class="rights-actions">
        <button class="btn-danger" @click="handleSubmitDeletion('delete')">
          申请全链路彻底删除并获取收据
        </button>
        <button class="btn-outline" @click="handleSubmitDeletion('withdraw-consent')">
          撤回出镜人授权
        </button>
      </view>

      <view v-if="rightsCase" class="receipt-box">
        <text class="receipt-line">权利工单号：{{ rightsCase.id }}</text>
        <text class="receipt-line">处理状态：{{ rightsCase.state }}</text>
        <text class="receipt-line">承诺完成时间：{{ rightsCase.target_at }}</text>
        <text class="receipt-line">机器可查收据：{{ rightsCase.receipt_url }}</text>
      </view>
    </view>

    <!-- 微信小程序 & 小红书小程序双端上线预备状态自检看板 -->
    <view class="card">
      <view class="section-title">微信 & 小红书双端上线预备状态自检</view>
      <text class="card-desc">
        当前通道：{{ launchReadiness.channel }} · 模式：{{ launchReadiness.runtimeMode }} · 开发者工具预览就绪：{{ launchReadiness.readyForDevToolsPreview ? 'PASS' : 'PENDING' }}
      </text>
      <view class="order-box">
        <view
          v-for="item in launchReadiness.checks"
          :key="item.id"
          class="readiness-row"
        >
          <text class="order-line">
            {{ item.passed ? '✅' : '⏳' }} {{ item.label }}
          </text>
          <text class="readiness-sub">{{ item.detail }}</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import type { Order, RightsCase } from '@ailifetime/contracts';
import {
  apiClient,
  getCurrentPlatformChannel,
  getLatestOrderId,
  getLatestShareId,
  getMiniProgramLaunchReadiness,
  getTrackedShare,
  purgeEphemeralMediaCache,
} from '../../services/api';

const currentOrder = ref<Order | null>(null);
const shareRevoked = ref(false);
const rightsCase = ref<RightsCase | null>(null);
const launchReadiness = ref(getMiniProgramLaunchReadiness());

onShow(() => {
  const tracked = getTrackedShare(getLatestShareId());
  shareRevoked.value = Boolean(tracked && tracked.status === 'revoked');
  launchReadiness.value = getMiniProgramLaunchReadiness();
});

async function handleQueryOrder() {
  const order = await apiClient.getOrder(getLatestOrderId());
  currentOrder.value = order;
  uni.showToast({ title: '订单状态已同步', icon: 'success' });
}

async function handleRevokeShare() {
  await apiClient.revokeShare(getLatestShareId());
  shareRevoked.value = true;
  uni.showToast({ title: '分享链接已撤销', icon: 'success' });
}

async function handleSubmitDeletion(type: 'delete' | 'withdraw-consent') {
  purgeEphemeralMediaCache();
  const channel = getCurrentPlatformChannel();
  const result = await apiClient.submitRightsRequest({
    type,
    scope: {
      include_raw_media: true,
      include_derived_assets: true,
      include_vendor_print_copies: true,
      channel,
    },
    verification_method: `${channel}-session-bound`,
    reason: '用户主动在小程序端发起隐私权利请求',
  });
  rightsCase.value = result;
  uni.showToast({ title: '已生成删除收据工单', icon: 'success' });
}
</script>

<style scoped lang="scss">
.page-container {
  padding: 24rpx;
}

.section-title {
  font-size: 30rpx;
  font-weight: 700;
  margin-bottom: 12rpx;
  color: #1f1f24;
}

.card-desc {
  font-size: 24rpx;
  color: #666666;
  display: block;
  margin-bottom: 20rpx;
}

.order-box,
.receipt-box {
  background-color: #f8f8fa;
  border-radius: 16rpx;
  padding: 20rpx;
  margin: 16rpx 0;
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.order-line,
.receipt-line {
  font-size: 24rpx;
  color: #333333;
  word-break: break-all;
}

.readiness-row {
  display: flex;
  flex-direction: column;
  gap: 4rpx;
  padding-bottom: 10rpx;
  border-bottom: 1rpx solid #ececf2;
}

.readiness-sub {
  font-size: 21rpx;
  color: #666666;
  line-height: 1.4;
}

.rights-actions {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.btn-secondary {
  background-color: #fff0f3;
  color: #ff2442;
  border: 1rpx solid #ff2442;
  border-radius: 999rpx;
  font-size: 26rpx;
  font-weight: 600;
}

.btn-danger {
  background-color: #ff2442;
  color: #ffffff;
  border-radius: 999rpx;
  font-size: 26rpx;
  font-weight: 600;
}

.btn-outline {
  background-color: #ffffff;
  color: #333333;
  border: 1rpx solid #cccccc;
  border-radius: 999rpx;
  font-size: 26rpx;
}
</style>
