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
type AgentFixture = { name: string; owner: string; channel_scope: string; created_at: number; nickname?: string | null };

let profilesFixture: ProfileFixture[] = [];
let agentsFixture: AgentFixture[] = [];
const createCalls: Array<{ token: string; body: Record<string, unknown> }> = [];
const nicknameCalls: Array<{ token: string; slug: string; name: string; nickname: string }> = [];

mock.module("../lib/api", () => ({
  AuthError: class AuthError extends Error {},
  ConflictError: class ConflictError extends Error {},
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
  listChannelAgents: async () => agentsFixture,
  listProjectAgentProfiles: async () => profilesFixture,
  rotateChannelAgent: async () => ({}),
  setChannelAgentNickname: mock(async (token: string, slug: string, name: string, nickname: string) => {
    nicknameCalls.push({ token, slug, name, nickname });
    const agent = agentsFixture.find((entry) => entry.name === name);
    if (agent) agent.nickname = nickname;
    return { name, nickname };
  }),
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
let windowEvents: TestEventTarget;
let documentEvents: TestEventTarget;
const insideTarget = {};

class TestEventTarget {
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

beforeEach(() => {
  profilesFixture = [];
  agentsFixture = [];
  createCalls.length = 0;
  nicknameCalls.length = 0;
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage({ ap_locale: "en" }) });
  windowEvents = new TestEventTarget();
  documentEvents = new TestEventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    },
  });
});

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
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
    r = create(<LocaleProvider><AgentTokens {...baseProps()} /></LocaleProvider>, {
      createNodeMock(element) {
        if ((element.props as { className?: string }).className === "agenttokens") {
          return {
            contains: (target: unknown) => target === insideTarget,
            getBoundingClientRect: () => ({ bottom: 40, right: 700 }),
          };
        }
        return {};
      },
    });
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

describe("AgentTokens agent nickname management (#165)", () => {
  test("owner can set a Chinese nickname from the agent management panel", async () => {
    agentsFixture = [{ name: "build-bot", owner: "acct-1", channel_scope: "demo", created_at: 1, nickname: null }];
    const r = await renderOpen();

    await act(async () => findClass(r, "d-btn agenttokens-edit-nickname").props.onClick());
    const input = findClass(r, "agenttokens-input agenttokens-nickname-input");
    await act(async () => input.props.onChange({ target: { value: "  构建小助手  " } }));
    await act(async () => findClass(r, "d-btn d-btn--primary agenttokens-save-nickname").props.onClick());

    expect(nicknameCalls).toEqual([{ token: "tok-1", slug: "demo", name: "build-bot", nickname: "构建小助手" }]);
    expect(findClass(r, "agenttokens-nickname").children.join("")).toBe("@构建小助手");
  });

  test("editing an existing nickname starts with the current value", async () => {
    agentsFixture = [{ name: "build-bot", owner: "acct-1", channel_scope: "demo", created_at: 1, nickname: "旧昵称" }];
    const r = await renderOpen();
    await act(async () => findClass(r, "d-btn agenttokens-edit-nickname").props.onClick());
    expect(findClass(r, "agenttokens-input agenttokens-nickname-input").props.value).toBe("旧昵称");
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

describe("AgentTokens dismiss behavior", () => {
  test("exposes the panel as a modal dialog and ignores pointer presses inside the component", async () => {
    const r = await renderOpen();
    const panel = findClass(r, "agenttokens-panel");
    expect(panel.props.role).toBe("dialog");
    expect(panel.props["aria-modal"]).toBe("true");

    act(() => documentEvents.emit("pointerdown", { target: insideTarget }));
    expect(r.root.findAll((node) => node.props.className === "agenttokens-panel")).toHaveLength(1);
  });

  test("Escape and outside pointer presses close, clear drafts, and clean up listeners", async () => {
    profilesFixture = [profile()];
    const r = await renderOpen();
    const handleInput = r.root.findAll((node) => node.props.className === "agenttokens-input t-mono")[0]!;
    act(() => handleInput.props.onChange({ target: { value: "temporary" } }));
    act(() => findClass(r, "d-btn agenttokens-edit-rules").props.onClick());

    expect(windowEvents.count("keydown")).toBe(1);
    expect(documentEvents.count("pointerdown")).toBe(1);
    act(() => windowEvents.emit("keydown", { key: "Escape" }));
    expect(r.root.findAll((node) => node.props.className === "agenttokens-panel")).toHaveLength(0);
    expect(windowEvents.count("keydown")).toBe(0);
    expect(documentEvents.count("pointerdown")).toBe(0);

    act(() => r.root.find((node) => node.props.className === "d-btn agenttokens-btn").props.onClick());
    expect(r.root.findAll((node) => node.props.className === "agenttokens-input t-mono")[0]!.props.value).toBe("");
    expect(r.root.findAll((node) => node.type === "textarea")).toHaveLength(0);
    expect(allText(r)).toContain("always run the tests");

    act(() => documentEvents.emit("pointerdown", { target: {} }));
    expect(r.root.findAll((node) => node.props.className === "agenttokens-panel")).toHaveLength(0);
  });

  test("controlled dismiss requests onActiveChange without mutating the active prop", async () => {
    const changes: boolean[] = [];
    await act(async () => {
      renderer = create(
        <LocaleProvider>
          <AgentTokens {...baseProps()} active={true} onActiveChange={(open) => changes.push(open)} />
        </LocaleProvider>,
        {
          createNodeMock(element) {
            if ((element.props as { className?: string }).className === "agenttokens") {
              return {
                contains: (target: unknown) => target === insideTarget,
                getBoundingClientRect: () => ({ bottom: 40, right: 700 }),
              };
            }
            return {};
          },
        },
      );
    });
    act(() => documentEvents.emit("pointerdown", { target: {} }));
    expect(changes).toEqual([false]);
    expect(renderer!.root.findAll((node) => node.props.className === "agenttokens-panel")).toHaveLength(1);
  });
});
