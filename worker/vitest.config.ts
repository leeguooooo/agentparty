import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// vitest 4 + vitest-pool-workers 0.18：defineWorkersConfig/test.poolOptions.workers 已被
// cloudflareTest() Vite 插件取代（pool 选项进插件，普通 test 选项留在 test 块）。
export default defineConfig(async () => {
  const workerDir = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir = path.join(workerDir, "migrations");
  const migrations = await readD1Migrations(migrationsDir);
  // Fresh worktrees intentionally do not contain web/dist. Give workerd an isolated empty
  // assets binding so backend tests never need to write into the forbidden web workspace.
  const testRuntimeDir = mkdtempSync(path.join(tmpdir(), "agentparty-worker-vitest-"));
  const assetsDir = path.join(testRuntimeDir, "assets");
  mkdirSync(assetsDir);
  const testWranglerConfig = path.join(testRuntimeDir, "wrangler.json");
  writeFileSync(
    testWranglerConfig,
    JSON.stringify({
      name: "agentparty-test",
      main: path.join(workerDir, "src/index.ts"),
      compatibility_date: "2026-06-01",
      durable_objects: { bindings: [{ name: "CHANNELS", class_name: "ChannelDO" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["ChannelDO"] }],
      assets: { directory: assetsDir, binding: "ASSETS", run_worker_first: ["/api/*", "/openapi.json"] },
      // vitest-pool-workers 下 miniflare 会为每个声明的 r2 bucket 自动起一个内存 R2，无需真实账号
      r2_buckets: [{ binding: "ATTACHMENTS", bucket_name: "agentparty-attachments-test" }],
      d1_databases: [
        {
          binding: "DB",
          database_name: "agentparty-test",
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir: migrationsDir,
        },
      ],
    }),
  );
  return {
    plugins: [
      cloudflareTest({
        // 0.18 起 singleWorker/isolatedStorage 选项已移除（单 worker 是既定行为，
        // 存储隔离不复存在——本仓测试一直用唯一 slug/name 而非隔离，行为不变）。
        wrangler: { configPath: testWranglerConfig },
        miniflare: {
          bindings: {
            ADMIN_SECRET: "test-admin-secret",
            TEST_MIGRATIONS: migrations,
            // 静态启用 OIDC，供 e2e 走 SELF.fetch 验证人类网页登录（未配 OIDC 的降级路径由单元测试覆盖）
            OIDC_ISSUER: "https://oidc.test",
            OIDC_CLIENT_ID: "ap-web",
            AUTH_PROVIDERS: JSON.stringify([
              { id: "lark-main", kind: "lark", client_id: "cli_test_lark" },
            ]),
            LARK_CLIENT_SECRET: "test-lark-secret",
            DESKTOP_PAIRING_SECRET: "test-desktop-pairing-secret-at-least-32-bytes",
            // #137：把每频道 WS 连接上限降到小值，测试才不用真开 200 条连接验证上限。
            // 值必须 > 任何单个 it 对同一频道的并发连接数（现存最多 <6），并与
            // account-channel-quota.spec.ts 的 TEST_CONN_CAP 保持一致。
            MAX_CONNECTIONS_PER_CHANNEL: "10",
          },
        },
      }),
    ],
    test: {
      // 单 workerd 运行时串行跑全部 spec，满载时个别 WS 握手/DO 交互偶发超过默认 5000ms
      // （非代码 bug，隔离单跑 75ms；见 issue #43）。抬到 20s 消除随机挡发布的假超时。
      testTimeout: 20_000,
      hookTimeout: 20_000,
      // CI 满载下 vitest-pool-workers 跨 spec 文件反复 invalidate DO（thrash），偶发把
      // WS 握手/DO fetch 顶超时、挡住 release（#48）。CI 里 retry 1 次仅作兜底：真 bug
      // 连挂两次仍然红，retry 通过的用例 vitest 会标 flaky、不丢信号；本地不 retry 保持严格。
      retry: process.env.CI ? 1 : 0,
      // Worker specs share one workerd runtime and many tests keep WebSocket / Durable Object
      // state alive across ticks. Running spec files in parallel makes the pool invalidate the
      // Worker module while another spec still holds a DO stub, producing false
      // "worker/src/index.ts changed, invalidating this Durable Object" failures (#48).
      fileParallelism: false,
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
