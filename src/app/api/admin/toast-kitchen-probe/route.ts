import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { toastGet, toastGetWithStatus } from "@/lib/ingest/toast/client";

/**
 * STEP 0 probe for the Toast Kitchen ticket-time feed (handoff 2026-07-28 §4).
 *
 * KEPT DELIBERATELY through the kitchen feed's burn-in (feed shipped early
 * Aug 2026, migrations 041–044). Delete in the ~Sept 2026 cleanup once
 * ingest-toast-kitchen shows ~a month of clean nightly runs. (AGENTS.md)
 *
 * Two jobs, both read-only, no writes, no migration:
 *
 *  1. DEFAULT — hit the Kitchen export for one store + businessDate and report
 *     a JSON diagnostic. The #1 question is the RMS Pro+ gate: the spec
 *     documents `204 No Content` = "No subscription to Toast Restaurant
 *     Management Suite Pro+". A granted `kitchen:read` scope is NOT that
 *     subscription — this probe is the only proof either way. It also answers
 *     the true row grain, ticketFiredAt reliability, and daily volume.
 *
 *  2. `?mode=restaurants` — enumerate the credential's restaurants
 *     (restaurants:read) so Houston's GUID can be captured and Chico /
 *     CocoShack-Kona explicitly excluded. HOU's GUID is deliberately NULL in
 *     `locations` (the sales double-source guard, handoff §2.3), so kitchen
 *     probes against HOU pass `?guid=` directly.
 *
 * Never echoes the credential; the sample row truncates every GUID to 8 chars.
 *
 * AUTH: Bearer <CRON_SECRET>.
 *   GET /api/admin/toast-kitchen-probe?location=COS&businessDate=20260727
 *   GET /api/admin/toast-kitchen-probe?guid=<uuid>&businessDate=20260727
 *   GET /api/admin/toast-kitchen-probe?mode=restaurants
 */

export const dynamic = "force-dynamic";
// First COS run outlived 60s without a byte back from the Kitchen export; the
// wider ceiling plus the in-route race below distinguishes "slow" from "hung".
export const maxDuration = 300;

/** Give the Kitchen call this long, then report the hang as data. */
const KITCHEN_FETCH_TIMEOUT_MS = 240_000;

const KITCHEN_PATH = "/kitchen/v1/export/itemFulfillments";

/** Every field documented for ItemFulfillment (handoff §2.1). */
const KNOWN_FIELDS = new Set([
  "restaurantGuid",
  "orderGuid",
  "ticketGuid",
  "selectionGuid",
  "selectionMenuItemGuid",
  "selectionMenuItemName",
  "selectionMenuItemMultiLocationId",
  "ticketFiredAt",
  "itemStartedAt",
  "itemFulfilledAt",
  "itemFulfillmentLevel",
  "prepStationGuid",
  "prepStationName",
  "prepStationMultiLocationId",
  "diningOptionGuid",
  "diningOptionName",
  "diningOptionBehavior",
  "courseGuid",
  "courseName",
  "orderSource",
]);

