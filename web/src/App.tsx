// 应用骨架：登录闸 → 头部 + 左侧频道列表 + 右侧（首页 | 频道页）
import { isMember } from "@agentparty/shared";
import { membershipApplyMailto, membershipStatusOf } from "./lib/membership";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChannelList } from "./components/ChannelList";
import { CreateChannel } from "./components/CreateChannel";
import { DesktopSettings } from "./components/DesktopSettings";
import { reportDesktopUiReady } from "./lib/desktopUi";
import { DesktopDownloadLink } from "./components/DesktopDownloadLink";
import { DesktopInvitePaste } from "./components/DesktopInvitePaste";
import { DesktopPairingGate } from "./components/DesktopPairingGate";
import { DesktopUpdater } from "./components/DesktopUpdater";
import { TokenGate } from "./components/TokenGate";
import { SettingsPanel, type SettingsSectionId } from "./components/SettingsPanel";
import { LocalAgentCenter } from "./components/LocalAgentCenter";
import { OnboardingGuide } from "./components/OnboardingGuide";
import { NotifyToggle, readNotifyOptin } from "./components/NotifyToggle";
import { ServerProfileAddGate, ServerSwitcher } from "./components/ServerProfiles";
import {
  applyShareToken,
  AuthError,
  type ChannelInfo,
  type ChannelJoinRequest,
  type ChannelJoinRequestState,
  clearShareToken,
  clearToken,
  currentShareToken,
  createChannelJoinRequest,
  dropUrlToken,
  fetchMe,
  getToken,
  getMyChannelJoinRequest,
  InviteRequiredError,
  isShareMode,
  listChannels,
  type MeInfo,
  readSession,
  redeemJoinLink,
  saveSession,
  saveToken,
  storedToken,
  suspendShareMode,
} from "./lib/api";
import {
  clearJoinRequestTarget,
  clearPendingJoinRequest,
  readJoinRequestTarget,
  readPendingJoinRequest as loadPendingJoinRequest,
  rememberJoinRequestTarget,
  savePendingJoinRequest,
} from "./lib/joinRequestPending";
import {
  authConfigForRuntime,
  type AuthProviderConfig,
  beginLogin,
  completeLogin,
  decideJoinAuthAction,
  fetchAuthConfig,
  isCallbackPath,
  type OidcConfig,
  refreshSession,
  type WebSession,
} from "./lib/oidc";
import { withRefreshLock } from "./lib/refreshLock";
import {
  clearPendingPairing,
  readPendingPairing,
  rememberPendingPairing,
} from "./lib/pairingPending";
import { gateSession, jwtSub } from "./lib/sessionIdentity";
import {
  classifyDesktopRestoreFailure,
  initialTokenForRuntime,
  restoreDesktopAccess,
  restoreDesktopAccessInteractive,
  type DesktopRestoreFailure,
} from "./lib/desktopAuth";
import {
  desktopCredentialVaultForOrigin,
  logoutDesktopSession,
  migrateLegacyDesktopCredential,
} from "./lib/desktopCredentials";
import {
  isDesktopRuntime,
  listenForDesktopChannelLinks,
  listenForDesktopNotificationActions,
  showAndFocusDesktopWindow,
  waitForDesktopWindowShown,
} from "./lib/desktopRuntime";
import type { ChannelDeepLink } from "./lib/channelLink";
import { setApiBase } from "./lib/base";
import {
  addCustomServerProfile,
  loadActiveServerOrigin,
  loadServerProfiles,
  normalizeServerOrigin,
  saveActiveServerOrigin,
  type ServerProfile,
} from "./lib/serverProfiles";
import {
  activateDesktopServerWithAccessToken,
  beginDesktopServerAdd,
  beginDesktopServerPairing,
  cancelDesktopServerPairing,
  completeDesktopServerPairing,
  initialDesktopServerPairingFlow,
  switchActiveDesktopServer,
} from "./lib/serverSwitch";
import { ChannelPage } from "./pages/Channel";
import { Home } from "./pages/Home";
import { extractPairingCodeAndSanitizeUrl, PairPage } from "./pages/Pair";
import { matchChannel, matchInvite, matchJoin, matchPair, useRoute } from "./router";
import { InviteLanding, InviteRequiredGate } from "./components/InviteLanding";
import { useT } from "./i18n/useT";
import "./i18n/strings/App";

// 邀请链接兑换：未登录时跳 OIDC 会离开页面，用 sessionStorage 把 code 带过登录、回来接着兑换。
const PENDING_JOIN_KEY = "ap_pending_join";
// 外部协作者邀请（#593）：/invite/<code> 同款跨登录暂存。
const PENDING_INVITE_KEY = "ap_pending_invite";
function meTitle(me: MeInfo): string {
  const parts = [`token: ${me.name}`, `kind: ${me.kind}`, `role: ${me.role}`];
  if (me.display_name !== null) parts.push(`display: ${me.display_name}`);
  if (me.owner !== null) parts.push(`owner: ${me.owner}`);
  if (me.email !== null) parts.push(`email: ${me.email}`);
  if (me.provider !== null) parts.push(`provider: ${me.provider}`);
  if (me.channel_scope != null) parts.push(`scope: ${me.channel_scope}`);
  return parts.join(" · ");
}

function DesktopRecoveryUpdater() {
  return (
    <aside className="desktop-recovery-updater">
      <DesktopUpdater />
    </aside>
  );
}

