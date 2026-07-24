import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerFrame } from "@agentparty/shared";
import {
  AuthError,
  fetchPendingDecisions,
  ForbiddenError,
  type AuthoritativePendingDecision,
} from "./api";

const PENDING_DECISION_REFRESH_MS = 30_000;

interface PendingDecisionScheduler {
  every(callback: () => void, intervalMs: number): () => void;
}

const defaultScheduler: PendingDecisionScheduler = {
  every(callback, intervalMs) {
    const timer = globalThis.setInterval(callback, intervalMs);
    return () => globalThis.clearInterval(timer);
  },
};

export type PendingDecisionLoadError =
  | { kind: "forbidden" }
  | { kind: "load_failed" };

export interface PendingDecisionLoadState {
  /**
   * The most recent complete API result. `null` means no request has ever
   * succeeded, which is intentionally distinct from a successful empty list.
   */
  lastSuccessfulData: AuthoritativePendingDecision[] | null;
  loading: boolean;
  error: PendingDecisionLoadError | null;
}

const INITIAL_PENDING_DECISION_STATE: PendingDecisionLoadState = {
  lastSuccessfulData: null,
  loading: true,
  error: null,
};

export function frameMayChangePendingDecisions(frame: ServerFrame): boolean {
  if (frame.type === "msg" || frame.type === "status") {
    return frame.decision_request !== undefined;
  }
  if (frame.type !== "message_update") return false;
  return (
    frame.action === "decision" ||
    frame.action === "retract" ||
    frame.message.decision_request !== undefined
  );
}

export function useAuthoritativePendingDecisions({
  token,
  slug,
  onAuthError,
  load = fetchPendingDecisions,
  scheduler = defaultScheduler,
}: {
  token: string;
  slug: string;
  onAuthError(): void;
  load?: (token: string, slug: string) => Promise<AuthoritativePendingDecision[]>;
  scheduler?: PendingDecisionScheduler;
}): {
  lastSuccessfulData: AuthoritativePendingDecision[] | null;
  loading: boolean;
  error: PendingDecisionLoadError | null;
  refresh(): Promise<void>;
  observeFrame(frame: ServerFrame): void;
} {
  const [state, setState] = useState<PendingDecisionLoadState>(INITIAL_PENDING_DECISION_STATE);
  const aliveRef = useRef(false);
  const requestRef = useRef(0);
  const onAuthErrorRef = useRef(onAuthError);
  onAuthErrorRef.current = onAuthError;

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    if (aliveRef.current) {
      setState((current) => ({ ...current, loading: true, error: null }));
    }
    try {
      const next = await load(token, slug);
      if (aliveRef.current && request === requestRef.current) {
        setState({ lastSuccessfulData: next, loading: false, error: null });
      }
    } catch (error) {
      if (!aliveRef.current || request !== requestRef.current) return;
      if (error instanceof AuthError) {
        setState((current) => ({ ...current, loading: false, error: null }));
        onAuthErrorRef.current();
        return;
      }
      if (error instanceof ForbiddenError) {
        setState({
          lastSuccessfulData: null,
          loading: false,
          error: { kind: "forbidden" },
        });
        return;
      }
      setState((current) => ({
        ...current,
        loading: false,
        error: { kind: "load_failed" },
      }));
    }
  }, [load, slug, token]);

  useEffect(() => {
    aliveRef.current = true;
    setState(INITIAL_PENDING_DECISION_STATE);
    void refresh();
    const cancel = scheduler.every(() => void refresh(), PENDING_DECISION_REFRESH_MS);
    return () => {
      aliveRef.current = false;
      requestRef.current += 1;
      cancel();
    };
  }, [refresh, scheduler]);

  const observeFrame = useCallback((frame: ServerFrame) => {
    if (frameMayChangePendingDecisions(frame)) void refresh();
  }, [refresh]);

  return { ...state, refresh, observeFrame };
}
