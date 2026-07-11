import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const installer = readFileSync(resolve(import.meta.dir, "../install-desktop.sh"), "utf8");
const readme = readFileSync(resolve(import.meta.dir, "../README.md"), "utf8");

describe("macOS desktop production installer", () => {
  test("never removes quarantine or ad-hoc re-signs a downloaded app", () => {
    expect(installer).not.toContain("xattr -dr com.apple.quarantine");
    expect(installer).not.toMatch(/codesign[^\n]*--sign\s+-/);
    expect(readme).not.toContain("de-quarantines + ad-hoc signs");
  });

  test("rejects previews before mounting or copying the app", () => {
    const productionGate = installer.indexOf('[ "$distribution" = "production" ]');
    const mount = installer.indexOf('hdiutil attach "$tmp/$dmg"');
    const copy = installer.indexOf('cp -R "$src" "$stage"');
    expect(productionGate).toBeGreaterThan(0);
    expect(productionGate).toBeLessThan(mount);
    expect(mount).toBeLessThan(copy);
    expect(installer).toContain('[ "$notarized" = "true" ]');
    expect(installer).toContain("apple-id|api-key");
  });

  test("verifies both the DMG and staged app with Apple security tools", () => {
    expect(installer).toContain('xcrun stapler validate "$tmp/$dmg"');
    expect(installer).toContain('spctl --assess --type open --context context:primary-signature "$tmp/$dmg"');
    expect(installer).toContain('codesign --verify --deep --strict --verbose=2 "$stage"');
    expect(installer).toContain("^Authority=Developer ID Application:");
    expect(installer).toContain('xcrun stapler validate "$stage"');
    expect(installer).toContain('spctl --assess --type execute "$stage"');
  });

  test("stages and validates before backing up or replacing the installed app", () => {
    const stageCopy = installer.indexOf('cp -R "$src" "$stage"');
    const gatekeeper = installer.indexOf('spctl --assess --type execute "$stage"');
    const backup = installer.indexOf('mv "$dst" "$backup"');
    const replacement = installer.indexOf('mv "$stage" "$dst"');
    expect(stageCopy).toBeLessThan(gatekeeper);
    expect(gatekeeper).toBeLessThan(backup);
    expect(backup).toBeLessThan(replacement);
    expect(installer).toContain('mv "$backup" "$dst"');
  });
});
