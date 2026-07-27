import { NextResponse } from "next/server";
import { getAll, getOne } from "@/lib/ingest/sevenshifts/client";

/**
 * STEP 0 probe for the 7Tasks API migration (handoff 2026-07-27 §2):
 * confirm the PUBLIC 7shifts API's task endpoints expose per-task completion
 * attributed to a user_id — the one fact that decides whether the browser
 * harness can be replaced by a token-authenticated server pull.
 *
 * Read-only diagnostics; runs in prod because the per-company tokens
 * (IKES_CULTUREPULSE_*) live only in Vercel env. Reuses the labor client, so
 * host/version/auth/paging are exactly what the real feed would use. Kept
 * after the probe as a diagnostic for the parity phase.
 *
 * AUTH: Bearer <CRON_SECRET>.
 *   GET /api/admin/probe-7shifts-tasks?company=62064&location=74873&date=2026-07-25
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Probe = { ok: boolean; data?: unknown; error?: string };

async function attempt(fn: () => Promise<unknown>): Promise<Probe> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Trim huge arrays so the response stays readable; keep full object shapes. */
function sample(v: unknown, max = 2): unknown {
  if (Array.isArray(v)) return { count: v.length, items: v.slice(0, max) };
  return v;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const company = Number(url.searchParams.get("company") ?? "62064");
  const location = Number(url.searchParams.get("location") ?? "74873");
  const date = url.searchParams.get("date") ?? "2026-07-25";

  const lists = await attempt(() =>
    getAll<Record<string, unknown>>(company, "task_lists", {
      active_on_date: date,
      location_id: location,
    })
  );

  let detail: Probe = { ok: false, error: "skipped (no task_lists result)" };
  const firstId =
    lists.ok && Array.isArray(lists.data) && lists.data.length > 0
      ? (lists.data[0] as { id?: unknown }).id
      : null;
  if (firstId != null) {
    detail = await attempt(() => getOne(company, `task_lists/${firstId}`, {}));
  }

  const summary = await attempt(() =>
    getOne(company, "task_list_daily_summary", { location_id: location, date })
  );

  return NextResponse.json({
    probe: { company, location, date },
    task_lists: { ok: lists.ok, error: lists.ok ? undefined : lists.error, data: sample(lists.data) },
    task_list_detail: { id: firstId, ...detail },
    task_list_daily_summary: summary,
  });
}
