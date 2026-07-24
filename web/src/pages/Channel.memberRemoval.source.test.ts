// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(import.meta.dir + "/Channel.tsx", "utf8");

test("permanent member removal clears local channel snapshots only after the API succeeds", () => {
  const callbackStart = source.indexOf("const removeParticipant = useCallback");
  const callbackEnd = source.indexOf("const pauseAgentReception = useCallback", callbackStart);
  expect(callbackStart).toBeGreaterThanOrEqual(0);
  expect(callbackEnd).toBeGreaterThan(callbackStart);

  const callback = source.slice(callbackStart, callbackEnd);
  const request = callback.indexOf('kickParticipant(token, slug, name, "remove")');
  const success = callback.indexOf(".then((result) => {", request);
  const localRemoval = callback.indexOf("applyAuthoritativeParticipantRemoval(result.removal)");

  expect(request).toBeGreaterThanOrEqual(0);
  expect(success).toBeGreaterThan(request);
  expect(localRemoval).toBeGreaterThan(success);
  expect(callback.slice(0, success)).not.toContain("applyAuthoritativeParticipantRemoval");
  expect(callback).toContain("result?.removal");
});

test("only an explicit restored response releases local tombstones and refreshes roster authorities", () => {
  const helperStart = source.indexOf("const restoreParticipantProjection = useCallback");
  const helperEnd = source.indexOf("const loadSquads = useCallback", helperStart);
  expect(helperStart).toBeGreaterThanOrEqual(0);
  expect(helperEnd).toBeGreaterThan(helperStart);

  const helper = source.slice(helperStart, helperEnd);
  expect(helper).toContain("removedChannelMembersRef.current.delete(name)");
  expect(helper).toContain('dispatch({ type: "participant_restored", name })');
  expect(helper).toContain("void loadIdentities()");
  expect(helper).toContain("void loadRoles()");

  const callbackStart = source.indexOf("const removeParticipant = useCallback");
  const callbackEnd = source.indexOf("const pauseAgentReception = useCallback", callbackStart);
  const callback = source.slice(callbackStart, callbackEnd);
  const restoredBranch = callback.indexOf("if (result?.restored === true)");
  const restoreCall = callback.indexOf("restoreParticipantProjection(name)", restoredBranch);
  const removalBranch = callback.indexOf("else if (result?.removal", restoreCall);
  const applyRemoval = callback.indexOf("applyAuthoritativeParticipantRemoval(result.removal)", removalBranch);

  expect(restoredBranch).toBeGreaterThanOrEqual(0);
  expect(restoreCall).toBeGreaterThan(restoredBranch);
  expect(removalBranch).toBeGreaterThan(restoreCall);
  expect(applyRemoval).toBeGreaterThan(removalBranch);
  expect(callback.match(/restoreParticipantProjection\(name\)/g)).toHaveLength(1);
});

test("websocket participant removal uses the same role and roster cleanup path", () => {
  const socketStart = source.indexOf("const sock = new ChannelSocket");
  const socketEnd = source.indexOf("onStatus:", socketStart);
  expect(socketStart).toBeGreaterThanOrEqual(0);
  expect(socketEnd).toBeGreaterThan(socketStart);

  const callback = source.slice(socketStart, socketEnd);
  expect(callback).toContain('if (frame.type === "participant_removed")');
  expect(callback).toContain("applyAuthoritativeParticipantRemoval(frame)");
  expect(callback.indexOf("applyAuthoritativeParticipantRemoval(frame)")).toBeLessThan(callback.indexOf('dispatch({ type: "frame", frame })'));
});

test("account-scoped removal refreshes full authorities so same-owner siblings cannot remain projected", () => {
  const helperStart = source.indexOf("const applyAuthoritativeParticipantRemoval = useCallback");
  const helperEnd = source.indexOf("const restoreParticipantProjection = useCallback", helperStart);
  expect(helperStart).toBeGreaterThanOrEqual(0);
  expect(helperEnd).toBeGreaterThan(helperStart);

  const helper = source.slice(helperStart, helperEnd);
  const immediateTarget = helper.indexOf("applyParticipantRemoval(removal)");
  const refreshIdentities = helper.indexOf("void loadIdentities()", immediateTarget);
  const refreshRoles = helper.indexOf("void loadRoles()", refreshIdentities);
  expect(immediateTarget).toBeGreaterThanOrEqual(0);
  expect(refreshIdentities).toBeGreaterThan(immediateTarget);
  expect(refreshRoles).toBeGreaterThan(refreshIdentities);

  // The full REST snapshots replace local projections. If an account
  // tombstone also removed a sibling not named by the frame, its omission
  // from either authority therefore removes the stale Team/@ entry.
  const identitiesStart = source.indexOf("const loadIdentities = useCallback");
  const rolesStart = source.indexOf("const loadRoles = useCallback", identitiesStart);
  const helperBoundary = source.indexOf("const applyAuthoritativeParticipantRemoval = useCallback", rolesStart);
  const identities = source.slice(identitiesStart, rolesStart);
  const roles = source.slice(rolesStart, helperBoundary);
  expect(identities).toContain("setChannelIdentities(");
  expect(identities).toContain("identities.filter(");
  expect(roles).toContain("setChannelRoles(currentRoles)");
});

