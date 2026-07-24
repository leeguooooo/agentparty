// #700：本机 agent 概览——独立弹窗、全局按频道视角、可检索。
// 与 DesktopAgentPanel（设置里的「启动器」，管单次起停 + 转常驻）互补：这里是「监控/管理」面
// ——把 app 内实例（statusAll）与 launchd 常驻（dutyList）归一、按频道分组、支持检索，并就地停止/卸载。
// 可从频道页工具条唤起（scopeChannel 预过滤到当前频道），也可全局打开。
import { useEffect, useMemo, useRef, useState } from "react";
import type { TFunc } from "../i18n/useT";
import {
  desktopAgentAdapter,
  dutyDependencyErrorRunner,
  dutyRepairInput,
  type DesktopAgentAdapter,
  type DesktopAgentStatus,
  type DesktopDutyEntry,
} from "../lib/desktopAgent";
import { aggregateLocalAgents, filterLocalAgents, groupLocalAgentsByChannel } from "../lib/localAgents";
import type { DesktopAgentScheduler } from "./DesktopAgentPanel";
import "../i18n/strings/LocalAgentsOverview";

const defaultScheduler: DesktopAgentScheduler = {
  every(callback, intervalMs) {
    const timer = globalThis.setInterval(callback, intervalMs);
    return () => globalThis.clearInterval(timer);
  },
};

interface Props {
  t: TFunc;
  adapter?: DesktopAgentAdapter;
  scheduler?: DesktopAgentScheduler;
  active?: boolean;
  // 从频道页唤起时预过滤到该频道（点 ①「频道里能管理」）；全局打开则不传，看全部。
  scopeChannel?: string | null;
}

function isActive(state: string): boolean {
  return state === "starting" || state === "running" || state === "stopping";
}

