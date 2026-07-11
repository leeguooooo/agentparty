// vitest-pool-workers 0.18 起 `env` 的类型是全局 Cloudflare.Env（不再是模块内 ProvidedEnv）。
// 增补必须是可选字段：这个命名空间是全局的，必填会让 src 里构造 Env 的地方全部报缺属性。
declare namespace Cloudflare {
  interface Env {
    ADMIN_SECRET?: string;
    TEST_MIGRATIONS?: import("@cloudflare/vitest-pool-workers").D1Migration[];
    OIDC_ISSUER?: string;
    OIDC_CLIENT_ID?: string;
  }
}
