/**
 * 7shifts user-detail enrichment for the triage card (kickoff §5-A).
 *
 * The Step-0 probe (PR #16 body, 2026-08-16) pinned the full detail-endpoint
 * key list for both companies: it carries `hourly_wage` and `wage_type` (and
 * NO hire-date field — settled, do not re-research). Wage-shaped fields exist
 * → per the §5-A default they surface on the card and are written at mint.
 *
 * UNITS: `hourly_wage` is treated as CENTS, matching the repo's only other
 * 7shifts hourly_wage consumer (time.ts:37 pins the punches payload as
 * "cents (calculated)" and divides by 100). The derived dollar value renders
 * on the review card BEFORE the mint, so a wrong-unit surprise is visible to
 * the admin, not silent.
 *
 * 7shifts tokens are Sensitive Vercel vars — these calls only work in the
 * deployed app. Failures (missing env locally, the probe's known detail-404s)
 * are captured per-detection, never thrown: the card renders without
 * enrichment and says so.
 */

import { getOne } from "../ingest/sevenshifts/client.ts";
import { loadCrosswalk } from "../ingest/sevenshifts/crosswalk.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PendingDetection } from "./detections.ts";

export interface DetectionEnrichment {
  /** Dollars (hourly_wage cents / 100); null = absent, zero, or unfetchable. */
  wage: number | null;
  /** EPD wage_pay_type casing ("Hourly"); null when wage is null. */
  wagePayType: string | null;
  /** Why enrichment is missing, for the card's small print. */
  error: string | null;
}

/** Same rate-limit courtesy spacing as the probe's detail loop. */
const DETAIL_DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pull the wage-shaped fields out of a 7shifts user detail payload.
 * hourly_wage <= 0 reads as not-set (the time.ts convention); wage_pay_type
 * is only carried alongside a real wage — a bare "Hourly" with no amount is
 * meaningless on the roster.
 */
export function extractWageFields(detail: Record<string, unknown>): {
  wage: number | null;
  wagePayType: string | null;
} {
  const rawWage = detail["hourly_wage"];
  const cents =
    typeof rawWage === "number" && Number.isFinite(rawWage) ? rawWage : null;
  const wage = cents !== null && cents > 0 ? Math.round(cents) / 100 : null;
  if (wage === null) return { wage: null, wagePayType: null };

  const rawType = detail["wage_type"];
  const t = typeof rawType === "string" ? rawType.trim() : "";
  // EPD's existing values are capitalized ("Hourly") — match that casing.
  const wagePayType = t ? t.charAt(0).toUpperCase() + t.slice(1) : null;
  return { wage, wagePayType };
}

/**
 * Enrich each mintable detection from GET /users/{id}. Company routing rides
 * the migration-030 locations crosswalk (EPD location → 7shifts company).
 * Returns a map keyed by the detection's CP row id.
 */
export async function enrichDetections(
  epd: SupabaseClient,
  detections: PendingDetection[]
): Promise<Map<string, DetectionEnrichment>> {
  const out = new Map<string, DetectionEnrichment>();
  const candidates = detections.filter(
    (d) => d.location !== null && d.sevenShiftsUserId !== null && d.sevenShiftsUserId > 0
  );
  if (candidates.length === 0) return out;

  let companyByLocationId = new Map<string, number>();
  try {
    const crosswalk = await loadCrosswalk(epd);
    companyByLocationId = new Map(crosswalk.map((l) => [l.id, l.company_id]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const d of candidates) {
      out.set(d.cpId, { wage: null, wagePayType: null, error: message });
    }
    return out;
  }

  let first = true;
  for (const d of candidates) {
    const companyId = companyByLocationId.get(d.location!.id);
    if (companyId === undefined) {
      out.set(d.cpId, {
        wage: null,
        wagePayType: null,
        error: "location has no 7shifts company wiring",
      });
      continue;
    }
    if (!first) await sleep(DETAIL_DELAY_MS);
    first = false;
    try {
      const detail = await getOne<Record<string, unknown>>(
        companyId,
        `users/${d.sevenShiftsUserId}`
      );
      out.set(d.cpId, { ...extractWageFields(detail), error: null });
    } catch (err) {
      // Missing token env (local dev) or a detail-endpoint 404 (seen in the
      // probe) — the card renders without wage, with this note.
      out.set(d.cpId, {
        wage: null,
        wagePayType: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
