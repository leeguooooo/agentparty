// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { TaskRecord } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";

// Channel.tsx 会 import dompurify（经 markdown 链路）——测试环境里存桩掉。
mock.module("dompurify", () => ({
  default: { addHook: () => {}, sanitize: (value: string) => value },
}));

const { TaskLedgerPanel, TeamPanel, isTaskLedgerStatusNote } = await import("./Channel");

// #204 P1②：判定哪些 system status 触发任务台账刷新（多客户端一致性）。
describe("isTaskLedgerStatusNote (#204 P1②)", () => {
  test("matches worker-broadcast task status notes", () => {
    expect(isTaskLedgerStatusNote("task #12 in_progress")).toBe(true);
    expect(isTaskLedgerStatusNote("task #3 blocked")).toBe(true);
    expect(isTaskLedgerStatusNote("task #1 done")).toBe(true);
  });
  test("ignores non-task and lookalike notes (no false refetch)", () => {
    expect(isTaskLedgerStatusNote("charter updated to rev 5")).toBe(false);
    expect(isTaskLedgerStatusNote("worker-a working on task #5")).toBe(false); // 必须以 task # 开头
    expect(isTaskLedgerStatusNote("task #x oops")).toBe(false); // 需数字 id
    expect(isTaskLedgerStatusNote("task #12")).toBe(false); // 需 state 段（后随空格）
  });
});

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    type: "task",
    id: 1,
    channel: "demo",
    title: "wire the task panel",
    desc: null,
    state: "backlog",
    assignee: null,
    created_by: "human-a",
    created_by_kind: "human",
    priority: 0,
    labels: [],
    parent_id: null,
    anchor_seqs: [],
    completion_artifact: null,
    workflow_id: null,
    scope: [],
    blocked_reason: null,
    external_ref: null,
    created_at: 0,
    updated_at: 0,
    completed_at: null,
    ...overrides,
  };
}

type PanelProps = Parameters<typeof TaskLedgerPanel>[0];
type NodeMockFactory = NonNullable<NonNullable<Parameters<typeof create>[1]>["createNodeMock"]>;

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    tasks: [task()],
    loading: false,
    error: null,
    canWrite: true,
    busyTaskId: null,
    actionError: null,
    creating: false,
    createError: null,
    onRefresh: () => {},
    onSetState: () => {},
    onAssign: () => {},
    onReview: () => {},
    onCreateTask: async () => true,
    ...overrides,
  };
}

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "window");
});

function render(
  locale: "en" | "zh",
  props: PanelProps,
  createNodeMock?: NodeMockFactory,
): ReactTestRenderer {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage({ ap_locale: locale }),
  });
  let r!: ReactTestRenderer;
  void act(() => {
    r = create(
      <LocaleProvider><TaskLedgerPanel {...props} /></LocaleProvider>,
      createNodeMock === undefined ? undefined : { createNodeMock },
    );
  });
  renderer = r;
  return r;
}

function allText(r: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object" && "children" in (node as Record<string, unknown>)) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(r.toJSON());
  return out.join(" ");
}

function findByAria(r: ReactTestRenderer, label: string) {
  return r.root.find((n) => n.props["aria-label"] === label);
}

// #504 博客风：任务卡默认折叠，详情/动作点开才渲染。测试要验动作/详情前先展开所有卡。
async function expandCards(r: ReactTestRenderer) {
  const toggles = r.root.findAll((n) => n.props.className === "task-card-toggle");
  for (const toggle of toggles) {
    await act(async () => { toggle.props.onClick(); });
  }
}

describe("TaskLedgerPanel i18n", () => {
  test("renders Chinese action + column labels when locale is zh", async () => {
    const r = render("zh", baseProps());
    await expandCards(r);
    const text = allText(r);
    expect(text).toContain("认领"); // Claim
    expect(text).toContain("阻塞"); // Block
    expect(text).toContain("新建任务"); // New task
    expect(text).toContain("待办"); // backlog state label
    expect(text).not.toContain("Claim");
    expect(text).not.toContain("New task");
  });

  test("renders English labels when locale is en", async () => {
    const r = render("en", baseProps());
    await expandCards(r);
    const text = allText(r);
    expect(text).toContain("Claim");
    expect(text).toContain("New task");
  });
});

