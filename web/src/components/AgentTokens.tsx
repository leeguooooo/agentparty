import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AuthError,
  type ChannelAgentInfo,
  type ChannelCharter,
  ConflictError,
  ForbiddenError,
  type ProjectAgentInvitableBy,
  type ProjectAgentProfile,
  type ProjectAgentRunner,
  type ProjectAgentWorktreeStrategy,
  createProjectAgentProfile,
  inviteProjectAgent,
  listChannelAgents,
  listProjectAgentProfiles,
  deleteChannelAgent,
  rotateChannelAgent,
  setChannelAgentNickname,
  ValidationError,
} from "../lib/api";
import {
  buildMinimalAgentCommand,
  copyText,
  findSavedAgentToken,
  listSavedAgentTokens,
  removeSavedAgentToken,
  saveAgentToken,
} from "../lib/agentTokenVault";
import { apiOrigin } from "../lib/base";
import { desktopAgentAdapter, type DesktopAgentAdapter, type DesktopAgentRunner } from "../lib/desktopAgent";
import { isDesktopRuntime, pickDirectory as pickDirectoryDefault } from "../lib/desktopRuntime";
import { LocalAgentsOverview } from "./LocalAgentsOverview";
import { buildJoinPack, type JoinPackMode } from "../lib/joinPack";
import { useT } from "../i18n/useT";
import { useDismissableLayer } from "./useDismissableLayer";
import "../i18n/strings/AgentTokens";

interface Props {
  slug: string;
  token: string;
  accountKey: string;
  inviterName: string;
  /** 频道公告快照（与 AgentJoin 同源）；复制接入包时嵌入，null 则省略该段。 */
  charter: ChannelCharter | null;
  onAuthFailed(message: string): void;
  active?: boolean;
  onActiveChange?(open: boolean): void;
  // 转为常驻（launchd）注入点——测试用；默认走真实桌面适配器 / 目录选择器 / mac 桌面探测。
  dutyAdapter?: Pick<DesktopAgentAdapter, "dutyAdopt">;
  pickDirectory?: (title?: string) => Promise<string | null>;
  // 常驻是 macOS launchd，仅 mac 桌面可用；测试注入覆盖。
  canMakeResident?: boolean;
}

type CopyTarget = `${string}:token` | `${string}:command`;
type ProfileForm = {
  handle: string;
  runner: ProjectAgentRunner;
  repoUrl: string;
  workdir: string;
  baseBranch: string;
  worktree: ProjectAgentWorktreeStrategy;
  invitableBy: ProjectAgentInvitableBy;
  rules: string;
};

const EMPTY_PROFILE_FORM: ProfileForm = {
  handle: "",
  runner: "codex",
  repoUrl: "",
  workdir: "",
  baseBranch: "main",
  worktree: "branch",
  invitableBy: "owner",
  rules: "",
};

