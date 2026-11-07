import {
  AiLifeTimeClient,
  createIdempotencyKey,
  type HttpTransportRequest,
} from '@ailifetime/sdk-ts';
import type {
  CheckoutSession,
  ConsentReceipt,
  FutureSelfMessage,
  GenerationJob,
  GuestSession,
  MiniProgramSession,
  Order,
  Project,
  RightsCase,
  Share,
  UploadSession,
  XhsNoteMountCard,
  XhsNoteMountRequest,
} from '@ailifetime/contracts';

const DEFAULT_API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || 'https://api.sandbox.ailifetime.local';
const IS_SANDBOX_MODE = import.meta.env.VITE_SANDBOX_MODE !== 'false';

// Ephemeral in-memory signed URL registry (purged on page/app hide per B70-R03)
const ephemeralPreviewRegistry = new Set<string>();
const sandboxShares = new Map<string, Share>();
const sandboxOrders = new Map<string, Order>();
let currentAccessToken: string | null = null;
let latestShareId = 'shr_xhs_latest';
let latestOrderId = 'ord_xhs_latest';

export function registerEphemeralPreviewUrl(url: string): void {
  ephemeralPreviewRegistry.add(url);
}

export function purgeEphemeralMediaCache(): void {
  ephemeralPreviewRegistry.clear();
}

export function getEphemeralPreviewCount(): number {
  return ephemeralPreviewRegistry.size;
}

export function setAccessToken(token: string | null): void {
  currentAccessToken = token;
}

export function getLatestShareId(): string {
  return latestShareId;
}

export function getLatestOrderId(): string {
  return latestOrderId;
}

export function getTrackedShare(shareId: string): Share | undefined {
  return sandboxShares.get(shareId);
}

export function getCurrentPlatformChannel(): 'mp-xhs' | 'mp-weixin' | 'h5' {
  // #ifdef MP-XHS
  return 'mp-xhs';
  // #endif
  // #ifdef MP-WEIXIN
  return 'mp-weixin';
  // #endif
  // #ifndef MP-XHS || MP-WEIXIN
  return 'h5';
  // #endif
}

/**
 * Deterministic local sandbox responder when running offline in Xiaohongshu DevTools
 */
