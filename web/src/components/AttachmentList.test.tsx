// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Attachment } from "@agentparty/shared";

const signedUrl = "https://files.example.test/image.png?signature=test";

mock.module("../lib/api", () => ({
  fetchAttachmentBlob: mock(async () => new Blob()),
  fetchAttachmentSignedUrl: mock(async () => signedUrl),
  getToken: () => "test-token",
}));

const { AttachmentList } = await import("./AttachmentList");

let renderer: ReactTestRenderer | null = null;

const image: Attachment = {
  key: "channel/id/image.png",
  url: "/api/channels/channel/attachments/id/image.png",
  filename: "image.png",
  content_type: "image/png",
  size: 2048,
};

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("AttachmentList image fallback", () => {
  test("falls back to the file download button when the signed image cannot render", async () => {
    await act(async () => {
      renderer = create(<AttachmentList attachments={[image]} />);
      await Promise.resolve();
    });

    const img = renderer!.root.findByType("img");
    expect(img.props.src).toBe(signedUrl);

    act(() => img.props.onError());

    const fallback = renderer!.root.findByProps({ className: "d-btn msg-attachment-file t-mono" });
    expect(fallback.props.title).toBe("image.png · 2.0 KB · download");
    expect(renderer!.root.findAllByType("img")).toHaveLength(0);
  });
});
