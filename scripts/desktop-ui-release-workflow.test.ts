import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowPath = resolve(import.meta.dir, "../.github/workflows/release-desktop-ui.yml");

describe("desktop UI release workflow", () => {
  test("is valid YAML", () => {
    expect(() => Bun.YAML.parse(readFileSync(workflowPath, "utf8"))).not.toThrow();
  });

  test("uses a fixed serialized desktop-ui GitHub Release channel", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("group: desktop-ui-release");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("tag_name: desktop-ui");
    expect(workflow).toContain("name: AgentParty Desktop UI");
    expect(workflow).toContain("make_latest: false");
    expect(workflow).toContain("overwrite_files: true");
  });

  test("publishes automatically only after the authoritative main release workflow succeeds", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain('workflows: ["release"]');
    expect(workflow).toContain("types: [completed]");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).not.toMatch(/^\s+push:\s*$/m);
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
  });

  test("checks out and publishes the exact successful workflow SHA while preserving manual dispatch", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("github.event.workflow_run.head_sha || github.sha");
    expect(workflow).toContain("ref: ${{ env.SOURCE_SHA }}");
    expect(workflow).toContain('--build-id "$SOURCE_SHA"');
    expect(workflow).not.toContain('--build-id "$GITHUB_SHA"');
    expect(workflow).toContain('UI_VERSION="0.0.${GITHUB_RUN_NUMBER}"');
    expect(workflow).toContain('PUBLISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"');
    expect(workflow).not.toContain("git show -s --format=%cI");
    expect(workflow).toContain('UI_ABI="${INPUT_UI_ABI:-1}"');
    expect(workflow).toContain('MIN_SHELL_VERSION="${INPUT_MIN_SHELL_VERSION:-0.2.94}"');
    expect(workflow).toMatch(/min_shell_version:[\s\S]*?default: "0\.2\.94"/);
  });

  test("builds production web assets and creates deterministic versioned artifacts", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("VITE_API_BASE=https://agentparty.leeguoo.com bunx vite build");
    expect(workflow).toContain('ASSET="agentparty-desktop-ui-v${UI_VERSION}.tar.gz"');
    expect(workflow).toContain("bun scripts/desktop-ui-bundle.ts");
    expect(workflow).toContain("--source web/dist");
    expect(workflow).toContain("bun scripts/desktop-ui-manifest.ts");
    expect(workflow).toContain('--build-id "$SOURCE_SHA"');
    expect(workflow).toContain('--published-at "$PUBLISHED_AT"');
  });

  test("skips automatic publication when deterministic UI content is unchanged", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("id: publication");
    expect(workflow).toContain("bun scripts/desktop-ui-publication.ts");
    expect(workflow).toContain("gh release download desktop-ui");
    expect(workflow).toContain(".plugins.updater.pubkey");
    expect(workflow).toContain('--public-key "$UPDATER_PUBLIC_KEY"');
    expect(workflow).toContain('if [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ]');
    expect(workflow).toContain('echo "publish=true" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('echo "publish=$publish" >> "$GITHUB_OUTPUT"');
    for (const step of [
      "sign Desktop UI archive",
      "generate Desktop UI manifest",
      "sign Desktop UI manifest",
      "finalize signed Desktop UI manifest envelope",
      "publish fixed desktop-ui release channel",
    ]) {
      const start = workflow.indexOf(`- name: ${step}`);
      const end = workflow.indexOf("\n      - name:", start + 1);
      const block = workflow.slice(start, end === -1 ? undefined : end);
      expect(start).toBeGreaterThan(-1);
      expect(block).toContain("if: steps.publication.outputs.publish == 'true'");
    }
  });

  test("requires the Tauri v2 key and signs the archive before manifest generation", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_V2 }}");
    expect(workflow).toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD_V2 }}");
    expect(workflow).toMatch(/name: sign Desktop UI archive[\s\S]*?working-directory: desktop/);
    expect(workflow).toContain('bunx tauri signer sign "../dist/$ASSET"');
    expect(workflow.indexOf("sign Desktop UI archive")).toBeLessThan(workflow.indexOf("generate Desktop UI manifest"));
    expect(workflow).toMatch(/name: sign Desktop UI manifest[\s\S]*?working-directory: desktop/);
    expect(workflow).toContain('bunx tauri signer sign "../dist/desktop-ui-manifest-payload.json"');
    expect(workflow).toContain("--payload dist/desktop-ui-manifest-payload.json");
    expect(workflow).toContain("--signature dist/desktop-ui-manifest-payload.json.sig");
  });

  test("publishes versioned assets plus the stable manifest without touching the normal release", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain('cp "dist/$VERSIONED_MANIFEST" dist/desktop-ui.json');
    expect(workflow).toContain("dist/agentparty-desktop-ui-v*.tar.gz");
    expect(workflow).toContain("dist/agentparty-desktop-ui-v*.tar.gz.sha256");
    expect(workflow).toContain("dist/agentparty-desktop-ui-v*.tar.gz.sig");
    expect(workflow).toContain("dist/agentparty-desktop-ui-v*.json");
    expect(workflow).toContain("dist/desktop-ui.json");
    expect(workflow).not.toContain("tag_name: ${{ github.ref_name }}");
  });
});
