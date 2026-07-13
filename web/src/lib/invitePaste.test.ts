import { describe, expect, test } from "bun:test";
import { parsePastedInviteLink, resolvePastedInvite, type ParsedInviteLink } from "./invitePaste";

const ALLOWED = ["https://agentparty.leeguoo.com", "https://agentparty.pwtk-dev.work"] as const;

describe("parsePastedInviteLink — join links (/join/<code>)", () => {
  test("parses a well-formed join link from an allowlisted server", () => {
    expect(parsePastedInviteLink("https://agentparty.leeguoo.com/join/Ab3-_xYz", ALLOWED)).toEqual({
      kind: "join",
      serverOrigin: "https://agentparty.leeguoo.com",
      code: "Ab3-_xYz",
    });
  });

  test("tolerates surrounding whitespace and a trailing slash", () => {
    expect(parsePastedInviteLink("  https://agentparty.leeguoo.com/join/abc123/  \n", ALLOWED)).toEqual({
      kind: "join",
      serverOrigin: "https://agentparty.leeguoo.com",
      code: "abc123",
    });
  });

  test("accepts the test server origin too", () => {
    expect(parsePastedInviteLink("https://agentparty.pwtk-dev.work/join/zzz", ALLOWED)).toEqual({
      kind: "join",
      serverOrigin: "https://agentparty.pwtk-dev.work",
      code: "zzz",
    });
  });

  test("rejects a join link on a non-allowlisted host", () => {
    expect(parsePastedInviteLink("https://evil.example/join/abc123", ALLOWED)).toBeNull();
  });

  test("rejects a join link that smuggles a query string", () => {
    expect(parsePastedInviteLink("https://agentparty.leeguoo.com/join/abc?t=steal", ALLOWED)).toBeNull();
  });

  test("rejects a join link with a fragment", () => {
    expect(parsePastedInviteLink("https://agentparty.leeguoo.com/join/abc#x", ALLOWED)).toBeNull();
  });

  test("rejects an empty code", () => {
    expect(parsePastedInviteLink("https://agentparty.leeguoo.com/join/", ALLOWED)).toBeNull();
  });

  test("rejects a code with illegal characters", () => {
    expect(parsePastedInviteLink("https://agentparty.leeguoo.com/join/ab.cd", ALLOWED)).toBeNull();
  });

  test("rejects path traversal that resolves away from /join", () => {
    expect(parsePastedInviteLink("https://agentparty.leeguoo.com/join/../admin", ALLOWED)).toBeNull();
  });

  test("rejects credentials embedded in the URL", () => {
    expect(parsePastedInviteLink("https://user:pw@agentparty.leeguoo.com/join/abc", ALLOWED)).toBeNull();
  });

  test("rejects a non-http(s) scheme", () => {
    expect(parsePastedInviteLink("agentparty://join/abc", ALLOWED)).toBeNull();
  });
});

describe("parsePastedInviteLink — channel share links (/c/<slug>)", () => {
  test("parses a channel link carrying a share token", () => {
    expect(parsePastedInviteLink("https://agentparty.leeguoo.com/c/general?t=share-token", ALLOWED)).toEqual({
      kind: "channel",
      serverOrigin: "https://agentparty.leeguoo.com",
      slug: "general",
      token: "share-token",
    });
  });

  test("parses a channel link without a token", () => {
    expect(parsePastedInviteLink("https://agentparty.leeguoo.com/c/team-42", ALLOWED)).toEqual({
      kind: "channel",
      serverOrigin: "https://agentparty.leeguoo.com",
      slug: "team-42",
      token: null,
    });
  });

  test("rejects an uppercase (invalid) slug", () => {
    expect(parsePastedInviteLink("https://agentparty.leeguoo.com/c/General", ALLOWED)).toBeNull();
  });

  test("rejects a channel link with an unexpected query param", () => {
    expect(parsePastedInviteLink("https://agentparty.leeguoo.com/c/general?x=1", ALLOWED)).toBeNull();
  });

  test("rejects an empty token value", () => {
    expect(parsePastedInviteLink("https://agentparty.leeguoo.com/c/general?t=", ALLOWED)).toBeNull();
  });

  test("rejects a channel link on a non-allowlisted host", () => {
    expect(parsePastedInviteLink("https://evil.example/c/general?t=x", ALLOWED)).toBeNull();
  });
});

describe("parsePastedInviteLink — junk", () => {
  test("rejects unparseable input", () => {
    expect(parsePastedInviteLink("not a url", ALLOWED)).toBeNull();
    expect(parsePastedInviteLink("", ALLOWED)).toBeNull();
    expect(parsePastedInviteLink("https://agentparty.leeguoo.com/", ALLOWED)).toBeNull();
    expect(parsePastedInviteLink("https://agentparty.leeguoo.com/settings", ALLOWED)).toBeNull();
  });
});

describe("resolvePastedInvite", () => {
  const joinLink: ParsedInviteLink = {
    kind: "join",
    serverOrigin: "https://agentparty.leeguoo.com",
    code: "abc123",
  };
  const channelLink: ParsedInviteLink = {
    kind: "channel",
    serverOrigin: "https://agentparty.leeguoo.com",
    slug: "general",
    token: "share-token",
  };

  test("redeems a join link on the active server and returns the channel to open", async () => {
    const calls: Array<{ token: string; code: string }> = [];
    const result = await resolvePastedInvite(joinLink, {
      activeOrigin: "https://agentparty.leeguoo.com",
      token: "desk-token",
      redeem: async (token, code) => {
        calls.push({ token, code });
        return { channel_slug: "secret-room", joined: true };
      },
    });
    expect(result).toEqual({ status: "navigate", slug: "secret-room" });
    expect(calls).toEqual([{ token: "desk-token", code: "abc123" }]);
  });

  test("navigates straight to a channel link without redeeming (already authed for this server)", async () => {
    let redeemed = false;
    const result = await resolvePastedInvite(channelLink, {
      activeOrigin: "https://agentparty.leeguoo.com",
      token: "desk-token",
      redeem: async () => {
        redeemed = true;
        return { channel_slug: "x", joined: true };
      },
    });
    expect(result).toEqual({ status: "navigate", slug: "general" });
    expect(redeemed).toBe(false);
  });

  test("refuses an invite for a different server than the active desktop session", async () => {
    let redeemed = false;
    const result = await resolvePastedInvite(joinLink, {
      activeOrigin: "https://agentparty.pwtk-dev.work",
      token: "desk-token",
      redeem: async () => {
        redeemed = true;
        return { channel_slug: "x", joined: true };
      },
    });
    expect(result).toEqual({ status: "wrong-server", serverOrigin: "https://agentparty.leeguoo.com" });
    expect(redeemed).toBe(false);
  });

  test("surfaces a redeem failure as an error result", async () => {
    const result = await resolvePastedInvite(joinLink, {
      activeOrigin: "https://agentparty.leeguoo.com",
      token: "desk-token",
      redeem: async () => {
        throw new Error("this invite link is no longer valid");
      },
    });
    expect(result).toEqual({ status: "error", message: "this invite link is no longer valid" });
  });
});
