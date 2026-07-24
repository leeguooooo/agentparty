// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import {
  ChannelAdminView,
  type ChannelAdminSection,
  type ChannelAdminViewProps,
} from "./ChannelAdminView";

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

const MEMBERS: ChannelAdminViewProps["members"] = [
  {
    name: "worker-1",
    display: "Worker One",
    kind: "agent",
    detail: "Owns the API",
    canRemove: true,
  },
  {
    name: "leo",
    display: "Leo",
    kind: "human",
    canRemove: false,
  },
];

const ALL_CAPABILITIES: ChannelAdminViewProps["capabilities"] = {
  manageAccess: true,
  manageMembers: true,
  manageSafety: true,
  archive: true,
};

function render(
  overrides: Partial<ChannelAdminViewProps> = {},
  options?: Parameters<typeof create>[1],
): ReactTestRenderer {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <ChannelAdminView
          slug="alpha"
          visibility="private"
          archived={false}
          capabilities={ALL_CAPABILITIES}
          members={MEMBERS}
          safetyControls={<button type="button">SAFETY_CONTROL</button>}
          {...overrides}
        />
      </LocaleProvider>,
      options,
    );
  });
  return renderer!;
}

function text(node: ReactTestRenderer | ReactTestInstance): string {
  const output: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string" || typeof value === "number") {
      output.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value !== null && typeof value === "object" && "children" in value) {
      walk((value as { children?: unknown }).children);
    }
  };
  walk("toJSON" in node ? node.toJSON() : node);
  return output.join(" ");
}

function tabs(r: ReactTestRenderer): ReactTestInstance[] {
  return r.root.findAll((node) => node.props.role === "tab");
}

function panels(r: ReactTestRenderer): ReactTestInstance[] {
  return r.root.findAll((node) => node.props.role === "tabpanel");
}

function select(r: ReactTestRenderer, section: ChannelAdminSection): void {
  const tab = tabs(r).find((node) => node.props["data-admin-section"] === section)!;
  act(() => tab.props.onClick());
}

describe("ChannelAdminView structure", () => {
  test("groups administration into four linked, persistent sections", () => {
    const r = render();
    const allTabs = tabs(r);
    const allPanels = panels(r);

    expect(allTabs).toHaveLength(4);
    expect(allPanels).toHaveLength(4);
    expect(allTabs.map((node) => node.props["data-admin-section"])).toEqual([
      "access",
      "members",
      "safety",
      "lifecycle",
    ]);
    expect(allTabs.map((node) => node.props["aria-selected"])).toEqual([true, false, false, false]);
    expect(allPanels.map((node) => node.props.hidden)).toEqual([false, true, true, true]);
    allTabs.forEach((tab, index) => {
      expect(tab.props["aria-controls"]).toBe(allPanels[index]!.props.id);
      expect(allPanels[index]!.props["aria-labelledby"]).toBe(tab.props.id);
    });

    const all = text(r);
    expect(all).toContain("Channel administration");
    expect(all).toContain("2 members");
    expect(all).toContain("private");
  });

  test("supports roving keyboard navigation and reports section changes", () => {
    const changed: ChannelAdminSection[] = [];
    let focusedSection: ChannelAdminSection | null = null;
    const r = render(
      { onSectionChange: (section) => changed.push(section) },
      {
        createNodeMock: (element) => {
          const props = element.props as Record<string, unknown>;
          if (element.type !== "button" || props.role !== "tab") return null;
          return {
            focus: () => {
              focusedSection = props["data-admin-section"] as ChannelAdminSection;
            },
          };
        },
      },
    );
    let allTabs = tabs(r);

    let prevented = false;
    act(() => allTabs[0]!.props.onKeyDown({
      key: "ArrowLeft",
      preventDefault: () => { prevented = true; },
    }));
    expect(prevented).toBe(true);
    expect(focusedSection).toBe("lifecycle");
    expect(tabs(r).map((node) => node.props.tabIndex)).toEqual([-1, -1, -1, 0]);

    allTabs = tabs(r);
    act(() => allTabs[3]!.props.onKeyDown({ key: "Home", preventDefault: () => {} }));
    expect(focusedSection).toBe("access");
    act(() => tabs(r)[0]!.props.onKeyDown({ key: "End", preventDefault: () => {} }));
    expect(focusedSection).toBe("lifecycle");
    expect(changed).toEqual(["lifecycle", "access", "lifecycle"]);
  });

  test("supports a controlled section for deep links and back navigation", () => {
    function ControlledView() {
      const [section, setSection] = useState<ChannelAdminSection>("access");
      return (
        <>
          <button type="button" data-show-safety onClick={() => setSection("safety")}>
            show safety
          </button>
          <ChannelAdminView
            slug="alpha"
            visibility="private"
            archived={false}
            capabilities={ALL_CAPABILITIES}
            members={MEMBERS}
            activeSection={section}
            onSectionChange={setSection}
            safetyControls={<button type="button">SAFETY_CONTROL</button>}
          />
        </>
      );
    }

    act(() => {
      renderer = create(
        <LocaleProvider>
          <ControlledView />
        </LocaleProvider>,
      );
    });
    const r = renderer!;
    act(() => r.root.findByProps({ "data-show-safety": true }).props.onClick());
    expect(tabs(r).map((node) => node.props["aria-selected"])).toEqual([false, false, true, false]);
    select(r, "members");
    expect(tabs(r).map((node) => node.props["aria-selected"])).toEqual([false, true, false, false]);
  });

  test("keeps embedded control state while switching sections", () => {
    function StatefulControl() {
      const [draft, setDraft] = useState("");
      return (
        <input
          aria-label="invite draft"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      );
    }

    const r = render({ safetyControls: <StatefulControl /> });
    select(r, "safety");
    const input = r.root.findByProps({ "aria-label": "invite draft" });
    act(() => input.props.onChange({ currentTarget: { value: "pending-code" } }));
    select(r, "members");
    select(r, "safety");
    expect(r.root.findByProps({ "aria-label": "invite draft" }).props.value).toBe("pending-code");
  });
});

