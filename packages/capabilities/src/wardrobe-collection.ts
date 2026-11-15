// Discovery metadata is descriptive. It never claims measured generation quality.
export const WARDROBE_CATALOG_VERSION = "lifetime-wardrobe.v2";
type Series = Readonly<{ id: string; label: string; category: string; categoryLabel: string; tagline: string; palette: readonly string[] }>;
const collection = (id: string, label: string, category: string, categoryLabel: string, tagline: string, palette: string[]): Series =>
  Object.freeze({ id, label, category, categoryLabel, tagline, palette: Object.freeze(palette) });
export const WARDROBE_SERIES: readonly Series[] = Object.freeze([
  collection("east", "新中式 · 东方岁月", "oriental", "东方雅韵", "盘扣与交领，把东方韵致穿进每一岁。", ["#E9DED0", "#8A9B86", "#80675C"]),
  collection("retro", "复古 · 时光照相馆", "cinema", "复古映画", "从八十年代到千禧，重逢旧日衣着。", ["#C2A488", "#705C58", "#D9CABA"]),
  collection("together", "情侣 · 陪你到白头", "occasion", "相聚时刻", "同一个色调，两份各自合身的温柔。", ["#D8B8AF", "#F1E8DD", "#8E827C"]),
  collection("daily", "简约 · 质感日常", "everyday", "日常有型", "白衬衫、奶油针织，简单也有好质感。", ["#F1E9D9", "#B4BBA5", "#7C8B7A"]),
  collection("wedding", "婚礼 · 周年纪念", "occasion", "相聚时刻", "从简约礼服到中式喜服，珍藏仪式感。", ["#F2E6D8", "#B99A75", "#8D4C4B"]),
  collection("milestone", "人生 · 重要时刻", "occasion", "相聚时刻", "为毕业、生日与人生新章换一套衣着。", ["#EAD7B6", "#767F93", "#695D62"]),
  collection("winter", "冬日衣橱", "nature", "四季漫游", "毛呢、绞花与围巾，穿得暖也穿得好看。", ["#D7E3E6", "#9DAEC4", "#6D7A8A"]),
  collection("newyear", "新年团圆", "oriental", "东方雅韵", "把新年的红，织进一张团圆纪念。", ["#AA4649", "#D7B27E", "#F0DFCE"]),
  collection("french", "法式 · 巴黎来信", "cinema", "复古映画", "海魂条纹与软呢滚边，轻轻穿出法式感。", ["#F1E5D4", "#253C58", "#B95A56"]),
  collection("british", "英伦 · 庄园旧梦", "cinema", "复古映画", "人字呢、细格纹，沉静而有故事的层次。", ["#A08B69", "#556C5B", "#E5DAC6"]),
  collection("film", "电影 · 光影主角", "cinema", "复古映画", "香槟缎与深色剪裁，衣着自有主角感。", ["#DDC7A6", "#383B45", "#7B3B48"]),
  collection("atelier", "高定 · 鎏光礼遇", "occasion", "相聚时刻", "克制的珠光与立体裁线，为郑重一刻。", ["#E4D4C3", "#686778", "#A99069"]),
  collection("ink", "国风 · 水墨留白", "oriental", "东方雅韵", "月白、墨竹与茶褐，让衣纹像一幅画。", ["#EDEAE0", "#6E837D", "#4B5351"]),
  collection("dunhuang", "国风 · 敦煌织梦", "oriental", "东方雅韵", "赭石与石绿，化作衣上的流动纹样。", ["#BA8058", "#6F9489", "#D9B77C"]),
  collection("garden", "花园 · 花间来信", "nature", "四季漫游", "细碎花纹与雾感色彩，把春意穿在身上。", ["#D8A8AA", "#A9B69B", "#EEE3CE"]),
  collection("coast", "海岛 · 蔚蓝假日", "nature", "四季漫游", "蓝白棉麻与落日暖色，清爽度假衣橱。", ["#79A9C1", "#EAE5D6", "#D39371"]),
  collection("city", "都市 · 松弛通勤", "everyday", "日常有型", "燕麦、雾灰与低饱和层次，利落不紧绷。", ["#C9BBA7", "#7E8992", "#EBE6DE"]),
  collection("utility", "机能 · 城市漫游", "everyday", "日常有型", "立体口袋与哑光面料，轻装走自己的路。", ["#727E70", "#D0C4AC", "#434E59"]),
  collection("outdoor", "山野 · 轻户外", "nature", "四季漫游", "苔绿、岩灰与山系拼色，衣着自在有型。", ["#829377", "#B6A18A", "#697E8B"]),
  collection("sport", "运动 · 元气日常", "nature", "四季漫游", "干净的拼色与运动织物，穿出轻快精神。", ["#EADECE", "#6B8F82", "#C77855"]),
  collection("academy", "学院 · 青春书页", "everyday", "日常有型", "针织背心与学院格纹，重读一页青春。", ["#586B62", "#E5DDCB", "#867184"]),
  collection("storybook", "童话 · 小小奇遇", "family", "童年银龄", "星星、小森林与糖果色，属于童年的想象。", ["#AFC7C1", "#E3BAA5", "#B7B2D7"]),
  collection("baby", "童年 · 软糯时光", "family", "童年银龄", "柔软棉织、圆领与小小刺绣，留住软糯一岁。", ["#EEDBC2", "#CBDBD2", "#D8B6AB"]),
  collection("heritage", "银龄 · 从容风华", "family", "童年银龄", "羊绒、绢棉与温润色彩，岁月自有风度。", ["#B4A58C", "#8F9D99", "#756176"]),
]);

