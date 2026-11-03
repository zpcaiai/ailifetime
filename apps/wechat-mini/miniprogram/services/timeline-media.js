const api = require("./api");
const session = require("./session");
const privacy = require("./privacy");
const { createSha256 } = require("./sha256");
const files = new Set();
let epoch = 0;

function remove(path) {
  return new Promise((resolve) => wx.getFileSystemManager().unlink({ filePath: path,
    success() { files.delete(path); resolve(true); }, fail() { resolve(false); } }));
}
async function clearAll() { epoch++; await Promise.all([...files].map(remove)); }
function call(fn, input) { return new Promise((resolve, reject) => fn({ ...input, success: resolve, fail: reject })); }
async function download(node) {
  if (!node || node.status !== "ready" || !node.asset || !/^\/v1\/timelines\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/nodes\/\d{1,3}\/image$/.test(node.downloadPath) ||
      !/^[a-f0-9]{64}$/.test(node.asset.sha256) || !Number.isSafeInteger(node.asset.byteLength) || node.asset.byteLength < 1 || node.asset.byteLength > 25 * 1024 * 1024) throw new Error("TIMELINE_IMAGE_UNAVAILABLE");
  const generation = epoch, activeSession = session.requireSession();
  let random;
  try {
    const result = await call(wx.getRandomValues, { length: 16 });
    const size = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get.call(result.randomValues);
    if (size !== 16) throw new Error("INVALID_RANDOM_LENGTH");
    random = new Uint8Array(result.randomValues);
  } catch { throw new Error("TIMELINE_RANDOM_UNAVAILABLE"); }
  if (generation !== epoch || session.requireSession().accessToken !== activeSession.accessToken) throw new Error("MEDIA_REQUEST_CANCELLED");
  const directory = wx.env && wx.env.USER_DATA_PATH;
  if (typeof directory !== "string" || !directory) throw new Error("TIMELINE_PRIVATE_DIRECTORY_UNAVAILABLE");
  // Platform download-cache files cannot be unlinked in DevTools. An explicit
  // private destination gives this module ownership of its entire lifecycle.
  const path = `${directory}/ltm-timeline-${Date.now()}-${Array.from(random, value => value.toString(16).padStart(2, "0")).join("")}`;
  files.add(path);
  try {
    const result = await call(wx.downloadFile, { url: `${api.configuration().baseUrl}${node.downloadPath}`, filePath: path, timeout: 30000,
      header: { Authorization: `Bearer ${activeSession.accessToken}`, "X-Purpose": "age_transformation" } });
    if ((result.filePath || result.tempFilePath) !== path) throw new Error("TIMELINE_DOWNLOAD_DESTINATION_MISMATCH");
    if (result.statusCode !== 200) {
      if (result.statusCode === 401) session.clear();
      throw new Error(`TIMELINE_DOWNLOAD_HTTP_${result.statusCode}`);
    }
    if (generation !== epoch) throw new Error("MEDIA_REQUEST_CANCELLED");
    const filesystem = wx.getFileSystemManager();
    const stat = await call(filesystem.stat.bind(filesystem), { path });
    if (!stat.stats || stat.stats.size !== node.asset.byteLength) throw new Error("TIMELINE_IMAGE_SIZE_MISMATCH");
    const hash = createSha256();
    for (let position = 0; position < node.asset.byteLength;) {
      if (generation !== epoch) throw new Error("MEDIA_REQUEST_CANCELLED");
      const length = Math.min(1024 * 1024, node.asset.byteLength - position);
      const chunk = await call(filesystem.readFile.bind(filesystem), { filePath: path, position, length });
      // Native DevTools/WeChat buffers may originate in another JS realm.
      // The intrinsic getter checks the actual binary brand, unlike instanceof
      // or a spoofable constructor name / Symbol.toStringTag.
      let bytes;
      try {
        const size = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get.call(chunk.data);
        if (size !== length) throw new Error("INVALID_CHUNK_LENGTH");
        bytes = new Uint8Array(chunk.data);
      } catch { throw new Error("TIMELINE_IMAGE_READ_FAILED"); }
      hash.update(bytes); position += length;
    }
    if (hash.digestHex() !== node.asset.sha256) throw new Error("TIMELINE_IMAGE_DIGEST_MISMATCH");
    const info = await call(wx.getImageInfo, { src: path });
    if (info.width !== node.asset.width || info.height !== node.asset.height) throw new Error("TIMELINE_IMAGE_DIMENSIONS_MISMATCH");
    if (generation !== epoch || session.requireSession().accessToken !== activeSession.accessToken) throw new Error("MEDIA_REQUEST_CANCELLED");
    return path;
  } catch (error) { await remove(path); throw error; }
}
async function save(node, signal = {cancelled: false}) {
  const generation = epoch;
  if (signal.cancelled) throw new Error("MEDIA_REQUEST_CANCELLED");
  await privacy.requireAuthorization();
  if (generation !== epoch || signal.cancelled) throw new Error("MEDIA_REQUEST_CANCELLED");
  const path = await download(node); // Reauthorize on the server for every save, never reuse a cached preview.
  try {
    if (generation !== epoch || signal.cancelled) throw new Error("MEDIA_REQUEST_CANCELLED");
    await call(wx.saveImageToPhotosAlbum, { filePath: path });
  } catch (error) {
    if (/auth|permission|denied/i.test(String(error && error.errMsg))) throw new Error("ALBUM_PERMISSION_REQUIRED");
    throw error instanceof Error ? error : new Error("ALBUM_SAVE_FAILED");
  } finally { await remove(path); }
}
async function openAlbumSettings() {
  session.requireSession();
  if (typeof wx.openSetting !== "function") throw new Error("ALBUM_SETTINGS_UNAVAILABLE");
  const response = await call(wx.openSetting, {});
  if (!response || !response.authSetting || typeof response.authSetting !== "object") throw new Error("ALBUM_SETTINGS_INVALID");
  return response.authSetting["scope.writePhotosAlbum"] === true;
}
module.exports = { download, save, clearAll, remove, openAlbumSettings };
