import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCrosswalk } from "@/lib/ingest/sevenshifts/crosswalk";
import { resolveIdentities } from "@/lib/ingest/sevenshifts/identities";

/**
 * Narrow per-location 7shifts IDENTITY lever (ruled 2026-08-26, CSU memo
 * §7 standing list — "a narrow per-location identity lever, ruled and
 * specced").
 *
 * THE GAP THIS CLOSES: resolveIdentities (the email bridge that populates
 * employees.seven_shifts_user_id) had no standalone trigger. It ran inside
 * the estate-wide nightly, and inside backfill-worked-time — which guards
 * out every store whose actuals_source is not '7shifts' BEFORE the identity
 * call. Post-flip that is ALL NINE stores, so bridging one store's new
 * hires meant either waiting for 09:00 UTC or running the whole estate's
 * ingest. The CSU import hit exactly this (2026-08-26: 12 new hires,
 * bridge unreachable narrowly).
 *
 * IDENTITY ONLY — no punch pull, no shift pull, no recompute, no
 * time_entries writes. resolveIdentities itself is idempotent: it fills
 * seven_shifts_user_id where NULL by exact normalized-email match against
 * the company's GET /users, and never overwrites an existing id.
 *
 * AUTH: Bearer <CRON_SECRET> (the admin-lever pattern).
 *   GET /api/admin/resolve-identities?location=<location_code>
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const locationParam = (url.searchParams.get("location") ?? "").trim();
  if (!locationParam) {
    return NextResponse.json(
      { error: "Missing ?location=<location_code> (one location per invocation)" },
      { status: 400 }
    );
  }

  try {
    const supabase = createAdminClient();
    const crosswalk = await loadCrosswalk(supabase);
    // Deliberately NO actuals_source guard: identity is a per-company user
    // matter, independent of which system owns the store's worked actuals —
    // the guard on backfill-worked-time is about its TIME pull, and copying
    // it here is what made the bridge unreachable.
    const loc = crosswalk.find(
      (l) => l.location_code.toLowerCase() === locationParam.toLowerCase()
    );
    if (!loc) {
      return NextResponse.json(
        {
          error: `Unknown or un-wired location_code "${locationParam}" (needs both 7shifts ids set)`,
          known: crosswalk.map((l) => l.location_code),
        },
        { status: 404 }
      );
    }

    const identities = await resolveIdentities(supabase, [loc]);
    // resolveIdentities collects per-company/per-employee failures into its
    // errors array instead of throwing — a 200 with silent zero updates
    // would look like success (Codex should-fix). Non-empty errors → 502.
    const failed = (identities.errors?.length ?? 0) > 0;
    if (failed) {
      console.error("[resolve-identities] completed with errors", {
        location_code: loc.location_code,
        errors: identities.errors,
      });
    }
    return NextResponse.json(
      {
        lever: "resolve-identities",
        location_code: loc.location_code,
        ok: !failed,
        identities,
        note: "IDENTITY ONLY — filled seven_shifts_user_id where NULL by exact email match; nothing else written. Attribution/backfills are separate levers.",
      },
      { status: failed ? 502 : 200 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[resolve-identities] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
