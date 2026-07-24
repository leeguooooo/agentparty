import type { MsgFrame } from "@agentparty/shared";
import { matchesAgentFilter, type AgentFilter } from "./filters";

export interface MessageNavigationElement {
  scrollIntoView(options?: ScrollIntoViewOptions): void;
  focus(options?: FocusOptions): void;
  classList: {
    add(token: string): void;
    remove(token: string): void;
  };
}

export interface ResolvedMessageNavigationTarget {
  target: MsgFrame;
  messagesToMerge: MsgFrame[];
}

/**
 * Resolves a message jump against the local window first, then asks the
 * caller for an anchored history window when the target has fallen outside
 * the in-memory cap.
 */
export async function resolveMessageNavigationTarget(input: {
  messages: MsgFrame[];
  seq: number;
  loadAround: (seq: number) => Promise<MsgFrame[]>;
}): Promise<ResolvedMessageNavigationTarget | null> {
  const loaded = input.messages.find((message) => message.seq === input.seq);
  if (loaded !== undefined) {
    return { target: loaded, messagesToMerge: [] };
  }

  const around = await input.loadAround(input.seq);
  const target = around.find((message) => message.seq === input.seq);
  return target === undefined ? null : { target, messagesToMerge: around };
}

/**
 * Completes a successful message jump after React has committed the target.
 * Focus follows the scroll so keyboard and screen-reader users arrive at the
 * same message as sighted pointer users.
 */
export function focusMessageNavigationTarget(
  element: MessageNavigationElement,
  announce: () => void,
  scheduleHighlightRemoval: (callback: () => void, delayMs: number) => unknown,
): void {
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.classList.add("msg-jump-highlight");
  element.focus({ preventScroll: true });
  announce();
  scheduleHighlightRemoval(() => element.classList.remove("msg-jump-highlight"), 1200);
}

export type LoadedMessageNavigationPlan =
  | { found: false }
  | {
      found: true;
      target: MsgFrame;
      clearAgentFilter: boolean;
      changeCompletionView: boolean;
      preserveCurrentView: boolean;
    };

/**
 * Plans navigation inside the currently loaded message window.
 *
 * Search, mentions, decisions and completion links all use the same rules:
 * reveal a target hidden by timeline filters, preserve those filters for an
 * explicit restore action, and report an unloaded target instead of silently
 * pretending the jump succeeded.
 */
export function planLoadedMessageNavigation(input: {
  messages: MsgFrame[];
  seq: number;
  agentFilter: AgentFilter;
  completionOnly: boolean;
  desiredCompletionOnly: boolean;
}): LoadedMessageNavigationPlan {
  const target = input.messages.find((message) => message.seq === input.seq);
  if (target === undefined) return { found: false };

  const clearAgentFilter = !matchesAgentFilter(target.sender, input.agentFilter);
  const changeCompletionView = input.completionOnly !== input.desiredCompletionOnly;
  return {
    found: true,
    target,
    clearAgentFilter,
    changeCompletionView,
    preserveCurrentView:
      clearAgentFilter || (input.completionOnly && !input.desiredCompletionOnly),
  };
}
