import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  bindWorkspaceConfigPointer,
  cwdStatePath,
  durableConfigPointerPath,
  globalConfigPath,
  loadCursor,
  readConfig,
  readConfigWithSource,
  readState,
  refreshConfigInPlace,
  resolveChannel,
  saveCursor,
  slugifyBasename,
  statePath,
  tokenFingerprint,
  workspaceId,
  workspaceConfigPath,
  writeConfig,
  writeState,
  writeWorkspaceConfigOnly,
} from "../src/config";

let home: string;
let volatileDirs: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-test-"));
  volatileDirs = [];
  process.env.AGENTPARTY_HOME = home;
});

afterEach(() => {
  delete process.env.AGENTPARTY_HOME;
  delete process.env.AGENTPARTY_CONFIG;
  delete process.env.AGENTPARTY_CHANNEL;
  for (const dir of volatileDirs) rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("config", () => {
  test("read returns null when missing", () => {
    expect(readConfig()).toBeNull();
  });

  test("write/read roundtrip", () => {
    writeConfig({ server: "https://ap.example.com", token: "ap_x" });
    expect(readConfig()).toEqual({ server: "https://ap.example.com", token: "ap_x" });
  });

  test("readConfigWithSource reports workspace source and safe fingerprint", () => {
    const cwd = "/tmp/project-source";
    writeConfig({ server: "https://ap.example.com", token: "ap_secret_token" }, cwd);
    const resolved = readConfigWithSource(cwd);
    expect(resolved.config).toEqual({ server: "https://ap.example.com", token: "ap_secret_token" });
    expect(resolved.source).toMatchObject({
      kind: "workspace",
      path: join(home, "state", workspaceId(cwd), "config.json"),
      workspace_id: workspaceId(cwd),
      token_fingerprint: tokenFingerprint("ap_secret_token"),
    });
    expect(JSON.stringify(resolved.source)).not.toContain("ap_secret_token");
  });

  test("readConfigWithSource reports explicit global and none", () => {
    expect(readConfigWithSource("/tmp/missing").source).toMatchObject({ kind: "none", path: null });

    writeConfig({ server: "https://ap.example.com", token: "ap_global" }, "/tmp/has-global");
    const global = readConfigWithSource("/tmp/other");
    expect(global.source.kind).toBe("global");
    expect(global.source.path).toBe(join(home, "config.json"));

    process.env.AGENTPARTY_CONFIG = join(home, "explicit.json");
    writeConfig({ server: "https://ap.example.com", token: "ap_explicit" });
    const explicit = readConfigWithSource("/tmp/other");
    expect(explicit.source.kind).toBe("explicit");
    expect(explicit.source.path).toBe(join(home, "explicit.json"));
    expect(explicit.source.token_fingerprint).toBe(tokenFingerprint("ap_explicit"));
  });

  test("workspace configs isolate by cwd; global is the cross-dir fallback", () => {
    const a = "/tmp/proj-a";
    const b = "/tmp/proj-b";
    writeConfig({ server: "s", token: "ap_a" }, a);
    writeConfig({ server: "s", token: "ap_b" }, b);
    // 各目录读回自己的 token——同机多 session 不再互相覆盖串号
    expect(readConfig(a)).toEqual({ server: "s", token: "ap_a" });
    expect(readConfig(b)).toEqual({ server: "s", token: "ap_b" });
    // 无 workspace 配置的目录回退到全局（= 最近一次 init 的 ap_b），保「init 一次跨目录可用」
    expect(readConfig("/tmp/proj-c")).toEqual({ server: "s", token: "ap_b" });
  });

  test("profile child config ignores owner explicit/global config and stays mode 0600 (#548)", () => {
    const ownerPath = join(home, "owner.json");
    process.env.AGENTPARTY_CONFIG = ownerPath;
    writeConfig({ server: "s", token: "ap_OWNER" });

    const childCwd = "/tmp/profile-child-alpha";
    const childPath = writeWorkspaceConfigOnly({ server: "s", token: "ap_CHILD" }, childCwd);

    expect(childPath).toBe(join(home, "state", workspaceId(childCwd), "config.json"));
    expect(JSON.parse(readFileSync(childPath, "utf8"))).toEqual({ server: "s", token: "ap_CHILD" });
    expect(JSON.parse(readFileSync(ownerPath, "utf8"))).toEqual({ server: "s", token: "ap_OWNER" });
    expect(statSync(childPath).mode & 0o777).toBe(0o600);
    expect(globalConfigPath()).toBe(ownerPath);
  });

  test("config precedence is explicit env > workspace > cwd breadcrumb > global (#359)", () => {
    const cwd = "/tmp/config-precedence";
    const breadcrumbPath = join(home, "breadcrumb.json");
    const explicitPath = join(home, "explicit.json");

    writeConfig({ server: "s", token: "ap_global" }, "/tmp/global-source");

    process.env.AGENTPARTY_CONFIG = breadcrumbPath;
    writeConfig({ server: "s", token: "ap_breadcrumb" }, cwd);
    bindWorkspaceConfigPointer(breadcrumbPath, "dev", cwd);
    delete process.env.AGENTPARTY_CONFIG;
    expect(readConfigWithSource(cwd)).toMatchObject({
      config: { token: "ap_breadcrumb" },
      source: { kind: "explicit", path: breadcrumbPath },
    });

    writeConfig({ server: "s", token: "ap_workspace" }, cwd);
    expect(readConfigWithSource(cwd)).toMatchObject({
      config: { token: "ap_workspace" },
      source: { kind: "workspace" },
    });

    process.env.AGENTPARTY_CONFIG = explicitPath;
    writeConfig({ server: "s", token: "ap_explicit" }, cwd);
    expect(readConfigWithSource(cwd)).toMatchObject({
      config: { token: "ap_explicit" },
      source: { kind: "explicit", path: explicitPath },
    });
  });

  test("AGENTPARTY_CONFIG pins config and cursor state for same-cwd agents", () => {
    const cwd = "/tmp/shared-worktree";
    const configA = join(home, "agent-a.json");
    const configB = join(home, "agent-b.json");

    process.env.AGENTPARTY_CONFIG = configA;
    writeConfig({ server: "s", token: "ap_a" }, cwd);
    writeState({ channel: "agentparty", cursor: 10 }, cwd);
    expect(readConfig(cwd)).toEqual({ server: "s", token: "ap_a" });
    expect(statePath(cwd)).toBe(join(home, "agent-a.json.state", "state.json"));
    expect(readState(cwd)).toEqual({ channel: "agentparty", cursor: 10 });

    process.env.AGENTPARTY_CONFIG = configB;
    writeConfig({ server: "s", token: "ap_b" }, cwd);
    writeState({ channel: "agentparty", cursor: 3 }, cwd);
    expect(readConfig(cwd)).toEqual({ server: "s", token: "ap_b" });
    expect(statePath(cwd)).toBe(join(home, "agent-b.json.state", "state.json"));
    expect(readState(cwd)).toEqual({ channel: "agentparty", cursor: 3 });

    process.env.AGENTPARTY_CONFIG = configA;
    expect(readConfig(cwd)).toEqual({ server: "s", token: "ap_a" });
    expect(readState(cwd)).toEqual({ channel: "agentparty", cursor: 10 });
  });

  test("config, refreshed config, state, and breadcrumb writes replace JSON atomically (#364)", () => {
    const cwd = "/tmp/atomic-json-writes";
    writeConfig({ server: "s", token: "ap_one" }, cwd);
    const workspacePath = workspaceConfigPath(cwd);
    const globalPath = globalConfigPath();
    const workspaceInode = statSync(workspacePath).ino;
    const globalInode = statSync(globalPath).ino;
    writeConfig({ server: "s", token: "ap_two" }, cwd);
    expect(statSync(workspacePath).ino).not.toBe(workspaceInode);
    expect(statSync(globalPath).ino).not.toBe(globalInode);

    const refreshedInode = statSync(workspacePath).ino;
    refreshConfigInPlace({ server: "s", token: "ap_three" }, cwd);
    expect(statSync(workspacePath).ino).not.toBe(refreshedInode);

    writeState({ channel: "dev", cursor: 1 }, cwd);
    const stateInode = statSync(statePath(cwd)).ino;
    writeState({ channel: "dev", cursor: 2 }, cwd);
    expect(statSync(statePath(cwd)).ino).not.toBe(stateInode);

    bindWorkspaceConfigPointer(join(home, "dev-one.json"), "dev", cwd);
    const breadcrumbInode = statSync(cwdStatePath(cwd)).ino;
    bindWorkspaceConfigPointer(join(home, "dev-two.json"), "dev", cwd);
    expect(statSync(cwdStatePath(cwd)).ino).not.toBe(breadcrumbInode);
  });
});

describe("workspace id", () => {
  test("slugify basename", () => {
    expect(slugifyBasename("My_Dir 2")).toBe("my-dir-2");
    expect(slugifyBasename("herness-use")).toBe("herness-use");
    expect(slugifyBasename("中文目录")).toBe("workspace");
  });

  test("id = <basename-slug>-<sha256(cwd) first 16 hex>", () => {
    const cwd = "/Users/leo/github.com/My Project";
    const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
    expect(workspaceId(cwd)).toBe(`my-project-${hash}`);
  });

  test("state path lives under AGENTPARTY_HOME/state/<id>/state.json", () => {
    const cwd = "/tmp/abc";
    expect(statePath(cwd)).toBe(join(home, "state", workspaceId(cwd), "state.json"));
  });
});

describe("workspace state", () => {
  const cwd = "/tmp/project-x";

  test("state roundtrip + cursor helpers", () => {
    expect(readState(cwd)).toBeNull();
    writeState({ channel: "dev", cursor: 7 }, cwd);
    expect(readState(cwd)).toEqual({ channel: "dev", cursor: 7 });
    expect(loadCursor("dev", cwd)).toBe(7);
    expect(loadCursor("other", cwd)).toBe(0);
  });

  test("saveCursor advances monotonically and now keys by channel (#113)", () => {
    writeState({ channel: "dev", cursor: 5 }, cwd);
    saveCursor("dev", 9, cwd);
    expect(loadCursor("dev", cwd)).toBe(9);
    saveCursor("dev", 3, cwd);
    expect(loadCursor("dev", cwd)).toBe(9); // 不回退

    // #113 修复前：非绑定频道的游标被静默丢弃，serve --profile 的每个频道恒 since=0
    saveCursor("other", 42, cwd);
    expect(loadCursor("other", cwd)).toBe(42);
    expect(loadCursor("dev", cwd)).toBe(9); // 互不干扰
    // 绑定频道仍镜像到顶层，兼容旧读者
    expect(readState(cwd)?.cursor).toBe(9);
    expect(readState(cwd)?.channel).toBe("dev");
  });

  test("resolveChannel prefers explicit over bound", () => {
    writeState({ channel: "dev", cursor: 0 }, cwd);
    expect(resolveChannel(undefined, cwd)).toBe("dev");
    expect(resolveChannel("ops", cwd)).toBe("ops");
    expect(resolveChannel(undefined, "/tmp/unbound")).toBeNull();
  });

  test("resolveChannel uses the immutable runner channel binding before workspace state (#548)", () => {
    writeState({ channel: "owner-channel", cursor: 0 }, cwd);
    process.env.AGENTPARTY_CHANNEL = "profile-child-channel";
    expect(resolveChannel(undefined, cwd)).toBe("profile-child-channel");
    expect(resolveChannel("explicit-channel", cwd)).toBe("explicit-channel");
  });

  test("breadcrumb recovers the agent config after AGENTPARTY_CONFIG is lost (issue #42)", () => {
    const cfgPath = join(home, "agent-cfg.json");
    // 建立轮：有 env，写隔离 config + cwd 面包屑
    process.env.AGENTPARTY_CONFIG = cfgPath;
    writeConfig({ server: "https://agentparty.leeguoo.com", token: "ap_AGENT" }, cwd);
    bindWorkspaceConfigPointer(cfgPath, "dev", cwd);
    // 回复轮：env 蒸发（模拟 Claude 新 Bash）——workspace/global 都空，靠面包屑找回 agent token
    delete process.env.AGENTPARTY_CONFIG;
    const r = readConfigWithSource(cwd);
    expect(r.config?.token).toBe("ap_AGENT");
    expect(r.source.kind).toBe("explicit");
    expect(r.source.path).toBe(cfgPath);
  });

  test("TMPDIR config is mirrored persistently and recovers even while the explicit path stays missing (#518)", () => {
    const volatile = mkdtempSync(join(tmpdir(), "ap-volatile-config-"));
    volatileDirs.push(volatile);
    const tempConfig = join(volatile, "agentparty-worker-dev.json");
    const durable = join(home, "agents", "agentparty-worker-dev.json");

    process.env.AGENTPARTY_CONFIG = tempConfig;
    writeConfig({ server: "https://agentparty.example.com", token: "ap_DURABLE" }, cwd);
    writeState({ channel: "dev", cursor: 9 }, cwd);
    expect(durableConfigPointerPath(tempConfig)).toBe(durable);
    expect(statSync(durable).mode & 0o777).toBe(0o600);
    bindWorkspaceConfigPointer(durableConfigPointerPath(tempConfig), "dev", cwd);

    rmSync(volatile, { recursive: true, force: true });
    const recovered = readConfigWithSource(cwd);
    expect(recovered).toMatchObject({
      config: { server: "https://agentparty.example.com", token: "ap_DURABLE" },
      source: { kind: "explicit", path: durable },
    });
    expect(readState(cwd)).toMatchObject({ channel: "dev", cursor: 9 });
    const breadcrumbState = JSON.parse(readFileSync(cwdStatePath(cwd), "utf8"));
    expect(breadcrumbState).toMatchObject({
      config_path: durable,
      bindings: { dev: durable },
    });
  });

  test("a missing persistent explicit config fails closed instead of borrowing another workspace identity (#518)", () => {
    writeConfig({ server: "s", token: "ap_global" }, "/tmp/global-identity");
    const other = join(home, "agents", "other-agent.json");
    process.env.AGENTPARTY_CONFIG = other;
    writeConfig({ server: "s", token: "ap_OTHER" }, cwd);
    bindWorkspaceConfigPointer(other, "dev", cwd);

    const missing = join(home, "agents", "missing-agent.json");
    process.env.AGENTPARTY_CONFIG = missing;
    expect(readConfigWithSource(cwd)).toMatchObject({
      config: null,
      source: { kind: "explicit", path: missing },
    });
    expect(readState(cwd)).toBeNull();
  });

  test("channel bindings survive later init and channel follows the latest init (#360)", () => {
    const alphaPath = join(home, "alpha.json");
    const betaPath = join(home, "beta.json");
    bindWorkspaceConfigPointer(alphaPath, "alpha", cwd);
    bindWorkspaceConfigPointer(betaPath, "beta", cwd);

    expect(readState(cwd)).toMatchObject({
      channel: "beta",
      config_path: betaPath,
      bindings: { alpha: alphaPath, beta: betaPath },
    });

    bindWorkspaceConfigPointer(alphaPath, "alpha", cwd);
    expect(readState(cwd)).toMatchObject({
      channel: "alpha",
      config_path: alphaPath,
      bindings: { alpha: alphaPath, beta: betaPath },
    });
  });

  test("legacy config_path remains a readable breadcrumb", () => {
    const legacyPath = join(home, "legacy.json");
    process.env.AGENTPARTY_CONFIG = legacyPath;
    writeConfig({ server: "s", token: "ap_legacy" }, cwd);
    delete process.env.AGENTPARTY_CONFIG;
    writeState({ channel: "dev", cursor: 0, config_path: legacyPath }, cwd);

    expect(readConfigWithSource(cwd)).toMatchObject({
      config: { token: "ap_legacy" },
      source: { kind: "explicit", path: legacyPath },
    });
  });

  test("the first post-upgrade init migrates the legacy channel binding", () => {
    const alphaPath = join(home, "legacy-alpha.json");
    const betaPath = join(home, "beta.json");
    writeState({ channel: "alpha", cursor: 7, config_path: alphaPath }, cwd);

    bindWorkspaceConfigPointer(betaPath, "beta", cwd);
    expect(readState(cwd)).toMatchObject({
      channel: "beta",
      cursor: 7,
      config_path: betaPath,
      bindings: { alpha: alphaPath, beta: betaPath },
    });
  });

  test("unreadable breadcrumb warns before falling back to global (#359)", () => {
    const missingPath = join(home, "gone.json");
    writeConfig({ server: "s", token: "ap_global" }, "/tmp/global-fallback");
    bindWorkspaceConfigPointer(missingPath, "dev", cwd);
    const warnings: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      expect(readConfigWithSource(cwd)).toMatchObject({
        config: { token: "ap_global" },
        source: { kind: "global" },
      });
    } finally {
      console.error = originalError;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(missingPath);
    expect(warnings[0]).toContain("falling back");
  });
});
