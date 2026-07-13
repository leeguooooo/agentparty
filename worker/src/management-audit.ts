import type { TokenIdentity } from "./auth";

export const MANAGEMENT_AUDIT_DEFAULT_LIMIT = 50;
export const MANAGEMENT_AUDIT_MAX_LIMIT = 100;

export type ManagementAuditActorKind = "admin" | "human" | "agent";
export type ManagementAuditAction =
  | "token.issue"
  | "token.revoke"
  | "channel.create"
  | "channel.permissions.update"
  | "channel.visibility.update"
  | "channel.member.add"
  | "channel.member.remove"
  | "channel.role.assign"
  | "channel.role.remove"
  | "channel.join_link.create"
  | "channel.join_link.revoke"
  | "channel.join_request.approve"
  | "channel.join_request.reject"
  | "channel.project_agent.invite"
  | "channel.project_agent.remove"
  | "channel.guard.update"
  | "channel.guard.reset"
  | "channel.webhook.add"
  | "channel.webhook.remove"
  | "channel.webhook.redeliver"
  | "channel.archive"
  | "channel.identity.erase"
  | "channel.export"
  | "channel.retention.update"
  | "membership.set";

export interface ManagementAuditActor {
  account: string | null;
  kind: ManagementAuditActorKind;
}

export interface ManagementAuditEntry {
  actor_account: string | null;
  actor_kind: ManagementAuditActorKind;
  action: ManagementAuditAction;
  resource: string;
  channel: string | null;
  result: "success";
  timestamp: number;
  metadata: Record<string, unknown>;
}

export interface ManagementAuditPage {
  audit: ManagementAuditEntry[];
  next_cursor: string | null;
}

interface ManagementAuditWrite {
  actor: ManagementAuditActor;
  action: ManagementAuditAction;
  resource: string;
  channel?: string | null;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

const PERMISSION_FIELDS = new Set([
  "charter_write",
  "charter_write_agents",
  "charter_write_agent_allowlist",
  "members_list",
  "members_list_agents",
  "members_list_agent_allowlist",
]);

function safeMetadata(action: ManagementAuditAction, input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const metadata = input as Record<string, unknown>;
  if (action === "token.issue") {
    const result: Record<string, unknown> = {};
    if (metadata.token_role === "agent" || metadata.token_role === "human" || metadata.token_role === "readonly") {
      result.token_role = metadata.token_role;
    }
    if (typeof metadata.channel_scope === "string") result.channel_scope = metadata.channel_scope;
    return result;
  }
  if (action === "channel.permissions.update") {
    const fields = Array.isArray(metadata.permission_fields)
      ? metadata.permission_fields.filter((field): field is string => typeof field === "string" && PERMISSION_FIELDS.has(field))
      : [];
    return fields.length === 0 ? {} : { permission_fields: [...new Set(fields)].sort() };
  }
  if (action === "channel.visibility.update") {
    return metadata.visibility === "public" || metadata.visibility === "private"
      ? { visibility: metadata.visibility }
      : {};
  }
  if (action === "channel.webhook.add") {
    return metadata.webhook_filter === "mentions" ||
      metadata.webhook_filter === "status" ||
      metadata.webhook_filter === "needs-human" ||
      metadata.webhook_filter === "all"
      ? { webhook_filter: metadata.webhook_filter }
      : {};
  }
  if (action === "channel.create") {
    const result: Record<string, unknown> = {};
    if (metadata.kind === "standing" || metadata.kind === "temp") result.kind = metadata.kind;
    if (metadata.mode === "normal" || metadata.mode === "party") result.mode = metadata.mode;
    if (metadata.visibility === "public" || metadata.visibility === "private") result.visibility = metadata.visibility;
    return result;
  }
  if (action === "channel.role.assign") {
    return metadata.role === "host" ||
      metadata.role === "worker" ||
      metadata.role === "reviewer" ||
      metadata.role === "observer"
      ? { role: metadata.role }
      : {};
  }
  if (action === "channel.guard.update") {
    return metadata.guard === "completion_gate" ||
      metadata.guard === "decision_mode" ||
      metadata.guard === "loop_guard" ||
      metadata.guard === "workflow_guard"
      ? { guard: metadata.guard }
      : {};
  }
  if (action === "channel.guard.reset") {
    return metadata.guard === "loop" || metadata.guard === "workflow" ? { guard: metadata.guard } : {};
  }
  if (action === "channel.identity.erase") {
    // GDPR 硬擦除（#421）：只留各表命中数（纯数字，无内容），供合规追溯「删了多少行」。
    const result: Record<string, unknown> = {};
    for (const field of [
      "messages_scrubbed",
      "audit_deleted",
      "wake_ledger_deleted",
      "read_cursors_deleted",
      "presence_deleted",
    ]) {
      const value = metadata[field];
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) result[field] = value;
    }
    return result;
  }
  if (action === "channel.retention.update") {
    const result: Record<string, unknown> = {};
    for (const field of ["message_retention_ms", "audit_retention_ms"]) {
      const value = metadata[field];
      if (value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 60_000)) {
        result[field] = value;
      }
    }
    return result;
  }
  if (action === "membership.set") {
    return metadata.tier === "free" || metadata.tier === "member" ? { tier: metadata.tier } : {};
  }
  return {};
}

