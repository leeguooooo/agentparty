// @ts-nocheck -- Bun executes this source regression guard outside web tsconfig.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ChannelStrings } from "./Channel";

const source = readFileSync(resolve(import.meta.dir, "../../pages/Channel.tsx"), "utf8");

const REQUIRED_KEYS = [
  "Channel.banner.archived",
  "Channel.banner.readonly",
  "Channel.guard.banner",
  "Channel.guard.reset",
  "Channel.guard.resetting",
  "Channel.guard.error.forbidden",
  "Channel.guard.error.failed",
  "Channel.error.tokenRevoked",
  "Channel.error.sendNotConnected",
  "Channel.history.loadFailed",
  "Channel.history.retry",
  "Channel.upload.tooLarge",
  "Channel.upload.forbidden",
  "Channel.upload.failed",
  "Channel.charter.error.loadFailed",
  "Channel.charter.error.forbidden",
  "Channel.charter.error.tooLarge",
  "Channel.charter.error.saveFailed",
  "Channel.search.error.since",
  "Channel.search.error.limit",
  "Channel.search.error.failed",
  "Channel.catchup.aria",
  "Channel.catchup.chip.new",
  "Channel.catchup.chip.mentions",
  "Channel.catchup.chip.handled",
  "Channel.catchup.chip.blocked",
  "Channel.catchup.chip.done",
  "Channel.catchup.chip.release",
  "Channel.catchup.chip.question",
  "Channel.catchup.chip.replies",
  "Channel.completion.aria",
  "Channel.completion.meta.kickoff",
  "Channel.completion.meta.replies",
  "Channel.completion.meta.timeout",
  "Channel.completion.meta.closed",
  "Channel.filter.aria",
  "Channel.filter.modeAria",
  "Channel.filter.kindAria",
  "Channel.empty.content",
  "Channel.decision.aria",
  "Channel.decision.meta.next",
  "Channel.decision.meta.handoff",
  "Channel.decision.meta.takeover",
  "Channel.decision.meta.expires",
  "Channel.team.aria",
  "Channel.team.meta.root",
  "Channel.team.meta.parent",
  "Channel.team.meta.parents",
  "Channel.team.meta.depth",
  "Channel.team.meta.expires",
  "Channel.team.meta.seen",
  "Channel.team.front",
  "Channel.team.frontTitle",
  "Channel.team.active",
  "Channel.team.manual",
  "Channel.team.noWorkers",
  "Channel.team.memberTitle",
  "Channel.agentBoard.aria",
  "Channel.hostBoard.aria",
  "Channel.hostBoard.human",
  "Channel.hostBoard.conflictSeparator",
  "Channel.hostBoard.hostTitle",
  "Channel.hostBoard.reason",
  "Channel.teamThread.parent",
  "Channel.teamThread.parents",
  "Channel.teamThread.members",
  "Channel.teamThread.title",
  "Channel.empty.partyWatch",
  "Channel.charter.rev",
  "Channel.tasks.fromMessageTitle",
] as const;

const FORBIDDEN_VISIBLE_ENGLISH = [
  "channel archived — read-only from here on",
  "loop guard: agents hit the back-and-forth cap — a human message or reset clears it",
  '>Resetting<',
  '>Reset guard<',
  "read-only link — you're watching the party",
  "not connected — message not sent, draft kept",
  "history failed to load",
  "file too large (max 25MB)",
  "not allowed to upload here",
  "upload failed",
  "only a human owner can reset guard",
  "guard reset failed",
  "charter failed to load",
  "only moderators or hosts can edit the charter",
  "charter must be 16KB or less",
  "charter save failed",
  "since must be a non-negative integer",
  "limit must be 1..1000",
  "search failed to load",
  "token revoked — paste a new one",
  'aria-label="agent filters"',
  'aria-label="agent filter mode"',
  'aria-label="agent filter kind"',
  'aria-label="while you were away"',
  'aria-label="completion artifacts"',
  'aria-label="host decisions"',
  'aria-label="agent teams"',
  'aria-label="agent board"',
  'aria-label="host board"',
  ">no workers<",
  "party watch {slug}",
  "${message.sender.name} message #${message.seq}",
] as const;

function callbackDependencies(name: string): string {
  const start = source.indexOf(`const ${name} = useCallback`);
  expect(start, `${name} callback is missing`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n\n", start);
  return source.slice(start, end);
}

describe("Channel i18n source guard (#350)", () => {
  test("defines and uses every audited key in both locales", () => {
    for (const key of REQUIRED_KEYS) {
      expect(ChannelStrings.en[key], `missing English key: ${key}`).toBeTruthy();
      expect(ChannelStrings.zh[key], `missing Chinese key: ${key}`).toBeTruthy();
      expect(ChannelStrings.zh[key], `Chinese key still mirrors English: ${key}`).not.toBe(ChannelStrings.en[key]);
      expect(source, `Channel.tsx does not use: ${key}`).toContain(key);
    }
  });

  test("removes audited user-visible English literals from Channel.tsx", () => {
    for (const literal of FORBIDDEN_VISIBLE_ENGLISH) {
      expect(source.includes(literal), `Channel.tsx still hardcodes: ${literal}`).toBe(false);
    }
  });

  test("localizes every audited token-revoked path through the live translation ref", () => {
    const localizedPaths = source.match(/tRef\.current\("Channel\.error\.tokenRevoked"\)/g) ?? [];
    expect(localizedPaths.length).toBeGreaterThanOrEqual(30);
    expect(source).not.toContain('authFailedRef.current("token revoked');
  });

  test("keeps long-lived loaders and the socket independent from locale changes", () => {
    expect(callbackDependencies("loadRoles")).toContain('tRef.current("Channel.roles.loadFailed")');
    expect(callbackDependencies("loadRoles")).not.toMatch(/\[[^\]]*\bt\b[^\]]*\]/);
    expect(callbackDependencies("loadTaskLedger")).toContain('tRef.current("Channel.tasks.error.loadFailed")');
    expect(callbackDependencies("loadTaskLedger")).not.toMatch(/\[[^\]]*\bt\b[^\]]*\]/);
    expect(source).toContain("}, [from, limit, q, searchInputErrorKey, since, slug, token]);");

    const socketStart = source.indexOf("const sock = new ChannelSocket(");
    const socketEnd = source.indexOf("\n\n", source.indexOf("}, [", socketStart));
    const socketEffect = source.slice(socketStart, socketEnd);
    expect(socketEffect).not.toMatch(/\[[^\]]*\bt\b[^\]]*\]/);
  });

  test("leaves the #353 reconnect banner on its existing translation keys", () => {
    expect(source).toContain('t("Channel.conn.reconnecting")');
    expect(source).toContain('t("Channel.conn.closed")');
  });

  test("keeps resolved channel banners translated and surfaces the online-agents affordance in the merged Team panel", () => {
    for (const key of ["Channel.banner.archived", "Channel.banner.readonly", "Channel.guard.banner"] as const) {
      expect(source).toContain(`t("${key}")`);
      expect(ChannelStrings.zh[key]).not.toBe(ChannelStrings.en[key]);
    }
    // #370 方案A：Agent 面板并入「团队」——在线数从独立 Agent 按钮移到团队按钮的 onlineBadge。
    expect(source).toContain('t("Channel.tools.team")');
    expect(source).toContain("Channel.team.onlineBadge");
    expect(source).toContain("onlineAgentCount");
  });

  test("reject actions no longer use a browser prompt", () => {
    expect(source).not.toContain("window.prompt");
  });
});
