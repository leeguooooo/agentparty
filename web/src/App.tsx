// 应用骨架：登录闸 → 头部 + 左侧频道列表 + 右侧（首页 | 频道页）
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChannelList } from "./components/ChannelList";
import { CreateChannel } from "./components/CreateChannel";
import { DesktopSettings } from "./components/DesktopSettings";
import { DesktopUpdater } from "./components/DesktopUpdater";
import { HandleSetup } from "./components/HandleSetup";
import { TokenGate } from "./components/TokenGate";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
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
  redeemJoinLink,
  saveSession,
  saveToken,
  storedToken,
  type ChannelInfo,
  type MeInfo,
} from "./lib/api";
import {
  type AuthProviderConfig,
  type OidcConfig,
  authConfigForRuntime,
  beginLogin,
  completeLogin,
  decideJoinAuthAction,
  fetchAuthConfig,
  isCallbackPath,
  refreshSession,
} from "./lib/oidc";
import { ChannelPage } from "./pages/Channel";
import { Home } from "./pages/Home";
import { matchChannel, matchJoin, useRoute } from "./router";
import { useT } from "./i18n/useT";
import "./i18n/strings/App";

// 邀请链接兑换：未登录时跳 OIDC 会离开页面，用 sessionStorage 把 code 带过登录、回来接着兑换。
const PENDING_JOIN_KEY = "ap_pending_join";

function meTitle(me: MeInfo): string {
  const parts = [`token: ${me.name}`, `kind: ${me.kind}`, `role: ${me.role}`];
  if (me.display_name !== null) parts.push(`display: ${me.display_name}`);
  if (me.owner !== null) parts.push(`owner: ${me.owner}`);
  if (me.email !== null) parts.push(`email: ${me.email}`);
  if (me.provider !== null) parts.push(`provider: ${me.provider}`);
  if (me.channel_scope != null) parts.push(`scope: ${me.channel_scope}`);
  return parts.join(" · ");
}

