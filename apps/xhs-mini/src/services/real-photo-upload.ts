export type PhotoRequest = (path: string, options?: {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
}) => Promise<unknown>;

// The shared upload contract allows a short final part. Keep this single-part
// request within the deployed Vercel ingress limit, including on mobile.
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const sha256 = /^[a-f0-9]{64}$/;
type Call<Options, Result> = (options: Options & {
  success: (result: Result) => void;
  fail: () => void;
}) => void;

interface FileSystem {
  getFileInfo: Call<{ filePath: string; digestAlgorithm: 'sha256' }, { size: number; digest: string }>;
  readFile: Call<{ filePath: string; position: number; length: number }, { data: ArrayBuffer }>;
}
interface PhotoPlatform {
  chooseImage: Call<{ count: number; sourceType: string[] }, { tempFilePaths: string[] }>;
  compressImage: Call<{ src: string; quality: number; compressedWidth: number }, { tempFilePath: string }>;
  getImageInfo: Call<{ src: string }, { type: string; width: number; height: number }>;
  getFileSystemManager: () => FileSystem;
}
declare const xhs: Partial<PhotoPlatform> | undefined;

function call<Options, Result>(fn: Call<Options, Result>, options: Options): Promise<Result> {
  return new Promise((resolve, reject) => fn({
    ...options, success: resolve, fail: () => reject(new Error('PHOTO_NATIVE_OPERATION_FAILED')),
  }));
}

function live(isCurrent: () => boolean) {
  if (!isCurrent()) throw new Error('PHOTO_UPLOAD_CANCELLED');
}

export async function chooseAndUploadXhsPhoto(
  request: PhotoRequest,
  operationKey: string,
  isCurrent: () => boolean,
): Promise<{ assetId: string }> {
  live(isCurrent);
  if (typeof xhs === 'undefined' || !xhs?.chooseImage || !xhs.compressImage ||
      !xhs.getImageInfo || !xhs.getFileSystemManager) throw new Error('XHS_PHOTO_UNAVAILABLE');
  const fs = xhs.getFileSystemManager();
  if (!fs?.getFileInfo || !fs.readFile) throw new Error('XHS_PHOTO_UNAVAILABLE');
  const picked = await call(xhs.chooseImage.bind(xhs), { count: 1, sourceType: ['album'] });
  live(isCurrent);
  const selected = picked?.tempFilePaths?.[0];
  if (typeof selected !== 'string' || !selected) throw new Error('PHOTO_SOURCE_INVALID');
  const compressed = await call(xhs.compressImage.bind(xhs), { src: selected, quality: 88, compressedWidth: 2048 });
  live(isCurrent);
  const filePath = compressed?.tempFilePath;
  if (typeof filePath !== 'string' || !filePath) throw new Error('PHOTO_SOURCE_INVALID');
  const [info, file] = await Promise.all([
    call(xhs.getImageInfo.bind(xhs), { src: filePath }),
    call(fs.getFileInfo.bind(fs), { filePath, digestAlgorithm: 'sha256' as const }),
  ]);
  if (!['jpeg', 'jpg'].includes(info?.type?.toLowerCase()) ||
      !Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width < 512 || info.height < 512) {
    throw new Error('PHOTO_JPEG_RESOLUTION_INVALID');
  }
  const digest = file?.digest?.toLowerCase();
  if (!Number.isSafeInteger(file?.size) || file.size < 4 || file.size > MAX_PHOTO_BYTES ||
      typeof digest !== 'string' || !sha256.test(digest)) {
    throw new Error('PHOTO_SIZE_OR_DIGEST_INVALID');
  }
  live(isCurrent);
  const read = await call(fs.readFile.bind(fs), { filePath, position: 0, length: file.size });
  const length = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get?.call(read?.data);
  if (length !== file.size) throw new Error('PHOTO_READ_LENGTH_INVALID');
  const view = new Uint8Array(read.data);
  if (view[0] !== 0xff || view[1] !== 0xd8 || view[2] !== 0xff) throw new Error('PHOTO_JPEG_RESOLUTION_INVALID');
  live(isCurrent);

  const created = await request('/v1/uploads', {
    headers: { 'Idempotency-Key': operationKey },
    body: { fileSize: file.size, fileDigest: digest, digestAlgorithm: 'sha256', contentType: 'image/jpeg',
      clientRequestId: operationKey },
  }) as { uploadId?: string; nextOffset?: number; chunkBytes?: number } | null;
  if (typeof created?.uploadId !== 'string' || !id.test(created.uploadId)) throw new Error('PHOTO_UPLOAD_SESSION_INVALID');
  const uploadId = created.uploadId;
  const path = `/v1/uploads/${encodeURIComponent(uploadId)}`;
  try {
    live(isCurrent);
    if ((created.nextOffset !== 0 && created.nextOffset !== file.size) ||
        !Number.isSafeInteger(created.chunkBytes) || (created.chunkBytes ?? 0) < file.size) {
      throw new Error('PHOTO_UPLOAD_SESSION_INVALID');
    }
    if (created.nextOffset === 0) {
      const appended = await request(`${path}/chunks`, {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes 0-${file.size - 1}/${file.size}`,
          'X-Chunk-Sha256': digest, 'Idempotency-Key': `${operationKey}-chunk` },
        body: read.data,
      }) as { nextOffset?: number } | null;
      if (appended?.nextOffset !== file.size) throw new Error('PHOTO_UPLOAD_OFFSET_INVALID');
    }
    live(isCurrent);
    const result = await request(`${path}/complete`, {
      headers: { 'Idempotency-Key': `${operationKey}-complete` },
      body: { fileDigest: digest, digestAlgorithm: 'sha256' },
    }) as { uploadId?: string; assetId?: string; state?: string } | null;
    if (result?.uploadId !== uploadId || result.state !== 'available' ||
        typeof result.assetId !== 'string' || !id.test(result.assetId)) {
      throw new Error('PHOTO_UPLOAD_RESULT_INVALID');
    }
    live(isCurrent);
    return { assetId: result.assetId };
  } catch (error) {
    await request(`${path}/cancel`, {
      headers: { 'Idempotency-Key': `${operationKey}-cancel` }, body: {},
    }).catch(() => undefined);
    throw error;
  }
}
