/**
 * 小红书小程序 (MP-XHS) 与多端条件编译适配层
 * 遵循 B70-R01 (不把 openid 当作跨主体身份)、B71-R03 (可撤销短链与强制 AI 标识)
 */
import type { MiniProgramSession, MiniProgramSessionExchangeRequest, Order } from '@ailifetime/contracts';

interface XhsNativeOrderInfo {
  orderId: string;
  payToken: string;
  payMethod: 'third';
  wxUrl?: string;
  zfbUrl?: string;
}

declare const xhs: {
  requestOrderPayment?: (options: {
    orderInfo: XhsNativeOrderInfo;
    success: (result?: { success?: boolean }) => void;
    fail: (result?: { errMsg?: string }) => void;
  }) => void;
} | undefined;

export type XhsCashierOutcome = 'returned' | 'cancelled' | 'unknown';

let cashierInFlight = false;

export function isXhsOrderId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
}

function validPayUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096 || /[^\x21-\x7e]|\\/.test(value)) return false;
  const match = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?:[/?#]|$)/i.exec(value);
  return Boolean(match && !/\.(?:localhost|local|test|example|invalid)$/i.test(match[1]));
}

export async function requestXhsCustomPayment(order: Order): Promise<XhsCashierOutcome> {
  const checkout = order.xhs_custom_checkout;
  const now = Math.floor(Date.now() / 1000);
  if (order.state !== 'awaiting-payment' || !checkout || !isXhsOrderId(order.id) ||
      checkout.order_id !== order.id || !isXhsOrderId(checkout.provider_order_id) ||
      !Number.isSafeInteger(order.amount_minor) || order.amount_minor <= 0 ||
      order.currency !== 'CNY' || checkout.currency !== order.currency ||
      checkout.amount_minor !== order.amount_minor ||
      !Number.isSafeInteger(checkout.expires_at_unix) || checkout.expires_at_unix <= now ||
      typeof checkout.pay_token !== 'string' || !/^[!-~]{1,2048}$/.test(checkout.pay_token) ||
      (checkout.wx_url === undefined && checkout.zfb_url === undefined) ||
      (checkout.wx_url !== undefined && !validPayUrl(checkout.wx_url)) ||
      (checkout.zfb_url !== undefined && !validPayUrl(checkout.zfb_url))) {
    throw new Error('XHS_CHECKOUT_INVALID');
  }
  if (typeof xhs === 'undefined' || typeof xhs?.requestOrderPayment !== 'function') {
    throw new Error('XHS_CASHIER_UNAVAILABLE');
  }
  if (cashierInFlight) throw new Error('XHS_CASHIER_BUSY');
  const platform = xhs;
  const requestPayment = xhs.requestOrderPayment;
  cashierInFlight = true;
  try {
    return await new Promise<XhsCashierOutcome>((resolve) => {
      const finish = (outcome: XhsCashierOutcome) => {
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => finish('unknown'), 180_000);
      try {
        requestPayment.call(platform, {
          orderInfo: {
            orderId: checkout.provider_order_id,
            payToken: checkout.pay_token,
            payMethod: 'third',
            ...(checkout.wx_url ? { wxUrl: checkout.wx_url } : {}),
            ...(checkout.zfb_url ? { zfbUrl: checkout.zfb_url } : {}),
          },
          success: (result) => finish(result?.success === true ? 'returned' : 'unknown'),
          fail: (result) => finish(/\bcancel(?:led|ed)?\b/i.test(result?.errMsg ?? '') ? 'cancelled' : 'unknown'),
        });
      } catch {
        finish('unknown');
      }
    });
  } finally {
    cashierInFlight = false;
  }
}

export interface PlatformLoginResult {
  platform: 'mp-xhs' | 'mp-weixin';
  code: string;
}

export async function performPlatformLogin(): Promise<PlatformLoginResult | null> {
  let platform: PlatformLoginResult['platform'] | null = null;
  // #ifdef MP-XHS
  platform = 'mp-xhs';
  // #endif
  // #ifdef MP-WEIXIN
  platform = 'mp-weixin';
  // #endif
  if (platform === null) return null;
  const channel = platform;
  return new Promise((resolve, reject) => {
    uni.login({
      success: ({ code }) => {
        if (typeof code !== 'string' || !/^[!-~]{1,512}$/.test(code)) {
          reject(new Error('PLATFORM_LOGIN_CODE_INVALID'));
          return;
        }
        resolve({ platform: channel, code });
      },
      fail: () => reject(new Error('PLATFORM_LOGIN_FAILED')),
    });
  });
}

let sessionExchange: Promise<MiniProgramSession | null> | null = null;

export async function exchangePlatformSession(
  exchange: (request: MiniProgramSessionExchangeRequest) => Promise<MiniProgramSession>,
): Promise<MiniProgramSession | null> {
  if (sessionExchange) return sessionExchange;
  sessionExchange = (async () => {
    const login = await performPlatformLogin();
    if (!login) return null;
    const session = await exchange({ platform: login.platform, js_code: login.code });
    if (session?.platform !== login.platform || typeof session.access_token !== 'string' ||
        !/^[!-~]{20,4096}$/.test(session.access_token) || !(Date.parse(session.expires_at) > Date.now())) {
      throw new Error('MINI_PROGRAM_SESSION_INVALID');
    }
    return session;
  })();
  try {
    return await sessionExchange;
  } finally {
    sessionExchange = null;
  }
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
  const enforcedTitle = payload.title.startsWith('【AI艺术示意】')
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
      authorized: false,
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
