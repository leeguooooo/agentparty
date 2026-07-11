// party send --attach（#176）：解析 --attach 路径、本地文件 → 上传源、上传并附加到消息。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment } from "@agentparty/shared";
import { parseArgs } from "../src/args";
import { collectAttachments, resolveAttachments, resolveSendInput, sendSpec } from "../src/commands/send";

let dir = "";
let png = "";
let big = "";
let empty = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ap-attach-"));
  png = join(dir, "pic.png");
  big = join(dir, "huge.bin");
  empty = join(dir, "empty.txt");
  await writeFile(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  await writeFile(big, new Uint8Array(25 * 1024 * 1024 + 1));
  await writeFile(empty, new Uint8Array(0));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("send --attach parsing", () => {
  test("--attach is repeatable and collected into attachPaths", async () => {
    const parsed = parseArgs(["hello", "--channel", "c", "--attach", "a.png", "--attach", "b.pdf"], sendSpec);
    const input = await resolveSendInput(parsed);
    expect(input).not.toBeNull();
    expect(input!.attachPaths).toEqual(["a.png", "b.pdf"]);
  });

  test("empty body is allowed when --attach is present", async () => {
    const parsed = parseArgs(["--channel", "c", "--attach", "a.png"], sendSpec);
    const input = await resolveSendInput(parsed);
    expect(input).not.toBeNull();
    expect(input!.body).toBe("");
    expect(input!.attachPaths).toEqual(["a.png"]);
  });

  test("without body or attachments it still errors", async () => {
    const parsed = parseArgs(["--channel", "c"], sendSpec);
    expect(await resolveSendInput(parsed)).toBeNull();
  });
});

describe("resolveAttachments", () => {
  test("reads a real file into an upload source with basename + size + type", async () => {
    const [src] = await resolveAttachments([png]);
    expect(src!.filename).toBe("pic.png");
    expect(src!.size).toBe(8);
    expect(src!.contentType).toBe("image/png");
    expect(src!.bytes.byteLength).toBe(8);
  });

  test("missing file throws a legible not-found error naming the path", async () => {
    await expect(resolveAttachments([join(dir, "nope.png")])).rejects.toThrow(/file not found/i);
  });

  test("oversize file throws max-25MB error", async () => {
    await expect(resolveAttachments([big])).rejects.toThrow(/too large \(max 25MB\)/i);
  });

  test("empty file is rejected", async () => {
    await expect(resolveAttachments([empty])).rejects.toThrow(/empty/i);
  });
});

describe("collectAttachments", () => {
  test("uploads each source and returns the refs in order", async () => {
    const seen: string[] = [];
    const upload = async (
      _server: string,
      _token: string,
      slug: string,
      filename: string,
      _bytes: Uint8Array,
      _contentType: string,
    ): Promise<Attachment> => {
      seen.push(filename);
      return {
        key: `${slug}/uuid/${filename}`,
        filename,
        content_type: "image/png",
        size: 8,
        url: `/api/channels/${slug}/attachments/uuid/${filename}`,
      };
    };
    const sources = await resolveAttachments([png]);
    const refs = await collectAttachments("https://s", "tok", "chan", sources, upload);
    expect(seen).toEqual(["pic.png"]);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.url).toBe("/api/channels/chan/attachments/uuid/pic.png");
  });
});
