import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_SIGNED_URL_TTL_SECONDS,
  createSignedAttachmentUrl,
  verifySignedAttachmentRequest,
} from "../src/attachment-signatures";

const env = { ATTACHMENT_SIGNING_SECRET: "test-attachment-signing-secret" };
const source = "https://agentparty.example/api/channels/private-room/attachments/abc123/proof.png?signed-url=1";

describe("attachment signed URLs (#521)", () => {
  it("binds the signature to the exact path and rejects extra query capabilities", async () => {
    const now = 1_700_000_000_000;
    const signed = await createSignedAttachmentUrl(source, env, now);
    expect(signed).not.toBeNull();
    expect(signed?.expiresAt).toBe(Math.floor(now / 1000) + ATTACHMENT_SIGNED_URL_TTL_SECONDS);
    expect(await verifySignedAttachmentRequest(signed!.url, env, now)).toBe(true);

    const changedPath = new URL(signed!.url);
    changedPath.pathname = changedPath.pathname.replace("proof.png", "secret.png");
    expect(await verifySignedAttachmentRequest(changedPath.toString(), env, now)).toBe(false);

    const extraQuery = new URL(signed!.url);
    extraQuery.searchParams.set("signed-url", "1");
    expect(await verifySignedAttachmentRequest(extraQuery.toString(), env, now)).toBe(false);
  });

  it("expires fail-closed and cannot sign when no deployment secret exists", async () => {
    const now = 1_700_000_000_000;
    const signed = await createSignedAttachmentUrl(source, env, now);
    expect(await verifySignedAttachmentRequest(signed!.url, env, (signed!.expiresAt + 1) * 1000)).toBe(false);
    expect(await createSignedAttachmentUrl(source, {}, now)).toBeNull();
    expect(await verifySignedAttachmentRequest(signed!.url, {}, now)).toBe(false);
    expect(await createSignedAttachmentUrl(source, {
      DESKTOP_PAIRING_SECRET: "must-not-cross-sign",
      ADMIN_SECRET: "must-not-cross-sign",
    } as Record<string, string>, now)).toBeNull();
  });
});
