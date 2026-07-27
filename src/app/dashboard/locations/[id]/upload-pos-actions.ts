"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  parseSalesCsv,
  type ParsedSalesRecord,
  type PosImportResult,
} from "@/lib/pos-import";
import { recomputeAfterSalesUpsert } from "@/lib/ingest/sevenshifts/recompute";
import { rowMatchesLocation } from "@/lib/location-match";
import { readCsvFromStorage, deleteCsvFromStorage } from "@/lib/storage-csv";

// NOTE on timeouts: in a "use server" file only async functions can be
// exported, so `maxDuration` must live on the calling pages, not here. All
// three callers — locations/[id]/page.tsx, clients/[id]/page.tsx, and
// uploads/page.tsx — already export `maxDuration = 300`, which gives this
// action the headroom it needs even for the largest store (Downtown Denver,
// ~49K rows × 4 quarters × ~25 employees).

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

const UPSERT_BATCH_SIZE = 500;
const FETCH_PAGE = 1000; // PostgREST max-rows is 1000 by default

interface IngestStats {
  sales_inserted: number;
  sales_updated: number;
  split_tender_receipts: number;
  refund_rows: number;
  affected_quarters: number;
  recomputed: number;
  teams_recomputed: number;
  skipped_other_location: number;
  warnings: string[];
  failures: string[];
}

function newStats(warnings: string[] = []): IngestStats {
  return {
    sales_inserted: 0,
    sales_updated: 0,
    split_tender_receipts: 0,
    refund_rows: 0,
    affected_quarters: 0,
    recomputed: 0,
    teams_recomputed: 0,
    skipped_other_location: 0,
    warnings,
    failures: [],
  };
}

async function chunkOp<T>(
  fn: (batch: T[]) => Promise<{ error: { message: string } | null }>,
  rows: T[],
  label: string,
  stats: IngestStats
) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await fn(batch);
    if (error) {
      const msg = `${label} batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}: ${error.message}`;
      console.error("[pos-import]", msg);
      stats.failures.push(msg);
    }
  }
}

/**
 * End-to-end POS sales ingest for ONE location. Filters parsed.records by
 * location (if a Location column was present), upserts sales_records on the
 * (location_id, receipt_number, transaction_at) natural key, then recomputes
 * performance_records for every active employee at the location in every
 * quarter touched by the import.
 *
 * Why recompute everyone-at-location and not just employees whose presence
 * overlaps the new sales: adding sales shifts the LOCATION baseline
 * (location_tip_rate_pct, location_tip_per_hour), which in turn changes
 * every employee's tip_rate_delta_pp. So a sale rung during nobody's shift
 * still needs every employee's quarter row refreshed.
 *
 * Pure compute, no redirect/revalidate. Same return-stats shape as the
 * tasks/surveys/reviews helpers.
 */
