export type CredentialState = "healthy" | "cooldown" | "exhausted" | "revoked";

export interface PoolCredential {
  id: string;
  secret: string;
}

interface CredentialRecord extends PoolCredential {
  state: CredentialState;
  retryAt?: number;
  attempts: number;
  successes: number;
  failures: number;
}

export interface PoolSnapshot {
  id: string;
  state: CredentialState;
  retryAt?: number;
  attempts: number;
  successes: number;
  failures: number;
}

export interface PoolEvent {
  credentialId: string;
  outcome: "success" | "cooldown" | "exhausted" | "revoked" | "transient_failure";
  status?: number;
}

export interface GrokPoolOptions {
  credentials: PoolCredential[];
  cooldownMs?: number;
  transientCooldownMs?: number;
  now?: () => number;
  logger?: (event: PoolEvent) => void;
}

type RequestWithSignal = { readonly signal: AbortSignal };
type ReplayableRequest<T> = RequestWithSignal & { clone(): T };

const unavailable = () => Response.json({
  error: {
    code: "pool_exhausted",
    message: "No authorized Grok credential is currently available",
  },
}, { status: 503 });

async function errorMessage(response: Response): Promise<string> {
  const payload = await response.clone().json().catch(() => null) as { error?: { message?: unknown } } | null;
  return typeof payload?.error?.message === "string" ? payload.error.message : "";
}

export function createGrokPool(options: GrokPoolOptions) {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? 60_000;
  const transientCooldownMs = options.transientCooldownMs ?? 5_000;
  const logger = options.logger ?? (() => undefined);
  let records: CredentialRecord[] = options.credentials.map((credential) => ({
    ...credential,
    state: "healthy",
    attempts: 0,
    successes: 0,
    failures: 0,
  }));

  function refreshCooldowns() {
    const current = now();
    for (const record of records) {
      if (record.state === "cooldown" && (record.retryAt ?? Infinity) <= current) {
        record.state = "healthy";
        delete record.retryAt;
      }
    }
  }

  function nextHealthy(excluded: Set<string>): CredentialRecord | undefined {
    refreshCooldowns();
    return records.find((record) => record.state === "healthy" && !excluded.has(record.id));
  }

  function coolDown(record: CredentialRecord, duration: number) {
    record.state = "cooldown";
    record.retryAt = now() + duration;
  }

  async function classifyFailure(record: CredentialRecord, response: Response): Promise<void> {
    const message = await errorMessage(response);
    if (message.includes("personal-team-blocked:spending-limit")) {
      record.state = "exhausted";
      logger({ credentialId: record.id, outcome: "exhausted", status: response.status });
      return;
    }
    if (response.status === 401 || response.status === 403) {
      record.state = "revoked";
      logger({ credentialId: record.id, outcome: "revoked", status: response.status });
      return;
    }
    if (response.status === 429) {
      coolDown(record, cooldownMs);
      logger({ credentialId: record.id, outcome: "cooldown", status: response.status });
      return;
    }
    coolDown(record, transientCooldownMs);
    logger({ credentialId: record.id, outcome: "transient_failure", status: response.status });
  }

  return {
    replaceCredentials(credentials: PoolCredential[]): void {
      const existing = new Map(records.map((record) => [record.id, record]));
      records = credentials.map((credential) => {
        const current = existing.get(credential.id);
        if (!current) {
          return { ...credential, state: "healthy", attempts: 0, successes: 0, failures: 0 };
        }
        return { ...current, ...credential };
      });
    },

    async handle<T>(
      request: ReplayableRequest<T>,
      send: (credential: PoolCredential, request: T) => Promise<Response>,
    ): Promise<Response> {
      const attempted = new Set<string>();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const record = nextHealthy(attempted);
        if (!record) return unavailable();
        attempted.add(record.id);
        record.attempts += 1;
        let response: Response;
        try {
          response = await send({ id: record.id, secret: record.secret }, request.clone());
        } catch (error) {
          if (request.signal.aborted) throw error;
          record.failures += 1;
          coolDown(record, transientCooldownMs);
          logger({ credentialId: record.id, outcome: "transient_failure" });
          continue;
        }
        if (response.ok) {
          record.successes += 1;
          logger({ credentialId: record.id, outcome: "success", status: response.status });
          return response;
        }
        record.failures += 1;
        await classifyFailure(record, response);
      }
      return unavailable();
    },

    snapshot(): PoolSnapshot[] {
      refreshCooldowns();
      return records.map(({ id, state, retryAt, attempts, successes, failures }) => ({
        id,
        state,
        attempts,
        successes,
        failures,
        ...(retryAt === undefined ? {} : { retryAt }),
      }));
    },
  };
}
