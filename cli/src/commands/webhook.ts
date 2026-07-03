// party webhook add|remove|list — 频道级 webhook 管理
import { parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveAuth } from "../oidc-cli";
import {
  addWebhook,
  handleRestError,
  listWebhooks,
  removeWebhook,
  type WebhookFilter,
} from "../rest";
import { isName, isSlug } from "../validation";

const FILTERS: WebhookFilter[] = ["mentions", "all"];
const WEBHOOK_FLAGS = ["name", "url", "secret", "filter"];
const URL_MAX = 2048;
const SECRET_MAX = 4096;
const HEADER_VALUE_RE = /^[\x21-\x7e]+$/;

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => (p === "" ? NaN : Number(p)));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && nums[2] === 0) ||
    (a === 192 && b === 0 && nums[2] === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && nums[2] === 100) ||
    (a === 203 && b === 0 && nums[2] === 113) ||
    a >= 224
  );
}

function mappedIpv4FromIpv6(host: string): string | null {
  if (!host.startsWith("::ffff:")) return null;
  const tail = host.slice("::ffff:".length);
  if (tail.includes(".")) return tail;
  const parts = tail.split(":");
  if (parts.length !== 2) return null;
  const nums = parts.map((p) => Number.parseInt(p, 16));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  const [hi, lo] = nums as [number, number];
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isBlockedWebhookHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  const isIpv6 = h.includes(":");
  const mapped = isIpv6 ? mappedIpv4FromIpv6(h) : null;
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::" ||
    h === "::1" ||
    (isIpv6 && isIpv6LinkLocal(h)) ||
    (isIpv6 && h.startsWith("fc")) ||
    (isIpv6 && h.startsWith("fd")) ||
    (mapped !== null && isPrivateIpv4(mapped)) ||
    isPrivateIpv4(h)
  );
}

function isIpv6LinkLocal(host: string): boolean {
  const first = host.split(":")[0] ?? "";
  const n = Number.parseInt(first, 16);
  return Number.isInteger(n) && n >= 0xfe80 && n <= 0xfebf;
}

function validWebhookTarget(raw: string): boolean {
  if (raw.length > URL_MAX) return false;
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      u.username === "" &&
      u.password === "" &&
      !isBlockedWebhookHost(u.hostname)
    );
  } catch {
    return false;
  }
}

export async function run(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const unknown = unknownFlagError(flags, WEBHOOK_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["name", "url", "secret", "filter"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const sub = positionals[0];
  const channel = positionals[1];
  if (sub && !channel) {
    console.error("usage: party webhook add|remove|list <channel>");
    return 1;
  }
  if (channel && !isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  try {
    switch (sub) {
      case "add": {
        const name = str(flags.name);
        const url = str(flags.url);
        const secret = str(flags.secret);
        const filter = str(flags.filter) ?? "mentions";
        if (
          !name ||
          !isName(name) ||
          !url ||
          !validWebhookTarget(url) ||
          !secret ||
          secret.length > SECRET_MAX ||
          !HEADER_VALUE_RE.test(secret) ||
          !FILTERS.includes(filter as WebhookFilter)
        ) {
          console.error(
            "usage: party webhook add <channel> --name n --url https://... --secret S [--filter mentions|all]",
          );
          return 1;
        }
        await addWebhook(cfg.server, cfg.token, channel!, {
          name,
          url,
          secret,
          filter: filter as WebhookFilter,
        });
        console.log(`webhook ${name} added to ${channel} (filter: ${filter})`);
        return 0;
      }
      case "remove": {
        const name = str(flags.name);
        if (!name || !isName(name)) {
          console.error("usage: party webhook remove <channel> --name n");
          return 1;
        }
        await removeWebhook(cfg.server, cfg.token, channel!, name);
        console.log(`webhook ${name} removed from ${channel}`);
        return 0;
      }
      case "list": {
        const webhooks = await listWebhooks(cfg.server, cfg.token, channel!);
        for (const w of webhooks) {
          console.log(`${w.name}\t${w.filter}\t${w.url}`);
        }
        return 0;
      }
      default:
        console.error("usage: party webhook add|remove|list <channel>");
        return 1;
    }
  } catch (e) {
    return handleRestError(e);
  }
}
