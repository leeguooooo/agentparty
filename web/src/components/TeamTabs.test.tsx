// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import "../i18n/strings/Channel"; // 触发 registerDict，让 t() 解析团队面板文案
import { TeamTabs } from "./TeamTabs";

// #504 团队面板博客风：三个页签（01 分工 / 02 Agent 看板 / 03 协调）替代一整页长滚动。
// 只测结构层——页签切换、角标计数、头部提示符——现有 DivisionBoard/AgentBoard 数据逻辑不动。

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function render(): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = create(
      <LocaleProvider>
        <TeamTabs
          stats={{ roles: 3, online: 3, offline: 7, unclaimed: 10 }}
          mentionCount={1}
          division={<div>DIVISION_PANEL</div>}
          board={<div>BOARD_PANEL</div>}
          coordination={<div>COORD_PANEL</div>}
        />
      </LocaleProvider>,
    );
  });
  return r;
}

function allText(r: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === "object" && "children" in (node as { children?: unknown })) {
      walk((node as { children?: unknown }).children);
    }
  };
  walk(r.toJSON());
  return out.join(" ");
}

function tabButtons(r: ReactTestRenderer) {
  return r.root
    .findAllByType("button")
    .filter((b) => (b.props.className ?? "").includes("team-blog-tab"));
}

function tabPanels(r: ReactTestRenderer) {
  return r.root.findAllByProps({ role: "tabpanel" });
}

