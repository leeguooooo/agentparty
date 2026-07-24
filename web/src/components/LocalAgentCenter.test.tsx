// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "../i18n/locale";
import type { DesktopAgentAdapter, DesktopAgentStatus } from "../lib/desktopAgent";
import { LocalAgentCenter } from "./LocalAgentCenter";

const stopped: DesktopAgentStatus = {
  state: "stopped",
  pid: null,
  configId: null,
  name: null,
  channel: null,
  runner: null,
  startedAt: null,
  exitCode: null,
  lastError: null,
  instanceId: null,
  workdir: null,
  repo: null,
};

const adapter: DesktopAgentAdapter = {
  listConfigs: async () => [],
  status: async () => stopped,
  statusAll: async () => [],
  start: async () => stopped,
  stop: async () => stopped,
  stopInstance: async () => stopped,
  logs: async () => [],
  logsInstance: async () => [],
  dutyList: async () => [],
  dutyPersist: async () => ({
    label: "test",
    instanceId: "test:channel",
    plistPath: "/tmp/test.plist",
    logPath: "/tmp/test.log",
    loaded: true,
  }),
  dutyUnpersist: async () => {},
  dutyAdopt: async () => ({
    label: "test",
    instanceId: "test:channel",
    plistPath: "/tmp/test.plist",
    logPath: "/tmp/test.log",
    loaded: true,
  }),
  dutyLogRead: async () => "",
};

function render(initialSection?: Parameters<typeof LocalAgentCenter>[0]["initialSection"]): string {
  return renderToStaticMarkup(
    <LocaleProvider>
      <LocalAgentCenter
        adapter={adapter}
        initialSection={initialSection}
        onClose={() => {}}
      />
    </LocaleProvider>,
  );
}

describe("LocalAgentCenter", () => {
  test("is a dedicated three-module control center", () => {
    const html = render();

    expect(html).toContain("Local agent center");
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('id="local-agent-center-panel-overview"');
    expect(html).toContain("local-agents");
    expect(html).toContain("desktop-agent");
    expect(html).toContain("resident-logs");
  });

  test("keeps module state mounted while hiding inactive operational panels", () => {
    const launcher = render("launcher");
    expect(launcher).toContain("desktop-agent");
    expect(launcher).toContain('id="local-agent-center-panel-overview" class="settings-module" role="tabpanel" aria-labelledby="local-agent-center-tab-overview" hidden=""');
    expect(launcher).toContain('id="local-agent-center-panel-launcher" class="settings-module" role="tabpanel" aria-labelledby="local-agent-center-tab-launcher"');
    expect(launcher).toContain('id="local-agent-center-panel-logs" class="settings-module" role="tabpanel" aria-labelledby="local-agent-center-tab-logs" hidden=""');

    const logs = render("logs");
    expect(logs).toContain("resident-logs");
    expect(logs).toContain('id="local-agent-center-panel-overview" class="settings-module" role="tabpanel" aria-labelledby="local-agent-center-tab-overview" hidden=""');
    expect(logs).toContain('id="local-agent-center-panel-launcher" class="settings-module" role="tabpanel" aria-labelledby="local-agent-center-tab-launcher" hidden=""');
    expect(logs).toContain('id="local-agent-center-panel-logs" class="settings-module" role="tabpanel" aria-labelledby="local-agent-center-tab-logs"');
  });
});
