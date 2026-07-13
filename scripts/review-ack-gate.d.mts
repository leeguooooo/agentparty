export interface ReviewAckResult {
  ok: boolean;
  code: string;
  description: string;
  latestAckAt?: number;
  latestBotReviewAt?: number;
}

export function evaluateReviewAck(input: any): ReviewAckResult;
