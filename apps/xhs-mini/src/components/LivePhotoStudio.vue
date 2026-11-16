<template>
  <view class="studio">
    <view class="card">
      <text class="title">指定年龄照片</text>
      <text class="copy">{{ PHOTO_CONSENT_TEXT }}</text>
      <checkbox-group @change="acceptConsent">
        <label><checkbox value="self" :checked="accepted" :disabled="busy || Boolean(asset)" />我已满18岁，是照片中唯一出镜人，并授权处理本次照片</label>
      </checkbox-group>
      <button :disabled="busy || !accepted || Boolean(asset)" @click="uploadPhoto">
        {{ asset ? '照片已上传' : '选择并上传照片' }}
      </button>
      <input v-model="currentAge" type="number" :disabled="busy || Boolean(quoteInput)" placeholder="本人现在的年龄" />
      <input v-model="targetAge" type="number" :disabled="busy || Boolean(quoteInput)" placeholder="想查看的年龄" />
      <button :disabled="busy || !asset || Boolean(purchase)" @click="quote">获取服务端报价</button>
    </view>
    <view v-if="purchase" class="card">
      <text class="copy">订单 {{ purchase.purchaseId }}</text>
      <text class="copy">金额 ¥{{ (purchase.amountMinor / 100).toFixed(2) }}</text>
      <text class="copy">{{ purchase.readyCount === 1 ? '生成结果已就绪' : purchase.paymentState === 'paid' ? '付款已确认' : '等待服务端确认付款' }}</text>
      <button :disabled="busy" @click="refresh">刷新订单</button>
      <button v-if="purchase.paymentState === 'paid' && !purchase.readyCount" :disabled="busy" @click="fulfill">提交或恢复生成</button>
    </view>
    <text v-if="message" class="copy" role="status">{{ message }}</text>
  </view>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { apiClient, createIdempotencyKey, photoRequestForCurrentSession, setAccessToken } from '../services/api';
import { chooseAndUploadXhsPhoto, type PhotoRequest } from '../services/real-photo-upload';
import {
  createXhsPhotoPurchase, fulfillXhsPhotoPurchase, PHOTO_CONSENT_TEXT, refreshXhsPhotoPurchase,
  verifiedPhotoActor, type PhotoPurchase,
} from '../services/real-photo-generation';
import { exchangePlatformSession } from '../utils/xhs-platform';

const props = defineProps<{ active: boolean }>();
const accepted = ref(false);
const currentAge = ref('');
const targetAge = ref('');
const busy = ref(false);
const message = ref('');
const asset = ref<{ assetId: string; actorId: string; request: PhotoRequest } | null>(null);
const quoteInput = ref<{ key: string; currentAge: number; targetAge: number } | null>(null);
const purchase = ref<PhotoPurchase | null>(null);
let purchaseId: string | null = null;
let pageVersion = 0;

function clearMedia() {
  pageVersion++;
  accepted.value = false;
  asset.value = null;
  quoteInput.value = null;
  purchase.value = null;
  message.value = '';
}

watch(() => props.active, (active) => {
  if (!active) clearMedia();
  else if (purchaseId && !busy.value) void refresh();
});
onBeforeUnmount(clearMedia);

function acceptConsent(event: { detail: { value: string[] } }) {
  accepted.value = event.detail.value.includes('self');
}

async function connectedRequest(): Promise<{ request: PhotoRequest; actorId: string }> {
  try {
    const request = photoRequestForCurrentSession();
    return { request, actorId: await verifiedPhotoActor(request) };
  } catch (error) {
    if (!(error instanceof Error) ||
        !['MINI_PROGRAM_LOGIN_REQUIRED', 'MINI_PROGRAM_SESSION_CHANGED', 'API_HTTP_401'].includes(error.message)) throw error;
    const session = await exchangePlatformSession(request => apiClient.exchangeMiniProgramSession(request));
    if (session?.platform !== 'mp-xhs') throw new Error('MINI_PROGRAM_LOGIN_REQUIRED');
    setAccessToken(session.access_token);
    const request = photoRequestForCurrentSession();
    return { request, actorId: await verifiedPhotoActor(request) };
  }
}

async function run(operation: (isCurrent: () => boolean) => Promise<void>, failure: string) {
  if (!props.active || busy.value) return;
  const version = pageVersion;
  const isCurrent = () => props.active && version === pageVersion;
  busy.value = true;
  message.value = '';
  try { await operation(isCurrent); }
  catch { if (isCurrent()) message.value = failure; }
  finally { busy.value = false; }
}

async function uploadPhoto() {
  if (!accepted.value || asset.value) return;
  await run(async (isCurrent) => {
    const connection = await connectedRequest();
    const uploaded = await chooseAndUploadXhsPhoto(connection.request, createIdempotencyKey('xhs-upload'), isCurrent);
    if (isCurrent()) asset.value = { ...connection, ...uploaded };
  }, '暂时无法上传。请确认登录，并选择 4 MiB 以内、至少 512×512 的本人 JPEG 照片。');
}

async function quote() {
  const source = asset.value;
  if (!source || !accepted.value) return;
  if (!/^\d{1,3}$/.test(String(currentAge.value).trim()) || !/^\d{1,3}$/.test(String(targetAge.value).trim()) ||
      Number(currentAge.value) < 18 || Number(currentAge.value) > 100 || Number(targetAge.value) > 100) {
    message.value = '请填写有效年龄。本人年龄须为 18 至 100 岁。';
    return;
  }
  await run(async (isCurrent) => {
    quoteInput.value ??= { key: createIdempotencyKey('xhs-photo'), currentAge: Number(currentAge.value), targetAge: Number(targetAge.value) };
    const intent = quoteInput.value;
    const result = await createXhsPhotoPurchase(source.request, {
      assetId: source.assetId, actorId: source.actorId, currentAge: intent.currentAge, targetAge: intent.targetAge,
    }, intent.key, isCurrent);
    purchaseId = result.purchaseId;
    if (isCurrent()) purchase.value = result;
  }, '未取得报价，请保留当前照片和年龄后重试。');
}

async function refresh() {
  const id = purchaseId;
  if (!id) return;
  await run(async (isCurrent) => {
    const { request } = await connectedRequest();
    const result = await refreshXhsPhotoPurchase(request, id);
    if (isCurrent()) purchase.value = result;
  }, '暂时无法查询订单。');
}

async function fulfill() {
  const id = purchaseId;
  if (!id || purchase.value?.paymentState !== 'paid') return;
  await run(async (isCurrent) => {
    const { request } = await connectedRequest();
    if (!isCurrent()) return;
    const result = await fulfillXhsPhotoPurchase(request, id);
    if (isCurrent()) purchase.value = result;
  }, '生成状态待确认，请先刷新订单。');
}
</script>

<style scoped>
.studio { padding: 24rpx; }
.title, .copy { display: block; margin-bottom: 20rpx; }
.title { font-size: 32rpx; font-weight: 700; }
button, input, checkbox-group { margin-top: 20rpx; }
input { padding: 16rpx; border: 1px solid #ddd; }
</style>
