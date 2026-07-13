## 改动说明
<!-- 这个 PR 做了什么、为什么 -->

## 合并前检查（review-ack 强制闸——不留结论合不了）
> main 分支保护要求：合并前必须**读过 review 并留下结论**。做法二选一，否则 `review-ack` check 红、无法合并：
> 等当前 head 的 pr-agent(qwen) / CodeRabbit review 都落地后，再二选一（提前 ack 不会放行）：
> - 在本 PR 提交一次 review（Files → Review changes → Approve/Comment），或
> - 评论一条以 `review-ack:` 开头的结论，说清两份 review 有无**真问题**、哪些是**误报**、哪些**采纳**。

- [ ] 我已读 pr-agent / CodeRabbit 的 review，真问题已处理、误报已判明
- [ ] 本地门禁通过（tsc / 测试 / build）
- [ ] 涉及安全/鉴权/数据的改动已做对抗性验证（变异测试或等价手段）