type Look = [key: string, label: string, description: string, instruction: string];
const looks = (seriesId: string, entries: Look[], minAge = 0, maxAge = 100) => {
  const group = WARDROBE_SERIES.find(item => item.id === seriesId)!;
  return entries.map(([key, label, description, instruction]) => Object.freeze({
    id: `${seriesId}-${key}-v1`, label, description, seriesId, seriesLabel: group.label, minAge, maxAge, minPeople: 1,
    instruction: `${instruction}. Render the specified fabric weave, seam construction, realistic thickness and gravity-led folds; adapt the cut to the visible body and source gender presentation without reshaping it. Keep any pattern confined to the garment, with no readable text, logos or brand marks. Use opaque, modest, age-appropriate coverage and safe infant/child sizing; no adult styling of children. Edit only visible clothing; preserve faces, exact displayed age, hair, hands, pose, body shape, person positions, lighting and background. Do not add hats, jewelry, handheld props, scenery or photo filters.`,
  }));
};
export const ADDITIONAL_WARDROBE_STYLES = Object.freeze([
  ...looks("french", [
    ["mariniere", "海魂来信", "奶油白棉织 · 海军蓝细条 · 平整圆领", "Cream cotton Breton knit top with narrow navy horizontal stripes, a modest round neckline and a clean bound collar"],
    ["tweed", "奶油软呢", "奶油米软呢 · 深蓝滚边 · 小圆扣", "Cream boucle tweed jacket with fine navy piping along the collar and placket, small matte round buttons and an opaque inner top"],
    ["cardigan", "莓果开衫", "莓果红细针织 · 象牙白内搭 · 短罗纹", "Muted berry-red fine-gauge cardigan over an ivory cotton top, tiny fabric-covered buttons and short ribbed cuffs"],
    ["linen", "燕麦午后", "燕麦亚麻 · 细密褶线 · 柔和方领", "Oatmeal linen blouse or shirt with a modest softly squared collar, narrow pintucks and natural slub texture"],
  ]),
  ...looks("british", [
    ["herringbone", "栗色人字呢", "栗棕羊毛 · 人字纹 · 经典驳领", "Chestnut-brown wool herringbone jacket with neat notched lapels, inset welt pockets and an ivory opaque shirt"],
    ["argyle", "森林菱格", "森林绿针织 · 驼色菱格 · 衬衫叠穿", "Forest-green knit vest with restrained camel argyle diamonds over a soft cream collared shirt, fitted without changing body shape"],
    ["check", "雾蓝格纹", "雾蓝细格 · 磨毛棉 · 对齐门襟", "Misty-blue brushed cotton shirt with fine aligned windowpane checks and a soft charcoal wool waistcoat"],
    ["corduroy", "焦糖灯芯绒", "焦糖灯芯绒 · 细纵棱 · 圆润领角", "Caramel fine-wale corduroy jacket with rounded collar points, tonal buttons and a plain warm-beige inner layer"],
  ]),
  ...looks("film", [
    ["champagne", "香槟片段", "香槟缎 · 柔光褶面 · 包覆领口", "Champagne satin occasion top or covered dress bodice with soft asymmetric garment pleats, a modest closed neckline and restrained fabric sheen"],
    ["noir", "黑白序章", "炭黑精纺 · 象牙白内搭 · 利落线条", "Charcoal-black fine wool jacket with clean satin-free lapels over a high-coverage ivory shirt, precise monochrome tailoring"],
    ["burgundy", "酒红丝绒", "深酒红丝绒 · 哑光翻领 · 细滚边", "Deep burgundy velvet jacket with a matte shawl collar, narrow tonal piping and an opaque dark inner layer; show realistic velvet pile"],
    ["jade", "翡翠年代", "翡翠绿绉纱 · 收褶肩线 · 同色暗扣", "Muted jade-green opaque crepe blouse or shirt with restrained shoulder tucks, tonal covered buttons and a tidy stand collar"],
  ]),
  ...looks("atelier", [
    ["pearl", "珍珠光泽", "珍珠白提花 · 立体裁线 · 不加珠宝", "Pearl-white opaque jacquard formal jacket or covered gown bodice, sculptural garment seams and subtle woven pearlescence without jewelry"],
    ["midnight", "午夜蓝缎", "午夜蓝厚缎 · 流线褶裥 · 高覆盖剪裁", "Midnight-blue heavyweight satin formalwear with flowing garment pleats, a high-coverage neckline and clean structured shoulder seams"],
    ["rose", "玫瑰浮雕", "灰玫瑰提花 · 同色花纹 · 精致包边", "Dusty-rose tonal floral jacquard formal jacket or covered dress bodice with small woven relief flowers and neatly bound edges"],
    ["silver", "月银细褶", "月银绉缎 · 细密压褶 · 柔和反光", "Soft moon-silver opaque crepe satin formal top with narrow pressed pleats, modest neckline and gentle non-metallic highlights"],
  ], 18),
  ...looks("ink", [
    ["moon", "月白交领", "月白绢棉 · 浅灰交领 · 细斜纹", "Moon-white silk-cotton cross-collar garment with light gray collar binding, fine twill weave and restrained overlapping front panels"],
    ["bamboo", "墨竹清风", "竹青苎麻 · 墨色竹叶绣 · 小立领", "Bamboo-green ramie mandarin-collar shirt with sparse dark bamboo-leaf embroidery confined to one garment panel and fine natural slubs"],
    ["tea", "茶褐长衫", "茶褐棉麻 · 素色盘扣 · 宽松直线", "Tea-brown cotton-linen Chinese long jacket with tonal knotted buttons, relaxed straight garment lines and softly creased sleeves"],
    ["mist", "青岚叠襟", "青灰绉棉 · 双层叠襟 · 素雅压线", "Misty blue-gray crepe-cotton layered Chinese-inspired top with a double overlapping placket and fine tonal topstitching"],
  ]),
  ...looks("dunhuang", [
    ["ochre", "赭金流纹", "赭石绢棉 · 暗金流纹 · 包覆交领", "Ochre silk-cotton cross-collar garment with restrained antique-gold curving embroidery confined to the collar and sleeve edges, opaque coverage"],
    ["mineral", "石绿回响", "石绿织锦 · 沙金边饰 · 细密几何纹", "Mineral-green brocade jacket with narrow sand-gold borders and small geometric woven motifs, a modest upright collar and realistic fabric weight"],
    ["sand", "沙色织梦", "沙杏亚麻 · 朱砂细纹 · 宽缓袖口", "Sand-apricot linen robe-inspired top with sparse cinnabar geometric embroidery, softly bounded sleeves and natural cloth drape"],
    ["lapis", "青金锦章", "青金蓝提花 · 米金滚边 · 对称衣纹", "Lapis-blue opaque jacquard top with muted pale-gold piping and symmetrical small cloud-like woven motifs; no headdress or floating ribbons"],
  ]),
  ...looks("garden", [
    ["rose", "蔷薇细语", "灰粉棉布 · 小蔷薇纹 · 柔软圆领", "Dusty-pink cotton top with tiny muted rose prints confined to the cloth, a soft round collar and narrow gathered sleeve seams"],
    ["sage", "鼠尾草绿", "鼠尾草绿棉麻 · 叶脉暗纹 · 木色扣", "Sage-green cotton-linen shirt with subtle woven leaf-vein texture, small wood-tone buttons and relaxed natural sleeve folds"],
    ["lilac", "雾紫花笺", "雾紫绉棉 · 白色花点 · 细褶门襟", "Misty-lilac opaque crepe-cotton blouse or shirt with sparse white micro-floral dots and a modest finely pleated placket"],
    ["butter", "奶油小雏菊", "奶油黄棉织 · 小雏菊刺绣 · 窄罗纹", "Butter-yellow cotton knit top with a few small embroidered daisies on the chest, narrow ribbed cuffs and a neat covered neckline"],
  ]),
  ...looks("coast", [
    ["azure", "蔚蓝亚麻", "蔚蓝亚麻 · 象牙白滚边 · 舒展剪裁", "Azure linen shirt with ivory collar binding, breathable visible slub weave and a modest relaxed cut over an opaque inner layer"],
    ["sail", "白帆棉织", "白色绞花 · 浅沙色领边 · 细针织", "Sail-white fine cotton cable-knit top with pale-sand collar and cuff accents, a closed neckline and lightweight natural drape"],
    ["sunset", "落日陶橘", "陶橘棉麻 · 竖向细褶 · 小方扣", "Muted terracotta cotton-linen resort shirt with narrow vertical pintucks, small square matte buttons and covered shoulders"],
    ["seafoam", "海盐薄荷", "海盐薄荷色 · 泡泡纱纹 · 蓝白细条", "Seafoam-mint seersucker shirt with thin blue-white stripes, fine puckered cotton texture and softly rounded collar points; no swimwear"],
  ]),
  ...looks("city", [
    ["oat", "燕麦轻西装", "燕麦混纺 · 软肩驳领 · 象牙白内搭", "Oatmeal soft-shouldered woven blazer over an ivory cotton top, natural notched lapels and tonal welt pockets"],
    ["slate", "雾灰叠穿", "雾灰针织 · 白色衬领 · 细密罗纹", "Mist-gray fine-knit pullover layered over a clean white collared shirt, narrow ribbed cuffs and a relaxed structured silhouette"],
    ["coffee", "摩卡垂感", "摩卡棕斜纹 · 同色暗扣 · 平整肩线", "Mocha-brown fluid twill shirt with hidden tonal buttons, clean shoulder seams and realistic gravity-led fabric drape"],
    ["olive", "橄榄短夹克", "橄榄绿棉斜纹 · 弧形口袋 · 哑光按扣", "Muted olive cotton-twill short jacket with curved patch pockets, matte snap buttons and a plain light-beige opaque inner layer"],
  ]),
  ...looks("utility", [
    ["graphite", "石墨机能", "石墨灰尼龙 · 立体口袋 · 隐藏拉链", "Graphite-gray matte nylon utility jacket with shallow three-dimensional pockets, a concealed zipper and restrained articulated garment seams"],
    ["sand", "沙丘工装", "沙卡其棉布 · 双线车缝 · 小贴袋", "Sand-khaki cotton canvas workwear jacket with realistic double topstitching, small flat patch pockets and dark matte buttons"],
    ["sage", "苔绿拼接", "苔绿棉尼龙 · 岩灰拼片 · 圆弧裁线", "Moss-green cotton-nylon jacket with restrained rock-gray paneling and curved garment seam lines; no equipment or straps outside clothing"],
    ["navy", "深蓝轻壳", "深海蓝轻壳 · 细密防撕裂格 · 平整领口", "Deep navy lightweight ripstop shell jacket with fine grid texture, a low stand collar and a neat front zipper; keep any hood down and out of the face"],
  ]),
  ...looks("outdoor", [
    ["moss", "苔原抓绒", "苔绿抓绒 · 米色包边 · 细密绒面", "Moss-green microfleece jacket with beige bound edges, a short covered zipper and believable soft low-pile fleece texture"],
    ["rock", "岩灰轻壳", "岩灰哑光壳 · 蓝灰拼肩 · 防水压线", "Rock-gray matte shell jacket with muted blue-gray shoulder panels and subtle taped garment seams, no backpack or outdoor equipment"],
    ["maple", "枫叶暖棉", "枫糖棉布 · 菱格薄绗 · 灯芯绒领", "Maple-caramel lightweight quilted cotton jacket with small diamond stitching, a soft corduroy collar and an opaque neutral inner shirt"],
    ["lake", "湖蓝叠穿", "湖蓝摇粒绒 · 石色马甲 · 细织带包边", "Lake-blue fine fleece top layered under a stone-beige lightweight woven vest with narrow fabric-bound edges and natural garment thickness"],
  ]),
  ...looks("sport", [
    ["tennis", "奶油网球风", "奶油白珠地棉 · 森林绿领线 · 小纽扣", "Cream-white pique cotton polo top with narrow forest-green collar stripes, tiny matte buttons and a modest covered placket, without sporting equipment"],
    ["track", "复古运动线", "海军蓝针织 · 米白肩线 · 直线拉链", "Navy knit track jacket with narrow cream shoulder stripes, a neat center zipper and softly ribbed cuffs; no logos or team emblems"],
    ["peach", "蜜桃卫衣", "浅蜜桃毛圈棉 · 奶油罗纹 · 柔软圆领", "Pale-peach loopback cotton sweatshirt with cream ribbed collar and cuffs, realistic medium-weight jersey and relaxed age-appropriate fit"],
    ["mint", "薄荷拼色", "薄荷灰运动织物 · 雾蓝拼片 · 平整缝线", "Mint-gray opaque sports-knit top with misty-blue panels, flatlock garment seams and a comfortable closed neckline"],
  ]),
  ...looks("academy", [
    ["forest", "常春藤针织", "深绿针织背心 · 白色衬领 · 米色V线", "Deep ivy-green fine-knit vest over a white collared shirt, modest cream V-neck binding and ribbed hem, no school badge or institutional logo"],
    ["check", "书页格纹", "米咖细格西装 · 同色包扣 · 深色内搭", "Beige-coffee small-check school-inspired blazer with tonal fabric-covered buttons and a plain opaque dark inner shirt, no insignia"],
    ["navy", "海军蓝开衫", "海军蓝棉针织 · 象牙白门襟 · 小圆扣", "Navy cotton-knit cardigan with ivory placket edges and small round buttons over a modest white inner top"],
    ["plum", "梅紫麻花", "浅梅紫麻花针织 · 细圆领 · 层次衬领", "Soft muted-plum cable-knit sweater with a narrow round neckline over a cream collared shirt, show individual yarn loops and soft garment volume"],
  ], 6),
  ...looks("storybook", [
    ["forest", "小森林日记", "苔绿灯芯绒 · 米白圆领 · 小叶刺绣", "Child-sized moss-green fine corduroy vest over a cream cotton round-collar shirt, tiny leaf embroidery on the cloth and safe flat fastenings"],
    ["stars", "星星睡前诗", "雾蓝柔棉 · 淡金小星 · 圆领包边", "Child-sized misty-blue soft cotton top with tiny pale-gold stitched star motifs, a safe bound round neckline and covered comfortable fit"],
    ["candy", "糖果拼拼", "浅杏与薄荷 · 双色棉织 · 圆弧口袋", "Child-sized apricot and mint color-block cotton outfit with small rounded flat pockets, soft covered seams and no dangling decorations"],
    ["cloud", "云朵小诗人", "云白绗棉 · 浅紫包边 · 小云纹绣", "Child-sized cloud-white softly quilted cotton top with pale-lilac bound edges and small cloud embroidery, modest round neckline and safe simple closures"],
  ], 0, 12),
  ...looks("baby", [
    ["milk", "奶油小团子", "奶油白罗纹棉 · 包边圆领 · 平整暗扣", "Infant or young-child sized cream-white ribbed cotton top or one-piece according to the visible source clothing region, flat concealed snap fastenings and safe bound collar"],
    ["peach", "蜜桃绵绵", "浅蜜桃毛圈 · 米白圆领 · 小桃刺绣", "Infant or young-child sized pale-peach terry-cotton garment with ivory round collar binding and tiny peach embroidery, no loose trims or adult tailoring"],
    ["sage", "芽芽针织", "嫩芽绿棉针织 · 细密纹路 · 柔软袖口", "Infant or young-child sized pale-sage fine cotton knit garment with gentle ribbed cuffs, closed soft neckline and smooth safe flat seams"],
    ["biscuit", "小饼干格格", "饼干米细格 · 柔棉圆领 · 平整贴袋", "Infant or young-child sized biscuit-beige small-gingham cotton garment with rounded collar, flat patch pockets and soft safe fastenings"],
  ], 0, 6),
  ...looks("heritage", [
    ["cashmere", "燕麦羊绒", "燕麦羊绒 · 温润细绒 · 舒适圆领", "Refined oatmeal cashmere cardigan or pullover with fine soft nap, an easy covered neckline and comfortable natural fit; preserve existing age and hair"],
    ["jade", "玉色绢棉", "浅玉绿绢棉 · 小立领 · 同色暗纹", "Pale jade silk-cotton mandarin-collar shirt with subtle tonal woven pattern, small covered buttons and comfortable unrestrictive sleeves"],
    ["plum", "梅紫锦纹", "沉静梅紫提花 · 素色滚边 · 端正肩线", "Quiet plum-purple opaque jacquard jacket with restrained geometric woven texture, plain tonal piping and soft structured shoulder seams"],
    ["sand", "暖砂轻呢", "暖砂轻羊毛 · 炭灰内搭 · 细驳领", "Warm sand-colored lightweight fine-wool jacket with a soft narrow lapel over a charcoal knit inner layer, refined seams and comfortable age-appropriate tailoring"],
  ], 50),
]);
