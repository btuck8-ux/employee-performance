import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendFatalAlert } from "@/lib/ingest/sevenshifts/alert";
import {
  buildSplitReport,
  maybeSendSplitAlert,
  type SplitScanRow,
} from "@/lib/identity-split-scan";

/**
 * Scan B — weekly identity-split detector (epd_role spec 2026-08-26 §8a).
 *
 * Runs scan_identity_splits(NULL) (mig 073): estate-wide, same-location
 * name-shape pairs (last name OR FIRST name OR 4-char last-name prefix —
 * the first-name arm is what catches Tolan/Tolson, the only true split),
 * classified by punch/schedule asymmetry. Reports ONLY hits; the total
 * pair count rides as drift metadata against the agreed baseline of 19.
 * Emails on hits via the ingest-alert Resend path; the JSON response
 * always carries the full report either way.
 *
 * Schedule: Mondays 12:00 UTC (vercel.json) — clear of the nightly ingest
 * window (~09:00–10:15 UTC) and the GH-Action window (~13:30–14:00 UTC).
 * AUTH: Bearer <CRON_SECRET>.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("scan_identity_splits", {
      p_location_code: null,
    });
    if (error) throw new Error(`scan rpc: ${error.message}`);

    const report = buildSplitReport((data ?? []) as SplitScanRow[]);
    const alert = await maybeSendSplitAlert(report);

    console.log("[identity-split-scan] completed", {
      pair_count: report.pair_count,
      pair_drift: report.pair_drift,
      hit_count: report.hit_count,
      alert,
    });
    return NextResponse.json({ ...report, alert });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[identity-split-scan] fatal:", message);
    await sendFatalAlert("/api/cron/identity-split-scan", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
