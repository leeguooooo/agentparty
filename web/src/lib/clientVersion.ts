// 发送方 CLI 版本展示 + 落后判定（#434）。
// 消息帧的 sender.client_version 是「发送时快照」；服务端 /api/version 声明当前 min_client_version。
// 低于该下限即视为落后，网页在该条消息旁标警告符号，提示升级。
//
// 版本比较规则与 worker/src/client-version.ts 的 compareClientVersions、cli/src/upgrade.ts 完全一致：
// 只认前三段数字（X.Y.Z），忽略 -beta.1 等预发行后缀，三端对 min-version 的判定不分叉。
import { useEffect, useState } from "react";
import { apiUrl } from "./base";

// a>b→1, a<b→-1, ==→0。
export function compareClientVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 发送方版本严格低于服务端最低版本 → 落后。任一为空则「未知」，一律不判落后（不误伤）。
export function isClientVersionOutdated(version: string | null | undefined, min: string | null | undefined): boolean {
  if (!version || !min) return false;
  return compareClientVersions(version, min) < 0;
}

// 服务端声明的最低客户端版本，全站只拉一次并缓存；解析失败/离线一律回落 null（=未知，不标落后）。
let cachedMin: string | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function fetchMinClientVersion(): Promise<void> {
  if (inflight !== null) return inflight;
  inflight = fetch(apiUrl("/api/version"), { headers: { accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: unknown) => {
      const min =
        data !== null && typeof data === "object" && typeof (data as { min_client_version?: unknown }).min_client_version === "string"
          ? (data as { min_client_version: string }).min_client_version
          : null;
      if (min !== null && min !== cachedMin) {
        cachedMin = min;
        for (const notify of listeners) notify();
      }
    })
    .catch(() => {
      // 版本端点拿不到就当未知——宁可不标落后，也不误报。
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// 读取服务端最低客户端版本。首个消费方触发一次拉取，拉到后所有订阅者一并重渲染。
// 非浏览器环境（如 bun 单测的 react-test-renderer）无 window，直接返回 null，不发网络请求。
export function useMinClientVersion(): string | null {
  const [min, setMin] = useState<string | null>(cachedMin);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setMin(cachedMin);
    listeners.add(update);
    if (cachedMin === null) void fetchMinClientVersion();
    else update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return min;
}
