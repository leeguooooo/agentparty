import { applyD1Migrations, env } from "cloudflare:test";

// TEST_MIGRATIONS 由 vitest.config.ts 的 miniflare bindings 注入，测试环境必有；
// 类型上可选只是因为它增补在全局 Cloudflare.Env（见 env.d.ts）。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
