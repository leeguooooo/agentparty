import {
  refreshDesktopSession,
  refreshDesktopSessionInteractive,
  type DesktopCredentialVault,
} from "./desktopCredentials";
import { runSingleFlight } from "./desktopPairing";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type DesktopRestoreFailure = "keychain-authorization" | "retryable";

export function classifyDesktopRestoreFailure(cause: unknown): DesktopRestoreFailure {
  const message = typeof cause === "string"
    ? cause
    : cause instanceof Error
      ? cause.message
      : null;
  return message === "desktop_keychain_authorization_required" ? "keychain-authorization" : "retryable";
}

export function initialTokenForRuntime(desktop: boolean, readBrowserToken: () => string | null): string | null {
  return desktop ? null : readBrowserToken();
}

export function restoreDesktopAccessInteractive(
  vault: DesktopCredentialVault,
  origin: string,
  fetcher: Fetcher = fetch,
): Promise<string | null> {
  return runSingleFlight(
    `desktop-interactive-refresh:${origin}`,
    () => refreshDesktopSessionInteractive(vault, [origin], fetcher),
  );
}

export function restoreDesktopAccess(
  vault: DesktopCredentialVault,
  origin: string,
  fetcher: Fetcher = fetch,
): Promise<string | null> {
  return runSingleFlight(
    `desktop-startup-refresh:${origin}`,
    () => refreshDesktopSession(vault, [origin], fetcher),
  );
}