async function ingestPOSForLocation(
  supabase: SupabaseServer,
  parsed: PosImportResult,
  location: { id: string; name: string; csv_aliases: string[] | null }
): Promise<IngestStats> {
  const stats = newStats();

  // Filter parsed.records to those tagged for THIS location (or untagged).
  // Current Ike's POS exports are single-location with no Location column,
  // so all rows pass; the filter exists so the same helper works when a
  // multi-location master CSV ever appears.
  const beforeFilter = parsed.records.length;
  const records = parsed.records.filter((r) =>
    rowMatchesLocation(r.location_label, location.name, location.csv_aliases)
  );
  stats.skipped_other_location = beforeFilter - records.length;
  if (records.length === 0) {
    return stats;
  }

  // Determine the time range of this import — used to bound the existing-row
  // lookup so it doesn't scan the entire (potentially huge) sales table.
  let minAt = records[0].transaction_at;
  let maxAt = records[0].transaction_at;
  for (const r of records) {
    if (r.transaction_at < minAt) minAt = r.transaction_at;
    if (r.transaction_at > maxAt) maxAt = r.transaction_at;
  }

  // Look up which (receipt, transaction_at) pairs already exist at this
  // location within the import window, so we can split insert vs update
  // counts. Paginate to dodge the 1000-row truncation.
  const existingKey = new Set<string>();
  {
    let from = 0;
    while (true) {
      const { data: page } = await supabase
        .from("sales_records")
        .select("receipt_number, transaction_at")
        .eq("location_id", location.id)
        .gte("transaction_at", minAt)
        .lte("transaction_at", maxAt)
        .range(from, from + FETCH_PAGE - 1);
      if (!page || page.length === 0) break;
      for (const r of page) {
        existingKey.add(
          `${r.receipt_number as string}|${r.transaction_at as string}`
        );
      }
      if (page.length < FETCH_PAGE) break;
      from += FETCH_PAGE;
    }
  }

  // Build upsert payloads + tally stats in one pass.
  const payloads = records.map((r: ParsedSalesRecord) => {
    const k = `${r.receipt_number}|${r.transaction_at}`;
    if (existingKey.has(k)) stats.sales_updated += 1;
    else stats.sales_inserted += 1;
    if (r.raw_row.payment_legs.length > 1) stats.split_tender_receipts += 1;
    if (
      r.transaction_type.toLowerCase().startsWith("refund") ||
      r.total_amount < 0
    ) {
      stats.refund_rows += 1;
    }
    return {
      location_id: location.id,
      receipt_number: r.receipt_number,
      transaction_at: r.transaction_at,
      transaction_type: r.transaction_type,
      order_type: r.order_type,
      channel: r.channel,
      payment_type: r.payment_type,
      register: r.register,
      pos_employee_name: r.pos_employee_name,
      total_amount: r.total_amount,
      tip_amount: r.tip_amount,
      raw_row: r.raw_row,
    };
  });

  await chunkOp(
    async (batch: typeof payloads) =>
      await supabase
        .from("sales_records")
        .upsert(batch, {
          onConflict: "location_id,receipt_number,transaction_at",
        }),
    payloads,
    "sales_records",
    stats
  );

  // Shared post-sales recompute tail (ingest/sevenshifts/recompute.ts): every
  // active employee × touched quarter, then the team tip-impact slice per
  // quarter. The same tail the 7shifts pos_receipts and Toast sales feeds run,
  // so all three sales writers stay recompute-identical.
  const rc = await recomputeAfterSalesUpsert(
    supabase,
    location.id,
    records.map((r) => r.transaction_at)
  );
  stats.affected_quarters = rc.quarters.length;
  stats.recomputed = rc.recomputed;
  stats.teams_recomputed = rc.teams_recomputed;
  stats.failures.push(...rc.failures);

  await supabase
    .from("locations")
    .update({ last_data_uploaded_at: new Date().toISOString() })
    .eq("id", location.id);

  return stats;
}

