import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateDesktopUpdateVersion } from "./desktop-update-manifest";

const SHA_256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const usage = "Usage: bun scripts/desktop-ui-publication.ts --archive <archive.tar.gz> --manifest <desktop-ui.json> --public-key <base64 minisign public key> --ui-abi <1..65535> --min-shell-version <semver>";

export interface DesktopUiPublicationInput {
  archive: Buffer;
  currentManifest: string | null;
  publicKey: string;
  uiAbi: number;
  minShellVersion: string;
}

export interface DesktopUiPublicationDecision {
  publish: boolean;
  reason: "unchanged" | "content-changed" | "compatibility-changed" | "current-missing" | "current-invalid";
}

function decodeBase64(value: string): Buffer | null {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64.test(value)) return null;
  return Buffer.from(value, "base64");
}

function verifyMinisign(payload: Buffer, encodedSignature: string, encodedPublicKey: string): boolean {
  try {
    const publicKeyText = decodeBase64(encodedPublicKey)?.toString("utf8");
    const signatureText = decodeBase64(encodedSignature)?.toString("utf8");
    if (!publicKeyText || !signatureText) return false;
    const publicKeyLines = publicKeyText.trimEnd().split("\n");
    const signatureLines = signatureText.trimEnd().split("\n");
    if (publicKeyLines.length !== 2 || signatureLines.length !== 4) return false;
    const publicKeyBytes = decodeBase64(publicKeyLines[1]);
    const signatureBytes = decodeBase64(signatureLines[1]);
    const globalSignature = decodeBase64(signatureLines[3]);
    if (
      publicKeyBytes?.length !== 42 ||
      signatureBytes?.length !== 74 ||
      globalSignature?.length !== 64 ||
      !["Ed", "ED"].includes(publicKeyBytes.subarray(0, 2).toString("ascii")) ||
      signatureBytes.subarray(0, 2).toString("ascii") !== "ED" ||
      !publicKeyBytes.subarray(2, 10).equals(signatureBytes.subarray(2, 10)) ||
      !signatureLines[2].startsWith("trusted comment: ")
    ) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes.subarray(10)]),
      format: "der",
      type: "spki",
    });
    const signature = signatureBytes.subarray(10);
    const digest = createHash("blake2b512").update(payload).digest();
    if (!verify(null, digest, key, signature)) return false;
    const trustedComment = signatureLines[2].slice("trusted comment: ".length);
    return verify(
      null,
      Buffer.concat([signature, Buffer.from(trustedComment)]),
      key,
      globalSignature,
    );
  } catch {
    return false;
  }
}

function currentReleaseMetadata(contents: string, publicKey: string): {
  sha256: string;
  uiAbi: number;
  minShellVersion: string;
} | null {
  try {
    const envelope: unknown = JSON.parse(contents);
    if (typeof envelope !== "object" || envelope === null) return null;
    const payloadBase64 = (envelope as Record<string, unknown>).payload;
    const signature = (envelope as Record<string, unknown>).signature;
    if (typeof payloadBase64 !== "string" || typeof signature !== "string") return null;
    const payloadBytes = decodeBase64(payloadBase64);
    if (payloadBytes === null || !verifyMinisign(payloadBytes, signature, publicKey)) return null;
    const payload: unknown = JSON.parse(payloadBytes.toString("utf8"));
    if (typeof payload !== "object" || payload === null) return null;
    const manifest = payload as Record<string, unknown>;
    const archive = manifest.archive;
    if (typeof archive !== "object" || archive === null) return null;
    const sha256 = (archive as Record<string, unknown>).sha256;
    if (
      manifest.schema !== 1 ||
      typeof sha256 !== "string" ||
      !SHA_256.test(sha256) ||
      !Number.isInteger(manifest.ui_abi) ||
      typeof manifest.min_shell_version !== "string"
    ) return null;
    return {
      sha256,
      uiAbi: manifest.ui_abi as number,
      minShellVersion: manifest.min_shell_version,
    };
  } catch {
    return null;
  }
}

export function decideDesktopUiPublication(
  input: DesktopUiPublicationInput,
): DesktopUiPublicationDecision {
  if (!Number.isInteger(input.uiAbi) || input.uiAbi < 1 || input.uiAbi > 65535) {
    throw new Error("Invalid Desktop UI ABI");
  }
  validateDesktopUpdateVersion(input.minShellVersion);
  if (input.currentManifest === null) return { publish: true, reason: "current-missing" };
  const current = currentReleaseMetadata(input.currentManifest, input.publicKey);
  if (current === null) return { publish: true, reason: "current-invalid" };
  const sha256 = createHash("sha256").update(input.archive).digest("hex");
  if (current.sha256 !== sha256) return { publish: true, reason: "content-changed" };
  if (current.uiAbi !== input.uiAbi || current.minShellVersion !== input.minShellVersion) {
    return { publish: true, reason: "compatibility-changed" };
  }
  return { publish: false, reason: "unchanged" };
}

function run(arguments_: string[]): DesktopUiPublicationDecision {
  const values = new Map<string, string>();
  const allowed = new Set(["--archive", "--manifest", "--public-key", "--ui-abi", "--min-shell-version"]);
  if (arguments_.length !== 10) throw new Error(usage);
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(flag) || !value || values.has(flag)) throw new Error(usage);
    values.set(flag, value);
  }
  const archivePath = values.get("--archive");
  const manifestPath = values.get("--manifest");
  const publicKey = values.get("--public-key");
  const uiAbiText = values.get("--ui-abi");
  const minShellVersion = values.get("--min-shell-version");
  if (!archivePath || !manifestPath || !publicKey || !uiAbiText || !minShellVersion || !/^(0|[1-9]\d*)$/.test(uiAbiText)) {
    throw new Error(usage);
  }
  return decideDesktopUiPublication({
    archive: readFileSync(archivePath),
    currentManifest: readFileSync(manifestPath, "utf8"),
    publicKey,
    uiAbi: Number(uiAbiText),
    minShellVersion,
  });
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(run(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
