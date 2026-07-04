import type { MsgFrame } from "@agentparty/shared";

export function isCompletionMessage(message: MsgFrame): boolean {
  return message.kind === "message" && message.completion_artifact !== undefined;
}

export function completionMessages(messages: MsgFrame[]): MsgFrame[] {
  return messages.filter(isCompletionMessage);
}

