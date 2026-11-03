# 手机相册保存联调服务

这是隔离测试工具，不是生产服务或真机验收回执。使用明确标注的合成 PNG，实际执行 SQL、签名同意策略、API 鉴权、图片校验和下载。不会调用付费模型；测试质量记录不构成真实模型、肖像质量或独立认证。

## 本地启动

先使用 Node26+、pnpm10.12.4 构建：

```sh
pnpm --filter @ltm/api... build
node tools/native-album-api.mjs --synthetic-test-images \
  --output /absolute/private/new-album-test-state --port 8189
```

输出目录必须不存在。服务仅监听127.0.0.1，生成单张 single-root 与21张 root。临时 consumer 凭据只写入目录内0600的 identity.json，默认30分钟服务端强制过期，最长1小时。数据库和原图目录保持私有，不读取用户相册或真实人像，不复用生产凭据。

GET /native-album/config、/v1/session、/v1/capabilities/visible、两组 /v1/timelines 及其原图路径是唯一入口。凭据通过 Authorization 请求头传递，X-Purpose 必须为 age_transformation；禁止把令牌放在 URL、二维码、代码、ext.json、命令参数或日志。拒绝浏览器 Origin/Cookie、写入、生成、支付和管理路径。测试账号不冒充微信身份；正常 wx.login 流程保持原实现，独立的开发联调入口只验证临时测试身份。

## 部署包

```sh
node tools/native-album-deployment.mjs \
  --repository /absolute/path/to/git-repository --ref origin/main \
  --output /absolute/private/new-album-deployment-package
```

包内有固定提交的 source.tar.gz、精确列举的新工具、SHA256 manifest、Nginx模板、systemd实例模板与小程序配置片段。包里没有临时身份、数据库、原图状态、node_modules或未列举的并发改动。没有实际域名时，保留明确占位符，publicDeployment/nativeAcceptance 均为 NOT_RUN。生成包不会申请主机、注册域名、修改 DNS/权限、启动公网代理或安装服务。

## 独立开发预览

从解压后的干净源码生成独立预览，不修改当前项目 app.json 或 ext.json：

```sh
node tools/native-album-preview.mjs \
  --source-root /absolute/extracted-source/apps/wechat-mini \
  --output /absolute/private/new-native-preview \
  --api-base-url https://YOUR-ACTUAL-REGISTERED-DOMAIN
```

仅在开发者工具本机检查时可显式传 `--api-base-url http://127.0.0.1:8189 --allow-loopback-devtools`。此预览在手机上会拒绝 HTTP；不能把本机回环地址当作手机后端。预览项目仍开启合法域名和隐私检查，并保留原发布校验文件。临时测试入口仅在 develop 版且 nativeAlbumTestEnabled 显式开启时可用；trial/release 拒绝。

将新的预览项目交给官方开发者工具生成二维码。二维码和小程序包不含凭据；由测试人从私有 identity.json 取得短期凭据后，在密码输入框手动输入。入口通过真实 /native-album/config 和 /v1/session 校验测试身份，再进入原有单张/批量结果页，实际保存仍使用原 timeline-media 服务。测试身份不是微信登录结果，正常 wx.login 和发布代码不添加登录后门。

## 可复现验证

```sh
node --test --test-timeout=25000 tools/native-album-api.test.mjs \
  tools/native-album-deployment.test.mjs tools/native-album-entry.test.mjs \
  tools/native-album-preview.test.mjs
pnpm --filter @ltm/wechat-mini-core test
```

本机需安装官方 Nginx 和 OpenSSL。若在无 .git 的源码包中运行部署包测试，用 `LTM_NATIVE_TEST_SOURCE_REPOSITORY` 指向可读取固定源码提交的 Git 仓库；正常 Git checkout 自动发现，不修改断言或跳过测试。本机 TLS 测试生成并显式信任仅供测试的 CA，证书检查保持有效，不产生微信合法域名或公网证书证据。

目标必须是获授权的持久主机、有实际 HTTPS 域名和有效公开证书链。按包内 README 替换占位符、安装锁定依赖并构建，先 nginx -t，再按该主机流程部署专用服务实例。登记微信 request/download 合法域名并完成隐私配置，保留 urlCheck、TLS与隐私检查。不要把本机自签名测试 CA 当作微信可用证书，不关闭证书检查，不创建未获授权的公网隧道。

## 四项真机验收

先用原生微信开发预览的联调入口输入短期测试凭据，完成真实 /v1/session 服务端校验，然后打开实际结果页并使用既有保存按钮。记录手机系统/微信版本与构建摘要，不记录账号标识或凭据。

1. 首次授权：确认处于未申请状态，点单张保存，看到系统实际授权提示并允许。
2. 单张保存：实际相册新增正确测试图片，核对保存提示、图片与数量。
3. 批量保存：一键保存 root 的21张，实际相册数量与不同测试图一致，重试不重复保存本页成功项。
4. 拒绝后重试：在可复现的干净授权状态拒绝，确认没有新增图片；通过正常设置开启权限后，再主动点击保存并核对实际相册。

微信回调成功、服务器下载200、本机 Nginx/TLS 通过，都不能单独代替手机 Photos/Gallery 的实际观察。四项须逐项记录；缺少实际 HTTPS/合法域名、测试手机或授权状态则保持 NOT_RUN/BLOCKED_INCOMPLETE。

结束时撤销或等待短期凭据过期，按正常流程关闭本次服务实例；保留证据和数据库，不覆盖任何并发新配置。恢复前必须核对前像与本次后像，不能回滚别人后续改动。
