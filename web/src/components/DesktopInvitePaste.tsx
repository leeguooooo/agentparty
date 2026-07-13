// Desktop-only entry for issue #297: paste a web invite/join link to enter a channel, reusing the
// exact same shareable link the web app produces (…/join/<code> or …/c/<slug>). The desktop shell has
// no address bar, so pasting is how a link becomes a join. Parsing/validation live in lib/invitePaste
// (host-allowlisted, pure, unit-tested); this component is the UI + wiring into the desktop session.
import { useCallback, useState } from "react";
import { AuthError, redeemJoinLink } from "../lib/api";
import { parsePastedInviteLink, resolvePastedInvite } from "../lib/invitePaste";
import { useT } from "../i18n/useT";
import "../i18n/strings/DesktopInvitePaste";

interface Props {
  token: string;
  activeOrigin: string;
  allowedOrigins: readonly string[];
  onJoined(slug: string): void;
  onAuthFailed(message: string): void;
}

export function DesktopInvitePaste({ token, activeOrigin, allowedOrigins, onJoined, onAuthFailed }: Props) {
  const t = useT();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Best-effort clipboard read. In the desktop webview this needs clipboard-read permission; if it's
  // denied or unavailable we just tell the user to paste manually — never block the manual path.
  const pasteFromClipboard = useCallback(async () => {
    setError(null);
    try {
      const text = await navigator.clipboard?.readText();
      if (typeof text === "string" && text.trim() !== "") setInput(text.trim());
    } catch {
      setError(t("DesktopInvitePaste.clipboardFailed"));
    }
  }, [t]);

  const join = useCallback(async () => {
    setError(null);
    const parsed = parsePastedInviteLink(input, allowedOrigins);
    if (parsed === null) {
      setError(t("DesktopInvitePaste.invalid"));
      return;
    }
    setBusy(true);
    const result = await resolvePastedInvite(parsed, {
      activeOrigin,
      token,
      // Reuse the web redeem endpoint with the desktop session's own access token; a stale token
      // routes to the desktop session-restore path via onAuthFailed, same as every other API call.
      redeem: async (tok, code) => {
        try {
          return await redeemJoinLink(tok, code);
        } catch (cause) {
          if (cause instanceof AuthError) onAuthFailed(cause.message);
          throw cause;
        }
      },
    });
    setBusy(false);
    switch (result.status) {
      case "navigate":
        setInput("");
        onJoined(result.slug);
        return;
      case "wrong-server":
        setError(t("DesktopInvitePaste.wrongServer", { server: result.serverOrigin }));
        return;
      case "error":
        setError(result.message);
    }
  }, [input, allowedOrigins, activeOrigin, token, onJoined, onAuthFailed, t]);

  return (
    <section className="invitepaste">
      <h2 className="invitepaste-title">{t("DesktopInvitePaste.title")}</h2>
      <p className="invitepaste-hint">{t("DesktopInvitePaste.hint")}</p>
      <div className="invitepaste-row">
        <input
          className="invitepaste-input t-mono"
          type="text"
          inputMode="url"
          spellCheck={false}
          value={input}
          placeholder={t("DesktopInvitePaste.placeholder")}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void join();
          }}
        />
        <button type="button" className="d-btn invitepaste-paste" disabled={busy} onClick={() => void pasteFromClipboard()}>
          {t("DesktopInvitePaste.paste")}
        </button>
        <button
          type="button"
          className="d-btn d-btn--primary invitepaste-join"
          disabled={busy || input.trim() === ""}
          onClick={() => void join()}
        >
          {busy ? t("DesktopInvitePaste.joining") : t("DesktopInvitePaste.join")}
        </button>
      </div>
      {error !== null && (
        <p className="invitepaste-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