type Row = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function redact(v: unknown): unknown {
  if (typeof v === "string" && UUID_RE.test(v)) return `${v.slice(0, 8)}…`;
  if (typeof v === "string" && v.length > 80) return `${v.slice(0, 80)}…`;
  return v;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function str(row: Row, field: string): string {
  const v = row[field];
  return v == null ? "" : String(v);
}

function analyze(rows: Row[]) {
  const distinct = (f: string) => new Set(rows.map((r) => str(r, f)).filter(Boolean));
  const distinctVals = (f: string) =>
    Array.from(new Set(rows.map((r) => str(r, f)).filter(Boolean))).sort();
  const nullCount = (f: string) => rows.filter((r) => r[f] == null).length;

  const prepSecs: number[] = [];
  let negativeOrZero = 0;
  for (const r of rows) {
    const fired = Date.parse(str(r, "ticketFiredAt"));
    const fulfilled = Date.parse(str(r, "itemFulfilledAt"));
    if (Number.isNaN(fired) || Number.isNaN(fulfilled)) continue;
    const s = Math.round((fulfilled - fired) / 1000);
    if (s <= 0) negativeOrZero += 1;
    else prepSecs.push(s);
  }
  prepSecs.sort((a, b) => a - b);

  const grainKey = (r: Row, withTicket: boolean) =>
    [
      withTicket ? str(r, "ticketGuid") : "",
      str(r, "selectionGuid"),
      str(r, "prepStationGuid"),
      str(r, "itemFulfillmentLevel"),
    ].join("|");

  const unexpected = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) if (!KNOWN_FIELDS.has(k)) unexpected.add(k);
  }

  // Rows colliding on the full proposed unique key — what actually differs?
  // (HOU 20260727 showed 3 such collisions; the answer decides upsert vs dedupe.)
  const byKey = new Map<string, Row[]>();
  for (const r of rows) {
    const k = grainKey(r, true);
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  const duplicateExamples = Array.from(byKey.values())
    .filter((list) => list.length > 1)
    .slice(0, 5)
    .map((list) =>
      list.map((r) => ({
        selectionGuid: redact(r["selectionGuid"]),
        itemName: redact(r["selectionMenuItemName"]),
        level: r["itemFulfillmentLevel"],
        station: r["prepStationName"] ?? null,
        firedAt: r["ticketFiredAt"],
        startedAt: r["itemStartedAt"],
        fulfilledAt: r["itemFulfilledAt"],
      }))
    );

  return {
    row_count: rows.length,
    distinct: {
      ticket_guids: distinct("ticketGuid").size,
      order_guids: distinct("orderGuid").size,
      selection_guids: distinct("selectionGuid").size,
      prep_station_names: distinctVals("prepStationName"),
      item_fulfillment_levels: distinctVals("itemFulfillmentLevel"),
      dining_option_behaviors: distinctVals("diningOptionBehavior"),
      order_sources: distinctVals("orderSource"),
    },
    null_counts: {
      ticketFiredAt: nullCount("ticketFiredAt"),
      itemStartedAt: nullCount("itemStartedAt"),
      itemFulfilledAt: nullCount("itemFulfilledAt"),
      prepStationGuid: nullCount("prepStationGuid"),
    },
    prep_seconds: {
      p50: percentile(prepSecs, 0.5),
      p90: percentile(prepSecs, 0.9),
      min: prepSecs[0] ?? 0,
      max: prepSecs[prepSecs.length - 1] ?? 0,
      negative_or_zero: negativeOrZero,
    },
    duplicate_grain_check: {
      rows: rows.length,
      distinct_selection_guid: distinct("selectionGuid").size,
      distinct_selection_plus_station_plus_level: new Set(
        rows.map((r) => grainKey(r, false))
      ).size,
      distinct_ticket_selection_station_level: new Set(
        rows.map((r) => grainKey(r, true))
      ).size,
    },
    duplicate_examples: duplicateExamples,
    sample_row_redacted: rows[0]
      ? Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, redact(v)]))
      : {},
    unexpected_fields: Array.from(unexpected).sort(),
  };
}

type Probe = { ok: boolean; data?: unknown; error?: string };

async function attempt(fn: () => Promise<unknown>): Promise<Probe> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enumerate the credential's restaurants. There is no single documented
 * "list my restaurants" for a standard machine client, so try the two known
 * shapes and report both: the partner-style listing, and the management-group
 * walk seeded from a known restaurant's config.
 */
