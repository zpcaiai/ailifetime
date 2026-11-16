<template>
  <view class="page-container">
    <view v-if="IS_SANDBOX_MODE" class="card card-desc">当前为本地预览，订单、分享和隐私请求使用演示数据。</view>
    <!-- 订单与实物相册履约查询 -->
    <view v-if="IS_SANDBOX_MODE || routedOrderId" class="card">
      <view class="section-title">订单与履约</view>
      <view v-if="currentOrder" class="order-box">
        <text class="order-line">订单号：{{ currentOrder.id }}</text>
        <text class="order-line">状态：{{ currentOrder.state }}</text>
        <text class="order-line">金额：¥{{ (currentOrder.amount_minor / 100).toFixed(2) }}</text>
      </view>
      <text v-if="orderMessage" class="card-desc">{{ orderMessage }}</text>
      <button class="btn-secondary" :loading="orderBusy" :disabled="orderBusy" @click="handleQueryOrder">
        {{ IS_SANDBOX_MODE ? '查询演示订单' : '刷新订单状态' }}
      </button>
      <button v-if="canPay" class="btn-secondary" :disabled="orderBusy" @click="handlePayOrder">继续支付</button>
    </view>

    <!-- 分享短链即时撤销 -->
    <view class="card">
      <view class="section-title">撤销分享短链</view>
      <button class="btn-secondary" @click="handleRevokeShare">
        {{ shareRevoked ? '已撤销分享' : '撤销最近分享短链' }}
      </button>
    </view>

    <!-- 数据权利与全链路删除收据 (B70-R03 / B72-R05) -->
    <view class="card">
      <view class="section-title">隐私权、撤回同意与全链路删除</view>
      <text class="card-desc">
        可申请删除数据或撤回出镜授权。提交后可查看工单处理状态。
      </text>

      <view class="rights-actions">
        <button class="btn-danger" :disabled="rightsPending" @click="handleSubmitDeletion('delete')">
          申请删除数据
        </button>
        <button class="btn-outline" :disabled="rightsPending" @click="handleSubmitDeletion('withdraw-consent')">
          撤回出镜人授权
        </button>
      </view>

      <view v-if="rightsCase" class="receipt-box">
        <text class="receipt-line">权利工单号：{{ rightsCase.id }}</text>
        <text class="receipt-line">处理状态：{{ rightsCase.state }}</text>
        <text class="receipt-line">承诺完成时间：{{ rightsCase.target_at }}</text>
      </view>
    </view>

  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onHide, onLoad, onShow, onUnload } from '@dcloudio/uni-app';
import type { Order, RightsCase } from '@ailifetime/contracts';
import {
  apiClient,
  IS_SANDBOX_MODE,
  getCurrentPlatformChannel,
  getLatestOrderId,
  getLatestShareId,
  getTrackedShare,
  purgeEphemeralMediaCache,
  setAccessToken,
} from '../../services/api';
import { exchangePlatformSession, isXhsOrderId, requestXhsCustomPayment } from '../../utils/xhs-platform';

const currentOrder = ref<Order | null>(null);
const routedOrderId = ref<string | null>(null);
const orderBusy = ref(false);
const canPay = ref(false);
const orderMessage = ref('');
let orderPageVisible = false;
const shareRevoked = ref(false);
const rightsCase = ref<RightsCase | null>(null);
const rightsPending = ref(false);

onLoad((options) => {
  if (!IS_SANDBOX_MODE && getCurrentPlatformChannel() === 'mp-xhs' && isXhsOrderId(options?.order_id)) {
    routedOrderId.value = options.order_id;
  }
});

onShow(() => {
  orderPageVisible = true;
  const tracked = getTrackedShare(getLatestShareId());
  shareRevoked.value = Boolean(tracked && tracked.status === 'revoked');
  if (routedOrderId.value) void handleQueryOrder();
});

function clearOrderView() {
  orderPageVisible = false;
  currentOrder.value = null;
  canPay.value = false;
  orderMessage.value = '';
}

onHide(clearOrderView);
onUnload(() => {
  clearOrderView();
  routedOrderId.value = null;
});