export async function uploadPOSCsvAction(formData: FormData) {
  console.log("[pos-import] uploadPOSCsvAction invoked");

  const location_id = String(formData.get("location_id") ?? "");
  const storagePath = String(formData.get("file_path") ?? "");

  if (!location_id) {
    redirect(
      `/dashboard/locations?pos_error=${encodeURIComponent("Missing location.")}`
    );
  }
  if (!storagePath) {
    redirect(
      `/dashboard/locations/${location_id}?pos_error=${encodeURIComponent(
        "No file uploaded."
      )}`
    );
  }

  const supabase = await createClient();

  let text: string;
  try {
    text = await readCsvFromStorage(supabase, storagePath);
  } catch (err) {
    await deleteCsvFromStorage(supabase, storagePath);
    redirect(
      `/dashboard/locations/${location_id}?pos_error=${encodeURIComponent(
        err instanceof Error ? err.message : "Failed to read uploaded file."
      )}`
    );
  }

  try {
    const parsed = parseSalesCsv(text);
    console.log(
      `[pos-import] parsed ${parsed.rows_in_file} rows -> ${parsed.unique_receipts} receipts ` +
        `(${parsed.split_tender_receipts} split-tender)`
    );
    if (parsed.errors.length > 0 && parsed.records.length === 0) {
      redirect(
        `/dashboard/locations/${location_id}?pos_error=${encodeURIComponent(
          parsed.errors.join("; ")
        )}`
      );
    }

    const { data: locRow } = await supabase
      .from("locations")
      .select("id, name, csv_aliases")
      .eq("id", location_id)
      .single();
    const location =
      (locRow as { id: string; name: string; csv_aliases: string[] | null } | null) ?? {
        id: location_id,
        name: "",
        csv_aliases: null,
      };

    const stats = await ingestPOSForLocation(supabase, parsed, location);
    for (const w of parsed.warnings.slice(0, 10)) stats.warnings.push(w);

    console.log(
      `[pos-import] ${location.name}: sales ${stats.sales_inserted}+${stats.sales_updated}u, ` +
        `split=${stats.split_tender_receipts}, refunds=${stats.refund_rows}, ` +
        `quarters=${stats.affected_quarters}, recomputed=${stats.recomputed}, ` +
        `teams=${stats.teams_recomputed}, skipped_other=${stats.skipped_other_location}`
    );

    revalidatePath(`/dashboard/locations/${location_id}`);
    revalidatePath(`/dashboard/locations/${location_id}/teams`);
    revalidatePath("/dashboard/employees");

    const params = new URLSearchParams();
    params.set("pos_in", String(stats.sales_inserted));
    params.set("pos_up", String(stats.sales_updated));
    params.set("pos_split", String(stats.split_tender_receipts));
    params.set("pos_refunds", String(stats.refund_rows));
    params.set("pos_quarters", String(stats.affected_quarters));
    params.set("pos_recomputed", String(stats.recomputed));
    params.set("pos_teams", String(stats.teams_recomputed));
    if (stats.skipped_other_location > 0)
      params.set("pos_skipped_other_location", String(stats.skipped_other_location));
    if (stats.warnings.length > 0)
      params.set("pos_warnings", stats.warnings.slice(0, 3).join(" | "));
    if (stats.failures.length > 0)
      params.set("pos_failures", stats.failures.slice(0, 3).join(" | "));

    redirect(`/dashboard/locations/${location_id}?${params.toString()}`);
  } finally {
    // Always reclaim the storage object — fires after the success redirect
    // throws, and after any error redirect from inside this try.
    await deleteCsvFromStorage(supabase, storagePath);
  }
}

/**
 * Bulk: fan out a POS CSV across many locations (scope=client | scope=all).
 * Routes each record by its Location column to the matching location (if the
 * CSV has one), then runs the per-location ingest. Aggregates counts +
 * per-location breakdown. Single-location CSVs (no Location column) hit
 * every target location's filter equally — the caller should use the
 * per-location action for those, not bulk.
 */
