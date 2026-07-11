// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";

// AgentTokens 只依赖 ../lib/api 的这几个运行时导出；类型导入会被擦除。
// 这里整体桩掉，让测试可以驱动 profile 规则的查看/编辑，而不真的打网络。
type ProfileFixture = {
  owner_account: string;
  handle: string;
  name: string;
  runner: string;
  repo_url: string | null;
  workdir: string | null;
  base_branch: string;
  worktree_strategy: string;
  rules: string | null;
  invitable_by: string;
  created_at: number;
  updated_at: number;
};

let profilesFixture: ProfileFixture[] = [];
const createCalls: Array<{ token: string; body: Record<string, unknown> }> = [];

mock.module("../lib/api", () => ({
  AuthError: class AuthError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
  ValidationError: class ValidationError extends Error {},
  createProjectAgentProfile: mock(async (token: string, body: Record<string, unknown>) => {
    createCalls.push({ token, body });
    // upsert：把新 rules 落回 fixture，模拟 worker 的 ON CONFLICT DO UPDATE
    const existing = profilesFixture.find((p) => p.handle === body.handle);
    if (existing) existing.rules = (body.rules as string | undefined) ?? null;
    return existing ?? profilesFixture[0];
  }),
  inviteProjectAgent: async () => {},
  listChannelAgents: async () => [],
  listProjectAgentProfiles: async () => profilesFixture,
  rotateChannelAgent: async () => ({}),
}));

const { AgentTokens } = await import("./AgentTokens");

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function profile(overrides: Partial<ProfileFixture> = {}): ProfileFixture {
  return {
    owner_account: "acct-1",
    handle: "builder",
    name: "builder",
    runner: "codex",
    repo_url: "https://github.com/x/y",
    workdir: "/w",
    base_branch: "main",
    worktree_strategy: "branch",
    rules: "always run the tests",
    invitable_by: "owner",
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  profilesFixture = [];
  createCalls.length = 0;
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage({ ap_locale: "en" }) });
  const windowEvents = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    },
  });
});

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "localStorage");
});

function baseProps() {
  return {
    slug: "demo",
    token: "tok-1",
    accountKey: "acct-1",
    inviterName: "host",
    onAuthFailed: () => {},
  };
}

async function renderOpen(): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(<LocaleProvider><AgentTokens {...baseProps()} /></LocaleProvider>);
  });
  renderer = r;
  // 打开面板 → 触发 refresh()，拉取 profiles
  await act(async () => {
    r.root.find((n) => n.props.className === "d-btn agenttokens-btn").props.onClick();
  });
  await act(async () => {}); // flush Promise.all
  return r;
}

function allText(r: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object" && "children" in (node as Record<string, unknown>)) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(r.toJSON());
  return out.join(" ");
}

function findClass(r: ReactTestRenderer, className: string) {
  return r.root.find((n) => n.props.className === className);
}

describe("AgentTokens project-agent rules view", () => {
  test("shows an existing profile's rules text", async () => {
    profilesFixture = [profile({ rules: "always run the tests" })];
    const r = await renderOpen();
    expect(allText(r)).toContain("always run the tests");
  });

  test("shows the empty-rules placeholder when a profile has no rules", async () => {
    profilesFixture = [profile({ rules: null })];
    const r = await renderOpen();
    expect(allText(r)).toContain("no rules set");
    expect(allText(r)).not.toContain("always run the tests");
  });
});

describe("AgentTokens project-agent rules edit", () => {
  test("editing rules re-posts the full profile (upsert) with the new rules, preserving other fields", async () => {
    profilesFixture = [profile({ rules: "old rules", repo_url: "https://github.com/x/y", base_branch: "dev" })];
    const r = await renderOpen();

    // 进入编辑
    await act(async () => {
      findClass(r, "d-btn agenttokens-edit-rules").props.onClick();
    });
    // textarea 预填旧值
    const textarea = r.root.find((n) => n.props["aria-label"] === "agent rules" && n.type === "textarea");
    expect(textarea.props.value).toBe("old rules");
    // 改写
    await act(async () => {
      textarea.props.onChange({ target: { value: "new rules text" } });
    });
    // 保存
    await act(async () => {
      findClass(r, "d-btn agenttokens-save-rules").props.onClick();
    });
    await act(async () => {});

    expect(createCalls).toHaveLength(1);
    const body = createCalls[0]!.body;
    expect(body.handle).toBe("builder");
    expect(body.rules).toBe("new rules text");
    // 关键：不能因为重新 POST 而丢掉其它字段（worker 缺字段会写成 null）
    expect(body.runner).toBe("codex");
    expect(body.repo_url).toBe("https://github.com/x/y");
    expect(body.base_branch).toBe("dev");
    expect(body.worktree_strategy).toBe("branch");
    expect(body.invitable_by).toBe("owner");
    // 保存成功后退出编辑态，展示新规则
    expect(allText(r)).toContain("new rules text");
  });

  test("cancel leaves the profile untouched and posts nothing", async () => {
    profilesFixture = [profile({ rules: "keep me" })];
    const r = await renderOpen();
    await act(async () => {
      findClass(r, "d-btn agenttokens-edit-rules").props.onClick();
    });
    await act(async () => {
      findClass(r, "d-btn agenttokens-cancel-rules").props.onClick();
    });
    expect(createCalls).toHaveLength(0);
    expect(allText(r)).toContain("keep me");
  });
});
