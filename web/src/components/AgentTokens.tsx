import { type CSSProperties, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AuthError,
  type ChannelAgentInfo,
  ForbiddenError,
  type ProjectAgentInvitableBy,
  type ProjectAgentProfile,
  type ProjectAgentRunner,
  type ProjectAgentWorktreeStrategy,
  createProjectAgentProfile,
  inviteProjectAgent,
  listChannelAgents,
  listProjectAgentProfiles,
  rotateChannelAgent,
  ValidationError,
} from "../lib/api";
import {
  buildMinimalAgentCommand,
  copyText,
  findSavedAgentToken,
  listSavedAgentTokens,
  saveAgentToken,
} from "../lib/agentTokenVault";
import { useT } from "../i18n/useT";
import "../i18n/strings/AgentTokens";

interface Props {
  slug: string;
  token: string;
  accountKey: string;
  inviterName: string;
  onAuthFailed(message: string): void;
  active?: boolean;
  onActiveChange?(open: boolean): void;
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

export function AgentTokens({ slug, token, accountKey, inviterName, onAuthFailed, active, onActiveChange }: Props) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<ChannelAgentInfo[] | null>(null);
  const [profiles, setProfiles] = useState<ProjectAgentProfile[] | null>(null);
  const [profileForm, setProfileForm] = useState<ProfileForm>({
    handle: "",
    runner: "codex",
    repoUrl: "",
    workdir: "",
    baseBranch: "main",
    worktree: "branch",
    invitableBy: "owner",
    rules: "",
  });
  const [busyName, setBusyName] = useState<string | null>(null);
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

  const toggle = useCallback(() => {
    const next = !isOpen;
    if (active === undefined) setOpen(next);
    onActiveChange?.(next);
    if (next && agents === null) void refresh();
  }, [active, agents, isOpen, onActiveChange, refresh]);

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

  async function rotate(name: string) {
    const ok = window.confirm(t("AgentTokens.rotateConfirm", { name }));
    if (!ok) return;
    setBusyName(name);
    setError(null);
    try {
      const next = await rotateChannelAgent(token, slug, name);
      const command = buildMinimalAgentCommand({
        server: location.origin,
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
        savedAt: Date.now(),
      });
      await refresh();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setError(t("AgentTokens.errRotateForbidden"));
      else setError(t("AgentTokens.errRotate"));
    } finally {
      setBusyName(null);
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
        <div className="agenttokens-panel" style={panelStyle}>
          <div className="agenttokens-head">
            <span className="agenttokens-title">{t("AgentTokens.title")}</span>
            <button type="button" className="d-btn agenttokens-refresh" onClick={refresh}>
              {t("AgentTokens.refresh")}
            </button>
          </div>
          <p className="agenttokens-hint">{t("AgentTokens.hint")}</p>
          {error !== null && <p className="agenttokens-error">{error}</p>}
          {(agents === null || profiles === null) && error === null && <p className="agenttokens-empty">{t("AgentTokens.loading")}</p>}
          {agents !== null && agents.length === 0 && localOnly.length === 0 && (
            <p className="agenttokens-empty">{t("AgentTokens.empty")}</p>
          )}
          {agents !== null && agents.length > 0 && (
            <ul className="agenttokens-list">
              {agents.map((agent) => {
                const saved = findSavedAgentToken(accountKey, slug, agent.name);
                return (
                  <li key={agent.name} className="agenttokens-item">
                    <div className="agenttokens-main">
                      <strong className="agenttokens-name">{agent.name}</strong>
                      <span className="agenttokens-meta">
                        {saved ? t("AgentTokens.hasPlaintext") : t("AgentTokens.noPlaintext")}
                      </span>
                    </div>
                    {saved ? tokenField(`server:${agent.name}`, saved.token) : null}
                    <div className="agenttokens-actions">
                      {saved ? (
                        <>
                          <button type="button" className="d-btn" onClick={() => copy(agent.name, "token", saved.token)}>
                            {copied === `${agent.name}:token` ? t("AgentTokens.copied") : t("AgentTokens.copyToken")}
                          </button>
                          <button type="button" className="d-btn" onClick={() => copy(agent.name, "command", saved.command)}>
                            {copied === `${agent.name}:command` ? t("AgentTokens.copied") : t("AgentTokens.copyPack")}
                          </button>
                        </>
                      ) : null}
                      <button
                        type="button"
                        className="d-btn agenttokens-rotate"
                        disabled={busyName === agent.name}
                        onClick={() => rotate(agent.name)}
                      >
                        {busyName === agent.name ? t("AgentTokens.rotating") : t("AgentTokens.rotate")}
                      </button>
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
