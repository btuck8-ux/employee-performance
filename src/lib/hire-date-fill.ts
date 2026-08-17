import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Hire-date NULL-fill (kickoff 2026-08-17 §3, resolved by Tucker's §6-B
 * ruling after the Step-0 probe).
 *
 * THE RULING (2026-08-17, do not re-litigate):
 *  - An employee that ALREADY HAS a hire_date keeps it — this fill never
 *    overwrites, and hand-set dates via the profile edit page always win.
 *  - An employee with NO hire_date gets the date of the FIRST WORKED shift
 *    we have data for. Scheduled entries deliberately DON'T count ("first
 *    shift they worked" — a schedule row isn't evidence anyone showed up).
 *
 * WHY fallback-only: the Step-0 probe (/api/admin/probe-7shifts-hire-date,
 * run 2026-08-17 against both companies' live payloads) found ZERO
 * hire-date-shaped fields in the 7shifts users list AND detail endpoints —
 * the original "7shifts is the source of truth" plan has no source to read.
 * Don't re-research; the probe route + PR #16 body hold the evidence.
 *
 * KNOWN LIMIT (accepted in the ruling): earliest-worked-entry floors at the
 * start of EPD's data, so employees hired before our ingest era show
 * tenure from the data floor, not their true start. Correct individually
 * via the profile edit page — this fill will never claw such a fix back.
 *
 * COVERAGE: reads `time_entries` regardless of which feed landed the row,
 * so NOLA (CAKE-sourced worked rows) is covered by the same pass — no
 * per-source fan-out. Runs from the nightly-ingest cron (new hires get
 * stamped the night their first worked shift lands) and from the
 * /api/admin/backfill-hire-dates operator lever.
 *
 * Never throws: per-employee failures are counted and reported, and the
 * nightly caller additionally wraps this so a fill problem can never fail
 * the ingest cron itself.
 */

// Admin (service-role) client — the fill is an operational write and runs
// only from CRON_SECRET-gated routes, never from a browser session.
type AdminClient = SupabaseClient;

const FILL_CONCURRENCY = 8;

export interface HireDateFillRow {
  employee_code: string;
  employee_name: string;
  hire_date: string;
}

export interface HireDateFillResult {
  examined: number;
  filled: number;
  no_worked_entries: number;
  errors: number;
  filled_rows: HireDateFillRow[];
  error_messages: string[];
}

interface NullHireRow {
  id: string;
  employee_code: string | null;
  employee_name: string | null;
}

async function fillOne(
  supabase: AdminClient,
  emp: NullHireRow,
  result: HireDateFillResult
): Promise<void> {
  const { data: firstWorked, error: readError } = await supabase
    .from("time_entries")
    .select("entry_date")
    .eq("employee_id", emp.id)
    .eq("entry_type", "worked")
    .order("entry_date", { ascending: true })
    .limit(1);
  if (readError) {
    result.errors += 1;
    result.error_messages.push(
      `${emp.employee_code ?? emp.id}: read failed — ${readError.message}`
    );
    return;
  }
  const hireDate = firstWorked?.[0]?.entry_date as string | undefined;
  if (!hireDate) {
    result.no_worked_entries += 1;
    return;
  }

  // The .is("hire_date", null) guard makes the write race-safe: if Tucker
  // hand-sets a date between our read and this update, the update matches
  // zero rows and the manual value survives (never-overwrite invariant).
  const { data: updated, error: writeError } = await supabase
    .from("employees")
    .update({ hire_date: hireDate })
    .eq("id", emp.id)
    .is("hire_date", null)
    .select("id");
  if (writeError) {
    result.errors += 1;
    result.error_messages.push(
      `${emp.employee_code ?? emp.id}: write failed — ${writeError.message}`
    );
    return;
  }
  if ((updated ?? []).length > 0) {
    result.filled += 1;
    result.filled_rows.push({
      employee_code: emp.employee_code ?? "—",
      employee_name: emp.employee_name ?? "—",
      hire_date: hireDate,
    });
  }
}

/** Fill every NULL employees.hire_date from the earliest WORKED time entry. */
export async function fillMissingHireDates(
  supabase: AdminClient
): Promise<HireDateFillResult> {
  const result: HireDateFillResult = {
    examined: 0,
    filled: 0,
    no_worked_entries: 0,
    errors: 0,
    filled_rows: [],
    error_messages: [],
  };

  // Active AND inactive employees alike — an archived employee's tenure
  // still renders on their profile and in historical reports.
  const { data: nullRows, error } = await supabase
    .from("employees")
    .select("id, employee_code, employee_name")
    .is("hire_date", null);
  if (error) {
    result.errors += 1;
    result.error_messages.push(`employee scan failed — ${error.message}`);
    return result;
  }

  const employees = (nullRows ?? []) as NullHireRow[];
  result.examined = employees.length;

  for (let i = 0; i < employees.length; i += FILL_CONCURRENCY) {
    const chunk = employees.slice(i, i + FILL_CONCURRENCY);
    await Promise.all(chunk.map((emp) => fillOne(supabase, emp, result)));
  }

  // Deterministic report order regardless of chunk completion order.
  result.filled_rows.sort((a, b) =>
    a.employee_code.localeCompare(b.employee_code)
  );
  return result;
}
