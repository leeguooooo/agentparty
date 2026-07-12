import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { decideDesktopUiPublication } from "./desktop-ui-publication";

const archive = Buffer.from("deterministic desktop UI archive");
const sha256 = createHash("sha256").update(archive).digest("hex");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyId = Buffer.from("12345678");
const publicKeyAlgorithm = Buffer.from("Ed");
const signatureAlgorithm = Buffer.from("ED");
const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const updaterPublicKey = Buffer.from(
  `untrusted comment: test key\n${Buffer.concat([publicKeyAlgorithm, keyId, rawPublicKey]).toString("base64")}\n`,
).toString("base64");

function signedManifest(overrides: Record<string, unknown> = {}): string {
  const payload = {
    schema: 1,
    version: "0.0.43",
    ui_abi: 1,
    min_shell_version: "0.2.94",
    build_id: "f".repeat(40),
    published_at: "2026-07-12T08:44:09Z",
    archive: { sha256 },
    entrypoint: "index.html",
    ...overrides,
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  const signature = sign(null, createHash("blake2b512").update(payloadBytes).digest(), privateKey);
  const trustedComment = "timestamp:1783845849";
  const globalSignature = sign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment)]),
    privateKey,
  );
  const signatureText = [
    "untrusted comment: test signature",
    Buffer.concat([signatureAlgorithm, keyId, signature]).toString("base64"),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString("base64"),
  ].join("\n");
  return JSON.stringify({
    payload: payloadBytes.toString("base64"),
    signature: Buffer.from(signatureText).toString("base64"),
  });
}

describe("desktop UI publication decision", () => {
  test("skips an automatic publication when content and compatibility are unchanged", () => {
    expect(decideDesktopUiPublication({
      archive,
      currentManifest: signedManifest(),
      publicKey: updaterPublicKey,
      uiAbi: 1,
      minShellVersion: "0.2.94",
    })).toEqual({ publish: false, reason: "unchanged" });
  });

  test("publishes changed content or compatibility metadata", () => {
    expect(decideDesktopUiPublication({
      archive: Buffer.from("changed"),
      currentManifest: signedManifest(),
      publicKey: updaterPublicKey,
      uiAbi: 1,
      minShellVersion: "0.2.94",
    })).toEqual({ publish: true, reason: "content-changed" });

    expect(decideDesktopUiPublication({
      archive,
      currentManifest: signedManifest(),
      publicKey: updaterPublicKey,
      uiAbi: 2,
      minShellVersion: "0.2.94",
    })).toEqual({ publish: true, reason: "compatibility-changed" });
  });

  test("fails open to a fresh signed publication when the current manifest is unavailable or invalid", () => {
    expect(decideDesktopUiPublication({
      archive,
      currentManifest: null,
      publicKey: updaterPublicKey,
      uiAbi: 1,
      minShellVersion: "0.2.94",
    })).toEqual({ publish: true, reason: "current-missing" });
    expect(decideDesktopUiPublication({
      archive,
      currentManifest: '{"payload":"not-base64","signature":"signed"}',
      publicKey: updaterPublicKey,
      uiAbi: 1,
      minShellVersion: "0.2.94",
    })).toEqual({ publish: true, reason: "current-invalid" });
  });

  test("republishes when the current manifest signature was tampered with", () => {
    const envelope = JSON.parse(signedManifest()) as { payload: string; signature: string };
    const signatureLines = Buffer.from(envelope.signature, "base64").toString("utf8").split("\n");
    const signatureBytes = Buffer.from(signatureLines[1], "base64");
    signatureBytes[20] ^= 0xff;
    signatureLines[1] = signatureBytes.toString("base64");
    envelope.signature = Buffer.from(signatureLines.join("\n")).toString("base64");

    expect(decideDesktopUiPublication({
      archive,
      currentManifest: JSON.stringify(envelope),
      publicKey: updaterPublicKey,
      uiAbi: 1,
      minShellVersion: "0.2.94",
    })).toEqual({ publish: true, reason: "current-invalid" });
  });
});