export function managementAuditActor(identity: TokenIdentity): ManagementAuditActor {
  return { account: identity.account ?? null, kind: identity.kind };
}

export const managementAuditAdminActor: ManagementAuditActor = Object.freeze({ account: null, kind: "admin" });

async function recordManagementAudit(db: D1Database, event: ManagementAuditWrite): Promise<void> {
  const metadata = safeMetadata(event.action, event.metadata);
  const cursorToken = `mc_${crypto.randomUUID().replaceAll("-", "")}`;
  await db.prepare(
    `INSERT INTO management_audit (
       cursor_token, actor_account, actor_kind, action, resource, channel, result, timestamp, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      cursorToken,
      event.actor.account,
      event.actor.kind,
      event.action,
      event.resource,
      event.channel ?? null,
      "success",
      event.timestamp ?? Date.now(),
      JSON.stringify(metadata),
    )
    .run();
}

export async function bestEffortRecordManagementAudit(db: D1Database, event: ManagementAuditWrite): Promise<void> {
  try {
    await recordManagementAudit(db, event);
  } catch {
    try {
      console.error(
        "management_audit_write_failed",
        JSON.stringify({ action: event.action, channel: event.channel ?? null }),
      );
    } catch {
      // Audit and its fallback marker must never break an already-committed management operation.
    }
  }
}

export function parseManagementAuditPagination(
  url: URL,
): { limit: number; cursor: string | null } | null {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? MANAGEMENT_AUDIT_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MANAGEMENT_AUDIT_MAX_LIMIT) return null;
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor === null) return { limit, cursor: null };
  return /^mc_[0-9a-f]{32}$/.test(rawCursor) ? { limit, cursor: rawCursor } : null;
}

interface ManagementAuditRow {
  id: number;
  cursor_token: string;
  actor_account: string | null;
  actor_kind: ManagementAuditActorKind;
  action: ManagementAuditAction;
  resource: string;
  channel: string | null;
  result: "success";
  timestamp: number;
  metadata_json: string;
}

export async function listManagementAudit(
  db: D1Database,
  options: { channel?: string; limit: number; cursor: string | null },
): Promise<ManagementAuditPage | null> {
  const where: string[] = [];
  const bindings: Array<string | number> = [];
  if (options.channel !== undefined) {
    where.push("channel = ?");
    bindings.push(options.channel);
  }
  if (options.cursor !== null) {
    const cursorRow = options.channel === undefined
      ? await db.prepare("SELECT id FROM management_audit WHERE cursor_token = ?")
        .bind(options.cursor)
        .first<{ id: number }>()
      : await db.prepare("SELECT id FROM management_audit WHERE cursor_token = ? AND channel = ?")
        .bind(options.cursor, options.channel)
        .first<{ id: number }>();
    if (cursorRow === null) return null;
    where.push("id < ?");
    bindings.push(cursorRow.id);
  }
  const query = `SELECT id, cursor_token, actor_account, actor_kind, action, resource, channel, result, timestamp, metadata_json
                   FROM management_audit
                  ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
                  ORDER BY id DESC
                  LIMIT ?`;
  const rows = await db.prepare(query)
    .bind(...bindings, options.limit + 1)
    .all<ManagementAuditRow>();
  const pageRows = (rows.results ?? []).slice(0, options.limit);
  return {
    audit: pageRows.map((row) => ({
      actor_account: row.actor_account,
      actor_kind: row.actor_kind,
      action: row.action,
      resource: row.resource,
      channel: row.channel,
      result: row.result,
      timestamp: row.timestamp,
      metadata: safeMetadata(row.action, JSON.parse(row.metadata_json) as unknown),
    })),
    next_cursor:
      (rows.results?.length ?? 0) > options.limit && pageRows.length > 0
        ? pageRows[pageRows.length - 1].cursor_token
        : null,
  };
}
