// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
// Run before component suites because Bun's process-global module mocks replace lib/api later.
import { browseLarkOrganization, inviteLarkMember, searchLarkDirectory } from "./lib/api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Lark directory API", () => {
  test("encodes search pagination and returns only the public directory summary", async () => {
    let request: Request | null = null;
    globalThis.fetch = (async (input, init) => {
      request = new Request(new URL(String(input), "https://web.test"), init);
      return new Response(JSON.stringify({
        users: [{ id: "on_alice", name: "Alice", avatar_url: null, already_member: false }],
        next_cursor: "next/page",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const page = await searchLarkDirectory("session-token", "private room", "Alice Zhang", 12, "cursor/value");
    expect(request!.url).toContain("/api/channels/private%20room/lark-directory?");
    expect(request!.url).toContain("q=Alice+Zhang");
    expect(request!.url).toContain("limit=12");
    expect(request!.url).toContain("cursor=cursor%2Fvalue");
    expect(request!.headers.get("authorization")).toBe("Bearer session-token");
    expect(page.users[0]).toEqual({ id: "on_alice", name: "Alice", avatar_url: null, already_member: false });
  });

  test("posts only the selected provider user id", async () => {
    let request: Request | null = null;
    globalThis.fetch = (async (input, init) => {
      request = new Request(new URL(String(input), "https://web.test"), init);
      return new Response(JSON.stringify({ id: "on_alice", name: "Alice", already_member: false }), { status: 201 });
    }) as typeof fetch;
    await inviteLarkMember("session-token", "private room", "on_alice");
    expect(request!.method).toBe("POST");
    const rawBody = await request!.clone().text();
    expect(await request!.json()).toEqual({ user_id: "on_alice" });
    expect(rawBody).not.toMatch(/access.?token|tenant/i);
  });

  test("encodes organization browsing and independent pagination", async () => {
    let request: Request | null = null;
    globalThis.fetch = (async (input, init) => {
      request = new Request(new URL(String(input), "https://web.test"), init);
      return new Response(JSON.stringify({
        departments: [{ id: "od_app", name: "APP-Dev", parent_id: "0" }],
        users: [],
        next_department_cursor: null,
        next_user_cursor: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await browseLarkOrganization("session-token", "private room", "od_app", 50, null, "users/next", false, true);
    expect(request!.url).toContain("/api/channels/private%20room/lark-organization?");
    expect(request!.url).toContain("department_id=od_app");
    expect(request!.url).toContain("user_cursor=users%2Fnext");
    expect(request!.url).toContain("departments=0");
    expect(request!.headers.get("authorization")).toBe("Bearer session-token");
  });
});
