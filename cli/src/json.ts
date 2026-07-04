export const JSON_SCHEMA = "agentparty.v1";

export function nowTs(): number {
  return Date.now();
}

export function jsonFrame<T extends Record<string, unknown>>(frame: T): T & { schema: string } {
  return { schema: JSON_SCHEMA, ...frame };
}
