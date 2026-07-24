// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { SearchHit } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";
import { ChannelStrings } from "../i18n/strings/Channel";
import { ChannelPanelModal, ChannelSearchPanel, type ChannelSearchPanelProps } from "./Channel";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

const hit: SearchHit = {
  type: "search_hit",
  channel: "ops",
  query: "deploy",
  seq: 42,
  sender: { name: "alice", kind: "agent" },
  kind: "message",
  match_field: "body",
  snippet: "deploy completed",
  ts: 1_700_000_000_000,
};

const noop = () => {};
const acceptJump = () => true;
let renderer: ReactTestRenderer | null = null;
let fakeWindow: EventTarget | null = null;

function baseProps(overrides: Partial<ChannelSearchPanelProps> = {}): ChannelSearchPanelProps {
  return {
    search: "deploy",
    query: "deploy",
    searchFrom: "",
    searchSince: "0",
    searchLimit: "100",
    senderListId: "senders-ops",
    knownSenders: ["alice"],
    searchLoading: false,
    searchHits: [hit],
    visibleSearchHits: [hit],
    agentFilterActive: false,
    searchInputError: null,
    searchError: null,
    onSearch: noop,
    onSearchFrom: noop,
    onSearchSince: noop,
    onSearchLimit: noop,
    onClose: noop,
    onJump: acceptJump,
    ...overrides,
  };
}

function render(props: ChannelSearchPanelProps) {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <ChannelPanelModal title="Search" onClose={props.onClose}>
          <ChannelSearchPanel {...props} />
        </ChannelPanelModal>
      </LocaleProvider>,
    );
  });
  return renderer!.root;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  fakeWindow = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  localStorage.setItem("ap_locale", "en");
});

afterEach(() => {
  if (renderer) {
    act(() => renderer!.unmount());
    renderer = null;
  }
  Reflect.deleteProperty(globalThis, "window");
  fakeWindow = null;
});

describe("Channel search modal (#351)", () => {
  test("keeps the search input, loading state, and filters inside the dialog", () => {
    const root = render(baseProps({ searchLoading: true, searchHits: [], visibleSearchHits: [] }));
    const dialog = root.findByProps({ role: "dialog" });

    expect(dialog.findByProps({ type: "search" }).props.value).toBe("deploy");
    expect(dialog.findByProps({ role: "status" }).props.children).toBe(ChannelStrings.en["Channel.search.searching"]);
    expect(dialog.findAllByProps({ className: "t-mono chan-filter-input" })).toHaveLength(2);
  });

  test("renders validation and request errors inside the dialog", () => {
    let root = render(baseProps({ searchInputError: "invalid limit", searchHits: [], visibleSearchHits: [] }));
    expect(root.findByProps({ role: "dialog" }).findByProps({ role: "alert" }).props.children).toBe("invalid limit");

    act(() => renderer!.update(
      <LocaleProvider>
        <ChannelPanelModal title="Search" onClose={noop}>
          <ChannelSearchPanel {...baseProps({ searchError: "request failed", searchHits: [], visibleSearchHits: [] })} />
        </ChannelPanelModal>
      </LocaleProvider>,
    ));
    root = renderer!.root;
    expect(root.findByProps({ role: "dialog" }).findByProps({ role: "alert" }).props.children).toBe("request failed");
  });

  test("renders hits inside the dialog and closes only after an async jump succeeds", async () => {
    const events: string[] = [];
    const root = render(baseProps({
      onClose: () => events.push("close"),
      onJump: async (seq) => {
        events.push(`jump:${seq}`);
        return true;
      },
    }));
    const dialog = root.findByProps({ role: "dialog" });
    const jump = dialog.findByProps({ title: ChannelStrings.en["Channel.search.jumpTitle"] });

    expect(dialog.findByProps({ className: "search-hit-snippet" }).props.children).toBe("deploy completed");
    await act(async () => { await jump.props.onClick(); });
    expect(events).toEqual(["jump:42", "close"]);
  });

  test("keeps the search dialog open and shows the jump error when navigation fails", async () => {
    const events: string[] = [];
    const root = render(baseProps({
      jumpError: "Message #42 is outside the loaded history.",
      onClose: () => events.push("close"),
      onJump: (seq) => {
        events.push(`jump:${seq}`);
        return false;
      },
    }));
    const dialog = root.findByProps({ role: "dialog" });
    const jump = dialog.findByProps({ title: ChannelStrings.en["Channel.search.jumpTitle"] });

    await act(async () => { await jump.props.onClick(); });
    expect(events).toEqual(["jump:42"]);
    expect(dialog.findByProps({ role: "alert" }).props.children).toBe("Message #42 is outside the loaded history.");
  });

  test("does not close while an around-seq load is still pending", async () => {
    const events: string[] = [];
    let resolveJump!: (located: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { resolveJump = resolve; });
    const root = render(baseProps({
      onClose: () => events.push("close"),
      onJump: (seq) => {
        events.push(`jump:${seq}`);
        return pending;
      },
    }));
    const jump = root.findByProps({ title: ChannelStrings.en["Channel.search.jumpTitle"] });
    let completion!: Promise<void>;

    act(() => { completion = jump.props.onClick(); });
    expect(events).toEqual(["jump:42"]);
    expect(root.findByProps({ className: "chan-search-panel" }).props["aria-busy"]).toBe(true);
    expect(jump.props.disabled).toBe(true);

    resolveJump(true);
    await act(async () => { await completion; });
    expect(events).toEqual(["jump:42", "close"]);
  });

  test("reserves explicit #<seq> for navigation and searches bare numbers as text", () => {
    let root = render(baseProps({
      search: "634",
      query: "634",
      searchHits: [],
      visibleSearchHits: [],
    }));
    let dialog = root.findByProps({ role: "dialog" });

    expect(dialog.findAllByProps({ className: "d-btn chan-search-seq-jump" })).toHaveLength(0);
    expect(dialog.findAllByProps({ className: "t-mono chan-filter-input" })).toHaveLength(2);
    expect(dialog.findByProps({ type: "search" }).props.placeholder).toContain("#123");

    act(() => renderer!.update(
      <LocaleProvider>
        <ChannelPanelModal title="Search" onClose={noop}>
          <ChannelSearchPanel {...baseProps({
            search: "#634",
            query: "#634",
            searchHits: [],
            visibleSearchHits: [],
          })} />
        </ChannelPanelModal>
      </LocaleProvider>,
    ));
    root = renderer!.root;
    dialog = root.findByProps({ role: "dialog" });

    expect(dialog.findByProps({ className: "d-btn chan-search-seq-jump" }).props.children).toContain("634");
    expect(dialog.findAllByProps({ className: "t-mono chan-filter-input" })).toHaveLength(0);
  });

  test("renders both no-result states inside the dialog", () => {
    let root = render(baseProps({ searchHits: [], visibleSearchHits: [] }));
    expect(root.findByProps({ role: "dialog" }).findByProps({ className: "d-empty" }).props.children).toContain("deploy");

    act(() => renderer!.update(
      <LocaleProvider>
        <ChannelPanelModal title="Search" onClose={noop}>
          <ChannelSearchPanel {...baseProps({ searchHits: [hit], visibleSearchHits: [] })} />
        </ChannelPanelModal>
      </LocaleProvider>,
    ));
    root = renderer!.root;
    expect(root.findByProps({ role: "dialog" }).findByProps({ className: "d-empty" }).props.children)
      .toBe(ChannelStrings.en["Channel.empty.searchFiltered"]);
  });
});
