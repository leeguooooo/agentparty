// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { SectionedDialog, type SectionedDialogSection } from "./SectionedDialog";

type SectionId = "general" | "account" | "desktop";
type EventListener = (event: unknown) => void;

class EventTargetHarness {
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class MediaQueryHarness extends EventTargetHarness {
  readonly media = "(max-width: 760px)";
  onchange: ((event: unknown) => void) | null = null;

  constructor(public matches: boolean) {
    super();
  }

  addListener(listener: EventListener) {
    this.addEventListener("change", listener);
  }

  removeListener(listener: EventListener) {
    this.removeEventListener("change", listener);
  }
}

interface DocumentHarness {
  activeElement: FocusableHarness | null;
}

class FocusableHarness {
  focusCount = 0;
  isConnected = true;

  constructor(
    readonly name: string,
    private readonly document: DocumentHarness,
    public tabIndex = 0,
    private readonly hiddenAncestor = false,
  ) {}

  focus() {
    this.focusCount += 1;
    this.document.activeElement = this;
  }

  closest(selector: string) {
    return selector === "[hidden]" && this.hiddenAncestor ? { hidden: true } : null;
  }
}

class PanelHarness extends FocusableHarness {
  constructor(
    document: DocumentHarness,
    private readonly focusables: readonly FocusableHarness[],
  ) {
    super("dialog panel", document, -1);
  }

  querySelectorAll() {
    // Mirrors the component's broad selector: enabled buttons are returned
    // even when they have tabIndex=-1. SectionedDialog must remove those from
    // the actual keyboard cycle itself.
    return this.focusables;
  }

  contains(element: FocusableHarness) {
    return element === this || (element.isConnected && this.focusables.includes(element));
  }
}

interface KeyHarness {
  key: string;
  shiftKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function keyEvent(key: string, shiftKey = false): KeyHarness {
  return {
    key,
    shiftKey,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

const sectionIds: readonly SectionId[] = ["general", "account", "desktop"];
const sections: readonly SectionedDialogSection<SectionId>[] = sectionIds.map((id) => ({
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
  content: <button type="button">{id} action</button>,
}));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
let mountedRenderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (mountedRenderer !== null) {
    act(() => mountedRenderer?.unmount());
    mountedRenderer = null;
  }
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else Object.defineProperty(globalThis, "window", originalWindow);
  if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else Object.defineProperty(globalThis, "document", originalDocument);
  if (originalActEnvironment === undefined) {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  } else {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalActEnvironment);
  }
});

function renderDialog({
  mobile = false,
  restoreFocusOnUnmount = true,
}: {
  mobile?: boolean;
  restoreFocusOnUnmount?: boolean;
} = {}) {
  const documentHarness: DocumentHarness = { activeElement: null };
  const previous = new FocusableHarness("trigger", documentHarness);
  previous.focus();

  const close = new FocusableHarness("close", documentHarness);
  const tabElements = new Map<SectionId, FocusableHarness>(
    sectionIds.map((id, index) => [
      id,
      new FocusableHarness(`${id} tab`, documentHarness, index === 0 ? 0 : -1),
    ]),
  );
  const visibleAction = new FocusableHarness("visible action", documentHarness);
  const residentStop = new FocusableHarness("resident stop", documentHarness);
  const hiddenAction = new FocusableHarness("hidden action", documentHarness, 0, true);
  const focusables = [
    close,
    ...sectionIds.map((id) => tabElements.get(id)!),
    residentStop,
    visibleAction,
    hiddenAction,
  ];
  const panel = new PanelHarness(documentHarness, focusables);
  const windowHarness = new EventTargetHarness();
  const mediaQuery = new MediaQueryHarness(mobile);
  const windowValue = Object.assign(windowHarness, {
    matchMedia: (query: string) => {
      expect(query).toBe(mediaQuery.media);
      return mediaQuery;
    },
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowValue });
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentHarness });

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <SectionedDialog
        idPrefix="test-dialog"
        title="Test dialog"
        closeLabel="Close"
        navigationLabel="Sections"
        sections={sections}
        initialSection="general"
        onClose={() => {}}
        restoreFocusOnUnmount={restoreFocusOnUnmount}
      />,
      {
        createNodeMock(element) {
          const props = element.props as Record<string, unknown>;
          if (props.role === "tab") {
            const id = String(props.id).replace("test-dialog-tab-", "") as SectionId;
            return tabElements.get(id)!;
          }
          if (String(props.className ?? "").split(" ").includes("settings-panel")) return panel;
          return {};
        },
      },
    );
  });
  mountedRenderer = renderer;

  return {
    renderer,
    document: documentHarness,
    window: windowHarness,
    previous,
    close,
    tabs: tabElements,
    residentStop,
    removeResidentStop() {
      residentStop.isConnected = false;
      focusables.splice(focusables.indexOf(residentStop), 1);
    },
    visibleAction,
    hiddenAction,
  };
}

function tabs(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll((node) => node.props.role === "tab");
}

function tablist(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.find((node) => node.props.role === "tablist");
}

