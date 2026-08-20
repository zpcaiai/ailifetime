# 项目工厂使用说明

## 两种模式

- `new`：生成非生产性的起始 monorepo、安装 Skills、固化 Profile/Stack、初始化状态。B01 才负责真实架构和构建闭环。
- `adapt`：只安装项目工厂并初始化控制文件，不覆盖已有应用。B00/B01 建立复用与迁移映射。

## 状态机

`excluded → planned → ready → running → review → merged/certified`，另有 `blocked`。只有依赖处于 `merged/certified` 才会 ready。完成报告通过 `verify_release.py` 后才能进入 review。

## 并行规则

- 每个 Agent 一次只领取一个 Batch；
- 使用独立 branch/worktree 和明确路径所有权；
- 共享契约变更优先单独合并；
- 下游基于最新依赖 commit 重放；
- 失败三轮后标记 blocked，而不是无限修改；
- 任何口头“完成”不改变状态。

## 常用命令

```bash
python3 scripts/projectctl.py --repo . profile-list
python3 scripts/projectctl.py --repo . init --profile full-commercial
python3 scripts/projectctl.py --repo . ready
python3 scripts/projectctl.py --repo . prompt B00 --host codex
python3 scripts/projectctl.py --repo . worktree-plan B00
python3 scripts/render_backlog.py --profile full-commercial --output backlog.md
```
