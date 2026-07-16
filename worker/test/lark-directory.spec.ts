import { env } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearLarkTokenCache } from "../src/integrations/lark";
import { api, createChannel, seedToken, uniq } from "./helpers";
import { fetchMock } from "./fetch-mock";

const LARK_ORIGIN = "https://open.larksuite.com";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  clearLarkTokenCache();
  fetchMock.assertNoPendingInterceptors();
  vi.restoreAllMocks();
});

afterAll(() => fetchMock.deactivate());

async function larkHuman(tenantKey = "tenant-test") {
  const account = `lark-main:${uniq("on_owner")}`;
  const human = await seedToken("human", uniq("human"), { owner: account });
  await env.DB.prepare(
    `INSERT INTO account_profiles (
       account, handle, display_name, provider, provider_user_id, tenant_key, created_at, updated_at
     ) VALUES (?, ?, 'Owner', 'lark-main', ?, ?, ?, ?)`,
  )
    .bind(account, uniq("owner"), account.slice("lark-main:".length), tenantKey, Date.now(), Date.now())
    .run();
  return { ...human, account };
}

function mockTenantToken() {
  fetchMock.get(LARK_ORIGIN)
    .intercept({ path: "/open-apis/auth/v3/tenant_access_token/internal", method: "POST" })
    .reply(200, { code: 0, tenant_access_token: "tenant-secret-token", expire: 3600 });
}

function decodeDirectoryCursor(cursor: string): Record<string, unknown> {
  const payload = cursor.split(".", 1)[0].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="))) as Record<string, unknown>;
}

function mockDirectoryPage(options: { permissionDenied?: boolean; persist?: boolean } = {}) {
  const interceptor = fetchMock.get(LARK_ORIGIN)
    .intercept({
      path: "/open-apis/contact/v3/users/find_by_department?user_id_type=union_id&department_id_type=open_department_id&department_id=0&page_size=20",
      method: "GET",
    })
    .reply(200, options.permissionDenied
      ? { code: 41050, msg: "no user authority" }
      : {
          code: 0,
          data: {
            has_more: true,
            page_token: "next-page",
            items: [
              {
                union_id: "on_alice",
                name: "Alice Zhang",
                avatar: { avatar_72: "https://cdn.example/alice.png" },
                email: "must-not-leak@example.com",
                mobile: "+81000000000",
              },
              { union_id: "on_bob", name: "Bob" },
            ],
          },
        });
  if (options.persist) interceptor.persist();
}