describe("TaskLedgerPanel new-task entry", () => {
  test("opening the composer and submitting fires onCreateTask exactly once with the typed values", async () => {
    const calls: Array<{ title: string; desc: string }> = [];
    const onCreateTask = mock(async (input: { title: string; desc: string }) => {
      calls.push(input);
      return true;
    });
    const r = render("en", baseProps({ onCreateTask }));

    // open composer
    await act(async () => {
      findByAria(r, "New task").props.onClick();
    });
    // type a title
    await act(async () => {
      findByAria(r, "New task title").props.onChange({ currentTarget: { value: "ship it" } });
    });
    // submit the form
    await act(async () => {
      await r.root.find((n) => n.props.className === "task-new-form").props.onSubmit({ preventDefault() {} });
    });

    expect(onCreateTask).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ title: "ship it", desc: "", attachments: [] }]);
  });

  test("submitting with an empty title never calls onCreateTask", async () => {
    const onCreateTask = mock(async () => true);
    const r = render("en", baseProps({ onCreateTask }));

    await act(async () => {
      findByAria(r, "New task").props.onClick();
    });
    await act(async () => {
      await r.root.find((n) => n.props.className === "task-new-form").props.onSubmit({ preventDefault() {} });
    });

    expect(onCreateTask).toHaveBeenCalledTimes(0);
  });
});

describe("TaskLedgerPanel inline rejection (#357)", () => {
  test("reject opens a textarea and submits the trimmed reason", async () => {
    const reviews: Array<{ id: number; action: string; reason?: string }> = [];
    const reviewable = task({ state: "needs_review", completion_artifact: {}, anchor_seqs: [42] });
    const r = render("en", baseProps({
      tasks: [reviewable],
      onReview: (item, action, reason) => reviews.push({ id: item.id, action, reason }),
    }));

    await expandCards(r);
    await act(async () => {
      r.root.find((n) => n.type === "button" && n.children.includes("Reject")).props.onClick();
    });
    const reason = findByAria(r, "Reject reason for task 1");
    await act(async () => reason.props.onChange({ currentTarget: { value: "  add test evidence  " } }));
    await act(async () => r.root.find((n) => n.props.className === "task-action-btn task-reject-confirm").props.onClick());

    expect(reviews).toEqual([{ id: 1, action: "reject", reason: "add test evidence" }]);
  });

  test("cancel closes the rejection editor without reviewing", async () => {
    const onReview = mock(() => undefined);
    const reviewable = task({ state: "needs_review", completion_artifact: {}, anchor_seqs: [42] });
    const r = render("en", baseProps({ tasks: [reviewable], onReview }));
    await expandCards(r);
    await act(async () => r.root.find((n) => n.type === "button" && n.children.includes("Reject")).props.onClick());
    await act(async () => r.root.find((n) => n.props.className === "task-action-btn task-reject-cancel").props.onClick());
    expect(r.root.findAll((n) => n.props.className === "task-new-form task-reject-form")).toHaveLength(0);
    expect(onReview).toHaveBeenCalledTimes(0);
  });
});

describe("TeamPanel touch details (#357)", () => {
  test("member detail is a button that expands the title content inline", async () => {
    const member = {
      name: "worker-a", parentAgent: "lead", rootAgent: "lead", teamId: "squad-a", depth: 1,
      state: "working", role: "worker" as const, residency: "supervised" as const, active: true, connected: true,
      lastSeen: 1_700_000_000_000, expiresAt: null,
    };
    let r!: ReactTestRenderer;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage({ ap_locale: "en" }) });
    await act(async () => {
      r = create(<LocaleProvider><TeamPanel teams={[{
        key: "lead::squad-a", rootAgent: "lead", teamId: "squad-a", parentAgents: ["lead"],
        activeCount: 1, staleCount: 0, memberCount: 1, maxDepth: 1, residency: "supervised",
        expiresAt: null, lastSeen: member.lastSeen, frontAgent: null, members: [member],
      }]} /></LocaleProvider>);
    });
    renderer = r;
    const button = r.root.find((n) => n.type === "button" && n.props.className.includes("team-member"));
    expect(button.props["aria-expanded"]).toBe(false);
    await act(async () => button.props.onClick());
    expect(button.props["aria-expanded"]).toBe(true);
    expect(allText(r)).toContain("parent: lead");
    expect(allText(r)).toContain("residency: supervised");
  });
});

