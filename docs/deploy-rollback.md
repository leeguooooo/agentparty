# worker 部署 / 回滚 runbook

worker 上线与 D1 迁移由 CI 自动化（issue #420）。本文档说明触发方式、迁移 ↔ 代码
顺序守卫、以及出事时的回滚路径（含 D1 time-travel 兜底）。

## 部署（`.github/workflows/worker-deploy.yml`）

**触发**

- 推 `v*` tag：随发布自动部署 prod + xdream 两个实例。
- 手动 `workflow_dispatch`：可选 `both` / `prod` / `xdream` 只部署一个实例。

**每个实例的顺序（迁移 ↔ 代码守卫）** —— 见 `worker/scripts/deploy-ci.mjs`：

1. `wrangler d1 migrations apply <db> --remote` —— 先把 schema 迁到位。
2. `verify-remote-schema.mjs` —— 校验「迁移全部已应用」且「必需列 / 索引存在」。
   **失败即中断，绝不进入 deploy**，这是防「新列被新代码依赖但迁移未落地」的半上线守卫。
3. `wrangler deploy` —— 带 build 元数据 `--define`（version / commit / deployed_at）。
4. 拉线上 `/api/health?deployment_metadata=1` 确认 version + commit + 时间戳一致后才算成功。
5. smoke（token 齐全时跑写路径冒烟）。

prod 与 xdream **串行**（`max-parallel: 1`），任一失败即停，避免两个实例同时半上线。
两个都部署时，最后 `verify-dual-deployment.mjs` 确认两实例对外提供**同一 build**。

**凭据**：CI 用原生 Cloudflare 凭据（`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`），
不用本机 `wrangler-accounts` profile。prod / xdream 是两个独立 Cloudflare 账号，各自的
一套凭据放在同名 GitHub Environment（`worker-prod` / `worker-xdream`）里。

## 兼容性迁移的写法（避免半上线）

- **向前兼容迁移（加列 / 加表 / 加索引，旧代码不依赖）**：随代码一起上，先迁后部署即安全，
  CI 默认流程已覆盖。
- **破坏性迁移（删列 / 改类型 / 重命名，旧代码会因此报错）**：必须**分两次发布**——
  1. 第一次：只上「新代码能同时兼容新旧 schema」的版本 + 向前兼容迁移；
  2. 第二次：待旧代码完全下线后，再上删除 / 收窄 schema 的破坏性迁移。
  绝不在一次发布里既删 schema 又依赖删除结果，否则回滚代码后旧代码撞上新 schema。

迁移编号唯一性由 `scripts/check-migration-numbering.ts` 守卫（见 `docs/migrations.md`），
`worker-deploy` 在部署前也会独立再跑一次。

## 回滚（`.github/workflows/worker-rollback.yml`）

手动 `workflow_dispatch`，输入 `confirm=rollback` 才执行。

**worker 代码回滚（可自动化）** —— 见 `worker/scripts/rollback-ci.mjs`：

1. `wrangler deployments list` —— 打印可回退的历史版本（挑 deployment id）。
2. `wrangler rollback [<id>]` —— 不带 id 回退到**上一个** deployment；带 id 回退到指定版本。
3. 读回线上 `/api/health` 打印回滚后实际的 version + commit。

选 `both` 时不能指定 `deployment_id`（各实例的 id 不通用）。单实例回滚可带 id。

### D1 schema 回退（人工，破坏性，不自动化）

wrangler **没有** D1 迁移回滚。schema 回退只能靠 time-travel，且会**丢失**回退时间点
之后写入的数据 —— 故刻意不放进 CI，必须人工评估后执行：

```bash
# 1. 找回退时间点（部署前的 bookmark / 时间戳）
wrangler-accounts d1 time-travel info agentparty --json

# 2. 恢复到指定时间戳或 bookmark（破坏性，会丢该点之后的数据）
wrangler-accounts d1 time-travel restore agentparty --timestamp "2026-07-13T00:00:00Z"
# 或
wrangler-accounts d1 time-travel restore agentparty --bookmark "<bookmark>"
```

xdream 实例把上面的 `agentparty` 换成 `agentparty-xdream`，并切到 xdream 账号。

**降级策略**：破坏性迁移不可逆时，优先「代码回滚 + 保留新 schema」（新 schema 对旧代码
向前兼容时可行）；只有在旧代码无法在新 schema 上运行、且新数据可接受丢失时，才动 time-travel。
D1 time-travel 默认保留 30 天窗口。

## owner 需在 GitHub 配置的 secret / environment

在 repo Settings → Environments 建两个 environment，各自配一套 secret：

| Environment | secret | 说明 |
| --- | --- | --- |
| `worker-prod` | `CLOUDFLARE_API_TOKEN` | leeguooooo 账号、含 Workers Scripts + D1 编辑权限的 API token |
| `worker-prod` | `CLOUDFLARE_ACCOUNT_ID` | leeguooooo 账号 id |
| `worker-prod` | `AGENTPARTY_SMOKE_TOKEN` / `AGENTPARTY_SMOKE_WRITE_TOKEN` | 可选，一次性冒烟 token；不配则跳过写冒烟 |
| `worker-xdream` | `CLOUDFLARE_API_TOKEN` | Xdreamstar2025 账号的 API token |
| `worker-xdream` | `CLOUDFLARE_ACCOUNT_ID` | Xdreamstar2025 账号 id |
| `worker-xdream` | `AGENTPARTY_SMOKE_TOKEN` / `AGENTPARTY_SMOKE_WRITE_TOKEN` | 可选 |

API token 建议用 Cloudflare「Edit Cloudflare Workers」模板 + D1 编辑权限。
