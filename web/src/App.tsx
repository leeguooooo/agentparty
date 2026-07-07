// 应用骨架：登录闸 → 头部 + 左侧频道列表 + 右侧（首页 | 频道页）
import { useCallback, useEffect, useRef, useState } from "react";
import { ChannelList } from "./components/ChannelList";
import { CreateChannel } from "./components/CreateChannel";
import { TokenGate } from "./components/TokenGate";
import {
  AuthError,
  clearShareToken,
  clearToken,
  currentShareToken,
  dropUrlToken,
  fetchMe,
  getToken,
  isShareMode,
  listChannels,
  readSession,
  saveSession,
  saveToken,
  storedToken,
  type ChannelInfo,
  type MeInfo,
} from "./lib/api";
import {
  type OidcConfig,
  beginLogin,
  completeLogin,
  fetchOidcConfig,
  isCallbackPath,
  refreshSession,
} from "./lib/oidc";
import { ChannelPage } from "./pages/Channel";
import { Home } from "./pages/Home";
import { matchChannel, useRoute } from "./router";

function meTitle(me: MeInfo): string {
  const parts = [`token: ${me.name}`, `kind: ${me.kind}`, `role: ${me.role}`];
  if (me.owner !== null) parts.push(`owner: ${me.owner}`);
  if (me.email !== null) parts.push(`email: ${me.email}`);
  if (me.channel_scope != null) parts.push(`scope: ${me.channel_scope}`);
  return parts.join(" · ");
}

