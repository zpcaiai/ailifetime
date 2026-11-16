import type { PhotoRequest } from './real-photo-upload';

export const PHOTO_CONSENT_VERSION = 'age-transformation-consent-v1';
export const PHOTO_CONSENT_TEXT = '用途=AI年龄主题艺术创作;声明=非真实未来预测且持续显示AI标识;范围=本次授权参与者的构图与生成;保留=原始上传会话最长24小时;撤回=可在账户内撤回并停止后续处理';

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const purchasePattern = /^photo-[a-f0-9]{64}$/;

export interface PhotoPurchase {
  purchaseId: string;
  amountMinor: number;
  state: string;
  paymentState: string;
  readyCount: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PHOTO_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}

function purchase(response: unknown, expectedId?: string): PhotoPurchase {
  const data = object(object(response).data);
  if (data.schemaVersion !== 'ltm.photo-purchase.v1' || data.sku !== 'selected-age' || data.currency !== 'CNY' ||
      typeof data.purchaseId !== 'string' || !purchasePattern.test(data.purchaseId) ||
      (expectedId && data.purchaseId !== expectedId) || typeof data.amountMinor !== 'number' ||
      !Number.isSafeInteger(data.amountMinor) || data.amountMinor < 1 ||
      typeof data.state !== 'string' || typeof data.paymentState !== 'string' ||
      (data.readyCount !== 0 && data.readyCount !== 1)) {
    throw new Error('PHOTO_PURCHASE_INVALID');
  }
  return { purchaseId: data.purchaseId, amountMinor: data.amountMinor, state: data.state,
    paymentState: data.paymentState, readyCount: data.readyCount };
}

export async function verifiedPhotoActor(request: PhotoRequest): Promise<string> {
  const session = object(object(await request('/v1/session', { method: 'GET' })).session);
  if (session.authenticationState !== 'server_verified' || session.purpose !== 'age_transformation' ||
      !Array.isArray(session.roles) || !session.roles.includes('consumer') ||
      typeof session.actorId !== 'string' || !identifier.test(session.actorId)) {
    throw new Error('PHOTO_PRINCIPAL_INVALID');
  }
  return session.actorId;
}

export async function createXhsPhotoPurchase(
  request: PhotoRequest,
  input: { assetId: string; actorId: string; currentAge: number; targetAge: number },
  key: string,
  isCurrent: () => boolean,
): Promise<PhotoPurchase> {
  const { assetId, actorId, currentAge, targetAge } = input;
  if (!identifier.test(assetId) || !identifier.test(actorId) || !Number.isInteger(currentAge) ||
      currentAge < 18 || currentAge > 100 || !Number.isInteger(targetAge) || targetAge < 0 || targetAge > 100) {
    throw new Error('PHOTO_INPUT_INVALID');
  }
  const post = (path: string, action: string, body: unknown) => {
    if (!isCurrent()) throw new Error('PHOTO_OPERATION_CANCELLED');
    return request(path, { headers: { 'Idempotency-Key': `${key}-${action}` }, body });
  };
  const templateId = 'timeline-classic-v1';
  await post('/v1/commands', 'consent', { command: 'consent.grant', input: {
    id: `${key}-consent`, participantId: actorId, grantorCapacity: 'self', purpose: 'age_transformation',
    scope: { resource: `media.asset:${assetId}`, actions: ['ingest', 'transform'] },
    policyVersion: PHOTO_CONSENT_VERSION,
  } });
  const intake = await post('/v1/capabilities/B07', 'intake', { assetId, participantIds: [actorId] });
  if (object(object(intake).data).state !== 'persisted') throw new Error('PHOTO_INTAKE_NOT_ACCEPTED');
  await post('/v1/capabilities/B08', 'draft', {
    draftId: `${key}-draft`, sourceAssetId: assetId, templateId, participantIds: [actorId], targetAges: [targetAge],
    composition: { sourceAssetIds: [assetId], layout: 'timeline' }, illustrativeLabel: true,
  });
  return purchase(await post('/v1/photo-purchases', 'purchase', { sku: 'selected-age', generation: {
    sourceAssetId: assetId, templateId, participantIds: [actorId], targetAges: [targetAge], currentAge,
    timelineProfile: 'single-age-v1', seed: `${key}-seed`, promptPolicyVersion: 'age-policy-v1', illustrativeLabel: true,
  } }));
}

export async function refreshXhsPhotoPurchase(request: PhotoRequest, purchaseId: string): Promise<PhotoPurchase> {
  if (!purchasePattern.test(purchaseId)) throw new Error('PHOTO_PURCHASE_INVALID');
  return purchase(await request(`/v1/photo-purchases/${purchaseId}`, { method: 'GET' }), purchaseId);
}

export async function fulfillXhsPhotoPurchase(request: PhotoRequest, purchaseId: string): Promise<PhotoPurchase> {
  const current = await refreshXhsPhotoPurchase(request, purchaseId);
  if (current.paymentState !== 'paid') throw new Error('PHOTO_PAYMENT_NOT_CONFIRMED');
  return purchase(await request(`/v1/photo-purchases/${purchaseId}/fulfill`, {
    body: {}, headers: { 'Idempotency-Key': `${purchaseId}-fulfill` },
  }), purchaseId);
}