export function App() {
  const t = useT();
  const [path, navigate, replace] = useRoute();
  const [token, setToken] = useState<string | null>(() => getToken());
  const [authError, setAuthError] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [me, setMe] = useState<MeInfo | null>(null);
  const [oidc, setOidc] = useState<OidcConfig | null>(null);
  const [authProviders, setAuthProviders] = useState<AuthProviderConfig[]>([]);
  const [authProvidersResolved, setAuthProvidersResolved] = useState(false);
  // 邀请链接落地页状态（/join/<code>）：正在加入 / 失败
  const [joinStatus, setJoinStatus] = useState<{ phase: "joining" | "error"; message?: string } | null>(null);
  // 命中 /auth/callback 时先挂起，避免闪一下登录闸；换 token 成功/失败后落定
  const [oidcPending, setOidcPending] = useState<boolean>(() => isCallbackPath());

  // 人类账号设置/修改 @handle（Task B2）：me chip 旁的入口开关 + 浮层定位（fixed + 视口内钳制，
  // 手法同 AgentTokens 那次 viewport 修复）；banner 关闭态只在本次会话内记，不落盘。
  const [handleSetupOpen, setHandleSetupOpen] = useState(false);
  const [handlePanelStyle, setHandlePanelStyle] = useState<CSSProperties>({});
  const [handleBannerDismissed, setHandleBannerDismissed] = useState(false);
  const handleAnchorRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    if (!handleSetupOpen) return;
    const update = () => {
      const anchor = handleAnchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const gap = 6;
      const margin = 12;
      const width = Math.min(320, window.innerWidth - margin * 2);
      const top = Math.min(anchor.bottom + gap, window.innerHeight - margin);
      const left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin));
      const maxHeight = Math.max(160, window.innerHeight - top - margin);
      setHandlePanelStyle({ left, top, width, maxHeight });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [handleSetupOpen]);

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

  // 启动时拉一次公开配置决定是否显示 SSO；若正落在 OAuth/OIDC 回调则就地换 token
  // ref 守卫：code_verifier 一次性，StrictMode 双跑不得重复兑换 code
  const callbackHandled = useRef(false);
  useEffect(() => {
    let alive = true;
    fetchAuthConfig().then((cfg) => {
      if (!alive) return;
      const runtimeConfig = authConfigForRuntime(cfg);
      setOidc(runtimeConfig.oidc);
      setAuthProviders(runtimeConfig.providers);
      setAuthProvidersResolved(true);
      if (!isCallbackPath() || callbackHandled.current) return;
      callbackHandled.current = true;
      if (runtimeConfig.providers.length === 0) {
        setOidcPending(false);
        setAuthError("sign-in is not configured");
        replace("/");
        return;
      }
      completeLogin(runtimeConfig.providers)
        .then((sess) => {
          if (!alive) return;
          saveSession(sess); // 存 access + refresh，供静默续期
          setAuthError(null);
          setChannels(null);
          setListError(null);
          setToken(sess.accessToken);
          setOidcPending(false);
          // 若登录前是去兑换邀请链接，回到 /join/<code> 让下面的 effect（此时已有 token）完成加入
          const pendingJoin = sessionStorage.getItem(PENDING_JOIN_KEY);
          replace(pendingJoin ? `/join/${pendingJoin}` : "/");
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

  // 邀请链接落地：访问 /join/<code> 时——已登录则直接兑换（加入频道→跳进去）；未登录则存下 code
  // 并跳 OIDC 登录，回来后 callback 会重新落到 /join/<code>、此时有 token 走兑换分支。
  const joinCode = matchJoin(path);
  const joinAuthAction = decideJoinAuthAction({
    joinCode,
    hasToken: token !== null,
    providerAvailable: authProviders.length > 0,
    providersResolved: authProvidersResolved,
    providerLoginPending: oidcPending,
  });
  useEffect(() => {
    if (joinCode === null) return;
    if (joinAuthAction === "redeem" && token !== null) {
      sessionStorage.removeItem(PENDING_JOIN_KEY);
      setJoinStatus({ phase: "joining" });
      let alive = true;
      redeemJoinLink(token, joinCode)
        .then(async (r) => {
          if (!alive) return;
          // 新加入的频道要重新拉列表才在侧栏/路由里认得（否则跳进去会「not available」）。
          // 显式等这次拉取完成再跳，别依赖 setChannels(null) 触发——那样有竞态。
          try {
            const next = await listChannels(token);
            if (alive) setChannels(next);
          } catch {
            // 列表拉取失败不阻塞跳转，频道页自己还会重试
          }
          if (!alive) return;
          setJoinStatus(null);
          replace(`/c/${r.channel_slug}`);
        })
        .catch((e: unknown) => {
          if (alive) setJoinStatus({ phase: "error", message: e instanceof Error ? e.message : t("App.join.failed") });
        });
      return () => {
        alive = false;
      };
    }
    if (joinAuthAction === "begin-provider-login") {
      const primaryProvider = authProviders[0];
      if (primaryProvider === undefined) return;
      // 浏览器未登录：存 code 跨登录重定向，跳 provider 登录。
      sessionStorage.setItem(PENDING_JOIN_KEY, joinCode);
      beginLogin(primaryProvider).catch(() => setJoinStatus({ phase: "error", message: t("App.join.loginFailed") }));
    }
  }, [joinCode, joinAuthAction, token, authProviders, replace, t]);

  // 登录身份：topbar 显示 token name/kind/role；readonly 分享链接 401 由页面其它路径接管，这里静默
  useEffect(() => {
    if (token === null) {
      setMe(null);
      setHandleSetupOpen(false);
      setHandleBannerDismissed(false);
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

  // 无 redirect provider 的 runtime 原地显示 TokenGate；粘贴 token 后仍在 /join/<code>，effect 接着兑换。
  if (joinCode !== null && joinAuthAction !== "request-token-login") {
    return (
      <main className="gate">
        <h1 className="d-title gate-title">
          Agent<span className="d-hl">Party</span>
        </h1>
        {joinStatus?.phase === "error" ? (
          <>
            <p className="banner banner--red" role="alert">
              {joinStatus.message ?? t("App.join.failed")}
            </p>
            <button type="button" className="d-btn" onClick={() => replace("/")}>
              {t("App.join.backHome")}
            </button>
          </>
        ) : (
          <p className="banner" role="status" aria-live="polite">
            {t("App.join.joining")}
          </p>
        )}
      </main>
    );
  }

  if (token === null) {
    return (
      <TokenGate
        error={authError}
        providers={authProviders}
        onSso={(provider) => {
          setAuthError(null);
          beginLogin(provider).catch(() => setAuthError("could not start sign-in"));
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
  // 设置/修改 @handle 只给登录人类账号（agent token 会话、分享只读链接都不显示，Task B2）
  const canSetHandle = !isShareMode() && me?.role === "human";
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
            {me.avatar_thumb !== null || me.avatar_url !== null ? (
              <img className="app-me-avatar" src={me.avatar_thumb ?? me.avatar_url ?? ""} alt="" />
            ) : null}
            <span className="app-me-prefix">token</span>
            <strong className="app-me-name">{me.display_name ?? me.handle ?? me.name}</strong>
            <span className={`app-me-chip app-me-chip--${me.kind}`}>{me.kind}</span>
            {/* role 与 kind 相同时（human/human、agent/agent）不重复显示，只有 readonly 等差异角色才补一个 chip */}
            {me.role !== me.kind && <span className="app-me-chip">{me.role}</span>}
            {me.owner !== null && me.owner !== me.name && (
              <span className="app-me-owner">owner: {me.owner}</span>
            )}
          </span>
        )}
        {canSetHandle && me !== null && (
          <span className="handlesetup-anchor" ref={handleAnchorRef}>
            <button
              type="button"
              className={"d-btn handlesetup-trigger" + (me.handle === null ? " handlesetup-trigger--cta" : "")}
              onClick={() => setHandleSetupOpen((v) => !v)}
              aria-expanded={handleSetupOpen}
              title={me.handle !== null ? t("App.handle.editHint") : t("App.handle.setCta")}
            >
              <span className="handlesetup-trigger-edit" aria-hidden="true">
                ✎
              </span>
              {me.handle !== null ? (
                <>
                  <span className="handlesetup-trigger-label">{t("App.handle.chipLabel")}</span>
                  <span className="handlesetup-trigger-value">{me.handle}</span>
                </>
              ) : (
                <span className="handlesetup-trigger-value">{t("App.handle.chipUnset")}</span>
              )}
            </button>
          </span>
        )}
        {handleSetupOpen && me !== null && (
          <div className="handlesetup-panel" style={handlePanelStyle}>
            <HandleSetup
              current={me.handle}
              onSaved={(handle) => {
                setMe((prev) => (prev ? { ...prev, handle } : prev));
                setHandleSetupOpen(false);
                setHandleBannerDismissed(true);
              }}
              onClose={() => setHandleSetupOpen(false)}
            />
          </div>
        )}
        <DesktopSettings />
        <DesktopUpdater />
        <LanguageSwitcher />
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
              setHandleSetupOpen(false);
              setHandleBannerDismissed(false);
              setToken(null);
            }}
          >
            sign out
          </button>
        )}
      </header>
      {canSetHandle && me !== null && me.handle === null && !handleBannerDismissed && !handleSetupOpen && (
        <p className="banner banner--yellow handle-banner" role="status">
          <span className="handle-banner-text">{t("App.handle.banner")}</span>
          <span className="handle-banner-actions">
            <button type="button" className="d-btn" onClick={() => setHandleSetupOpen(true)}>
              {t("App.handle.bannerAction")}
            </button>
            <button
              type="button"
              className="d-btn handle-banner-dismiss"
              onClick={() => setHandleBannerDismissed(true)}
              aria-label={t("App.handle.bannerDismiss")}
            >
              ✕
            </button>
          </span>
        </p>
      )}
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
              loopGuardEnabled={channels?.find((c) => c.slug === slug)?.loop_guard_enabled === 1}
              loopGuardLimit={channels?.find((c) => c.slug === slug)?.loop_guard_limit ?? null}
              workflowGuardEnabled={channels?.find((c) => c.slug === slug)?.workflow_guard_enabled === 1}
              workflowGuardLimit={channels?.find((c) => c.slug === slug)?.workflow_guard_limit ?? 30}
              shareMode={isShareMode()}
              // 只有登录人类账号会话（非只读分享链接）才能铸 agent（worker 要求 role==="human"）
              canMintAgent={!isShareMode() && me?.role === "human"}
              canResetGuard={!isShareMode() && me?.role === "human"}
              // 可见性切换是 owner 专属：服务端算好的 can_moderate 决定渲不渲染（非 owner 不显会 403 的按钮）
              canModerate={channels?.find((c) => c.slug === slug)?.can_moderate === true}
              agentNamePrefix={(me?.email ?? me?.name ?? slug).split("@")[0] ?? slug}
              accountKey={me?.email ?? me?.owner ?? me?.name ?? null}
              inviterName={me?.name ?? slug}
              selfHandle={me?.handle ?? null}
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
