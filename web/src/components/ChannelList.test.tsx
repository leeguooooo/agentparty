// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import type { PresenceEntry } from "@agentparty/shared";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import type { ChannelInfo } from "../lib/api";
import { ChannelList, lastMessagePreview, PresenceDots } from "./ChannelList";

let renderer: ReactTestRenderer | null = null;

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

function presence(name: string, state: PresenceEntry["state"]): PresenceEntry {
  return { name, state, note: null, ts: 1 };
}

function channel(
  slug: string,
  options: {
    owned?: boolean;
    member?: boolean;
    presence?: PresenceEntry[];
  } = {},
): ChannelInfo {
  return {
    slug,
    title: slug,
    topic: null,
    kind: "standing",
    mode: "normal",
    visibility: "private",
    owned: options.owned,
    member: options.member,
    created_at: 1,
    archived_at: null,
    last_message: null,
    presence: options.presence ?? [],
  };
}

function listView(scope: string, channels: ChannelInfo[], active: string | null = null) {
  return (
    <LocaleProvider>
      <ChannelList
        scopeKey={scope}
        channels={channels}
        active={active}
        error={null}
        onOpen={() => {}}
      />
    </LocaleProvider>
  );
}

function categoryButton(r: ReactTestRenderer, category: "all" | "created" | "joined") {
  const categories = r.root.findAll(
    (node) => node.type === "button" && String(node.props.className ?? "").includes("chan-cat-btn"),
  );
  const index = category === "all" ? 0 : category === "created" ? 1 : 2;
  return categories[index]!;
}

function visibleChannelSlugs(r: ReactTestRenderer): string[] {
  return r.root
    .findAll((node) => node.type === "button" && String(node.props.className ?? "").includes("chan-pill"))
    .map((node) => String(node.props.title));
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("ChannelList view-scoped filters", () => {
  test("server change resets a stale joined filter so the new server's real channels remain visible", () => {
    act(() => {
      renderer = create(
        listView("https://server-a.example:/", [
          channel("created-a", { owned: true }),
          channel("joined-a", { member: true }),
        ]),
      );
    });
    const r = renderer!;

    act(() => (categoryButton(r, "joined").props.onClick as () => void)());
    expect(visibleChannelSlugs(r)).toEqual(["joined-a"]);
    expect(categoryButton(r, "joined").props["aria-pressed"]).toBe(true);

    act(() => {
      r.update(
        listView("https://server-b.example:/", [
          channel("created-b", { owned: true }),
        ]),
      );
    });
    expect(visibleChannelSlugs(r)).toEqual(["created-b"]);
    expect(categoryButton(r, "all").props["aria-pressed"]).toBe(true);
  });

  test("route change resets the filter before rendering an externally opened active channel", () => {
    const channels = [
      channel("created-a", { owned: true }),
      channel("joined-a", { member: true }),
    ];
    act(() => {
      renderer = create(listView("https://server-a.example:/", channels));
    });
    const r = renderer!;

    act(() => (categoryButton(r, "joined").props.onClick as () => void)());
    expect(visibleChannelSlugs(r)).toEqual(["joined-a"]);

    act(() => {
      r.update(listView("https://server-a.example:/", channels, "created-a"));
    });
    expect(visibleChannelSlugs(r)).toEqual(["created-a", "joined-a"]);
    const active = r.root.findAll(
      (node) =>
        node.type === "button" &&
        String(node.props.className ?? "").includes("chan-pill") &&
        String(node.props.className ?? "").includes("is-active"),
    );
    expect(active).toHaveLength(1);
    expect(active[0]!.props.title).toBe("created-a");
  });

  test("an explicit category choice remains active while the current route is unchanged", () => {
    const channels = [
      channel("created-a", { owned: true }),
      channel("joined-a", { member: true }),
    ];
    act(() => {
      renderer = create(listView("https://server-a.example", channels, "created-a"));
    });

    act(() => (categoryButton(renderer!, "joined").props.onClick as () => void)());

    expect(visibleChannelSlugs(renderer!)).toEqual(["joined-a"]);
    expect(categoryButton(renderer!, "joined").props["aria-pressed"]).toBe(true);
  });
});

describe("PresenceDots priority", () => {
  test("working and online members are selected before earlier offline records", () => {
    const value = channel("priority", {
      presence: [
        presence("offline-1", "offline"),
        presence("offline-2", "offline"),
        presence("offline-3", "offline"),
        presence("offline-4", "offline"),
        presence("waiting-live", "waiting"),
        presence("working-live", "working"),
      ],
    });
    act(() => {
      renderer = create(
        <LocaleProvider>
          <PresenceDots channel={value} />
        </LocaleProvider>,
      );
    });

    const dots = renderer!.root
      .findAll((node) => node.type === "span" && String(node.props.className ?? "").startsWith("d-dot "))
      .map((node) => String(node.props.title));
    expect(dots).toEqual([
      "working-live — working",
      "waiting-live — waiting",
      "offline-1 — offline",
      "offline-2 — offline",
    ]);
  });

  test("treats an omitted presence field as an empty legacy response", () => {
    const value = channel("legacy-response");
    delete (value as Partial<ChannelInfo>).presence;
    act(() => {
      renderer = create(
        <LocaleProvider>
          <PresenceDots channel={value} />
        </LocaleProvider>,
      );
    });

    expect(
      renderer!.root.findAll(
        (node) => node.type === "span" && node.props.className === "d-dot d-dot--offline",
      ),
    ).toHaveLength(1);
  });
});

describe("lastMessagePreview", () => {
  test("treats an omitted last_message field as no preview", () => {
    const value = channel("legacy-response");
    delete (value as Partial<ChannelInfo>).last_message;

    expect(lastMessagePreview(value)).toBeNull();
  });
});
