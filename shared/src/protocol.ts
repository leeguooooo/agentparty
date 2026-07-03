// agentparty wire protocol — worker 与 cli 的单一事实来源

// ---- 常量 ----

export const BODY_LIMIT = 100_000;
export const RATE_LIMIT_PER_MIN = 30;
export const LOOP_GUARD_N = 30;
export const RETAIN_N = 10_000;
export const PRESENCE_TIMEOUT_MS = 60_000;

// cli 退出码
export const EXIT_TIMEOUT = 2;
export const EXIT_AUTH = 3;
export const EXIT_LOOP_GUARD = 4;
export const EXIT_ARCHIVED = 5;

// ---- 基础类型 ----

export type SenderKind = "agent" | "human";
export type TokenRole = "agent" | "human" | "readonly";
export type ChannelKind = "standing" | "temp";
export type MessageKind = "message" | "status";

export type StatusState = "working" | "waiting" | "blocked" | "done";
export type PresenceState = StatusState | "offline";

export type ErrorCode =
  | "unauthorized"
  | "rate_limited"
  | "too_large"
  | "loop_guard"
  | "archived"
  | "not_found";

export interface Sender {
  name: string;
  kind: SenderKind;
}

export interface PresenceEntry {
  name: string;
  state: PresenceState;
  note: string | null;
  ts: number;
}

// ---- 客户端 → 服务端帧 ----

export interface HelloFrame {
  type: "hello";
  since: number;
}

export interface SendMessageFrame {
  type: "send";
  kind: "message";
  body: string;
  mentions: string[];
  reply_to: number | null;
}

export interface SendStatusFrame {
  type: "send";
  kind: "status";
  state: StatusState;
  note: string;
}

export type SendFrame = SendMessageFrame | SendStatusFrame;

export interface PingFrame {
  type: "ping";
}

export type ClientFrame = HelloFrame | SendFrame | PingFrame;

// ---- 服务端 → 客户端帧 ----

export interface WelcomeFrame {
  type: "welcome";
  channel: string;
  self: string;
  participants: Sender[];
  last_seq: number;
  presence: PresenceEntry[];
}

export interface MsgFrame {
  type: "msg";
  seq: number;
  sender: Sender;
  kind: MessageKind;
  body: string;
  mentions: string[];
  reply_to: number | null;
  state: StatusState | null;
  note: string | null;
  ts: number;
}

export interface SentFrame {
  type: "sent";
  seq: number;
}

export interface PresenceFrame {
  type: "presence";
  name: string;
  state: PresenceState;
  note: string | null;
  ts: number;
}

export interface ErrorFrame {
  type: "error";
  code: ErrorCode;
  message: string;
}

export interface PongFrame {
  type: "pong";
}

export type ServerFrame =
  | WelcomeFrame
  | MsgFrame
  | SentFrame
  | PresenceFrame
  | ErrorFrame
  | PongFrame;
