// Original fantasy garment designs. Catalog copy and previews reference the same design.
type Color = readonly [label: string, name: string];
type Realm = readonly [key: string, name: string, palette: readonly string[], colors: readonly Color[], fabricLabel: string, fabric: string, motifLabel: string, motif: string];
type Silhouette = readonly [key: string, label: string, detail: string, cut: string];

const realms: readonly Realm[] = [
  ["aurora","极光",["#126A75","#B880CF","#A9ECC4"],[["极光绿","teal-green"],["虹光紫","opalescent lilac"],["浅荧绿","pale mint-green"]],"珠光缎织","iridescent satin with opaque backing","极光带纹","aurora ribbon embroidery"],
  ["moon","月桂",["#DDE7EA","#65799C","#42475E"],[["月银白","moon-silver white"],["月影蓝","silvery mid-blue"],["午夜灰蓝","deep slate-blue"]],"银丝云锦","opaque silver-thread brocade","月桂银绣","crescent and laurel embroidery"],
  ["abyss","珊瑚海",["#126478","#C95153","#E1C7A6"],[["深海蓝","deep lagoon blue"],["珊瑚红","coral red"],["贝母白","mother-of-pearl ivory"]],"贝纹珠绣","shell-pattern opaque silk jacquard","珊瑚贝纹","scallop-shell and coral embroidery"],
  ["phoenix","焰羽",["#A62E37","#E4A341","#4B2234"],[["熔岩绯红","flame-crimson red"],["琥珀金","amber gold"],["灰烬紫","aubergine ash purple"]],"金线绣缎","gold-thread opaque silk satin","焰羽金绣","flame-feather embroidery"],
  ["rose","玫瑰夜",["#782D49","#D1899B","#2F1E36"],[["玫瑰酒红","dark rose wine"],["烟粉","dusty rose pink"],["夜花梅紫","midnight plum"]],"花瓣丝绒","floral velvet with opaque lining","玫瑰花瓣绣","thornless rose petal embroidery"],
  ["storm","雷霆",["#2452A2","#BAC8D4","#514982"],[["雷霆钴蓝","electric cobalt blue"],["冷雾银","cool mist silver"],["云幕紫","storm-cloud purple"]],"斜纹银丝锦","silver-thread opaque twill brocade","折线雷纹","lightning zigzag embroidery"],
  ["jade","翡翠宫",["#237750","#E0D3AA","#1D698B"],[["翡翠绿","emerald-jade green"],["象牙白","ivory white"],["孔雀青","peacock teal-blue"]],"玉纹绸缎","jade-vine silk satin with full lining","翡翠藤纹","abstract jade-vine embroidery"],
  ["butterfly","幻蝶",["#9278B7","#EC8F7E","#265479"],[["淡蝶紫","soft amethyst lavender"],["夕蝶橘","warm salmon orange"],["蝶翼蓝","deep butterfly blue"]],"翼纹缎纱","opaque satin with layered organza panels","幻蝶翅脉纹","butterfly-wing-vein embroidery confined to cloth"],
  ["desert","流沙",["#DCB06B","#A74643","#34746E"],[["流沙蜜金","sand-dune honey gold"],["赤砂赭","burnt red ochre"],["绿洲青","oasis teal green"]],"砂纹金锦","sand-pattern opaque metallic jacquard","沙丘金线纹","sand-dune curves and geometric embroidery"],
  ["clockwork","钟摆城",["#764653","#B8874D","#315957"],[["莓铜红","copper-plum red"],["钟摆黄铜","brass amber"],["氧化铜绿","oxidized copper teal"]],"铜丝提花","copper-thread woven jacquard","黄铜齿轮纹","stylized stitched cogwheel motifs, no actual hardware"],
  ["raven","渡鸦",["#292635","#9C9EBA","#473C75"],[["渡鸦墨黑","raven charcoal black"],["银羽灰","silvery feather gray"],["紫夜蓝","deep midnight violet"]],"羽纹丝绒","feather-pattern opaque velvet","渡鸦羽纹","abstract raven-feather embroidery"],
  ["winter","冰晶",["#D6E7EB","#76A8CE","#9F8BAD"],[["霜川白","frost white"],["冰湖蓝","glacier blue"],["冻莓紫","muted icy berry purple"]],"霜花亮缎","frost-embroidered satin with opaque underlayer","六角霜花绣","snowflake and hexagonal frost embroidery"],
  ["stardust","星辰",["#29275C","#DFB56F","#765497"],[["深空靛","deep space indigo"],["星屑金","stardust gold"],["星云紫","nebula purple"]],"星尘亮锦","opaque star-thread jacquard","星轨金线绣","constellations and gold comet-tail embroidery"],
];

