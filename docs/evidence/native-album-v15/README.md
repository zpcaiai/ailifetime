# v15 真机回归归档

本轮源码固定为 `bc89eed35315440d648b721d50f3777be8c73e57`，预览 v15，测试窗口 window10。HyperOS 3.0.308／微信 8.0.80；7/7 项为当前用户真机确认，状态 `PASS_USER_REPORTED`。只使用明确标注的合成测试图片，付费图像模型调用 0。

| 项目 | 用户本轮确认 |
|---|---|
| 单张 | 页面保存成功，相册新增 1 张 |
| 批量 | 21/21，新增 21 张且批内不同 |
| 新批量页关闭权限 | 权限提示和设置按钮，新增 0 张 |
| 页面按钮恢复授权，未点保存 | 新增 0 张，未自动保存 |
| 手动重试 | 21/21，新增 21 张且批内不同 |
| 岁月相册 | 无 HTTP_404，展示单张与 21 张标注测试作品，时间轴可打开 |
| 查看最新进展 | 有加载反馈，随后显示“已更新…”及就绪数量 |

`revision-0` 是原样保留的准备记录（七项 NOT_RUN）；`revision-1` 是用户确认后的追加记录，含两组完整原始问题与回答。未覆盖旧版本，也未修改 v10、v13、v14 历史记录。

准备时观察到远端 main 已前进到 `6afa221f7cbad27a0568c493fb0f945d270faa3b`。按照用户指定保留实际测试的 bc89eed；当时已验证它是远端祖先且原生测试相关源码一致。交付分支基于 6afa221，不能把此次手机结果归属于未测试的新源码。bc89eed 的四项已通过 CI 见 [Actions 原始运行](https://github.com/zpcaiai/ailifetime/actions/runs/41810900547)；不据此推定较新远端 CI 通过。

`source-verification.json` 保留准备时源码、CI 快照哈希及 106 个文件的 SHA256。新增历史校验器会验证两个可移植记录包、连续版本、原始源记录哈希链、测试窗口和源码/二维码一致性，且可对指定 Git 对象逐一校验 106 个文件。

在仓库根目录运行：

```sh
python3 -m unittest discover -s tools -p 'test_native_album_*.py' -v
python3 tools/native-album-regression-history.py --prepared docs/evidence/native-album-v15/revision-0 --confirmed docs/evidence/native-album-v15/revision-1 --source-proof docs/evidence/native-album-v15/source-verification.json --repo .
```

各子目录的 `SHA256SUMS` 校验可移植记录包；本目录 `SHA256SUMS` 校验全部八个公开归档文件。原始主机日志保存在本地，记录只保存哈希、实际执行 PID、退出码及 LOCAL_RAW_ARCHIVE 标识。日志未随 Git 发布，公开哈希不能独立重现其内容。记录校验和 Git 对象校验不执行手机保存，也不构成独立真机或生产认证。

用户未提供手机型号、Android 基础版本及实际执行时间，保持 UNKNOWN；归档时间不代表执行时间。本轮没有复测首次授权弹窗。两次批量各自批内不同，不声称跨批次图案全部不同。原 v12 最初 0/21 的原因仍为 UNKNOWN。

测试身份文件、访问令牌、部署环境、账号及项目配置、二维码和包含私有路径的运行脚本均不进入本目录或本次 Git 提交。凭据仅用于本地排除扫描；可通过校验器的 `--private-identity` 参数传入私有文件路径，工具不会输出其值。
