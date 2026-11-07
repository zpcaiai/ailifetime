<template>
  <view class="xhs-mount-card">
    <view class="mount-header">
      <text class="mount-badge">小红书笔记挂载组件</text>
      <text class="ai-badge">{{ mountCard?.ai_watermark_badge || 'AI生成·艺术示意非真实预测' }}</text>
    </view>

    <text class="mount-desc">
      一键生成带强制 AI 艺术示意标签与可撤销短链的小红书种草笔记挂载卡片（遵循 B71-R03，含未成年人出镜作品默认禁止公开挂载）。
    </text>

    <view class="tag-list">
      <text
        v-for="tag in selectedTags"
        :key="tag"
        class="topic-tag"
      >
        #{{ tag }}
      </text>
    </view>

    <button class="btn-mount" @click="handleGenerateMount">
      {{ mountCard ? '重新生成小红书笔记挂载卡' : '生成小红书种草笔记挂载卡' }}
    </button>

    <view v-if="mountCard" class="mount-result">
      <text class="result-line">挂载 ID：{{ mountCard.mount_id }}</text>
      <text class="result-line">合规标题：{{ mountCard.enforced_title }}</text>
      <text class="result-line">小程序路径：{{ mountCard.xhs_path }}</text>
      <text class="result-line">有效期至：{{ mountCard.expires_at }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { XhsNoteMountCard } from '@ailifetime/contracts';
import { apiClient } from '../services/api';

const props = defineProps<{
  shareId: string;
  consentRefs: string[];
  containsMinor?: boolean;
}>();

const selectedTags = ref(['AI人生时光机', '0到100岁的自己', '时光相册', 'AI艺术写真']);
const mountCard = ref<XhsNoteMountCard | null>(null);

async function handleGenerateMount() {
  if (props.containsMinor) {
    uni.showToast({
      title: '未成年人出镜作品受 B21/B71 保护，禁止公开挂载笔记',
      icon: 'none',
    });
    return;
  }
  try {
    const card = await apiClient.createXhsNoteMount({
      share_id: props.shareId,
      title: '0—100岁人生时光胶片体验',
      topic_tags: selectedTags.value,
      participant_consent_refs: props.consentRefs,
      contains_minor: Boolean(props.containsMinor),
    });
    mountCard.value = card;
    uni.showToast({ title: '笔记挂载卡已生成', icon: 'success' });
  } catch (err) {
    mountCard.value = null;
    const message = err instanceof Error ? err.message : '生成笔记挂载卡失败';
    uni.showToast({ title: message, icon: 'none' });
  }
}
</script>

<style scoped lang="scss">
.xhs-mount-card {
  margin-top: 24rpx;
  padding: 24rpx;
  border-radius: 20rpx;
  background: linear-gradient(180deg, #fff5f7 0%, #ffffff 100%);
  border: 1rpx solid #ffd0da;
}

.mount-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12rpx;
}

.mount-badge {
  font-size: 26rpx;
  font-weight: 700;
  color: #ff2442;
}

.mount-desc {
  font-size: 22rpx;
  color: #555555;
  display: block;
  margin-bottom: 16rpx;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
  margin-bottom: 20rpx;
}

.topic-tag {
  font-size: 22rpx;
  color: #ff2442;
  background-color: #ffffff;
  border: 1rpx solid #ffccd5;
  padding: 4rpx 14rpx;
  border-radius: 999rpx;
}

.btn-mount {
  background-color: #1f1f24;
  color: #ffffff;
  border-radius: 999rpx;
  font-size: 26rpx;
  font-weight: 600;
}

.mount-result {
  margin-top: 16rpx;
  padding: 16rpx;
  background-color: #ffffff;
  border-radius: 14rpx;
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.result-line {
  font-size: 22rpx;
  color: #333333;
  word-break: break-all;
}
</style>