export function LocalAgentsOverview({
  t,
  adapter = desktopAgentAdapter,
  scheduler = defaultScheduler,
  active = true,
  scopeChannel = null,
}: Props) {
  // available=null 未探测；false=不可用（非 macOS/旧壳，statusAll 与 dutyList 都失败）。
  const [available, setAvailable] = useState<boolean | null>(null);
  const [instances, setInstances] = useState<DesktopAgentStatus[]>([]);
  const [duties, setDuties] = useState<DesktopDutyEntry[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const mountedRef = useRef(true);
  const opRef = useRef(false);
  // #707 评审：挂载刷新 / 轮询 / 操作后刷新可并发，早发的请求后到会把新快照覆盖成旧的。
  // 单调序号——只让「最新一次 refresh」的结果落地，乱序完成的旧结果丢弃。
  const refreshSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = async (): Promise<void> => {
    const seq = ++refreshSeqRef.current;
    let anyOk = false;
    let nextInstances: DesktopAgentStatus[] = [];
    try {
      nextInstances = await adapter.statusAll();
      anyOk = true;
    } catch {
      try {
        const single = await adapter.status();
        nextInstances = single.instanceId !== null || single.state !== "stopped" ? [single] : [];
        anyOk = true;
      } catch {
        // statusAll 与 status 都失败：本机 agent 不可用
      }
    }
    let nextDuties: DesktopDutyEntry[] = [];
    try {
      nextDuties = await adapter.dutyList();
      anyOk = true;
    } catch {
      // 非 macOS / 旧壳：无常驻，忽略
    }
    if (!aliveRef.current || seq !== refreshSeqRef.current) return;
    // 只列活跃/存在的实例：stopped 且无 instanceId 的空位不进概览（与启动器的完整实例表不同）。
    setInstances(nextInstances.filter((item) => item.state !== "stopped" || item.instanceId !== null));
    setDuties(nextDuties);
    setAvailable(anyOk);
  };

  useEffect(() => {
    if (!active) {
      aliveRef.current = false;
      return () => {
        aliveRef.current = false;
        refreshSeqRef.current += 1;
      };
    }
    aliveRef.current = true;
    void refresh();
    const cancel = scheduler.every(() => void refresh(), 3_000);
    return () => {
      aliveRef.current = false;
      refreshSeqRef.current += 1;
      cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, adapter, scheduler]);

  const groups = useMemo(() => {
    const rows = aggregateLocalAgents(instances, duties);
    const scoped = scopeChannel === null || scopeChannel === "" ? rows : rows.filter((row) => row.channel === scopeChannel);
    return groupLocalAgentsByChannel(filterLocalAgents(scoped, query));
  }, [instances, duties, query, scopeChannel]);

  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    if (opRef.current) return;
    opRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      if (aliveRef.current) await refresh();
    } catch (cause) {
      if (aliveRef.current) {
        const runner = dutyDependencyErrorRunner(cause);
        setActionError(
          runner === null
            ? t("LocalAgents.actionFailed")
            : t("DesktopSettings.agent.dutyDependencyMissing", { runner }),
        );
      }
    } finally {
      opRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const totalRows = groups.reduce((sum, g) => sum + g.rows.length, 0);

  return (
    <section className="local-agents" aria-labelledby="local-agents-title">
      <header className="local-agents-head">
        <strong id="local-agents-title">{t("LocalAgents.title")}</strong>
        <p className="local-agents-subtitle">{t("LocalAgents.subtitle")}</p>
      </header>

      {available === false ? (
        <p className="local-agents-empty" role="status">{t("LocalAgents.unavailable")}</p>
      ) : (
        <>
          <input
            type="search"
            className="local-agents-search t-mono"
            name="local-agents-search"
            value={query}
            placeholder={t("LocalAgents.search")}
            aria-label={t("LocalAgents.searchLabel")}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
          {actionError !== null && (
            <p className="desktop-agent-error" role="alert">{actionError}</p>
          )}

          {totalRows === 0 ? (
            <p className="local-agents-empty" role="status">
              {query.trim() !== "" ? t("LocalAgents.emptyFiltered") : t("LocalAgents.empty")}
            </p>
          ) : (
            <div className="local-agents-groups">
              {groups.map((group) => (
                <section key={group.channel || "unassigned"} className="local-agents-group" aria-label={group.channel || t("LocalAgents.unassigned")}>
                  <h4 className="local-agents-group-title">
                    <span className="t-mono">{group.channel || t("LocalAgents.unassigned")}</span>
                    <span className="local-agents-group-count">{t("LocalAgents.count", { count: group.rows.length })}</span>
                  </h4>
                  <ul className="local-agents-list">
                    {group.rows.map((row) => (
                      <li key={row.key} className={`local-agents-row local-agents-row--${row.kind}`}>
                        <span className={`local-agents-badge local-agents-badge--${row.kind}`}>
                          {t(row.kind === "duty" ? "LocalAgents.kind.duty" : "LocalAgents.kind.instance")}
                        </span>
                        <span className="t-mono local-agents-name">{row.name}</span>
                        {row.runner !== null && <span className="local-agents-runner">{row.runner}</span>}
                        <span className={`desktop-agent-state desktop-agent-state--${row.state}`}>
                          {row.kind === "duty"
                            ? t(row.duty!.loaded ? "DesktopSettings.agent.dutyLoaded" : "DesktopSettings.agent.dutyNotLoaded")
                            : t(`DesktopSettings.agent.state.${row.state}`)}
                        </span>
                        {row.kind === "duty" && (
                          row.duty!.dependencyState === "missing" ||
                          row.duty!.dependencyState === "repair-required"
                        ) && (
                          <span className="desktop-agent-error" role="alert">
                            {t(
                              row.duty!.dependencyState === "missing"
                                ? "DesktopSettings.agent.dutyDependencyMissing"
                                : "DesktopSettings.agent.dutyDependencyRepair",
                              { runner: row.duty!.runner ?? "runner" },
                            )}
                          </span>
                        )}
                        {row.kind === "instance" && row.instanceId !== null && isActive(row.state) && (
                          <button
                            type="button"
                            className="d-btn local-agents-stop"
                            disabled={busy}
                            aria-label={`${t("DesktopSettings.agent.instanceStop")} ${row.instanceId}`}
                            onClick={() => void runAction(() => adapter.stopInstance(row.instanceId!))}
                          >
                            {t("DesktopSettings.agent.instanceStop")}
                          </button>
                        )}
                        {row.kind === "duty" && (
                          <>
                            {(
                              row.duty!.dependencyState === "missing" ||
                              row.duty!.dependencyState === "repair-required"
                            ) && dutyRepairInput(row.duty!) !== null && (
                              <button
                                type="button"
                                className="d-btn local-agents-repair"
                                disabled={busy}
                                aria-label={`${t("DesktopSettings.agent.dutyRepair")} ${row.instanceId}`}
                                onClick={() => {
                                  const input = dutyRepairInput(row.duty!);
                                  if (input !== null) void runAction(() => adapter.dutyPersist(input));
                                }}
                              >
                                {t("DesktopSettings.agent.dutyRepair")}
                              </button>
                            )}
                            <button
                              type="button"
                              className="d-btn local-agents-unload"
                              disabled={busy}
                              aria-label={`${t("DesktopSettings.agent.dutyUnload")} ${row.instanceId}`}
                              onClick={() => void runAction(() => adapter.dutyUnpersist(row.instanceId!))}
                            >
                              {t("DesktopSettings.agent.dutyUnload")}
                            </button>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