const silhouettes: Readonly<Record<"princess" | "prince", readonly Silhouette[]>> = {
  princess: [
    ["tiered","阶纱礼裙","层叠泡袖礼裙","layered ball gown with three distinct tiers and short puff sleeves"],
    ["asymmetric","斜摆盛装","斜摆礼服","modest asymmetric overskirt gown with a visible diagonal waist drape"],
    ["bell","钟形礼裙","钟摆长袖","bell-shaped royal gown with dramatic full bell sleeves and a closed round neckline"],
    ["high-collar","立领盛装","立领披肩裙","high stand-collar court gown with integrated scalloped shoulder cape panels"],
    ["pleated","扇褶礼裙","扇褶长裙","closed neckline palace gown with wide fan pleats across the lower skirt"],
    ["petal","花瓣盛装","花萼裙摆","structured petal-panel gown with distinct overlapping petal hem layers"],
    ["column","直身仪袍","长袖直身裙","slim straight-column court gown with wide embroidered cuffs and a modest rounded neckline"],
    ["ruffle","皱褶舞裙","双层褶边舞裙","formal palace gown with elbow-length ruffled sleeves and two bold flounced skirt bands"],
    ["mantle","披袍礼裙","连肩披袍","regal A-line princess dress with a broad fitted overmantle visibly sewn to both shoulders"],
  ],
  prince: [
    ["tailcoat","燕尾礼衣","双燕尾外衣","sculptural double-tailcoat over a closed ivory shirt, sharply defined lapels and long rear tails"],
    ["ceremony","仪仗礼衣","立领仪仗长衣","high-standing-collar ceremonial prince coat with ornate horizontal fabric frogging and full sleeves"],
    ["asymmetric","斜襟王服","斜襟长外衣","visual diagonal fabric overlap on a long asymmetric prince coat with closed neck and draped front"],
    ["shoulder","披肩王服","连肩短披袍","fitted closed court jacket with a short broad half-cape visibly sewn into one shoulder seam"],
    ["brocade","织锦王服","织锦及膝长衣","knee-length princely brocade coat with a straight front, decorated sleeve hems and covered inner layer"],
    ["doublet","束身礼衣","分片短礼衣","structured Renaissance-style princely doublet with faceted fabric paneling, rounded sleeve upper sections and a covered neckline"],
    ["sleeves","阔袖王袍","阔袖礼袍","broad square-sleeve princely court robe with wide scalloped woven cuffs and a closed inner tunic"],
    ["panel","折襞王服","折襞束腰长衣","court prince jacket with a waist sash made of sewn garment fabric and pleated flared panel hem"],
    ["gala","礼宴正装","大驳领长礼衣","opulent court prince formal long jacket with exaggerated wide lapels and a contrasting opaque standing-collar waistcoat"],
  ],
};

