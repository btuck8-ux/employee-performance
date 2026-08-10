<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# EPD — agent trap-list

Read this before changing anything. Every item below is a trap that has
already cost a session (or was deliberately decided); none of it is
derivable from the code alone.

## Standing collaboration protocol (Tucker, 2026-08-07)

- **Codex rides along as validator.** Claude Code is the lead engineer and
  builder; Codex (official plugin) is the validator and sanity-check layer.
  Codex reviews each completed item's diff (minimum: full branch diff
  pre-PR). Every finding is fixed or explicitly dismissed with a one-line
  reason in the PR description — no silent drops. Codex validates; it never
  writes code.
- **All decision points go to Tucker before they're finalized — even in
  auto-mode.** Auto-mode covers execution, never decisions. Decision points
  include, at minimum: deviations from the active packet/plan; ambiguity
  where reasonable implementations differ in behavior; auth/security
  choices; any TS↔SQL scoring-parity mismatch (never silently pick which
  side is "right"); unlisted file deletions; dependency changes beyond
  those agreed. When in doubt: it's a decision point. Present options + a
  recommendation, then wait.

## Live consumers — coordinate before ANY shape change

- `/api/scores` + `/api/identity` are polled **daily in production** —
  CulturePulse (identity 08:45 UTC, scores 09:00 UTC) and Training HQ
  (scores 11:15 UTC). Response shapes, auth semantics, and pagination are
  a cross-project contract. The scores payload is additive-only: mig 045
  appended the 9 individual metrics behind CS/TIS (wire names mirror
  `performance_records` columns; null = not-computed, never 0;
  `scores-feed-contract.test.ts` pins the shape).
- `/api/admin/cake-profile-ids` + `/api/admin/cake-timesheet-import` are
  the **cake-nightly GitHub Action's** landing points (13:30 UTC daily).
- `/api/admin/set-tattle-token` is the **tattle-nightly Action's** landing
  point (scheduled 13:50 UTC daily — but the Action has run exactly once
  ever, failed 2026-07-27, and has never stored a token; the Tattle feed
  actually rides env `TATTLE_BEARER_TOKEN` + manual recapture, with the
  nightly alert email as the expiry tripwire).
- Avoid landing merges during the nightly ingest window (~09:00–10:15 UTC)
  and the GH-Action window (~13:30–14:00 UTC).

## Scoring

- **Scoring math exists TWICE** — TS (`customer-service-score.ts`,
  `total-impact-score.ts`, kitchen/tip logic in
  `performance-recompute.ts`) and SQL (migrations 023/025/026/043). Keep
  them in lockstep; the colocated scoring tests are the guardrail. A
  discovered mismatch is a Tucker-decision, never a silent fix.
- Known-good anchor weights: CS 0.40/0.40/0.20 (null if <2 of 3
  components); TIS 0.40 + 0.15×4 (null if <4 of 5).
- Degenerate all-zero-weights config → composite 0, not null (SQL 023/025
  canonical; aligned 2026-08-07).
- Kitchen Speed has **no web-app surface** — the PDF is the only place it
  renders. Known gap on hold pending Tucker's UI audit, not an oversight.

## Tokens & env

- `set-tattle-token` accepts `TASKS_HARVEST_TOKEN ?? CAKE_HARVEST_TOKEN ??
  CRON_SECRET`. The GH secret `EPD_HARVEST_TOKEN` matches one of the first
  two (unverified which) — **don't simplify the chain** without verifying.
- 7shifts tokens are **Sensitive** Vercel vars (write-only) → identity /
  backfill work must run in-cron, never via local scripts.
- Deploy gate: `IKES_COLORADO_CULTUREPULSE` must exist in prod or Colorado
  ingest breaks at the next 09:00 UTC nightly.

## Routing & data

- `location_code` (CPD/COS/DTD/FCOL/HRANCH/LONGM/HOU/NOLA) is the shared
  cross-project key; EPD mints `employee_code` (location-scoped). CP-side
  uncoded hires = triage aliases before minting new codes (the Lortz
  class).
- NOLA: `actuals_source='cake'` — excluded from the 7shifts time fan-out;
  its labor rides the cake-nightly Playwright Action. `pos_via_7shifts` =
  Houston only.
- `rowMatchesLocation` is strict case-insensitive equality — new vendor
  location labels must be added to `locations.csv_aliases` (migration, the
  035 pattern) or rows silently bucket as `skipped_other_location`.
- `backfill-roles` + `backfill-worked-time` are deliberate operator repair
  levers (both used 2026-08-06) — **not dead code**; don't "clean them
  up".
- `toast-kitchen-probe` is kept deliberately until ~Sept 2026 (kitchen
  feed burn-in); then delete.

## Platform

- Cron routes must live under `/api/cron/*` to stay proxy-allowlisted
  (src/proxy.ts — Next 16 renamed middleware to proxy; renamed here 2026-08-07).
  `maxDuration` cannot be exported from `"use server"` files (Next 16
  Turbopack).
- Migrations: 015 intentionally absent; current head is 045. When Cowork
  applies prod DDL via MCP, the matching migration file gets committed
  (repo↔prod parity — established pattern).
- `@radix-ui/react-dialog` + `@radix-ui/react-select` are
  installed-but-unused **on purpose** (reserved for the UI-polish sprint:
  adopt them for the hand-styled selects + hand-rolled modal) — don't
  remove.

## Testing & lint

- Tests: `node --test` (no jest/vitest), Node 24 type-stripping, colocated
  `*.test.ts`.
- Lint: CI fails on **any** ESLint error. Always run the repo-wide
  `npm run lint`, never a scoped eslint call (a scoped call blocked the
  PR #1 merge). Known-clean baseline: 0 errors / 3 warnings.

## Scope

- Don't build CulturePulse features here — comms/schedule/surveys live in
  CP; EPD scores off actuals.
