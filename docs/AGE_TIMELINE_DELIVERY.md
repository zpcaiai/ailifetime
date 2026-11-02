# 21 张年龄照片：本地交付闭环

> 最新进展（2026-11-02）：已接入提供的 AppID、单人/情侣与单年龄/21 年龄玩法。本文保留历史审查记录；当前验证与未完成边界见 [年龄玩法与验收状态](AGE_PLAY_MODES.md)。新 AppID 的合法域名联调受阻，真实模型与逼真度仍未验收。

2026-11-02，沿用当前栈与既有授权/签名证据机制。本页更新 AGE_GENERATION_AUDIT.md 中结果清单、时间轴、保存与恢复的历史缺口；真实模型与逼真度状态没有改变。

## 已实现的运行路径

`B14 计划 → 可信签名 resultManifest → 精确年龄/原图/质量/安全绑定 → SQL 命令记录 → 用户时间轴 → 鉴权原图下载 → 小程序相册 API`

1. `packages/core/src/timeline-results.ts` 定义 `ltm.timeline-results.v1`。一个清单必须与请求的原图、计划版本和全部目标年龄匹配；默认 21 个年龄 0、5……100。节点可以 ready、failed、review，缺失和失败不能凑成完成。年龄、资产 ID、图片摘要不能重复，清单禁止携带 URL、集合或状态补丁等任意控制字段。
2. `packages/providers/src/production-common.ts` 和 gateway 的 `partner-callbacks.ts` 只在 B14 可信回调中接受可选 `resultManifest`，将其纳入 canonicalClaims 签名绑定。其他路由不能携带它；旧 B14 回调无清单时继续保留旧协议，但不会被当作照片交付。
3. `packages/capabilities/src/external-business-event-reducers.ts` 在既有 SQL 事务内读取每张 ready 图对应的 B15/B17 记录。人物、租户、原图、资产 ID、输出 SHA256、目标年龄、质量维度和安全决定均须对应；缺少记录或不匹配则拒绝发布。ready 不是生成供应商自行填写就能通过的许可。
4. `services/api/src/timeline-delivery.ts` 返回按年龄排序的节点状态、已完成数量、缺失年龄及恢复状态；不依赖普通用户无权读取的内部 external-command 诊断接口。每次读取仍走原有所有者、目的、人物同意检查。
5. 小程序作品库提供完整年龄轴、当前年龄预览、原图尺寸、保存原图、单年龄重试和刷新。子重试不会单独冒充一套新作品。页面重开后从服务端读取原任务和重试记录，客户端不持久化令牌或私密媒体。

## API 合同

以下请求均需要正常 bearer 会话及 `X-Purpose: age_transformation`，不能用 URL 携带令牌。

| 请求 | 行为 |
|---|---|
| `GET /v1/timelines/{commandId}` | 返回原始计划与重试合并后的节点、计数、缺失年龄、授权下载路径及原图存储可用状态 |
| `POST /v1/timelines/{commandId}/retry` | 只接受 `{targetAge, attempt}`，attempt 为 1..3，需要 Idempotency-Key；不直接调用模型 |
| `GET /v1/timelines/{commandId}/nodes/{targetAge}/image` | 读取原图前后重新鉴权，校验字节数和摘要；返回原 PNG/JPEG、SHA256 头、AI 标记头及 private/no-store |

详见 `services/api/openapi.yaml` 的 TimelineResultManifest / TimelineDeliveryResponse / TimelineImageAsset。

### 回调节点

ready 节点包含 nodeId=`age-N`、targetAge、资产元数据、qualityResultId、safetyResultId。资产元数据只有 id、sha256、mimeType、width、height、byteLength；没有外部下载 URL。失败/复核节点包含受限 errorCode，不能夹带图像。

B15/B17 的新可选 artifactBinding 为 `{sourceAssetId, assetId, outputSha256, targetAge}`。用于图片发布的 B15 必须有身份、年龄、五官漂移、姿态、伪影、清晰度、背景、眼牙手、逼真度九项有效分数/阈值并通过，B17 必须允许输入/输出并带 AI 标识。既有专用权限与同意检查保留；旧未绑定的声明不能作为逐图发布证据。

这只是可信权威的入站合同。测试中的合成报告不证明真实评估器已实现、阈值已校准或真人照片已达到逼真度要求。

## 原图与本地存储

`FileTimelineArtifactStore` 实际写入和读取按内容摘要寻址的文件，检查大小、MIME/尺寸头和 SHA256，拒绝路径注入/软链接/被替换的内容。原图保存不经过压缩或放大。它不提供图像审美或真人质量测量。

开发时可显式设置 `LTM_TIMELINE_MEDIA_DIRECTORY` 为绝对、任务专用目录。API 只在 local/test 启动配置中接受此选项；生产拒绝这个本地文件回退。未配置原图 reader 时返回 mediaAvailable=false，不能伪造图片 URL。生产需要接入批准的对象存储 reader，仍须通过同一下载鉴权和摘要检查。

小程序 `services/timeline-media.js` 从同一个受信 API origin 下载，以内存会话鉴权，逐块核对原图 SHA256、字节数、尺寸后才展示或调用 `wx.saveImageToPhotosAlbum`。每次下载显式写入 `wx.env.USER_DATA_PATH` 下独立随机文件；平台默认 `http://tmp` 下载缓存不允许 unlink，不能用于声称可控删除。原图读取使用 ArrayBuffer 内建二进制类型检查，兼容微信跨环境返回的缓冲区并拒绝伪造对象。每次保存重新下载/鉴权，不复用之前的预览来绕过撤回；隐藏、退出或授权失败会清理私有文件，删除失败的路径保留在待清理集合供再次清理。相册权限拒绝会提示用户，不强行打开设置或反复申请。

