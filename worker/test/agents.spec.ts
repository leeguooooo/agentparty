// 账号维度自助铸 agent token（spec §5.3 / P3）：无需 ADMIN_SECRET，凭 human 账号会话即可铸。
// owner 恒 = 铸造者的 principal.account（不接受客户端传），role 固定 agent，channel_scope 可选。
// 铸造门的授权分支与身份来源无关（OIDC 人类 vs 带 owner 的 human ap_ token 走同一判定），
// OIDC 身份解析本身由 oidc.spec.ts 覆盖，这里用 human ap_ token 驱动账号会话。
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN_HEADERS, api, seedToken, uniq } from "./helpers";

// 用 ADMIN 铸一个带 owner 的 human token = 一个账号会话（account = owner）
async function humanSession(owner = "leo@leeguoo.com"): Promise<string> {
  const res = await SELF.fetch("http://ap.test/api/tokens", {
    method: "POST",
    headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ name: uniq("human"), role: "human", owner }),
  });
  if (res.status !== 201) throw new Error(`human session mint failed: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

function mintAgent(token: string | null, body: unknown): Promise<Response> {
  return SELF.fetch("http://ap.test/api/agents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agents", () => {
  it("a human account session mints an agent with owner = the caller's account", async () => {
    const session = await humanSession("leo@leeguoo.com");
    const res = await mintAgent(session, { name: uniq("bot") });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; role: string; owner: string; channel_scope?: string };
    expect(body.token).toMatch(/^ap_[0-9a-f]{32}$/);
    expect(body.role).toBe("agent");
    // owner 来自铸造者账号，不是客户端传的
    expect(body.owner).toBe("leo@leeguoo.com");
    expect(body).not.toHaveProperty("channel_scope");
    // 铸出的 token 立即可用作 bearer
    expect((await api("/api/channels", body.token)).status).toBe(200);
  });

  it("ignores a client-supplied owner and always uses the caller's account", async () => {
    const session = await humanSession("real@leeguoo.com");
    const res = await mintAgent(session, { name: uniq("bot"), owner: "victim@evil.com" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { owner: string };
    expect(body.owner).toBe("real@leeguoo.com");
  });

  it("passes channel_scope through", async () => {
    const session = await humanSession();
    const scope = uniq("scoped");
    const res = await mintAgent(session, { name: uniq("bot"), channel_scope: scope });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { channel_scope: string; role: string };
    expect(body.channel_scope).toBe(scope);
    expect(body.role).toBe("agent");
  });

  it("scoped session can only mint tokens for its own channel (no scope escalation)", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const { token: scoped } = await seedToken("human", uniq("bcorp-h"), { owner: acct, channelScope: "collab" });
    // 无 scope 请求 → 强制继承调用者的 scope，铸不出无 scope（更宽）的 token
    const r1 = await mintAgent(scoped, { name: uniq("bot") });
    expect(r1.status).toBe(201);
    expect(((await r1.json()) as { channel_scope?: string }).channel_scope).toBe("collab");
    // 请求别的频道 scope → 403，不得放大到其它频道
    const r2 = await mintAgent(scoped, { name: uniq("bot"), channel_scope: "elsewhere" });
    expect(r2.status).toBe(403);
  });

  it("rejects an invalid channel_scope", async () => {
    const session = await humanSession();
    const res = await mintAgent(session, { name: uniq("bot"), channel_scope: "Not A Slug" });
    expect(res.status).toBe(400);
  });

  it("a readonly token cannot mint (403)", async () => {
    const { token } = await seedToken("readonly", uniq("ro"), { owner: "leo@leeguoo.com" });
    const res = await mintAgent(token, { name: uniq("bot") });
    expect(res.status).toBe(403);
  });

  it("an agent token cannot mint (403)", async () => {
    const { token } = await seedToken("agent", uniq("ag"), { owner: "leo@leeguoo.com" });
    const res = await mintAgent(token, { name: uniq("bot") });
    expect(res.status).toBe(403);
  });

  it("a legacy human token without an account cannot mint (403)", async () => {
    // legacy 存量 human token：owner=null → account undefined → 无从确定归属账号
    const { token } = await seedToken("human", uniq("legacy"));
    const res = await mintAgent(token, { name: uniq("bot") });
    expect(res.status).toBe(403);
  });

  it("an anonymous request is 401", async () => {
    const res = await mintAgent(null, { name: uniq("bot") });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid or reserved name", async () => {
    const session = await humanSession();
    expect((await mintAgent(session, { name: "bad name!" })).status).toBe(400);
    expect((await mintAgent(session, { name: "system" })).status).toBe(400);
  });

  it("409 on a duplicate active name", async () => {
    const session = await humanSession();
    const name = uniq("dup");
    expect((await mintAgent(session, { name })).status).toBe(201);
    expect((await mintAgent(session, { name })).status).toBe(409);
  });

  it("the minted agent shares the minter's account: it can read the minter's private channel", async () => {
    const session = await humanSession("owner@leeguoo.com");
    // 房主账号建私有频道
    const slug = uniq("priv");
    const created = await api("/api/channels", session, {
      method: "POST",
      body: JSON.stringify({ slug, kind: "standing", visibility: "private" }),
    });
    expect(created.status).toBe(201);
    // 同账号铸出的 agent
    const minted = await mintAgent(session, { name: uniq("bot") });
    const agentToken = ((await minted.json()) as { token: string }).token;
    // agent 与房主同账号 → 能进私有频道
    expect((await api(`/api/channels/${slug}/messages`, agentToken)).status).toBe(200);
    // 且该私有频道出现在 agent 的频道列表里
    const list = (await (await api("/api/channels", agentToken)).json()) as { channels: { slug: string }[] };
    expect(list.channels.some((ch) => ch.slug === slug)).toBe(true);
  });
});

describe("current-account channel agent inventory", () => {
  it("lists only the caller's own channel-scoped agents and never returns plaintext tokens", async () => {
    const owner = "owner@leeguoo.com";
    const other = "other@leeguoo.com";
    const session = await humanSession(owner);
    const otherSession = await humanSession(other);
    const slug = uniq("agents");
    const created = await api("/api/channels", session, {
      method: "POST",
      body: JSON.stringify({ slug, kind: "standing", visibility: "private" }),
    });
    expect(created.status).toBe(201);

    const mine = await mintAgent(session, { name: uniq("mine"), channel_scope: slug });
    expect(mine.status).toBe(201);
    const mineBody = (await mine.json()) as { name: string };
    expect((await mintAgent(session, { name: uniq("other-scope"), channel_scope: uniq("elsewhere") })).status).toBe(201);
    expect((await mintAgent(otherSession, { name: uniq("theirs"), channel_scope: slug })).status).toBe(201);

    const listed = await api(`/api/channels/${slug}/agents`, session);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { agents: { name: string; token?: string; owner: string; channel_scope: string; nickname?: string | null }[] };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({ name: mineBody.name, owner, channel_scope: slug });
    expect(body.agents[0]).not.toHaveProperty("token");
  });

  it("lets the owning human set a channel agent nickname and returns it in inventory", async () => {
    const owner = "nickname-owner@leeguoo.com";
    const session = await humanSession(owner);
    const slug = uniq("nickname-ui");
    expect((await api("/api/channels", session, {
      method: "POST",
      body: JSON.stringify({ slug, kind: "standing", visibility: "private" }),
    })).status).toBe(201);
    const minted = await mintAgent(session, { name: uniq("bot"), channel_scope: slug });
    const agent = (await minted.json()) as { name: string; token: string };

    const updated = await api(`/api/channels/${slug}/agents/${encodeURIComponent(agent.name)}/nickname`, session, {
      method: "PUT",
      body: JSON.stringify({ nickname: "页面小助手" }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ name: agent.name, nickname: "页面小助手" });

    const listed = (await (await api(`/api/channels/${slug}/agents`, session)).json()) as {
      agents: { name: string; nickname: string | null }[];
    };
    expect(listed.agents).toContainEqual(expect.objectContaining({ name: agent.name, nickname: "页面小助手" }));
    expect(((await (await api("/api/me", agent.token)).json()) as { handle: string | null }).handle).toBe("页面小助手");
    const audit = (await (await api(`/api/channels/${slug}/management-audit?limit=100`, session)).json()) as {
      audit: { action: string; resource: string; channel: string | null; metadata: Record<string, unknown> }[];
    };
    expect(audit.audit).toContainEqual(expect.objectContaining({
      action: "agent.nickname.update",
      resource: `token/${agent.name}`,
      channel: slug,
      metadata: {},
    }));
  });

  it("rejects invalid/conflicting nicknames and never lets another account rename the agent", async () => {
    const owner = "nickname-guard@leeguoo.com";
    const session = await humanSession(owner);
    const other = await humanSession("nickname-other@leeguoo.com");
    const slug = uniq("nickname-guard");
    expect((await api("/api/channels", session, {
      method: "POST",
      body: JSON.stringify({ slug, kind: "standing", visibility: "public" }),
    })).status).toBe(201);
    const first = (await (await mintAgent(session, { name: uniq("first"), channel_scope: slug })).json()) as { name: string; token: string };
    const second = (await (await mintAgent(session, { name: uniq("second"), channel_scope: slug })).json()) as { name: string };
    const route = (name: string) => `/api/channels/${slug}/agents/${encodeURIComponent(name)}/nickname`;
    const put = (token: string, name: string, nickname: unknown) => api(route(name), token, {
      method: "PUT",
      body: JSON.stringify({ nickname }),
    });

    expect((await put(session, first.name, "bad nickname")).status).toBe(400);
    expect((await put(session, first.name, "唯一页面昵称")).status).toBe(200);
    expect((await put(session, second.name, "唯一页面昵称")).status).toBe(409);
    // 公共频道对 other 可读，仍必须被 token.owner 绑定挡住；不能靠外层 private ACL 偶然过测试。
    expect((await put(other, first.name, "越权改名")).status).toBe(404);
    expect((await put(first.token, first.name, "agent自己走owner端点")).status).toBe(403);
  });

  it("rotates only the caller's own channel-scoped agent token and invalidates the previous plaintext", async () => {
    const owner = "owner@leeguoo.com";
    const session = await humanSession(owner);
    const slug = uniq("rotate");
    expect(
      (
        await api("/api/channels", session, {
          method: "POST",
          body: JSON.stringify({ slug, kind: "standing", visibility: "private" }),
        })
      ).status,
    ).toBe(201);
    const minted = await mintAgent(session, { name: uniq("bot"), channel_scope: slug });
    expect(minted.status).toBe(201);
    const first = (await minted.json()) as { name: string; token: string };
    expect((await api(`/api/channels/${slug}/messages`, first.token)).status).toBe(200);

    const rotated = await api(`/api/channels/${slug}/agents/${encodeURIComponent(first.name)}/rotate`, session, {
      method: "POST",
    });
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as { name: string; token: string; owner: string; channel_scope: string };
    expect(next.name).toBe(first.name);
    expect(next.owner).toBe(owner);
    expect(next.channel_scope).toBe(slug);
    expect(next.token).toMatch(/^ap_[0-9a-f]{32}$/);
    expect(next.token).not.toBe(first.token);
    expect((await api(`/api/channels/${slug}/messages`, first.token)).status).toBe(401);
    expect((await api(`/api/channels/${slug}/messages`, next.token)).status).toBe(200);
  });

  it("does not let another account list or rotate private-channel agents", async () => {
    const ownerSession = await humanSession("owner@leeguoo.com");
    const otherSession = await humanSession("other@leeguoo.com");
    const slug = uniq("private-agents");
    expect(
      (
        await api("/api/channels", ownerSession, {
          method: "POST",
          body: JSON.stringify({ slug, kind: "standing", visibility: "private" }),
        })
      ).status,
    ).toBe(201);
    const minted = await mintAgent(ownerSession, { name: uniq("bot"), channel_scope: slug });
    const body = (await minted.json()) as { name: string };

    expect((await api(`/api/channels/${slug}/agents`, otherSession)).status).toBe(403);
    expect((await api(`/api/channels/${slug}/agents/${encodeURIComponent(body.name)}/rotate`, otherSession, { method: "POST" })).status).toBe(403);
  });
});

describe("project agent profiles", () => {
  async function saveProfile(session: string, body: Record<string, unknown>): Promise<Response> {
    return api("/api/agent-profiles", session, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("creates and lists reusable profiles only for the current account", async () => {
    const owner = "owner@leeguoo.com";
    const session = await humanSession(owner);
    const otherSession = await humanSession("other@leeguoo.com");
    const created = await saveProfile(session, {
      handle: "herness-dev",
      name: "Herness Dev",
      runner: "codex-sdk",
      repo_url: "git@github.com:leeguooooo/herness-use.git",
      workdir: "/Users/leo/github.com/herness-use",
      base_branch: "main",
      worktree_strategy: "branch",
      rules: "Report readiness before taking work.",
      invitable_by: "owner",
    });
    expect(created.status).toBe(201);
    const profile = (await created.json()) as { owner_account: string; handle: string; runner: string; token?: string };
    expect(profile).toMatchObject({ owner_account: owner, handle: "herness-dev", runner: "codex-sdk" });
    expect(profile).not.toHaveProperty("token");

    const mine = (await (await api("/api/agent-profiles", session)).json()) as { profiles: { handle: string }[] };
    expect(mine.profiles.map((p) => p.handle)).toContain("herness-dev");
    const theirs = (await (await api("/api/agent-profiles", otherSession)).json()) as { profiles: { handle: string }[] };
    expect(theirs.profiles).toHaveLength(0);
  });

  it("persists channel invites and enforces invitable_by", async () => {
    const owner = "profile-owner@leeguoo.com";
    const other = "other-inviter@leeguoo.com";
    const ownerSession = await humanSession(owner);
    const otherSession = await humanSession(other);
    expect((await saveProfile(ownerSession, { handle: "builder", runner: "codex", invitable_by: "owner" })).status).toBe(201);
    const slug = uniq("project-agent");
    expect(
      (
        await api("/api/channels", otherSession, {
          method: "POST",
          body: JSON.stringify({ slug, kind: "standing", visibility: "private" }),
        })
      ).status,
    ).toBe(201);

    const denied = await api(`/api/channels/${slug}/project-agents`, otherSession, {
      method: "POST",
      body: JSON.stringify({ owner_account: owner, handle: "builder" }),
    });
    expect(denied.status).toBe(403);

    expect((await saveProfile(ownerSession, { handle: "builder", runner: "codex", invitable_by: "anyone" })).status).toBe(201);
    const invited = await api(`/api/channels/${slug}/project-agents`, otherSession, {
      method: "POST",
      body: JSON.stringify({ owner_account: owner, handle: "builder" }),
    });
    expect(invited.status).toBe(201);
    const invite = (await invited.json()) as { channel_slug: string; owner_account: string; profile_handle: string; already_invited: boolean };
    expect(invite).toMatchObject({ channel_slug: slug, owner_account: owner, profile_handle: "builder", already_invited: false });

    const again = await api(`/api/channels/${slug}/project-agents`, otherSession, {
      method: "POST",
      body: JSON.stringify({ owner_account: owner, handle: "builder" }),
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { already_invited: boolean }).already_invited).toBe(true);

    const inbox = (await (await api("/api/agent-profiles/invites", ownerSession)).json()) as {
      invites: { channel_slug: string; profile: { handle: string } }[];
    };
    expect(inbox.invites).toContainEqual(expect.objectContaining({ channel_slug: slug, profile: expect.objectContaining({ handle: "builder" }) }));
  });

  it("mints profile and per-channel runtime tokens, and revokes only the removed channel", async () => {
    const owner = "runtime-owner@leeguoo.com";
    const inviter = "runtime-inviter@leeguoo.com";
    const ownerSession = await humanSession(owner);
    const inviterSession = await humanSession(inviter);
    expect((await saveProfile(ownerSession, { handle: "resident", runner: "codex-sdk", invitable_by: "anyone" })).status).toBe(201);
    const invitedSlug = uniq("runtime-invited");
    const secondSlug = uniq("runtime-second");
    const otherSlug = uniq("runtime-other");
    for (const slug of [invitedSlug, secondSlug, otherSlug]) {
      expect(
        (
          await api("/api/channels", inviterSession, {
            method: "POST",
            body: JSON.stringify({ slug, kind: "standing", visibility: "private" }),
          })
        ).status,
      ).toBe(201);
    }
    for (const slug of [invitedSlug, secondSlug]) {
      expect(
        (
          await api(`/api/channels/${slug}/project-agents`, inviterSession, {
            method: "POST",
            body: JSON.stringify({ owner_account: owner, handle: "resident" }),
          })
        ).status,
      ).toBe(201);
    }

    const runtime = await api("/api/agent-profiles/resident/runtime-token", ownerSession, { method: "POST" });
    expect(runtime.status).toBe(201);
    const runtimeBody = (await runtime.json()) as { token: string; profile: { handle: string } };
    expect(runtimeBody.profile.handle).toBe("resident");
    expect((await api(`/api/channels/${invitedSlug}/messages`, runtimeBody.token)).status).toBe(200);
    expect((await api(`/api/channels/${otherSlug}/messages`, runtimeBody.token)).status).toBe(403);
    const channels = (await (await api("/api/channels", runtimeBody.token)).json()) as { channels: { slug: string }[] };
    expect(channels.channels.map((ch) => ch.slug)).toContain(invitedSlug);
    expect(channels.channels.map((ch) => ch.slug)).toContain(secondSlug);
    expect(channels.channels.map((ch) => ch.slug)).not.toContain(otherSlug);

    const firstChild = await api(`/api/channels/${invitedSlug}/project-agents/runtime-token`, runtimeBody.token, {
      method: "POST",
      body: JSON.stringify({ owner_account: owner, handle: "resident", name: "resident-child-a" }),
    });
    expect(firstChild.status).toBe(201);
    const firstChildBody = (await firstChild.json()) as { token: string; channel_scope: string; lineage: { parent_agent: string } };
    expect(firstChildBody.channel_scope).toBe(invitedSlug);
    expect(firstChildBody.lineage.parent_agent).toBe("resident");
    const secondChild = await api(`/api/channels/${secondSlug}/project-agents/runtime-token`, runtimeBody.token, {
      method: "POST",
      body: JSON.stringify({ owner_account: owner, handle: "resident", name: "resident-child-b" }),
    });
    expect(secondChild.status).toBe(201);
    const secondChildBody = (await secondChild.json()) as { token: string };
    expect((await api(`/api/channels/${invitedSlug}/messages`, firstChildBody.token)).status).toBe(200);
    expect((await api(`/api/channels/${secondSlug}/messages`, secondChildBody.token)).status).toBe(200);

    const removed = await api(`/api/channels/${invitedSlug}/project-agents`, inviterSession, {
      method: "DELETE",
      body: JSON.stringify({ owner_account: owner, handle: "resident" }),
    });
    expect(removed.status).toBe(200);
    expect((await api(`/api/channels/${invitedSlug}/messages`, firstChildBody.token)).status).toBe(401);
    expect((await api(`/api/channels/${invitedSlug}/messages`, runtimeBody.token)).status).toBe(403);
    expect((await api(`/api/channels/${secondSlug}/messages`, secondChildBody.token)).status).toBe(200);
  });

  it("allows org-scoped project agent invites only within the owner domain", async () => {
    const owner = "profile-owner@leeguoo.com";
    const sameOrg = "teammate@leeguoo.com";
    const otherOrg = "stranger@example.com";
    const ownerSession = await humanSession(owner);
    const sameOrgSession = await humanSession(sameOrg);
    const otherOrgSession = await humanSession(otherOrg);
    expect((await saveProfile(ownerSession, { handle: "orgbot", runner: "codex", invitable_by: "org" })).status).toBe(201);
    const sameSlug = uniq("org-same");
    const otherSlug = uniq("org-other");
    for (const [slug, session] of [[sameSlug, sameOrgSession], [otherSlug, otherOrgSession]] as const) {
      expect(
        (
          await api("/api/channels", session, {
            method: "POST",
            body: JSON.stringify({ slug, kind: "standing", visibility: "private" }),
          })
        ).status,
      ).toBe(201);
    }
    expect(
      (
        await api(`/api/channels/${sameSlug}/project-agents`, sameOrgSession, {
          method: "POST",
          body: JSON.stringify({ owner_account: owner, handle: "orgbot" }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api(`/api/channels/${otherSlug}/project-agents`, otherOrgSession, {
          method: "POST",
          body: JSON.stringify({ owner_account: owner, handle: "orgbot" }),
        })
      ).status,
    ).toBe(403);
  });
});