async function fetchLiveOrder(orderId: string): Promise<Order> {
  let order;
  try {
    order = await apiClient.getOrder(orderId);
  } catch (error) {
    if (!(error instanceof Error) || !['MINI_PROGRAM_LOGIN_REQUIRED', 'API_HTTP_401'].includes(error.message)) throw error;
    const session = await exchangePlatformSession((request) => apiClient.exchangeMiniProgramSession(request));
    if (session?.platform !== 'mp-xhs') throw new Error('MINI_PROGRAM_LOGIN_REQUIRED');
    setAccessToken(session.access_token);
    order = await apiClient.getOrder(orderId);
  }
  if (order?.id !== orderId || order.currency !== 'CNY' ||
      !Number.isSafeInteger(order.amount_minor) || order.amount_minor < 0) {
    throw new Error('XHS_ORDER_RESPONSE_INVALID');
  }
  return order;
}

function displayOrder(order: Order, allowPayment: boolean) {
  const { xhs_custom_checkout: checkout, ...summary } = order;
  currentOrder.value = summary;
  canPay.value = allowPayment && order.state === 'awaiting-payment' && Boolean(checkout);
}

async function handleQueryOrder() {
  const orderId = routedOrderId.value;
  if (orderBusy.value || (!IS_SANDBOX_MODE && !orderId)) return;
  orderBusy.value = true;
  orderMessage.value = '';
  try {
    const order = orderId ? await fetchLiveOrder(orderId) : await apiClient.getOrder(getLatestOrderId());
    if (orderPageVisible && routedOrderId.value === orderId) displayOrder(order, Boolean(orderId));
  } catch {
    if (orderPageVisible && routedOrderId.value === orderId) {
      currentOrder.value = null;
      canPay.value = false;
      orderMessage.value = '暂时无法查询订单';
    }
  } finally {
    orderBusy.value = false;
  }
}

async function handlePayOrder() {
  const orderId = routedOrderId.value;
  if (IS_SANDBOX_MODE || !orderId || !canPay.value || orderBusy.value) return;
  orderBusy.value = true;
  canPay.value = false;
  orderMessage.value = '';
  let cashierRequested = false;
  try {
    const order = await fetchLiveOrder(orderId);
    if (!orderPageVisible || routedOrderId.value !== orderId) return;
    if (order.state !== 'awaiting-payment') {
      displayOrder(order, false);
      return;
    }
    const outcome = await requestXhsCustomPayment(order);
    cashierRequested = true;
    if (routedOrderId.value !== orderId) return;
    const reconciled = await fetchLiveOrder(orderId);
    if (orderPageVisible && routedOrderId.value === orderId) {
      displayOrder(reconciled, outcome === 'cancelled');
      if (reconciled.state === 'awaiting-payment') {
        orderMessage.value = outcome === 'cancelled' ? '支付已取消' : '订单状态待确认，请稍后刷新';
      }
    }
  } catch {
    if (orderPageVisible && routedOrderId.value === orderId) {
      orderMessage.value = cashierRequested ? '订单状态待确认，请稍后刷新' : '暂时无法继续支付，请刷新订单';
    }
  } finally {
    orderBusy.value = false;
  }
}

async function handleRevokeShare() {
  try {
    await apiClient.revokeShare(getLatestShareId());
    shareRevoked.value = true;
    uni.showToast({ title: '分享链接已撤销', icon: 'success' });
  } catch {
    uni.showToast({ title: '暂时无法撤销分享链接', icon: 'none' });
  }
}

async function handleSubmitDeletion(type: 'delete' | 'withdraw-consent') {
  if (rightsPending.value) return;
  rightsPending.value = true;
  rightsCase.value = null;
  purgeEphemeralMediaCache();
  const channel = getCurrentPlatformChannel();
  try {
    rightsCase.value = await apiClient.submitRightsRequest({
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
    uni.showToast({ title: '权利申请已提交', icon: 'success' });
  } catch {
    uni.showToast({ title: '提交失败，请稍后重试', icon: 'none' });
  } finally {
    rightsPending.value = false;
  }
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