## 失败恢复

- 每个年龄至多 3 个显式恢复尝试。SQL 外部命令 ID 由原任务、年龄、attempt 确定；重放同一次尝试返回原命令，页面重启也不会另造同一尝试。
- 活跃/未知副作用的任务不发起新尝试。旧回调仅有 succeeded 而无结果清单时进入待对账，不重新收费“试一次”。
- POLICY_BLOCKED、review、补偿及已耗尽尝试不会自动绕过；其他已通过年龄保持可读，单年龄失败不会清空整组。
- 新恢复仍使用最初原图与同意、版本化计划及目标年龄，不能用上一个年龄输出替换身份锚点。
- 下载失败可重新读取相同原图，损坏/摘要不匹配/授权撤回不会交给相册。前后台异步迟到结果不能恢复已清理的私密预览。

## 本地复现与明确边界

运行已安装依赖的测试，不需要模型凭据、真实人像或付费调用：

```sh
pnpm --filter @ltm/core build
pnpm --filter @ltm/providers build
pnpm --filter @ltm/capabilities build
pnpm --filter @ltm/api test
pnpm --filter @ltm/integration-gateway test
pnpm --filter @ltm/wechat-mini-core test
```

`services/api/test/timeline.http.test.mjs` 创建实际文件 SQLite、真实签名回调、实际 HTTP 服务和 21 张明确合成的 1024×1024 PNG，走 20 张通过/1 年龄失败 → 单年龄重试 → 21 张 → 原字节下载 → 数据库关闭重开 → 撤回同意后拒绝下载，并在结束时清理自己的临时目录。测试没有人像，没有图像生成或质量测量模型。

`apps/wechat-mini/tools/timeline-media.test.mjs` 使用实际 loopback HTTP/文件系统验证下载、摘要和原字节保留；微信相册 API 通过测试边界适配，不能当作微信真机或系统相册验收。页面脚本测试覆盖 21 节点、切换、恢复、权限拒绝及后台清理。

最终在本任务专用 PostgreSQL 17.5 测试库中，使用现有校验和绑定迁移及最小权限运行角色，串行完成 core、providers、capabilities、API、workers、integration-gateway、wechat-mini-core、experience-platform 八包回归：450 项全部通过，零失败、零跳过。原先因未配置数据库而跳过的 11 项现已实际执行通过；测试库已正常关闭，原始跳过记录与本次执行证据均保留。这不代表新增时间轴已做 PostgreSQL 专项全链路或生产负载验收；21 图交付全链路使用上文的真实 SQLite/HTTP/文件系统。

当前仍未完成：真实供应商/模型接入和计费控制的部署验收、授权真人样片的身份/年龄/逼真度测量与盲评、生产对象存储、真实 AppID 平台授权弹窗和微信真机验收。以上保持 NOT_RUN / NOT_CERTIFIED。没有部署、付费推理或生产认证。

## 微信开发者工具联调（2026-11-02）

已在本机实际运行 Stable 2.01.2510290、基础库 3.7.12，通过官方 miniprogram-automator 0.13.0 驱动真实模拟器。测试使用独立 SQLite、真实 API/下载/文件系统、签名回调和明确合成的 21 张 PNG；没有调用出图模型。测试配置与合成会话仅由测试工具临时注入，结束后撤销，不写入小程序生产登录流程。

实际修复三处工具联调暴露的问题：app.json 错把 chooseMedia 写入只支持地址/位置接口的 requiredPrivateInfos；跨环境 ArrayBuffer 被 instanceof 误拒绝；平台只读下载缓存导致删除无效。隐私平台检查、授权事件、原图摘要和尺寸检查均保留。

10 项实际模拟器检查通过：21 节点渲染、横向滚动到 100 岁、选择失败年龄、单年龄重试后 21/21、原字节一致、调用保存接口、相册拒绝后的保存文件清理、隐私拒绝前不下载且清理预览、实际 tab 隐藏/重开恢复、丢失响应重放复用原 SQL 命令。还通过开发者工具的 macOS 保存窗口实际导出 1024×1024 PNG，577728 字节，SHA256 为 `7e57080ecde2bd359db683854dec36287fab94cef00251219b0412f4647741e3`，与服务端原字节一致。

项目目前是 touristappid。相册和隐私拒绝通过在真实模拟器原生 API 边界注入拒绝回调，验证实际页面、真实下载/私有文件和恢复行为；没有替换 API、SQL、状态投影或文件校验。游客工具明确提示部分平台接口为模拟返回，因此真实 AppID 的平台授权弹窗和手机系统相册仍为 NOT_RUN，不能用上述故障注入替代。联调日志、失败前像、截图、导出文件和执行回执保存在本次会话的 wechat-devtools-closure 证据目录。没有正式 AppID 变更、上传、发布或付费推理。

本轮最终八包 PostgreSQL 回归为 **451/451 通过，零失败、零跳过**，新增 manifest 编译负例也实际执行。回归中发现的测试库复用幂等冲突保留原日志和原库；最终使用全新任务库。另修复原 PostgreSQL RLS 测试结束时强制删库与连接退出竞争，仅改为关闭连接后普通删库，所有 RLS 正反断言保持。未修改 Zero-Fake 检查器：26 个 TS/JS 文件零违规；JSON/MJS/WXML 不在它的扫描范围，另由真实编译、原生脚本和模拟器执行检查。用户已确认暂无真实 AppID，真实平台权限弹窗保持 BLOCKED / NOT_RUN；真实模型和逼真度分别仍为 NOT_RUN / NOT_CERTIFIED。
