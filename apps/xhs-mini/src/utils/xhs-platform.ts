/**
 * 小红书小程序 (MP-XHS) 与多端条件编译适配层
 * 遵循 B70-R01 (不把 openid 当作跨主体身份)、B71-R03 (可撤销短链与强制 AI 标识)
 */

export interface PlatformLoginResult {
  platform: 'mp-xhs' | 'mp-weixin' | 'h5';
  code: string;
  anonymousHint: string;
}

export async function performPlatformLogin(): Promise<PlatformLoginResult> {
  // #ifdef MP-XHS
  return new Promise((resolve) => {
    uni.login({
      success: (res) => {
        resolve({
          platform: 'mp-xhs',
          code: res.code || `xhs_code_${Date.now()}`,
          anonymousHint: '小红书授权会话（服务端映射独立 Actor，不直接暴露 openid）',
        });
      },
      fail: () => {
        resolve({
          platform: 'mp-xhs',
          code: `xhs_sandbox_${Date.now()}`,
          anonymousHint: '小红书本地沙箱会话',
        });
      },
    });
  });
  // #endif

  // #ifdef MP-WEIXIN
  return new Promise((resolve) => {
    uni.login({
      success: (res) => {
        resolve({
          platform: 'mp-weixin',
          code: res.code || `wx_code_${Date.now()}`,
          anonymousHint: '微信授权会话（服务端映射独立 Actor）',
        });
      },
      fail: () => {
        resolve({
          platform: 'mp-weixin',
          code: `wx_sandbox_${Date.now()}`,
          anonymousHint: '微信本地沙箱会话',
        });
      },
    });
  });
  // #endif

  // #ifndef MP-XHS || MP-WEIXIN
  return {
    platform: 'h5',
    code: `h5_guest_${Date.now()}`,
    anonymousHint: 'Web H5 降级访客会话 (B70-R04)',
  };
  // #endif
}

export interface XhsSharePayload {
  title: string;
  path: string;
  shareUrl: string;
  provenanceId: string;
}

/**
 * 构造带有强制 AI 艺术示意标识与可撤销短链的小红书分享卡片配置 (B71-R03)
 */
export function buildCompliantShareConfig(payload: XhsSharePayload) {
  const enforcedTitle = payload.title.includes('AI')
    ? payload.title
    : `【AI艺术示意】${payload.title}`;
  return {
    title: enforcedTitle,
    path: `${payload.path}?share_url=${encodeURIComponent(payload.shareUrl)}&prov=${encodeURIComponent(payload.provenanceId)}&ai_label=1`,
  };
}