export async function uploadPOSCsvBulkAction(formData: FormData) {
  console.log("[pos-import] uploadPOSCsvBulkAction invoked");

  const scope = String(formData.get("scope") ?? "all") as "client" | "all";
  const client_id =
    scope === "client" ? String(formData.get("client_id") ?? "") : null;
  const storagePath = String(formData.get("file_path") ?? "");

  const redirectBase =
    scope === "client" && client_id
      ? `/dashboard/clients/${client_id}`
      : `/dashboard/uploads`;

  if (!storagePath) {
    redirect(
      `${redirectBase}?bulk_pos_error=${encodeURIComponent("No file uploaded.")}`
    );
  }

  const supabase = await createClient();

  let text: string;
  try {
    text = await readCsvFromStorage(supabase, storagePath);
  } catch (err) {
    await deleteCsvFromStorage(supabase, storagePath);
    redirect(
      `${redirectBase}?bulk_pos_error=${encodeURIComponent(
        err instanceof Error ? err.message : "Failed to read uploaded file."
      )}`
    );
  }

  try {
    const parsed = parseSalesCsv(text);

    if (parsed.errors.length > 0 && parsed.records.length === 0) {
      redirect(
        `${redirectBase}?bulk_pos_error=${encodeURIComponent(
          parsed.errors.join("; ")
        )}`
      );
    }

    // Safety guard: bulk requires a Location column so each row routes to the
    // correct store. Without it, every location's filter accepts every row and
    // the CSV gets ingested N times. Ike's current per-store exports have no
    // Location column — those must go through the per-location action.
    const rowsWithLocation = parsed.records.filter(
      (r) => r.location_label !== null
    ).length;
    if (rowsWithLocation === 0) {
      redirect(
        `${redirectBase}?bulk_pos_error=${encodeURIComponent(
          "This CSV has no Location/Store/Site column — bulk upload requires one to route rows to the right store. Use the per-location upload instead (one file per store)."
        )}`
      );
    }

    let q = supabase
      .from("locations")
      .select("id, name, csv_aliases")
      .order("name");
    if (scope === "client" && client_id) q = q.eq("client_id", client_id);
    const { data: targetsRaw } = await q;
    const targets = (targetsRaw ?? []) as Array<{
      id: string;
      name: string;
      csv_aliases: string[] | null;
    }>;
    if (targets.length === 0) {
      redirect(
        `${redirectBase}?bulk_pos_error=${encodeURIComponent(
          scope === "client"
            ? "No locations under this client."
            : "No locations exist yet."
        )}`
      );
    }

    const aggregated: IngestStats = newStats();
    const perLocation: Array<{
      name: string;
      in: number;
      up: number;
      split: number;
      refunds: number;
      recomputed: number;
    }> = [];

    for (const loc of targets) {
      const stats = await ingestPOSForLocation(supabase, parsed, loc);
      aggregated.sales_inserted += stats.sales_inserted;
      aggregated.sales_updated += stats.sales_updated;
      aggregated.split_tender_receipts += stats.split_tender_receipts;
      aggregated.refund_rows += stats.refund_rows;
      aggregated.affected_quarters = Math.max(
        aggregated.affected_quarters,
        stats.affected_quarters
      );
      aggregated.recomputed += stats.recomputed;
      aggregated.teams_recomputed += stats.teams_recomputed;
      aggregated.skipped_other_location += stats.skipped_other_location;
      aggregated.failures.push(...stats.failures);
      perLocation.push({
        name: loc.name,
        in: stats.sales_inserted,
        up: stats.sales_updated,
        split: stats.split_tender_receipts,
        refunds: stats.refund_rows,
        recomputed: stats.recomputed,
      });
    }

    // Truly unmatched: rows whose location_label matches no target name AND no alias.
    const targetNames = new Set<string>();
    for (const l of targets) {
      targetNames.add(l.name.toLowerCase());
      if (l.csv_aliases) {
        for (const a of l.csv_aliases) {
          if (a) targetNames.add(a.trim().toLowerCase());
        }
      }
    }
    let trulyUnmatched = 0;
    for (const r of parsed.records) {
      const lbl = (r.location_label ?? "").trim().toLowerCase();
      if (lbl && !targetNames.has(lbl)) trulyUnmatched += 1;
    }

    for (const loc of targets) revalidatePath(`/dashboard/locations/${loc.id}`);
    revalidatePath("/dashboard/employees");
    if (scope === "client" && client_id)
      revalidatePath(`/dashboard/clients/${client_id}`);
    revalidatePath("/dashboard/uploads");

    console.log(
      `[pos-import] BULK DONE across ${targets.length} locations: ` +
        `sales=${aggregated.sales_inserted}+${aggregated.sales_updated}u, ` +
        `split=${aggregated.split_tender_receipts}, refunds=${aggregated.refund_rows}, ` +
        `recomputed=${aggregated.recomputed}, teams=${aggregated.teams_recomputed}, ` +
        `unmatched=${trulyUnmatched}, failures=${aggregated.failures.length}`
    );

    const params = new URLSearchParams();
    params.set("bulk_pos_locations", String(targets.length));
    params.set("bulk_pos_in", String(aggregated.sales_inserted));
    params.set("bulk_pos_up", String(aggregated.sales_updated));
    params.set("bulk_pos_split", String(aggregated.split_tender_receipts));
    params.set("bulk_pos_refunds", String(aggregated.refund_rows));
    params.set("bulk_pos_recomputed", String(aggregated.recomputed));
    params.set("bulk_pos_teams", String(aggregated.teams_recomputed));
    params.set("bulk_pos_unmatched", String(trulyUnmatched));
    const breakdown = perLocation
      .filter((p) => p.in + p.up > 0)
      .map(
        (p) =>
          `${p.name}: sales ${p.in}+${p.up}u · split ${p.split} · refunds ${p.refunds} · recomputed ${p.recomputed}`
      )
      .join(" | ");
    if (breakdown) params.set("bulk_pos_breakdown", breakdown);
    if (aggregated.failures.length > 0)
      params.set(
        "bulk_pos_failures",
        aggregated.failures.slice(0, 3).join(" | ")
      );

    redirect(`${redirectBase}?${params.toString()}`);
  } finally {
    await deleteCsvFromStorage(supabase, storagePath);
  }
}