// #271(a)：按受理人筛选看板。
describe("TaskLedgerPanel assignee filter (#271)", () => {
  const filterTasks = () => [
    task({ id: 1, title: "alpha-task", assignee: { name: "worker-a", kind: "agent" } }),
    task({ id: 2, title: "bravo-task", assignee: { name: "worker-b", kind: "agent" }, state: "in_progress" }),
    task({ id: 3, title: "charlie-task" }),
  ];

  test("dropdown lists each assignee once and filters the board", async () => {
    const r = render("en", baseProps({ tasks: filterTasks() }));
    const select = findByAria(r, "Filter by assignee");
    const values = select.findAllByType("option").map((o) => o.props.value);
    expect(values).toEqual(["all", "__unassigned__", "worker-a", "worker-b"]);

    await act(async () => {
      select.props.onChange({ currentTarget: { value: "worker-a" } });
    });
    let text = allText(r);
    expect(text).toContain("alpha-task");
    expect(text).not.toContain("bravo-task");
    expect(text).not.toContain("charlie-task");

    await act(async () => {
      findByAria(r, "Filter by assignee").props.onChange({ currentTarget: { value: "__unassigned__" } });
    });
    text = allText(r);
    expect(text).toContain("charlie-task");
    expect(text).not.toContain("alpha-task");
  });

  test("dropdown stays hidden while no task has an assignee", () => {
    const r = render("en", baseProps());
    expect(r.root.findAll((n) => n.props["aria-label"] === "Filter by assignee")).toHaveLength(0);
  });
});

// #271(b)：指派输入框接 datalist，候选来自频道身份。
describe("TaskLedgerPanel assignee datalist (#271)", () => {
  test("assign input points at a datalist fed by channel identities", async () => {
    const identities = [
      { name: "worker-a", display: "worker-a · agent" },
      { name: "human-b", display: "human-b · human" },
    ];
    const r = render("en", baseProps({ identities }));
    await expandCards(r);
    const input = findByAria(r, "Assign task 1");
    expect(input.props.list).toBe("task-assignee-targets");
    const datalist = r.root.find((n) => n.type === "datalist");
    expect(datalist.props.id).toBe("task-assignee-targets");
    expect(datalist.findAllByType("option").map((o) => o.props.value)).toEqual(["worker-a", "human-b"]);
  });

  test("datalist renders empty (not crashing) without identities", () => {
    const r = render("en", baseProps());
    const datalist = r.root.find((n) => n.type === "datalist");
    expect(datalist.findAllByType("option")).toHaveLength(0);
  });
});

// #271(d)：展开/收起切换宽度 class。
describe("TaskLedgerPanel expanded view (#271)", () => {
  test("toggle flips the --expanded class and aria-pressed", async () => {
    const r = render("en", baseProps());
    const section = r.root.find((n) => n.props["aria-label"] === "channel tasks");
    expect(section.props.className).toBe("task-ledger-panel");

    const toggle = findByAria(r, "Toggle task panel width");
    expect(toggle.props["aria-pressed"]).toBe(false);
    await act(async () => { toggle.props.onClick(); });

    expect(r.root.find((n) => n.props["aria-label"] === "channel tasks").props.className)
      .toBe("task-ledger-panel task-ledger-panel--expanded");
    // 博客风把展开钮改成图标（⇱/⇲），可见状态由 aria-pressed 表达（文案断言已上移到 aria）。
    expect(findByAria(r, "Toggle task panel width").props["aria-pressed"]).toBe(true);

    await act(async () => { findByAria(r, "Toggle task panel width").props.onClick(); });
    expect(r.root.find((n) => n.props["aria-label"] === "channel tasks").props.className)
      .toBe("task-ledger-panel");
  });
});

