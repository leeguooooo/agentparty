import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(resolve(import.meta.dir, "../.github/workflows/release.yml"), "utf8");
const desktopDocs = readFileSync(
  resolve(import.meta.dir, "../web/public/docs/desktop/index.html"),
  "utf8",
);
const tauriConfig = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../desktop/src-tauri/tauri.conf.json"), "utf8"),
);
const desktopCapability = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../desktop/src-tauri/capabilities/default.json"), "utf8"),
);

describe("desktop release workflow", () => {
  test("hands every signed updater artifact to the release job", () => {
    expect(workflow).toMatch(/^\s+path: agentparty-desktop-\*\s*$/m);
    expect(workflow).toContain("agentparty-desktop-${ASSET}.app.tar.gz");
    expect(workflow).toContain('cp "${updater}.sig" "${updater_out}.sig"');
    expect(workflow).toContain('[ ! -s "$dmg" ] || [ ! -s "$updater" ] || [ ! -s "${updater}.sig" ]');
  });

  test("requires the signing key and publishes a static updater manifest", () => {
    expect(workflow).toContain("secrets.TAURI_SIGNING_PRIVATE_KEY");
    expect(workflow).toContain("secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
    expect(workflow).toContain("bun scripts/desktop-update-manifest.ts");
    expect(workflow).toContain("--output dist/latest.json");
    expect(workflow).toContain("dist/latest.json");
  });

  test("allows the desktop shell to receive notification click actions", () => {
    expect(desktopCapability.permissions).toContain("notification:allow-register-listener");
  });

  test("ships the desktop webview with a restrictive content security policy", () => {
    const csp = tauriConfig.app.security.csp;
    expect(typeof csp).toBe("string");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-eval'");
  });

  test("gates desktop distribution and falls back to an honest unnotarized preview", () => {
    expect(tauriConfig.bundle.macOS.signingIdentity).not.toBe("-");
    expect(workflow).toMatch(/desktop:\n(?:[\s\S]*?)environment:\n\s+name: release/);
    expect(workflow).toContain("id: apple-signing");
    expect(workflow).toContain('echo "enabled=false" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain("if: steps.apple-signing.outputs.enabled == 'true'");
    expect(workflow).toContain("if: steps.apple-signing.outputs.enabled == 'false'");
    for (const secret of [
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID",
      "KEYCHAIN_PASSWORD",
    ]) {
      expect(workflow).toContain(`secrets.${secret}`);
    }
    expect(workflow).toContain("security find-identity -v -p codesigning");
    expect(workflow).toContain("spctl --assess --type execute");
    expect(workflow).toContain("xcrun stapler validate");
    expect(workflow).not.toContain('xcrun notarytool submit "$dmg"');
    expect(workflow).not.toContain('xcrun stapler staple "$dmg"');
    expect(workflow).toContain('xcrun stapler validate "$dmg"');
    expect(workflow).toContain('spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"');
    expect(workflow).toContain("agentparty-desktop-${ASSET}.signing-status.json");
    expect(workflow).toContain("dist/release-body.md");
    expect(workflow).toContain("--notes \"$DESKTOP_RELEASE_NOTES\"");
    expect(workflow).toContain("dist/*.signing-status.json");

    expect(desktopDocs).toContain("Unnotarized macOS preview");
    expect(desktopDocs).toContain("正式下载入口仍处于准备中");
  });

  test("uses commands available on GitHub macOS runners for certificate import", () => {
    expect(workflow).toContain("security list-keychains -d user");
    expect(workflow).not.toContain("-maxdepth");
  });

  test("requires the tag, CLI package, and desktop package versions to match", () => {
    expect(workflow).toContain('TAG_VERSION="${GITHUB_REF_NAME#v}"');
    expect(workflow).toContain('CLI_VERSION=$(bun -e');
    expect(workflow).toContain('DESKTOP_VERSION=$(bun -e');
    expect(workflow).toContain('"$TAG_VERSION" = "$CLI_VERSION"');
    expect(workflow).toContain('"$TAG_VERSION" = "$DESKTOP_VERSION"');
  });

  test("keeps prereleases out of the stable latest updater channel", () => {
    expect(workflow).toContain('VERSION_WITHOUT_BUILD="${VERSION%%+*}"');
    expect(workflow).toContain('if [[ "$VERSION_WITHOUT_BUILD" == *-* ]]');
    expect(workflow).toContain("prerelease: ${{ steps.release-channel.outputs.prerelease }}");
    expect(workflow).toContain("make_latest: ${{ steps.release-channel.outputs.make_latest }}");
  });
});
