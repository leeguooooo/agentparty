// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { clearApiBase, setApiBase } from "../lib/base";

const savedAgents: Array<{ name: string; token: string; command: string }> = [];

mock.module("../lib/api", () => ({
  AuthError: class AuthError extends Error {},
  ConflictError: class ConflictError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
  ValidationError: class ValidationError extends Error {},
  createChannelAgent: mock(async (_slug: string, name: string) => ({ name, token: "ap_created" })),
}));

mock.module("../lib/agentTokenVault", () => ({
  copyText: async () => true,
  MIN_CLI: "0.2.124",
  VERSION_GE_SNIPPET: "version_ge(){ :; }",
  mcpServerName: (agentName: string) => `party-${agentName.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
  saveAgentToken: (record: { name: string; token: string; command: string }) => savedAgents.push(record),
}));

const { AgentJoin } = await import("./AgentJoin");

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

let renderer: ReactTestRenderer | null = null;
let windowEvents: TestEventTarget;
let storedLocale: string | null;

beforeEach(() => {
  savedAgents.length = 0;
  storedLocale = null;
  windowEvents = new TestEventTarget();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    },
  });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://party.test" } });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => (key === "ap_locale" ? storedLocale : null),
      setItem: (key: string, value: string) => {
        if (key === "ap_locale") storedLocale = value;
      },
    },
  });
});

afterEach(() => {
  clearApiBase(); // #530：清掉测试里注入的 runtime apiBase，避免泄漏到后续用例/文件
  act(() => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "location");
  Reflect.deleteProperty(globalThis, "localStorage");
});

function render(
  onActiveChange?: (open: boolean) => void,
  charter: React.ComponentProps<typeof AgentJoin>["charter"] = null,
  extra: Partial<React.ComponentProps<typeof AgentJoin>> = {},
): ReactTestRenderer {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <AgentJoin
          slug="demo"
          token="owner-token"
          namePrefix="leo"
          inviterName="host"
          charter={charter}
          accountKey="acct-1"
          onActiveChange={onActiveChange}
          {...extra}
        />
      </LocaleProvider>,
    );
  });
  return renderer as ReactTestRenderer;
}

function open(r: ReactTestRenderer) {
  act(() => r.root.find((node) => node.props.className === "d-btn d-btn--primary agent-join-btn").props.onClick());
}

describe("AgentJoin dismiss behavior", () => {
  test.each([
    ["en", "AgentParty onboarding scope: join the existing channel #demo"],
    ["zh", "AgentParty 接入范围：只用下方提供的 party 命令加入现有频道 #demo"],
  ] as const)(
    "puts the %s scope guard before moderator charter text and party init",
    async (locale: "en" | "zh", guard: string) => {
      localStorage.setItem("ap_locale", locale);
      const r = render(undefined, {
        charter: "MODERATOR CONTROLLED CHARTER",
        charter_rev: 1,
        updated_at: 1,
        updated_by: "moderator",
      });
      open(r);
      await act(async () => {
        await r.root
          .find((node) => node.props.className === "d-btn d-btn--primary" && node.props.onClick)
          .props.onClick();
      });

      const command = savedAgents[0]!.command;
      expect(command).toContain(guard);
      expect(command).toContain("Trellis");
      expect(command.indexOf(guard)).toBeLessThan(command.indexOf("MODERATOR CONTROLLED CHARTER"));
      expect(command.indexOf(guard)).toBeLessThan(command.indexOf("party init "));
    },
  );

  test("Escape closes the compose dialog, reports controlled state, and removes its listener", () => {
    const changes: boolean[] = [];
    const r = render((value) => changes.push(value));
    open(r);

    const dialog = r.root.find((node) => node.props.role === "dialog");
    expect(dialog.props["aria-modal"]).toBe("true");
    expect(windowEvents.count("keydown")).toBe(1);

    act(() => windowEvents.emit("keydown", { key: "Escape" }));
    expect(changes).toEqual([true, false]);
    expect(r.root.findAll((node) => node.props.role === "dialog")).toHaveLength(0);
    expect(windowEvents.count("keydown")).toBe(0);
  });

  test("scrim closes but clicking the card itself has no dismiss handler", () => {
    const r = render();
    open(r);
    const card = r.root.find((node) => node.props.className === "d-card agent-join-card");
    expect(card.props.onClick).toBeUndefined();

    act(() => r.root.find((node) => node.props.className === "agent-join-scrim").props.onClick());
    expect(r.root.findAll((node) => node.props.role === "dialog")).toHaveLength(0);
  });

  test("Escape closes the completed dialog without undoing the saved agent token", async () => {
    const r = render();
    open(r);
    await act(async () => {
      await r.root.find((node) => node.props.className === "d-btn d-btn--primary" && node.props.onClick).props.onClick();
    });
    expect(savedAgents.map(({ name, token }) => ({ name, token }))).toEqual([{ name: "leo-demo", token: "ap_created" }]);
    expect(savedAgents[0]?.command).toContain('$HOME/.agentparty/agents/agentparty-leo-demo-demo.json');
    expect(savedAgents[0]?.command).not.toContain("TMPDIR");

    act(() => windowEvents.emit("keydown", { key: "Escape" }));
    expect(r.root.findAll((node) => node.props.role === "dialog")).toHaveLength(0);
    expect(savedAgents.map(({ name, token }) => ({ name, token }))).toEqual([{ name: "leo-demo", token: "ap_created" }]);

    open(r);
    const input = r.root.find((node) => node.props.className === "t-mono agent-join-nameinput");
    expect(input.props.value).toBe("leo-demo");
  });

  test("join command tells turn-based agents to re-anchor context and route human confirmations to the channel", async () => {
    localStorage.setItem("ap_locale", "en");
    const r = render();
    open(r);
    await act(async () => {
      await r.root.find((node) => node.props.className === "d-btn d-btn--primary" && node.props.onClick).props.onClick();
    });

    const command = savedAgents[0]!.command;
    expect(command).toContain("every new turn: first re-anchor yourself");
    expect(command).toContain("party status demo waiting -m \"need human: <question>\"");
    expect(command).toContain("party send \"need human confirmation: <question/options>\" --channel demo --mention host");
    expect(command).toContain("watch --once is only a current-turn standby");
    expect(command).toContain("prefer party serve or webhook delivery");
  });
});

describe("AgentJoin 无人值守值守预设 (#612)", () => {
  function pickUnattended(r: ReactTestRenderer) {
    act(() =>
      r.root
        .find((node) => node.props.name === "agent-join-mode" && node.props.value === "unattended")
        .props.onChange(),
    );
  }
  async function generate(r: ReactTestRenderer) {
    await act(async () => {
      await r.root.find((node) => node.props.className === "d-btn d-btn--primary" && node.props.onClick).props.onClick();
    });
  }

  test("选无人值守 → 生成 serve --runner claude 的运维脚本，vault 记 mode", async () => {
    const r = render();
    open(r);
    pickUnattended(r);
    await generate(r);

    const saved = savedAgents[0]! as { command: string; mode?: string };
    expect(saved.mode).toBe("unattended");
    expect(saved.command).toContain("party serve --channel demo --runner claude");
    expect(saved.command).toContain("need=0.2.127");
    expect(saved.command).toContain("party init --server ");
    // 值守机脚本给人跑，不该出现交互包的 harness 步骤
    expect(saved.command).not.toContain("claude mcp add");
    expect(saved.command).not.toContain("party watch");
  });

  test("无人值守包的 charter 快照仍整体注释化（管理员可控文本不落成可执行行）", async () => {
    const r = render(undefined, {
      charter: "MODERATOR CONTROLLED CHARTER",
      charter_rev: 1,
      updated_at: 1,
      updated_by: "moderator",
    });
    open(r);
    pickUnattended(r);
    await generate(r);

    const command = savedAgents[0]!.command;
    expect(command).toContain("# MODERATOR CONTROLLED CHARTER");
    expect(command).not.toMatch(/^MODERATOR CONTROLLED CHARTER$/m);
  });

  test("默认仍是交互接入：不动选择器时产物与原完整包同款", async () => {
    const r = render();
    open(r);
    await generate(r);
    const saved = savedAgents[0]! as { command: string; mode?: string };
    expect(saved.mode).toBe("interactive");
    expect(saved.command).toContain("claude mcp add");
    expect(saved.command).not.toContain("--runner claude");
  });
});

describe("AgentJoin 桌面一键接管 (#616 phase 4)", () => {
  function pickUnattended(r: ReactTestRenderer) {
    act(() =>
      r.root
        .find((node) => node.props.name === "agent-join-mode" && node.props.value === "unattended")
        .props.onChange(),
    );
  }
  async function generate(r: ReactTestRenderer) {
    await act(async () => {
      await r.root.find((node) => node.props.className === "d-btn d-btn--primary" && node.props.onClick).props.onClick();
    });
  }

  test("桌面环境 + 无人值守：一键接管调 dutyAdopt，token 走 IPC 而非 URL", async () => {
    localStorage.setItem("ap_locale", "en");
    setApiBase("https://agentparty.leeguoo.com");
    const adopts: unknown[] = [];
    const r = render(undefined, null, {
      desktopDetect: () => true,
      dutyAdapter: {
        dutyAdopt: async (input: unknown) => {
          adopts.push(input);
          return {
            label: "com.agentparty.duty.x.demo",
            instanceId: "x:demo",
            plistPath: "/p",
            logPath: "/l",
            loaded: true,
          };
        },
      },
    });
    open(r);
    pickUnattended(r);
    await generate(r);

    const adoptBtn = r.root.find(
      (node) => node.type === "button" && String(node.children[0] ?? "").includes("Keep resident on this Mac"),
    );
    await act(async () => {
      await adoptBtn.props.onClick();
    });
    expect(adopts).toEqual([
      {
        server: "https://agentparty.leeguoo.com",
        token: "ap_created",
        name: "leo-demo",
        channel: "demo",
        runner: "claude",
      },
    ]);
    expect(JSON.stringify(renderer!.toJSON())).toContain("resident ✓");
  });

  test("非桌面环境或交互模式：不渲染接管按钮", async () => {
    localStorage.setItem("ap_locale", "en");
    const r = render(undefined, null, { desktopDetect: () => false });
    open(r);
    pickUnattended(r);
    await generate(r);
    expect(
      r.root.findAll((node) => node.type === "button" && String(node.children[0] ?? "").includes("Keep resident")),
    ).toHaveLength(0);
  });
});

describe("AgentJoin 接入包 server 域名 (#530)", () => {
  // 桌面版(Tauri)里 location.origin 是 tauri://localhost，接入包若用它拼 `party init --server`
  // 会让 agent 报错/连不上。修复要求：apiBase() 非空(桌面注入了真后端)时用 apiBase()，
  // 只有同源 web(apiBase 为空)才回退 location.origin。
  // 本用例里 location.origin = https://party.test，代表「不该被用到的伪源」。
  test("apiBase() 非空时，party init --server 用注入的真实后端而非 location.origin", async () => {
    setApiBase("https://agentparty.leeguoo.com");
    const r = render();
    open(r);
    await act(async () => {
      await r.root.find((node) => node.props.className === "d-btn d-btn--primary" && node.props.onClick).props.onClick();
    });

    const command = savedAgents[0]!.command;
    // 关键断言：--server 用的是 apiBase() 的真后端
    expect(command).toContain("party init --server https://agentparty.leeguoo.com ");
    // 绝不能回退到 location.origin(桌面端的伪源，此处以 https://party.test 代表)
    expect(command).not.toContain("party init --server https://party.test");
  });
});