export function App() {
  useEffect(() => {
    void reportDesktopUiReady();
  }, []);

  const t = useT();
  const [path, navigate, replace] = useRoute();
  const desktop = useRef(isDesktopRuntime()).current;
  const [serverProfiles, setServerProfiles] = useState<ServerProfile[]>(() => loadServerProfiles());
  const [activeOrigin, setActiveOrigin] = useState<string>(() => {
    const origin = loadActiveServerOrigin();
    if (desktop) setApiBase(origin);
    return origin;
  });
  const [serverPairingFlow, setServerPairingFlow] = useState(() => initialDesktopServerPairingFlow(activeOrigin));
  const [token, setToken] = useState<string | null>(() => initialTokenForRuntime(desktop, getToken));
  // A desktop watch invite deliberately enters share mode, but every successful Keychain/pairing
  // restore is an explicit return to the signed-in human session. Clear both the in-memory and
  // sessionStorage share markers before installing that credential, otherwise ChannelSocket sends
  // the human token through the readonly query-token path while the rest of the app treats it as owner.
  const activateDesktopHumanSession = useCallback((accessToken: string) => {
    clearShareToken();
    setToken(accessToken);
  }, []);
  // 本标签当前身份（access token 的 sub）。共享 localStorage 里的 session 是否可用，
  // 必须与它比对——只比 token 字符串没用：同身份续期后 access token 本来就会变。
  const identityRef = useRef<string | null>(null);
  identityRef.current = jwtSub(token);
  const [authError, setAuthError] = useState<string | null>(null);
  const [desktopBoot, setDesktopBoot] = useState<"loading" | "ready" | "error">(desktop ? "loading" : "ready");
  const [desktopRestoreFailure, setDesktopRestoreFailure] = useState<DesktopRestoreFailure>("retryable");
  const [desktopNotice, setDesktopNotice] = useState<string | null>(null);
  const [desktopLogoutPending, setDesktopLogoutPending] = useState(false);
  const [channels, setChannels] = useState<ChannelInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const channelReloadGeneration = useRef(0);
  const channelReloadInFlight = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const [me, setMe] = useState<MeInfo | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [notifyOptin, setNotifyOptin] = useState<boolean>(() => readNotifyOptin());
  const [oidc, setOidc] = useState<OidcConfig | null>(null);
  const [authProviders, setAuthProviders] = useState<AuthProviderConfig[]>([]);
  const [authProvidersResolved, setAuthProvidersResolved] = useState(false);
  // 邀请链接落地页状态（/join/<code>）：正在加入 / 失败
  const [joinStatus, setJoinStatus] = useState<{ phase: "joining" | "error"; message?: string } | null>(null);
  // 实例邀请制（#593）：登录有效但未入册（403 invite_required）→ 渲染邀请码输入门
  const [inviteRequired, setInviteRequired] = useState(false);
  const [channelJoinRequest, setChannelJoinRequest] = useState<{
    slug: string;
    state: ChannelJoinRequestState | "submitting" | "login_required" | "error";
    reason?: string | null;
    message?: string;
  } | null>(() => {
    const slug = readJoinRequestTarget();
    return slug === null ? null : { slug, state: "submitting" };
  });
  // 命中 /auth/callback 时先挂起，避免闪一下登录闸；换 token 成功/失败后落定
  const [oidcPending, setOidcPending] = useState<boolean>(() => isCallbackPath());
  const [initialPairCode] = useState<string | null>(() => {
    let stored = readPendingPairing(sessionStorage).code;
    if (matchPair(location.pathname)) {
      const pairOrigin = normalizeServerOrigin(location.origin);
      const consumed = extractPairingCodeAndSanitizeUrl(location.href);
      history.replaceState(null, "", consumed.sanitizedPath);
      const pending = rememberPendingPairing(sessionStorage, {
        ...(pairOrigin === null ? {} : { serverOrigin: pairOrigin }),
        ...(consumed.userCode === null ? {} : { code: consumed.userCode }),
      });
      stored = pending.code;
    }
    return stored;
  });

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    let stop = () => {};
    void listenForDesktopNotificationActions(({ slug, seq }) => {
      void showAndFocusDesktopWindow();
      navigate(`/c/${slug}`);
      window.location.hash = `#msg-${seq}`;
    }).then((unlisten) => {
      if (alive) stop = unlisten;
      else unlisten();
    });
    return () => {
      alive = false;
      stop();
    };
  }, [desktop, navigate]);

  const restoreDesktop = useCallback(() => {
    setDesktopBoot("loading");
    setDesktopNotice(null);
    return restoreDesktopAccess(desktopCredentialVaultForOrigin(activeOrigin), activeOrigin)
      .then((accessToken) => {
        if (accessToken !== null) activateDesktopHumanSession(accessToken);
        setDesktopRestoreFailure("retryable");
        setDesktopBoot("ready");
        return accessToken;
      })
      .catch((cause: unknown) => {
        setToken(null);
        setDesktopRestoreFailure(classifyDesktopRestoreFailure(cause));
        setDesktopBoot("error");
        throw cause;
      });
  }, [activeOrigin, activateDesktopHumanSession]);

  const restoreDesktopInteractive = useCallback(() => {
    setDesktopBoot("loading");
    setDesktopNotice(null);
    return restoreDesktopAccessInteractive(desktopCredentialVaultForOrigin(activeOrigin), activeOrigin)
      .then((accessToken) => {
        if (accessToken !== null) activateDesktopHumanSession(accessToken);
        setDesktopRestoreFailure("retryable");
        setDesktopBoot("ready");
        return accessToken;
      })
      .catch((cause: unknown) => {
        setToken(null);
        setDesktopRestoreFailure(classifyDesktopRestoreFailure(cause));
        setDesktopBoot("error");
        throw cause;
      });
  }, [activeOrigin, activateDesktopHumanSession]);

  // 桌面版贴观看邀请链接（#297）：/c/<slug>?t=<token> 的观看 token 直接落进分享态（复用 #186），
  // 换成只读会话打开频道——与网页命中 ?t= 等价，只是桌面没有地址栏，token 从粘贴框进来。
  const enterWatchInvite = useCallback(
    (slug: string, watchToken: string) => {
      applyShareToken(watchToken);
      setAuthError(null);
      setChannels(null);
      setListError(null);
      setMe(null);
      setToken(watchToken);
      navigate(`/c/${slug}`);
    },
    [navigate],
  );

  const temporaryHumanToken = useCallback(async (): Promise<string | null> => {
    if (desktop) {
      return restoreDesktopAccess(desktopCredentialVaultForOrigin(activeOrigin), activeOrigin);
    }
    return readSession()?.accessToken ?? null;
  }, [activeOrigin, desktop]);

  useEffect(() => {
    const slug = readJoinRequestTarget();
    if (slug === null || loadPendingJoinRequest() !== null || channelJoinRequest?.slug !== slug || channelJoinRequest.state !== "submitting") return;
    let alive = true;
    temporaryHumanToken()
      .then((humanToken) => {
        if (humanToken === null) throw new Error("human session unavailable");
        return getMyChannelJoinRequest(humanToken, slug);
      })
      .then((request) => {
        if (alive) setChannelJoinRequest({ slug, state: request.state, reason: request.review_reason });
      })
      .catch(() => {
        if (alive) setChannelJoinRequest({ slug, state: "error", message: t("Channel.joinRequest.error") });
      });
    return () => { alive = false; };
  }, [channelJoinRequest?.slug, channelJoinRequest?.state, t, temporaryHumanToken]);

  const submitPendingChannelJoinRequest = useCallback(async (
    humanToken: string,
    pending = loadPendingJoinRequest(),
  ): Promise<ChannelJoinRequest | null> => {
    if (pending === null) return null;
    const watchToken = currentShareToken();
    if (watchToken === null) {
      setChannelJoinRequest({ slug: pending.slug, state: "error", message: t("Channel.joinRequest.error") });
      return null;
    }
    setChannelJoinRequest({ slug: pending.slug, state: "submitting" });
    try {
      const request = await createChannelJoinRequest(humanToken, pending.slug, watchToken, pending.note);
      rememberJoinRequestTarget(pending.slug);
      clearPendingJoinRequest();
      setChannelJoinRequest({ slug: pending.slug, state: request.state, reason: request.review_reason });
      return request;
    } catch (cause) {
      setChannelJoinRequest({
        slug: pending.slug,
        state: "error",
        message: cause instanceof Error ? cause.message : t("Channel.joinRequest.error"),
      });
      return null;
    } finally {
      // Human auth is deliberately temporary until approval. Keep the live ChannelPage on the watch credential.
      applyShareToken(watchToken);
      setToken(watchToken);
    }
  }, [t]);

  const requestChannelJoin = useCallback(async (note: string): Promise<void> => {
    const slug = matchChannel(path);
    const watchToken = currentShareToken();
    if (slug === null || watchToken === null) return;
    savePendingJoinRequest({ slug, note });
    const humanToken = await temporaryHumanToken().catch(() => null);
    if (humanToken !== null) {
      await submitPendingChannelJoinRequest(humanToken);
      return;
    }
    if (desktop) {
      setChannelJoinRequest({ slug, state: "error", message: t("Channel.joinRequest.desktopAuthRequired") });
      return;
    }
    setChannelJoinRequest({ slug, state: "login_required" });
    suspendShareMode();
    dropUrlToken();
    setAuthError(null);
    setMe(null);
    setToken(null);
  }, [desktop, path, submitPendingChannelJoinRequest, temporaryHumanToken, t]);

  useEffect(() => {
    const pending = loadPendingJoinRequest();
    if (pending === null || token === null || isShareMode()) return;
    void submitPendingChannelJoinRequest(token, pending);
  }, [submitPendingChannelJoinRequest, token]);

  const beginChannelJoinLogin = useCallback((provider: AuthProviderConfig) => {
    const pending = loadPendingJoinRequest();
    if (pending === null) return;
    setChannelJoinRequest({ slug: pending.slug, state: "submitting" });
    beginLogin(provider).catch(() => {
      setChannelJoinRequest({ slug: pending.slug, state: "error", message: t("App.error.startSignInFailed") });
    });
  }, [t]);

  const refreshChannelJoinRequest = useCallback(async (): Promise<void> => {
    const slug = matchChannel(path);
    if (slug === null) return;
    setChannelJoinRequest((current) => ({ slug, state: "submitting", reason: current?.reason }));
    const humanToken = await temporaryHumanToken().catch(() => null);
    if (humanToken === null) {
      setChannelJoinRequest({ slug, state: desktop ? "error" : "login_required", message: desktop ? t("Channel.joinRequest.desktopAuthRequired") : undefined });
      return;
    }
    try {
      const request = await getMyChannelJoinRequest(humanToken, slug);
      setChannelJoinRequest({ slug, state: request.state, reason: request.review_reason });
    } catch (cause) {
      setChannelJoinRequest({ slug, state: "error", message: cause instanceof Error ? cause.message : t("Channel.joinRequest.error") });
    }
  }, [desktop, path, temporaryHumanToken, t]);

  const enterApprovedChannel = useCallback(async (): Promise<void> => {
    const slug = matchChannel(path);
    if (slug === null) return;
    const humanToken = await temporaryHumanToken().catch(() => null);
    if (humanToken === null) {
      setChannelJoinRequest({ slug, state: "error", message: t("Channel.joinRequest.humanSessionMissing") });
      return;
    }
    clearPendingJoinRequest();
    clearJoinRequestTarget();
    clearShareToken();
    dropUrlToken();
    setChannelJoinRequest(null);
    setChannels(null);
    setListError(null);
    setMe(null);
    setToken(humanToken);
    replace(`/c/${slug}`);
  }, [path, replace, temporaryHumanToken, t]);

  // destination 缺省回 Home；跨实例直达频道时传 `/c/<slug>`，让「切实例」和「落频道」在同一次
  // replace 里完成——否则先 replace("/") 再由外层微任务 navigate，中间会闪一帧空 channels 的 Home。
  const switchDesktopOrigin = useCallback(async (origin: string, restoredAccessToken?: string, destination = "/") => {
    const result = restoredAccessToken === undefined
      ? await switchActiveDesktopServer(origin)
      : activateDesktopServerWithAccessToken(origin, restoredAccessToken);
    setActiveOrigin(result.origin);
    setServerPairingFlow(initialDesktopServerPairingFlow(result.origin));
    setAuthError(null);
    setChannels(null);
    setListError(null);
    setMe(null);
    activateDesktopHumanSession(result.accessToken);
    setDesktopBoot("ready");
    replace(destination);
  }, [activateDesktopHumanSession, replace]);

  // 桌面版：外部工具（如 claude-statusbar 的 `cs hud`）通过 agentparty://channel/<slug>?server=<origin>
  // 直达频道。scheme 已在 Tauri 侧注册，这里接住 onOpenUrl → 聚焦窗口 → 切到目标实例（仅当 server 指向
  // 另一台已配对实例）→ 跳频道页。与配对 deep link（agentparty://pair/...）靠 hostname 分流，互不干扰。
  // 用 ref 存回调、effect 只依赖 desktop：listener 只注册一次，冷启动链接经 getCurrent 也只投递一次，
  // 避免 activeOrigin / 频道列表变化时重挂 listener 反复触发同一次跳转。
  const channelLinkHandler = useRef<(link: ChannelDeepLink) => void>(() => {});
  channelLinkHandler.current = (link) => {
    void showAndFocusDesktopWindow();
    const target =
      link.serverOrigin !== null &&
      link.serverOrigin !== activeOrigin &&
      serverProfiles.some((profile) => profile.origin === link.serverOrigin)
        ? link.serverOrigin
        : null;
    if (target !== null) {
      // 目标是另一台已配对实例：切服并在同一次 replace 里落到频道页（不闪 Home）。切服失败也不应
      // 把用户卡在原地，退化成在当前实例按 slug 打开即可。
      void switchDesktopOrigin(target, undefined, `/c/${link.slug}`)
        .catch(() => navigate(`/c/${link.slug}`));
    } else {
      navigate(`/c/${link.slug}`);
    }
  };

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    let stop = () => {};
    void listenForDesktopChannelLinks((link) => channelLinkHandler.current(link)).then((unlisten) => {
      if (alive) stop = unlisten;
      else unlisten();
    });
    return () => {
      alive = false;
      stop();
    };
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    void (async () => {
      await waitForDesktopWindowShown();
      if (!alive) return null;
      let startupOrigin = activeOrigin;
      // A stale legacy slot must never block the current per-server credential.
      // Automatic migration is deliberately non-interactive; users can authorize
      // or remove the old item later from the explicit recovery screen.
      const migratedOrigin = await migrateLegacyDesktopCredential().catch(() => null);
      if (!alive) return null;
      if (migratedOrigin !== null) {
        let nextProfiles = loadServerProfiles();
        if (!nextProfiles.some((profile) => profile.origin === migratedOrigin)) {
          nextProfiles = addCustomServerProfile(localStorage, {
            label: new URL(migratedOrigin).host,
            origin: migratedOrigin,
          });
        }
        setServerProfiles(nextProfiles);
        saveActiveServerOrigin(localStorage, migratedOrigin);
        setApiBase(migratedOrigin);
        setActiveOrigin(migratedOrigin);
        setServerPairingFlow(initialDesktopServerPairingFlow(migratedOrigin));
        startupOrigin = migratedOrigin;
      } else {
        startupOrigin = loadActiveServerOrigin();
      }
      return await restoreDesktopAccess(desktopCredentialVaultForOrigin(startupOrigin), startupOrigin);
    })().then((accessToken) => {
        if (!alive) return;
        if (accessToken !== null) activateDesktopHumanSession(accessToken);
        setDesktopRestoreFailure("retryable");
        setDesktopBoot("ready");
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setToken(null);
        setDesktopRestoreFailure(classifyDesktopRestoreFailure(cause));
        setDesktopBoot("error");
      });
    return () => { alive = false; };
  }, [activateDesktopHumanSession, desktop]);

  // 全局设置面板（#273）：语言/主题/通知/账号（身份 + @别名编辑 + 退出）都收进这里，由顶栏齿轮开合。
  // 账号 @handle / 昵称编辑复用 HandleSetup，放进面板的账号区（不再在顶栏单独挂一个浮层入口）。
  // banner 关闭态只在本次会话内记，不落盘。
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSectionId>("preferences");
  const [localAgentCenterOpen, setLocalAgentCenterOpen] = useState(false);
  const [handleBannerDismissed, setHandleBannerDismissed] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const handleSetupButtonRef = useRef<HTMLButtonElement | null>(null);
  const handleBannerButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsFocusOriginRef = useRef<"settings" | "handle-setup" | "handle-banner">("settings");
  const restoreSettingsFocusRef = useRef(false);
  const localAgentCenterButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsFocusTarget = useCallback((): HTMLButtonElement | null => {
    if (settingsFocusOriginRef.current === "handle-setup") return handleSetupButtonRef.current;
    if (settingsFocusOriginRef.current === "handle-banner") return handleBannerButtonRef.current;
    return settingsButtonRef.current;
  }, []);
  const onboardingReturnFocusRef = useMemo(() => ({
    get current(): HTMLButtonElement | null {
      return settingsFocusTarget() ?? settingsButtonRef.current;
    },
  }), [settingsFocusTarget]);
  const openSettings = useCallback((
    _event?: { currentTarget?: HTMLButtonElement },
    section: SettingsSectionId = "preferences",
    origin: "settings" | "handle-setup" | "handle-banner" = "settings",
  ) => {
    setLocalAgentCenterOpen(false);
    setSettingsInitialSection(section);
    settingsFocusOriginRef.current = origin;
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => {
    restoreSettingsFocusRef.current = true;
    setSettingsOpen(false);
  }, []);
  useEffect(() => {
    if (settingsOpen || !restoreSettingsFocusRef.current) return;
    restoreSettingsFocusRef.current = false;
    (settingsFocusTarget() ?? settingsButtonRef.current)?.focus();
  }, [settingsFocusTarget, settingsOpen]);
  const openLocalAgentCenter = useCallback(() => {
    setSettingsOpen(false);
    setLocalAgentCenterOpen(true);
  }, []);
  const closeLocalAgentCenter = useCallback(() => {
    setLocalAgentCenterOpen(false);
    localAgentCenterButtonRef.current?.focus?.();
  }, []);

  // oidc 配置存 ref，供 onAuthFailed/续期在稳定回调里读到最新值（避免进 effect 依赖引发重跑）
  const oidcRef = useRef<OidcConfig | null>(null);
  useEffect(() => {
    oidcRef.current = oidc;
  }, [oidc]);

  // 真正踢回登录闸：分享模式先摘掉坏 ?t= 退回粘贴 token，否则清会话
  const hardLogout = useCallback((message: string) => {
    if (desktop) {
      setAuthError(message);
      setChannels(null);
      setToken(null);
      setDesktopBoot("error");
      return;
    }
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
      // 别的标签可能刚刚续期成功并写回了共享 localStorage（#126）：与其把所有标签一起
      // 踢回登录页，不如接管那份新鲜会话。但**只接管同身份的**（#126 follow-up）：
      // 跨身份 / 旧 session 无 identity 一律不接管，否则本标签会静默变成另一个账号。
      const shared = readSession();
      if (shared !== null && gateSession(shared, identityRef.current) === "adopt") {
        // #190 之后 adopt 分支已保证只接管同身份的共享会话（跨身份一律 foreign），
        // 不清 channels——理由同 token-keyed effect 里的注释。
        setAuthError(null);
        setListError(null);
        setToken(shared.accessToken);
        return;
      }
      // 共享会话明确属于另一个身份：不接管，也**不要删**——删了会把那个身份的其它标签一起踢下线。
      // 其余情况（不新鲜 / 身份未知 / 属于本身份但已失效）照旧清理。
      if (shared === null || gateSession(shared, identityRef.current) !== "foreign") {
        clearToken();
      }
    }
    setAuthError(message);
    setChannels(null);
    setToken(null);
  }, [desktop]);

  // 静默续期（去重）：refresh_token 会轮换，并发续期会互相作废。
  // 标签页内用 refreshInFlight 去重；**标签页之间**用 navigator.locks 互斥（#126）——
  // 否则所有标签在 expiresAt-60s 这个绝对时刻同时拿同一个 refresh_token 去换，
  // 先到的让后到的作废，后到者 hardLogout 清掉共享 localStorage 里的 session，
  // 于是所有标签集体被踢回登录页。
  // 拿到锁后先重读 session：很可能别的标签已经续好了，直接复用，一次请求都不发。
  const refreshInFlight = useRef<Promise<string> | null>(null);
  const doRefresh = useCallback((): Promise<string> => {
    if (desktop) return Promise.reject(new Error("browser refresh is unavailable in desktop mode"));
    if (refreshInFlight.current) return refreshInFlight.current;
    const gate = gateSession(readSession(), identityRef.current);
    if (oidcRef.current === null || gate === "none") {
      return Promise.reject(new Error("no refreshable session"));
    }
    // 共享会话属于另一个身份（别的标签登录了别的账号）：既不复用、也不拿它的 refresh_token 去换，
    // 否则本标签会静默变成那个身份。交给 hardLogout 走正常登录闸。
    if (gate === "foreign") {
      return Promise.reject(new Error("session identity switched"));
    }
    const p = withRefreshLock<WebSession>({
      readFresh: () => {
        const sess = readSession();
        // 等锁期间别的标签可能已经续好（同身份 → 直接复用），也可能换成了别的身份 → 重新按身份判定
        return sess !== null && gateSession(sess, identityRef.current) === "adopt" ? sess : null;
      },
      refresh: async () => {
        const sess = readSession();
        if (oidcRef.current === null || sess?.refreshToken == null) throw new Error("no refreshable session");
        if (gateSession(sess, identityRef.current) === "foreign") throw new Error("session identity switched");
        const next = await refreshSession(oidcRef.current, sess.refreshToken);
        saveSession(next);
        return next;
      },
    })
      .then((next) => {
        setAuthError(null);
        setToken(next.accessToken);
        return next.accessToken;
      })
      .finally(() => {
        refreshInFlight.current = null;
      });
    refreshInFlight.current = p;
    return p;
  }, [desktop]);

  // token 失效（401 / ws 被踢）：OIDC 会话先试静默续期，续到就不掉登录；续不动才真踢回登录闸。
  const onAuthFailed = useCallback(
    (message: string) => {
      if (desktop) {
        restoreDesktop()
          .then((accessToken) => {
            if (accessToken === null) throw new Error("desktop session is unavailable");
            // desktop 续期换回的是同一身份的新 token（同 server），不清 channels——理由同下面
            // token-keyed effect 里的注释：清空只会连带卸载 ChannelPage、丢草稿。
            setListError(null);
          })
          .catch(() => hardLogout(message));
        return;
      }
      const sess = readSession();
      if (!isShareMode() && sess?.refreshToken != null && oidcRef.current !== null) {
        doRefresh()
          .then(() => {
            // 静默续期成功只是换了 access token 字符串，身份没变，不清 channels。
            setListError(null);
          })
          .catch(() => hardLogout(message));
        return;
      }
      hardLogout(message);
    },
    [desktop, doRefresh, hardLogout, restoreDesktop],
  );

  // 启动时拉一次公开配置决定是否显示 SSO；若正落在 OAuth/OIDC 回调则就地换 token
  // ref 守卫：code_verifier 一次性，StrictMode 双跑不得重复兑换 code
  const callbackHandled = useRef(false);
  useEffect(() => {
    let alive = true;
    const pendingPairOrigin = readPendingPairing(sessionStorage).serverOrigin ?? undefined;
    const configOrigin = !desktop && (matchPair(location.pathname) || isCallbackPath())
      ? pendingPairOrigin
      : undefined;
    fetchAuthConfig(configOrigin).then((cfg) => {
      if (!alive) return;
      const runtimeConfig = authConfigForRuntime(cfg);
      setOidc(runtimeConfig.oidc);
      setAuthProviders(runtimeConfig.providers);
      setAuthProvidersResolved(true);
      if (!isCallbackPath() || callbackHandled.current) return;
      callbackHandled.current = true;
      if (runtimeConfig.providers.length === 0) {
        setOidcPending(false);
        setAuthError(t("App.error.ssoNotConfigured"));
        replace("/");
        return;
      }
      completeLogin(runtimeConfig.providers, configOrigin)
        .then((sess) => {
          if (!alive) return;
          saveSession(sess); // 存 access + refresh，供静默续期
          const pendingChannelJoin = loadPendingJoinRequest();
          if (pendingChannelJoin !== null) {
            setAuthError(null);
            setOidcPending(false);
            void submitPendingChannelJoinRequest(sess.accessToken, pendingChannelJoin).finally(() => {
              replace(`/c/${pendingChannelJoin.slug}`);
            });
            return;
          }
          setAuthError(null);
          setChannels(null);
          setListError(null);
          setToken(sess.accessToken);
          setOidcPending(false);
          // 若登录前是去兑换邀请链接，回到 /join/<code>（或外部邀请 /invite/<code>）让下面的
          // effect（此时已有 token）完成加入/兑换
          const pendingJoin = sessionStorage.getItem(PENDING_JOIN_KEY);
          const pendingInvite = sessionStorage.getItem(PENDING_INVITE_KEY);
          const pendingPair = readPendingPairing(sessionStorage).routePending;
          replace(
            pendingPair
              ? "/pair"
              : pendingJoin
                ? `/join/${pendingJoin}`
                : pendingInvite
                  ? `/invite/${pendingInvite}`
                  : "/",
          );
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setOidcPending(false);
          setAuthError(err instanceof Error ? err.message : t("App.error.signInFailed"));
          replace("/");
        });
    });
    return () => {
      alive = false;
    };
  }, [replace, submitPendingChannelJoinRequest, t]);

  // 邀请链接落地：访问 /join/<code> 时——已登录则直接兑换（加入频道→跳进去）；未登录则存下 code
  // 并跳 OIDC 登录，回来后 callback 会重新落到 /join/<code>、此时有 token 走兑换分支。
  const joinCode = matchJoin(path);
  const inviteCode = matchInvite(path);
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
      // 浏览器未登录：存 code 跨登录重定向，跳 provider 登录。pending 路由互斥——
      // 残留的外部邀请 code 会在回调里劫持本次 join 登录（反之亦然）。
      sessionStorage.removeItem(PENDING_INVITE_KEY);
      sessionStorage.setItem(PENDING_JOIN_KEY, joinCode);
      beginLogin(primaryProvider).catch(() => setJoinStatus({ phase: "error", message: t("App.join.loginFailed") }));
    }
  }, [joinCode, joinAuthAction, token, authProviders, replace, t]);

  // 登录身份：topbar 显示 token name/kind/role；readonly 分享链接 401 由页面其它路径接管，这里静默
  useEffect(() => {
    if (!desktop && matchPair(path)) return;
    if (token === null) {
      setMe(null);
      setSettingsOpen(false);
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
  }, [desktop, path, token]);

  // OIDC access_token 仅 ~10min：到期前 60s 主动续期，标签页长开也不掉登录（"humans watch" 常态）。
  // 每次 token 变化重排下一次；非 OIDC 会话（粘贴的机器 token）无 refresh，跳过。
  useEffect(() => {
    if (desktop || oidc === null || token === null) return;
    const sess = readSession();
    if (sess?.refreshToken == null || sess.expiresAt == null) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const delayMs = Math.max(0, sess.expiresAt - 60 - nowSec) * 1000;
    let alive = true;
    const timer = window.setTimeout(() => {
      if (!alive) return;
      doRefresh().catch(() => hardLogout(t("App.error.sessionExpired")));
    }, delayMs);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [desktop, oidc, token, doRefresh, hardLogout, t]);

  const reloadChannels = useCallback((): Promise<void> => {
    if (token === null || (!desktop && matchPair(path))) return Promise.resolve();
    const key = `${activeOrigin}\n${token}`;
    if (channelReloadInFlight.current?.key === key) return channelReloadInFlight.current.promise;

    const generation = ++channelReloadGeneration.current;
    setListError(null);
    const promise = listChannels(token)
      .then((cs) => {
        if (channelReloadGeneration.current !== generation) return;
        setInviteRequired(false); // 入册成功/服务端关闸后，别把人永远关在邀请码门里
        setChannels(cs);
        setListError(null);
      })
      .catch((err: unknown) => {
        if (channelReloadGeneration.current !== generation) return;
        if (err instanceof AuthError) onAuthFailed(t("App.error.tokenInvalid"));
        else if (err instanceof InviteRequiredError) setInviteRequired(true);
        else setListError(t("App.error.channelsLoadFailed"));
      })
      .finally(() => {
        if (channelReloadInFlight.current?.promise === promise) channelReloadInFlight.current = null;
      });
    channelReloadInFlight.current = { key, promise };
    return promise;
  }, [activeOrigin, desktop, path, token, onAuthFailed, t]);

  useEffect(() => {
    if (token === null || (!desktop && matchPair(path))) return;
    void reloadChannels();
    const refresh = () => {
      if (document.visibilityState !== "hidden") void reloadChannels();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      channelReloadGeneration.current += 1;
      channelReloadInFlight.current = null;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [desktop, path, reloadChannels, token]);

  const signOut = async () => {
    if (desktop) {
      if (desktopLogoutPending) return;
      setDesktopLogoutPending(true);
      const result = await logoutDesktopSession(
        desktopCredentialVaultForOrigin(activeOrigin),
        fetch,
        [activeOrigin],
      );
      setDesktopLogoutPending(false);
      setDesktopNotice(result.removedOnly ? t("App.desktop.logoutRemovedOnly") : null);
      setDesktopBoot("ready");
    } else {
      clearToken();
    }
    setAuthError(null);
    setChannels(null);
    setListError(null);
    setMe(null);
    setSettingsOpen(false);
    setHandleBannerDismissed(false);
    setToken(null);
  };

  if (desktop && token === null) {
    if (desktopBoot === "loading") {
      return (
        <>
          <main className="gate desktop-session-gate">
            <h1 className="d-title gate-title">Agent<span className="d-hl">Party</span></h1>
            <p className="banner" role="status" aria-live="polite">{t("App.desktop.restoring")}</p>
          </main>
          <DesktopRecoveryUpdater />
        </>
      );
    }
    if (desktopBoot === "error") {
      return (
        <>
          <main className="gate desktop-session-gate">
            <h1 className="d-title gate-title">Agent<span className="d-hl">Party</span></h1>
            <section className="d-card gate-card">
              <p className="banner banner--red" role="alert">{t("App.desktop.restoreFailed")}</p>
              <ServerSwitcher
                profiles={serverProfiles}
                activeOrigin={activeOrigin}
                onSwitch={switchDesktopOrigin}
                onAddPair={() => setDesktopBoot("ready")}
                onPair={(origin) => {
                  saveActiveServerOrigin(localStorage, origin);
                  setApiBase(origin);
                  setActiveOrigin(origin);
                  setServerPairingFlow(initialDesktopServerPairingFlow(origin));
                  setDesktopBoot("ready");
                }}
              />
              <div className="desktop-session-actions">
                <button
                  type="button"
                  className="d-btn"
                  onClick={() => void desktopCredentialVaultForOrigin(activeOrigin)
                    .deleteInteractive()
                    .then(() => setDesktopBoot("ready"))
                    .catch(() => setDesktopBoot("error"))}
                >
                  {t("App.desktop.removeLocal")}
                </button>
                <button
                  type="button"
                  className="d-btn d-btn--primary"
                  onClick={() => void (desktopRestoreFailure === "keychain-authorization"
                    ? restoreDesktopInteractive()
                    : restoreDesktop()).catch(() => {})}
                >
                  {t(desktopRestoreFailure === "keychain-authorization"
                    ? "App.desktop.authorizeRetry"
                    : "App.desktop.retry")}
                </button>
              </div>
            </section>
          </main>
          <DesktopRecoveryUpdater />
        </>
      );
    }
    return (
      <>
        {desktopNotice !== null && <p className="banner banner--yellow desktop-auth-notice" role="status">{desktopNotice}</p>}
        <DesktopPairingGate
          profiles={serverProfiles}
          selectedOrigin={activeOrigin}
          onSelectOrigin={(origin) => {
            saveActiveServerOrigin(localStorage, origin);
            setApiBase(origin);
            setActiveOrigin(origin);
            setServerPairingFlow(initialDesktopServerPairingFlow(origin));
          }}
          onProfilesChanged={setServerProfiles}
          onAuthenticated={(accessToken, origin) => {
            setDesktopNotice(null);
            setAuthError(null);
            setActiveOrigin(origin);
            setServerPairingFlow(initialDesktopServerPairingFlow(origin));
            activateDesktopHumanSession(accessToken);
          }}
        />
        <DesktopRecoveryUpdater />
      </>
    );
  }

  if (desktop && token !== null && serverPairingFlow.phase === "adding") {
    return (
      <ServerProfileAddGate
        profiles={serverProfiles}
        activeOrigin={serverPairingFlow.activeOrigin}
        onPair={(origin) => setServerPairingFlow((flow) => beginDesktopServerPairing(flow, origin))}
        onProfilesChanged={setServerProfiles}
        onCancel={() => setServerPairingFlow((flow) => cancelDesktopServerPairing(flow))}
      />
    );
  }

  if (desktop && token !== null && serverPairingFlow.phase === "pairing" && serverPairingFlow.targetOrigin !== null) {
    return (
      <DesktopPairingGate
        profiles={serverProfiles}
        selectedOrigin={serverPairingFlow.targetOrigin}
        onSelectOrigin={(origin) => setServerPairingFlow((flow) => beginDesktopServerPairing(flow, origin))}
        onProfilesChanged={setServerProfiles}
        onExit={() => setServerPairingFlow((flow) => cancelDesktopServerPairing(flow))}
        onAuthenticated={(accessToken, origin) => {
          saveActiveServerOrigin(localStorage, origin);
          setApiBase(origin);
          setActiveOrigin(origin);
          setServerPairingFlow((flow) => completeDesktopServerPairing(flow));
          setAuthError(null);
          setChannels(null);
          setListError(null);
          setMe(null);
          activateDesktopHumanSession(accessToken);
        }}
      />
    );
  }

  if (oidcPending) {
    return (
      <main className="gate">
        <h1 className="d-title gate-title">
          Agent<span className="d-hl">Party</span>
        </h1>
        <p className="banner" role="status" aria-live="polite">
          {t("App.status.signingIn")}
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

  // 外部协作者邀请落地（#593）：登录前先见预览+登录按钮；已登录直接兑换。
  // 无 redirect provider 的 runtime 落回 TokenGate 粘贴 token，粘贴后仍在 /invite/<code> 继续兑换。
  if (inviteCode !== null && (token !== null || !authProvidersResolved || authProviders.length > 0)) {
    return (
      <InviteLanding
        code={inviteCode}
        token={token}
        providers={authProviders}
        providersResolved={authProvidersResolved}
        onBeforeLogin={() => {
          setAuthError(null);
          // pending 路由互斥：残留的 join code 会在回调里把本次外部邀请登录重定向去错误页面
          sessionStorage.removeItem(PENDING_JOIN_KEY);
          sessionStorage.setItem(PENDING_INVITE_KEY, inviteCode);
        }}
        onRedeemed={(joinedSlug) => {
          setInviteRequired(false);
          sessionStorage.removeItem(PENDING_INVITE_KEY);
          const goto = () => replace(`/c/${joinedSlug}`);
          if (token === null) {
            goto();
            return;
          }
          // 新加入的频道要先出现在列表里再跳，否则频道页会「not available」（与 /join 同一竞态）
          listChannels(token)
            .then(setChannels)
            .catch(() => {})
            .finally(goto);
        }}
        onAuthFailed={onAuthFailed}
      />
    );
  }

  if (token === null) {
    return (
      <TokenGate
        error={
          !desktop && matchPair(path) && authProvidersResolved && authProviders.length === 0
            ? t("Pair.providerMissing")
            : authError
        }
        providers={authProviders}
        onSso={(provider) => {
          setAuthError(null);
          if (matchPair(path)) rememberPendingPairing(sessionStorage, {});
          beginLogin(provider).catch(() => setAuthError(t("App.error.startSignInFailed")));
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

  if (!desktop && matchPair(path)) {
    const pairServerOrigin = readPendingPairing(sessionStorage).serverOrigin
      ?? normalizeServerOrigin(location.origin);
    if (pairServerOrigin === null) {
      return <main className="gate"><p className="banner banner--red" role="alert">{t("Pair.inspect.failed")}</p></main>;
    }
    return (
      <PairPage
        serverOrigin={pairServerOrigin}
        token={token}
        initialCode={readPendingPairing(sessionStorage).code ?? initialPairCode}
        onRequireHuman={({ code }) => {
          rememberPendingPairing(sessionStorage, { code, serverOrigin: pairServerOrigin });
          clearToken();
          setAuthError(null);
          setToken(null);
        }}
        onDecisionComplete={() => clearPendingPairing(sessionStorage)}
      />
    );
  }

  // 实例邀请制兜底门（#593）：直接登录（没走邀请链接）的未入册账号，引导输入邀请码或退出。
  if (inviteRequired) {
    return (
      <InviteRequiredGate
        onSubmitCode={(code) => {
          setInviteRequired(false);
          navigate(`/invite/${code}`);
        }}
        onSignOut={() => {
          setInviteRequired(false);
          void signOut();
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
  // #165：人类设 @handle，agent 会话设昵称——都走同一入口/浮层，只是 mode 不同。readonly/分享态不给设。
  const canSetHandle = !isShareMode() && (me?.role === "human" || me?.role === "agent");
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
        <span className="d-hand app-tag">{t("App.tagline")}</span>
        <a className="app-docs t-mono" href="/docs">
          {t("App.docs")}
        </a>
        <DesktopDownloadLink desktop={desktop} />
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
            {/* 会员骨架（#277）：账号 free/member 状态就近展示（不进 #273 全局设置面板，避免并行冲突）。 */}
            {me.kind === "human" && (
              isMember(membershipStatusOf(me)) ? (
                <span
                  className="app-me-chip app-me-chip--member"
                  title={t("App.membership.memberTitle")}
                >
                  {t("App.membership.member")}
                </span>
              ) : (
                <a
                  className="app-me-membership-apply"
                  href={membershipApplyMailto(
                    me,
                    t("App.membership.applySubject"),
                    t("App.membership.applyBody"),
                  )}
                  title={t("App.membership.freeTitle")}
                >
                  {t("App.membership.apply")}
                </a>
              )
            )}
          </span>
        )}
        {canSetHandle && me !== null && me.handle === null && (
          <button
            ref={handleSetupButtonRef}
            type="button"
            className="d-btn handlesetup-trigger handlesetup-trigger--cta"
            onClick={(event) => openSettings(event, "account", "handle-setup")}
            title={t("App.handle.setCta")}
          >
            <span className="handlesetup-trigger-edit" aria-hidden="true">
              ✎
            </span>
            <span className="handlesetup-trigger-value">{t("App.handle.chipUnset")}</span>
          </button>
        )}
        {desktop && (
          <ServerSwitcher
            profiles={serverProfiles}
            activeOrigin={activeOrigin}
            onSwitch={switchDesktopOrigin}
            onAddPair={() => setServerPairingFlow(beginDesktopServerAdd(initialDesktopServerPairingFlow(activeOrigin)))}
            onPair={(origin) => setServerPairingFlow(beginDesktopServerPairing(
              initialDesktopServerPairingFlow(activeOrigin),
              origin,
            ))}
          />
        )}
        <DesktopUpdater />
        {desktop && (
          <button
            ref={localAgentCenterButtonRef}
            type="button"
            className="app-agent-center-btn"
            aria-label={t("App.localAgentCenter.open")}
            title={t("App.localAgentCenter.open")}
            aria-expanded={localAgentCenterOpen}
            onClick={openLocalAgentCenter}
          >
            <span className="ap-sprite ap-sprite--agent" aria-hidden="true" />
          </button>
        )}
        {slug !== null && (
          <div className="app-channel-notify" aria-label={t("Channel.notify.headerLabel")}>
            <NotifyToggle optin={notifyOptin} onChange={setNotifyOptin} />
          </div>
        )}
        <button
          ref={settingsButtonRef}
          type="button"
          className="app-settings-btn"
          aria-label={t("App.settings.title")}
          title={t("App.settings.title")}
          onClick={openSettings}
        >
          <span className="ap-sprite ap-sprite--settings" aria-hidden="true" />
        </button>
      </header>
      {settingsOpen && (
        <SettingsPanel
          me={me}
          notifyOptin={notifyOptin}
          canSetHandle={canSetHandle}
          onClose={closeSettings}
          onNotifyOptinChange={setNotifyOptin}
          onLogout={
            isShareMode() || desktopLogoutPending
              ? null
              : () => {
                  setSettingsOpen(false);
                  void signOut();
                }
          }
          onHandleSaved={(handle) => {
            setMe((prev) => (prev ? { ...prev, handle } : prev));
            setHandleBannerDismissed(true);
          }}
          onShowOnboarding={() => {
            setSettingsOpen(false);
            setGuideOpen(true);
          }}
          desktopAppSettings={desktop ? <DesktopSettings embedded serverOrigin={activeOrigin} /> : null}
          initialSection={settingsInitialSection}
          restoreFocusOnUnmount={false}
        />
      )}
      {localAgentCenterOpen && (
        <LocalAgentCenter onClose={closeLocalAgentCenter} />
      )}
      {canSetHandle && me !== null && me.handle === null && !handleBannerDismissed && !settingsOpen && !localAgentCenterOpen && (
        <p className="banner banner--yellow handle-banner" role="status">
          <span className="handle-banner-text">{t("App.handle.banner")}</span>
          <span className="handle-banner-actions">
            <button
              ref={handleBannerButtonRef}
              type="button"
              className="d-btn handle-banner-open"
              onClick={(event) => openSettings(event, "account", "handle-banner")}
            >
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
          {/* 桌面版：贴网页邀请链接进入频道（#297）。桌面壳没地址栏，粘贴框把 /join 或 /c 链接
              解析后走网页同款兑换——participate 走 /join/<code> 兑换 effect，watch 落分享态。 */}
          {desktop && !isShareMode() && (
            <DesktopInvitePaste
              activeOrigin={activeOrigin}
              onParticipate={(code) => navigate(`/join/${code}`)}
              onOpen={(s) => navigate(`/c/${s}`)}
              onWatch={enterWatchInvite}
            />
          )}
          <ChannelList
            scopeKey={activeOrigin}
            channels={channels}
            active={slug}
            error={listError}
            onOpen={openChannel}
            onRetry={reloadChannels}
          />
        </aside>
        <main className="app-main">
          {routeNotFound ? (
            <p className="banner banner--red" role="alert">
              {t("App.route.notFound")}
            </p>
          ) : channelPending ? (
            <p className="banner" role="status" aria-live="polite">
              {t("App.channel.loading")}
            </p>
          ) : slug !== null && channels === null ? (
            <p className="banner banner--red" role="alert">
              <span>{listError ?? t("App.error.channelsLoadFailed")}</span>{" "}
              <button type="button" className="d-btn channels-retry" onClick={reloadChannels}>
                {t("App.error.retry")}
              </button>
            </p>
          ) : unknownChannel ? (
            <p className="banner banner--red" role="alert">
              {t("App.channel.unavailable")}
            </p>
          ) : slug !== null ? (
            <ChannelPage
              key={`${activeOrigin}:${slug}`}
              slug={slug}
              token={token}
              mode={channels?.find((c) => c.slug === slug)?.mode ?? "normal"}
              visibility={channels?.find((c) => c.slug === slug)?.visibility ?? "private"}
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
              notifyOptin={notifyOptin}
              joinRequestStatus={channelJoinRequest?.slug === slug ? channelJoinRequest.state : "none"}
              joinRequestReason={channelJoinRequest?.slug === slug ? channelJoinRequest.reason ?? null : null}
              joinRequestError={channelJoinRequest?.slug === slug ? channelJoinRequest.message ?? null : null}
              joinAuthProviders={authProviders}
              larkDirectoryEnabled={!isShareMode() && me?.role === "human" && authProviders.some(
                (provider) => provider.type === "oauth"
                  && provider.id === me.provider
                  && (provider.kind === "lark" || provider.kind === "feishu"),
              )}
              onRequestJoin={requestChannelJoin}
              onBeginJoinLogin={beginChannelJoinLogin}
              onRefreshJoinRequest={refreshChannelJoinRequest}
              onEnterApprovedChannel={enterApprovedChannel}
              onAuthFailed={onAuthFailed}
            />
          ) : (
            <Home channels={channels} onOpen={openChannel} />
          )}
        </main>
      </div>
      {/* 首次自动显示仍由组件记忆；设置入口可显式重开（#146 / #357）。 */}
      <OnboardingGuide
        forceOpen={guideOpen}
        onClose={() => setGuideOpen(false)}
        returnFocusRef={guideOpen ? onboardingReturnFocusRef : undefined}
      />
    </div>
  );
}
