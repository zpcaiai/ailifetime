export interface PixelMetrics { readonly meanLuminance: number; readonly laplacianVariance: number }

/** Computes luminance and a four-neighbour Laplacian variance without retaining image pixels. */
export function measureRgbaQuality(data: Uint8Array, width: number, height: number): PixelMetrics {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 3 || height < 3 || data.byteLength !== width * height * 4) {
    throw new Error("RGBA_IMAGE_INVALID");
  }
  const step = Math.max(1, Math.floor(Math.max(width, height) / 1024));
  let luminanceTotal = 0;
  let count = 0;
  let laplacianTotal = 0;
  let laplacianSquared = 0;
  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const center = luma(data, width, x, y);
      luminanceTotal += center;
      const laplacian = 4 * center - luma(data, width, x - step, y) - luma(data, width, x + step, y) -
        luma(data, width, x, y - step) - luma(data, width, x, y + step);
      laplacianTotal += laplacian;
      laplacianSquared += laplacian * laplacian;
      count += 1;
    }
  }
  if (count === 0) throw new Error("RGBA_SAMPLE_EMPTY");
  const meanLaplace = laplacianTotal / count;
  return { meanLuminance: luminanceTotal / count, laplacianVariance: Math.max(0, laplacianSquared / count - meanLaplace * meanLaplace) };
}

function luma(data: Uint8Array, width: number, x: number, y: number): number {
  const index = (y * width + x) * 4;
  return 0.2126 * data[index]! + 0.7152 * data[index + 1]! + 0.0722 * data[index + 2]!;
}
