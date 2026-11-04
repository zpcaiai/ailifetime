# v14 真机验证记录与测试工具

真机受测源码为 main `2faf110cefbe947a92eea9c0979833e5b952a5da`，预览 v14、测试窗口 window9。操作者确认设备为 **HyperOS 3.0.308、微信 8.0.80**，七项均为 **PASS_USER_REPORTED**。仅使用标注的 512×512 测试图片，付费图像模型调用为 0。

| 真机项目 | 系统相册与页面实际反馈 |
| --- | --- |
| 单张保存 | 页面成功，相册新增 1 张 |
| 批量保存 | 21/21，相册新增 21 张，批内不同 |
| 新批量页关闭添加到相册权限后保存 | 权限提示及设置按钮，相册新增 0 张 |
| 页面按钮恢复权限后暂不保存 | 未自动保存，相册新增 0 张 |
| 手动重试批量保存 | 21/21，相册新增 21 张，批内不同 |
| 岁月相册 | 无 HTTP_404，单张及 21 张标注作品可见，时间轴可打开 |
| 查看最新进展 | 有加载反馈，随后显示“已更新…”及就绪数量 |

五步实际相册新增依次为 **1、21、0、0、21**。批内不同不代表跨两批图案全不同。手机型号、Android 基础版本与准确执行时间保持 UNKNOWN；首次授权弹窗不在本轮七项范围内。原 v12 首次 0/21 原因仍为 UNKNOWN。

## 历史与证据

- [准备版 revision0](evidence/native-album-v14/revision-0/report.md) 保留七项 NOT_RUN；[确认版 revision1](evidence/native-album-v14/revision-1/report.md) 保留本轮七项实际反馈、设备版本及原始问答。
- [工具来源与原始证据哈希](evidence/native-album-v14/tool-provenance.json) 记录原脚本到可移植工具的映射、原记录哈希及新工具的实际公开 HTTPS 结果。历史 v10/v13 等仓库记录均未覆盖。
- 主机和工具证明不替代手机相册核对。原始日志中的 nativePhone:NOT_RUN 指主机检查自身没有操作手机；本轮手机结果来自另行取得的操作者原始回答。
- 固定 window9 截止 2026-11-04 18:00:36 Asia/Shanghai；此为历史测试期限，不声明凭据持续有效，也不自动续期。

## 可移植工具

从仓库根目录执行。凭据通过仓库外的 0600 文件传入；不将值放在参数或 Git 中。

```sh
python3 tools/native-album-curl-check.py \
  --origin https://your-test-domain.example.org \
  --identity /private/album/identity-current.json \
  --previous-identity /private/album/identity-previous.json \
  --capture-directory /private/album/new-curl-capture
```

新工具通过实际 curl GET 执行原有 native-album-public-check.py 的全部断言，保持证书及主机名校验、禁止重定向、响应上限 4MiB。捕获目录必须全新且在仓库外；目录 0700、请求头/响应/进程凭证 0600。仅连接错误 28/35/56 对幂等 GET 最多尝试两次，每次真实 PID、退出码、原始文件及 SHA256 均保留；证书拒绝不重试。可显式指定 --ca-file 受信测试 CA，不关闭验证。

本次可移植工具已对现有独立测试域名执行 40 次真实 HTTPS 请求，0 次连接失败，新身份有效、8 份历史身份拒绝、1+21 张 PNG 尺寸/字节数/SHA256 与批内唯一性通过。完整结构化结果见来源索引，原始私有捕获留在本地。

```sh
python3 tools/native-album-regression-record.py export \
  --input /private/album/seven-case-operator-record.json \
  --output /public/output/new-seven-case-record \
  --private-identity /private/album/identity-current.json
python3 tools/native-album-regression-record.py verify \
  --output docs/evidence/native-album-v14/revision-0
python3 tools/native-album-regression-record.py verify \
  --output docs/evidence/native-album-v14/revision-1
```

七项工具支持 native-album-full-regression/1 输入，分别保留诚实的准备态及操作者确认态。公开输出采用字段白名单和相对路径 SHA256SUMS；拒绝覆盖既有修订、已知凭据泄露、私有元数据、符号链接、路径穿越、篡改、缺少病例、布尔冒充数量，以及把主机记录提升成独立手机认证。已有五项记录工具及原断言保持不变。

```sh
python3 -m unittest discover -s tools -p 'test_native_album_*.py' -v
APP_ENV=test node --test tools/native-album-public-check.test.mjs tools/native-album-curl-check.test.mjs
node --test tools/native-album-preview.test.mjs tools/native-album-entry.test.mjs
sha256sum --check docs/evidence/native-album-v14/SHA256SUMS
```

真实 TLS 测试启动现有 Node/SQLite 入口并下载实际测试图，验证认证、证书拒绝、重定向拒绝、私有权限及不可覆盖捕获。序列化测试使用明确标注的测试输入，只验证记录工具。CI 在原步骤加入新 curl 测试路径，触发条件、运行器和既有断言保持不变；Python 原有通配发现包含新增记录测试。