export function AgentTokens({
  slug,
  token,
  accountKey,
  inviterName,
  charter,
  onAuthFailed,
  active,
  onActiveChange,
  dutyAdapter = desktopAgentAdapter,
  pickDirectory = pickDirectoryDefault,
  canMakeResident = isDesktopRuntime() && /mac/i.test(globalThis.navigator?.userAgent ?? ""),
}: Props) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 转为常驻状态：busy 名 / 已完成集 / 错误。residentBusyRef 是同步锁（state 更新晚于 await，见 makeResident）。
  const [residentBusy, setResidentBusy] = useState<string | null>(null);
  const residentBusyRef = useRef<string | null>(null);
  const [residentDone, setResidentDone] = useState<Set<string>>(() => new Set());
  const [residentError, setResidentError] = useState<string | null>(null);
  // #725：转常驻要能选 codex/claude(默认 codex,与本机 agent 默认一致)。按 agent 名各记一份。
  const [residentRunnerByName, setResidentRunnerByName] = useState<Record<string, DesktopAgentRunner>>({});
  const residentRunnerFor = (name: string): DesktopAgentRunner => residentRunnerByName[name] ?? "codex";
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<ChannelAgentInfo[] | null>(null);
  const [profiles, setProfiles] = useState<ProjectAgentProfile[] | null>(null);
  const [profileForm, setProfileForm] = useState<ProfileForm>(EMPTY_PROFILE_FORM);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [editingNickname, setEditingNickname] = useState<string | null>(null);
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [savingNickname, setSavingNickname] = useState<string | null>(null);
  const [busyProfile, setBusyProfile] = useState<string | null>(null);
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [editingRules, setEditingRules] = useState<string | null>(null);
  const [rulesDraft, setRulesDraft] = useState("");
  const [savingRules, setSavingRules] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const isOpen = active ?? open;
  const localOnly = useMemo(() => {
    const serverNames = new Set((agents ?? []).map((agent) => agent.name));
    return listSavedAgentTokens(accountKey, slug).filter((rec) => !serverNames.has(rec.name));
  }, [accountKey, agents, slug]);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [nextAgents, nextProfiles] = await Promise.all([
        listChannelAgents(token, slug),
        listProjectAgentProfiles(token),
      ]);
      setAgents(nextAgents);
      setProfiles(nextProfiles);
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setError(t("AgentTokens.errForbidden"));
      else setError(t("AgentTokens.errLoad"));
    }
  }, [onAuthFailed, slug, t, token]);

  const close = useCallback(() => {
    if (active === undefined) setOpen(false);
    onActiveChange?.(false);
  }, [active, onActiveChange]);

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
      return;
    }
    if (active === undefined) setOpen(true);
    onActiveChange?.(true);
    if (agents === null) void refresh();
  }, [active, agents, close, isOpen, onActiveChange, refresh]);

  useDismissableLayer({ active: isOpen, onDismiss: close, outsideRef: rootRef });

  useEffect(() => {
    if (isOpen) return;
    setPanelStyle({});
    setProfileForm(EMPTY_PROFILE_FORM);
    setEditingRules(null);
    setRulesDraft("");
    setEditingNickname(null);
    setNicknameDraft("");
    setError(null);
    setCopied(null);
    setRevealed(new Set());
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;

    const updatePanelPosition = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const gap = 6;
      const margin = 12;
      const width = Math.min(620, window.innerWidth - margin * 2);
      const top = Math.min(anchor.bottom + gap, window.innerHeight - margin);
      const left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin));
      const maxHeight = Math.max(220, window.innerHeight - top - margin);
      setPanelStyle({ left, top, width, maxHeight });
    };

    updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [isOpen]);

  const toggleReveal = useCallback((key: string) => {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const tokenField = (key: string, tokenValue: string) => {
    const isRevealed = revealed.has(key);
    return (
      <div className="agenttokens-tokenrow">
        <input
          className="agenttokens-token t-mono"
          type={isRevealed ? "text" : "password"}
          value={tokenValue}
          readOnly
          aria-label={t("AgentTokens.tokenField")}
        />
        <button type="button" className="d-btn agenttokens-reveal" onClick={() => toggleReveal(key)}>
          {isRevealed ? t("AgentTokens.hideToken") : t("AgentTokens.showToken")}
        </button>
      </div>
    );
  };

  // #584：vault 里存的 command 是生成时刻的冻结文本，会带着旧世界观（TMPDIR 配置路径、
  // 旧 MIN_CLI、无 MCP 步骤）继续流通。复制永远现场重建，存量 command 字段只留作兼容不再读。
  // 重建走 buildFullJoinPack——与「＋ 让 agent 加入」同一份 builder，产物逐字节同构，
  // 含 charter 快照与待命/唤醒指引（只发最小包的话，新 agent 报到完就不知道怎么挂 watch/serve）。
  // #612：unattended 记录重建同款无人值守包（serve --runner claude），别把值守机脚本换成交互包。
  function freshCommand(record: { name: string; token: string; mode?: JoinPackMode; runner?: DesktopAgentRunner }): string {
    return buildJoinPack(record.mode ?? "interactive", {
      slug,
      agentName: record.name,
      agentToken: record.token,
      // #530：桌面版 location.origin 是 tauri://localhost，接入包会报错；优先真实后端 apiBase，同源 web 回退 origin。
      server: apiOrigin(),
      inviterName,
      charter,
      // #749：按生成时选的 runner 重建 unattended 脚本；旧记录无此字段 → buildJoinPack 内落 codex 默认。
      runner: record.runner,
      t,
    });
  }

  async function copy(name: string, kind: "token" | "command", text: string) {
    const ok = await copyText(text);
    if (!ok) {
      setError(t("AgentTokens.errCopy"));
      return;
    }
    const key = `${name}:${kind}` as CopyTarget;
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
  }

  // #605：删除自己的 agent——撤 token、断连、清本地 vault 记录。不可逆，二次确认。
  async function removeAgent(name: string) {
    const ok = window.confirm(t("AgentTokens.deleteConfirm", { name }));
    if (!ok) return;
    setBusyName(name);
    setError(null);
    try {
      await deleteChannelAgent(token, slug, name);
      removeSavedAgentToken(accountKey, slug, name);
      await refresh();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ValidationError) {
        // 404 = 服务端早已没有这个 agent（别处已删/已撤销）——本地清理照做，幂等收尾。
        removeSavedAgentToken(accountKey, slug, name);
        await refresh();
      } else setError(t("AgentTokens.errDelete"));
    } finally {
      setBusyName(null);
    }
  }

  // rotate token + 重建接入命令 + 存回 vault 的共享流程（rotate 与转常驻都用）。返回新明文 token。
  // #612：换 token 不换接入方式——沿用旧记录的 mode，让「复制接入包」仍是同款脚本。
  // #530：桌面版 location.origin 是 tauri://localhost，接入包会报错；优先真实后端 apiBase，同源 web 回退 origin。
  async function regenerateAndSaveToken(name: string): Promise<string> {
    const next = await rotateChannelAgent(token, slug, name);
    const command = buildMinimalAgentCommand({
      server: apiOrigin(),
      slug,
      name: next.name,
      token: next.token,
      inviterName,
      checkinMessage: t("AgentTokens.checkinMessage", { name: next.name }),
    });
    saveAgentToken({
      account: accountKey,
      slug,
      name: next.name,
      token: next.token,
      command,
      mode: findSavedAgentToken(accountKey, slug, name)?.mode,
      // #749：轮换 token 也要保留已选 runner,否则已选 claude 的 unattended 记录轮换后复制包会回退 codex。
      runner: findSavedAgentToken(accountKey, slug, name)?.runner,
      savedAt: Date.now(),
    });
    return next.token;
  }

  async function rotate(name: string) {
    const ok = window.confirm(t("AgentTokens.rotateConfirm", { name }));
    if (!ok) return;
    setBusyName(name);
    setError(null);
    try {
      await regenerateAndSaveToken(name);
      await refresh();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setError(t("AgentTokens.errRotateForbidden"));
      else setError(t("AgentTokens.errRotate"));
    } finally {
      setBusyName(null);
    }
  }

  // 拿到该 agent 可用的明文 token：本地 vault 有就用（不动线上）；没有则征得同意后 rotate
  // 生成新 token（旧 token 立即失效——若在别处正跑会掉线），并存回 vault 供复制/后续复用。
  async function tokenForResidency(name: string): Promise<string | null> {
    const saved = findSavedAgentToken(accountKey, slug, name);
    if (saved) return saved.token;
    if (!window.confirm(t("AgentTokens.residentRegenConfirm", { name }))) return null;
    return regenerateAndSaveToken(name);
  }

  // 把某个 agent 身份转成本机 launchd 常驻：先选工作目录（必选，不手填），再 dutyAdopt 落地。
  // #721 评审：用 ref 同步上锁——residentBusy 是 state，要等 await pickDirectory 后才生效，
  // 连点会绕过 state 守卫并发触发 rotate/dutyAdopt（第二次 rotate 作废第一次的 token）。
  async function makeResident(name: string) {
    if (!canMakeResident || residentBusyRef.current !== null) return;
    residentBusyRef.current = name;
    setResidentBusy(name);
    setResidentError(null);
    try {
      const dir = await pickDirectory(t("AgentTokens.residentPickTitle", { name }));
      if (dir === null) return; // 取消选目录 = 放弃整个操作
      const agentToken = await tokenForResidency(name);
      if (agentToken === null) return; // 未同意重新生成
      await dutyAdapter.dutyAdopt({
        server: apiOrigin(),
        token: agentToken,
        name,
        channel: slug,
        runner: residentRunnerFor(name),
        workdir: dir,
      });
      setResidentDone((s) => new Set(s).add(name));
      await refresh();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else setResidentError(err instanceof Error ? err.message : String(err));
    } finally {
      residentBusyRef.current = null;
      setResidentBusy(null);
    }
  }

  function startEditNickname(agent: ChannelAgentInfo) {
    setEditingNickname(agent.name);
    setNicknameDraft(agent.nickname ?? "");
    setError(null);
  }

  function cancelEditNickname() {
    setEditingNickname(null);
    setNicknameDraft("");
  }

  async function saveNickname(agent: ChannelAgentInfo) {
    const nickname = nicknameDraft.trim();
    if (nickname === "") {
      setError(t("AgentTokens.errNicknameInvalid"));
      return;
    }
    setSavingNickname(agent.name);
    setError(null);
    try {
      const saved = await setChannelAgentNickname(token, slug, agent.name, nickname);
      setAgents((current) => current?.map((entry) => entry.name === agent.name ? { ...entry, nickname: saved.nickname } : entry) ?? null);
      cancelEditNickname();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setError(t("AgentTokens.errNicknameForbidden"));
      else if (err instanceof ConflictError) setError(t("AgentTokens.errNicknameConflict"));
      else if (err instanceof ValidationError) setError(t("AgentTokens.errNicknameInvalid"));
      else setError(t("AgentTokens.errNicknameSave"));
    } finally {
      setSavingNickname(null);
    }
  }

  async function createProfile() {
    const handle = profileForm.handle.trim();
    if (handle === "") {
      setError(t("AgentTokens.errProfileInvalid"));
      return;
    }
    setCreatingProfile(true);
    setError(null);
    try {
      await createProjectAgentProfile(token, {
        handle,
        runner: profileForm.runner,
        ...(profileForm.repoUrl.trim() === "" ? {} : { repo_url: profileForm.repoUrl.trim() }),
        ...(profileForm.workdir.trim() === "" ? {} : { workdir: profileForm.workdir.trim() }),
        ...(profileForm.baseBranch.trim() === "" ? {} : { base_branch: profileForm.baseBranch.trim() }),
        worktree_strategy: profileForm.worktree,
        invitable_by: profileForm.invitableBy,
        ...(profileForm.rules.trim() === "" ? {} : { rules: profileForm.rules.trim() }),
      });
      setProfileForm((current) => ({ ...current, handle: "", repoUrl: "", workdir: "", rules: "" }));
      await refresh();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setError(t("AgentTokens.errProfileForbidden"));
      else if (err instanceof ValidationError) setError(t("AgentTokens.errProfileInvalid"));
      else setError(t("AgentTokens.errProfileSave"));
    } finally {
      setCreatingProfile(false);
    }
  }

  function startEditRules(profile: ProjectAgentProfile) {
    setEditingRules(`${profile.owner_account}/${profile.handle}`);
    setRulesDraft(profile.rules ?? "");
    setError(null);
  }

  function cancelEditRules() {
    setEditingRules(null);
    setRulesDraft("");
  }

  // 编辑已有 profile 的规则：worker 没有独立的 PATCH，POST /api/agent-profiles 走 ON CONFLICT
  // DO UPDATE 做 upsert，缺省字段会被写成 null——所以这里必须把整份 profile 的字段带回去，
  // 只替换 rules，否则重存会把 repo/workdir 等抹掉。
  async function saveProfileRules(profile: ProjectAgentProfile) {
    const key = `${profile.owner_account}/${profile.handle}`;
    setSavingRules(key);
    setError(null);
    try {
      await createProjectAgentProfile(token, {
        handle: profile.handle,
        runner: profile.runner,
        ...(profile.repo_url === null ? {} : { repo_url: profile.repo_url }),
        ...(profile.workdir === null ? {} : { workdir: profile.workdir }),
        base_branch: profile.base_branch,
        worktree_strategy: profile.worktree_strategy,
        invitable_by: profile.invitable_by,
        rules: rulesDraft.trim(),
      });
      setEditingRules(null);
      setRulesDraft("");
      await refresh();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setError(t("AgentTokens.errProfileForbidden"));
      else if (err instanceof ValidationError) setError(t("AgentTokens.errProfileInvalid"));
      else setError(t("AgentTokens.errProfileSave"));
    } finally {
      setSavingRules(null);
    }
  }

  async function inviteProfile(profile: ProjectAgentProfile) {
    const key = `${profile.owner_account}/${profile.handle}`;
    setBusyProfile(key);
    setError(null);
    try {
      await inviteProjectAgent(token, slug, profile);
      await refresh();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setError(t("AgentTokens.errInviteForbidden"));
      else setError(t("AgentTokens.errInvite"));
    } finally {
      setBusyProfile(null);
    }
  }

  return (
    <div className="agenttokens" ref={rootRef}>
      <button type="button" className="d-btn agenttokens-btn" onClick={toggle} aria-expanded={isOpen}>
        {t("AgentTokens.open")}
      </button>
      {isOpen && (
        <div
          className="agenttokens-panel"
          style={panelStyle}
          role="dialog"
          aria-modal="true"
          aria-label={t("AgentTokens.title")}
        >
          <div className="agenttokens-head">
            <span className="agenttokens-title">{t("AgentTokens.title")}</span>
            <button type="button" className="d-btn agenttokens-refresh" onClick={refresh}>
              {t("AgentTokens.refresh")}
            </button>
          </div>
          <p className="agenttokens-hint">{t("AgentTokens.hint")}</p>
          {/* 合并「本机 agent」入口（原独立按钮）——桌面端在此直接看/管本机运行态，与身份/接入并列。 */}
          {isDesktopRuntime() && (
            <section className="agenttokens-local">
              <LocalAgentsOverview t={t} scopeChannel={slug} />
            </section>
          )}
          {error !== null && <p className="agenttokens-error">{error}</p>}
          {residentError !== null && <p className="agenttokens-error" role="alert">{residentError}</p>}
          {(agents === null || profiles === null) && error === null && <p className="agenttokens-empty">{t("AgentTokens.loading")}</p>}
          {agents !== null && agents.length === 0 && localOnly.length === 0 && (
            <p className="agenttokens-empty">{t("AgentTokens.empty")}</p>
          )}
          {agents !== null && agents.length > 0 && (
            <ul className="agenttokens-list">
              {agents.map((agent) => {
                const saved = findSavedAgentToken(accountKey, slug, agent.name);
                const isEditingNickname = editingNickname === agent.name;
                return (
                  <li key={agent.name} className="agenttokens-item">
                    <div className="agenttokens-main">
                      <strong className="agenttokens-name">{agent.name}</strong>
                      {agent.nickname && <span className="agenttokens-nickname">@{agent.nickname}</span>}
                      <span className="agenttokens-meta">
                        {saved ? t("AgentTokens.hasPlaintext") : t("AgentTokens.noPlaintext")}
                      </span>
                    </div>
                    {saved ? tokenField(`server:${agent.name}`, saved.token) : null}
                    {isEditingNickname && (
                      <div className="agenttokens-nickname-edit">
                        <input
                          className="agenttokens-input agenttokens-nickname-input"
                          value={nicknameDraft}
                          maxLength={64}
                          autoFocus
                          onChange={(event) => setNicknameDraft(event.target.value)}
                          placeholder={t("AgentTokens.nicknamePlaceholder")}
                          aria-label={t("AgentTokens.nicknameLabel")}
                        />
                        <button
                          type="button"
                          className="d-btn d-btn--primary agenttokens-save-nickname"
                          disabled={savingNickname === agent.name}
                          onClick={() => void saveNickname(agent)}
                        >
                          {savingNickname === agent.name ? t("AgentTokens.savingNickname") : t("AgentTokens.saveNickname")}
                        </button>
                        <button type="button" className="d-btn agenttokens-cancel-nickname" disabled={savingNickname === agent.name} onClick={cancelEditNickname}>
                          {t("AgentTokens.cancelNickname")}
                        </button>
                      </div>
                    )}
                    <div className="agenttokens-actions">
                      {!isEditingNickname && (
                        <button type="button" className="d-btn agenttokens-edit-nickname" onClick={() => startEditNickname(agent)}>
                          {agent.nickname ? t("AgentTokens.changeNickname") : t("AgentTokens.setNickname")}
                        </button>
                      )}
                      {saved ? (
                        <>
                          <button type="button" className="d-btn" onClick={() => copy(agent.name, "token", saved.token)}>
                            {copied === `${agent.name}:token` ? t("AgentTokens.copied") : t("AgentTokens.copyToken")}
                          </button>
                          <button type="button" className="d-btn" onClick={() => copy(agent.name, "command", freshCommand(saved))}>
                            {copied === `${agent.name}:command` ? t("AgentTokens.copied") : t("AgentTokens.copyPack")}
                          </button>
                        </>
                      ) : null}
                      <button
                        type="button"
                        className="d-btn agenttokens-delete"
                        disabled={busyName === agent.name}
                        onClick={() => void removeAgent(agent.name)}
                      >
                        {t("AgentTokens.delete")}
                      </button>
                      <button
                        type="button"
                        className="d-btn agenttokens-rotate"
                        disabled={busyName === agent.name}
                        onClick={() => rotate(agent.name)}
                      >
                        {busyName === agent.name ? t("AgentTokens.rotating") : t("AgentTokens.rotate")}
                      </button>
                      {/* 转为常驻——仅 mac 桌面（launchd）；先选 runner(codex/claude) 与工作目录,再 dutyAdopt 落地。 */}
                      {canMakeResident && (
                        <>
                          <select
                            className="d-input agenttokens-resident-runner"
                            aria-label={t("AgentTokens.residentRunnerLabel", { name: agent.name })}
                            value={residentRunnerFor(agent.name)}
                            disabled={residentBusy !== null}
                            onChange={(event) =>
                              setResidentRunnerByName((current) => ({
                                ...current,
                                [agent.name]: event.target.value as DesktopAgentRunner,
                              }))
                            }
                          >
                            <option value="codex">codex</option>
                            <option value="claude">claude</option>
                          </select>
                          <button
                            type="button"
                            className="d-btn agenttokens-resident"
                            disabled={residentBusy !== null}
                            onClick={() => void makeResident(agent.name)}
                          >
                            {residentBusy === agent.name
                              ? t("AgentTokens.residentBusy")
                              : residentDone.has(agent.name)
                                ? t("AgentTokens.residentDone")
                                : t("AgentTokens.resident")}
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {localOnly.length > 0 && (
            <>
              <p className="agenttokens-subtitle">{t("AgentTokens.localOnlyTitle")}</p>
              <ul className="agenttokens-list">
                {localOnly.map((rec) => (
                  <li key={rec.name} className="agenttokens-item agenttokens-item--stale">
                    <div className="agenttokens-main">
                      <strong className="agenttokens-name">{rec.name}</strong>
                      <span className="agenttokens-meta">{t("AgentTokens.localOnlyMeta")}</span>
                    </div>
                    {tokenField(`local:${rec.name}`, rec.token)}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="agenttokens-project">
            <div className="agenttokens-project-head">
              <p className="agenttokens-subtitle">{t("AgentTokens.projectTitle")}</p>
              <span className="agenttokens-meta">{profiles === null ? "" : profiles.length}</span>
            </div>
            <div className="agenttokens-profile-form">
              <input
                className="agenttokens-input t-mono"
                value={profileForm.handle}
                onChange={(event) => setProfileForm((current) => ({ ...current, handle: event.target.value }))}
                placeholder={t("AgentTokens.profileHandle")}
                aria-label={t("AgentTokens.profileHandle")}
              />
              <select
                className="agenttokens-input"
                value={profileForm.runner}
                onChange={(event) => setProfileForm((current) => ({ ...current, runner: event.target.value as ProjectAgentRunner }))}
                aria-label={t("AgentTokens.profileRunner")}
              >
                <option value="codex">codex</option>
                <option value="claude">claude</option>
                <option value="codex-sdk">codex-sdk</option>
                <option value="shell">shell</option>
              </select>
              <input
                className="agenttokens-input"
                value={profileForm.repoUrl}
                onChange={(event) => setProfileForm((current) => ({ ...current, repoUrl: event.target.value }))}
                placeholder={t("AgentTokens.profileRepo")}
                aria-label={t("AgentTokens.profileRepo")}
              />
              <input
                className="agenttokens-input"
                value={profileForm.workdir}
                onChange={(event) => setProfileForm((current) => ({ ...current, workdir: event.target.value }))}
                placeholder={t("AgentTokens.profileWorkdir")}
                aria-label={t("AgentTokens.profileWorkdir")}
              />
              <input
                className="agenttokens-input t-mono"
                value={profileForm.baseBranch}
                onChange={(event) => setProfileForm((current) => ({ ...current, baseBranch: event.target.value }))}
                placeholder={t("AgentTokens.profileBase")}
                aria-label={t("AgentTokens.profileBase")}
              />
              <select
                className="agenttokens-input"
                value={profileForm.worktree}
                onChange={(event) => setProfileForm((current) => ({ ...current, worktree: event.target.value as ProjectAgentWorktreeStrategy }))}
                aria-label={t("AgentTokens.profileWorktree")}
              >
                <option value="branch">{t("AgentTokens.worktreeBranch")}</option>
                <option value="shared">{t("AgentTokens.worktreeShared")}</option>
                <option value="none">{t("AgentTokens.worktreeNone")}</option>
              </select>
              <select
                className="agenttokens-input"
                value={profileForm.invitableBy}
                onChange={(event) => setProfileForm((current) => ({ ...current, invitableBy: event.target.value as ProjectAgentInvitableBy }))}
                aria-label={t("AgentTokens.profileInvitableBy")}
              >
                <option value="owner">{t("AgentTokens.invitableOwner")}</option>
                <option value="org">{t("AgentTokens.invitableOrg")}</option>
                <option value="anyone">{t("AgentTokens.invitableAnyone")}</option>
              </select>
              <input
                className="agenttokens-input agenttokens-input--wide"
                value={profileForm.rules}
                onChange={(event) => setProfileForm((current) => ({ ...current, rules: event.target.value }))}
                placeholder={t("AgentTokens.profileRules")}
                aria-label={t("AgentTokens.profileRules")}
              />
              <button type="button" className="d-btn agenttokens-create-profile" disabled={creatingProfile} onClick={createProfile}>
                {creatingProfile ? t("AgentTokens.creatingProfile") : t("AgentTokens.createProfile")}
              </button>
            </div>
            {profiles !== null && profiles.length > 0 && (
              <ul className="agenttokens-list agenttokens-profile-list">
                {profiles.map((profile) => {
                  const key = `${profile.owner_account}/${profile.handle}`;
                  const isEditing = editingRules === key;
                  return (
                    <li key={key} className="agenttokens-item">
                      <div className="agenttokens-main">
                        <strong className="agenttokens-name">{profile.handle}</strong>
                        <span className="agenttokens-meta">
                          {profile.runner} · {profile.base_branch} · {profile.worktree_strategy}
                        </span>
                      </div>
                      {isEditing ? (
                        <div className="agenttokens-rules-edit-wrap">
                          <textarea
                            className="agenttokens-input agenttokens-input--wide agenttokens-rules-edit"
                            value={rulesDraft}
                            onChange={(event) => setRulesDraft(event.target.value)}
                            placeholder={t("AgentTokens.profileRules")}
                            aria-label={t("AgentTokens.rulesLabel")}
                          />
                          <div className="agenttokens-actions">
                            <button
                              type="button"
                              className="d-btn agenttokens-save-rules"
                              disabled={savingRules === key}
                              onClick={() => saveProfileRules(profile)}
                            >
                              {savingRules === key ? t("AgentTokens.savingRules") : t("AgentTokens.saveRules")}
                            </button>
                            <button
                              type="button"
                              className="d-btn agenttokens-cancel-rules"
                              disabled={savingRules === key}
                              onClick={cancelEditRules}
                            >
                              {t("AgentTokens.cancelRules")}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {profile.rules !== null && profile.rules !== "" ? (
                            <pre className="agenttokens-rules" aria-label={t("AgentTokens.rulesLabel")}>{profile.rules}</pre>
                          ) : (
                            <span className="agenttokens-rules-empty">{t("AgentTokens.noRules")}</span>
                          )}
                          <div className="agenttokens-actions">
                            <button type="button" className="d-btn agenttokens-edit-rules" onClick={() => startEditRules(profile)}>
                              {t("AgentTokens.editRules")}
                            </button>
                            <button type="button" className="d-btn" disabled={busyProfile === key} onClick={() => inviteProfile(profile)}>
                              {busyProfile === key ? t("AgentTokens.invitingProfile") : t("AgentTokens.inviteProfile")}
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
