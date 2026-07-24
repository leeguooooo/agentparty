// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AgentDetailPanel } from "../components/AgentDetailModal";
import { ChannelAdminView } from "../components/ChannelAdminView";
import { TeamTabs } from "../components/TeamTabs";
import { LocaleProvider } from "../i18n/locale";
import { ChannelPanelModal } from "./Channel";

function memoryStorage(): Storage {
  const values = new Map<string, string>([["ap_locale", "zh"]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

let renderer: ReactTestRenderer | null = null;
let fakeWindow: EventTarget | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  fakeWindow = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  fakeWindow = null;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "HTMLElement");
  Reflect.deleteProperty(globalThis, "localStorage");
});

function pressEscape(): void {
  const event = new Event("keydown") as Event & { key: string };
  event.key = "Escape";
  fakeWindow!.dispatchEvent(event);
}

describe("Channel Team member route", () => {
  test("keeps member detail inside the single channel dialog", () => {
    act(() => {
      renderer = create(
        <LocaleProvider>
          <ChannelPanelModal title="Team" onClose={() => {}}>
            <AgentDetailPanel
              name="worker-a"
              display="Worker A"
              kind="agent"
              owner={null}
              online
              presence={null}
              messages={[]}
              assignment={{
                role: "worker",
                responsibility: "Ship the channel UI",
                reportsTo: null,
                source: "assigned",
              }}
            />
          </ChannelPanelModal>
        </LocaleProvider>,
      );
    });

    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(renderer!.root.findAll((node) => node.props.className === "channel-panel-scrim")).toHaveLength(1);
  });

  test("Escape can return from member detail without closing the Team dialog", () => {
    let closeCalls = 0;
    let backCalls = 0;
    act(() => {
      renderer = create(
        <LocaleProvider>
          <ChannelPanelModal
            title="Team"
            onClose={() => { closeCalls += 1; }}
            onEscape={() => { backCalls += 1; }}
          >
            <div>member detail</div>
          </ChannelPanelModal>
        </LocaleProvider>,
      );
    });

    act(() => pressEscape());
    expect(backCalls).toBe(1);
    expect(closeCalls).toBe(0);

    const scrim = renderer!.root.find((node) => node.props.className === "channel-panel-scrim");
    act(() => scrim.props.onClick());
    expect(closeCalls).toBe(1);
  });

  test("Admin Members View and Escape return to Members and restore its View trigger", () => {
    let closeCalls = 0;
    let focusedBack = 0;
    let focusedMember: string | null = null;

    function AdminMemberRoute() {
      const [member, setMember] = useState<string | null>(null);
      return (
        <LocaleProvider>
          <ChannelPanelModal
            title="Admin"
            hideHeader
            onClose={() => { closeCalls += 1; }}
            onEscape={member === null ? undefined : () => setMember(null)}
          >
            <ChannelAdminView
              slug="demo"
              visibility="private"
              archived={false}
              capabilities={{
                manageAccess: true,
                manageMembers: true,
                manageSafety: true,
                archive: true,
              }}
              members={[{
                name: "worker-a",
                display: "Worker A",
                kind: "agent",
                canRemove: false,
              }]}
              initialSection="members"
              detail={member === null ? null : <article data-admin-member-detail={member}>DETAIL</article>}
              detailBackLabel="Back to members"
              onBackFromDetail={() => setMember(null)}
              onOpenMember={setMember}
              onClose={() => { closeCalls += 1; }}
            />
          </ChannelPanelModal>
        </LocaleProvider>
      );
    }

    act(() => {
      renderer = create(<AdminMemberRoute />, {
        createNodeMock(element) {
          const props = element.props as Record<string, unknown>;
          if (element.type === "button" && props["data-admin-member-open"] === "worker-a") {
            return {
              focus: () => {
                focusedMember = "worker-a";
              },
            };
          }
          if (
            element.type === "button"
            && String(props.className).includes("team-blog-detail-back")
          ) {
            return { focus: () => { focusedBack += 1; } };
          }
          return null;
        },
      });
    });

    const r = renderer!;
    act(() => r.root.findByProps({ "data-admin-member-open": "worker-a" }).props.onClick());
    expect(focusedBack).toBe(1);
    expect(r.root.findByProps({ "data-admin-member-detail": "worker-a" })).toBeTruthy();

    act(() => pressEscape());

    expect(closeCalls).toBe(0);
    expect(r.root.findAllByProps({ "data-admin-member-detail": "worker-a" })).toHaveLength(0);
    expect(
      r.root.findByProps({ "data-admin-section": "members" }).props["aria-selected"],
    ).toBe(true);
    expect(focusedMember).toBe("worker-a");
  });

  test("ordinary Team detail Back returns to the Team board route, not Admin Members", () => {
    let focusedBack = 0;
    let focusedTabId: string | null = null;

    function TeamMemberRoute() {
      const [showDetail, setShowDetail] = useState(false);
      return (
        <LocaleProvider>
          <ChannelPanelModal title="Team" hideHeader onClose={() => {}}>
            <TeamTabs
              initialTab="board"
              stats={{ roles: 1, online: 1, offline: 0, unclaimed: 0 }}
              mentionCount={0}
              division={<div>DIVISION</div>}
              board={(
                <button type="button" data-team-member-open onClick={() => setShowDetail(true)}>
                  OPEN
                </button>
              )}
              coordination={<div>COORDINATION</div>}
              detail={showDetail ? <article data-team-member-detail>DETAIL</article> : null}
              detailBackLabel="Back to team"
              onBackFromDetail={() => setShowDetail(false)}
            />
          </ChannelPanelModal>
        </LocaleProvider>
      );
    }

    act(() => {
      renderer = create(<TeamMemberRoute />, {
        createNodeMock(element) {
          const props = element.props as Record<string, unknown>;
          if (element.type === "button" && props.role === "tab") {
            return {
              focus: () => {
                focusedTabId = typeof props.id === "string" ? props.id : null;
              },
            };
          }
          if (
            element.type === "button"
            && String(props.className).includes("team-blog-detail-back")
          ) {
            return { focus: () => { focusedBack += 1; } };
          }
          return null;
        },
      });
    });

    const r = renderer!;
    act(() => r.root.findByProps({ "data-team-member-open": true }).props.onClick());
    expect(focusedBack).toBe(1);
    expect(r.root.findByProps({ role: "tablist" }).props.hidden).toBe(true);

    const back = r.root.findAllByType("button")
      .find((button) => String(button.props.className).includes("team-blog-detail-back"))!;
    act(() => back.props.onClick());

    const teamTabs = r.root.findAllByProps({ role: "tab" });
    expect(teamTabs.map((tab) => tab.props["aria-selected"])).toEqual([false, true, false]);
    expect(r.root.findAllByProps({ role: "tabpanel" }).map((panel) => panel.props.hidden))
      .toEqual([true, false, true]);
    expect(focusedTabId).toContain("team-tab-board");
    expect(r.root.findAll((node) => node.props["data-admin-section"] !== undefined)).toHaveLength(0);
  });

  test("does not close when an embedded route already handled Escape", () => {
    let closeCalls = 0;
    act(() => {
      renderer = create(
        <LocaleProvider>
          <ChannelPanelModal title="Admin" onClose={() => { closeCalls += 1; }}>
            <div>embedded confirmation</div>
          </ChannelPanelModal>
        </LocaleProvider>,
      );
    });

    const event = new Event("keydown", { cancelable: true }) as Event & { key: string };
    event.key = "Escape";
    event.preventDefault();
    act(() => {
      fakeWindow!.dispatchEvent(event);
    });
    expect(closeCalls).toBe(0);
  });

  test("focus trap ignores controls inside persistent hidden tab panels", () => {
    const doc: { activeElement: FocusMock | null } = { activeElement: null };
    class FocusMock {
      readonly isConnected = true;
      readonly tabIndex = 0;
      constructor(
        readonly name: string,
        readonly hiddenByAncestor = false,
        readonly autofocus = false,
      ) {}
      focus() { doc.activeElement = this; }
      closest() { return this.hiddenByAncestor ? {} : null; }
      hasAttribute(name: string) { return name === "autofocus" && this.autofocus; }
    }
    const source = new FocusMock("source");
    const close = new FocusMock("close");
    const visibleAction = new FocusMock("visible");
    const hiddenAction = new FocusMock("hidden", true);
    const card = Object.assign(new FocusMock("card"), {
      contains: (element: unknown) => [close, visibleAction, hiddenAction, card].includes(element as FocusMock),
      querySelectorAll: () => [close, visibleAction, hiddenAction],
    });
    source.focus();
    Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FocusMock });

    act(() => {
      renderer = create(
        <LocaleProvider>
          <ChannelPanelModal title="Team" onClose={() => {}}>
            <button type="button" className="visible-action">Visible</button>
            <section hidden>
              <button type="button" className="hidden-action">Hidden</button>
            </section>
          </ChannelPanelModal>
        </LocaleProvider>,
        {
          createNodeMock(element) {
            const props = element.props as Record<string, unknown>;
            if (props.className === "channel-panel-card") return card;
            if (props.className === "d-btn channel-panel-close") return close;
            if (props.className === "visible-action") return visibleAction;
            if (props.className === "hidden-action") return hiddenAction;
            return {};
          },
        },
      );
    });

    expect(doc.activeElement).toBe(close);
    visibleAction.focus();
    const event = new Event("keydown", { cancelable: true }) as Event & {
      key: string;
      shiftKey: boolean;
    };
    event.key = "Tab";
    event.shiftKey = false;
    act(() => {
      fakeWindow!.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(close);
  });

  test("focus trap redirects Tab when focus escaped or points at an unmounted node", () => {
    const doc: { activeElement: FocusMock | null } = { activeElement: null };
    class FocusMock {
      readonly tabIndex = 0;
      constructor(
        readonly name: string,
        readonly isConnected = true,
      ) {}
      focus() { doc.activeElement = this; }
      closest() { return null; }
      hasAttribute() { return false; }
    }
    const source = new FocusMock("source");
    const close = new FocusMock("close");
    const action = new FocusMock("action");
    const outside = new FocusMock("outside");
    const unmountedInside = new FocusMock("unmounted", false);
    const card = Object.assign(new FocusMock("card"), {
      contains: (element: unknown) => [close, action, unmountedInside, card].includes(element as FocusMock),
      querySelectorAll: () => [close, action],
    });
    source.focus();
    Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FocusMock });

    act(() => {
      renderer = create(
        <LocaleProvider>
          <ChannelPanelModal title="Team" onClose={() => {}}>
            <button type="button" className="visible-action">Visible</button>
          </ChannelPanelModal>
        </LocaleProvider>,
        {
          createNodeMock(element) {
            const props = element.props as Record<string, unknown>;
            if (props.className === "channel-panel-card") return card;
            if (props.className === "d-btn channel-panel-close") return close;
            if (props.className === "visible-action") return action;
            return {};
          },
        },
      );
    });

    expect(doc.activeElement).toBe(close);
    for (const escapedFocus of [outside, unmountedInside]) {
      escapedFocus.focus();
      const event = new Event("keydown", { cancelable: true }) as Event & {
        key: string;
        shiftKey: boolean;
      };
      event.key = "Tab";
      event.shiftKey = false;
      act(() => {
        fakeWindow!.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(doc.activeElement).toBe(close);
    }
  });

  test("focus trap ignores inactive roving tabs in a sparse archived Admin panel", () => {
    const doc: { activeElement: FocusMock | null } = { activeElement: null };
    class FocusMock {
      readonly isConnected = true;
      constructor(
        readonly name: string,
        readonly tabIndex: number,
      ) {}
      focus() { doc.activeElement = this; }
      closest() { return null; }
      hasAttribute() { return false; }
    }
    const source = new FocusMock("source", 0);
    const close = new FocusMock("close", 0);
    const access = new FocusMock("access", 0);
    const members = new FocusMock("members", -1);
    const safety = new FocusMock("safety", -1);
    const lifecycle = new FocusMock("lifecycle", -1);
    const controls = [close, access, members, safety, lifecycle];
    const card = Object.assign(new FocusMock("card", -1), {
      contains: (element: unknown) => controls.includes(element as FocusMock) || element === card,
      querySelectorAll: () => controls,
    });
    source.focus();
    Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FocusMock });

    act(() => {
      renderer = create(
        <LocaleProvider>
          <ChannelPanelModal title="Admin" hideHeader onClose={() => {}}>
            <ChannelAdminView
              slug="demo"
              visibility="private"
              archived
              capabilities={{
                manageAccess: true,
                manageMembers: true,
                manageSafety: true,
                archive: true,
              }}
              members={[]}
              onClose={() => {}}
            />
          </ChannelPanelModal>
        </LocaleProvider>,
        {
          createNodeMock(element) {
            const props = element.props as Record<string, unknown>;
            if (props.className === "channel-panel-card") return card;
            if (props.className === "d-btn team-blog-close") return close;
            if (props["data-admin-section"] === "access") return access;
            if (props["data-admin-section"] === "members") return members;
            if (props["data-admin-section"] === "safety") return safety;
            if (props["data-admin-section"] === "lifecycle") return lifecycle;
            return {};
          },
        },
      );
    });

    expect(doc.activeElement).toBe(close);
    access.focus();
    const tab = new Event("keydown", { cancelable: true }) as Event & {
      key: string;
      shiftKey: boolean;
    };
    tab.key = "Tab";
    tab.shiftKey = false;
    act(() => {
      fakeWindow!.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(close);

    const shiftTab = new Event("keydown", { cancelable: true }) as Event & {
      key: string;
      shiftKey: boolean;
    };
    shiftTab.key = "Tab";
    shiftTab.shiftKey = true;
    act(() => {
      fakeWindow!.dispatchEvent(shiftTab);
    });
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(access);
  });
});
