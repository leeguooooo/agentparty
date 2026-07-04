import { spawnSync } from "node:child_process";

const database = process.env.AGENTPARTY_D1_DATABASE ?? "agentparty";

const required = {
  channels: ["id", "slug", "title", "topic", "kind", "mode", "created_by", "created_at", "archived_at"],
  tokens: ["id", "hash", "name", "role", "owner", "created_at", "revoked_at"],
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
};

function run(args) {
  const res = spawnSync("wrangler-accounts", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    process.stderr.write(res.stdout);
    process.stderr.write(res.stderr);
    throw new Error(`wrangler-accounts ${args.join(" ")} failed`);
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

console.log(JSON.stringify({ ok: true, database, tables: Object.keys(required) }));
