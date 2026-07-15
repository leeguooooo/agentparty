// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { beforeEach, describe, expect, mock, test } from "bun:test";

const signedCalls: Array<{ token: string; url: string }> = [];
const blobCalls: Array<{ token: string | null; url: string }> = [];
let signedFailure = false;

mock.module("../lib/api", () => ({
  getToken: () => null,
  fetchAttachmentSignedUrl: async (token: string, url: string) => {
    signedCalls.push({ token, url });
    if (signedFailure) throw new Error("old worker");
    return "https://ap.test/signed";
  },
  fetchAttachmentBlob: async (token: string | null, url: string) => {
    blobCalls.push({ token, url });
    return new Blob(["proof"]);
  },
}));

const { resolveAttachmentDownloadUrl } = await import("./AttachmentList");

beforeEach(() => {
  signedCalls.length = 0;
  blobCalls.length = 0;
  signedFailure = false;
  URL.createObjectURL = mock(() => "blob:authenticated-fallback");
});

describe("attachment downloads (#521)", () => {
  test("uses a signed URL when the worker supports it", async () => {
    expect(await resolveAttachmentDownloadUrl("token", "/attachment")).toEqual({
      href: "https://ap.test/signed",
      revoke: false,
    });
    expect(signedCalls).toEqual([{ token: "token", url: "/attachment" }]);
    expect(blobCalls).toEqual([]);
  });

  test("falls back to an authenticated blob when signed URL exchange fails", async () => {
    signedFailure = true;
    expect(await resolveAttachmentDownloadUrl("token", "/attachment")).toEqual({
      href: "blob:authenticated-fallback",
      revoke: true,
    });
    expect(blobCalls).toEqual([{ token: "token", url: "/attachment" }]);
  });
});
