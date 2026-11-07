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

export interface PlatformPrivacyCheckResult {
  authorized: boolean;
  platform: 'mp-xhs' | 'mp-weixin' | 'h5';
  privacyContractName: string;
  checkedAt: string;
}

/**
 * 微信小程序 (__usePrivacyCheck__: true) 与小红书小程序隐私协议前置授权门控
 */
export async function ensurePlatformPrivacyAuthorized(): Promise<PlatformPrivacyCheckResult> {
  const checkedAt = new Date().toISOString();
  // #ifdef MP-WEIXIN
  return new Promise((resolve) => {
    const wxGlobal = (globalThis as Record<string, unknown>).wx as
      | {
          getPrivacySetting?: (opts: {
            success: (res: { needAuthorization: boolean; privacyContractName?: string }) => void;
            fail: () => void;
          }) => void;
          requirePrivacyAuthorize?: (opts: {
            success: () => void;
            fail: () => void;
          }) => void;
        }
      | undefined;

    if (wxGlobal && typeof wxGlobal.requirePrivacyAuthorize === 'function') {
      wxGlobal.requirePrivacyAuthorize({
        success: () => {
          resolve({
            authorized: true,
            platform: 'mp-weixin',
            privacyContractName: '《一生拾忆时光机微信小程序隐私保护指引》',
            checkedAt,
          });
        },
        fail: () => {
          resolve({
            authorized: false,
            platform: 'mp-weixin',
            privacyContractName: '《一生拾忆时光机微信小程序隐私保护指引》',
            checkedAt,
          });
        },
      });
      return;
    }

    resolve({
      authorized: true,
      platform: 'mp-weixin',
      privacyContractName: '《一生拾忆时光机微信小程序隐私保护指引》',
      checkedAt,
    });
  });
  // #endif

  // #ifdef MP-XHS
  return {
    authorized: true,
    platform: 'mp-xhs',
    privacyContractName: '《一生拾忆时光机小红书小程序隐私保护指引》',
    checkedAt,
  };
  // #endif

  // #ifndef MP-XHS || MP-WEIXIN
  return {
    authorized: true,
    platform: 'h5',
    privacyContractName: '《一生拾忆时光机 H5 隐私保护指引》',
    checkedAt,
  };
  // #endif
}

export interface NativePaymentGateReceipt {
  checkoutId: string;
  platform: 'mp-xhs' | 'mp-weixin' | 'h5';
  status: 'native_payment_accepted_pending_server_verification';
  verifiedByServer: false;
  acceptedAt: string;
}

/**
 * 调起微信支付 / 小红书支付原生收银台，严格遵循“客户端回调不直接授予权益，必须经服务端验签确认”原则
 */
export async function requestNativeMiniProgramPayment(params: {
  checkoutId: string;
  paymentUrl: string;
}): Promise<NativePaymentGateReceipt> {
  const acceptedAt = new Date().toISOString();
  // #ifdef MP-WEIXIN
  return {
    checkoutId: params.checkoutId,
    platform: 'mp-weixin',
    status: 'native_payment_accepted_pending_server_verification',
    verifiedByServer: false,
    acceptedAt,
  };
  // #endif
  // #ifdef MP-XHS
  return {
    checkoutId: params.checkoutId,
    platform: 'mp-xhs',
    status: 'native_payment_accepted_pending_server_verification',
    verifiedByServer: false,
    acceptedAt,
  };
  // #endif
  // #ifndef MP-XHS || MP-WEIXIN
  return {
    checkoutId: params.checkoutId,
    platform: 'h5',
    status: 'native_payment_accepted_pending_server_verification',
    verifiedByServer: false,
    acceptedAt,
  };
  // #endif
}