function resolveSandboxResponse<T>(req: HttpTransportRequest): T {
  const now = new Date();
  const inOneHour = new Date(now.getTime() + 3600 * 1000).toISOString();

  if (req.path.endsWith('/v1/guest-sessions') && req.method === 'POST') {
    const res: GuestSession = {
      id: `guest_xhs_${Date.now()}`,
      expires_at: inOneHour,
      consent_preflight_version: '2026.11-cn-xhs',
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/mini-program/sessions') && req.method === 'POST') {
    const body = (req.body || {}) as { platform?: 'mp-xhs' | 'mp-weixin' };
    const platform = body.platform || 'mp-xhs';
    const token = `st_sandbox_${Date.now()}`;
    setAccessToken(token);
    const res: MiniProgramSession = {
      session_id: `mps_${Date.now()}`,
      actor_pseudonym: `act_${platform.replace('-', '_')}_${Date.now().toString(16)}`,
      platform,
      access_token: token,
      expires_at: inOneHour,
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/xhs/note-mounts') && req.method === 'POST') {
    const body = (req.body || {}) as XhsNoteMountRequest;
    if (body.contains_minor) {
      throw new Error('MINOR_PUBLIC_MOUNT_FORBIDDEN: 未成年人出镜作品禁止公开挂载至小红书笔记');
    }
    const targetShareId = body.share_id || latestShareId;
    const tracked = sandboxShares.get(targetShareId);
    if (tracked && tracked.status !== 'active') {
      throw new Error(`SHARE_NOT_ACTIVE: 分享链接状态为 ${tracked.status}，无法生成挂载卡片`);
    }
    const rawTitle = (body.title || '0—100岁人生时光胶片').trim();
    const enforcedTitle = rawTitle.includes('AI') ? rawTitle : `【AI艺术示意】${rawTitle}`;
    const mountId = `mnt_${Date.now()}`;
    const res: XhsNoteMountCard = {
      mount_id: mountId,
      share_id: targetShareId,
      xhs_path: `/pages/index/index?share_id=${encodeURIComponent(targetShareId)}&mount_id=${mountId}&ai_label=1`,
      enforced_title: enforcedTitle,
      ai_watermark_badge: 'AI生成·艺术示意非真实预测',
      topic_tags: body.topic_tags || ['AI人生时光机', '0到100岁的自己'],
      expires_at: tracked?.expires_at || inOneHour,
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/consents') && req.method === 'POST') {
    const res: ConsentReceipt = {
      id: `consent_${Date.now()}`,
      status: 'active',
      evidence_hash: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      granted_at: now.toISOString(),
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/upload-sessions') && req.method === 'POST') {
    const res: UploadSession = {
      id: `upl_${Date.now()}`,
      asset_id: `asset_${Date.now()}`,
      upload_url: 'https://upload.sandbox.ailifetime.local/signed-put',
      expires_at: inOneHour,
      required_headers: {
        'x-amz-server-side-encryption': 'AES256',
      },
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/projects') && req.method === 'POST') {
    const res: Project = {
      id: `proj_${Date.now()}`,
      state: 'ready',
      version: 1,
      policy_summary: {
        ai_label_enforced: true,
        consent_verified: true,
      },
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/generation-jobs') && req.method === 'POST') {
    const jobId = `job_${Date.now()}`;
    const frames = [6, 18, 28, 45, 65, 85].map((age) => {
      const signedUrl = `https://cdn.sandbox.ailifetime.local/preview/${jobId}/age-${age}.webp?sig=shortlived`;
      registerEphemeralPreviewUrl(signedUrl);
      return {
        age,
        label: `${age}岁 · AI艺术化时光示意`,
        signed_preview_url: signedUrl,
        expires_at: inOneHour,
        ai_watermark_text: 'AI生成 · 艺术化示意非真实预测',
      };
    });
    const res: GenerationJob = {
      id: jobId,
      state: 'ready',
      progress: {
        stage: 'completed',
        completed_units: 6,
        total_units: 6,
      },
      result_manifest_url: `https://cdn.sandbox.ailifetime.local/manifests/${jobId}.json`,
      frames,
      error: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    return res as unknown as T;
  }

  if (req.path.includes('/v1/generation-jobs/') && req.method === 'GET') {
    const jobId = req.path.split('/').pop() || 'job_demo';
    const res: GenerationJob = {
      id: jobId,
      state: 'ready',
      progress: {
        stage: 'completed',
        completed_units: 6,
        total_units: 6,
      },
      result_manifest_url: `https://cdn.sandbox.ailifetime.local/manifests/${jobId}.json`,
      error: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/shares') && req.method === 'POST') {
    const shareId = `shr_${Date.now()}`;
    const res: Share = {
      id: shareId,
      url: `https://share.ailifetime.local/s/${shareId}?ai_label=1`,
      status: 'active',
      expires_at: inOneHour,
      provenance_id: `prov_${Date.now()}`,
    };
    sandboxShares.set(shareId, res);
    latestShareId = shareId;
    return res as unknown as T;
  }

  if (req.path.includes('/v1/shares/') && req.method === 'DELETE') {
    const rawId = decodeURIComponent(req.path.split('/').pop() || latestShareId);
    const existing = sandboxShares.get(rawId);
    if (existing) {
      sandboxShares.set(rawId, { ...existing, status: 'revoked' });
    } else {
      sandboxShares.set(rawId, {
        id: rawId,
        url: `https://share.ailifetime.local/s/${rawId}?ai_label=1`,
        status: 'revoked',
        expires_at: inOneHour,
      });
    }
    return undefined as unknown as T;
  }

  if (req.path.endsWith('/v1/checkout-sessions') && req.method === 'POST') {
    const checkoutId = `chk_${Date.now()}`;
    const orderId = `ord_${Date.now()}`;
    const orderRecord: Order = {
      id: orderId,
      state: 'paid',
      items: [{ sku: 'PHOTO_BOOK_HARDCOVER_0_100', title: '0—100岁典藏精装时光相册', quantity: 1 }],
      amount_minor: 9900,
      currency: 'CNY',
      delivery_manifest_url: `https://cdn.sandbox.ailifetime.local/orders/${orderId}.json`,
    };
    sandboxOrders.set(orderId, orderRecord);
    latestOrderId = orderId;
    const res: CheckoutSession = {
      id: checkoutId,
      quote_id: `quo_${Date.now()}`,
      amount_minor: 9900,
      currency: 'CNY',
      payment_url: 'xhs://pay/order?prepay_id=sandbox_prepay_001',
      expires_at: inOneHour,
    };
    return res as unknown as T;
  }

  if (req.path.includes('/v1/orders/') && req.method === 'GET') {
    const orderId = decodeURIComponent(req.path.split('/').pop() || latestOrderId);
    const trackedOrder = sandboxOrders.get(orderId);
    if (trackedOrder) {
      return trackedOrder as unknown as T;
    }
    const res: Order = {
      id: orderId,
      state: 'paid',
      items: [{ sku: 'PHOTO_BOOK_HARDCOVER_0_100', title: '0—100岁典藏精装时光相册', quantity: 1 }],
      amount_minor: 9900,
      currency: 'CNY',
      delivery_manifest_url: `https://cdn.sandbox.ailifetime.local/orders/${orderId}.json`,
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/future-self/messages') && req.method === 'POST') {
    const body = (req.body || {}) as { message?: string };
    const userText = body.message || '';
    const res: FutureSelfMessage = {
      message_id: `msg_${Date.now()}`,
      role_disclosure: '【AI虚拟形象提示】我是基于艺术化想象构建的“未来自我”对话伙伴，不具备现实预测、医疗、心理或理财建议能力。',
      content: `收到你写给未来的心声：“${userText.slice(0, 60)}”。无论岁月如何流转，愿你珍惜当下与家人的每一刻温暖陪伴。`,
      safety_state: 'normal',
      resources: [],
    };
    return res as unknown as T;
  }

  if (req.path.endsWith('/v1/data-rights/requests') && req.method === 'POST') {
    const targetDate = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
    const res: RightsCase = {
      id: `dsr_${Date.now()}`,
      state: 'in-progress',
      submitted_at: now.toISOString(),
      target_at: targetDate,
      receipt_url: `https://privacy.ailifetime.local/receipts/dsr_${Date.now()}.json`,
    };
    return res as unknown as T;
  }

  throw new Error(`Unsupported sandbox route: ${req.method} ${req.path}`);
}

export const apiClient = new AiLifeTimeClient({
  baseUrl: DEFAULT_API_BASE_URL,
  getAccessToken: () => currentAccessToken,
  transport: async <T>(req: HttpTransportRequest): Promise<T> => {
    if (IS_SANDBOX_MODE) {
      return resolveSandboxResponse<T>(req);
    }
    return new Promise<T>((resolve, reject) => {
      uni.request({
        url: req.path,
        method: req.method,
        header: req.headers,
        data: req.body as Record<string, unknown> | undefined,
        timeout: 15000,
        success: (res) => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(res.data as T);
          } else {
            reject(
              new Error(
                `API Error (${res.statusCode}): ${JSON.stringify(res.data || {})}`
              )
            );
          }
        },
        fail: (err) => {
          reject(new Error(err.errMsg || 'Network request failed'));
        },
      });
    });
  },
});

export { createIdempotencyKey };
