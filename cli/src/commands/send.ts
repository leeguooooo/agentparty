// party send — rest 一次性发消息，成功后推进游标
import { basename } from "node:path";
import { extractMentionTokens, MAX_MENTIONS, mentionMatchKey, type Attachment } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, strArray, unknownFlagError, valueFlagError, type Parsed } from "../args";
import { advanceCursorPastOwnMessage, resolveChannel, type Config } from "../config";
import { stripTerminalControls } from "../format";
import { formatAuthDebugLine, resolveAuthDetailed } from "../oidc-cli";
import { fetchMe, fetchPresence, handleRestError, postMessage, RestError, uploadAttachment } from "../rest";
import { formatReachLine, reachOf } from "../reach";
import { localStatuslineBase, statuslinePreview, unreadFromCursor, writeStatuslineCache } from "../statusline-cache";
import { isName, isSlug, parsePositiveIntFlag } from "../validation";

export const sendSpec = { repeatable: ["mention", "attach"], booleans: ["debug-auth", "reach", "no-reach"] };
const SEND_FLAGS = ["channel", "reply-to", "mention", "attach", "debug-auth", "reach", "no-reach"];
const HELP = `usage: party send <text|-> [--channel C] [--mention name]... [--attach path]... [--reply-to seq] [--debug-auth]

Send one message to a channel. Use "-" as the body to read stdin.
Positional text decodes \\n as a line break; use \\\\n for a literal \\n, or stdin for exact bytes.

With --attach, each file is uploaded to the channel first, then the message is sent
carrying the attachment refs. Body may be empty when at least one --attach is present.

After a send with --mention, a reachability line prints to stderr — whether each
target is ● online / ◐ wakeable / ○ offline (won't reach until it reconnects).
On by default in an interactive terminal; --reach forces it, --no-reach silences it.

Options:
  --channel C      send to channel C instead of the bound channel
  --mention name   mention a user or agent; repeatable
  --attach path    upload a local file and attach it; repeatable (max 25MB each)
  --reply-to seq   attach this message as a reply to seq
  --reach          show mention reachability even when not a TTY (agent loops)
  --no-reach       never show mention reachability
  --debug-auth     print resolved auth/config source to stderr`;

// 附件上限与文件名规则与 worker 侧保持一致（#176）：本地先挡一刀，给出比服务端 413 更贴切的文案。
const ATTACH_SIZE_LIMIT = 25 * 1024 * 1024;
const ATTACH_FILENAME_RE = /^[^/\\\x00-\x1f\x7f]{1,255}$/;

// 常见类型的扩展名 → MIME 映射；命中不了回退 application/octet-stream，让服务端按 nosniff 处理。
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  json: "application/json",
  csv: "text/csv",
  zip: "application/zip",
  log: "text/plain",
};

