// 极简 history 路由：/ 与 /c/:slug 两条。跨路由只保留 ?t= 分享凭据；
// agent / completion 等频道内视图参数不能泄漏到另一个频道。
import { useCallback, useEffect, useState } from "react";

export function routeNavigationTarget(to: string, currentSearch: string): string {
  if (/[?#]/.test(to)) return to;
  const shareToken = new URLSearchParams(currentSearch).get("t");
  if (shareToken === null || shareToken === "") return to;
  const params = new URLSearchParams();
  params.set("t", shareToken);
  return `${to}?${params.toString()}`;
}

export function useRoute(): [string, (to: string) => void, (to: string) => void] {
  const [path, setPath] = useState(() => location.pathname);

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    if (to === location.pathname) return;
    history.pushState(null, "", routeNavigationTarget(to, location.search));
    setPath(to);
  }, []);

  // 替换当前历史项，落到 to 的整串（含 query）——OIDC 回调后清掉 ?code&state 用
  const replace = useCallback((to: string) => {
    history.replaceState(null, "", to);
    setPath(to.split(/[?#]/)[0] ?? to);
  }, []);

  return [path, navigate, replace];
}

export function matchChannel(path: string): string | null {
  const m = path.match(/^\/c\/([a-z0-9][a-z0-9-]*)\/?$/);
  return m?.[1] ?? null;
}

// 邀请链接落地：/join/<code>（code 为 base64url 随机串）。命中则走兑换流程加入私有频道。
export function matchJoin(path: string): string | null {
  const m = path.match(/^\/join\/([A-Za-z0-9_-]+)\/?$/);
  return m?.[1] ?? null;
}

// 外部协作者邀请落地（#593）：/invite/<code>。登录前展示预览，登录后自动兑换（入册+入频道+设昵称）。
export function matchInvite(path: string): string | null {
  const m = path.match(/^\/invite\/([A-Za-z0-9_-]+)\/?$/);
  return m?.[1] ?? null;
}

export function matchPair(path: string): boolean {
  return /^\/pair\/?$/.test(path);
}
