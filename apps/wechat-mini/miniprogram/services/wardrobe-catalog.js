const legacySeries = ["east", "retro", "together", "daily", "wedding", "milestone", "winter", "newyear"];
const isSeriesId = value => typeof value === "string" && value.length <= 48 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
const invalid = () => { throw new Error("WARDROBE_CONTEXT_INVALID"); };

function catalog(context) {
  const nine = context?.catalogVersion === "lifetime-wardrobe.v3", modern = nine || context?.catalogVersion === "lifetime-wardrobe.v2", old = context?.catalogVersion === "lifetime-wardrobe.v1";
  if ((!modern && !old) || !Number.isInteger(context.targetAge) || context.targetAge < 0 || context.targetAge > 100 || !Array.isArray(context.participants) || ![1, 2].includes(context.participants.length) ||
      !Array.isArray(context.styles) || context.styles.length !== (nine ? 219 : modern ? 98 : 34) || new Set(context.styles.map(s => s?.id)).size !== context.styles.length) return invalid();
  for (const style of context.styles) {
    if (!style || !text(style.id,128) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(style.id) || !text(style.label,40) || !isSeriesId(style.seriesId) || !text(style.seriesLabel,50) ||
        typeof style.legacy !== "boolean" || style.legacy !== (style.seriesId === "legacy") || !Number.isInteger(style.minAge) || !Number.isInteger(style.maxAge) || style.minAge < 0 || style.minAge > style.maxAge || style.maxAge > 100 ||
        ![1,2].includes(style.minPeople) || typeof style.unavailableReason !== "string" || style.available !== (context.targetAge >= style.minAge && context.targetAge <= style.maxAge && context.participants.length >= style.minPeople) ||
        (modern && !text(style.description,160))) return invalid();
  }
  const styles = context.styles.filter(s => !s.legacy);
  if (styles.length !== (nine ? 216 : modern ? 95 : 31) || context.styles.filter(s => s.legacy).length !== 3 || !context.styles.some(s => s.id === "daily-white-v1" && s.available)) return invalid();
  let groups;
  if (modern) {
    groups = context.series;
    if (!Array.isArray(groups) || groups.length !== 24 || new Set(groups.map(s => s?.id)).size !== 24) return invalid();
    const categories = new Map();
    for (const group of groups) {
      if (!group || !isSeriesId(group.id) || group.id === "legacy" || !text(group.label,50) || !isSeriesId(group.category) || !text(group.categoryLabel,12) || !text(group.tagline,100) ||
          !Array.isArray(group.palette) || group.palette.length !== 3 || group.palette.some(c => typeof c !== "string" || !/^#[A-Fa-f0-9]{6}$/.test(c))) return invalid();
      if (categories.has(group.category) && categories.get(group.category) !== group.categoryLabel) return invalid();
      categories.set(group.category,group.categoryLabel);
    }
    if (categories.size !== 6) return invalid();
  } else {
    if (new Set(styles.map(s => s.seriesId)).size !== 8 || styles.some(s => !legacySeries.includes(s.seriesId))) return invalid();
    groups = legacySeries.map(id => ({id,label:styles.find(s => s.seriesId === id).seriesLabel,category:"classic",categoryLabel:"经典系列",tagline:"选一个系列，收藏全部适用衣着。",palette:["#E5DACB","#B3C3B2","#8E7C86"]}));
  }
  for (const group of groups) {
    const looks = styles.filter(s => s.seriesId === group.id);
    if ((nine ? looks.length !== 9 : looks.length < 3 || looks.length > 4) || looks.some(s => s.seriesLabel !== group.label || !s.id.startsWith(group.id + "-"))) return invalid();
  }
  if (styles.some(s => !groups.some(group => group.id === s.seriesId))) return invalid();
  return groups;
}

function presentStyle(style, index, palette) {
  const detail = (style.label || "") + " " + (style.description || "");
  const silhouette = /马甲|背心/.test(detail) ? "vest" : /开衫/.test(detail) ? "cardigan" : /羽绒|绗棉|绗缝/.test(detail) ? "puffer" : /长衫|汉服|交领|叠袍|叠襟/.test(detail) ? "robe" : /婚纱|礼服|厚缎|叠纱/.test(detail) ? "occasion" : /针织|羊绒|毛线|绞花/.test(detail) ? "knit" : /风衣|毛呢|羊毛|西装|精纺/.test(detail) ? "coat" : /夹克|工装|轻壳|抓绒/.test(detail) ? "jacket" : "shirt";
  const texture = /条|海魂/.test(detail) ? "stripe" : /格/.test(detail) ? "check" : /绗|羽绒/.test(detail) ? "quilt" : /花|绣|织锦|提花|叶纹/.test(detail) ? "floral" : /针织|罗纹|灯芯绒|羊绒/.test(detail) ? "rib" : /人字|软呢/.test(detail) ? "tweed" : "plain";
  const previewSrc = /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(style.id) ? "/assets/wardrobe/" + style.id + ".webp" : "";
  return {...style,previewSrc,ordinal:String(index+1).padStart(2,"0"),description:style.description || style.label,silhouette,texture,
    features:(style.description || style.label).split(" · "),
    illustrationStyle:`--garment:${palette[index % 3]};--trim:${palette[(index+2) % 3]};--accent:${palette[(index+1) % 3]};`,
    swatchStyle:`background:${palette[index % 3]};`};
}
function discover(styles, groups, {category = "all", query = "", onlyAvailable = false} = {}) {
  const search = String(query).trim().toLowerCase().slice(0,40);
  const series = groups.map(group => {
    const looks = styles.filter(s => !s.legacy && s.seriesId === group.id), eligible = looks.filter(s => s.available);
    const palette = group.palette;
    const matches = search ? looks.filter(style => [style.label, style.description || ""].some(value => value.toLowerCase().includes(search))) : [];
    const eligibleMatch = matches.find(style => style.available);
    const lead = eligibleMatch || matches[0];
    const sample = [looks[0], looks[Math.floor(looks.length / 2)], looks[looks.length - 1]];
    const cover = lead ? [lead, ...sample.filter(style => style.id !== lead.id)].slice(0, 3) : sample;
    const listed = lead ? [lead, ...matches.filter(style => style.id !== lead.id)] : looks;
    const names = listed.slice(0, 3).map(style => style.label).join(" / ") + (listed.length > 3 ? ` 等${listed.length}款` : "");
    return {...group, name:group.label.split(" · ")[0], count:eligible.length, totalCount:looks.length,
      lookNames:lead ? `匹配 · ${names}${eligibleMatch ? "" : "（当前不适用）"}` : names,
      matchedStyleIds:matches.map(style => style.id),
      coverLooks:cover.map(style => presentStyle(style, looks.indexOf(style), palette)),
      availability:eligible.length ? `本照片可用 ${eligible.length} 款` : looks[0]?.unavailableReason || "当前照片不适用",
      coverStyle:`background:linear-gradient(135deg,${palette[0]} 0%,${palette[1]} 100%);`,
      garmentStyle:`background:${palette[2]};`,
      swatches:palette.map((color,i) => ({id:String(i),style:`background:${color};`}))};
  });
  const categories = [{id:"all",label:"全部风格"}, ...Array.from(new Map(groups.map(g => [g.category,{id:g.category,label:g.categoryLabel}])).values())];
  const visibleSeries = series.filter(group => (category === "all" || group.category === category) && (!onlyAvailable || group.count > 0) &&
    (!search || group.matchedStyleIds.length > 0 || [group.label, group.tagline, group.categoryLabel].some(value => value.toLowerCase().includes(search))));
  return {series, visibleSeries, categories, styleCount:styles.filter(s => !s.legacy).length, availableSeriesCount:series.filter(g => g.count > 0).length};
}
module.exports = {catalog, discover, isSeriesId, presentStyle};