async function enumerateRestaurants(seedGuid: string) {
  const partners = await attempt(() =>
    toastGet<unknown>(seedGuid, "/partners/v1/restaurants")
  );

  const seedConfig = await attempt(() =>
    toastGet<Row>(seedGuid, `/restaurants/v1/restaurants/${seedGuid}`)
  );

  let groupList: Probe = { ok: false, error: "skipped (no managementGroupGuid found)" };
  const mgmtGroupGuid =
    seedConfig.ok && seedConfig.data
      ? ((seedConfig.data as Row)["managementGroupGuid"] as string | undefined) ??
        (((seedConfig.data as Row)["general"] as Row | undefined)?.[
          "managementGroupGuid"
        ] as string | undefined)
      : undefined;
  if (mgmtGroupGuid) {
    groupList = await attempt(() =>
      toastGet<Row[]>(seedGuid, `/restaurants/v1/groups/${mgmtGroupGuid}/restaurants`)
    );
  }

  // Name every GUID the group walk surfaced (cap 12 — the credential holds 9).
  const named: Array<{ guid: string; name: unknown; error?: string }> = [];
  if (groupList.ok && Array.isArray(groupList.data)) {
    for (const entry of (groupList.data as Row[]).slice(0, 12)) {
      const guid = String(entry["guid"] ?? entry["restaurantGuid"] ?? "");
      if (!guid) continue;
      await sleep(150);
      const info = await attempt(() =>
        toastGet<Row>(guid, `/restaurants/v1/restaurants/${guid}`)
      );
      const general = info.ok ? ((info.data as Row)["general"] as Row | undefined) : undefined;
      named.push({
        guid,
        name: general?.["name"] ?? general?.["locationName"] ?? null,
        ...(info.ok ? {} : { error: info.error }),
      });
    }
  }

  return {
    partners_listing: { ok: partners.ok, error: partners.error, data: partners.data },
    seed_restaurant_config: {
      ok: seedConfig.ok,
      error: seedConfig.error,
      management_group_guid: mgmtGroupGuid ?? null,
      data: seedConfig.data,
    },
    group_restaurants: groupList,
    named_restaurants: named,
  };
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
  const mode = url.searchParams.get("mode") ?? "kitchen";
  const locationParam = (url.searchParams.get("location") ?? "").trim();
  const guidParam = (url.searchParams.get("guid") ?? "").trim();
  const businessDate = (url.searchParams.get("businessDate") ?? "").trim();

  try {
    // Resolve the restaurant GUID: explicit ?guid= wins (HOU has none stored);
    // otherwise look up the location's crosswalk row.
    let guid = guidParam;
    let locationCode = locationParam || (guidParam ? "(by guid)" : "");
    if (!guid) {
      if (!locationParam) {
        return NextResponse.json(
          { error: "Pass ?location=<CODE> (with a stored toast_restaurant_guid) or ?guid=<uuid>" },
          { status: 400 }
        );
      }
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("locations")
        .select("location_code, toast_restaurant_guid")
        .ilike("location_code", locationParam)
        .maybeSingle();
      if (error) throw new Error(`locations lookup: ${error.message}`);
      if (!data) {
        return NextResponse.json({ error: `Unknown location_code "${locationParam}"` }, { status: 404 });
      }
      if (!data.toast_restaurant_guid) {
        return NextResponse.json(
          {
            error: `${data.location_code} has no toast_restaurant_guid stored (HOU's is deliberately NULL — probe it via ?guid= once enumerated).`,
          },
          { status: 400 }
        );
      }
      guid = data.toast_restaurant_guid as string;
      locationCode = data.location_code as string;
    }

    if (mode === "restaurants") {
      return NextResponse.json({
        mode,
        seed_location: locationCode,
        ...(await enumerateRestaurants(guid)),
      });
    }

    if (!/^\d{8}$/.test(businessDate)) {
      return NextResponse.json({ error: "Pass ?businessDate=YYYYMMDD" }, { status: 400 });
    }

    const res = await Promise.race([
      toastGetWithStatus<Row[]>(guid, KITCHEN_PATH, { businessDate }),
      new Promise<{ status: number; body: null; error_body: string }>((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: 0,
              body: null,
              error_body: `kitchen export produced no response within ${KITCHEN_FETCH_TIMEOUT_MS / 1000}s (hang, not an HTTP error)`,
            }),
          KITCHEN_FETCH_TIMEOUT_MS
        )
      ),
    ]);

    if (res.status === 204) {
      return NextResponse.json({
        http_status: 204,
        location_code: locationCode,
        business_date: businessDate,
        verdict:
          "RMS Pro+ gate: 204 No Content = no Toast Restaurant Management Suite Pro+ subscription. STOP — this is an account conversation, not a code fix.",
      });
    }
    if (res.status !== 200 || !Array.isArray(res.body)) {
      return NextResponse.json({
        http_status: res.status,
        location_code: locationCode,
        business_date: businessDate,
        error_body: res.error_body ?? null,
        body_shape: Array.isArray(res.body) ? "array" : typeof res.body,
      });
    }

    return NextResponse.json({
      http_status: res.status,
      location_code: locationCode,
      business_date: businessDate,
      ...analyze(res.body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[toast-kitchen-probe] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
