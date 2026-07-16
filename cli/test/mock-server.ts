// bun.serve 的 ws mock 服务器，测试用
import type { ClientFrame } from "@agentparty/shared";

export interface MockSocket {
  send(frame: unknown): void;
  close(code?: number, reason?: string): void;
}

export interface MockServer {
  url: string;
  hellos: number[];
  connections: number;
  auths: (string | null)[];
  paths: string[];
  stop(): void;
}

export type FrameHandler = (
  frame: ClientFrame,
  sock: MockSocket,
  connIndex: number,
) => void;

export type OpenHandler = (sock: MockSocket, connIndex: number) => void;

export function startMockServer(onFrame: FrameHandler, onOpen?: OpenHandler): MockServer {
  const hellos: number[] = [];
  const auths: (string | null)[] = [];
  const paths: string[] = [];
  let connections = 0;

  const server = Bun.serve<{ index: number }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      paths.push(new URL(req.url).pathname);
      auths.push(req.headers.get("authorization"));
      if (srv.upgrade(req, { data: { index: connections++ } })) return;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        onOpen?.({
          send: (frame) => ws.send(JSON.stringify(frame)),
          close: (code, reason) => ws.close(code, reason),
        }, ws.data.index);
      },
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as ClientFrame;
        if (frame.type === "hello") hellos.push(frame.since);
        const sock: MockSocket = {
          send: (f) => ws.send(JSON.stringify(f)),
          close: (code, reason) => ws.close(code, reason),
        };
        onFrame(frame, sock, ws.data.index);
      },
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    hellos,
    auths,
    paths,
    get connections() {
      return connections;
    },
    stop() {
      server.stop(true);
    },
  };
}

export function msgFrame(seq: number, body: string, over: Record<string, unknown> = {}) {
  return {
    type: "msg",
    seq,
    sender: { name: "bob", kind: "agent" },
    kind: "message",
    body,
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: Date.now(),
    ...over,
  };
}

export function welcomeFrame(lastSeq: number, self = "me", readCursors?: Array<{ name: string; last_seen_seq: number; updated_at: number }>) {
  return {
    type: "welcome",
    channel: "dev",
    self,
    last_seq: lastSeq,
    presence: [],
    ...(readCursors ? { read_cursors: readCursors } : {}),
  };
}