test("late identity and role responses are invalidated and filtered through one tombstone authority", () => {
  const identitiesStart = source.indexOf("const loadIdentities = useCallback");
  const rolesStart = source.indexOf("const loadRoles = useCallback", identitiesStart);
  const loadEnd = source.indexOf("const loadSquads = useCallback", rolesStart);
  expect(identitiesStart).toBeGreaterThanOrEqual(0);
  expect(rolesStart).toBeGreaterThan(identitiesStart);
  expect(loadEnd).toBeGreaterThan(rolesStart);

  const identities = source.slice(identitiesStart, rolesStart);
  const roles = source.slice(rolesStart, loadEnd);
  expect(identities).toContain("channelIdentitiesRequestRef.current");
  expect(identities).toContain("removedChannelMembersRef.current.has(identity.name)");
  expect(roles).toContain("channelRolesRequestRef.current");
  expect(roles).toContain("removedChannelMembersRef.current.has(role.name)");
});

test("authoritative welcome clears member tombstones before refreshing identities and roles", () => {
  const socketStart = source.indexOf("const sock = new ChannelSocket");
  const socketEnd = source.indexOf("onStatus:", socketStart);
  const callback = source.slice(socketStart, socketEnd);
  const welcome = callback.indexOf('if (frame.type === "welcome")');
  const clear = callback.indexOf("removedChannelMembersRef.current.delete(participant.name)", welcome);
  const refreshIdentities = callback.indexOf("void loadIdentities()", welcome);
  const refreshRoles = callback.indexOf("void loadRoles()", welcome);

  expect(welcome).toBeGreaterThanOrEqual(0);
  expect(clear).toBeGreaterThan(welcome);
  expect(refreshIdentities).toBeGreaterThan(clear);
  expect(refreshRoles).toBeGreaterThan(refreshIdentities);
});

test("authoritative participant roster clears a member tombstone for live same-name rejoin", () => {
  const socketStart = source.indexOf("const sock = new ChannelSocket");
  const socketEnd = source.indexOf("onStatus:", socketStart);
  const callback = source.slice(socketStart, socketEnd);
  const participants = callback.indexOf('if (frame.type === "participants")');
  const clear = callback.indexOf("removedChannelMembersRef.current.delete(participant.name)", participants);
  const restored = callback.indexOf("if (restoredMember)", participants);
  const refreshIdentities = callback.indexOf("void loadIdentities()", restored);
  const refreshRoles = callback.indexOf("void loadRoles()", restored);

  expect(participants).toBeGreaterThanOrEqual(0);
  expect(clear).toBeGreaterThan(participants);
  expect(restored).toBeGreaterThan(clear);
  expect(refreshIdentities).toBeGreaterThan(restored);
  expect(refreshRoles).toBeGreaterThan(refreshIdentities);
});

test("mention and Team projections use current roster authority instead of historical resurrection", () => {
  const mentionStart = source.indexOf("const mentionOptions = useMemo");
  const mentionEnd = source.indexOf("const mentionNames = useMemo", mentionStart);
  const mentionProjection = source.slice(mentionStart, mentionEnd);

  expect(mentionProjection).toContain("removedMemberNames");
  expect(mentionProjection).toContain("authoritativeMemberNames");
  expect(source).toContain("memberNames: authoritativeMemberNames");
  expect(source).toContain("memberNames={authoritativeMemberNames}");
});

test("participant removal immediately clears identity, role, draft and open detail projections", () => {
  const start = source.indexOf("const applyParticipantRemoval = useCallback");
  const end = source.indexOf("const loadCharter = useCallback", start);
  const callback = source.slice(start, end);

  expect(callback).toContain("setChannelIdentities");
  expect(callback).toContain("identity.name !== removal.name");
  expect(callback).toContain("setChannelRoles");
  expect(callback).toContain("role.name !== removal.name");
  expect(callback).toContain("delete next[removal.name]");
  expect(callback).toContain("current?.name === removal.name ? null : current");
});

test("authoritative removal retains only a session-local account and name snapshot for re-add", () => {
  const removalStart = source.indexOf("const applyParticipantRemoval = useCallback");
  const removalEnd = source.indexOf("const loadCharter = useCallback", removalStart);
  const removal = source.slice(removalStart, removalEnd);
  expect(removal).toContain("channelAdminMemberRowsRef.current.get(removal.name)");
  expect(removal).toContain("setRemovedChannelMemberSnapshots");
  expect(removal).toContain("account: member.account!");

  const rosterStart = source.indexOf("const activeChannelAdminMembers = useMemo");
  const rosterEnd = source.indexOf("const selectedTeamMember = useMemo", rosterStart);
  const roster = source.slice(rosterStart, rosterEnd);
  expect(roster).toContain("Object.values(removedChannelMemberSnapshots)");
  expect(roster).toContain("removedMemberNames.has(member.name)");
  expect(roster).toContain("canRestore: canModerate && !state.archived");
});

test("admin re-add sends the removed row account and name before releasing local guards", () => {
  const restoreStart = source.indexOf("const restoreRemovedParticipant = useCallback");
  const restoreEnd = source.indexOf("const removeParticipant = useCallback", restoreStart);
  expect(restoreStart).toBeGreaterThanOrEqual(0);
  expect(restoreEnd).toBeGreaterThan(restoreStart);

  const callback = source.slice(restoreStart, restoreEnd);
  const request = callback.indexOf(
    "addChannelMember(token, slug, member.account, member.name)",
  );
  const success = callback.indexOf(".then(() => {", request);
  const release = callback.indexOf("restoreParticipantProjection(member.name)", success);
  const failure = callback.indexOf(".catch((err: unknown) => {", release);

  expect(request).toBeGreaterThanOrEqual(0);
  expect(success).toBeGreaterThan(request);
  expect(release).toBeGreaterThan(success);
  expect(failure).toBeGreaterThan(release);
  expect(callback.slice(failure)).not.toContain("restoreParticipantProjection(member.name)");
  expect(source).toContain("onRestoreMember={restoreRemovedParticipant}");
  expect(source).toContain("restoringMember={restoringName}");
});
