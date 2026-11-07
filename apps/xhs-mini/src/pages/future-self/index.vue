<template>
  <view class="page-container">
    <!-- 未来自我虚构身份透明告知卡 -->
    <view class="card notice-card">
      <view class="notice-header">
        <text class="ai-badge">AI 虚构对话声明</text>
        <text class="memory-pill" @click="cycleMemoryMode">记忆模式: {{ memoryModeLabel }}</text>
      </view>
      <text class="notice-body">
        “未来自我”是基于艺术化想象生成的 AI 角色，旨在提供温暖的人生书信与情感回顾，不提供真实人生预测、医疗诊断、心理咨询或投资理财建议。
      </text>
    </view>

    <!-- 对话消息列表 -->
    <view class="card chat-box">
      <view v-for="msg in messages" :key="msg.id" class="msg-item" :class="msg.sender">
        <text class="msg-role">{{ msg.sender === 'user' ? '现在的我' : '80岁的未来自我 (AI示意)' }}</text>
        <text v-if="msg.disclosure" class="msg-disclosure">{{ msg.disclosure }}</text>
        <text class="msg-content">{{ msg.text }}</text>
      </view>
    </view>

    <!-- 发送输入栏 -->
    <view class="card input-card">
      <textarea
        v-model="draftMessage"
        class="chat-input"
        maxlength="500"
        placeholder="写一句想对 30 年后的自己或家人说的话..."
      />
      <button class="btn-primary" :disabled="sending" @click="handleSendMessage">
        {{ sending ? '正在投递时光信件...' : '发送给未来自我' }}
      </button>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { apiClient } from '../../services/api';

interface ChatBubble {
  id: string;
  sender: 'user' | 'future';
  text: string;
  disclosure?: string;
}

const memoryMode = ref<'off' | 'session' | 'explicit'>('off');
const draftMessage = ref('');
const sending = ref(false);
const conversationId = ref(`conv_xhs_${Date.now()}`);

const messages = ref<ChatBubble[]>([
  {
    id: 'welcome_01',
    sender: 'future',
    disclosure: '【AI虚拟形象提示】以下内容为 AI 艺术化虚构书信示意。',
    text: '你好呀，现在的我。翻开这本时光相册，你最想留住今年的哪个瞬间？',
  },
]);

const memoryModeLabel = computed(() => {
  if (memoryMode.value === 'off') return '关闭长期记忆 (默认)';
  if (memoryMode.value === 'session') return '仅当前会话';
  return '显式授权纪念册';
});

function cycleMemoryMode() {
  if (memoryMode.value === 'off') memoryMode.value = 'session';
  else if (memoryMode.value === 'session') memoryMode.value = 'explicit';
  else memoryMode.value = 'off';
}

async function handleSendMessage() {
  const content = draftMessage.value.trim();
  if (!content) {
    uni.showToast({ title: '请输入想对未来自己说的话', icon: 'none' });
    return;
  }

  messages.value.push({
    id: `usr_${Date.now()}`,
    sender: 'user',
    text: content,
  });
  draftMessage.value = '';
  sending.value = true;

  try {
    const reply = await apiClient.sendFutureSelfMessage({
      conversation_id: conversationId.value,
      message: content,
      disclosure_ack: true,
      memory_mode: memoryMode.value,
    });

    messages.value.push({
      id: reply.message_id,
      sender: 'future',
      disclosure: reply.role_disclosure,
      text: reply.content,
    });
  } finally {
    sending.value = false;
  }
}
</script>

<style scoped lang="scss">
.page-container {
  padding: 24rpx;
}

.notice-card {
  background-color: #fff9fa;
  border: 1rpx solid #ffd6df;
}

.notice-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12rpx;
}

.memory-pill {
  font-size: 22rpx;
  color: #444444;
  background-color: #f0f0f5;
  padding: 6rpx 16rpx;
  border-radius: 999rpx;
}

.notice-body {
  font-size: 24rpx;
  color: #666666;
}

.chat-box {
  display: flex;
  flex-direction: column;
  gap: 20rpx;
  min-height: 420rpx;
}

.msg-item {
  padding: 20rpx;
  border-radius: 18rpx;
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.msg-item.future {
  background-color: #f8f8fa;
  border-left: 6rpx solid #ff2442;
}

.msg-item.user {
  background-color: #fff0f3;
  align-self: flex-end;
}

.msg-role {
  font-size: 22rpx;
  font-weight: 700;
  color: #ff2442;
}

.msg-disclosure {
  font-size: 20rpx;
  color: #888888;
}

.msg-content {
  font-size: 28rpx;
  color: #222222;
}

.chat-input {
  width: 100%;
  height: 160rpx;
  background-color: #f8f8fa;
  border-radius: 16rpx;
  padding: 16rpx;
  box-sizing: border-box;
  font-size: 28rpx;
  margin-bottom: 20rpx;
}

.btn-primary {
  background-color: #ff2442;
  color: #ffffff;
  border-radius: 999rpx;
  font-size: 28rpx;
  font-weight: 600;
}
</style>
