import { DomainError } from "@ltm/core";
import { WARDROBE_STYLES } from "@ltm/capabilities";

export const PHOTO_PRICE_VERSION = "photo-retail-cny.v3";
const LEGACY_PRODUCTS = Object.freeze([
  Object.freeze({ sku: "lifespan-21", title: "一生相册", amountMinor: 4990, currency: "CNY", deliveryUnit: "21_age_photos", imageCount: 21 }),
  Object.freeze({ sku: "selected-age", title: "停在某一岁", amountMinor: 590, currency: "CNY", deliveryUnit: "one_selected_age_photo", imageCount: 1 }),
  Object.freeze({ sku: "wardrobe-series", title: "一生衣橱 · 系列套装", amountMinor: 990, currency: "CNY", deliveryUnit: "all_eligible_styles_in_one_series", imageCount: null }),
]);
function album(sku: string, count: number, imageQuality: "standard"|"hd", amountMinor: number) {
  const size = imageQuality === "standard" ? 1536 : 2048;
  return Object.freeze({sku,title: `一生相册 · ${count} 张 · ${imageQuality === "standard" ? "普通清晰" : "高清"}`,amountMinor,currency:"CNY",deliveryUnit:`${count}_age_photos`,imageCount:count,imageQuality,imageWidth:size,imageHeight:size,retentionDays:30});
}
export const PHOTO_PRODUCTS = Object.freeze([
  album("lifespan-11-standard",11,"standard",1990),
  album("lifespan-21-standard",21,"standard",2990),
  album("lifespan-11-hd",11,"hd",2990),
  album("lifespan-21",21,"hd",4990),
  LEGACY_PRODUCTS[1]!, LEGACY_PRODUCTS[2]!,
]);

export function photoProduct(sku: unknown, priceVersion: unknown = PHOTO_PRICE_VERSION) {
  if (priceVersion !== "photo-retail-cny.v1" && priceVersion !== "photo-retail-cny.v2" && priceVersion !== PHOTO_PRICE_VERSION) throw new DomainError("VALIDATION_FAILED", "unknown photo price version");
  const product = (priceVersion === PHOTO_PRICE_VERSION ? PHOTO_PRODUCTS : LEGACY_PRODUCTS).find(item => item.sku === sku);
  if (!product) throw new DomainError("VALIDATION_FAILED", "unknown photo product");
  return { ...product, amountMinor: priceVersion === "photo-retail-cny.v1" && sku === "lifespan-21" ? 990 : product.amountMinor, priceVersion };
}

export function agePhotoProduct(profile: unknown, ages: unknown, imageQuality: unknown = "hd") {
  const short = profile === "lifespan-11-v1" || profile === "lifespan-11-couple-v1";
  const lifespan = short || profile === "lifespan-21-v1" || profile === "lifespan-21-couple-v1";
  const selected = profile === "single-age-v1" || profile === "single-age-couple-v1";
  const count = short ? 11 : 21, step = short ? 10 : 5;
  if ((!lifespan && !selected) || (imageQuality !== "standard" && imageQuality !== "hd") || (selected && imageQuality !== "hd") || !Array.isArray(ages) || ages.some(age => !Number.isInteger(age) || age < 0 || age > 100) ||
      (lifespan ? ages.length !== count || ages.some((age, i) => age !== i * step) : ages.length !== 1)) {
    throw new DomainError("VALIDATION_FAILED", "retail age purchase must bind its exact age profile and photo count");
  }
  const sku = !lifespan ? "selected-age" : count === 21 && imageQuality === "hd" ? "lifespan-21" : `lifespan-${count}-${imageQuality}`;
  return { ...photoProduct(sku), targetAges: [...ages] as number[] };
}

export function wardrobeSeriesProduct(seriesId: unknown, targetAge: unknown, people: unknown) {
  if (typeof seriesId !== "string" || !Number.isInteger(targetAge) || Number(targetAge) < 0 || Number(targetAge) > 100 || (people !== 1 && people !== 2)) {
    throw new DomainError("VALIDATION_FAILED", "wardrobe series requires a valid age and one or two participants");
  }
  const series = WARDROBE_STYLES.filter(style => style.seriesId === seriesId);
  if (!series.length) throw new DomainError("VALIDATION_FAILED", "unknown wardrobe series");
  const eligible = series.filter(style => Number(targetAge) >= (style.minAge ?? 0) && Number(targetAge) <= (style.maxAge ?? 100) && people >= (style.minPeople ?? 1));
  if (!eligible.length) throw new DomainError("VERSION_CONFLICT", "this series has no eligible styles for this age and participant count");
  return { ...photoProduct("wardrobe-series"), seriesId, seriesTitle: series[0]!.seriesLabel!, targetAge: targetAge as number,
    imageCount: eligible.length, styleIds: eligible.map(style => style.id), styles: eligible.map(style => ({ id: style.id, title: style.label })) };
}
