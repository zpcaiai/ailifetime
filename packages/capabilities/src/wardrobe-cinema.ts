type Costume = readonly [label: string, description: string, cut: string];
type CinemaTheme = Readonly<{
  key: string;
  title: string;
  genre: string;
  palette: readonly string[];
  tagline: string;
  women: readonly Costume[];
  men: readonly Costume[];
}>;

export const CINEMA_CATALOG_VERSION = "lifetime-wardrobe.v5";

const themes: readonly CinemaTheme[] = [
  { key: "orbit", title: "星际远征", genre: "太空科幻",
    palette: ["#294A77","#EBE4D5","#B4683F"], tagline: "钴蓝制服、月白飞行服和铜色舱服，拼接缝线参考太空科幻服装。",
    women: [
      ["蓝金领航服","钴蓝斜襟短制服、铜边和深蓝直筒裤","cobalt asymmetric cropped navigator jacket, copper piping and navy trousers"],
      ["月白飞行服","月白连身飞行服、蓝色腰侧嵌片","ivory flight jumpsuit, blue waist side panels"],
      ["橘砂勘察服","赭橘外套、加厚肘片和炭灰裤","ochre survey jacket, quilted elbows and dark trousers"],
      ["深空指挥长衣","中长墨蓝长衣、银线方肩","mid-calf dark navy command coat, squared shoulders and silver piping"],
      ["银灰维修制服","银灰拼片制服和宽横袋","pale slate paneled mechanic two-piece with large flat pockets"],
      ["铜边冷舱服","黑铜保温连身装和高领","black thermal one-piece with copper inset and padded collar"],
      ["月白观测大衣","象牙白防护长大衣和钴蓝袖带","ivory observer duster with cobalt cuffs over navy trousers"],
      ["橙银救援服","鲜橙连身服、月白斜裁拼色","orange rescue jumpsuit with diagonal ivory panels"],
      ["舰桥银纹礼装","墨蓝长礼服、银线和雕塑肩","inky high-coverage floor-length command gown with silver seam lines and sculptured shoulders"],
    ],
    men: [
      ["舰长双襟制服","深蓝双襟衣、铜嵌条和直筒裤","navy double-paneled captain tunic with copper piping and trousers"],
      ["近轨飞行服","月白飞行连身服、蓝色胁下嵌片","ivory flight jumpsuit with blue rib panels"],
      ["岩面测绘装","橘褐分体服、加固膝片和墨灰裤","rust field two-piece with quilted knee inserts and dark trousers"],
      ["暗轨巡逻长衣","炭灰中长衣、钴蓝立体侧襟","charcoal patrol long coat with three-dimensional cobalt side panels"],
      ["机舱技师工装","银蓝工程连身服和大袋片","slate blue engineer coverall with bold flat cargo pockets"],
      ["冷舱警戒服","黑色立领短衣、铜色轮廓线","black thermal jacket and trousers with copper contour seam"],
      ["轨道观测长褂","月白长褂套海军蓝裤","ivory observer long coat over navy trousers"],
      ["火星救援服","橘色救援连身服配斜向白线","vivid orange rescue jumpsuit with ivory diagonal striping"],
      ["舰队银纹正装","墨蓝礼仪上衣、银线和锥裤","deep navy ceremonious tunic with angular shoulders, silver braid and tapered trousers"],
    ],
  },
  { key: "spy", title: "夜幕情报", genre: "谍战动作",
    palette: ["#212C32","#296067","#7A3342"], tagline: "暗色剪裁、隐袋和立领，覆盖夜宴、雨巷和城市行动三种场合。",
    women: [
      ["夜缎高领礼裙","黑缎长袖高领礼裙","black high-neck satin column gown with strong shoulders"],
      ["潜行风衣","深青双排扣系带长风衣","matte deep teal double-breasted belted trench"],
      ["酒红行动西装","酒红窄剪裁裤装、黑色针织内搭","oxblood sharp trouser suit with dark ribbed underlayer"],
      ["城市机能夹克","深灰立体袋短夹克和便裤","graphite structured field jacket with gusseted pockets and trousers"],
      ["黑羊毛雨夜长衣","墨黑长羊毛大衣和高风领","midnight wool ankle coat with high storm collar"],
      ["档案室针织套装","青黑高领针织和深灰马甲阔腿裤","dark teal ribbed turtleneck under charcoal waistcoat and wide trousers"],
      ["黑皮拼袖短装","哑黑机车夹克和酒红嵌线","matte black biker-style jacket with leather-look sleeves, oxblood piping and charcoal pants"],
      ["使馆白领套装","象牙白礼服夹克和黑长裤","ivory blazer with black silk lapels and full-length black trousers"],
      ["夜驶连身服","炭灰连身服、青色肩胯拼片","charcoal rugged zip-front one-piece with teal shoulder and hip panels"],
    ],
    men: [
      ["午夜缎领礼服","墨黑青果领燕尾装和白衬衣","black tuxedo with satin shawl lapel, white shirt and trousers"],
      ["隐线长风衣","深青雨夜长风衣和炭灰裤","deep teal double-breasted floor-length storm trench and charcoal trousers"],
      ["酒红便衣西装","酒红三件套和黑内搭","oxblood three-piece undercover suit and black shirt"],
      ["城市行动夹克","炭灰战术短夹克和机能裤","graphite field jacket with discreet flat pockets over cargo trousers"],
      ["冷巷立领大衣","墨黑羊毛风领外套和暗红袖口","black wool greatcoat with hidden closure and muted burgundy cuffs"],
      ["高领针织外套","藏青外套、黑色高领和灰便裤","navy overcoat, ink turtleneck, relaxed gray trousers"],
      ["暗线皮袖夹克","黑皮短夹克和青色窄嵌线","black leather-look bomber with deep teal inset and tapered trousers"],
      ["白色宴会正装","象牙白晚宴礼服和黑裤","ivory dinner jacket with black lapels and full-length tuxedo trousers"],
      ["夜航车手服","炭黑拉链连身服和酒红缝带","slate one-piece race-style coverall with oxblood seam stripes"],
    ],
  },
  { key: "expedition", title: "失落遗迹", genre: "遗迹冒险",
    palette: ["#A16A3E","#5B6248","#E0CEAC"], tagline: "沙色帆布、橄榄绿工装与轻亚麻，适合遗迹勘查和旧式旅行。",
    women: [
      ["古图测绘夹克","卡其方袋外套与橄榄裤","khaki canvas mapmaker jacket with square chest pockets and olive trousers"],
      ["沙尘远行长衣","深砂色防尘长衣与米白内搭","desert tan split-back long duster over ivory shirt and sand breeches"],
      ["石阶猎装","橄榄狩猎外套和卡其褶裙","cinched moss safari jacket and pleated khaki skirt"],
      ["营地粗布马甲","赭棕马甲、象牙袖衫与绿裤","ochre canvas vest, ivory long-sleeve shirt and moss trousers"],
      ["雨林攀行连身服","橄榄连身装、布质肘片膝片","olive cotton expedition jumpsuit with cloth elbow and knee patches"],
      ["峡谷织边外褂","铁锈色织纹披外套和亚麻裤","rust woven poncho-style short coat and linen trousers"],
      ["碎石机师短装","棕色工装夹克、深绿连身内搭","warm brown cropped weathered jacket and moss overalls"],
      ["博物馆旅行裙装","米色人字纹西装和赭色长裙","cream herringbone blazer and long rust skirt"],
      ["晨光亚麻行装","米色亚麻衬衫长裙和织边","cream full-length linen shirt dress with large pockets and woven ochre trim"],
    ],
    men: [
      ["石碑考察夹克","苔绿猎装和砂色长裤","moss khaki safari coat and sand trousers with dark elbows"],
      ["古道防尘长衣","赭色帆布长风衣与青绿便裤","ochre expedition duster with storm-flap canvas and olive trousers"],
      ["地图室工装","橄榄帆布短衣、米色宽工装裤","olive duck canvas jacket and pleated tan cargo trousers"],
      ["营地粗布马甲","棕马甲、象牙亚麻衫和绿裤","brown vest over long-sleeve ivory linen shirt and moss trousers"],
      ["雨林修补服","苔绿连身装、叠缝布质补丁","moss mechanic jumpsuit with canvas elbow and knee patches"],
      ["峡谷织边披肩","赤褐短肩披和亚麻裤","rust wool expedition shoulder cape on brown jacket and straight linen trousers"],
      ["远航机师短装","棕皮飞行夹克、橄榄宽工装裤","russet aviator leather-look jacket and loose moss trousers"],
      ["博物馆旅行西装","米色纹理猎装、同色三件套","ivory herringbone safari suit with vest and warm rust folded shirt collar"],
      ["暮色亚麻行装","米白亚麻短褂和赭色宽裤","cream linen field tunic with fabric knot front and dark ochre trousers"],
    ],
  },
  { key: "western", title: "荒原列车", genre: "美式西部",
    palette: ["#9D5739","#3E566B","#C3A178"], tagline: "靛蓝牛仔、磨砂麂皮和沙色防尘大衣，来自经典西部片的服装轮廓。",
    women: [
      ["铁道蓝牛仔装","靛蓝牛仔夹克和宽腿牛仔裤","indigo denim ranch jacket and matching wide jeans"],
      ["赭地麂皮短衣","赭色短麂皮外套与布流苏","russet suede-look jacket with sewn fringe and straight jeans"],
      ["黄昏马车长裙","烟粉高领先驱长裙和层叠裙摆","dusty rose high-neck pioneer dress with tiered full hem"],
      ["旧镇格纹套装","砖红米白格纹衣和深蓝高腰裤","brick-and-ivory plaid shirt and high-waist slate denim trousers"],
      ["风沙长外套","驼色防尘长外套和砂裤","camel weathered long duster and sand slacks"],
      ["车站黑绒礼裙","墨蓝黑丝绒旧式长裙与白窄边","navy-black full-length velvet town dress with ivory piping"],
      ["雪线羔绒夹克","驼色羔绒夹克和深靛裤","camel shearling-look ranch jacket with light lining and black denim"],
      ["旷野皮质马甲","棕马甲、高领衬衣与牛仔裙","brown leather-look vest over ivory blouse and indigo skirt"],
      ["邮路拼布旅行衣","锈色与靛蓝拼布外套和黑裤","rust and indigo patchwork coat with sand cuffs and black trousers"],
    ],
    men: [
      ["沿线铁路牛仔装","靛蓝牛仔夹克和深色牛仔裤","indigo denim ranch work jacket with ochre topstitch and matching jeans"],
      ["荒地流苏皮衣","锈棕麂皮夹克、炭灰牛仔裤","russet suede-look ranch jacket with fine chest fringe and charcoal jeans"],
      ["夕照车夫长大衣","黄褐长外套与宽领襟","dark tan western carriage coat with broad lapels over sand trousers"],
      ["旧镇格纹马甲装","砖米格纹衫、棕马甲和黑裤","brick plaid shirt under brown vest and dark jeans"],
      ["风沙分片外套","沙棕防尘长衣、分片护肩","weathered ochre long duster with sloped storm panels"],
      ["黑绒镇长正装","墨黑丝绒礼衣和象牙白衫","navy-black velvet frock coat, cream long-sleeve shirt and dark trousers"],
      ["雪线羔绒皮衣","驼色羔绒夹克、石洗蓝裤","camel shearling-look jacket with ecru collar and stonewashed denim"],
      ["旷野粗革马甲","牛血色马甲、长袖奶油衫和靛裤","oxblood leather-look ranch vest, cream shirt and indigo jeans"],
      ["邮路撞色工装","锈红拼蓝短衣、沙色袖口","rust and indigo stitched patch jacket with camel cuffs and charcoal denim"],
    ],
  },
  { key: "gala", title: "午夜首映", genre: "黄金年代",
    palette: ["#62223E","#21645A","#CFBEA9"], tagline: "好莱坞黄金年代的首映夜，取材于装饰艺术纹路、丝绒和宽翻领。",
    women: [
      ["银线首映长裙","银灰丝绉、扇形缝线和长袖","silver-grey silk crepe gown with full sleeves and Art Deco fan stitching"],
      ["翡翠丝绒长裙","深绿丝绒包肩、柔顺斜褶","emerald velvet gown with sculpted shoulder and draped side"],
      ["酒红斜褶礼装","酒红缎面、斜褶和包领","burgundy satin full-length closed-shoulder dress with diagonal pleats"],
      ["香槟塔夫绸舞裙","香槟色塔夫绸和花瓣蓬裙","champagne taffeta modest ball gown with layered petal skirt"],
      ["墨夜珠纹披领","墨黑裙身和银灰织纹短披","ink-black full-length dress with sewn shoulder mantle and silver fabric bead pattern"],
      ["象牙白阔腿礼服","象牙白阔裤礼服和黑边翻领","ivory wide-leg jumpsuit with black Art Deco trim and tailored collar"],
      ["旧影蓝提花裙","深蓝提花直身长裙、菱形纹","midnight blue jacquard column gown with diamond pleats"],
      ["珊瑚酒会长裙","暗珊瑚缎面、叠边长裙和宽袖","muted dark coral full-length flounced cocktail gown with long wide sleeves"],
      ["金棕披肩礼裙","青铜金长裙、折扇肩褶","bronze gold draped long gown with pleated shawl shoulders"],
    ],
    men: [
      ["银雾燕尾礼服","银灰燕尾上装配白礼衫和黑裤","silver grey wool tailcoat over white shirt and black trousers"],
      ["翡翠绒面晚礼服","翡翠绿丝绒礼服与黑缎宽襟","deep emerald velvet dinner jacket with broad black lapels and black trousers"],
      ["酒红双排扣礼服","酒红长上衣、方肩和深裤","burgundy double-breasted long evening jacket with structured shoulders"],
      ["香槟白晚宴礼服","香槟白外衣和黑马甲","warm ivory dinner jacket with black waistcoat and ivory trousers"],
      ["午夜织纹长礼衣","漆黑织纹长礼衣和白立领衫","black long frock with shadow-silver jacquard and white collar"],
      ["黑白三件套","象牙白与黑色几何宽领","ivory and charcoal three-piece suit with Art Deco lapel edging"],
      ["深蓝提花晚礼服","深蓝扇纹提花与挺括直裤","midnight navy jacquard evening suit with fan weave and straight pants"],
      ["珊瑚绒领正装","暗珊瑚色上衣和酒红绒领","deep coral red jacket with oxblood velvet lapel and charcoal trousers"],
      ["金棕舞会礼装","铜棕阔襟外衣和金棕马甲","bronze brown broad-lapel evening jacket, gold waistcoat and dark pants"],
    ],
  },
  { key: "relic", title: "古城传奇", genre: "年代史诗",
    palette: ["#426366","#89505A","#D8B987"], tagline: "铜线织锦、青石色礼衣和海纹披肩，以虚构港城为背景。",
    women: [
      ["铜纹披肩长袍","铜棕刺绣长袍和叠片肩披","bronze brown embroidered full-length robe with fabric mantle"],
      ["青石护城服","青色长衣、方肩和直裤","deep teal embroidered long tunic and trousers with soft padded shoulder"],
      ["白石王庭长裙","象牙白直身长裙和织腰片","ivory floor-length column robe with woven waist inset and long sleeves"],
      ["赭红议事礼服","赭红褶裙和铜色袖边","oxblood floor-length closed robe with deep pleats and copper sleeve border"],
      ["港城海纹披袍","青绿叠层长袍和波纹边","dark teal layered robe with scalloped woven marine hem"],
      ["沙色斜襟长裙","砂金高领斜襟礼裙和宽袖","sand cross-front fully opaque floor-length gown with wide long sleeves"],
      ["铜河织锦大衣","桂棕织锦大衣和浅色裤","cinnamon-brown brocade coat over ivory trousers"],
      ["青铜绒面裙袍","青铜色立领长裙和绒面拼片","aged copper high-collar modest dress with velvet panels"],
      ["夜堡银边礼裙","深青近黑长衣和银织高领","near-black teal gown with silver woven cuffs and outlined high neck"],
    ],
    men: [
      ["铜纹城卫长衣","铜棕长外衣、软绗方肩和深裤","bronze-brown long coat with padded shoulders and brown trousers"],
      ["青石礼卫制服","青灰长衣、方袖边和黑裤","deep teal half-length tunic with squared embroidered cuffs and black trousers"],
      ["白石议庭袍","象牙白长袍、宽袖和砂边","ivory ankle-length robe with grand square sleeves and sand hem"],
      ["赭红城门礼装","赭红长礼衣、铜色胸织带","oxblood ceremonial tunic with woven chest bands and dark wool trousers"],
      ["港城海纹外褂","青绿色高领衣和宽边波纹","petrol teal long coat with raised collar and broad wave-pattern hem"],
      ["王庭斜襟仪仗服","砂棕交襟长衣和深棕裤","sand cross-front long royal tunic with copper seam and dark trousers"],
      ["铜河织锦长袍","斑铜刺绣外袍和象牙白内衣","old copper double-breasted embroidered outer robe over ivory tunic"],
      ["青铜剧场外衣","青铜绒袍和宽阔肩背","aged bronze velvet robe with broad theater shoulders and high neck"],
      ["夜堡银边正装","深青黑及膝衣、银线和深裤","black teal knee-length coat with silver contour seams and opaque dark trousers"],
    ],
  },
];

