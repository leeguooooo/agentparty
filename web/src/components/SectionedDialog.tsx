import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

export interface SectionedDialogSection<SectionId extends string = string> {
  id: SectionId;
  label: string;
  content: ReactNode;
}

interface Props<SectionId extends string> {
  idPrefix: string;
  title: string;
  closeLabel: string;
  navigationLabel: string;
  sections: readonly SectionedDialogSection<SectionId>[];
  initialSection: SectionId;
  onClose(): void;
  onActiveSectionChange?(section: SectionId): void;
  restoreFocusOnUnmount?: boolean;
  keepMounted?: boolean;
  panelClassName?: string;
}

type TabOrientation = "horizontal" | "vertical";

function nextTabIndex(
  key: string,
  current: number,
  count: number,
  orientation: TabOrientation,
): number | null {
  if (count === 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (
    (orientation === "vertical" && key === "ArrowDown")
    || (orientation === "horizontal" && key === "ArrowRight")
  ) return (current + 1) % count;
  if (
    (orientation === "vertical" && key === "ArrowUp")
    || (orientation === "horizontal" && key === "ArrowLeft")
  ) return (current - 1 + count) % count;
  return null;
}

function initialTabOrientation(): TabOrientation {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "vertical";
  return window.matchMedia("(max-width: 760px)").matches ? "horizontal" : "vertical";
}

/**
 * Shared interaction shell for settings-like control surfaces.
 *
 * It owns one modal, one focus trap, and one section-navigation model. Feature
 * modules only provide their content; they do not create nested dialogs.
 */
export function SectionedDialog<SectionId extends string>({
  idPrefix,
  title,
  closeLabel,
  navigationLabel,
  sections,
  initialSection,
  onClose,
  onActiveSectionChange,
  restoreFocusOnUnmount = true,
  keepMounted = true,
  panelClassName = "",
}: Props<SectionId>) {
  const fallbackSection = sections[0]?.id ?? initialSection;
  const [activeSection, setActiveSection] = useState<SectionId>(
    sections.some((section) => section.id === initialSection) ? initialSection : fallbackSection,
  );
  const [tabOrientation, setTabOrientation] = useState<TabOrientation>(initialTabOrientation);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<SectionId, HTMLButtonElement>());
  const onCloseRef = useRef(onClose);
  const onActiveSectionChangeRef = useRef(onActiveSectionChange);
  const restoreFocusOnUnmountRef = useRef(restoreFocusOnUnmount);
  onCloseRef.current = onClose;
  onActiveSectionChangeRef.current = onActiveSectionChange;
  restoreFocusOnUnmountRef.current = restoreFocusOnUnmount;

  useEffect(() => {
    if (sections.some((section) => section.id === activeSection)) return;
    setActiveSection(fallbackSection);
    onActiveSectionChangeRef.current?.(fallbackSection);
  }, [activeSection, fallbackSection, sections]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 760px)");
    const syncOrientation = () => setTabOrientation(media.matches ? "horizontal" : "vertical");
    syncOrientation();
    media.addEventListener?.("change", syncOrientation);
    return () => media.removeEventListener?.("change", syncOrientation);
  }, []);

  useEffect(() => {
    const doc = typeof document === "undefined" ? null : document;
    const previouslyFocused = (doc?.activeElement ?? null) as HTMLElement | null;
    const focusables = (): HTMLElement[] => {
      const panel = panelRef.current;
      if (panel === null || typeof panel.querySelectorAll !== "function") return [];
      return Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) => element.tabIndex >= 0 && element.closest?.("[hidden]") === null,
      );
    };

    (tabRefs.current.get(activeSection) ?? focusables()[0] ?? panelRef.current)?.focus?.();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      const panel = panelRef.current;
      if (items.length === 0) {
        event.preventDefault();
        panel?.focus?.();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = (doc?.activeElement ?? null) as HTMLElement | null;
      const activeIsInsidePanel = active !== null
        && active.isConnected !== false
        && (active === panel || panel?.contains(active) === true);
      if (!activeIsInsidePanel) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (restoreFocusOnUnmountRef.current) previouslyFocused?.focus?.();
    };
    // The dialog's focus lifecycle belongs to mount/unmount. Changing a parent
    // callback identity must not tear down and re-arm the trap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectFromKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    const nextIndex = nextTabIndex(event.key, currentIndex, sections.length, tabOrientation);
    if (nextIndex === null) return;
    event.preventDefault();
    const next = sections[nextIndex];
    if (next === undefined) return;
    setActiveSection(next.id);
    onActiveSectionChangeRef.current?.(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  const selectSection = (section: SectionId) => {
    setActiveSection(section);
    onActiveSectionChangeRef.current?.(section);
  };

  const titleId = `${idPrefix}-title`;
  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div
        className={`settings-panel${panelClassName ? ` ${panelClassName}` : ""}`}
        ref={panelRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-head">
          <h2 className="settings-title" id={titleId}>{title}</h2>
          <button type="button" className="settings-close" aria-label={closeLabel} onClick={onClose}>
            ×
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label={navigationLabel}>
            <div className="settings-tabs" role="tablist" aria-orientation={tabOrientation}>
              {sections.map((section, index) => {
                const active = section.id === activeSection;
                return (
                  <button
                    key={section.id}
                    ref={(node) => {
                      if (node === null) tabRefs.current.delete(section.id);
                      else tabRefs.current.set(section.id, node);
                    }}
                    type="button"
                    id={`${idPrefix}-tab-${section.id}`}
                    className={`settings-tab${active ? " is-active" : ""}`}
                    role="tab"
                    aria-selected={active}
                    aria-controls={`${idPrefix}-panel-${section.id}`}
                    tabIndex={active ? 0 : -1}
                    onClick={() => selectSection(section.id)}
                    onKeyDown={(event) => selectFromKeyboard(event, index)}
                  >
                    {section.label}
                  </button>
                );
              })}
            </div>
          </nav>

          <div className="settings-content">
            {sections.map((section) => {
              const active = section.id === activeSection;
              return (
                <section
                  key={section.id}
                  id={`${idPrefix}-panel-${section.id}`}
                  className="settings-module"
                  role="tabpanel"
                  aria-labelledby={`${idPrefix}-tab-${section.id}`}
                  hidden={!active}
                >
                  {(keepMounted || active) && section.content}
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
