// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import type { Visibility, VisibilityResult } from "../lib/api";
import { ChannelAdminView } from "./ChannelAdminView";

const actualApi = await import("../lib/api");
const visibilityCalls: Array<{
  token: string;
  slug: string;
  visibility: Visibility;
  confirm: boolean;
}> = [];
let setVisibilityImpl = async (): Promise<VisibilityResult> => ({ changed: true });

mock.module("../lib/api", () => ({
  ...actualApi,
  setChannelVisibility: async (
    token: string,
    slug: string,
    visibility: Visibility,
    confirm = false,
  ) => {
    visibilityCalls.push({ token, slug, visibility, confirm });
    return setVisibilityImpl();
  },
}));

const { VisibilityToggle } = await import("./VisibilityToggle");

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
}

function memoryStorage(): Storage {
  const values = new Map<string, string>([["ap_locale", "en"]]);
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
let windowEvents: TestEventTarget;

beforeEach(() => {
  visibilityCalls.length = 0;
  setVisibilityImpl = async () => ({ changed: true });
  windowEvents = new TestEventTarget();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowEvents });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("VisibilityToggle confirmation", () => {
  test("focuses confirmation and Escape cancels back to its trigger without closing Admin", async () => {
    setVisibilityImpl = async () => ({ needsConfirm: true, messageCount: 23 });
    let focused = "";
    const publicOption = {
      isConnected: true,
      focus: () => { focused = "public"; },
    };
    const confirmAction = {
      isConnected: true,
      focus: () => { focused = "confirm"; },
    };

    await act(async () => {
      renderer = create(
        <LocaleProvider>
          <VisibilityToggle
            slug="demo"
            token="owner-token"
            visibility="private"
            onChanged={() => {}}
            onAuthFailed={() => {}}
          />
        </LocaleProvider>,
        {
          createNodeMock(element) {
            const props = element.props as Record<string, unknown>;
            if (
              props.className === "vis-seg-btn"
              && props.children === "public"
            ) return publicOption;
            if (props.className === "d-btn d-btn--primary") return confirmAction;
            return { isConnected: true, focus: () => {} };
          },
        },
      );
    });

    const publicButton = renderer!.root
      .findAllByType("button")
      .find((node) => node.props.className === "vis-seg-btn" && node.children.includes("public"))!;
    await act(async () => {
      publicButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const confirmation = renderer!.root.findByProps({ role: "alertdialog" });
    expect(confirmation.props["aria-modal"]).toBeUndefined();
    expect(confirmation.props["aria-describedby"]).toBe(
      confirmation.findByProps({ className: "vis-confirm-text" }).props.id,
    );
    expect(focused).toBe("confirm");
    expect(visibilityCalls).toEqual([{
      token: "owner-token",
      slug: "demo",
      visibility: "public",
      confirm: false,
    }]);

    let adminCloseCalls = 0;
    windowEvents.addEventListener("keydown", (rawEvent) => {
      const event = rawEvent as { key: string; defaultPrevented: boolean };
      if (event.key === "Escape" && !event.defaultPrevented) adminCloseCalls += 1;
    });
    const escape = {
      key: "Escape",
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    act(() => windowEvents.emit("keydown", escape));

    expect(escape.defaultPrevented).toBe(true);
    expect(escape.propagationStopped).toBe(true);
    expect(adminCloseCalls).toBe(0);
    expect(renderer!.root.findAllByProps({ role: "alertdialog" })).toHaveLength(0);
    expect(focused).toBe("public");
  });

  test("consumes Escape without dismissing while the confirmed request is busy", async () => {
    let callCount = 0;
    let resolveConfirmed!: (result: VisibilityResult) => void;
    setVisibilityImpl = async () => {
      callCount += 1;
      if (callCount === 1) return { needsConfirm: true, messageCount: 23 };
      return new Promise<VisibilityResult>((resolve) => {
        resolveConfirmed = resolve;
      });
    };
    const changed: Visibility[] = [];

    await act(async () => {
      renderer = create(
        <LocaleProvider>
          <VisibilityToggle
            slug="demo"
            token="owner-token"
            visibility="private"
            onChanged={(next) => changed.push(next)}
            onAuthFailed={() => {}}
          />
        </LocaleProvider>,
      );
    });

    const publicButton = renderer!.root
      .findAllByType("button")
      .find((node) => node.props.className === "vis-seg-btn" && node.children.includes("public"))!;
    await act(async () => {
      publicButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    const confirmButton = renderer!.root.findByProps({ className: "d-btn d-btn--primary" });
    act(() => confirmButton.props.onClick());
    expect(renderer!.root.findByProps({ className: "d-btn d-btn--primary" }).props.disabled).toBe(true);

    let adminCloseCalls = 0;
    windowEvents.addEventListener("keydown", (rawEvent) => {
      const event = rawEvent as { key: string; defaultPrevented: boolean };
      if (event.key === "Escape" && !event.defaultPrevented) adminCloseCalls += 1;
    });
    const escape = {
      key: "Escape",
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    act(() => windowEvents.emit("keydown", escape));

    expect(escape.defaultPrevented).toBe(true);
    expect(escape.propagationStopped).toBe(true);
    expect(adminCloseCalls).toBe(0);
    expect(renderer!.root.findAllByProps({ role: "alertdialog" })).toHaveLength(1);
    expect(changed).toEqual([]);

    await act(async () => {
      resolveConfirmed({ changed: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer!.root.findAllByProps({ role: "alertdialog" })).toHaveLength(0);
    expect(changed).toEqual(["public"]);
  });

  test("switching away from Access clears confirmation and releases Escape", async () => {
    setVisibilityImpl = async () => ({ needsConfirm: true, messageCount: 23 });
    await act(async () => {
      renderer = create(
        <LocaleProvider>
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
            members={[]}
            accessControls={(active) => (
              <VisibilityToggle
                active={active}
                slug="demo"
                token="owner-token"
                visibility="private"
                onChanged={() => {}}
                onAuthFailed={() => {}}
              />
            )}
          />
        </LocaleProvider>,
      );
    });

    const publicButton = renderer!.root
      .findAllByType("button")
      .find((node) => node.props.className === "vis-seg-btn" && node.children.includes("public"))!;
    await act(async () => {
      publicButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer!.root.findAllByProps({ role: "alertdialog" })).toHaveLength(1);

    await act(async () => {
      renderer!.root.findByProps({ "data-admin-section": "members" }).props.onClick();
      await Promise.resolve();
    });
    expect(renderer!.root.findAllByProps({ role: "alertdialog" })).toHaveLength(0);

    const escape = {
      key: "Escape",
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    act(() => windowEvents.emit("keydown", escape));
    expect(escape.defaultPrevented).toBe(false);
    expect(escape.propagationStopped).toBe(false);
  });

  test("a late confirmation response cannot create a hidden dialog or Escape listener", async () => {
    let resolveInitial!: (result: VisibilityResult) => void;
    setVisibilityImpl = async () => new Promise<VisibilityResult>((resolve) => {
      resolveInitial = resolve;
    });
    await act(async () => {
      renderer = create(
        <LocaleProvider>
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
            members={[]}
            accessControls={(active) => (
              <VisibilityToggle
                active={active}
                slug="demo"
                token="owner-token"
                visibility="private"
                onChanged={() => {}}
                onAuthFailed={() => {}}
              />
            )}
          />
        </LocaleProvider>,
      );
    });

    const publicButton = renderer!.root
      .findAllByType("button")
      .find((node) => node.props.className === "vis-seg-btn" && node.children.includes("public"))!;
    act(() => publicButton.props.onClick());
    await act(async () => {
      renderer!.root.findByProps({ "data-admin-section": "members" }).props.onClick();
      resolveInitial({ needsConfirm: true, messageCount: 23 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer!.root.findAllByProps({ role: "alertdialog" })).toHaveLength(0);
    const escape = {
      key: "Escape",
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    act(() => windowEvents.emit("keydown", escape));
    expect(escape.defaultPrevented).toBe(false);
    expect(escape.propagationStopped).toBe(false);
  });
});
