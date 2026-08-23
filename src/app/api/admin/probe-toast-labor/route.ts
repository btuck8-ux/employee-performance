import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getAccessToken,
  invalidateToken,
  toastHost,
} from "@/lib/ingest/toast/client";

/**
 * STEP 0 probe for workstream I — Toast Labor time entries as the worked-time
 * source (addendum-2-worked-time-toast-2026-08-23 §2.2). READ-ONLY — no
 * writes to any database. Follows the probe-7shifts-shifts pattern:
 * CRON_SECRET-gated, run from the deployed app (Toast credentials are
 * Sensitive Vercel vars), key lists / shapes / counts only — no names, no
 * emails, no token material. GUIDs are echoed as 8-char prefixes.
 *
 * Questions (each answered explicitly in the response):
 *  1. Does the credential carry the Labor scope at all? (401/403 on
 *     /labor/v1/employees or /labor/v1/timeEntries is a REAL, BLOCKING
 *     finding — the 2026-07-27 "14 read scopes" note was an expectation,
 *     not a verification.)
 *  2. Which time-entry endpoint filter does the API honour —
 *     businessDate=yyyyMMdd, or a startDate/endDate window — and does it
 *     paginate? (Variant matrix on the first store; header capture for
 *     page tokens.)
 *  3. The complete field list of a time entry (top-level + one nested level),
 *     including clock-in/out, business date, breaks, job reference, and any
 *     deleted/voided marker.
 *  4. THE IDENTITY KEY: what identity fields a Toast time entry and the
 *     Toast employee record expose, and which could join to EPD. Measured,
 *     not guessed: per store, counts of Toast employees whose email matches
 *     an EPD employee email, and whose externalEmployeeId / externalId
 *     equals an EPD seven_shifts_user_id. Name matching is forbidden
 *     (house rule) and is not attempted.
 *  5. Acceptance re-confirmation: Chazz Limon EMP-100082 (DTD), Nathan
 *     Johnson EMP-100214 (COS), Luke Cato EMP-100020 (CPD) — Tucker saw
 *     their punches in the Toast UI; confirm the API exposes them, via a
 *     deterministic (email) join only. Per employee: Toast punch-day count
 *     in the window, and how many of their EPD scheduled-unworked days have
 *     a Toast punch.
 *  6. Volume + cost per store-day for the cron budget.
 *
 * Store scoping: strictly locations.toast_restaurant_guid (never "all the
 * credential reaches" — the credential also reaches Chico and a stray second
 * FCOL). NOLA has no GUID and is naturally excluded.
 *
 * AUTH: Bearer <CRON_SECRET>.
 *   GET /api/admin/probe-toast-labor
 *     ?start=YYYY-MM-DD&end=YYYY-MM-DD  window (default 2026-07-01..2026-08-20)
 *     &business_date=YYYY-MM-DD         single-day variant probe date (default end)
 *     &sample_days=3                    recent days per store for shape/volume
 *     &test_codes=EMP-100082,EMP-100214,EMP-100020
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DISCRIMINATOR_RE = /delet|void|status|approv|archiv|type|source/i;
const DISTINCT_CAP = 8;
const REQUEST_DELAY_MS = 120;
const MAX_WINDOW_DAYS = 62;

type Row = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function guidPrefix(v: unknown): string | null {
  return typeof v === "string" && v.length >= 8 ? v.slice(0, 8) : null;
}

/** Clamp echoed scalars — the no-PII invariant must not depend on Toast. */
function redactScalar(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "object") return `(${Array.isArray(v) ? "array" : "object"})`;
  return String(v).slice(0, 40);
}

interface KeyStat {
  non_null: number;
  distinct_values?: Record<string, number>;
}

/**
 * Union of payload keys with non-null counts; discriminator-shaped keys also
 * report their distinct (redacted) values. Nested objects (and first elements
 * of object arrays) contribute one level of "parent.child" key names so
 * employeeReference / jobReference / breaks shapes surface without echoing
 * their values.
 */
