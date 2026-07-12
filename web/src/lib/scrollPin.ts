export interface ScrollViewport {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function isNearBottom(viewport: ScrollViewport, threshold = 160): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < threshold;
}

export function pinToBottom(viewport: ScrollViewport, enabled: boolean): boolean {
  if (!enabled) return false;
  viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  return true;
}
