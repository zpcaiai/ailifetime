import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DomainError, parseTimelineImageAsset, type TimelineImageAsset } from "@ltm/core";

export interface TimelineArtifactReader { read(asset: TimelineImageAsset): Promise<Uint8Array>; }
export function configuredTimelineArtifacts(environment: Readonly<Record<string,string|undefined>>, appEnvironment: string): FileTimelineArtifactStore | undefined {
  const directory = environment.LTM_TIMELINE_MEDIA_DIRECTORY;
  if (directory === undefined) return undefined;
  if (!["local", "test"].includes(appEnvironment) || directory.trim() !== directory || directory === "") throw new DomainError("CONFIGURATION_INVALID", "local timeline media directory requires explicit local/test environment");
  return new FileTimelineArtifactStore(directory);
}
function invalid(message: string): never { throw new DomainError("DEPENDENCY_UNAVAILABLE", message); }
/** Local/test content-addressed immutable storage. Production must provide its approved reader. */
export class FileTimelineArtifactStore implements TimelineArtifactReader {
  private readonly directory: string;
  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new DomainError("CONFIGURATION_INVALID", "timeline media directory must be absolute");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new DomainError("CONFIGURATION_INVALID", "timeline media directory cannot be a symlink");
    this.directory = realpathSync(directory);
  }
  async put(id: string, bytes: Uint8Array, mimeType: "image/jpeg" | "image/png"): Promise<TimelineImageAsset> {
    if (bytes.byteLength < 1 || bytes.byteLength > 25 * 1024 * 1024) return invalid("timeline image size is invalid");
    const image = Buffer.from(bytes), { width, height } = imageDimensions(image, mimeType);
    const asset = parseTimelineImageAsset({ id, sha256: createHash("sha256").update(image).digest("hex"), mimeType, width, height, byteLength: image.byteLength });
    const target = this.path(asset), temporary = join(this.directory, `.incoming-${randomUUID()}`);
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, image); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, target); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    finally { unlinkSync(temporary); }
    await this.read(asset);
    return asset;
  }
  private path(asset: TimelineImageAsset): string { return join(this.directory, `${asset.sha256}.${asset.mimeType === "image/png" ? "png" : "jpg"}`); }
  async read(value: TimelineImageAsset): Promise<Uint8Array> {
    const asset = parseTimelineImageAsset(value);
    let fd: number;
    try { fd = openSync(this.path(asset), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch { return invalid("timeline image is unavailable"); }
    let bytes: Buffer;
    try {
      const buffer = Buffer.alloc(asset.byteLength + 1); let total = 0, amount = 0;
      do { amount = readSync(fd, buffer, total, buffer.byteLength-total, null); total += amount; } while (amount > 0 && total < buffer.byteLength);
      if (total !== asset.byteLength) return invalid("timeline image byte length changed");
      bytes = buffer.subarray(0,total);
    } finally { closeSync(fd); }
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) return invalid("timeline image digest changed");
    const dimensions = imageDimensions(bytes, asset.mimeType);
    if (dimensions.width !== asset.width || dimensions.height !== asset.height) return invalid("timeline image dimensions changed");
    return bytes;
  }
}
function imageDimensions(bytes: Buffer, mime: string): { width: number; height: number } {
  if (mime === "image/png" && bytes.length >= 33 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString("ascii",12,16) === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    let position = 2;
    while (position + 4 < bytes.length) {
      if (bytes[position++] !== 255) break;
      while (bytes[position] === 255) position++;
      const marker = bytes[position++]; if (marker === undefined || marker === 217 || marker === 218) break;
      const length = bytes.readUInt16BE(position);
      if (length < 2 || position + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) return { height: bytes.readUInt16BE(position+3), width: bytes.readUInt16BE(position+5) };
      position += length;
    }
  }
  return invalid("timeline image header is invalid");
}
