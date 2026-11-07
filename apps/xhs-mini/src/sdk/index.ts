import type {
  CheckoutRequest,
  CheckoutSession,
  ConsentReceipt,
  ConsentRequest,
  FutureSelfMessage,
  FutureSelfMessageRequest,
  GenerationJob,
  GenerationJobRequest,
  GuestSession,
  MiniProgramSession,
  MiniProgramSessionExchangeRequest,
  Order,
  PortraitTemplateSpec,
  Project,
  ProjectRequest,
  RightsCase,
  RightsRequest,
  Share,
  ShareRequest,
  UploadSession,
  UploadSessionRequest,
  XhsNoteMountCard,
  XhsNoteMountRequest,
} from '@ailifetime/contracts';

export interface HttpTransportRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export type HttpTransport = <T>(req: HttpTransportRequest) => Promise<T>;

export interface AiLifeTimeClientOptions {
  baseUrl: string;
  getAccessToken?: () => string | null | undefined;
  transport: HttpTransport;
}

/**
 * Generate a deterministic-format or random Idempotency-Key (16-128 chars per OpenAPI spec).
 */
export function createIdempotencyKey(prefix = 'xhs'): string {
  const randomPart = Array.from({ length: 24 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
  return `${prefix}-${Date.now()}-${randomPart}`;
}

export class AiLifeTimeClient {
  private readonly options: AiLifeTimeClientOptions;

  constructor(options: AiLifeTimeClientOptions) {
    this.options = options;
  }

  private buildHeaders(idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Request-Id': createIdempotencyKey('req'),
    };
    const token = this.options.getAccessToken?.();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (idempotencyKey) {
      if (idempotencyKey.length < 16 || idempotencyKey.length > 128) {
        throw new Error('Idempotency-Key must be between 16 and 128 characters');
      }
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return headers;
  }

  createGuestSession(idempotencyKey = createIdempotencyKey('guest')): Promise<GuestSession> {
    return this.options.transport<GuestSession>({
      method: 'POST',
      path: `${this.options.baseUrl}/v1/guest-sessions`,
      headers: this.buildHeaders(idempotencyKey),
    });
  }

  exchangeMiniProgramSession(
    payload: MiniProgramSessionExchangeRequest,
    idempotencyKey = createIdempotencyKey('mpsess')
  ): Promise<MiniProgramSession> {
    return this.options.transport<MiniProgramSession>({
      method: 'POST',
      path: `${this.options.baseUrl}/v1/mini-program/sessions`,
      headers: this.buildHeaders(idempotencyKey),
      body: payload,
    });
  }

  createXhsNoteMount(
    payload: XhsNoteMountRequest,
    idempotencyKey = createIdempotencyKey('xhsmount')
  ): Promise<XhsNoteMountCard> {
    return this.options.transport<XhsNoteMountCard>({
      method: 'POST',
      path: `${this.options.baseUrl}/v1/xhs/note-mounts`,
      headers: this.buildHeaders(idempotencyKey),
      body: payload,
    });
  }

  createUploadSession(
    payload: UploadSessionRequest,
    idempotencyKey = createIdempotencyKey('upload')
  ): Promise<UploadSession> {
    return this.options.transport<UploadSession>({
      method: 'POST',
      path: `${this.options.baseUrl}/v1/upload-sessions`,
      headers: this.buildHeaders(idempotencyKey),
      body: payload,
    });
  }

  grantConsent(
    payload: ConsentRequest,
    idempotencyKey = createIdempotencyKey('consent')
  ): Promise<ConsentReceipt> {
    return this.options.transport<ConsentReceipt>({
      method: 'POST',
      path: `${this.options.baseUrl}/v1/consents`,
      headers: this.buildHeaders(idempotencyKey),
      body: payload,
    });
  }

  createProject(
    payload: ProjectRequest,
    idempotencyKey = createIdempotencyKey('project')
  ): Promise<Project> {
    return this.options.transport<Project>({
      method: 'POST',
      path: `${this.options.baseUrl}/v1/projects`,
      headers: this.buildHeaders(idempotencyKey),
      body: payload,
    });
  }

  listTemplates(): Promise<PortraitTemplateSpec[]> {
    return this.options.transport<PortraitTemplateSpec[]>({
      method: 'GET',
      path: `${this.options.baseUrl}/v1/templates`,
      headers: this.buildHeaders(),
    });
  }

  getTemplate(templateId: string): Promise<PortraitTemplateSpec> {
    return this.options.transport<PortraitTemplateSpec>({
      method: 'GET',
      path: `${this.options.baseUrl}/v1/templates/${encodeURIComponent(templateId)}`,
      headers: this.buildHeaders(),
    });
  }

  startGenerationJob(
    payload: GenerationJobRequest,
    idempotencyKey = createIdempotencyKey('genjob')
  ): Promise<GenerationJob> {
    return this.options.transport<GenerationJob>({
      method: 'POST',
      path: `${this.options.baseUrl}/v1/generation-jobs`,
      headers: this.buildHeaders(idempotencyKey),
      body: payload,
    });
  }

  getGenerationJob(jobId: string): Promise<GenerationJob> {
    return this.options.transport<GenerationJob>({
      method: 'GET',
      path: `${this.options.baseUrl}/v1/generation-jobs/${encodeURIComponent(jobId)}`,
      headers: this.buildHeaders(),
    });
  }

  cancelGenerationJob(
    jobId: string,
    idempotencyKey = createIdempotencyKey('cancel')
  ): Promise<GenerationJob> {
    return this.options.transport<GenerationJob>({
      method: 'POST',
      path: `${this.options.baseUrl}/v1/generation-jobs/${encodeURIComponent(jobId)}/cancel`,
      headers: this.buildHeaders(idempotencyKey),
    });
  }

  createShare(
    payload: ShareRequest,
    idempotencyKey = createIdempotencyKey('share')
  ): Promise<Share> {
    return this.options.transport<Share>({
      method: 'POST',
      path: `${this.options.baseUrl}/v1/shares`,
      headers: this.buildHeaders(idempotencyKey),
      body: payload,
    });
  }

  revokeShare(shareId: string): Promise<void> {
    return this.options.transport<void>({
      method: 'DELETE',
      path: `${this.options.baseUrl}/v1/shares/${encodeURIComponent(shareId)}`,
      headers: this.buildHeaders(),
    });
  }

  createCheckoutSession(
    payload: CheckoutRequest,
    idempotencyKey = createIdempotencyKey('checkout')
  ): Promise<CheckoutSession> {
    return this.options.transport<CheckoutSession>({
      method: 'POST',
      path: `${this.options.baseUrl}/v1/checkout-sessions`,
      headers: this.buildHeaders(idempotencyKey),
      body: payload,
    });
  }

  getOrder(orderId: string): Promise<Order> {
    return this.options.transport<Order>({
      method: 'GET',
      path: `${this.options.baseUrl}/v1/orders/${encodeURIComponent(orderId)}`,
      headers: this.buildHeaders(),
    });
  }

  sendFutureSelfMessage(
    payload: FutureSelfMessageRequest,
    idempotencyKey = createIdempotencyKey('future')
  ): Promise<FutureSelfMessage> {
    return this.options.transport<FutureSelfMessage>({
      method: 'POST',
      path: `${this.options.baseUrl}/v1/future-self/messages`,
      headers: this.buildHeaders(idempotencyKey),
      body: payload,
    });
  }

  submitRightsRequest(
    payload: RightsRequest,
    idempotencyKey = createIdempotencyKey('rights')
  ): Promise<RightsCase> {
    return this.options.transport<RightsCase>({
      method: 'POST',
      path: `${this.options.baseUrl}/v1/data-rights/requests`,
      headers: this.buildHeaders(idempotencyKey),
      body: payload,
    });
  }
}
