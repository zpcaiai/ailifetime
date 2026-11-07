<script setup lang="ts">
import { onLaunch, onShow, onHide } from '@dcloudio/uni-app';
import { purgeEphemeralMediaCache } from './services/api';

onLaunch((options) => {
  // #ifdef MP-XHS
  console.info('[AI人生时光机 · 小红书端] 启动参数:', options?.path || 'index');
  // #endif
  // #ifdef MP-WEIXIN
  console.info('[AI人生时光机 · 微信端] 启动参数:', options?.path || 'index');
  // #endif
  // #ifndef MP-XHS || MP-WEIXIN
  console.info('[AI人生时光机 · 多端模式] 启动参数:', options?.path || 'index');
  // #endif
});

onShow(() => {
  // 页面展示时保持会话状态校验
});

onHide(() => {
  // B70-R03: 小程序切后台时主动清理短期签名预览媒体缓存，不留存敏感原图 URL
  purgeEphemeralMediaCache();
});
</script>

<style lang="scss">
page {
  background-color: #f8f8fa;
  color: #222222;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', sans-serif;
  font-size: 28rpx;
  line-height: 1.5;
}

.ai-badge {
  display: inline-flex;
  align-items: center;
  padding: 4rpx 14rpx;
  border-radius: 999rpx;
  background-color: #fff0f3;
  color: #ff2442;
  font-size: 22rpx;
  font-weight: 600;
}

.card {
  background-color: #ffffff;
  border-radius: 24rpx;
  padding: 28rpx;
  margin-bottom: 24rpx;
  box-shadow: 0 6rpx 20rpx rgba(0, 0, 0, 0.04);
}
</style>