const collections = themes.flatMap(theme => (["women", "men"] as const).map(category => {
  const categoryLabel = category === "women" ? "女装" : "男装";
  const id = `cinema-${theme.key}-${category}`;
  const label = `${theme.title} · ${categoryLabel}`;
  const series = Object.freeze({
    id, label, category, categoryLabel,
    tagline: `${theme.genre} · ${theme.tagline}`,
    palette: Object.freeze([...theme.palette]),
  });
  const styles = theme[category].map(([name, description, cut], index) => Object.freeze({
    id: `${id}-${index + 1}-v1`, label: name, description, seriesId: id, seriesLabel: label,
    minAge: 0, maxAge: 100, minPeople: 1,
    instruction: `${cut}. Apply the original cinematic costume to visible clothing only. Keep believable textile, folds and seams. Preserve faces, identity, displayed age, gender presentation, body shape, hair, hands, pose, lighting and background. Use opaque modest age-appropriate variants, with soft kid-safe fabric and closures for infants or children. Do not add headwear, visible props, weapons, logos, emblems, text, watermarks or recognizable character likeness.`,
  }));
  return { series, styles };
}));
export const CINEMA_WARDROBE_SERIES = Object.freeze(collections.map(entry => entry.series));
export const CINEMA_WARDROBE_STYLES = Object.freeze(collections.flatMap(entry => entry.styles));
