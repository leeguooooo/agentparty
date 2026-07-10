import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  analyzeMigrations,
  GRANDFATHERED_DUPLICATES,
} from "./check-migration-numbering";

const repoRoot = resolve(import.meta.dir, "..");
const script = join(repoRoot, "scripts", "check-migration-numbering.ts");
const realMigrationsDir = join(repoRoot, "worker", "migrations");

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) {
    const dir = cleanup.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "agentparty-migrations-"));
  cleanup.push(dir);
  for (const f of files) writeFileSync(join(dir, f), "-- fixture\n");
  return dir;
}

function run(args: string[]): { status: number; out: string } {
  const r = spawnSync("bun", [script, ...args], {
    encoding: "utf8",
    env: process.env,
  });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe("analyzeMigrations (pure)", () => {
  test("flags a fresh duplicate number as forbidden", () => {
    const res = analyzeMigrations(
      ["0001_a.sql", "0002_b.sql", "0002_c.sql"],
      [],
    );
    expect(res.forbidden.map((g) => g.number)).toEqual([2]);
    expect(res.forbidden[0].files).toEqual(["0002_b.sql", "0002_c.sql"]);
  });

  test("grandfathered duplicates are tolerated, not forbidden", () => {
    const res = analyzeMigrations(
      [...GRANDFATHERED_DUPLICATES],
      GRANDFATHERED_DUPLICATES,
    );
    // both 0015 and 0016 collide, but all files are grandfathered
    expect(res.duplicates.map((g) => g.number)).toEqual([15, 16]);
    expect(res.forbidden).toEqual([]);
  });

  test("adding a THIRD file to a grandfathered number is forbidden (frozen)", () => {
    const res = analyzeMigrations(
      [...GRANDFATHERED_DUPLICATES, "0015_new_thing.sql"],
      GRANDFATHERED_DUPLICATES,
    );
    expect(res.forbidden.map((g) => g.number)).toEqual([15]);
  });

  test("renaming a grandfathered file is forbidden (would re-run in prod)", () => {
    const renamed = GRANDFATHERED_DUPLICATES.map((f) =>
      f === "0015_guard_config.sql" ? "0015_guardcfg.sql" : f,
    );
    const res = analyzeMigrations(renamed, GRANDFATHERED_DUPLICATES);
    expect(res.forbidden.map((g) => g.number)).toEqual([15]);
  });

  test("unique numbering yields no duplicates", () => {
    const res = analyzeMigrations(
      ["0001_a.sql", "0002_b.sql", "0003_c.sql"],
      [],
    );
    expect(res.duplicates).toEqual([]);
    expect(res.forbidden).toEqual([]);
  });

  test("a .sql without a numeric prefix is reported as unnumbered", () => {
    const res = analyzeMigrations(["init.sql", "0001_a.sql"], []);
    expect(res.unnumbered).toEqual(["init.sql"]);
  });
});

describe("check-migration-numbering CLI", () => {
  test("real worker/migrations passes (grandfathered dups tolerated)", () => {
    const r = run(["--dir", realMigrationsDir]);
    expect(r.status).toBe(0);
  });

  test("exits non-zero on a NEW duplicate number", () => {
    const dir = makeDir(["0001_a.sql", "0007_b.sql", "0007_c.sql"]);
    const r = run(["--dir", dir, "--allow", ""]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("0007");
  });

  test("exits zero on a clean, uniquely-numbered dir", () => {
    const dir = makeDir(["0001_a.sql", "0002_b.sql", "0003_c.sql"]);
    const r = run(["--dir", dir, "--allow", ""]);
    expect(r.status).toBe(0);
  });

  test("grandfather is frozen: a third file on a known dup fails", () => {
    const dir = makeDir([...GRANDFATHERED_DUPLICATES, "0015_new_thing.sql"]);
    // no --allow → CLI uses the built-in grandfather list
    const r = run(["--dir", dir]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("0015");
  });
});