function discoverKeys(rows: Row[]): Record<string, KeyStat> {
  const stats = new Map<string, KeyStat>();
  const bump = (k: string, v: unknown) => {
    let s = stats.get(k);
    if (!s) {
      s = { non_null: 0 };
      if (DISCRIMINATOR_RE.test(k)) s.distinct_values = {};
      stats.set(k, s);
    }
    if (v !== null && v !== undefined && v !== "") s.non_null += 1;
    if (s.distinct_values) {
      const val = redactScalar(v);
      if (
        s.distinct_values[val] !== undefined ||
        Object.keys(s.distinct_values).length < DISTINCT_CAP
      ) {
        s.distinct_values[val] = (s.distinct_values[val] ?? 0) + 1;
      }
    }
  };
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      bump(k, v);
      const nested = Array.isArray(v) ? v[0] : v;
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        for (const [ck, cv] of Object.entries(nested as Row)) {
          bump(`${k}${Array.isArray(v) ? "[]" : ""}.${ck}`, cv);
        }
      }
    }
  }
  return Object.fromEntries([...stats.entries()].sort());
}

/** yyyyMMdd for Toast businessDate params. */
function yyyymmdd(date: string): string {
  return date.replaceAll("-", "");
}

/** Enumerate YYYY-MM-DD dates start..end inclusive (bounded). */
function dateRange(start: string, end: string, cap: number): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (d <= stop && out.length < cap) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Normalize a time entry's business date to YYYY-MM-DD (Toast has used both
 * yyyyMMdd and ISO); falls back to the inDate prefix (UTC caveat noted in
 * the response). */
function entryBusinessDate(e: Row): string | null {
  const bd = e["businessDate"];
  if (typeof bd === "number" || typeof bd === "string") {
    const s = String(bd);
    if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  }
  const inDate = e["inDate"];
  if (typeof inDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(inDate)) {
    return inDate.slice(0, 10);
  }
  return null;
}

interface ProbeResult {
  status: number;
  rows: Row[] | null;
  is_array: boolean;
  error_body?: string;
  headers_of_interest: Record<string, string>;
  elapsed_ms: number;
}

/**
 * One authenticated GET with header capture (page tokens / rate limits are a
 * probe question, and the shared client doesn't expose headers). Reuses the
 * client's auth/token layer; one re-auth on 401 so a stale cached token can't
 * masquerade as a missing scope.
 */