// Each archetype supplies the shared identity across the two silhouettes.
const archetypes: Readonly<Record<string, readonly [role: string, detail: string]>> = {
  aurora: ["光法师", "珠光缎织像极光一样在袖摆流动"],
  moon: ["月卫", "银线月桂沿肩披和长衣排布"],
  abyss: ["深海守卫", "贝纹珠绣和珊瑚分片铺满礼服"],
  phoenix: ["焰羽战将", "立体火纹和羽鳞叠片从衣缝向外展开"],
  rose: ["花语术士", "酒红和烟粉丝绒绣出夜玫瑰"],
  storm: ["雷纹骑士", "折线雷纹从银丝宽袖伸向下摆"],
  jade: ["翡翠御卫", "青玉藤纹缠绕翡翠、牙白和孔雀蓝缎面"],
  butterfly: ["幻蝶织法师", "扇折翼袖与虹彩裙摆随步展开"],
  desert: ["沙海游侠", "砂金与赭红在长摆里叠出沙丘曲线"],
  clockwork: ["齿轮工匠", "铜色弧片和机芯折褶构成机关甲"],
  raven: ["暗羽刺客", "墨黑、银灰与紫蓝羽纹若隐若现"],
  winter: ["霜晶术士", "雪花六角纹密布冰蓝与霜银缎面"],
  stardust: ["星轨召唤师", "金线星轨沿高领和披袍攀升"],
};
const showcase: Readonly<Record<string, readonly [detail: string, construction: string]>> = {
  phoenix: ["立体焰羽叠片", "bold sculptural flame-ribbon ridges and raised feather-scale cloth panels radiating from the seams of that specific silhouette, in dramatic red, saffron gold or deep aubergine, with strongly three-dimensional stiffened fabric construction"],
  butterfly: ["虹彩扇折翼袖", "dramatic oversized fan-folded fins built into the hem and sleeves, layered iridescent organza over opaque satin with rich color transitions and sculptural curves, all forming part of the garment silhouette, no separate wings"],
  clockwork: ["铜弧机芯折褶", "bold exposed concentric arcs made from padded copper fabric, radial telescoping pleats and dimensional rivet-like embroidered dots, heavily shaped, asymmetric construction in glowing patinated bronze, copper-red and deep blue-green, fabric only"],
};

export const ROYAL_CATALOG_VERSION = "lifetime-wardrobe.v4";
// Lead with the most sculptural pieces in the gallery.
const featuredRealms = ["phoenix", "butterfly", "clockwork"] as const;
const orderedRealms = [...featuredRealms.map(key => realms.find(([realm]) => realm === key)!), ...realms.filter(([realm]) => !Object.hasOwn(showcase, realm))];
const royal = orderedRealms.flatMap(([realm, name, palette, colors, fabricLabel, fabric, motifLabel, motif]) =>
  (["princess", "prince"] as const).map(category => {
    const role = category === "princess" ? "公主" : "王子";
    const [archetype, visual] = archetypes[realm]!;
    const sculptural = showcase[realm];
    const series = Object.freeze({ id: `royal-${realm}-${category}`, label: `${name}王国 · ${role}`, category,
      categoryLabel: `${role}套装`, tagline: `${archetype} · ${visual}。`, palette: Object.freeze([...palette]) });
    const styles = silhouettes[category].map(([key, label, detail, cut], index) => {
      const [colorLabel, color] = colors[index % colors.length]!;
      const construction = sculptural ? `no separate accessories; add ${sculptural[1]}` : "restrained metallic details, no separate accessories";
      const garment = `${color} ${cut}, using ${fabric}; precise ${motif} integrated into the garment, ${construction}`;
      return Object.freeze({
        id: `${series.id}-${key}-v1`, label: colorLabel + label,
        description: `${colorLabel}${fabricLabel} · ${sculptural?.[0] || motifLabel} · ${detail}`,
        seriesId: series.id, seriesLabel: series.label, minAge: 0, maxAge: 100, minPeople: 1,
        instruction: `${garment}. Apply the selected fairy-tale costume only to visible clothing inside the source crop. Preserve each person's identity, displayed age, gender presentation, face, hair, body shape, hands, pose, position, lighting and background. Translate the design to opaque, modest, age-appropriate garments with safe infant or child sizing and sewn fabric closures. Keep motifs sewn or woven into clothing. Do not add crowns, headwear, jewelry, weapons, wings, props, recognizable character marks, text or watermarks.`,
      });
    });
    return { series, styles };
  }),
);
export const ROYAL_WARDROBE_SERIES = Object.freeze(royal.map(({ series }) => series));
export const ROYAL_WARDROBE_STYLES = Object.freeze(royal.flatMap(({ styles }) => styles));
