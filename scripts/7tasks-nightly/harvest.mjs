/**
 * Nightly 7Tasks harvester (runs in GitHub Actions).
 *
 * The 7shifts per-employee Tasks report only exists behind the dashboard
 * session (app.7shifts.com), and dashboard cookies expire in days — the same
 * fragility that retired the server-side pull. So, like the CAKE nightly, we
 * drive a real Playwright login fresh each run, replay the dashboard's async
 * Tasks-report export per company from the authenticated session, and POST
 * each CSV to EPD's /api/admin/import-tasks-csv (idempotent upsert +
 * accountability + recompute). Rolling window (default last 7 days) — the
 * upsert makes overlap free.
 *
 * Required env (GitHub repo secrets):
 *   SEVENSHIFTS_USERNAME  7shifts dashboard login email (MFA-free account!)
 *   SEVENSHIFTS_PASSWORD  7shifts dashboard password
 *   EPD_BASE_URL          e.g. https://employee-performance-one.vercel.app
 *   EPD_HARVEST_TOKEN     matches Vercel TASKS_HARVEST_TOKEN/CAKE_HARVEST_TOKEN
 * Optional:
 *   DAYS_BACK             rolling window size in days (default 7)
 *   COMPANY_IDS           default "62064,185592" (HOU + the 6 CO stores)
 *   HEADLESS              "false" to watch locally (default true)
 */

import { chromium } from "playwright";

const {
  SEVENSHIFTS_USERNAME,
  SEVENSHIFTS_PASSWORD,
  EPD_BASE_URL,
  EPD_HARVEST_TOKEN,
  DAYS_BACK = "7",
  COMPANY_IDS = "62064,185592",
  HEADLESS = "true",
} = process.env;

const DASHBOARD_BASE = "https://app.7shifts.com/api/v2";
const LOGIN_URL = "https://app.7shifts.com/login";
const POLL_DELAY_MS = 1500;
const POLL_MAX_ATTEMPTS = 40; // ~60s; reports finish in seconds

function requireEnv() {
  const missing = [
    "SEVENSHIFTS_USERNAME",
    "SEVENSHIFTS_PASSWORD",
    "EPD_BASE_URL",
    "EPD_HARVEST_TOKEN",
  ].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(", ")}`);
    process.exit(1);
  }
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return isoDate(d);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function login(page) {
  console.log("Navigating to 7shifts login...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  const userSel = 'input[name="email"], input[type="email"], input#email';
  const passSel = 'input[name="password"], input[type="password"], input#password';
  await page.waitForSelector(userSel, { timeout: 30000 });
  await page.fill(userSel, SEVENSHIFTS_USERNAME);
  await page.fill(passSel, SEVENSHIFTS_PASSWORD);
  await Promise.all([
    page.waitForURL(
      (url) => url.hostname === "app.7shifts.com" && !url.pathname.startsWith("/login"),
      { timeout: 60000 }
    ),
    page.click('button[type="submit"], input[type="submit"]'),
  ]);
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  console.log("Logged in; landed on", page.url());
}

/** Build a Cookie header (+ CSRF echo) from the authenticated browser context. */
async function sessionHeaders(context) {
  const cookies = await context.cookies();
  const relevant = cookies.filter((c) => c.domain.includes("7shifts.com"));
  if (relevant.length === 0) throw new Error("No 7shifts cookies after login");
  const cookieHeader = relevant.map((c) => `${c.name}=${c.value}`).join("; ");
  const xsrf = relevant.find((c) => c.name === "XSRF-TOKEN");
  return {
    Cookie: cookieHeader,
    Accept: "application/json",
    ...(xsrf ? { "X-Csrf-Token": decodeURIComponent(xsrf.value) } : {}),
  };
}

/** The dashboard's 3-step async Tasks export (mirrors EPD's tasks-source.ts). */
async function fetchTasksCsv(headers, companyId, startDate, endDate) {
  const initRes = await fetch(
    `${DASHBOARD_BASE}/company/${companyId}/tasks_report?start_date=${startDate}&end_date=${endDate}&async_v2=true`,
    { headers }
  );
  if (!initRes.ok) {
    throw new Error(`tasks_report initiate ${initRes.status}: ${(await initRes.text()).slice(0, 300)}`);
  }
  const uuid = (await initRes.json())?.data?.report_task_uuid;
  if (!uuid) throw new Error(`tasks_report (company ${companyId}) returned no report_task_uuid`);

  let fileUrl = null;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_DELAY_MS);
    const pollRes = await fetch(`${DASHBOARD_BASE}/company/${companyId}/report_task/${uuid}`, { headers });
    if (!pollRes.ok) {
      throw new Error(`report_task poll ${pollRes.status}: ${(await pollRes.text()).slice(0, 300)}`);
    }
    const body = (await pollRes.json())?.data ?? {};
    if (body.file_url) {
      fileUrl = body.file_url;
      break;
    }
    const status = (body.status ?? "").toLowerCase();
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      throw new Error(`tasks_report job ${status}: ${body.status_description ?? "no description"}`);
    }
  }
  if (!fileUrl) throw new Error(`tasks_report (company ${companyId}) did not finish in time`);

  const csvRes = await fetch(fileUrl); // pre-signed; self-authorizing
  if (!csvRes.ok) throw new Error(`CSV download ${csvRes.status}`);
  return csvRes.text();
}

async function postToEpd(csv, windowStart, windowEnd) {
  const url = `${EPD_BASE_URL}/api/admin/import-tasks-csv?window_start=${windowStart}&window_end=${windowEnd}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${EPD_HARVEST_TOKEN}`, "Content-Type": "text/csv" },
    body: csv,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`import route ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function main() {
  requireEnv();

  const endDate = isoDate(new Date());
  const startDate = daysAgo(parseInt(DAYS_BACK, 10));
  const companies = COMPANY_IDS.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
  console.log(`Window: ${startDate} .. ${endDate}; companies: ${companies.join(", ")}`);

  const browser = await chromium.launch({ headless: HEADLESS !== "false" });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await login(page);
    const headers = await sessionHeaders(context);

    for (const companyId of companies) {
      console.log(`Exporting Tasks report for company ${companyId}...`);
      const csv = await fetchTasksCsv(headers, companyId, startDate, endDate);
      const lines = csv.split("\n").length;
      console.log(`  company ${companyId}: ${lines} CSV lines; posting to EPD`);
      const result = await postToEpd(csv, startDate, endDate);
      console.log(
        `  EPD result: by_status=${JSON.stringify(result.by_status)} ` +
          `outcomes=${(result.outcomes ?? [])
            .map((o) => `${o.location_code}:${o.status}(${o.rows_upserted})`)
            .join(" ")}`
      );
    }
    console.log("Done.");
  } catch (err) {
    try {
      await page.screenshot({ path: "7tasks-harvest-failure.png", fullPage: true });
      console.error("Saved failure screenshot to 7tasks-harvest-failure.png");
    } catch {}
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("FATAL:", err?.message || err);
  process.exit(1);
});
