import { useFacesInPhoto } from "@infinitered/react-native-mlkit-face-detection";
import { toByteArray } from "base64-js";
import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import jpeg from "jpeg-js";
import { useMemo } from "react";
import type { DetectedFaceQuality } from "../../src/production";
import { measureRgbaQuality } from "./image-metrics";
import { validatePrivateMediaUri } from "./security";

export interface NormalizedCapture {
  readonly uri: string;
  readonly mimeType: "image/jpeg";
  readonly sourceMimeType: "image/jpeg" | "image/png" | "image/heic" | "image/heif";
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly meanLuminance: number;
  readonly laplacianVariance: number;
  readonly orientationNormalized: true;
  readonly metadataStripped: true;
}

export async function captureAndNormalize(
  source: "camera" | "library",
  crop?: { readonly originX: number; readonly originY: number; readonly width: number; readonly height: number },
): Promise<NormalizedCapture | null> {
  const permission = source === "camera"
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error(source === "camera" ? "CAMERA_PERMISSION_DENIED" : "PHOTO_PERMISSION_DENIED");
  const result = source === "camera"
    ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], allowsEditing: false, quality: 1, exif: false, base64: false })
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: false, allowsEditing: false, quality: 1, exif: false, base64: false });
  if (result.canceled) return null;
  if (result.assets.length !== 1) throw new Error("IMAGE_SELECTION_AMBIGUOUS");
  const asset = result.assets[0]!;
  if (asset.type !== undefined && asset.type !== null && asset.type !== "image") throw new Error("IMAGE_MEDIA_TYPE_REQUIRED");
  const sourceMimeType = captureMime(asset.mimeType, asset.fileName);
  validatePrivateMediaUri(asset.uri);
  const actions: ImageManipulator.Action[] = [];
  if (crop !== undefined) {
    if (![crop.originX, crop.originY, crop.width, crop.height].every(Number.isSafeInteger) || crop.originX < 0 || crop.originY < 0 ||
        crop.width < 256 || crop.height < 256 || crop.originX + crop.width > asset.width || crop.originY + crop.height > asset.height) {
      throw new Error("IMAGE_CROP_INVALID");
    }
    actions.push({ crop });
  }
  // Re-encoding applies platform orientation and deliberately emits neither EXIF nor the HEIC container.
  const normalized = await ImageManipulator.manipulateAsync(asset.uri, actions, { compress: 0.94, format: ImageManipulator.SaveFormat.JPEG });
  validatePrivateMediaUri(normalized.uri);
  const info = await FileSystem.getInfoAsync(normalized.uri);
  if (!info.exists || typeof info.size !== "number" || info.size < 1 || info.size > 25 * 1_024 * 1_024) throw new Error("NORMALIZED_IMAGE_SIZE_INVALID");
  const base64 = await FileSystem.readAsStringAsync(normalized.uri, { encoding: FileSystem.EncodingType.Base64 });
  const decoded = jpeg.decode(toByteArray(base64), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 128, maxResolutionInMP: 30 });
  if (decoded.width !== normalized.width || decoded.height !== normalized.height) throw new Error("NORMALIZED_IMAGE_DIMENSION_MISMATCH");
  const metrics = measureRgbaQuality(decoded.data, decoded.width, decoded.height);
  decoded.data.fill(0);
  return Object.freeze({
    uri: normalized.uri, mimeType: "image/jpeg", sourceMimeType, width: normalized.width, height: normalized.height,
    byteLength: info.size, ...metrics, orientationNormalized: true, metadataStripped: true,
  });
}

export function useNativeFaceQuality(uri: string | undefined, imageWidth: number, imageHeight: number): {
  readonly status: string; readonly error?: string; readonly faces: readonly DetectedFaceQuality[];
} {
  const detection = useFacesInPhoto(uri);
  return useMemo(() => ({
    status: detection.status,
    ...(detection.error === undefined ? {} : { error: detection.error }),
    faces: detection.faces.map((face, index) => {
      const frameArea = face.frame.size.x * face.frame.size.y;
      const missingEyes = Number(!face.hasLeftEyeOpenProbability) + Number(!face.hasRightEyeOpenProbability);
      return {
        id: face.hasTrackingID && face.trackingID !== undefined && face.trackingID !== null ? `face-${face.trackingID}` : `face-${index}`,
        pitchDegrees: face.headEulerAngleX ?? 0,
        yawDegrees: face.headEulerAngleY ?? 0,
        rollDegrees: face.headEulerAngleZ ?? 0,
        occlusionRatio: missingEyes * 0.18,
        frameAreaRatio: imageWidth > 0 && imageHeight > 0 ? frameArea / (imageWidth * imageHeight) : 0,
      };
    }),
  }), [detection.error, detection.faces, detection.status, imageHeight, imageWidth]);
}

function captureMime(value: string | null | undefined, fileName: string | null | undefined): NormalizedCapture["sourceMimeType"] {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized === "image/jpeg" || normalized === "image/png" || normalized === "image/heic" || normalized === "image/heif") return normalized;
  const extension = fileName?.toLowerCase().split(".").pop();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "heic") return "image/heic";
  if (extension === "heif") return "image/heif";
  throw new Error("IMAGE_FORMAT_UNSUPPORTED");
}