function selectedTab(renderer: ReactTestRenderer): ReactTestInstance {
  return tabs(renderer).find((tab) => tab.props["aria-selected"] === true)!;
}

function pressTab(windowHarness: EventTargetHarness, shiftKey = false): KeyHarness {
  const event = keyEvent("Tab", shiftKey);
  act(() => windowHarness.emit("keydown", event));
  return event;
}

function pressSectionKey(tab: ReactTestInstance, key: string): KeyHarness {
  const event = keyEvent(key);
  act(() => tab.props.onKeyDown(event));
  return event;
}

describe("SectionedDialog focus lifecycle", () => {
  test("focuses the initial section and returns focus to the trigger on unmount", () => {
    const rendered = renderDialog();

    expect(rendered.document.activeElement).toBe(rendered.tabs.get("general")!);

    act(() => rendered.renderer.unmount());
    mountedRenderer = null;
    expect(rendered.document.activeElement).toBe(rendered.previous);
  });

  test("wraps Tab without admitting inactive tabs or controls in hidden panels", () => {
    const rendered = renderDialog();

    rendered.close.focus();
    const backward = pressTab(rendered.window, true);
    expect(backward.defaultPrevented).toBe(true);
    expect(rendered.document.activeElement).toBe(rendered.visibleAction);
    expect(rendered.document.activeElement).not.toBe(rendered.tabs.get("desktop")!);
    expect(rendered.document.activeElement).not.toBe(rendered.hiddenAction);

    const forward = pressTab(rendered.window);
    expect(forward.defaultPrevented).toBe(true);
    expect(rendered.document.activeElement).toBe(rendered.close);
  });

  test("re-enters after Resident Stop refresh removes the focused row", () => {
    const rendered = renderDialog();

    rendered.residentStop.focus();
    rendered.removeResidentStop();
    const forward = pressTab(rendered.window);
    expect(forward.defaultPrevented).toBe(true);
    expect(rendered.document.activeElement).toBe(rendered.close);

    rendered.previous.focus();
    const backward = pressTab(rendered.window, true);
    expect(backward.defaultPrevented).toBe(true);
    expect(rendered.document.activeElement).toBe(rendered.visibleAction);
  });

  test("can hand focus directly to a replacement modal without restoring behind it", () => {
    const rendered = renderDialog({ restoreFocusOnUnmount: false });

    act(() => rendered.renderer.unmount());
    mountedRenderer = null;

    expect(rendered.document.activeElement).toBe(rendered.tabs.get("general")!);
    expect(rendered.previous.focusCount).toBe(1);
  });
});

describe("SectionedDialog section keyboard navigation", () => {
  test("uses vertical arrow keys on desktop and always supports Home and End", () => {
    const { renderer, document, tabs: tabElements } = renderDialog();

    expect(tablist(renderer).props["aria-orientation"]).toBe("vertical");
    const ignored = pressSectionKey(tabs(renderer)[0]!, "ArrowRight");
    expect(ignored.defaultPrevented).toBe(false);
    expect(selectedTab(renderer).props.id).toBe("test-dialog-tab-general");

    const down = pressSectionKey(tabs(renderer)[0]!, "ArrowDown");
    expect(down.defaultPrevented).toBe(true);
    expect(selectedTab(renderer).props.id).toBe("test-dialog-tab-account");
    expect(document.activeElement).toBe(tabElements.get("account")!);

    pressSectionKey(selectedTab(renderer), "End");
    expect(selectedTab(renderer).props.id).toBe("test-dialog-tab-desktop");
    expect(document.activeElement).toBe(tabElements.get("desktop")!);

    pressSectionKey(selectedTab(renderer), "Home");
    expect(selectedTab(renderer).props.id).toBe("test-dialog-tab-general");
    expect(document.activeElement).toBe(tabElements.get("general")!);

    pressSectionKey(selectedTab(renderer), "ArrowUp");
    expect(selectedTab(renderer).props.id).toBe("test-dialog-tab-desktop");
    expect(document.activeElement).toBe(tabElements.get("desktop")!);
  });

  test("uses horizontal arrow keys at the responsive mobile breakpoint", () => {
    const { renderer, document, tabs: tabElements } = renderDialog({ mobile: true });

    expect(tablist(renderer).props["aria-orientation"]).toBe("horizontal");
    const ignored = pressSectionKey(tabs(renderer)[0]!, "ArrowDown");
    expect(ignored.defaultPrevented).toBe(false);
    expect(selectedTab(renderer).props.id).toBe("test-dialog-tab-general");

    const right = pressSectionKey(tabs(renderer)[0]!, "ArrowRight");
    expect(right.defaultPrevented).toBe(true);
    expect(selectedTab(renderer).props.id).toBe("test-dialog-tab-account");
    expect(document.activeElement).toBe(tabElements.get("account")!);

    pressSectionKey(selectedTab(renderer), "ArrowLeft");
    expect(selectedTab(renderer).props.id).toBe("test-dialog-tab-general");
    expect(document.activeElement).toBe(tabElements.get("general")!);
  });
});