describe("Lark organization member invitations (#358)", () => {
  it("publishes the moderator-only search and direct-invite contracts without any access token field", async () => {
    const response = await api("/openapi.json", "unused");
    expect(response.status).toBe(200);
    const document = (await response.json()) as { paths: Record<string, unknown> };
    expect(document.paths["/api/channels/{slug}/lark-directory"]).toBeDefined();
    expect(document.paths["/api/channels/{slug}/lark-organization"]).toBeDefined();
    expect(document.paths["/api/channels/{slug}/lark-members"]).toBeDefined();
    expect(document.paths["/api/channels/{slug}/lark-members/{userId}"]).toBeDefined();
    expect(JSON.stringify({
      search: document.paths["/api/channels/{slug}/lark-directory"],
      organization: document.paths["/api/channels/{slug}/lark-organization"],
      invite: document.paths["/api/channels/{slug}/lark-members"],
    })).not.toMatch(/access.?token/i);
  });

  it("lets a moderator browse child departments and direct members", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/departments/0/children?department_id_type=open_department_id&fetch_child=false&page_size=50",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: {
          has_more: false,
          items: [{ open_department_id: "od_app", parent_department_id: "0", name: "APP-Dev" }],
        },
      });
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/users/find_by_department?user_id_type=union_id&department_id_type=open_department_id&department_id=0&page_size=50",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: { has_more: false, items: [{ union_id: "on_evan", name: "陈文捷" }] },
      });

    const prepare = vi.spyOn(env.DB, "prepare");
    const response = await api(`/api/channels/${slug}/lark-organization?department_id=0&limit=50`, owner.token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      departments: [{ id: "od_app", name: "APP-Dev", parent_id: "0" }],
      users: [{ id: "on_evan", name: "陈文捷", avatar_url: null, already_member: false }],
      next_department_cursor: null,
      next_user_cursor: null,
      department_names_available: true,
    });
    const queries = prepare.mock.calls.map(([query]) => query.replace(/\s+/g, " ").trim());
    expect(queries).toContainEqual(expect.stringMatching(/account_profiles .*provider_user_id IN \(\?\)/));
    expect(queries).toContainEqual(expect.stringMatching(/channel_members .*account IN \(\?\)/));
    expect(queries).not.toContain("SELECT account, provider_user_id FROM account_profiles WHERE provider = ? AND tenant_key = ?");
    expect(queries).not.toContain("SELECT account FROM channel_members WHERE channel_slug = ?");
  });

  it("falls back to the visible employee directory while department names await approval", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/departments/0/children?department_id_type=open_department_id&fetch_child=false&page_size=50",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: { has_more: false, items: [{ open_department_id: "od_app" }] },
      });
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/scopes?user_id_type=union_id&department_id_type=open_department_id&page_size=100",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: { has_more: false, department_ids: ["od_app"], user_ids: [] },
      });
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/users/find_by_department?user_id_type=union_id&department_id_type=open_department_id&department_id=od_app&page_size=50",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: { has_more: false, items: [{ union_id: "on_evan", name: "陈文捷" }] },
      });

    const response = await api(`/api/channels/${slug}/lark-organization?department_id=0&limit=50`, owner.token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      departments: [],
      users: [{ id: "on_evan", name: "陈文捷", avatar_url: null, already_member: false }],
      next_department_cursor: null,
      next_user_cursor: null,
      department_names_available: false,
    });
  });

  it("reports missing department-name field permission without pretending the organization is empty", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/departments/0/children?department_id_type=open_department_id&fetch_child=false&page_size=50",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: { has_more: false, items: [{ open_department_id: "od_app" }] },
      });

    const response = await api(`/api/channels/${slug}/lark-organization?department_id=0&limit=50&users=0`, owner.token);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "lark_department_permission_required" },
    });
  });

  it("rejects flat organization pagination when users are disabled", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);

    const response = await api(
      `/api/channels/${slug}/lark-organization?department_id=0&limit=50&departments=0&users=0&flat=1`,
      owner.token,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
  });

  it("preserves department users across flat pages after direct users consume part of a page", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/scopes?user_id_type=union_id&department_id_type=open_department_id&page_size=100",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: { has_more: false, department_ids: ["od_app"], user_ids: ["on_direct"] },
      });
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/contact/v3/users/on_direct?user_id_type=union_id", method: "GET" })
      .reply(200, { code: 0, data: { user: { union_id: "on_direct", name: "Direct User" } } });
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/users/find_by_department?user_id_type=union_id&department_id_type=open_department_id&department_id=od_app&page_size=1",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: { has_more: true, page_token: "department-next", items: [{ union_id: "on_first", name: "First" }] },
      });
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/users/find_by_department?user_id_type=union_id&department_id_type=open_department_id&department_id=od_app&page_size=2&page_token=department-next",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: { has_more: false, items: [{ union_id: "on_second", name: "Second" }] },
      });

    const first = await api(
      `/api/channels/${slug}/lark-organization?department_id=0&limit=2&departments=0&flat=1`,
      owner.token,
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { users: Array<{ id: string }>; next_user_cursor: string };
    expect(firstBody.users.map((user) => user.id)).toEqual(["on_direct", "on_first"]);
    expect(firstBody.next_user_cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const second = await api(
      `/api/channels/${slug}/lark-organization?department_id=0&limit=2&departments=0&flat=1&user_cursor=${encodeURIComponent(firstBody.next_user_cursor)}`,
      owner.token,
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as { users: Array<{ id: string }> }).users.map((user) => user.id)).toEqual(["on_second"]);
  });

  it("matches English names and email aliases without returning them", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/users/find_by_department?user_id_type=union_id&department_id_type=open_department_id&department_id=0&page_size=20",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: {
          has_more: false,
          items: [{ union_id: "on_evan", name: "陈文捷", en_name: "Evan", email: "evan@example.com" }],
        },
      });
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/departments/0/children?department_id_type=open_department_id&fetch_child=true&page_size=4",
        method: "GET",
      })
      .reply(200, { code: 0, data: { has_more: false, items: [] } });

    const response = await api(`/api/channels/${slug}/lark-directory?q=evan&limit=20`, owner.token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      users: [{ id: "on_evan", name: "陈文捷", avatar_url: null, already_member: false }],
      next_cursor: null,
    });
    expect(JSON.stringify(body)).not.toContain("evan@example.com");
  });

  it("lets a Lark human moderator search a same-tenant directory page without leaking tokens or sensitive fields", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    mockDirectoryPage();

    const response = await api(`/api/channels/${slug}/lark-directory?q=alice&limit=20`, owner.token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      users: [{ id: "on_alice", name: "Alice Zhang", avatar_url: "https://cdn.example/alice.png", already_member: false }],
      next_cursor: expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    });
    expect(String(body.next_cursor)).not.toContain("next-page");
    expect(JSON.stringify(body)).not.toMatch(/tenant-secret-token|must-not-leak|81000000000|access.?token/i);
  });

  it("skips empty directory pages until it finds a match and keeps a query-bound signed cursor (#520)", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/users/find_by_department?user_id_type=union_id&department_id_type=open_department_id&department_id=0&page_size=20",
        method: "GET",
      })
      .reply(200, { code: 0, data: { has_more: false, items: [{ union_id: "on_owner", name: "Owner" }] } });
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/departments/0/children?department_id_type=open_department_id&fetch_child=true&page_size=4",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: {
          has_more: false,
          items: [{ open_department_id: "od-engineering" }, { open_department_id: "od-sales" }],
        },
      });
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/users/find_by_department?user_id_type=union_id&department_id_type=open_department_id&department_id=od-engineering&page_size=20",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: {
          has_more: false,
          items: [{ union_id: "on_alice", name: "Alice Zhang", avatar: { avatar_72: "https://cdn.example/alice.png" } }],
        },
      });

    const first = await api(`/api/channels/${slug}/lark-directory?q=alice&limit=20`, owner.token);
    expect(first.status).toBe(200);
    const firstPage = (await first.json()) as { users: unknown[]; next_cursor: string };
    expect(firstPage.users).toEqual([
      { id: "on_alice", name: "Alice Zhang", avatar_url: "https://cdn.example/alice.png", already_member: false },
    ]);
    expect(firstPage.next_cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const signatureIndex = firstPage.next_cursor.indexOf(".") + 1;
    const tampered = `${firstPage.next_cursor.slice(0, signatureIndex)}${
      firstPage.next_cursor[signatureIndex] === "A" ? "B" : "A"
    }${firstPage.next_cursor.slice(signatureIndex + 1)}`;
    const rejected = await api(
      `/api/channels/${slug}/lark-directory?q=alice&limit=20&cursor=${encodeURIComponent(tampered)}`,
      owner.token,
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: "bad_request" } });

    const rebound = await api(
      `/api/channels/${slug}/lark-directory?q=bob&limit=20&cursor=${encodeURIComponent(firstPage.next_cursor)}`,
      owner.token,
    );
    expect(rebound.status).toBe(400);
    expect(await rebound.json()).toMatchObject({ error: { code: "bad_request" } });

    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/users/find_by_department?user_id_type=union_id&department_id_type=open_department_id&department_id=od-sales&page_size=20",
        method: "GET",
      })
      .reply(200, { code: 0, data: { has_more: false, items: [{ union_id: "on_bob", name: "Bob" }] } });
    const second = await api(
      `/api/channels/${slug}/lark-directory?q=alice&limit=20&cursor=${encodeURIComponent(firstPage.next_cursor)}`,
      owner.token,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ users: [], next_cursor: null });
  });

  it("matches an existing member whose profile still stores an open_id", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    const legacyAccount = `lark-main:${uniq("legacy_alice")}`;
    const unionId = uniq("on_alice");
    const openId = uniq("ou_alice");
    const userId = uniq("alice_user");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO account_profiles (
         account, handle, display_name, provider, provider_user_id, tenant_key, created_at, updated_at
       ) VALUES (?, ?, 'Alice', 'lark-main', ?, 'tenant-test', ?, ?)`,
    ).bind(legacyAccount, uniq("alice"), openId, now, now).run();
    await env.DB.prepare(
      "INSERT INTO channel_members (channel_slug, account, added_by, added_at) VALUES (?, ?, ?, ?)",
    ).bind(slug, legacyAccount, owner.account, now).run();
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/users/find_by_department?user_id_type=union_id&department_id_type=open_department_id&department_id=0&page_size=20",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: {
          has_more: true,
          page_token: "next-page",
          items: [{ union_id: unionId, open_id: openId, user_id: userId, name: "Alice" }],
        },
      });

    const response = await api(`/api/channels/${slug}/lark-directory?q=alice&limit=20`, owner.token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { users: unknown[]; next_cursor: string };
    expect(body).toMatchObject({
      users: [{ id: unionId, name: "Alice", already_member: true }],
    });
    expect(decodeDirectoryCursor(body.next_cursor)).toMatchObject({ d: "0", u: "next-page" });
  });

  it("maps missing v3 department visibility to the stable contact-permission error", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/users/find_by_department?user_id_type=union_id&department_id_type=open_department_id&department_id=0&page_size=20",
        method: "GET",
      })
      .reply(200, { code: 0, data: { has_more: false, items: [] } });
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/departments/0/children?department_id_type=open_department_id&fetch_child=true&page_size=4",
        method: "GET",
      })
      .reply(403, { code: 40014, msg: "no parent dept authority" });

    const response = await api(`/api/channels/${slug}/lark-directory?q=alice&limit=20`, owner.token);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "lark_contact_permission_required" } });
  });

  it("falls back to the app contact scope when root department access is not all-staff", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/users/find_by_department?user_id_type=union_id&department_id_type=open_department_id&department_id=0&page_size=1",
        method: "GET",
      })
      .reply(403, { code: 40014, msg: "no all-staff authority" });
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/scopes?user_id_type=union_id&department_id_type=open_department_id&page_size=100",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: {
          has_more: false,
          department_ids: ["od-engineering"],
          user_ids: ["on_owner", "on_alice"],
        },
      });
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/contact/v3/users/on_owner?user_id_type=union_id", method: "GET" })
      .reply(200, {
        code: 0,
        data: { user: { union_id: "on_owner", name: "Owner" } },
      });
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/contact/v3/users/on_alice?user_id_type=union_id", method: "GET" })
      .reply(200, {
        code: 0,
        data: { user: { union_id: "on_alice", name: "Alice Zhang", avatar: { avatar_72: "https://cdn.example/alice.png" } } },
      });
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/users/find_by_department?user_id_type=union_id&department_id_type=open_department_id&department_id=od-engineering&page_size=1",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: {
          has_more: true,
          page_token: "dept-next",
          items: [
            { union_id: "on_alice", name: "Alice Zhang" },
            { union_id: "on_alicia", name: "Alicia Team" },
          ],
        },
      });
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/users/find_by_department?user_id_type=union_id&department_id_type=open_department_id&department_id=od-engineering&page_size=1&page_token=dept-next",
        method: "GET",
      })
      .reply(200, {
        code: 0,
        data: {
          has_more: false,
          items: [{ union_id: "on_alina", name: "Alina Team" }],
        },
      });

    const response = await api(`/api/channels/${slug}/lark-directory?q=ali&limit=1`, owner.token);
    expect(response.status).toBe(200);
    const first = (await response.json()) as { users: unknown[]; next_cursor: string };
    expect(first).toEqual({
      users: [{ id: "on_alice", name: "Alice Zhang", avatar_url: "https://cdn.example/alice.png", already_member: false }],
      next_cursor: expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    });

    const secondResponse = await api(
      `/api/channels/${slug}/lark-directory?q=ali&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
      owner.token,
    );
    expect(secondResponse.status).toBe(200);
    const second = (await secondResponse.json()) as { users: unknown[]; next_cursor: string };
    expect(second).toEqual({
      users: [{ id: "on_alicia", name: "Alicia Team", avatar_url: null, already_member: false }],
      next_cursor: expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    });

    const thirdResponse = await api(
      `/api/channels/${slug}/lark-directory?q=ali&limit=1&cursor=${encodeURIComponent(second.next_cursor)}`,
      owner.token,
    );
    expect(thirdResponse.status).toBe(200);
    expect(await thirdResponse.json()).toEqual({
      users: [{ id: "on_alina", name: "Alina Team", avatar_url: null, already_member: false }],
      next_cursor: null,
    });
  });

  it("directly adds the selected same-tenant Lark user idempotently and records management audit", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/contact/v3/users/on_alice?user_id_type=union_id", method: "GET" })
      .reply(200, {
        code: 0,
        data: { user: { union_id: "on_alice", name: "Alice Zhang", avatar: { avatar_72: "https://cdn.example/alice.png" } } },
      })
      .times(2);
    let sentMessage: Record<string, unknown> | null = null;
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/im/v1/messages?receive_id_type=union_id", method: "POST" })
      .reply(200, (options) => {
        sentMessage = JSON.parse(String(options.body)) as Record<string, unknown>;
        return { code: 0, data: { message_id: "om_invite" } };
      });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const invited = await api(`/api/channels/${slug}/lark-members`, owner.token, {
        method: "POST",
        body: JSON.stringify({ user_id: "on_alice" }),
      });
      expect(invited.status).toBe(attempt === 0 ? 201 : 200);
      expect(await invited.json()).toMatchObject({
        name: "Alice Zhang",
        already_member: attempt === 1,
        notification_status: attempt === 0 ? "sent" : "skipped_already_member",
      });
    }

    expect(sentMessage).toMatchObject({ receive_id: "on_alice", msg_type: "interactive" });
    const inviteCard = JSON.parse(String((sentMessage as unknown as Record<string, unknown>).content)) as Record<string, unknown>;
    expect(JSON.stringify(inviteCard)).toContain(`#${slug}`);
    expect(JSON.stringify(inviteCard)).toContain(`/c/${slug}`);

    const members = await env.DB.prepare(
      "SELECT account, added_by FROM channel_members WHERE channel_slug = ? AND account = ?",
    ).bind(slug, "lark-main:on_alice").all<{ account: string; added_by: string }>();
    expect(members.results).toEqual([{ account: "lark-main:on_alice", added_by: owner.account }]);

    const audit = await api(`/api/channels/${slug}/management-audit?limit=100`, owner.token);
    const entries = ((await audit.json()) as { audit: Array<{ action: string; resource: string }> }).audit;
    expect(entries.filter((entry) => entry.action === "channel.member.add" && entry.resource === `channel/${slug}/members/lark-main:on_alice`)).toHaveLength(1);
  });

  it("keeps the member addition when the Lark bot notification fails", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/contact/v3/users/on_bob?user_id_type=union_id", method: "GET" })
      .reply(200, { code: 0, data: { user: { union_id: "on_bob", name: "Bob" } } });
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/im/v1/messages?receive_id_type=union_id", method: "POST" })
      .reply(200, { code: 999, msg: "permission denied" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await api(`/api/channels/${slug}/lark-members`, owner.token, {
      method: "POST",
      body: JSON.stringify({ user_id: "on_bob" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ already_member: false, notification_status: "failed" });
    expect(await env.DB.prepare(
      "SELECT account FROM channel_members WHERE channel_slug = ? AND account = ?",
    ).bind(slug, "lark-main:on_bob").first()).not.toBeNull();
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it("removes a Lark member, revokes all channel-scoped agents, and blocks global agents from the channel", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    const account = "lark-main:on_remove";
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO account_profiles (
         account, handle, display_name, provider, provider_user_id, tenant_key, created_at, updated_at
       ) VALUES (?, ?, 'Remove Me', 'lark-main', 'on_remove', 'tenant-test', ?, ?)`,
    ).bind(account, uniq("remove_me"), now, now).run();
    await env.DB.prepare(
      "INSERT INTO channel_members (channel_slug, account, added_by, added_at) VALUES (?, ?, ?, ?)",
    ).bind(slug, account, owner.account, now).run();
    const scoped = await seedToken("agent", uniq("scoped_remove"), { owner: account, channelScope: slug });
    const global = await seedToken("agent", uniq("global_remove"), { owner: account });
    const other = await seedToken("agent", uniq("other_remove"), { owner: account, channelScope: uniq("other") });

    const response = await api(`/api/channels/${slug}/lark-members/on_remove`, owner.token, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ memberRemoved: true, revokedAgents: 1 });
    expect(await env.DB.prepare(
      "SELECT account FROM channel_members WHERE channel_slug = ? AND account = ?",
    ).bind(slug, account).first()).toBeNull();
    const tokens = await env.DB.prepare(
      "SELECT name, revoked_at FROM tokens WHERE name IN (?, ?, ?) ORDER BY name",
    ).bind(scoped.name, global.name, other.name).all<{ name: string; revoked_at: number | null }>();
    expect(tokens.results.find((token) => token.name === scoped.name)?.revoked_at).not.toBeNull();
    expect(tokens.results.find((token) => token.name === global.name)?.revoked_at).toBeNull();
    expect(tokens.results.find((token) => token.name === other.name)?.revoked_at).toBeNull();
    expect(await env.DB.prepare(
      "SELECT account FROM channel_account_bans WHERE channel_slug = ? AND account = ?",
    ).bind(slug, account).first()).toEqual({ account });
    expect((await api(`/api/channels/${slug}/messages`, global.token)).status).toBe(403);
    expect((await api(`/api/channels/${slug}/messages`, scoped.token)).status).toBe(401);

    await env.DB.prepare("UPDATE channels SET visibility = 'public' WHERE slug = ?").bind(slug).run();
    expect((await api(`/api/channels/${slug}/messages`, global.token)).status).toBe(403);

    expect((await api(`/api/channels/${slug}/members/${encodeURIComponent(account)}`, owner.token, { method: "PUT" })).status).toBe(200);
    expect(await env.DB.prepare(
      "SELECT account FROM channel_account_bans WHERE channel_slug = ? AND account = ?",
    ).bind(slug, account).first()).toBeNull();
    expect((await api(`/api/channels/${slug}/messages`, global.token)).status).toBe(200);
  });

  it("reuses an open_id profile during a union_id invite and migrates it to the stable id", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    const legacyAccount = `lark-main:${uniq("legacy_alice")}`;
    const unionId = uniq("on_alice");
    const openId = uniq("ou_alice");
    const userId = uniq("alice_user");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO account_profiles (
         account, handle, display_name, provider, provider_user_id, tenant_key, created_at, updated_at
       ) VALUES (?, ?, 'Alice', 'lark-main', ?, 'tenant-test', ?, ?)`,
    ).bind(legacyAccount, uniq("alice"), openId, now, now).run();
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: `/open-apis/contact/v3/users/${unionId}?user_id_type=union_id`, method: "GET" })
      .reply(200, {
        code: 0,
        data: { user: { union_id: unionId, open_id: openId, user_id: userId, name: "Alice" } },
      });

    const response = await api(`/api/channels/${slug}/lark-members`, owner.token, {
      method: "POST",
      body: JSON.stringify({ user_id: unionId }),
    });
    expect(response.status).toBe(201);
    expect(await env.DB.prepare(
      "SELECT account FROM channel_members WHERE channel_slug = ? AND account = ?",
    ).bind(slug, legacyAccount).first()).not.toBeNull();
    expect(await env.DB.prepare(
      "SELECT provider_user_id FROM account_profiles WHERE account = ?",
    ).bind(legacyAccount).first<{ provider_user_id: string }>()).toEqual({ provider_user_id: unionId });
  });

  it("prefers the stable union_id account when multiple historical identifiers already exist", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    const unionAccount = `lark-main:${uniq("union_alice")}`;
    const openAccount = `lark-main:${uniq("open_alice")}`;
    const unionId = uniq("on_alice");
    const openId = uniq("ou_alice");
    const userId = uniq("alice_user");
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO account_profiles (
           account, handle, display_name, provider, provider_user_id, tenant_key, created_at, updated_at
         ) VALUES (?, ?, 'Union Alice', 'lark-main', ?, 'tenant-test', ?, ?)`,
      ).bind(unionAccount, uniq("union_alice"), unionId, now, now),
      env.DB.prepare(
        `INSERT INTO account_profiles (
           account, handle, display_name, provider, provider_user_id, tenant_key, created_at, updated_at
         ) VALUES (?, ?, 'Open Alice', 'lark-main', ?, 'tenant-test', ?, ?)`,
      ).bind(openAccount, uniq("open_alice"), openId, now, now),
    ]);
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: `/open-apis/contact/v3/users/${unionId}?user_id_type=union_id`, method: "GET" })
      .reply(200, {
        code: 0,
        data: { user: { union_id: unionId, open_id: openId, user_id: userId, name: "Alice" } },
      });

    const response = await api(`/api/channels/${slug}/lark-members`, owner.token, {
      method: "POST",
      body: JSON.stringify({ user_id: unionId }),
    });
    expect(response.status).toBe(201);
    expect((await env.DB.prepare(
      "SELECT account FROM channel_members WHERE channel_slug = ? AND account IN (?, ?) ORDER BY account",
    ).bind(slug, unionAccount, openAccount).all<{ account: string }>()).results).toEqual([{ account: unionAccount }]);
  });

  it("uses the stable contact-permission code for direct invite failures", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/contact/v3/users/on_alice?user_id_type=union_id", method: "GET" })
      .reply(200, { code: 41050, msg: "no user authority" });

    const response = await api(`/api/channels/${slug}/lark-members`, owner.token, {
      method: "POST",
      body: JSON.stringify({ user_id: "on_alice" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "lark_contact_permission_required" },
    });
  });

  it("rejects non-moderators, agent moderators, and cross-tenant profiles before any directory request", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    const outsider = await larkHuman();
    const agent = await seedToken("agent", uniq("agent"), { owner: owner.account });
    const wrongTenant = await larkHuman("tenant-other");
    const wrongTenantSlug = await createChannel(wrongTenant.token);

    expect((await api(`/api/channels/${slug}/lark-directory?q=alice`, outsider.token)).status).toBe(403);
    expect((await api(`/api/channels/${slug}/lark-directory?q=alice`, agent.token)).status).toBe(403);
    const mismatch = await api(`/api/channels/${wrongTenantSlug}/lark-directory?q=alice`, wrongTenant.token);
    expect(mismatch.status).toBe(403);
    expect((await mismatch.json()) as object).toMatchObject({ error: { code: "forbidden" } });
  });

  it("surfaces missing Lark contact permission and applies a per-account search limit", async () => {
    const deniedOwner = await larkHuman();
    const deniedSlug = await createChannel(deniedOwner.token);
    mockTenantToken();
    mockDirectoryPage({ permissionDenied: true });
    fetchMock.get(LARK_ORIGIN)
      .intercept({
        path: "/open-apis/contact/v3/scopes?user_id_type=union_id&department_id_type=open_department_id&page_size=100",
        method: "GET",
      })
      .reply(403, { code: 40014, msg: "no contact scope authority" });
    const denied = await api(`/api/channels/${deniedSlug}/lark-directory?q=alice`, deniedOwner.token);
    expect(denied.status).toBe(503);
    expect(await denied.json()).toMatchObject({
      error: {
        code: "lark_contact_permission_required",
        message: expect.stringContaining("contact permission"),
      },
    });

    clearLarkTokenCache();
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    mockDirectoryPage({ persist: true });
    for (let request = 1; request <= 11; request += 1) {
      const response = await api(`/api/channels/${slug}/lark-directory?q=alice`, owner.token);
      expect(response.status).toBe(request <= 10 ? 200 : 429);
      if (request === 11) expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    }
  });
});