// #271(c)：点击任务卡标题进入台账内详情路由（完整 title/desc/meta）。
describe("TaskLedgerPanel task detail (#271)", () => {
  test("uses one in-panel route, focuses Back, and Escape restores the task trigger", async () => {
    const detailed = task({
      id: 7,
      title: "detail-task",
      desc: "long description body",
      assignee: { name: "worker-a", kind: "agent" },
      labels: ["infra"],
      solution: {
        key: "demo/11111111-1111-1111-1111-111111111111/solution.html",
        filename: "solution.html",
        content_type: "text/html",
        size: 123,
        url: "/api/channels/demo/attachments/11111111-1111-1111-1111-111111111111/solution.html",
      },
    });
    let focused = "";
    const titleNode = { isConnected: true, focus: () => { focused = "title"; } };
    const backNode = { isConnected: true, focus: () => { focused = "back"; } };
    const fakeWindow = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
    const r = render("en", baseProps({ tasks: [detailed] }), (element) => {
      const props = element.props as Record<string, unknown>;
      if (props.className === "task-card-title") return titleNode;
      if (props.className === "d-btn task-detail-close") return backNode;
      return {};
    });
    expect(r.root.findAll((n) => n.props["aria-label"] === "task 7 details")).toHaveLength(0);
    await expandCards(r); // 博客风：卡片内联 solution 展开后才渲染
    expect(r.root.findAll((n) => n.props.className === "task-solution")).toHaveLength(1);
    expect(allText(r)).toContain("solution.html");

    await act(async () => { findByAria(r, "Open task 7 details").props.onClick(); });
    findByAria(r, "task 7 details");
    expect(focused).toBe("back");
    expect(r.root.findAll((n) => n.props.role === "dialog")).toHaveLength(0);
    expect(r.root.findAll((n) => n.props["aria-modal"] === true)).toHaveLength(0);
    expect(r.root.findAll((n) => n.props.className === "task-board")).toHaveLength(0);
    const text = allText(r);
    expect(text).toContain("long description body");
    expect(text).toContain("created by"); // meta 标签只出现在详情里
    expect(text).toContain("human-a · human");
    expect(text).toContain("@worker-a · agent");
    expect(text).toContain("Solution");
    expect(text).toContain("solution.html");

    let outerCloseCalls = 0;
    fakeWindow.addEventListener("keydown", (rawEvent) => {
      const event = rawEvent as Event & { key: string };
      if (event.key === "Escape" && !event.defaultPrevented) outerCloseCalls += 1;
    });
    const escape = new Event("keydown", { cancelable: true }) as Event & { key: string };
    escape.key = "Escape";
    await act(async () => {
      fakeWindow.dispatchEvent(escape);
    });
    expect(escape.defaultPrevented).toBe(true);
    expect(outerCloseCalls).toBe(0);
    expect(focused).toBe("title");
    expect(r.root.findAll((n) => n.props["aria-label"] === "task 7 details")).toHaveLength(0);
    expect(r.root.findAll((n) => n.props.className === "task-board")).toHaveLength(1);
  });

  test("detail route shows a placeholder when the task has no desc", async () => {
    const r = render("en", baseProps({ tasks: [task({ id: 9, desc: null })] }));
    expect(r.root.findAll((n) => typeof n.props.className === "string" && n.props.className.startsWith("task-solution"))).toHaveLength(0);
    await act(async () => { findByAria(r, "Open task 9 details").props.onClick(); });
    expect(allText(r)).toContain("No details");
    expect(r.root.find((n) => n.props.className === "d-btn task-detail-close").children.join("")).toContain("Back to tasks");
    expect(r.root.findAll((n) => typeof n.props.className === "string" && n.props.className.startsWith("task-solution"))).toHaveLength(0);
  });
});

describe("TaskLedgerPanel external task selection", () => {
  test("reveals, expands, scrolls and focuses the selected task without resetting filters", async () => {
    const first = task({ id: 1, title: "alpha-task", assignee: { name: "worker-a", kind: "agent" } });
    const selected = task({ id: 2, title: "bravo-task", state: "in_progress", assignee: { name: "worker-b", kind: "agent" } });
    const focusCalls: number[] = [];
    const scrollCalls: number[] = [];
    const initialProps = baseProps({ tasks: [first, selected] });
    const r = render("en", initialProps, (element) => {
      const props = element.props as Record<string, unknown>;
      if (element.type !== "li" || typeof props["data-task-id"] !== "number") return {};
      const id = props["data-task-id"] as number;
      return {
        focus: () => focusCalls.push(id),
        scrollIntoView: () => scrollCalls.push(id),
      };
    });

    const search = findByAria(r, "Search tasks");
    await act(async () => search.props.onChange({ currentTarget: { value: "alpha" } }));
    expect(allText(r)).toContain("alpha-task");
    expect(allText(r)).not.toContain("bravo-task");

    await act(async () => {
      r.update(
        <LocaleProvider>
          <TaskLedgerPanel {...initialProps} selectedTaskId={2} />
        </LocaleProvider>,
      );
    });

    expect(findByAria(r, "Search tasks").props.value).toBe("alpha");
    expect(allText(r)).toContain("alpha-task");
    expect(allText(r)).toContain("bravo-task");
    const selectedCard = r.root.findByProps({ "data-task-id": 2 });
    expect(selectedCard.props.className).toContain("task-card--open");
    expect(selectedCard.findByProps({ className: "task-card-toggle" }).props["aria-expanded"]).toBe(true);
    expect(scrollCalls).toEqual([2]);
    expect(focusCalls).toEqual([2]);
  });

  test("keeps a selected completed task reachable beyond the collapsed done limit", async () => {
    const completed = Array.from({ length: 8 }, (_, index) => task({
      id: index + 1,
      title: `completed-${index + 1}`,
      state: "done",
    }));
    const r = render("en", baseProps({ tasks: completed, selectedTaskId: 8 }));
    await act(async () => {});

    const selectedCard = r.root.findByProps({ "data-task-id": 8 });
    expect(selectedCard.props.className).toContain("task-card--open");
    expect(allText(r)).toContain("completed-8");
    expect(r.root.findAll((node) => (
      typeof node.props.className === "string"
      && node.props.className.startsWith("task-card task-card--done")
    ))).toHaveLength(7);
  });
});