async function probeGet(
  restaurantGuid: string,
  path: string,
  params: Record<string, string>
): Promise<ProbeResult> {
  const url = new URL(`${toastHost()}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const t0 = Date.now();
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken();
    res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "Toast-Restaurant-External-ID": restaurantGuid,
        Accept: "application/json",
      },
    });
    if (res.status !== 401 || attempt > 0) break;
    invalidateToken();
  }
  if (!res) throw new Error("unreachable");
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (/page|token|link|rate|limit|next/i.test(k) && !/authorization/i.test(k)) {
      headers[k] = v.slice(0, 60);
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      status: res.status,
      rows: null,
      is_array: false,
      error_body: text.slice(0, 400),
      headers_of_interest: headers,
      elapsed_ms: Date.now() - t0,
    };
  }
  if (res.status === 204) {
    return {
      status: 204,
      rows: [],
      is_array: false,
      headers_of_interest: headers,
      elapsed_ms: Date.now() - t0,
    };
  }
  const body = (await res.json().catch(() => null)) as unknown;
  const rows = Array.isArray(body)
    ? (body as Row[])
    : body && typeof body === "object"
      ? [body as Row]
      : [];
  return {
    status: res.status,
    rows,
    is_array: Array.isArray(body),
    headers_of_interest: headers,
    elapsed_ms: Date.now() - t0,
  };
}

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const start = url.searchParams.get("start") ?? "2026-07-01";
  const end = url.searchParams.get("end") ?? "2026-08-20";
  const businessDate = url.searchParams.get("business_date") ?? end;
  const sampleDays = Math.min(
    Number(url.searchParams.get("sample_days") ?? 3) || 3,
    10
  );
  const testCodes = (
    url.searchParams.get("test_codes") ?? "EMP-100082,EMP-100214,EMP-100020"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const supabase = createAdminClient();

    // Strictly the crosswalked stores — never "everything the credential
    // reaches" (Chico / stray-FCOL guardrail, §2.7).
    const { data: locations, error: locError } = await supabase
      .from("locations")
      .select("id, location_code, toast_restaurant_guid")
      .not("toast_restaurant_guid", "is", null)
      .order("location_code");
    if (locError) throw new Error(`locations: ${locError.message}`);
    const stores = (locations ?? []).filter((l) => l.toast_restaurant_guid);
    if (stores.length === 0) throw new Error("no locations carry a toast_restaurant_guid");

    // ── Q2: variant matrix on the first store ────────────────────────────
    const first = stores[0];
    const shortStart = dateRange(start, end, MAX_WINDOW_DAYS).slice(-3)[0] ?? start;
    const variants: Array<{ name: string; params: Record<string, string> }> = [
      { name: "businessDate=yyyyMMdd", params: { businessDate: yyyymmdd(businessDate) } },
      {
        name: "startDate/endDate full window (ISO Z)",
        params: {
          startDate: `${start}T00:00:00.000Z`,
          endDate: `${end}T23:59:59.999Z`,
        },
      },
      {
        name: "startDate/endDate 3-day (ISO Z)",
        params: {
          startDate: `${shortStart}T00:00:00.000Z`,
          endDate: `${end}T23:59:59.999Z`,
        },
      },
    ];
    const variantMatrix: Array<Record<string, unknown>> = [];
    let scopeStatus: number | null = null;
    let windowMode: "full" | "short" | "businessDate" = "businessDate";
    for (const v of variants) {
      const r = await probeGet(
        first.toast_restaurant_guid,
        "/labor/v1/timeEntries",
        v.params
      );
      scopeStatus = scopeStatus ?? r.status;
      const dates = (r.rows ?? [])
        .map(entryBusinessDate)
        .filter((d): d is string => d !== null);
      variantMatrix.push({
        variant: v.name,
        status: r.status,
        rows: r.rows?.length ?? null,
        is_array: r.is_array,
        payload_min_date: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
        payload_max_date: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
        error_body: r.error_body,
        headers_of_interest: r.headers_of_interest,
        elapsed_ms: r.elapsed_ms,
      });
      if (r.status === 200) {
        if (v.name.includes("full window")) windowMode = "full";
        else if (v.name.includes("3-day") && windowMode === "businessDate")
          windowMode = "short";
      }
      await sleep(REQUEST_DELAY_MS);
    }
    const laborScope =
      scopeStatus === 401 || scopeStatus === 403
        ? { present: false, status: scopeStatus, blocking: true }
        : { present: scopeStatus === 200, status: scopeStatus, blocking: false };

    // Full-window pull for one store, honouring whatever the matrix learned.
    // businessDate fallback loops day-by-day (bounded, spaced).
    async function pullWindow(guid: string): Promise<{
      entries: Row[];
      requests: number;
      elapsed_ms: number;
      errors: string[];
    }> {
      const t0 = Date.now();
      const errors: string[] = [];
      if (windowMode === "full") {
        const r = await probeGet(guid, "/labor/v1/timeEntries", {
          startDate: `${start}T00:00:00.000Z`,
          endDate: `${end}T23:59:59.999Z`,
        });
        if (r.status !== 200) errors.push(`window pull ${r.status}: ${r.error_body ?? ""}`);
        return {
          entries: r.rows ?? [],
          requests: 1,
          elapsed_ms: Date.now() - t0,
          errors,
        };
      }
      const days = dateRange(start, end, MAX_WINDOW_DAYS);
      const entries: Row[] = [];
      let requests = 0;
      for (const day of days) {
        const r = await probeGet(guid, "/labor/v1/timeEntries", {
          businessDate: yyyymmdd(day),
        });
        requests += 1;
        if (r.status === 200) entries.push(...(r.rows ?? []));
        else errors.push(`${day}: ${r.status}`);
        await sleep(REQUEST_DELAY_MS);
      }
      return { entries, requests, elapsed_ms: Date.now() - t0, errors };
    }

    // EPD employees at the probed stores (identity join analysis).
    const { data: epdEmployees, error: empError } = await supabase
      .from("employees")
      .select("id, employee_code, location_id, email, seven_shifts_user_id, active")
      .in("location_id", stores.map((l) => l.id));
    if (empError) throw new Error(`employees: ${empError.message}`);
    const epdByLocation = new Map<string, typeof epdEmployees>();
    for (const e of epdEmployees ?? []) {
      const list = epdByLocation.get(String(e.location_id)) ?? [];
      list.push(e);
      epdByLocation.set(String(e.location_id), list);
    }

    // Window pulls are expensive — only for stores holding a test employee.
    const testEmps = (epdEmployees ?? []).filter((e) =>
      testCodes.includes(e.employee_code)
    );
    const windowStoreIds = new Set(testEmps.map((e) => String(e.location_id)));
    const windowEntriesByStore = new Map<
      string,
      Awaited<ReturnType<typeof pullWindow>>
    >();

    const perStore: Array<Record<string, unknown>> = [];
    for (const store of stores) {
      try {
        // ── Q1/Q4: employees endpoint + identity fields ──────────────────
        const empRes = await probeGet(
          store.toast_restaurant_guid,
          "/labor/v1/employees",
          {}
        );
        await sleep(REQUEST_DELAY_MS);
        const toastEmps = empRes.rows ?? [];
        const empKeys = discoverKeys(toastEmps);

        const epdHere = epdByLocation.get(String(store.id)) ?? [];
        const epdEmails = new Set(
          epdHere
            .map((e) => (typeof e.email === "string" ? e.email.trim().toLowerCase() : ""))
            .filter(Boolean)
        );
        const epd7sIds = new Set(
          epdHere
            .map((e) => (e.seven_shifts_user_id != null ? String(e.seven_shifts_user_id) : ""))
            .filter(Boolean)
        );
        const idField = (e: Row, k: string) =>
          e[k] != null && e[k] !== "" ? String(e[k]) : null;
        let emailMatches = 0;
        let extEmpIdEq7s = 0;
        let extIdEq7s = 0;
        const identityFieldCounts: Record<string, number> = {};
        for (const te of toastEmps) {
          for (const k of [
            "guid",
            "externalId",
            "externalEmployeeId",
            "email",
            "phoneNumber",
            "passcode",
          ]) {
            if (idField(te, k)) identityFieldCounts[k] = (identityFieldCounts[k] ?? 0) + 1;
          }
          const email = idField(te, "email");
          if (email && epdEmails.has(email.trim().toLowerCase())) emailMatches += 1;
          const extEmp = idField(te, "externalEmployeeId");
          if (extEmp && epd7sIds.has(extEmp)) extEmpIdEq7s += 1;
          const ext = idField(te, "externalId");
          if (ext && epd7sIds.has(ext)) extIdEq7s += 1;
        }

        // ── Q3/Q6: sample time-entry days for shape + volume ─────────────
        const sampleDates = dateRange(start, end, MAX_WINDOW_DAYS).slice(-sampleDays);
        const sampleEntries: Row[] = [];
        const sampleStatuses: Record<string, number> = {};
        let sampleElapsed = 0;
        for (const day of sampleDates) {
          const r = await probeGet(store.toast_restaurant_guid, "/labor/v1/timeEntries", {
            businessDate: yyyymmdd(day),
          });
          sampleStatuses[day] = r.status;
          sampleElapsed += r.elapsed_ms;
          if (r.status === 200) sampleEntries.push(...(r.rows ?? []));
          await sleep(REQUEST_DELAY_MS);
        }
        const entryKeys = discoverKeys(sampleEntries);
        const deletedTrue = sampleEntries.filter((e) => e["deleted"] === true).length;
        const distinctPunchers = new Set(
          sampleEntries
            .map((e) => {
              const ref = e["employeeReference"];
              return ref && typeof ref === "object"
                ? guidPrefix((ref as Row)["guid"])
                : null;
            })
            .filter(Boolean)
        ).size;

        // ── window pull for acceptance stores ────────────────────────────
        if (windowStoreIds.has(String(store.id))) {
          windowEntriesByStore.set(String(store.id), await pullWindow(store.toast_restaurant_guid));
        }
        const win = windowEntriesByStore.get(String(store.id));

        perStore.push({
          location_code: store.location_code,
          restaurant_guid_prefix: guidPrefix(store.toast_restaurant_guid),
          employees_endpoint: {
            status: empRes.status,
            rows: toastEmps.length,
            error_body: empRes.error_body,
            headers_of_interest: empRes.headers_of_interest,
            payload_keys: empKeys,
          },
          identity: {
            epd_employees: epdHere.length,
            epd_with_email: epdEmails.size,
            epd_with_7s_user_id: epd7sIds.size,
            toast_identity_field_non_null_counts: identityFieldCounts,
            toast_email_matches_epd_email: emailMatches,
            toast_externalEmployeeId_equals_epd_7s_user_id: extEmpIdEq7s,
            toast_externalId_equals_epd_7s_user_id: extIdEq7s,
          },
          time_entries_sample: {
            days: sampleDates,
            statuses: sampleStatuses,
            rows: sampleEntries.length,
            rows_per_day: sampleDates.length
              ? Math.round((sampleEntries.length / sampleDates.length) * 10) / 10
              : null,
            distinct_punching_employees: distinctPunchers,
            deleted_true: deletedTrue,
            elapsed_ms_total: sampleElapsed,
            payload_keys: entryKeys,
          },
          window_pull: win
            ? {
                mode: windowMode,
                rows: win.entries.length,
                requests: win.requests,
                elapsed_ms: win.elapsed_ms,
                errors: win.errors.slice(0, 5),
              }
            : null,
        });
      } catch (err) {
        perStore.push({
          location_code: store.location_code,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Q5: acceptance — the three UI-verified employees, via email join ──
    const codeByLocationId = new Map(stores.map((l) => [String(l.id), l.location_code]));
    const acceptance: Array<Record<string, unknown>> = [];
    for (const code of testCodes) {
      const emp = (epdEmployees ?? []).find((e) => e.employee_code === code);
      if (!emp) {
        acceptance.push({ employee_code: code, error: "not found at a Toast store" });
        continue;
      }
      const email =
        typeof emp.email === "string" && emp.email.trim()
          ? emp.email.trim().toLowerCase()
          : null;
      const storeCode = codeByLocationId.get(String(emp.location_id));
      const base: Record<string, unknown> = {
        employee_code: code,
        store: storeCode,
        epd_has_email: Boolean(email),
        epd_seven_shifts_user_id_present: emp.seven_shifts_user_id != null,
      };
      const win = windowEntriesByStore.get(String(emp.location_id));
      if (!win) {
        acceptance.push({ ...base, error: "no window pull for this store" });
        continue;
      }
      // Deterministic join only: find the Toast employee GUID(s) whose email
      // matches, then count their punches. Name matching is not attempted.
      const empEndpoint = await probeGet(
        stores.find((l) => String(l.id) === String(emp.location_id))!
          .toast_restaurant_guid,
        "/labor/v1/employees",
        {}
      );
      await sleep(REQUEST_DELAY_MS);
      const candidates = (empEndpoint.rows ?? []).filter(
        (te) =>
          email &&
          typeof te["email"] === "string" &&
          (te["email"] as string).trim().toLowerCase() === email
      );
      const candidateGuids = new Set(
        candidates.map((te) => te["guid"]).filter((g): g is string => typeof g === "string")
      );
      const punchDates = new Set<string>();
      for (const e of win.entries) {
        const ref = e["employeeReference"];
        const g = ref && typeof ref === "object" ? (ref as Row)["guid"] : null;
        if (typeof g === "string" && candidateGuids.has(g)) {
          const d = entryBusinessDate(e);
          if (d) punchDates.add(d);
        }
      }
      // EPD side: this employee's scheduled-unworked days in the window.
      const { data: entries, error: entriesError } = await supabase
        .from("time_entries")
        .select("entry_date, entry_type")
        .eq("employee_id", emp.id)
        .gte("entry_date", start)
        .lte("entry_date", end)
        .in("entry_type", ["scheduled", "worked"]);
      if (entriesError) {
        acceptance.push({ ...base, error: entriesError.message });
        continue;
      }
      const worked = new Set(
        (entries ?? [])
          .filter((e) => e.entry_type === "worked")
          .map((e) => String(e.entry_date).slice(0, 10))
      );
      const scheduledUnworked = [
        ...new Set(
          (entries ?? [])
            .filter((e) => e.entry_type === "scheduled")
            .map((e) => String(e.entry_date).slice(0, 10))
        ),
      ].filter((d) => !worked.has(d));
      acceptance.push({
        ...base,
        toast_email_match_candidates: candidates.length,
        toast_candidate_guid_prefixes: [...candidateGuids].map(guidPrefix),
        toast_punch_days_in_window: punchDates.size,
        epd_worked_days_in_window: worked.size,
        epd_scheduled_unworked_days: scheduledUnworked.length,
        scheduled_unworked_days_with_toast_punch: scheduledUnworked.filter((d) =>
          punchDates.has(d)
        ).length,
        note: "punch dates use Toast businessDate (or inDate UTC prefix as fallback); overnight shifts may straddle a day",
      });
    }

    return NextResponse.json({
      probe: "toast-labor",
      note: "READ-ONLY — no writes. Workstream I is built only after this output is read (addendum 2 §2.2/§3).",
      window: { start, end },
      labor_scope: laborScope,
      time_entries_variant_matrix: variantMatrix,
      window_mode_chosen: windowMode,
      stores: perStore,
      acceptance,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[probe-toast-labor] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
