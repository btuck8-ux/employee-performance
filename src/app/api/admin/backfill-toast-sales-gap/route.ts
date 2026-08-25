import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPagedList } from "@/lib/ingest/toast/client";
import { normalizeOrders, type ToastOrder } from "@/lib/ingest/toast/normalize";
import { timezoneForLocationCode } from "@/lib/ingest/sevenshifts/tz";
import { recomputeAfterSalesUpsert } from "@/lib/ingest/sevenshifts/recompute";

/**
 * Toast → sales_records gap-filler (addendum §2; addendum 2's §2
 * "correction" RETRACTED 2026-08-25 — the original diagnosis stands,
 * settled by raw_row payloads, not receipt-number shape). Houston's 26-day
 * sales hole (2026-05-05 → 05-30) sits in its 7shifts pos_receipts mirror:
 * HOU raw_row carries external_user_id / gross_total_cents / tips_cents
 * (a 7shifts receipt), while CPD's carries order_guid /
 * check_display_number (a Toast order). Houston has NEVER been on the
 * Toast sales path; its UUID-shaped receipt_numbers are 7shifts
 * receipt_ids. The coherent story: the POS moved to Toast 2026-04-30, the
 * 7shifts↔Toast sales integration broke at the cutover and was reconnected
 * 05-31 — time punches never were, which is the defect this sprint exists
 * to fix, with Houston its earliest instance. METHOD RULE (the sprint's
 * fourth bad-signal conclusion — shape is not identity): a claim about
 * which system wrote a row must cite the payload, never the key's format.
 *
 * ⚠️ THE DOUBLE-COUNT RISK IS REAL — the id spaces genuinely differ
 * (7shifts receipt_id vs Toast check.guid; the upsert key is
 * (location_id, receipt_number, transaction_at), so an overlapping day
 * INSERTS duplicates instead of colliding). This lever's collision report
 * is load-bearing, not belt-and-braces. What makes THIS job safe is that
 * the gap window is fully disjoint from every existing Houston row: last
 * pre-gap row 2026-05-04, first post-gap row 2026-05-31, zero rows
 * between. EXPECTED dry-run for 05-05 → 05-30: zero receipt-number
 * overlap, zero exact-key collisions, zero existing rows per day. ANYTHING
 * ELSE means the gap is not what we believe it is — stop and take it to
 * Tucker.
 *
 * ⚠️ WHY THIS IS A LEVER AND NOT A FEED. sales_records has one ongoing
 * writer per store, and mig 041's rule (never set toast_sales_enabled for
 * HOU) stands — two writers on one table with different keys is how
 * time_entries got into its current state. A Toast fill leaves Houston
 * with two id-spaces in one table, cleanly date-separated: tolerable for a
 * one-off backfill, NOT a reason to run two nightly writers. Tucker rules
 * on the write and on Houston's ongoing sales source from the dry-run
 * output.
 *
 * ⚠️ DRY-RUN FIRST, ALWAYS. The default dry-run fetches + normalizes, then
 * reports per-day: Toast rows/sums, existing rows/sums, receipt_number
 * overlap, and exact-key collisions — writing nothing. Rows on both sides
 * with ZERO key overlap is the double-count signature. &write=1 (only
 * after SA review of the dry-run) performs the same fetch + the orders.ts
 * upsert/recompute tail over exactly the same days, and requires
 * &confirm_quarters naming every quarter the recompute touches.
 *
 * No ingest_runs row is written in either mode: this lever must never move
 * a nightly feed's high-water mark (lastSuccessfulWindowEnd keys on the
 * toast_sales source).
 *
 * AUTH: Bearer <CRON_SECRET>.
 *   GET /api/admin/backfill-toast-sales-gap
 *     ?location_code=HOU        required
 *     &from=2026-04-30&to=2026-05-30   required local business dates,
 *                               floored at the store's toast_sales_start_date
 *     &write=1                  optional; default is the dry-run report
 *     &confirm_quarters=Q2-2026 write mode: must name every affected quarter
 *     &override_double_count_days=YYYY-MM-DD,…  write mode, only when the
 *                               dry-run flagged days: must echo the exact
 *                               flagged set (spec §4 — explicit and in
 *                               writing, never a loosened check)
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 62; // matches MAX_BUSINESS_DATES_PER_RUN — one bounded window

function addDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

interface DayReport {
  date: string;
  toast_rows: number;
  toast_total: number;
  toast_tips: number;
  existing_rows: number;
  existing_total: number;
  existing_tips: number;
  /** Toast receipt_numbers already present that day (any transaction_at). */
  receipt_number_overlap: number;
  /** Exact (receipt_number, transaction_at) matches — true upsert updates. */
  exact_key_collisions: number;
  would_insert: number;
  /** Rows on both sides but no shared receipt_numbers — the double-count
   * signature. Do not write while any day carries this flag un-reviewed. */
  double_count_risk: boolean;
}

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const locationCode = url.searchParams.get("location_code");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const write = url.searchParams.get("write") === "1";

  if (!locationCode || !from || !to || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    return NextResponse.json(
      { error: "location_code, from and to (YYYY-MM-DD, from <= to) are required" },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();
  const { data: loc, error: locError } = await supabase
    .from("locations")
    .select("id, location_code, toast_restaurant_guid, toast_sales_start_date")
    .eq("location_code", locationCode)
    .maybeSingle();
  if (locError) {
    return NextResponse.json({ error: locError.message }, { status: 500 });
  }
  if (!loc?.toast_restaurant_guid) {
    return NextResponse.json(
      { error: `${locationCode} has no toast_restaurant_guid — not a Toast store` },
      { status: 400 }
    );
  }
  const goLive = (loc.toast_sales_start_date as string | null) ?? null;
  if (!goLive) {
    // §1 discipline: a missing go-live is a data error, never a guess.
    return NextResponse.json(
      { error: `${locationCode} has no toast_sales_start_date — set the store's go-live first` },
      { status: 400 }
    );
  }

  // Explicit local business dates, floored at go-live (§1: the store's own
  // go-live is the only floor), bounded to one window.
  const dates: string[] = [];
  for (let d = from < goLive ? goLive : from; d <= to; d = addDays(d, 1)) {
    dates.push(d);
    if (dates.length > MAX_DAYS) {
      return NextResponse.json(
        { error: `window exceeds ${MAX_DAYS} days — split the backfill` },
        { status: 400 }
      );
    }
  }
  if (dates.length === 0) {
    return NextResponse.json(
      { error: `window is entirely before ${locationCode}'s go-live (${goLive})` },
      { status: 400 }
    );
  }

  try {
    const tz = timezoneForLocationCode(loc.location_code as string);
    const orders: ToastOrder[] = [];
    for (const isoDate of dates) {
      const batch = await getPagedList<ToastOrder>(
        loc.toast_restaurant_guid as string,
        "/orders/v2/ordersBulk",
        { businessDate: isoDate.replaceAll("-", "") }
      );
      orders.push(...batch);
    }
    const normalized = normalizeOrders(orders, loc.id as string, tz);

    // Existing rows over the same local-date window (transaction_at is the
    // store-local naive clock, so date-string bounds work directly). Paged
    // past the PostgREST cap — a month of a busy store exceeds 1000 rows.
    type ExistingRow = {
      receipt_number: string;
      transaction_at: string;
      total_amount: number | string;
      tip_amount: number | string;
    };
    const existing: ExistingRow[] = [];
    const BATCH = 1000;
    for (let fromRow = 0; ; fromRow += BATCH) {
      const { data, error } = await supabase
        .from("sales_records")
        .select("receipt_number, transaction_at, total_amount, tip_amount")
        .eq("location_id", loc.id)
        .gte("transaction_at", `${dates[0]}T00:00:00`)
        .lt("transaction_at", `${addDays(dates[dates.length - 1], 1)}T00:00:00`)
        .order("id", { ascending: true })
        .range(fromRow, fromRow + BATCH - 1);
      if (error) throw new Error(`existing rows read: ${error.message}`);
      existing.push(...((data ?? []) as ExistingRow[]));
      if (!data || data.length < BATCH) break;
    }

    const num = (v: number | string) => (typeof v === "string" ? Number(v) : v);
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const existingByDay = new Map<string, ExistingRow[]>();
    for (const r of existing) {
      const day = String(r.transaction_at).slice(0, 10);
      const list = existingByDay.get(day) ?? [];
      list.push(r);
      existingByDay.set(day, list);
    }
    const toastByDay = new Map<string, typeof normalized.payloads>();
    for (const p of normalized.payloads) {
      const day = p.transaction_at.slice(0, 10);
      const list = toastByDay.get(day) ?? [];
      list.push(p);
      toastByDay.set(day, list);
    }

    const days: DayReport[] = dates.map((date) => {
      const toastRows = toastByDay.get(date) ?? [];
      const existingRows = existingByDay.get(date) ?? [];
      const existingReceipts = new Set(existingRows.map((r) => r.receipt_number));
      const existingKeys = new Set(
        existingRows.map((r) => `${r.receipt_number}|${String(r.transaction_at).slice(0, 19)}`)
      );
      const overlap = toastRows.filter((p) => existingReceipts.has(p.receipt_number)).length;
      const collisions = toastRows.filter((p) =>
        existingKeys.has(`${p.receipt_number}|${p.transaction_at.slice(0, 19)}`)
      ).length;
      return {
        date,
        toast_rows: toastRows.length,
        toast_total: round2(toastRows.reduce((a, p) => a + p.total_amount, 0)),
        toast_tips: round2(toastRows.reduce((a, p) => a + p.tip_amount, 0)),
        existing_rows: existingRows.length,
        existing_total: round2(existingRows.reduce((a, r) => a + num(r.total_amount), 0)),
        existing_tips: round2(existingRows.reduce((a, r) => a + num(r.tip_amount), 0)),
        receipt_number_overlap: overlap,
        exact_key_collisions: collisions,
        would_insert: toastRows.length - collisions,
        double_count_risk:
          toastRows.length > 0 && existingRows.length > 0 && overlap === 0,
      };
    });

    // Every quarter the write would recompute, named. Write mode requires
    // the operator to echo this exact set back (&confirm_quarters=…) — a
    // recompute reaching a THQ frozen quarter must be a conscious, named
    // act, never a side effect of a wide window (Codex 2026-08-25).
    const quartersAffected = [
      ...new Set(
        dates.map((d) => {
          const [y, m] = d.split("-").map(Number);
          return `Q${Math.floor((m - 1) / 3) + 1}-${y}`;
        })
      ),
    ].sort();

    const summary = {
      location_code: loc.location_code,
      mode: write ? "write" : "dry_run",
      // §1 discipline: the resolved window rides every response.
      window: { since: dates[0], until: dates[dates.length - 1], requests: dates.length },
      quarters_affected: quartersAffected,
      orders_fetched: orders.length,
      checks_normalized: normalized.payloads.length,
      skipped_test_mode: normalized.skipped_test_mode,
      skipped_voided: normalized.skipped_voided,
      skipped_no_date: normalized.skipped_no_date,
      days_with_double_count_risk: days.filter((d) => d.double_count_risk).map((d) => d.date),
      days,
    };

    if (!write) {
      return NextResponse.json(summary);
    }

    const confirmed = (url.searchParams.get("confirm_quarters") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    if (confirmed.join(",") !== quartersAffected.join(",")) {
      return NextResponse.json(
        {
          error: `write mode requires confirm_quarters naming every quarter this recompute touches: expected "${quartersAffected.join(",")}"`,
          quarters_affected: quartersAffected,
        },
        { status: 400 }
      );
    }

    // Houston-to-Toast spec 2026-08-25 §4: a flagged day can be a correct
    // trigger AND a false positive (the 04-30 → 05-04 overlap is
    // complementary — legacy delivery + Toast in-store sum to Houston's
    // real day). The override is EXPLICIT AND IN WRITING — the operator
    // echoes the exact flagged-day set — never a loosening of the check.
    const flaggedDays = summary.days_with_double_count_risk;
    if (flaggedDays.length > 0) {
      const acknowledged = (url.searchParams.get("override_double_count_days") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .sort();
      if (acknowledged.join(",") !== [...flaggedDays].sort().join(",")) {
        return NextResponse.json(
          {
            error: `write mode with flagged days requires override_double_count_days naming every flagged day: expected "${[...flaggedDays].sort().join(",")}"`,
            days_with_double_count_risk: flaggedDays,
          },
          { status: 400 }
        );
      }
    }

    // Write path — the orders.ts upsert + recompute tail, verbatim, over
    // exactly the days the dry-run reported. Idempotent on
    // (location_id, receipt_number, transaction_at).
    let upserted = 0;
    const UPSERT_BATCH = 500;
    for (let i = 0; i < normalized.payloads.length; i += UPSERT_BATCH) {
      const batch = normalized.payloads.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase.from("sales_records").upsert(batch, {
        onConflict: "location_id,receipt_number,transaction_at",
      });
      if (error) throw new Error(`sales_records upsert: ${error.message}`);
      upserted += batch.length;
    }
    const rc = await recomputeAfterSalesUpsert(
      supabase,
      loc.id as string,
      normalized.payloads.map((p) => p.transaction_at)
    );
    if (normalized.payloads.length > 0) {
      await supabase
        .from("locations")
        .update({ last_data_uploaded_at: new Date().toISOString() })
        .eq("id", loc.id);
    }

    return NextResponse.json({
      ...summary,
      rows_upserted: upserted,
      quarters_recomputed: rc.quarters.length,
      records_recomputed: rc.recomputed,
      recompute_failures: rc.failures.slice(0, 20),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[backfill-toast-sales-gap] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
