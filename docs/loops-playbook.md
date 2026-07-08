# AgentParty 开发的 loops 用法（拿来即抄）

按 Claude Code 团队的 loops 文章（[原文](https://x.com/ClaudeDevs/status/2074208949205881033)）整理，模板全部对准本仓库的真实工作。原则：**能写清停止条件就别人肉当评估器**。

## /goal —— 替代反复说「继续」

停止条件可判定（issue 关了 / CI 绿了 / 冒烟过了）就用它。

```
/goal 清完 leeguooooo/agentparty 所有可实现的 open issue：每个都实现+测试+部署+prod 冒烟+带证据关闭；
CI 必须绿；跳过 roadmap/追踪类（当前 #32 #47 #48 里属 epic 的）。最多 20 轮。
```

```
/goal 修复 issue #47（presence 陈旧 wake 标记）：serve/watch 的 wakeable 需 presence fresh，
webhook 不受限；worker 全量测试过 + 部署 + party who 实测不再把死 supervisor 显示成可唤醒。最多 8 轮。
```

写法要点：停止条件要可判定（"测试过/部署了/关了"），给轮数上限，排除项写明白。

## /loop —— 盯外部状态（CI / codex / PR）

盯的东西自己会变、只需要按间隔看一眼再反应时用。替代手搓 sleep 轮询监视器（本 session 手写过 5 个，其中 1 个盯错旧日志误触发）。

```
/loop 5m 看 v0.2.XX 的 release CI：失败且是 full check 超时类 flaky（issue #48）就把 tag 移到 HEAD 重推一次；
绿了就 curl install.sh 装机、party --version 验证后停。
```

```
/loop 10m 检查 codex 任务 task-XXXX 的 log 是否收尾（停写>90s 且 git status 有改动）：
收尾了就按 skills/verify-agentparty-change 走验证；卡住超 30 分钟报告并停。
```

间隔匹配变化频率：CI 一轮 2-3 分钟 → 5m 合适；codex 写码 5-15 分钟 → 10m。

## /schedule —— 无人值守的日常

```
/schedule every morning 9am: 检查 leeguooooo/agentparty 新 issue 与频道未读。
小改动（有明确 spec/复现步骤）直接实现，按 skills/verify-agentparty-change 验证后关闭；
大改动写 spec 发 #agentparty 频道 @leo 评审。CLI 改动攒着别单独发版。
```

```
/schedule every hour: party who agentparty 查各 serve agent 是否真的活着（state≠offline），
死了的在频道 @leo 报一声（不要自己重启别人机器上的 supervisor）。
```

## 配套纪律（文章 "quality/usage" 两节的本仓库版）

- **验证交给 skill**：`skills/verify-agentparty-change/SKILL.md` 是 done 的定义，loop 的 stop 条件直接引用它。
- **发版交给脚本**：`scripts/release.sh <version>`，确定性工作零推理。
- **先小规模试跑**：dynamic workflow 派多 agent 前，先拿一个 issue 走通再放量。
- **一树一 agent**：并行 codex 必须各占一个 worktree（同树并跑污染过 #46/#38，教训在案）。
- **间隔别太密**：盯的东西多久变一次，loop 就多久跑一次。
