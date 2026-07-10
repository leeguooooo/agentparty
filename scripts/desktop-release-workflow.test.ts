import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(resolve(import.meta.dir, "../.github/workflows/release.yml"), "utf8");
const tauriConfig = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../desktop/src-tauri/tauri.conf.json"), "utf8"),
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

  test("requires Developer ID signing and notarization for every desktop release", () => {
    expect(tauriConfig.bundle.macOS.signingIdentity).not.toBe("-");
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
    expect(workflow).toContain('xcrun notarytool submit "$dmg"');
    expect(workflow).toContain('xcrun stapler staple "$dmg"');
    expect(workflow).toContain('spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"');
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
