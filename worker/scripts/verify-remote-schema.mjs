import { spawnSync } from "node:child_process";

const database = process.env.AGENTPARTY_D1_DATABASE ?? "agentparty";
const wranglerConfig = process.env.AGENTPARTY_WRANGLER_CONFIG;

// 本地缺省用 wrangler-accounts（profile 包装）；CI 通过 AGENTPARTY_WRANGLER_BIN
// 传 "bunx wrangler" 走原生 wrangler + CLOUDFLARE_API_TOKEN/ACCOUNT_ID 凭据。
const wranglerLauncher = (process.env.AGENTPARTY_WRANGLER_BIN ?? "wrangler-accounts")
  .trim()
  .split(/\s+/)
  .filter(Boolean);
const [wranglerBin, ...wranglerPrefix] = wranglerLauncher.length > 0 ? wranglerLauncher : ["wrangler-accounts"];

const required = {
  channels: [
    "id",
    "slug",
    "title",
    "topic",
    "kind",
    "mode",
    "created_by",
    "created_at",
    "archived_at",
    "charter_write_policy",
    "charter_write_agents",
    "charter_write_agent_allowlist_json",
    "members_list_policy",
    "members_list_agents",
    "members_list_agent_allowlist_json",
  ],
  tokens: ["id", "hash", "name", "role", "owner", "created_at", "revoked_at"],
  account_profiles: [
    "account",
    "handle",
    "display_name",
    "avatar_url",
    "avatar_thumb",
    "provider",
    "provider_user_id",
    "tenant_key",
    "created_at",
    "updated_at",
  ],
  captures: [
    "id",
    "channel_slug",
    "seq",
    "kind",
    "note",
    "created_by",
    "created_by_kind",
    "created_at",
    "message_sender",
    "message_sender_kind",
    "message_kind",
    "message_body",
    "message_ts",
  ],
  channel_tasks: [
    "id",
    "channel_slug",
    "title",
    "description",
    "state",
    "assignee_name",
    "assignee_kind",
    "created_by",
    "created_by_kind",
    "created_by_owner",
    "priority",
    "labels_json",
    "parent_id",
    "anchor_seqs_json",
    "completion_artifact_json",
    "workflow_id",
    "created_at",
    "updated_at",
    "completed_at",
  ],
  channel_roles: ["channel_slug", "agent_name", "role", "assigned_by", "assigned_at"],
  agent_profiles: [
    "owner_account",
    "handle",
    "name",
    "runner",
    "repo_url",
    "workdir",
    "base_branch",
    "worktree_strategy",
    "rules",
    "invitable_by",
    "created_at",
    "updated_at",
  ],
  channel_agent_invites: [
    "id",
    "channel_slug",
    "owner_account",
    "profile_handle",
    "invited_by",
    "invited_at",
    "revoked_at",
  ],
  desktop_pairings: [
    "id",
    "device_code_hash",
    "user_code_hash",
    "code_challenge",
    "device_secret_challenge",
    "device_name",
    "device_platform",
    "device_app_version",
    "status",
    "account",
    "approved_by",
    "proof_failures",
    "poll_interval_sec",
    "next_poll_at",
    "created_ip_hash",
    "created_at",
    "expires_at",
    "approved_at",
    "denied_at",
    "consumed_at",
  ],
  desktop_sessions: [
    "id",
    "pairing_id",
    "account",
    "device_name",
    "device_platform",
    "device_app_version",
    "device_secret_challenge",
    "access_hash",
    "access_expires_at",
    "refresh_hash",
    "refresh_expires_at",
    "created_at",
    "updated_at",
    "last_used_at",
    "revoked_at",
  ],
  desktop_refresh_history: ["refresh_hash", "session_id", "rotated_at"],
  desktop_token_recoveries: [
    "pairing_id",
    "session_id",
    "device_code_hash",
    "nonce",
    "ciphertext",
    "created_at",
    "expires_at",
  ],
  desktop_rate_limits: ["scope", "key_hash", "window_started_at", "count", "blocked_until", "updated_at"],
  desktop_audit: ["id", "event", "pairing_id", "session_id", "account_hash", "ip_hash", "created_at"],
  management_audit: [
    "id",
    "cursor_token",
    "actor_account",
    "actor_kind",
    "action",
    "resource",
    "channel",
    "result",
    "timestamp",
    "metadata_json",
  ],
};

const requiredIndexes = {
  desktop_token_recoveries: ["idx_desktop_token_recoveries_expires_at"],
  management_audit: [
    "idx_management_audit_cursor_token",
    "idx_management_audit_timestamp",
    "idx_management_audit_channel",
  ],
};

function run(args) {
  const configArgs = wranglerConfig ? [...args, "--config", wranglerConfig] : args;
  const commandArgs = [...wranglerPrefix, ...configArgs];
  const res = spawnSync(wranglerBin, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    process.stderr.write(res.stdout);
    process.stderr.write(res.stderr);
    throw new Error(`${wranglerBin} ${commandArgs.join(" ")} failed`);
  }
  return `${res.stdout}${res.stderr}`;
}

function parseD1Json(output) {
  return JSON.parse(output);
}

const migrations = run(["d1", "migrations", "list", database, "--remote"]);
if (!migrations.includes("No migrations to apply")) {
  process.stderr.write(migrations);
  throw new Error("remote D1 migrations are not fully applied");
}

for (const [table, columns] of Object.entries(required)) {
  const output = run([
    "d1",
    "execute",
    database,
    "--remote",
    "--json",
    "--command",
    `PRAGMA table_info(${table})`,
  ]);
  const rows = parseD1Json(output).flatMap((entry) => entry.results ?? []);
  const names = new Set(rows.map((row) => row.name));
  const missing = columns.filter((column) => !names.has(column));
  if (missing.length > 0) {
    throw new Error(`${table} missing columns: ${missing.join(", ")}`);
  }
}

for (const [table, indexes] of Object.entries(requiredIndexes)) {
  const output = run([
    "d1",
    "execute",
    database,
    "--remote",
    "--json",
    "--command",
    `PRAGMA index_list(${table})`,
  ]);
  const rows = parseD1Json(output).flatMap((entry) => entry.results ?? []);
  const names = new Set(rows.map((row) => row.name));
  const missing = indexes.filter((index) => !names.has(index));
  if (missing.length > 0) {
    throw new Error(`${table} missing indexes: ${missing.join(", ")}`);
  }
}

console.log(JSON.stringify({ ok: true, database, tables: Object.keys(required), indexes: requiredIndexes }));
