# v15 真机回归记录 · revision 1

源码：`bc89eed35315440d648b721d50f3777be8c73e57`。结果：**PASS_USER_REPORTED**。付费模型调用：0。

| 检查 | 本轮记录 |
|---|---|
| single | {"page_result": "保存成功", "album_delta": 1} |
| batch | {"progress": "21/21", "album_delta": 21, "batch_distinct": true} |
| denial | {"fresh_batch_page": true, "permission_disabled": true, "permission_message": true, "settings_button": true, "album_delta": 0} |
| restore_without_save | {"settings_opened_via_page": true, "permission_restored": true, "save_clicked": false, "album_delta": 0} |
| manual_retry | {"manual_retry": true, "progress": "21/21", "album_delta": 21, "batch_distinct": true} |
| library | {"no_http404": true, "labelled_test_counts": [1, 21], "timeline_opens": true} |
| progress | {"loading_feedback": true, "updated_feedback": true, "ready_count": true} |

设备：`{"model": "UNKNOWN", "os_name": "HyperOS", "os_version": "3.0.308", "wechat_version": "8.0.80", "android_base_version": "UNKNOWN", "execution_time": "UNKNOWN"}`。UNKNOWN不由归档时间推定。

七项均保留；主机记录校验不等于代理直接操作手机或独立认证。两次批量各自21张不同，不声称跨批次图案均不同。首次授权弹窗不在本轮七项中。原v12首次0/21原因仍为UNKNOWN。

原始问题：用目标手机扫描本轮 v15 二维码后，能否进入“手机相册保存联调”？请同时确认仍是 HyperOS 3.0.308、微信 8.0.80。请等新的 window10 凭据生效后再校验和保存。

用户原文：能进入，设备版本一致

原始问题：请在 HyperOS 3.0.308／微信 8.0.80 上，用本轮 v15＋window10 完成并核对：①单张保存成功，系统相册新增1张；②批量21/21，新增21张且批内不同；③返回入口重新打开批量页，关闭“添加到相册”权限后保存，出现权限提示及设置按钮，新增0张；④通过页面按钮恢复授权，返回未点保存时新增0张；⑤手动重试21/21，新增21张且批内不同；⑥岁月相册无HTTP_404，展示单张和21张标注测试作品，时间轴可打开；⑦查看最新进展有加载反馈，随后显示“已更新…”及就绪数量。是否七项全部符合？若未完成或失败，请回复当前步骤和错误原文，不要发送凭据。

用户原文：七项全部符合，设备版本一致

原始源记录SHA256：`c7b14993bdd3851164f00be4a5937564f77a4a2592ea93fdd71852facf6efb74`。相对路径SHA256SUMS校验本目录；原始日志保持LOCAL_RAW_ARCHIVE。
