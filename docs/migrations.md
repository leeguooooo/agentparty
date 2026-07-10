# D1 migrations — numbering contract

`worker/migrations/` holds the Cloudflare D1 schema migrations. They are applied
with `wrangler d1 migrations apply` (see `worker/package.json` → `migrate:remote`,
run automatically by `deploy`).

## The rule

**Every migration filename must have a unique `NNNN_` number.** Add a new
migration as the next free number (`0024_…`, `0025_…`, …). Never reuse a number.

A CI guard enforces this: `scripts/check-migration-numbering.ts` fails the build
(`bun run check`) if two files share a number.

## Why numbers must be unique

wrangler applies migrations in the order it **enumerates the directory**. In the
version this repo pins (`wrangler ^4.22.0`, currently resolving to `4.35.0`),
`getMigrationNames` reads the folder with `opendirSync().readSync()` and applies
**no sort at all** — so files run in raw filesystem enumeration order, which can
differ across machines and platforms. Newer wrangler (`4.107.0`) *does* sort, so
the ordering guarantee is version-dependent under a `^` range. Two files sharing a
number is therefore a latent, environment-dependent hazard even when it happens to
work today.

## The grandfathered collisions (do not "fix" them)

Two numbers already collide:

| number | files |
| --- | --- |
| `0015` | `0015_agent_profiles.sql`, `0015_guard_config.sql` |
| `0016` | `0016_account_profile_metadata.sql`, `0016_account_profiles_handle_nocase.sql` |

These are **already applied to production** (both prod and xdream). They are
currently benign only because, within each pair, the two files touch disjoint
schema objects (e.g. `agent_profiles` vs. `channels`), so their relative order does
not matter.

**They must not be renumbered.** wrangler records each applied migration by its
*exact filename* in the `d1_migrations` table; `getUnappliedMigrations` computes
"unapplied = files on disk whose name is not in that table". Renaming an
already-applied file makes wrangler treat it as a brand-new migration and **run it
again** against production — re-executing `CREATE TABLE` / `ALTER TABLE` and
failing or corrupting the live schema.

So the collisions are frozen: tolerated by the guard via a grandfather list, but no
new file may join them. The guard rejects a third file on `0015`/`0016` and rejects
renaming any grandfathered file. **Do not extend the grandfather list to silence a
new collision — renumber the new migration instead.**

## Running the guard locally

```bash
bun scripts/check-migration-numbering.ts        # checks worker/migrations/
bun test scripts/check-migration-numbering.test.ts
```

Reference: issue #112.
