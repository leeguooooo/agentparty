// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import type { DesktopDutyEntry } from "../lib/desktopAgent";

const { ResidentDutyLogs } = await import("./ResidentDutyLogs");

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
}

function entry(over: Partial<DesktopDutyEntry> = {}): DesktopDutyEntry {
  return {
    label: "com.agentparty.duty.abc123.kyc",
    instanceId: "abc123:kyc",
    plistPath: "/p.plist",
    logPath: "/l.log",
    loaded: true,
    ...over,
  };
}

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  localStorage.setItem("ap_locale", "en");
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

async function renderPanel(adapter: { dutyList: () => Promise<DesktopDutyEntry[]>; dutyLogRead: (label: string) => Promise<string> }): Promise<ReactTestRenderer> {
  await act(async () => {
    renderer = create(
      <LocaleProvider>
        <ResidentDutyLogs t={((k: string) => k) as never} adapter={adapter} />
      </LocaleProvider>,
    );
  });
  return renderer!;
}

function buttons(r: ReactTestRenderer): ReactTestInstance[] {
  return r.root.findAll((n) => n.type === "button");
}

describe("ResidentDutyLogs (#725)", () => {
  test("列出常驻实例并显示频道名", async () => {
    const r = await renderPanel({
      dutyList: async () => [entry({ instanceId: "abc:kyc" }), entry({ label: "com.agentparty.duty.def.dev", instanceId: "def:dev", loaded: false })],
      dutyLogRead: async () => "",
    });
    const text = JSON.stringify(r.toJSON());
    // JSX 的 `#{channel}` 会被拆成 ["#","kyc"] 两个文本节点,断言频道名本身即可。
    expect(text).toContain('"kyc"');
    expect(text).toContain('"dev"');
  });

  test("点某个实例 → 读取并展示其日志尾部", async () => {
    const reads: string[] = [];
    const r = await renderPanel({
      dutyList: async () => [entry()],
      dutyLogRead: async (label) => { reads.push(label); return "▶ wake seq=42\nserve: online"; },
    });
    const item = buttons(r).find((b) => JSON.stringify(b.props.className).includes("resident-logs-item"))!;
    await act(async () => { await item.props.onClick(); });
    expect(reads).toEqual(["com.agentparty.duty.abc123.kyc"]);
    expect(JSON.stringify(r.toJSON())).toContain("serve: online");
  });

  test("快速切换条目:慢请求不覆盖后点击的日志(#734 排序保护)", async () => {
    const resolvers: Record<string, (v: string) => void> = {};
    const r = await renderPanel({
      dutyList: async () => [
        entry({ label: "com.agentparty.duty.a.one", instanceId: "a:one" }),
        entry({ label: "com.agentparty.duty.b.two", instanceId: "b:two" }),
      ],
      dutyLogRead: (label: string) => new Promise<string>((resolve) => { resolvers[label] = resolve; }),
    });
    const items = buttons(r).filter((b) => JSON.stringify(b.props.className).includes("resident-logs-item"));
    await act(async () => { void items[0]!.props.onClick(); }); // 点 one(未 resolve)
    await act(async () => { void items[1]!.props.onClick(); }); // 再点 two(未 resolve)
    // two 先回,再让 one 回——one 是过期请求,不该覆盖 two 的日志
    await act(async () => { resolvers["com.agentparty.duty.b.two"]!("LOG TWO"); });
    await act(async () => { resolvers["com.agentparty.duty.a.one"]!("LOG ONE"); });
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain("LOG TWO");
    expect(text).not.toContain("LOG ONE");
  });

  test("无常驻实例 → 空状态", async () => {
    const r = await renderPanel({ dutyList: async () => [], dutyLogRead: async () => "" });
    expect(JSON.stringify(r.toJSON())).toContain("ResidentDutyLogs.empty");
  });

  test("dutyList 失败 → 展示错误横幅,不崩", async () => {
    const r = await renderPanel({ dutyList: async () => { throw new Error("launchctl down"); }, dutyLogRead: async () => "" });
    expect(JSON.stringify(r.toJSON())).toContain("launchctl down");
  });
});