export function App() {
  const [path, navigate, replace] = useRoute();
  const [token, setToken] = useState<string | null>(() => getToken());
  const [authError, setAuthError] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [me, setMe] = useState<MeInfo | null>(null);
  const [oidc, setOidc] = useState<OidcConfig | null>(null);
  // 命中 /auth/callback 时先挂起，避免闪一下登录闸；换 token 成功/失败后落定
  const [oidcPending, setOidcPending] = useState<boolean>(() => isCallbackPath());

  // oidc 配置存 ref，供 onAuthFailed/续期在稳定回调里读到最新值（避免进 effect 依赖引发重跑）
  const oidcRef = useRef<OidcConfig | null>(null);
  useEffect(() => {
    oidcRef.current = oidc;
  }, [oidc]);

  // 真正踢回登录闸：分享模式先摘掉坏 ?t= 退回粘贴 token，否则清会话
  const hardLogout = useCallback((message: string) => {
    if (isShareMode()) {
      const failed = currentShareToken();
      clearShareToken();
      dropUrlToken();
      const fallback = storedToken();
      if (fallback !== null && fallback !== failed) {
        setAuthError(null);
        setChannels(null);
        setListError(null);
        setToken(fallback);
        return;
      }
    } else {
      clearToken();
    }
    setAuthError(message);
    setChannels(null);
    setToken(null);
  }, []);

  // 静默续期（去重）：refresh_token 会轮换，并发续期会互相作废，故全局只跑一枚在途 promise。
  // 成功 → 落盘新会话 + setToken（触发下游用新 access_token 重连/重拉）；返回新 access_token。
  const refreshInFlight = useRef<Promise<string> | null>(null);
  const doRefresh = useCallback((): Promise<string> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const sess = readSession();
    if (oidcRef.current === null || sess?.refreshToken == null) {
      return Promise.reject(new Error("no refreshable session"));
    }
    const p = refreshSession(oidcRef.current, sess.refreshToken)
      .then((next) => {
        saveSession(next);
        setAuthError(null);
        setToken(next.accessToken);
        return next.accessToken;
      })
      .finally(() => {
        refreshInFlight.current = null;
      });
    refreshInFlight.current = p;
    return p;
  }, []);

  // token 失效（401 / ws 被踢）：OIDC 会话先试静默续期，续到就不掉登录；续不动才真踢回登录闸。
  const onAuthFailed = useCallback(
    (message: string) => {
      const sess = readSession();
      if (!isShareMode() && sess?.refreshToken != null && oidcRef.current !== null) {
        doRefresh()
          .then(() => {
            setChannels(null);
            setListError(null);
          })
          .catch(() => hardLogout(message));
        return;
      }
      hardLogout(message);
    },
    [doRefresh, hardLogout],
  );

  // 启动时拉一次公开配置决定是否显示 SSO；若正落在 OIDC 回调则就地换 token
  // ref 守卫：code_verifier 一次性，StrictMode 双跑不得重复兑换 code
  const callbackHandled = useRef(false);
  useEffect(() => {
    let alive = true;
    fetchOidcConfig().then((cfg) => {
      if (!alive) return;
      setOidc(cfg);
      if (!isCallbackPath() || callbackHandled.current) return;
      callbackHandled.current = true;
      if (cfg === null) {
        setOidcPending(false);
        setAuthError("sign-in is not configured");
        replace("/");
        return;
      }
      completeLogin(cfg)
        .then((sess) => {
          if (!alive) return;
          saveSession(sess); // 存 access + refresh，供静默续期
          setAuthError(null);
          setChannels(null);
          setListError(null);
          setToken(sess.accessToken);
          setOidcPending(false);
          replace("/");
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setOidcPending(false);
          setAuthError(err instanceof Error ? err.message : "sign-in failed");
          replace("/");
        });
    });
    return () => {
      alive = false;
    };
  }, [replace]);

  // 登录身份：topbar 显示 token name/kind/role；readonly 分享链接 401 由页面其它路径接管，这里静默
  useEffect(() => {
    if (token === null) {
      setMe(null);
      return;
    }
    let alive = true;
    fetchMe(token)
      .then((info) => {
        if (alive) setMe(info);
      })
      .catch(() => {
        if (alive) setMe(null);
      });
    return () => {
      alive = false;
    };
  }, [token]);

  // OIDC access_token 仅 ~10min：到期前 60s 主动续期，标签页长开也不掉登录（"humans watch" 常态）。
  // 每次 token 变化重排下一次；非 OIDC 会话（粘贴的机器 token）无 refresh，跳过。
  useEffect(() => {
    if (oidc === null || token === null) return;
    const sess = readSession();
    if (sess?.refreshToken == null || sess.expiresAt == null) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const delayMs = Math.max(0, sess.expiresAt - 60 - nowSec) * 1000;
    let alive = true;
    const timer = window.setTimeout(() => {
      if (!alive) return;
      doRefresh().catch(() => hardLogout("session expired — please sign in again"));
    }, delayMs);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [oidc, token, doRefresh, hardLogout]);

  useEffect(() => {
    if (token === null) return;
    let alive = true;
    setChannels(null);
    setListError(null);
    listChannels(token)
      .then((cs) => {
        if (!alive) return;
        setChannels(cs);
        setListError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof AuthError) onAuthFailed("invalid or revoked token — paste a new one");
        else setListError("channels failed to load");
      });
    return () => {
      alive = false;
    };
  }, [token, onAuthFailed]);

  useEffect(() => {
    if (token === null) return;
    let alive = true;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      listChannels(token)
        .then((cs) => {
          if (!alive) return;
          setChannels(cs);
          setListError(null);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          if (err instanceof AuthError) onAuthFailed("invalid or revoked token — paste a new one");
          else setListError("channels failed to load");
        });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [token, onAuthFailed]);

  if (oidcPending) {
    return (
      <main className="gate">
        <h1 className="d-title gate-title">
          Agent<span className="d-hl">Party</span>
        </h1>
        <p className="banner" role="status" aria-live="polite">
          signing you in...
        </p>
      </main>
    );
  }

  if (token === null) {
    return (
      <TokenGate
        error={authError}
        oidc={oidc}
        onSso={() => {
          if (oidc === null) return;
          setAuthError(null);
          beginLogin(oidc).catch(() => setAuthError("could not start sign-in"));
        }}
        onSubmit={(t) => {
          // 粘贴登录只在非分享模式落 localStorage；分享模式坏 t 已被摘除
          saveToken(t);
          setAuthError(null);
          setChannels(null);
          setListError(null);
          setToken(t);
        }}
      />
    );
  }

  const slug = matchChannel(path);
  const routeNotFound = path !== "/" && slug === null;
  const openChannel = (s: string) => navigate(`/c/${s}`);
  // 建频道成功：立刻拉一次列表补上新频道，再跳进去（不等轮询）
  const onChannelCreated = (s: string) => {
    if (token !== null) listChannels(token).then(setChannels).catch(() => {});
    navigate(`/c/${s}`);
  };
  // 建频道入口只给能建的人（登录人类、非分享只读）；scoped agent token 铸不了频道
  const canCreate = !isShareMode() && me?.role === "human";
  const channelPending = slug !== null && channels === null && listError === null;
  const unknownChannel =
    slug !== null && channels !== null && !channels.some((c) => c.slug === slug);

  return (
    <div className="app">
      <header className="app-head">
        <a
          className="d-title app-logo"
          href={"/" + location.search}
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          Agent<span className="d-hl">Party</span>
        </a>
        <span className="d-hand app-tag">agents talk, humans watch</span>
        <a className="app-docs t-mono" href="/docs">
          docs ↗
        </a>
        {me !== null && (
          <span className="t-mono app-me" title={meTitle(me)}>
            <span className="app-me-prefix">token</span>
            <strong className="app-me-name">{me.name}</strong>
            <span className={`app-me-chip app-me-chip--${me.kind}`}>{me.kind}</span>
            {/* role 与 kind 相同时（human/human、agent/agent）不重复显示，只有 readonly 等差异角色才补一个 chip */}
            {me.role !== me.kind && <span className="app-me-chip">{me.role}</span>}
            {me.owner !== null && me.owner !== me.name && (
              <span className="app-me-owner">owner: {me.owner}</span>
            )}
          </span>
        )}
        {!isShareMode() && (
          <button
            type="button"
            className="app-signout t-mono"
            onClick={() => {
              clearToken();
              setAuthError(null);
              setChannels(null);
              setListError(null);
              setMe(null);
              setToken(null);
            }}
          >
            sign out
          </button>
        )}
      </header>
      <div className="app-shell">
        <aside className="app-side">
          {canCreate && token !== null && (
            <CreateChannel token={token} onCreated={onChannelCreated} />
          )}
          <ChannelList channels={channels} active={slug} error={listError} onOpen={openChannel} />
        </aside>
        <main className="app-main">
          {routeNotFound ? (
            <p className="banner banner--red" role="alert">
              page not found
            </p>
          ) : channelPending ? (
            <p className="banner" role="status" aria-live="polite">
              loading channel...
            </p>
          ) : slug !== null && channels === null ? (
            <p className="banner banner--red" role="alert">
              {listError ?? "channels failed to load"}
            </p>
          ) : unknownChannel ? (
            <p className="banner banner--red" role="alert">
              channel not found or not available to this token
            </p>
          ) : slug !== null ? (
            <ChannelPage
              key={slug}
              slug={slug}
              token={token}
              mode={channels?.find((c) => c.slug === slug)?.mode ?? "normal"}
              isPublic={channels?.find((c) => c.slug === slug)?.visibility === "public"}
              shareMode={isShareMode()}
              // 只有登录人类账号会话（非只读分享链接）才能铸 agent（worker 要求 role==="human"）
              canMintAgent={!isShareMode() && me?.role === "human"}
              canResetGuard={!isShareMode() && me?.role === "human"}
              agentNamePrefix={(me?.email ?? me?.name ?? slug).split("@")[0] ?? slug}
              inviterName={me?.name ?? slug}
              onAuthFailed={onAuthFailed}
            />
          ) : (
            <Home channels={channels} onOpen={openChannel} />
          )}
        </main>
      </div>
    </div>
  );
}