describe("TeamTabs (#504 博客风页签)", () => {
  test("头部渲染 $ cat ./team/overview 提示符与状态角标", () => {
    const r = render();
    const text = allText(r);
    expect(text).toContain("$ cat ./team/overview");
    expect(text).toContain("10"); // 未认领
    expect(text).toContain("7"); // 离线
  });

  test("没有未认领成员时仍显示 0 状态角标，但不标红", () => {
    let r!: ReactTestRenderer;
    act(() => {
      r = create(
        <LocaleProvider>
          <TeamTabs
            stats={{ roles: 3, online: 3, offline: 0, unclaimed: 0 }}
            mentionCount={0}
            division={<div>DIVISION_PANEL</div>}
            board={<div>BOARD_PANEL</div>}
            coordination={<div>COORD_PANEL</div>}
          />
        </LocaleProvider>,
      );
    });
    renderer = r;
    const badges = r.root.findAllByProps({ role: "listitem" });
    const unclaimed = badges.find((node) => allText({ toJSON: () => node } as unknown as ReactTestRenderer).includes("0 unclaimed"));
    expect(unclaimed).toBeDefined();
    expect(unclaimed!.props.className).toBe("t-mono team-blog-stat");
  });

  test("三个面板保持挂载，默认只显示分工页", () => {
    const r = render();
    const panels = tabPanels(r);
    expect(panels).toHaveLength(3);
    expect(panels.map((panel) => panel.props.hidden)).toEqual([false, true, true]);
    expect(allText({ toJSON: () => panels[0] } as unknown as ReactTestRenderer)).toContain("DIVISION_PANEL");
    expect(allText({ toJSON: () => panels[1] } as unknown as ReactTestRenderer)).toContain("BOARD_PANEL");
    expect(allText({ toJSON: () => panels[2] } as unknown as ReactTestRenderer)).toContain("COORD_PANEL");
  });

  test("三个页签编号 01/02/03，未认领角标挂在分工、@角标挂在协调", () => {
    const r = render();
    expect(tabButtons(r).length).toBe(3);
    const text = allText(r);
    expect(text).toContain("01");
    expect(text).toContain("02");
    expect(text).toContain("03");
    // 分工页签带未认领 10；协调页签带 @1
    expect(text).toContain("10");
    expect(text).toContain("@1");
  });

  test("点第二个页签切到看板，点第三个切到协调", () => {
    const r = render();
    act(() => {
      tabButtons(r)[1]!.props.onClick();
    });
    expect(tabPanels(r).map((panel) => panel.props.hidden)).toEqual([true, false, true]);
    act(() => {
      tabButtons(r)[2]!.props.onClick();
    });
    expect(tabPanels(r).map((panel) => panel.props.hidden)).toEqual([true, true, false]);
  });

  test("页签使用 roving tabIndex、ARIA 关联和左右方向键循环切换", () => {
    const r = render();
    let tabs = tabButtons(r);
    let panels = tabPanels(r);
    expect(tabs.map((button) => button.props.tabIndex)).toEqual([0, -1, -1]);
    expect(new Set(tabs.map((button) => button.props["aria-controls"])).size).toBe(3);
    tabs.forEach((button, index) => {
      expect(button.props["aria-controls"]).toBe(panels[index]!.props.id);
      expect(panels[index]!.props["aria-labelledby"]).toBe(button.props.id);
    });

    let prevented = false;
    act(() => {
      tabs[0]!.props.onKeyDown({ key: "ArrowRight", preventDefault: () => { prevented = true; } });
    });
    tabs = tabButtons(r);
    expect(prevented).toBe(true);
    expect(tabs.map((button) => button.props.tabIndex)).toEqual([-1, 0, -1]);
    panels = tabPanels(r);
    expect(panels.map((panel) => panel.props.hidden)).toEqual([true, false, true]);

    act(() => {
      tabs[1]!.props.onKeyDown({ key: "ArrowLeft", preventDefault: () => {} });
    });
    tabs = tabButtons(r);
    act(() => {
      tabs[0]!.props.onKeyDown({ key: "ArrowLeft", preventDefault: () => {} });
    });
    tabs = tabButtons(r);
    expect(tabs.map((button) => button.props.tabIndex)).toEqual([-1, -1, 0]);
  });

  test("切换页签不会重置子模块的本地状态", () => {
    function StatefulBoard() {
      const [draft, setDraft] = useState("");
      return (
        <input
          aria-label="board draft"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      );
    }

    act(() => {
      renderer = create(
        <LocaleProvider>
          <TeamTabs
            stats={{ roles: 3, online: 3, offline: 7, unclaimed: 10 }}
            mentionCount={1}
            division={<div>DIVISION_PANEL</div>}
            board={<StatefulBoard />}
            coordination={<div>COORD_PANEL</div>}
          />
        </LocaleProvider>,
      );
    });
    const r = renderer!;
    act(() => tabButtons(r)[1]!.props.onClick());
    const input = r.root.findByProps({ "aria-label": "board draft" });
    act(() => input.props.onChange({ currentTarget: { value: "keep this draft" } }));
    act(() => tabButtons(r)[2]!.props.onClick());

    expect(r.root.findByProps({ "aria-label": "board draft" }).props.value).toBe("keep this draft");
    expect(tabPanels(r).map((panel) => panel.props.hidden)).toEqual([true, true, false]);

    act(() => tabButtons(r)[1]!.props.onClick());
    expect(r.root.findByProps({ "aria-label": "board draft" }).props.value).toBe("keep this draft");
  });

  test("详情在同一外壳内替代页签，返回后恢复此前选中的页签", () => {
    let backCalls = 0;

    function DetailRoute() {
      const [showDetail, setShowDetail] = useState(false);
      return (
        <LocaleProvider>
          <TeamTabs
            stats={{ roles: 3, online: 3, offline: 7, unclaimed: 10 }}
            mentionCount={1}
            division={<div>DIVISION_PANEL</div>}
            board={<button type="button" onClick={() => setShowDetail(true)}>OPEN_DETAIL</button>}
            coordination={<div>COORD_PANEL</div>}
            detail={showDetail ? <article>AGENT_DETAIL</article> : null}
            detailBackLabel="Back to team"
            onBackFromDetail={() => {
              backCalls += 1;
              setShowDetail(false);
            }}
          />
        </LocaleProvider>
      );
    }

    act(() => {
      renderer = create(<DetailRoute />);
    });
    const r = renderer!;
    act(() => tabButtons(r)[1]!.props.onClick());
    const openDetail = r.root
      .findAllByType("button")
      .find((button) => allText({ toJSON: () => button } as unknown as ReactTestRenderer).includes("OPEN_DETAIL"));
    expect(openDetail).toBeDefined();
    act(() => openDetail!.props.onClick());

    expect(r.root.findByProps({ role: "tablist" }).props.hidden).toBe(true);
    expect(tabPanels(r).map((panel) => panel.props.hidden)).toEqual([true, true, true]);
    expect(allText(r)).toContain("AGENT_DETAIL");
    const back = r.root.findAllByType("button").find((button) => allText({ toJSON: () => button } as unknown as ReactTestRenderer).includes("Back to team"));
    expect(back).toBeDefined();
    act(() => back!.props.onClick());

    expect(backCalls).toBe(1);
    expect(tabButtons(r).map((button) => button.props["aria-selected"])).toEqual([false, true, false]);
    expect(tabPanels(r).map((panel) => panel.props.hidden)).toEqual([true, false, true]);
  });

  test("成员详情往返不会重置原页签内的草稿", () => {
    function StatefulBoard({ onOpen }: { onOpen: () => void }) {
      const [draft, setDraft] = useState("");
      return (
        <>
          <input
            aria-label="member route draft"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <button type="button" onClick={onOpen}>OPEN_MEMBER</button>
        </>
      );
    }

    function DetailRoute() {
      const [showDetail, setShowDetail] = useState(false);
      return (
        <LocaleProvider>
          <TeamTabs
            initialTab="board"
            stats={{ roles: 3, online: 3, offline: 7, unclaimed: 10 }}
            mentionCount={1}
            division={<div>DIVISION_PANEL</div>}
            board={<StatefulBoard onOpen={() => setShowDetail(true)} />}
            coordination={<div>COORD_PANEL</div>}
            detail={showDetail ? <article>MEMBER_DETAIL</article> : null}
            detailBackLabel="Back to team"
            onBackFromDetail={() => setShowDetail(false)}
          />
        </LocaleProvider>
      );
    }

    act(() => {
      renderer = create(<DetailRoute />);
    });
    const r = renderer!;
    const input = r.root.findByProps({ "aria-label": "member route draft" });
    act(() => input.props.onChange({ currentTarget: { value: "keep across detail" } }));
    const openDetail = r.root
      .findAllByType("button")
      .find((button) => allText({ toJSON: () => button } as unknown as ReactTestRenderer).includes("OPEN_MEMBER"));
    expect(openDetail).toBeDefined();
    act(() => openDetail!.props.onClick());

    expect(tabPanels(r).map((panel) => panel.props.hidden)).toEqual([true, true, true]);
    expect(r.root.findByProps({ "aria-label": "member route draft" }).props.value).toBe("keep across detail");
    const back = r.root
      .findAllByType("button")
      .find((button) => allText({ toJSON: () => button } as unknown as ReactTestRenderer).includes("Back to team"));
    expect(back).toBeDefined();
    act(() => back!.props.onClick());

    expect(tabPanels(r).map((panel) => panel.props.hidden)).toEqual([true, false, true]);
    expect(r.root.findByProps({ "aria-label": "member route draft" }).props.value).toBe("keep across detail");
  });

  test("成员详情打开时聚焦返回按钮，返回后把焦点交还给来源页签", () => {
    let focusedTabId: string | null = null;
    let focusedBack = 0;

    function DetailRoute() {
      const [showDetail, setShowDetail] = useState(true);
      return (
        <LocaleProvider>
          <TeamTabs
            initialTab="board"
            stats={{ roles: 1, online: 1, offline: 0, unclaimed: 0 }}
            mentionCount={0}
            division={<div>DIVISION_PANEL</div>}
            board={<div>BOARD_PANEL</div>}
            coordination={<div>COORD_PANEL</div>}
            detail={showDetail ? <article>MEMBER_DETAIL</article> : null}
            detailBackLabel="Back to team"
            onBackFromDetail={() => setShowDetail(false)}
          />
        </LocaleProvider>
      );
    }

    act(() => {
      renderer = create(<DetailRoute />, {
        createNodeMock: (element) => {
          const props = element.props as { role?: string; id?: string; className?: string };
          if (element.type === "button" && props.role === "tab") {
            return { focus: () => { focusedTabId = props.id ?? null; } };
          }
          if (element.type === "button" && props.className?.includes("team-blog-detail-back")) {
            return { focus: () => { focusedBack += 1; } };
          }
          return null;
        },
      });
    });
    expect(focusedBack).toBe(1);
    const back = renderer!.root
      .findAllByType("button")
      .find((button) => allText({ toJSON: () => button } as unknown as ReactTestRenderer).includes("Back to team"));
    expect(back).toBeDefined();
    act(() => back!.props.onClick());

    expect(focusedTabId).toContain("team-tab-board");
  });
});
