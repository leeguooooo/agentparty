// party channel create|list|archive|reset-guard
import { parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { resolveAuth } from "../oidc-cli";
import {
  archiveChannel,
  createChannel,
  handleRestError,
  kickParticipant,
  listChannels,
  resetGuard,
} from "../rest";
import { isName, isSlug } from "../validation";

const CHANNEL_FLAGS = ["title", "temp", "party", "public"];

export async function run(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { booleans: ["temp", "party", "public"] });
  const unknown = unknownFlagError(flags, CHANNEL_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["title"]);
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
  try {
    switch (sub) {
      case "create": {
        const slug = positionals[1];
        if (!slug) {
          console.error(
            "usage: party channel create <slug> [--title t] [--temp] [--party] [--public]",
          );
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        await createChannel(cfg.server, cfg.token, {
          slug,
          title: str(flags.title),
          kind: flags.temp === true ? "temp" : "standing",
          mode: flags.party === true ? "party" : "normal",
          visibility: flags.public === true ? "public" : "private",
        });
        console.log(`created ${slug}`);
        return 0;
      }
      case "list": {
        const channels = await listChannels(cfg.server, cfg.token);
        for (const c of channels) {
          const state = c.archived_at ? "archived" : "active";
          const vis = c.visibility ?? "private";
          console.log(
            `${c.slug}\t${c.kind}\t${c.mode ?? "normal"}\t${vis}\t${state}\t${c.title ?? ""}`,
          );
        }
        return 0;
      }
      case "archive": {
        const slug = resolveChannel(positionals[1]);
        if (!slug) {
          console.error("usage: party channel archive [slug]");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        await archiveChannel(cfg.server, cfg.token, slug);
        console.log(`archived ${slug}`);
        return 0;
      }
      case "reset-guard": {
        const slug = resolveChannel(positionals[1]);
        if (!slug) {
          console.error("usage: party channel reset-guard [slug]");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        await resetGuard(cfg.server, cfg.token, slug);
        console.log(`guard reset ${slug}`);
        return 0;
      }
      case "kick": {
        const name = positionals[1];
        const slug = resolveChannel(positionals[2]);
        if (!name || !slug) {
          console.error("usage: party channel kick <name> [slug]");
          return 1;
        }
        if (!isName(name)) {
          console.error("name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        await kickParticipant(cfg.server, cfg.token, slug, name);
        console.log(`kicked ${name} from ${slug}`);
        return 0;
      }
      default:
        console.error("usage: party channel create|list|archive|reset-guard|kick");
        return 1;
    }
  } catch (e) {
    return handleRestError(e);
  }
}