function guessContentType(filename: string): string {
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase() : "";
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

export interface AttachSource {
  path: string;
  filename: string;
  size: number;
  contentType: string;
  bytes: Uint8Array;
}

export interface SendInput {
  channel: string;
  body: string;
  mentions: string[];
  replyTo: number | null;
  attachPaths: string[];
}

// Agent-generated shell commands commonly pass multiline replies as one quoted argument containing `\n`.
// Decode only positional text; stdin remains byte-for-byte so code and other literal content always have an exact path.
export function decodePositionalNewlines(input: string): string {
  return input.replace(/(\\+)n/g, (_match, slashes: string) => {
    const prefix = "\\".repeat(Math.floor(slashes.length / 2));
    return prefix + (slashes.length % 2 === 1 ? "\n" : "n");
  });
}

// 本地路径 → 上传源：不存在/空文件/超限一律抛带路径的可读错误，绝不静默上传半个包。
export async function resolveAttachments(paths: string[]): Promise<AttachSource[]> {
  const sources: AttachSource[] = [];
  for (const path of paths) {
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`attach: file not found: ${path}`);
    const filename = basename(path);
    if (!ATTACH_FILENAME_RE.test(filename)) {
      throw new Error(`attach: illegal filename (single path segment, <=255 chars, no control chars): ${filename}`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error(`attach: file is empty: ${path}`);
    if (bytes.byteLength > ATTACH_SIZE_LIMIT) throw new Error(`attach: ${filename}: file too large (max 25MB)`);
    sources.push({ path, filename, size: bytes.byteLength, contentType: guessContentType(filename), bytes });
  }
  return sources;
}

// 逐个上传，保序返回引用。upload 可注入以便测试；默认走 rest.uploadAttachment。
export async function collectAttachments(
  server: string,
  token: string,
  slug: string,
  sources: AttachSource[],
  upload: typeof uploadAttachment = uploadAttachment,
): Promise<Attachment[]> {
  const refs: Attachment[] = [];
  for (const src of sources) {
    refs.push(await upload(server, token, slug, src.filename, src.bytes, src.contentType));
  }
  return refs;
}

// 本地路径 → 已上传引用一条龙（#503）：CLI --attach 与 MCP party_send attach 共用，
// 校验/读文件/逐个上传的语义只有这一份。任一路径失败即整体抛错，不发半套附件。
export async function uploadAttachmentPaths(
  server: string,
  token: string,
  channel: string,
  paths: string[],
  upload: typeof uploadAttachment = uploadAttachment,
): Promise<Attachment[]> {
  const sources = await resolveAttachments(paths);
  return collectAttachments(server, token, channel, sources, upload);
}

export async function resolveSendInput(parsed: Parsed): Promise<SendInput | null> {
  const { positionals, flags } = parsed;
  const unknown = unknownFlagError(flags, SEND_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return null;
  }
  const flagError = valueFlagError(flags, ["channel", "reply-to"], ["mention", "attach"]);
  if (flagError !== null) {
    console.error(flagError);
    return null;
  }
  const attachPaths = strArray(flags.attach) ?? [];
  const replyTo = parsePositiveIntFlag(str(flags["reply-to"]), "reply-to");
  if (typeof replyTo === "string") {
    console.error(replyTo);
    return null;
  }
  const explicit = str(flags.channel);
  // 尾部裸 `-`（未被 `--` 字面化）表示正文来自 stdin；仅在此 stdin 语境下首个 positional 才可作 channel，
  // 即 `send <slug> -`，不给普通 `send <body...>` 重新引入隐式 channel 歧义
  const lastIdx = positionals.length - 1;
  const trailingStdin =
    positionals.length > 0 &&
    positionals[lastIdx] === "-" &&
    !(parsed.terminated && lastIdx >= (parsed.terminatedAt ?? 0));

  let channelArg = explicit;
  let text: string | undefined;
  let readStdin = false;
  if (trailingStdin && !explicit && positionals.length === 2) {
    channelArg = positionals[0]; // send <slug> -
    readStdin = true;
  } else if (trailingStdin && positionals.length === 1) {
    readStdin = true; // send -、send --channel C -、send - --
  } else {
    text = positionals.length > 0 ? decodePositionalNewlines(positionals.join(" ")) : undefined;
  }

  const channel = resolveChannel(channelArg);
  if (!channel) {
    console.error("no channel, pass --channel C or bind with: party init --channel C");
    return null;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return null;
  }
  if (readStdin) {
    text = await Bun.stdin.text();
  } else if (text === undefined) {
    // 纯附件消息（#176）：有 --attach 就允许空正文，与网页端「纯图片消息」一致。
    if (attachPaths.length > 0) {
      text = "";
    } else {
      console.error("missing message body (use - to read stdin, or --attach a file)");
      return null;
    }
  }
  // send footgun 软提示（#6）：无 --channel、≥2 个裸 positional、首个像 slug 且 ≠ 目标频道 →
  // 很可能误把「send <频道> <正文>」当成了子命令用法（首个词其实被并进了正文，发到了绑定频道）。
  // 只提示不拦截：消息照发，仅 stderr 一行帮用户下次用 --channel。
  if (!explicit && !readStdin && positionals.length >= 2 && isSlug(positionals[0]) && positionals[0] !== channel) {
    console.error(
      `note: 正发到绑定频道「${channel}」；若想发到「${positionals[0]}」，用：party send --channel ${positionals[0]} "..."（首个词已被当作正文的一部分）`,
    );
  }
  const explicitMentions = strArray(flags.mention) ?? [];
  if (explicitMentions.some((mention) => !isName(mention))) {
    console.error("--mention must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return null;
  }
  if (explicitMentions.some((mention) => mentionMatchKey(mention) === "system")) {
    console.error("--mention cannot target reserved name system");
    return null;
  }
  // Keep CLI, Web and Worker on the same body-mention contract. Explicit
  // --mention values stay first; body tokens are appended in source order.
  const mentions: string[] = [];
  const seenMentions = new Set<string>();
  for (const mention of explicitMentions) {
    const key = mentionMatchKey(mention);
    if (seenMentions.has(key)) continue;
    seenMentions.add(key);
    mentions.push(mention);
  }
  if (mentions.length > MAX_MENTIONS) {
    console.error(`too many mentions (max ${MAX_MENTIONS})`);
    return null;
  }
  for (const mention of extractMentionTokens(text)) {
    if (mentions.length >= MAX_MENTIONS) break;
    const key = mentionMatchKey(mention);
    if (seenMentions.has(key)) continue;
    seenMentions.add(key);
    mentions.push(mention);
  }
  return {
    channel,
    body: text,
    mentions,
    replyTo: replyTo ?? null,
    attachPaths,
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function doSend(cfg: Config, input: SendInput): Promise<number | { seq: number }> {
  // 先把 --attach 的文件上传到 R2，拿到引用；解析/上传任一失败就直接退，不发一条空引用的消息。
  let attachments: Attachment[] | undefined;
  if (input.attachPaths.length > 0) {
    try {
      attachments = await uploadAttachmentPaths(cfg.server, cfg.token, input.channel, input.attachPaths);
    } catch (e) {
      // 上传阶段 413 给「max 25MB」贴切文案（服务端消息是字节数，可读性差）；
      // 本地校验错（不存在/空文件/超限）带路径直出；其余 REST 错走契约退出码。
      if (e instanceof RestError && (e.code === "too_large" || e.status === 413)) {
        console.error("error: attachment too large (max 25MB)");
        return 1;
      }
      if (e instanceof RestError) return handleRestError(e);
      // 校验错误里带调用方给的路径（MCP 侧也可能传入），照 decision.ts 的 terminalText 惯例剥控制字符。
      console.error(`error: ${stripTerminalControls(e instanceof Error ? e.message : String(e))}`);
      return 1;
    }
    for (const ref of attachments) console.error(`uploaded ${ref.filename} (${formatSize(ref.size)})`);
  }
  try {
    const { seq } = await postMessage(cfg.server, cfg.token, input.channel, {
      kind: "message",
      body: input.body,
      mentions: input.mentions,
      reply_to: input.replyTo,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    });
    advanceCursorPastOwnMessage(input.channel, seq);
    writeStatuslineCache({
      ...localStatuslineBase(input.channel),
      unread: unreadFromCursor(seq, input.channel),
      last_message: {
        from: readLocalIdentityName(cfg) ?? "me",
        ts: Date.now(),
        preview: statuslinePreview(input.body),
      },
    });
    return { seq };
  } catch (e) {
    return handleRestError(e);
  }
}

function readLocalIdentityName(cfg: Config): string | null {
  return cfg.identity?.name ?? null;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv)) {
    console.log(HELP);
    return 0;
  }
  const auth = await resolveAuthDetailed();
  if (!auth.server || !auth.token) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const parsed = parseArgs(argv, sendSpec);
  const input = await resolveSendInput(parsed);
  if (!input) return 1;
  if (parsed.flags["debug-auth"] === true || process.env.AGENTPARTY_DEBUG_AUTH === "1") {
    try {
      console.error(formatAuthDebugLine(auth, await fetchMe(auth.server, auth.token)));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`${formatAuthDebugLine(auth)} runtime-error=${message}`);
    }
  }
  const result = await doSend({ server: auth.server, token: auth.token }, input);
  if (typeof result === "number") return result;
  const attachNote = input.attachPaths.length > 0 ? ` (+${input.attachPaths.length} attachment${input.attachPaths.length > 1 ? "s" : ""})` : "";
  console.log(`sent seq=${result.seq}${attachNote}`);
  await showReach(auth.server, auth.token, parsed, input);
  return 0;
}

// 发送后的可达性反馈：@ 的目标现在能不能收到。默认仅交互终端下开（脚本/agent 循环不额外拉 presence），
// --reach 强开、--no-reach 关。拉不到 presence 不影响已发成功（只是没这行提示）。
async function showReach(server: string, token: string, parsed: Parsed, input: SendInput): Promise<void> {
  const want =
    parsed.flags.reach === true ? true : parsed.flags["no-reach"] === true ? false : Boolean(process.stdout.isTTY);
  if (!want || input.mentions.length === 0) return;
  try {
    const presence = await fetchPresence(server, token, input.channel);
    const now = Date.now();
    console.error(formatReachLine(input.mentions.map((m) => reachOf(m, presence, now))));
  } catch {
    /* 锦上添花：presence 拉取失败不报错，消息已发成功 */
  }
}
