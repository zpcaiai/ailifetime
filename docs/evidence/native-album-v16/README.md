# v16 真机回归归档

实际受测源码固定为 `59f856d65552384bea81d80770f916a361689bb1`，预览 v16，测试窗口 window11。HyperOS 3.0.308／微信 8.0.80；7/7 项由用户本轮真机确认，状态 `PASS_USER_REPORTED`。仅使用明确标注的合成测试图片，付费模型调用 0。

| 项目 | 用户本轮确认 |
|---|---|
| 单张 | 页面保存成功，相册新增 1 张 |
| 批量 | 21/21，新增 21 张且批内不同 |
| 新批量页关闭权限 | 权限提示和设置按钮，新增 0 张 |
| 页面按钮恢复授权，未点保存 | 新增 0 张，未自动保存 |
| 手动重试 | 21/21，新增 21 张且批内不同 |
| 岁月相册 | 无 HTTP_404，展示单张与 21 张标注测试作品，时间轴可打开 |
| 查看最新进展 | 有加载反馈，随后显示“已更新…”及就绪数量 |

`revision-0` 原样保留准备记录（七项 NOT_RUN）；`revision-1` 追加用户确认版，保留七步问题与用户完整原文。两个包均与本地先前归档字节一致，未覆盖旧版及历次真机历史。

准备及交付分支的 main 基线为 `e808592a1367b0f2054c8fd599a5603d83dc3f85`。`source-verification.json` 保留实际受测 59f856d、当时远端、原生相关源码一致性和 111 个文件 SHA256。手机结果仍归属于 59f856d；提交所在分支的新源码不会因此获得真机通过结论。

`transport-receipts.json` 保存已有 HTTPS 记录的脱敏回读结果：43 条实际进程回执、42 次成功请求、1 次首次 TLS 连接失败（退出码 35）及随后成功重试，22 张 512×512 测试图，10 个旧身份被拒绝。新增回读工具校验原有摘要、文件权限和哈希、同源 HTTPS 参数、TLS 状态、重试关联和数量；不重新执行网络请求。原始私有日志未发布，仅保留哈希和 LOCAL_RAW_ARCHIVE 标识，不能用公开摘要独立重现其内容。首次失败证据仍保留。

在仓库根目录运行：

```sh
python3 -m unittest discover -s tools -p 'test_native_album_*.py' -v
APP_ENV=test node --test tools/native-album-curl-check.test.mjs
python3 tools/native-album-regression-history.py --prepared docs/evidence/native-album-v16/revision-0 --confirmed docs/evidence/native-album-v16/revision-1 --source-proof docs/evidence/native-album-v16/source-verification.json --repo .
```

`--repo .` 会逐个核对实际受测 Git 对象中的 111 个源码文件，需要本地含有该历史提交；CI 浅克隆使用不带此参数的记录完整性命令。各子目录的 SHA256SUMS 校验记录包，本目录的 SHA256SUMS 校验全部九个公开文件。回读私有 curl 归档时，使用 `python3 tools/native-album-curl-receipts.py --capture-directory PRIVATE_CAPTURE_DIRECTORY`；该目录须为原校验器创建的私有目录。

用户未提供手机型号、Android 基础版本及实际执行时间，保持 UNKNOWN；归档时间不代表手机执行时间。本轮没有复测首次授权弹窗。两次批量各自批内不同，不声称跨批次图案全部不同。原 v12 最初 0/21 原因仍为 UNKNOWN。主机记录完整性及真实 TLS 集成测试不代替代理直接观察手机，也不构成独立真机或生产认证。

凭据、身份文件、原始网络头与响应、部署环境和账号配置、二维码及含私有路径的临时脚本均不进入本次提交。凭据仅在本地内存中用于排除扫描，不输出其值。
