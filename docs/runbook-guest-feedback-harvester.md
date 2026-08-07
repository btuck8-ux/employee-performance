# Runbook — Unified Guest-Feedback Harvester

One server-side harvester pulls the three unautomated guest-feedback sources and
lands them through the same compute as the manual CSV uploads:

| Source | `ingest_runs.source` | Vendor endpoint (host) | Auth |
|---|---|---|---|
| Tattle Snapshots | `tattle` | `gettattle.com/v2/api/data/snapshots/raw-responses-csv` | Tattle Bearer |
| Online Reviews | `reviews` | `api.tattleapp.io/v3/.../SocialMediaReview/export` → `cdn.tattleapp.io` | Tattle Bearer |
| Per-employee 7Tasks | `7tasks` | 7shifts public API `/v2/company/{id}/task_lists` (tasks-api-source.ts) | 7shifts API token (the labor client's `IKES_*` tokens) |

- **Fetch is shared, ingest is per-location.** Tattle snapshots/reviews are
  pulled once (merchant 2685); the 7Tasks pull fans out per 7shifts company
  (62064 Houston, 185592 the 6 CO stores), calling `task_lists` per store/date
  with stores routed by `seven_shifts_location_id`. Each `(source × location)`
  gets its own `ingest_runs` row with an incremental window.
- **NOLA is excluded** from all three (no Tattle/Reviews merchant feed; no
  7Tasks). Its CS/TIS stay NULL by design.

## Required env (Vercel — set all as **Sensitive**)

| Var | Source | Where to capture |
|---|---|---|
| `TATTLE_BEARER_TOKEN` | A + B (fallback) | `localStorage["ngStorage-token"]` on dashboard.gettattle.com (~42 chars); the stored token from `scripts/tattle-nightly/` is read first |
| `TATTLE_MERCHANT_ID` | optional | defaults to `2685` |
| `CRON_SECRET` | already set | bearer for the admin + cron routes |

Source C needs no harvester-specific secret — it authenticates with the same
`IKES_*` 7shifts API tokens the labor ingest uses (already set as Sensitive).

A missing secret **throws** (surfaces as an `error` ingest_run), never a
fake-empty success.

## Routes

**Backfill / operator** — `GET /api/admin/harvest-guest-feedback`
- `?location=<CODE|all>` (required), `&since=<YYYY-MM-DD>` (backfill floor;
  omit for rolling), `&sources=<tattle,reviews,tasks>` (default all three).
- Auth: `Authorization: Bearer $CRON_SECRET`.

**Nightly cron** — `GET /api/cron/harvest-guest-feedback`
- `vercel.json` cron `30 9 * * *` (after `nightly-ingest` at `09:00` so worked
  time lands first and attribution resolves same-night). No `since` → each
  `(source, location)` resumes from its last successful `window_end` (14-day
  rolling default on first run).

## Backfill the 6 stale Colorado stores (handoff §6)

Worked time is already backfilled (Stage 2), so attribution resolves on the way
in. Run once Houston is verified (it has known-good current data to reconcile):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "$BASE/api/admin/harvest-guest-feedback?location=all&since=2026-04-01&sources=tattle,reviews,tasks"
```

Idempotent — every importer upserts on a natural key and replaces attributions
only for the touched ids, so Houston re-harvesting in the same `all` run is safe.

## Verification (handoff §7, Supabase ref `uyjlnciqecfcxsooupaa`)

```sql
-- Currency should advance to ~today for the 6 CO stores
select l.name,
  (select max(date_experienced) from tattle_surveys where location_id=l.id) tattle,
  (select max(review_date) from customer_reviews where location_id=l.id) reviews,
  (select max(task_date) from tasks where location_id=l.id) tasks
from locations l order by l.name;

-- Per-employee tasks now populated for CO + Houston (was 0 from log-only nightly)
select count(*) from task_accountability ta
join tasks t on t.id=ta.task_id where t.task_date >= '2026-04-01';

-- New sources green
select source,status,count(*) from ingest_runs
where source in ('tattle','reviews','7tasks') group by 1,2;
```

- **Houston reconciles:** spot-check one HOU employee's Q2 — Tattle qty/rating,
  Reviews qty, Tasks % should be unchanged after a Houston re-harvest.
- **No silent skips:** each run's `rows_skipped` (= `skipped_other_location`)
  should be ~0 for the targeted store. A non-zero value means a `csv_aliases`
  miss — fix the alias in a migration (the 035 pattern), not a raw edit.

## Session expiry — recapture

When a vendor session expires, the source raises `SessionExpiredError`, the
`(source × location)` runs log `status='error'` with a message naming the vendor,
and the nightly alert fires (`maybeSendFailureAlert`). The empty-streak guard
(`streak.ts`) also catches a source drifting `empty` for ≥3 nights.

- **`recapture tattle`** → normally unnecessary: the `tattle-nightly` GitHub
  Action (`scripts/tattle-nightly/`, 13:50 UTC) captures a fresh token every
  night and POSTs it to `/api/admin/set-tattle-token`. If the Action itself is
  broken, grab a fresh `ngStorage-token` from dashboard.gettattle.com
  `localStorage` and update `TATTLE_BEARER_TOKEN` in Vercel as the manual
  fallback.
- Source C (7Tasks) uses the durable `IKES_*` API tokens — no session to
  recapture; a 401 there means the API token itself was rotated/revoked.

After updating an env var, re-run the affected window with the admin route, e.g.
`?location=all&since=<the date of the gap>&sources=tasks`.
