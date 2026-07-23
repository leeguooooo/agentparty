// #744:launchd 常驻下,终局不该重启的退出(熔断/撤销)要 serve 自 bootout,别被 KeepAlive 绕过安全停机。
import { describe, expect, test } from "bun:test";
import { EXIT_AUTH, EXIT_STREAM_ENDED } from "@agentparty/shared";
import { EXIT_WAKE_ABANDON_CIRCUIT, selfBootoutTerminalDuty } from "../src/commands/serve";

const LABEL = "com.agentparty.duty.abc.dev";

function recorder() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const lines: string[] = [];
  const spawn = ((cmd: string, args: string[]) => { calls.push({ cmd, args }); return { status: 0 } as never; }) as never;
  const out = (l: string) => lines.push(l);
  return { calls, lines, spawn, out };
}
const base = (over: Record<string, unknown> = {}) => ({ platform: "darwin", uid: 501, label: LABEL, ...over });

describe("selfBootoutTerminalDuty (#744)", () => {
  test("熔断(11)在 macOS + 有 label:bootout 自身 job", () => {
    const r = recorder();
    const did = selfBootoutTerminalDuty(EXIT_WAKE_ABANDON_CIRCUIT, r.out, { ...base(), spawn: r.spawn } as never);
    expect(did).toBe(true);
    expect(r.calls).toEqual([{ cmd: "launchctl", args: ["bootout", `gui/501/${LABEL}`] }]);
  });

  test("token 撤销(auth)同样自卸载(重启也没用)", () => {
    const r = recorder();
    const did = selfBootoutTerminalDuty(EXIT_AUTH, r.out, { ...base(), spawn: r.spawn } as never);
    expect(did).toBe(true);
    expect(r.calls[0]!.args).toEqual(["bootout", `gui/501/${LABEL}`]);
  });

  test("普通可重启退出(stream-ended)不 bootout——留给 KeepAlive 自愈", () => {
    const r = recorder();
    const did = selfBootoutTerminalDuty(EXIT_STREAM_ENDED, r.out, { ...base(), spawn: r.spawn } as never);
    expect(did).toBe(false);
    expect(r.calls).toEqual([]);
  });

  test("没跑在 launchd duty 下(无 AP_DUTY_LABEL):什么都不做", () => {
    const r = recorder();
    const did = selfBootoutTerminalDuty(EXIT_WAKE_ABANDON_CIRCUIT, r.out, { platform: "darwin", uid: 501, label: undefined, spawn: r.spawn } as never);
    expect(did).toBe(false);
    expect(r.calls).toEqual([]);
  });

  test("label 非法(非 duty 前缀 / 含非法字符)→ 拒绝,绝不 bootout(@macmini 评审)", () => {
    for (const bad of ["com.other.job", "com.agentparty.duty.x dev", "com.agentparty.duty.x;rm", "system/"]) {
      const r = recorder();
      const did = selfBootoutTerminalDuty(EXIT_WAKE_ABANDON_CIRCUIT, r.out, { ...base({ label: bad }), spawn: r.spawn } as never);
      expect(did).toBe(false);
      expect(r.calls).toEqual([]);
    }
  });

  test("非 macOS 不碰 launchctl", () => {
    const r = recorder();
    const did = selfBootoutTerminalDuty(EXIT_WAKE_ABANDON_CIRCUIT, r.out, { ...base({ platform: "linux" }), spawn: r.spawn } as never);
    expect(did).toBe(false);
    expect(r.calls).toEqual([]);
  });

  test("bootout 抛错也不炸(best-effort,退出码仍对)", () => {
    const throwing = (() => { throw new Error("launchctl gone"); }) as never;
    const r = recorder();
    expect(() => selfBootoutTerminalDuty(EXIT_WAKE_ABANDON_CIRCUIT, r.out, { ...base(), spawn: throwing } as never)).not.toThrow();
  });

  test("spawnSync 返回非零/error(不抛)→ 记警告,不静默当成功(#745)", () => {
    for (const bad of [{ status: 1 }, { error: new Error("ENOENT") }, { signal: "SIGTERM", status: null }]) {
      const lines: string[] = [];
      const failSpawn = (() => bad) as never;
      const did = selfBootoutTerminalDuty(EXIT_AUTH, (l) => lines.push(l), { ...base(), spawn: failSpawn } as never);
      expect(did).toBe(true);
      expect(lines.some((l) => l.includes("bootout") && l.includes("失败"))).toBe(true);
    }
  });
});
