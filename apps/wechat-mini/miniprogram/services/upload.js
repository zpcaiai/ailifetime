const api = require("./api");
const { createSha256 } = require("./sha256");

// Five MiB is the minimum non-final multipart part size used by production object stores.
const CHUNK_BYTES = 5 * 1024 * 1024;
const MAX_BYTES = 25 * 1024 * 1024;

async function preflight(path) {
  const [info, file] = await Promise.all([imageInfo(path), fileStat(path)]);
  if (!new Set(["jpeg", "jpg"]).has(String(info.type).toLowerCase())) throw new Error("SANITIZED_MEDIA_MUST_BE_JPEG");
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_BYTES) throw new Error("MEDIA_SIZE_INVALID");
  if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 512 || info.height < 512) {
    throw new Error("MEDIA_RESOLUTION_TOO_LOW");
  }
  const digest = await fileSha256(path, file.size);
  return { path, width: info.width, height: info.height, size: file.size, digest, digestAlgorithm: "sha256" };
}

async function sanitize(path) {
  const result = await call(wx.compressImage, { src: path, quality: 95, compressedWidth: 4096, compressedHeight: 4096 });
  return result.tempFilePath;
}

async function resumableUpload(file, onProgress, signal = { cancelled: false }) {
  const created = await api.requestForPurpose("/v1/uploads", "age_transformation", {
    data: {
      fileSize: file.size,
      fileDigest: file.digest,
      digestAlgorithm: file.digestAlgorithm,
      contentType: "image/jpeg",
      clientRequestId: api.idempotencyKey("wechat-upload"),
    },
    headers: { "Idempotency-Key": api.idempotencyKey("upload-create") },
  });
  if (!created || typeof created.uploadId !== "string" || !Number.isSafeInteger(created.nextOffset)) throw new Error("UPLOAD_SESSION_INVALID");
  let offset = created.nextOffset;
  const filesystem = wx.getFileSystemManager();
  while (offset < file.size) {
    if (signal.cancelled) {
      await api.requestForPurpose(`/v1/uploads/${encodeURIComponent(created.uploadId)}/cancel`, "age_transformation", { data: {}, headers: { "Idempotency-Key": api.idempotencyKey("upload-cancel") } });
      throw new Error("UPLOAD_CANCELLED");
    }
    const length = Math.min(CHUNK_BYTES, file.size - offset);
    const bytes = await readChunk(filesystem, file.path, offset, length);
    const result = await api.requestForPurpose(`/v1/uploads/${encodeURIComponent(created.uploadId)}/chunks`, "age_transformation", {
      data: wx.arrayBufferToBase64(bytes),
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Range": `bytes ${offset}-${offset + length - 1}/${file.size}`,
        "Idempotency-Key": `${created.uploadId}-${offset}`,
      },
      timeout: 30000,
    });
    if (!result || result.nextOffset !== offset + length) throw new Error("UPLOAD_OFFSET_MISMATCH");
    offset = result.nextOffset;
    onProgress(Math.floor(offset * 100 / file.size));
  }
  return api.requestForPurpose(`/v1/uploads/${encodeURIComponent(created.uploadId)}/complete`, "age_transformation", {
    data: { fileDigest: file.digest, digestAlgorithm: file.digestAlgorithm },
    headers: { "Idempotency-Key": `${created.uploadId}-complete` },
  });
}

function imageInfo(src) { return call(wx.getImageInfo, { src }); }
function fileStat(path) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().stat({
    path,
    success: (value) => {
      const size = value && value.stats && value.stats.size;
      if (!Number.isSafeInteger(size)) reject(new Error("MEDIA_STAT_INVALID"));
      else resolve({ size });
    },
    fail: () => reject(new Error("MEDIA_STAT_FAILED")),
  }));
}
async function fileSha256(path, size) {
  const filesystem = wx.getFileSystemManager();
  const hasher = createSha256();
  let position = 0;
  while (position < size) {
    const length = Math.min(CHUNK_BYTES, size - position);
    const bytes = await readChunk(filesystem, path, position, length);
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== length) throw new Error("MEDIA_READ_LENGTH_MISMATCH");
    hasher.update(bytes);
    position += length;
  }
  return hasher.digestHex();
}
function call(fn, options) { return new Promise((resolve, reject) => fn({ ...options, success: resolve, fail: () => reject(new Error("MEDIA_OPERATION_FAILED")) })); }
function readChunk(filesystem, filePath, position, length) { return new Promise((resolve, reject) => filesystem.readFile({ filePath, position, length, success: (value) => resolve(value.data), fail: () => reject(new Error("MEDIA_READ_FAILED")) })); }

module.exports = { preflight, sanitize, resumableUpload, CHUNK_BYTES, MAX_BYTES };