describe("ChannelAdminView actions", () => {
  test("routes access editors through callbacks instead of embedding nested dialogs", () => {
    const calls: string[] = [];
    const r = render({
      onEditAccess: () => calls.push("access"),
      onManageInvitations: () => calls.push("invitations"),
    });
    const buttons = panels(r)[0]!.findAllByType("button");
    act(() => buttons[0]!.props.onClick());
    act(() => buttons[1]!.props.onClick());
    expect(calls).toEqual(["access", "invitations"]);
  });

  test("mounts access and invitation workflows inline when the parent supplies module controls", () => {
    const calls: string[] = [];
    const r = render({
      accessControls: <button type="button" data-inline-access>INLINE_ACCESS</button>,
      invitationControls: <section data-inline-invitations>INLINE_INVITATIONS</section>,
      onEditAccess: () => calls.push("legacy-access"),
      onManageInvitations: () => calls.push("legacy-invitations"),
    });
    const access = panels(r)[0]!;
    expect(access.findByProps({ "data-inline-access": true })).toBeTruthy();
    expect(access.findByProps({ "data-inline-invitations": true })).toBeTruthy();
    expect(text(access)).not.toContain("Edit access");
    expect(calls).toEqual([]);
  });

  test("shows an explicit unavailable state when authority exists but an action is not wired", () => {
    const r = render({ safetyControls: undefined });
    expect(text(panels(r)[0]!)).toContain("not connected");
    select(r, "safety");
    expect(text(panels(r)[2]!)).toContain("not connected");
    select(r, "lifecycle");
    expect(r.root.findAllByProps({ "data-admin-archive": true })).toHaveLength(0);
    expect(text(panels(r)[3]!)).toContain("not connected");
  });

  test("routes member view/remove callbacks by stable member name", () => {
    const opened: string[] = [];
    const removed: string[] = [];
    const r = render({
      onOpenMember: (name) => opened.push(name),
      onRemoveMember: (name) => removed.push(name),
    });
    select(r, "members");

    const openWorker = r.root.findByProps({ "data-admin-member-open": "worker-1" });
    const removeWorker = r.root.findByProps({ "data-admin-member-remove": "worker-1" });
    act(() => openWorker.props.onClick());
    act(() => removeWorker.props.onClick());

    expect(opened).toEqual(["worker-1"]);
    expect(removed).toEqual(["worker-1"]);
    expect(r.root.findAllByProps({ "data-admin-member-remove": "leo" })).toHaveLength(0);
  });

  test("marks a session-removed row and routes re-add with its account and exact name", () => {
    const removedMember: ChannelAdminViewProps["members"][number] = {
      name: "former-agent",
      display: "Former Agent",
      kind: "agent",
      account: "owner@example.com",
      detail: "API worker",
      canRemove: false,
      removed: true,
      canRestore: true,
    };
    const restored: ChannelAdminViewProps["members"][number][] = [];
    const r = render({
      members: [removedMember],
      onOpenMember: () => {},
      onRemoveMember: () => {},
      onRestoreMember: (member) => restored.push(member),
    });
    select(r, "members");

    expect(text(panels(r)[1]!)).toContain("Removed");
    expect(text(r)).toContain("0 members");
    expect(r.root.findAllByProps({ "data-admin-member-open": "former-agent" })).toHaveLength(0);
    expect(r.root.findAllByProps({ "data-admin-member-remove": "former-agent" })).toHaveLength(0);

    const restore = r.root.findByProps({ "data-admin-member-restore": "former-agent" });
    act(() => restore.props.onClick());
    expect(restored).toEqual([removedMember]);
    expect(restored[0]).toMatchObject({
      account: "owner@example.com",
      name: "former-agent",
    });
  });

  test("member View and Back preserve the Members section and restore the exact trigger", () => {
    let focusedBack = 0;
    let focusedMember: string | null = null;

    function MemberDetailRoute() {
      const [member, setMember] = useState<string | null>(null);
      return (
        <LocaleProvider>
          <ChannelAdminView
            slug="alpha"
            visibility="private"
            archived={false}
            capabilities={ALL_CAPABILITIES}
            members={MEMBERS}
            initialSection="members"
            detail={member === null ? null : <article data-member-detail={member}>DETAIL</article>}
            detailBackLabel="Back to members"
            onBackFromDetail={() => setMember(null)}
            onOpenMember={setMember}
          />
        </LocaleProvider>
      );
    }

    act(() => {
      renderer = create(<MemberDetailRoute />, {
        createNodeMock: (element) => {
          const props = element.props as Record<string, unknown>;
          if (element.type === "button" && typeof props["data-admin-member-open"] === "string") {
            return {
              focus: () => {
                focusedMember = props["data-admin-member-open"] as string;
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
    const openWorker = r.root.findByProps({ "data-admin-member-open": "worker-1" });
    act(() => openWorker.props.onClick());

    expect(focusedBack).toBe(1);
    expect(r.root.findByProps({ role: "tablist" }).props.hidden).toBe(true);
    expect(panels(r).every((panel) => panel.props.hidden)).toBe(true);
    expect(r.root.findByProps({ "data-member-detail": "worker-1" })).toBeTruthy();

    const back = r.root.findAllByType("button")
      .find((button) => String(button.props.className).includes("team-blog-detail-back"))!;
    act(() => back.props.onClick());

    expect(tabs(r).map((tab) => tab.props["aria-selected"])).toEqual([false, true, false, false]);
    expect(panels(r).map((panel) => panel.props.hidden)).toEqual([true, false, true, true]);
    expect(focusedMember).toBe("worker-1");
  });

  test("removes a deleted member row when the parent publishes the updated roster", () => {
    const sharedProps: ChannelAdminViewProps = {
      slug: "alpha",
      visibility: "private",
      archived: false,
      capabilities: ALL_CAPABILITIES,
      members: MEMBERS,
      activeSection: "members",
      onRemoveMember: () => {},
    };
    const r = render(sharedProps);
    expect(r.root.findAllByProps({ "data-admin-member-remove": "worker-1" })).toHaveLength(1);

    act(() => {
      renderer!.update(
        <LocaleProvider>
          <ChannelAdminView
            {...sharedProps}
            members={MEMBERS.filter((member) => member.name !== "worker-1")}
          />
        </LocaleProvider>,
      );
    });

    expect(r.root.findAllByProps({ "data-admin-member-remove": "worker-1" })).toHaveLength(0);
    expect(text(panels(r)[1]!)).not.toContain("Worker One");
    expect(text(r)).toContain("1 member");
  });

  test("disables member mutation while another removal is in flight", () => {
    const r = render({
      removingMember: "worker-1",
      onRemoveMember: () => {},
    });
    select(r, "members");
    const button = r.root.findByProps({ "data-admin-member-remove": "worker-1" });
    expect(button.props.disabled).toBe(true);
    expect(text(button)).toContain("Removing");
  });

  test("routes archive through the parent callback and exposes errors", () => {
    let archives = 0;
    const r = render({
      lifecycleError: "archive failed",
      onArchive: () => { archives += 1; },
    });
    select(r, "lifecycle");
    const archive = r.root.findByProps({ "data-admin-archive": true });
    act(() => archive.props.onClick());
    expect(archives).toBe(1);
    expect(r.root.findAll((node) => node.props.role === "alert").map(text)).toContain("archive failed");
  });

  test("keeps async action errors visible when their owning panel is hidden", () => {
    const r = render({
      memberError: "remove failed",
      lifecycleError: "archive failed",
    });
    expect(panels(r)[0]!.props.hidden).toBe(false);
    expect(r.root.findAll((node) => node.props.role === "alert").map(text)).toEqual([
      "remove failed archive failed",
    ]);
  });

  test("routes the optional close action without owning modal behavior", () => {
    let closes = 0;
    const r = render({ onClose: () => { closes += 1; } });
    const close = r.root
      .findAllByType("button")
      .find((node) => String(node.props.className).includes("team-blog-close"))!;
    act(() => close.props.onClick());
    expect(closes).toBe(1);
  });
});

describe("ChannelAdminView permission boundaries", () => {
  test("read-only viewers see current state but not injected mutation controls", () => {
    const r = render({
      capabilities: {
        manageAccess: false,
        manageMembers: false,
        manageSafety: false,
        archive: false,
      },
      onEditAccess: () => {},
      onManageInvitations: () => {},
      onRemoveMember: () => {},
      onArchive: () => {},
    });
    const all = text(r);
    expect(all).toContain("Current access: private");
    expect(all).toContain("Only channel moderators");
    expect(all).not.toContain("Change access");
    expect(all).not.toContain("Manage invitations");
    expect(all).not.toContain("SAFETY_CONTROL");

    select(r, "members");
    expect(r.root.findByProps({ "data-admin-member-remove": "worker-1" }).props.disabled).toBe(true);

    act(() => {
      renderer!.update(
        <LocaleProvider>
          <ChannelAdminView
            slug="alpha"
            visibility="private"
            archived={false}
            capabilities={{
              manageAccess: false,
              manageMembers: false,
              manageSafety: false,
              archive: false,
            }}
            members={[{
              name: "former-agent",
              display: "Former Agent",
              kind: "agent",
              account: "owner@example.com",
              canRemove: false,
              removed: true,
              canRestore: true,
            }]}
            onRestoreMember={() => {}}
          />
        </LocaleProvider>,
      );
    });
    expect(r.root.findAllByProps({ "data-admin-member-restore": "former-agent" })).toHaveLength(0);

    select(r, "lifecycle");
    expect(r.root.findByProps({ "data-admin-archive": true }).props.disabled).toBe(true);
  });

  test("archived channels hide write controls and present read-only lifecycle state", () => {
    const r = render({
      archived: true,
      lifecycleError: "old error",
      onEditAccess: () => {},
      onManageInvitations: () => {},
    });
    expect(text(r)).not.toContain("Change access");
    expect(text(r)).not.toContain("Manage invitations");
    expect(text(r)).not.toContain("SAFETY_CONTROL");
    expect(text(r)).toContain("Invitations are closed");

    select(r, "lifecycle");
    expect(r.root.findAllByProps({ "data-admin-archive": true })).toHaveLength(0);
    expect(text(r)).toContain("Archived");
    expect(r.root.findAll((node) => node.props.role === "alert").map(text)).toContain("old error");
  });
});
