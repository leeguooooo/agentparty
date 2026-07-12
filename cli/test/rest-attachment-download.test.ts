import { afterEach, describe, expect, test } from "bun:test";
import type { Attachment } from "@agentparty/shared";
import { downloadAttachment } from "../src/rest";

let server: ReturnType<typeof Bun.serve> | null = null;
let redirectTarget: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
  redirectTarget?.stop(true);
  redirectTarget = null;
});

function attachment(url = "/api/channels/dev/attachments/uuid/photo.png"): Attachment {
  return {
    key: "dev/uuid/photo.png",
    filename: "photo.png",
    content_type: "image/png",
    size: 4,
    url,
  };
}

describe("downloadAttachment", () => {
  test("downloads from the authenticated worker route", async () => {
    const captured: { authorization?: string | null; clientVersion?: string | null } = {};
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        captured.authorization = req.headers.get("authorization");
        captured.clientVersion = req.headers.get("x-ap-client-version");
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      },
    });

    const bytes = await downloadAttachment(`http://127.0.0.1:${server.port}`, "ap_secret", "dev", attachment());

    expect(bytes).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(captured.authorization).toBe("Bearer ap_secret");
    expect(captured.clientVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("rejects a ref outside the current channel before sending credentials", async () => {
    let requests = 0;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return new Response("unexpected");
      },
    });

    await expect(
      downloadAttachment(
        `http://127.0.0.1:${server.port}`,
        "ap_secret",
        "dev",
        attachment("/api/channels/other/attachments/uuid/photo.png"),
      ),
    ).rejects.toThrow("outside channel dev");
    expect(requests).toBe(0);
  });

  test("does not follow attachment redirects to another origin", async () => {
    let targetRequests = 0;
    redirectTarget = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        targetRequests++;
        return new Response(new Uint8Array([1, 2, 3, 4]));
      },
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.redirect(`http://127.0.0.1:${redirectTarget!.port}/stolen`, 302);
      },
    });

    await expect(
      downloadAttachment(`http://127.0.0.1:${server.port}`, "ap_secret", "dev", attachment()),
    ).rejects.toThrow();
    expect(targetRequests).toBe(0);
  });
});
