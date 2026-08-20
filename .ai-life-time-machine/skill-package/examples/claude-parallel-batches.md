# Claude Code + Codex 并行

```bash
python3 .ai-life-time-machine/skill-package/scripts/orchestrate_batches.py --repo . ready
python3 .ai-life-time-machine/skill-package/scripts/orchestrate_batches.py --repo . worktree-plan B06
```

在各自 worktree 中仅领取一个 ready Batch。共享 OpenAPI、事件 schema、迁移编号、权限与核心聚合必须设置单一 owner。完成后先验证 completion report，再合并；只有 `mark-merged` 后下游 Batch 才会 ready。
