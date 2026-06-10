/**
 * Source C — per-employee 7Tasks (handoff §2, 7shifts DASHBOARD API).
 *
 * This is the session-authenticated dashboard host (app.7shifts.com/api/v2), NOT
 * the public Access-Token API (api.7shifts.com, client.ts). The public API's only
 * task endpoint is the aggregate task_list_daily_summary (no per-employee data),
 * which is why per-employee attribution needs this captured export.
 *
 * Async job (captured live 2026-06-10):
 *   1. Initiate: GET .../company/{company_id}/tasks_report
 *        ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&async_v2=true
 *        → { data: { report_task_uuid } }
 *   2. Poll:     GET .../company/{company_id}/report_task/{uuid}
 *        → { data: { status, status_description, file_url } } until file_url set.
 *   3. Download: GET file_url (pre-signed) → CSV → parseTasksCsv.
 *
 * `Locations: All` exports every store in the company; the CSV `Location` column
 * routes them per store (parseTasksCsv keeps it; ingestTasksForLocation filters).
 * Auth is the dashboard cookie session (handoff §3); one cookie covers all three
 * companies (company_id is in the path). 401/403 → SessionExpiredError('7shifts').
 */

import { parseTasksCsv, type TaskImportResult } from "@/lib/task-import";
import { SessionExpiredError, sevenShiftsDashboardCookie } from "./secrets";

const DASHBOARD_BASE = "https://app.7shifts.com/api/v2";
const POLL_DELAY_MS = 1500;
const POLL_MAX_ATTEMPTS = 40; // ~60s; reports finish in seconds, this is the guard

const TERMINAL_FAIL = new Set(["failed", "error", "cancelled", "canceled"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the XSRF-TOKEN value from the captured cookie string, if present, so
 * we can echo it as a header. GET requests generally don't require CSRF, but
 * echoing it is harmless and matches how the dashboard client behaves.
 */
function xsrfFromCookie(cookie: string): string | null {
  const m = cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function dashboardFetch(path: string): Promise<Response> {
  const cookie = sevenShiftsDashboardCookie();
  const xsrf = xsrfFromCookie(cookie);
  const res = await fetch(`${DASHBOARD_BASE}/${path}`, {
    headers: {
      Cookie: cookie,
      Accept: "application/json",
      ...(xsrf ? { "X-Csrf-Token": xsrf } : {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new SessionExpiredError("7shifts");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `7shifts dashboard ${res.status} ${res.statusText} for /${path.split("?")[0]}: ${body.slice(0, 300)}`
    );
  }
  return res;
}

interface InitiateResponse {
  data?: { report_task_uuid?: string };
}
interface PollResponse {
  data?: {
    report_task_uuid?: string;
    status?: string;
    status_description?: string;
    file_url?: string | null;
  };
}

/**
 * Run the async Tasks-report export for one 7shifts company over [startDate,
 * endDate] (YYYY-MM-DD) and parse the resulting CSV via parseTasksCsv. The
 * returned TaskImportResult spans every store in the company; the caller routes
 * rows per location with ingestTasksForLocation. Throws on timeout, a failed
 * report job, or an expired session.
 */
export async function fetchTasksReport(
  companyId: number,
  startDate: string,
  endDate: string
): Promise<TaskImportResult> {
  // 1. Initiate.
  const initRes = await dashboardFetch(
    `company/${companyId}/tasks_report?start_date=${startDate}&end_date=${endDate}&async_v2=true`
  );
  const initBody = (await initRes.json()) as InitiateResponse;
  const uuid = initBody.data?.report_task_uuid;
  if (!uuid) {
    throw new Error(
      `7shifts tasks_report (company ${companyId}) returned no report_task_uuid.`
    );
  }

  // 2. Poll until file_url is populated (or the job fails / times out).
  let fileUrl: string | null = null;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    await sleep(POLL_DELAY_MS);
    const pollRes = await dashboardFetch(`company/${companyId}/report_task/${uuid}`);
    const pollBody = (await pollRes.json()) as PollResponse;
    const status = (pollBody.data?.status ?? "").toLowerCase();
    if (pollBody.data?.file_url) {
      fileUrl = pollBody.data.file_url;
      break;
    }
    if (TERMINAL_FAIL.has(status)) {
      throw new Error(
        `7shifts tasks_report (company ${companyId}) job ${status}: ${
          pollBody.data?.status_description ?? "no description"
        }`
      );
    }
  }
  if (!fileUrl) {
    throw new Error(
      `7shifts tasks_report (company ${companyId}) did not finish within ${
        (POLL_DELAY_MS * POLL_MAX_ATTEMPTS) / 1000
      }s.`
    );
  }

  // 3. Download the pre-signed CSV (self-authorizes — no cookie needed).
  const csvRes = await fetch(fileUrl);
  if (!csvRes.ok) {
    const t = await csvRes.text().catch(() => "");
    throw new Error(
      `7shifts tasks_report download ${csvRes.status} ${csvRes.statusText}: ${t.slice(0, 300)}`
    );
  }
  const csv = await csvRes.text();
  return parseTasksCsv(csv);
}
