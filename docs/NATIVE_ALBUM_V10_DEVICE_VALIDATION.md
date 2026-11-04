# v10 相册保存真机记录与测试工具

本轮真机预览源码为 main `7811c605f5960ba377fba9ef72b53f06afca41ad`，5/5项按用户实际操作和系统相册核对反馈记录为 **PASS_USER_REPORTED**。本次工具交付整合的main基线为 `e89e7ca5ae6115b6f62a861bd5a62346e8ae2eb3`；工具的主机回归不替代对其他源码版本的真机验收。仅使用512×512测试图片，本轮付费模型调用为0。

| 检查 | 相册新增 | 用户反馈 |
|---|---:|---|
| 单张保存 | 1 | 实际相册新增1张 |
| 批量保存 | 21 | 页面21/21，21张不同测试图 |
| 关闭权限后保存 | 0 | 重新进入批量页关闭权限后，有权限提示和设置按钮 |
| 页面按钮恢复权限后未点击保存 | 0 | 无自动保存 |
| 手动重试 | 21 | 页面21/21，新增21张不同测试图 |

每次批量内部21张不同，不声称两批合计43张图案均不同。手机具体型号、Android底层版本和实际操作时间未提供，仍为UNKNOWN；单张首次授权弹窗未报告。

## 记录与历史

- [原始v10记录 revision1](evidence/native-album-v10/revision-1/report.md)：设备细节当时未提供；[JSON](evidence/native-album-v10/revision-1/record.json)。
- [设备信息修订 revision2](evidence/native-album-v10/revision-2/report.md)：用户补充 **Xiaomi HyperOS3.0.308、微信8.0.80**；具体机型仍未知；[JSON](evidence/native-album-v10/revision-2/record.json)。
- 两版保留相同五项实际反馈，后续“ok”只作确认；原本地MD/JSON/SHA与所有等待阶段快照、错误原文均未覆盖。[旧版真机记录](NATIVE_ALBUM_DEVICE_VALIDATION.md)保持原样。
- [工具来源及原始证据哈希](evidence/native-album-v10/tool-provenance.json)将六个本地操作脚本映射为三个可移植工具。原始脚本、私有provider元数据和全部原始日志仍在本地归档；未随仓库提供的证据明确标为LOCAL_ARCHIVE。
- [V4 HTTPS原始输出](evidence/native-album-v10/https-window-4.jsonl)、[V5 HTTPS原始输出](evidence/native-album-v10/https-window-5.jsonl)保留实际1+21图完整性和拒绝检查。日志中的`nativePhone:NOT_RUN`指主机检查本身，不覆盖用户独立提供的相册反馈。

准备窗口V5固定截至2026-11-04 10:57:14（Asia/Shanghai）；不以记录时间推定实际操作时间，用户未单独确认使用的凭据版本。旧窗口到期记录与初次API版本错误、一次TLS EOF和随后通过证据均保留。

## 可移植工具

以下命令从仓库根目录运行。凭据只通过仓库外的0600文件传入，不能作为命令参数值或放入Git。示例路径需换成操作者自己的私有目录。

### 只读HTTPS回归

```sh
python3 tools/native-album-public-check.py \
  --origin https://your-test-domain.example.org \
  --identity /private/album/identity-current.json \
  --previous-identity /private/album/identity-previous.json
```

验证实际鉴权、401/403/404拒绝、固定synthetic配置、1+21张PNG的512尺寸/长度/SHA256/唯一性及旧身份拒绝。TLS证书与主机名校验开启，拒绝重定向，文件响应上限4MiB。`--ca-file`只用于显式受信测试CA，不关闭验证。此工具不保存手机相册，也不调用模型。

### 现有独立测试项目的窗口检查/创建

```sh
python3 tools/native-album-window.py inspect \
  --state-directory /private/album/new-readonly-inspection \
  --team-id team_REPLACE --project-id prj_REPLACE \
  --expected-project-name native-album-test \
  --expected-account-email operator@example.org
```

`inspect`只有GET；输出状态目录必须全新且在仓库外。校验明确指定的账户、团队、Hobby测试项目、Node26以及两个已有生产目标测试变量，保留0600原始响应和实际PID/退出码。它不读取CLI认证令牌、不升级套餐、不自动部署。

只有另行明确授权操作现有测试窗口时，才将`inspect`换成`create`并添加`--previous-identity /private/album/old-identity.json --window 6`。该模式会更新两项已有测试环境变量：先验证旧窗口已过期和当前expiry匹配，创建全新60分钟窗口和不可覆盖的私有文件，再于每次PATCH前核对变量ID/type/target/updatedAt。出现错误须检查私有日志并核对外部结果，不能直接重跑或覆盖部分成功。新值需要另行明确部署才生效；工具不自动重试、回滚或续期旧凭据。

本次Git交付对可移植窗口工具执行了真实Vercel只读检查和本地文件/随机数/并发保护测试，**未执行其线上create/PATCH/部署**。历史V4/V5已执行的操作仅由历史证据描述，不能冒充新工具线上更新验收。

### 不可覆盖的记录导出与校验

```sh
python3 tools/native-album-phone-record.py export \
  --input /private/album/operator-record.json \
  --output /public/output/new-record \
  --private-identity /private/album/identity-current.json
python3 tools/native-album-phone-record.py verify \
  --output docs/evidence/native-album-v10/revision-2
```

输入为完整`ltm.album-main-device-report.v1`记录；五个病例字段必须完整、计数为整数，批量UI/相册核对均须提供，证据类型保持USER_REPORTED。公开导出仅保留白名单字段、原始记录哈希和日志名/哈希，不依赖原机器绝对路径。每版产生`record.json`、`report.md`及相对路径`SHA256SUMS`；拒绝覆盖、凭据命中、符号链接清单、清单路径穿越和内容篡改。

## 本地回归

```sh
node tools/native-album-build.mjs
node --test tools/native-album-public-check.test.mjs
python3 -m unittest discover -s tools -p 'test_native_album_*.py' -v
python3 tools/native-album-phone-record.py verify --output docs/evidence/native-album-v10/revision-1
python3 tools/native-album-phone-record.py verify --output docs/evidence/native-album-v10/revision-2
```

TLS测试使用实际Node入口和SQLite测试服务、受信临时CA及真实文件，验证1+21媒体、证书拒绝、重定向拒绝和私有文件权限。窗口元数据单元输入仅验证本地控制逻辑，不能充当Vercel部署证明；记录序列化输入也不充当真机证明。
