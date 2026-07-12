# 贡献指南

## 合并纪律：review 必须被「读到」，不靠记忆

自动 review（pr-agent 用 qwen-max、CodeRabbit）会在每个 PR 上贴评论。但**非阻塞的 review 若没人读就是摆设**。为此 main 分支有两道对所有人生效的强制闸（required status checks），不依赖任何人的自觉：

1. **`pr_agent`（软阻断）**：合并前必须等自动 review 跑完——端点通时评论已贴在 PR 上；端点挂时无评论但 check 照样绿（不卡死 PR）。
2. **`review-ack`（读了才能合）**：合并前必须有人留下 **review 结论**，否则 check 红、无法合并。做法二选一：
   - 在 PR 提交一次 review（Approve / Comment / Request changes），或
   - 评论一条以 `review-ack:` 开头（或含「合并前已读」「合并者 review 结论」）的结论，说清 review 有无**真问题**、哪些是**误报**、哪些**采纳**。

> 为什么这样设计：`pr_agent` 保证 review 被**产出**，`review-ack` 保证 review 被**读到并判断**。两道都不依赖 LLM 端点存活；端点挂时 `pr_agent` 自动放行，但 `review-ack` 仍要求人看过——因为「有没有真问题」终究要人判。

## 其它约定

- 开自己的分支 + worktree 提 PR；动代码前先 `git fetch` 查重（多 agent 并行开发）。
- 迁移文件用 `worker/migrations/` 下一个空号（四位），过 `scripts/check-migration-numbering.test.ts`。
- Secret 绝不硬编码进代码/工作流——用 GitHub Secret 引用。
