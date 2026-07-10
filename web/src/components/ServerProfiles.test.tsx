// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "../i18n/locale";
import { ServerProfileStrings } from "../i18n/strings/ServerProfiles";
import {
  OFFICIAL_SERVER_PROFILES,
  type ServerProfileStorage,
} from "../lib/serverProfiles";
import {
  probeAndAddServerProfile,
  ServerProfilePicker,
  ServerSwitcherView,
} from "./ServerProfiles";

describe("server profile controls", () => {
  test("registers complete English and Chinese labels", () => {
    for (const locale of ["en", "zh"] as const) {
      for (const key of [
        "ServerProfiles.server",
        "ServerProfiles.add.title",
        "ServerProfiles.add.check",
        "ServerProfiles.providers.none",
        "ServerProfiles.switch.failed",
        "ServerProfiles.switch.unpaired",
        "ServerProfiles.switch.pair",
        "ServerProfiles.addPair",
        "ServerProfiles.addPair.cancel",
      ]) {
        expect(ServerProfileStrings[locale][key]).toBeTruthy();
      }
    }
  });

  test("renders official profiles and keyboard-native custom server controls", () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <ServerProfilePicker
          profiles={[...OFFICIAL_SERVER_PROFILES]}
          selectedOrigin={OFFICIAL_SERVER_PROFILES[0]!.origin}
          onSelect={() => {}}
          onProfilesChanged={() => {}}
        />
      </LocaleProvider>,
    );
    expect(html).toContain("AgentParty Production");
    expect(html).toContain("AgentParty Test");
    expect(html).toContain('type="url"');
    expect(html).toContain("Check and add server");
    expect(html).not.toContain("emoji");
  });

  test("renders a compact header switcher with pending and failure states", () => {
    const pending = renderToStaticMarkup(
      <LocaleProvider>
        <ServerSwitcherView
          profiles={[...OFFICIAL_SERVER_PROFILES]}
          activeOrigin={OFFICIAL_SERVER_PROFILES[0]!.origin}
          pending={true}
          error={null}
          pairTarget={null}
          onSelect={() => {}}
          onAddPair={() => {}}
          onPair={() => {}}
        />
      </LocaleProvider>,
    );
    expect(pending).toContain("disabled");
    expect(pending).toContain("Switching server");

    const failed = renderToStaticMarkup(
      <LocaleProvider>
        <ServerSwitcherView
          profiles={[...OFFICIAL_SERVER_PROFILES]}
          activeOrigin={OFFICIAL_SERVER_PROFILES[0]!.origin}
          pending={false}
          error="Could not switch"
          pairTarget="https://agentparty.pwtk-dev.work"
          onSelect={() => {}}
          onAddPair={() => {}}
          onPair={() => {}}
        />
      </LocaleProvider>,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Could not switch");
    expect(failed).toContain("Pair this server");
    expect(failed).toContain("Add or pair server");
  });

});

test("custom servers are persisted only after successful probing", async () => {
  const values = new Map<string, string>();
  const storage: ServerProfileStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const result = await probeAndAddServerProfile(
    storage,
    { label: "Private", origin: "https://party.example.com" },
    async (input) => String(input).endsWith("/api/health")
      ? new Response("{}", { status: 200 })
      : new Response(JSON.stringify({
        oidc: { issuer: "https://id.example.com", client_id: "public-web" },
      }), { status: 200 }),
  );

  expect(result.probe.providers.map((provider) => provider.label)).toEqual(["Sign in with account center"]);
  expect(result.profiles.at(-1)?.origin).toBe("https://party.example.com");
});
