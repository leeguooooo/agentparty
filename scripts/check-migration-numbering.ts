#!/usr/bin/env bun
// Guard against duplicate D1 migration numbers in worker/migrations/.
//
// Why this exists (issue #112): wrangler applies migrations in the order it
// enumerates the directory. In the version this repo pins (wrangler ^4.22.0,
// resolved 4.35.0) `getMigrationNames` reads the folder with
// `opendirSync().readSync()` and applies NO sort — so same-numbered files run in
// raw filesystem enumeration order, which differs across machines/platforms.
// Newer wrangler (4.107.0) does sort, so the guarantee is version-dependent under
// a `^` range. Either way, two files sharing a number is a latent hazard.
//
// We CANNOT simply renumber the existing collisions: they are already applied to
// production (prod + xdream). wrangler records applied migrations by exact
// filename in the `d1_migrations` table; renaming an applied file makes wrangler
// treat it as new and re-run it. So the existing pairs are grandfathered (frozen),
// and this guard blocks any NEW collision — including a third file on a known
// number or a rename of a grandfathered file.
//
// See docs/migrations.md.

import { readdirSync } from "node:fs";
import { resolve } from "node:path";

// Duplicate migration filenames that already collide AND are already applied to
// production. Tolerated but FROZEN — do not add to this list to "fix" a new
// collision; renumber the new migration instead.
export const GRANDFATHERED_DUPLICATES: readonly string[] = [
  "0015_agent_profiles.sql",
  "0015_guard_config.sql",
  "0016_account_profile_metadata.sql",
  "0016_account_profiles_handle_nocase.sql",
];

// Exactly four digits: the documented contract is `NNNN_`. `\d+` would let
// `25_bad_width.sql` or `00250_x.sql` slip through with a width that sorts
// differently from the 4-digit files around it.
export const MIGRATION_RE = /^(\d{4})_.*\.sql$/;

export interface DuplicateGroup {
  number: number;
  files: string[];
}

export interface AnalysisResult {
  /** Every number owned by more than one file (grandfathered or not). */
  duplicates: DuplicateGroup[];
  /** Duplicate groups that are NOT fully grandfathered — these fail the guard. */
  forbidden: DuplicateGroup[];
  /** `.sql` files without a leading `NNNN_` migration prefix. */
  unnumbered: string[];
  /**
   * Grandfathered (already-applied) filenames that are no longer present in the
   * directory. Renaming/removing an applied migration makes wrangler treat it as
   * new and re-run it against production — so a missing grandfathered file fails
   * the guard even though it produces no NEW duplicate number. This is the
   * "rename an applied migration across numbers" bypass the duplicate check alone
   * cannot see.
   */
  missingGrandfathered: string[];
}

export function analyzeMigrations(
  filenames: readonly string[],
  allowed: Iterable<string> = GRANDFATHERED_DUPLICATES,
): AnalysisResult {
  const allowSet = new Set(allowed);
  const fileSet = new Set(filenames);
  const byNumber = new Map<number, string[]>();
  const unnumbered: string[] = [];

  for (const name of filenames) {
    if (!name.endsWith(".sql")) continue;
    const match = MIGRATION_RE.exec(name);
    if (!match) {
      unnumbered.push(name);
      continue;
    }
    const number = Number.parseInt(match[1], 10);
    const files = byNumber.get(number) ?? [];
    files.push(name);
    byNumber.set(number, files);
  }

  const duplicates: DuplicateGroup[] = [];
  const forbidden: DuplicateGroup[] = [];

  for (const [number, files] of [...byNumber].sort((a, b) => a[0] - b[0])) {
    if (files.length < 2) continue;
    const group: DuplicateGroup = { number, files: [...files].sort() };
    duplicates.push(group);
    // A collision is only tolerated when EVERY file in it is grandfathered.
    if (!group.files.every((f) => allowSet.has(f))) forbidden.push(group);
  }

  const missingGrandfathered = [...allowSet].filter((f) => !fileSet.has(f)).sort();

  return { duplicates, forbidden, unnumbered: unnumbered.sort(), missingGrandfathered };
}

interface CliOptions {
  dir: string;
  allowed: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const defaultDir = resolve(import.meta.dir, "..", "worker", "migrations");
  let dir = defaultDir;
  let allowed: string[] = [...GRANDFATHERED_DUPLICATES];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") {
      dir = resolve(argv[++i] ?? "");
    } else if (arg === "--allow") {
      // `--allow ""` means "nothing is grandfathered".
      const raw = argv[++i] ?? "";
      allowed = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { dir, allowed };
}

function main(): void {
  const { dir, allowed } = parseArgs(process.argv.slice(2));

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.error(`check-migration-numbering: cannot read ${dir}: ${err}`);
    process.exit(2);
  }

  const { duplicates, forbidden, unnumbered, missingGrandfathered } = analyzeMigrations(
    entries,
    allowed,
  );

  if (forbidden.length === 0 && unnumbered.length === 0 && missingGrandfathered.length === 0) {
    const note =
      duplicates.length > 0
        ? ` (${duplicates.length} grandfathered duplicate number(s) tolerated)`
        : "";
    console.log(
      `check-migration-numbering: ok — ${dir}${note}`,
    );
    process.exit(0);
  }

  console.error(`check-migration-numbering: FAILED for ${dir}`);
  for (const group of forbidden) {
    const num = String(group.number).padStart(4, "0");
    console.error(
      `  duplicate migration number ${num}: ${group.files.join(", ")}`,
    );
  }
  for (const name of unnumbered) {
    console.error(`  .sql without NNNN_ prefix: ${name}`);
  }
  for (const name of missingGrandfathered) {
    console.error(
      `  already-applied migration renamed/removed: ${name} — wrangler would re-run it against production`,
    );
  }
  console.error(
    "\nEach migration number must be unique. Renumber the new migration to the " +
      "next free number. Do NOT rename an already-applied migration and do NOT " +
      "extend the grandfather list — see docs/migrations.md and issue #112.",
  );
  process.exit(1);
}

if (import.meta.main) main();
