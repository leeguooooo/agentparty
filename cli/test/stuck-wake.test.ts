// #198：游标不能同时表达「已了结」与「欠账」。
// stuck = 送达失败、从没进过模型的那条 seq。它必须落盘（进程崩了也要记得），
// 必须被 --skip-backlog 排除，且重放必须有界（失败 N 次后响亮地放弃）。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearStuck,
  loadStuck,
  markWatchDirectedStuckAccepted,
  saveStuck,
  saveWatchStuck,
} from "../src/config";

const cwd = () => mkdtempSync(join(tmpdir(), "ap-stuck-"));

describe("stuck wake persistence (#198 约束①：stuck 落盘)", () => {
  test("没有欠账时读出 null", () => {
    expect(loadStuck("dev", cwd())).toBeNull();
  });

  test("欠账落盘后能读回 seq / attempts / last_error", () => {
    const d = cwd();
    saveStuck("dev", { seq: 100, attempts: 1, last_error: "runner exploded" }, d);
    expect(loadStuck("dev", d)).toEqual({ seq: 100, attempts: 1, last_error: "runner exploded" });
  });

  test("欠账与游标并列，互不覆盖", () => {
    const d = cwd();
    const { saveCursor, loadCursor } = require("../src/config");
    saveCursor("dev", 99, d);
    saveStuck("dev", { seq: 100, attempts: 2 }, d);
    expect(loadCursor("dev", d)).toBe(99);
    expect(loadStuck("dev", d)?.seq).toBe(100);
  });

  test("欠账按频道隔离", () => {
    const d = cwd();
    saveStuck("alpha", { seq: 7, attempts: 1 }, d);
    expect(loadStuck("beta", d)).toBeNull();
    expect(loadStuck("alpha", d)?.seq).toBe(7);
  });

  test("了结后清除欠账", () => {
    const d = cwd();
    saveStuck("dev", { seq: 100, attempts: 3 }, d);
    clearStuck("dev", d);
    expect(loadStuck("dev", d)).toBeNull();
  });

  test("重试计数可以累加（同一条 seq 的失败次数要活过进程重启）", () => {
    const d = cwd();
    saveStuck("dev", { seq: 100, attempts: 1 }, d);
    const prev = loadStuck("dev", d)!;
    saveStuck("dev", { ...prev, attempts: prev.attempts + 1, last_error: "again" }, d);
    expect(loadStuck("dev", d)).toEqual({ seq: 100, attempts: 2, last_error: "again" });
  });

  test("watch durable delivery 元数据与 seq 一起活过进程重启 (#551)", () => {
    const d = cwd();
    saveWatchStuck("dev", {
      seq: 100,
      delivery_id: "delivery-100",
      work_id: "work-100",
      continuation_ref: "codex:thread-100",
      delivery_acceptance: "unconfirmed",
      attempts: 0,
      source: "watch",
    }, d);
    expect(loadStuck("dev", d)).toEqual({
      seq: 100,
      delivery_id: "delivery-100",
      work_id: "work-100",
      continuation_ref: "codex:thread-100",
      delivery_acceptance: "unconfirmed",
      attempts: 0,
      source: "watch",
    });
  });

  test("directed watch debt 仅能按同 delivery id 原子推进 accepted", () => {
    const d = cwd();
    saveWatchStuck("dev", {
      seq: 100,
      delivery_id: "delivery-100",
      delivery_acceptance: "unconfirmed",
      attempts: 0,
      source: "watch",
    }, d);

    expect(markWatchDirectedStuckAccepted("dev", "wrong-delivery", d)).toBe(false);
    expect(loadStuck("dev", d)?.delivery_acceptance).toBe("unconfirmed");
    expect(markWatchDirectedStuckAccepted("dev", "delivery-100", d)).toBe(true);
    expect(loadStuck("dev", d)).toMatchObject({
      delivery_id: "delivery-100",
      delivery_acceptance: "accepted",
      last_error: "watch delivery accepted; awaiting agent acknowledgement",
    });
    expect(markWatchDirectedStuckAccepted("dev", "delivery-100", d)).toBe(false);
  });

  test("watch 原子写不能覆盖 serve 欠账，但可以创建或更新自己的欠账 (#508)", () => {
    const d = cwd();
    saveStuck("dev", { seq: 100, attempts: 1 }, d);

    expect(saveWatchStuck("dev", { seq: 101, attempts: 0, source: "watch" }, d)).toBe(false);
    expect(loadStuck("dev", d)).toEqual({ seq: 100, attempts: 1 });

    clearStuck("dev", d);
    expect(saveWatchStuck("dev", { seq: 101, attempts: 0, source: "watch" }, d)).toBe(true);
    expect(saveWatchStuck("dev", { seq: 101, attempts: 1, source: "watch" }, d)).toBe(true);
    expect(loadStuck("dev", d)).toEqual({ seq: 101, attempts: 1, source: "watch" });
  });
});
