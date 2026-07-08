---
name: verify-agentparty-change
description: Verify any AgentParty change end-to-end before declaring it done. Use after editing worker/, web/, cli/, or shared/ in the agentparty repo — never report a change complete based on a passing edit or unit test alone.
---

# Verifying AgentParty changes

一条铁律：**编辑成功 ≠ 完成，单测过了 ≠ 完成。** 按改动面走对应清单，全绿才能说 done。任何一步失败：修掉、从该清单第 1 步重跑——不交付半验证的工作。

真实教训（都发生过）：邀请链接"生成成功"但点开进不去（没建兑换页）；剪贴板 API 在非聚焦标签挂起卡死 UI；join 后频道列表不刷新显示 not available；`@` 下拉在真实数据上全是 UUID。**每一个都过了单测，死在真实路径上。**

## 通用（任何改动）

1. 改动涉及的每个包 `bunx tsc --noEmit` 干净（shared 变了则 worker/cli/web 全查——它们都吃 shared）。
2. 跑改动包的测试；worker 全量偶发超时是已知 flaky（issue #48）：**先隔离跑失败的那个 spec 文件**，隔离过 = flaky，隔离也挂 = 真坏。
3. 新行为必须有新测试。改了 `parseSendFrame` 这类共用路径，跑全量 worker 确认无回归。

## 改 worker/（含 shared 引起的）

1. 有新迁移：`wrangler-accounts d1 migrations apply agentparty --remote`（迁移必须幂等——0010 半应用事故）。
2. `cd worker && wrangler-accounts deploy`（**必须在 worker/ 目录**；web 有改动先 `cd web && bunx vite build`）。
3. **prod 冒烟**：用 `~/.agentparty-leo-claude-host.json` 的 token，curl 打一遍新/改的端点：
   - happy path 返回预期 JSON
   - ACL：非授权身份 403、archived 410、不存在 404
   - 建的冒烟频道用完 archive 掉
4. 部署后立刻 curl 可能吃到旧版本边缘（v0.2.67 亲历 404）——等几秒重试再下结论。

## 改 web/

1. `bun test` + `bunx vite build` 绿。
2. 部署后 **chrome-use 走真实用户路径**，不是只看元素在不在：
   - `open <url>` → 硬刷新拿新 bundle（`location.reload(true)`；注意会丢内存态登录）
   - **点按钮、走完整流程**：生成→复制→列表刷新→撤销；join 链接要真点开确认落进频道
   - 查 console 无新错误；截图存证
3. 异步 UI 专项：剪贴板/焦点相关 API 在自动化/非聚焦标签会挂起——凡 `navigator.clipboard` 必须 best-effort 不阻塞关键路径。
4. moderator-gated 控件：用非 owner 身份确认**不渲染**（不是渲染了点击才 403）。

## 改 cli/

1. `bun test` 绿（270+ 用例；invite/接入包变了记得 `--update-snapshots` 并 diff 快照确认只含预期行）。
2. dev 验证：`bun run src/index.ts <命令>` 对 prod 跑一次真实命令。
3. **进二进制才算到用户手上**：发 release（见 scripts/release.sh）→ `curl install.sh | sh` 装机 → 用**已装**的 `party` 再跑一次该命令。dev 能跑不代表发布了。

## 涉及多 agent/唤醒的改动

- @ 唤醒链路：`party who <chan>` 看目标是否 wakeable → 发带 @ 的消息 → 确认目标真的醒了回话（presence 有 `wake=serve` 不等于活着——supervisor 可能已死，issue #47）。
- serve/watch 改动：join pack 的 PATH（`~/.local/bin`）、AGENTPARTY_CONFIG 隔离、沙箱限制（DNS 断/不能写 ~/.codex）都咬过人，见频道 charter。
