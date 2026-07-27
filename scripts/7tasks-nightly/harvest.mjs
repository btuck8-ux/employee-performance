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
 * Houston (62064) and Colorado (185592) are SEPARATE 7shifts orgs — a login
 * belongs to one org, so one session's cookies cannot pull the other
 * company's tasks_report. Each region therefore gets its own service account
 * and its own login in a fresh browser context (no session bleed).
 *
 * Required env (GitHub repo secrets):
 *   SEVENSHIFTS_USERNAME_HH / SEVENSHIFTS_PASSWORD_HH  Houston org login
 *   SEVENSHIFTS_USERNAME_CO / SEVENSHIFTS_PASSWORD_CO  Colorado org login
 *     (both MFA-free service accounts!)
 *   EPD_BASE_URL          e.g. https://employee-performance-one.vercel.app
 *   EPD_HARVEST_TOKEN     matches Vercel TASKS_HARVEST_TOKEN/CAKE_HARVEST_TOKEN
 * Optional:
 *   DAYS_BACK             rolling window size in days (default 7)
 *   HEADLESS              "false" to watch locally (default true)
 */

import { chromium } from "playwright";

const {
  SEVENSHIFTS_USERNAME_HH,
  SEVENSHIFTS_PASSWORD_HH,
  SEVENSHIFTS_USERNAME_CO,
  SEVENSHIFTS_PASSWORD_CO,
  EPD_BASE_URL,
  EPD_HARVEST_TOKEN,
  DAYS_BACK = "7",
  HEADLESS = "true",
} = process.env;

/** Explicit account↔company map — one 7shifts org per service account.
 * Values are trimmed: a stray newline in a pasted GitHub secret reads as a
 * wrong password at the vendor. */
const trim = (v) => (v ?? "").trim();
const ACCOUNTS = [
  { label: "HOU", company: 62064, user: trim(SEVENSHIFTS_USERNAME_HH), pass: trim(SEVENSHIFTS_PASSWORD_HH) },
  { label: "CO", company: 185592, user: trim(SEVENSHIFTS_USERNAME_CO), pass: trim(SEVENSHIFTS_PASSWORD_CO) },
];

const DASHBOARD_BASE = "https://app.7shifts.com/api/v2";
const LOGIN_URL = "https://app.7shifts.com/login";
const POLL_DELAY_MS = 1500;
const POLL_MAX_ATTEMPTS = 40; // ~60s; reports finish in seconds

function requireEnv() {
  const missing = [
    "SEVENSHIFTS_USERNAME_HH",
    "SEVENSHIFTS_PASSWORD_HH",
    "SEVENSHIFTS_USERNAME_CO",
    "SEVENSHIFTS_PASSWORD_CO",
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

async function login(page, user, pass) {
  console.log("Navigating to 7shifts login...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // app.7shifts.com/login redirects to login.7shifts.com (FusionAuth OAuth):
  // the form is input#loginId + input#password (captured live 7/27). Cloudflare
  // fronts it — headless Chromium gets challenged, so the harness must run
  // HEADED (xvfb in CI). The email/... selectors are kept as fallbacks.
  const userSel = 'input#loginId, input[name="loginId"], input[name="email"], input[type="email"], input#email';
  const passSel = 'input#password, input[name="password"], input[type="password"]';
  await page.waitForSelector(userSel, { timeout: 30000 });

  // A cookie-consent overlay sometimes covers the form; dismiss best-effort.
  await page
    .locator('button:has-text("Accept")')
    .first()
    .click({ timeout: 3000 })
    .catch(() => {});

  await page.fill(userSel, user);
  await page.fill(passSel, pass);
  // FusionAuth's Log In button carries no type attribute (captured 7/27).
  await page.click('button.button-login, button[type="submit"], input[type="submit"]');
  try {
    await page.waitForURL(
      (url) => url.hostname === "app.7shifts.com" && !url.pathname.startsWith("/login"),
      { timeout: 60000 }
    );
  } catch (err) {
    // Distinguish "vendor rejected the credentials" from a slow redirect —
    // the former needs a re-pasted secret, not a retry.
    const rejected = await page
      .getByText(/wrong email or password/i)
      .count()
      .catch(() => 0);
    if (rejected > 0) {
      throw new Error(`7shifts rejected the credentials for ${user} (wrong email or password — re-check the GitHub secret)`);
    }
    throw err;
  }
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
  console.log(
    `Window: ${startDate} .. ${endDate}; regions: ${ACCOUNTS.map((a) => `${a.label}=${a.company}`).join(", ")}`
  );

  const browser = await chromium.launch({ headless: HEADLESS !== "false" });
  const regionFailures = [];
  try {
    // One login per region, each in a fresh context — the two companies are
    // separate 7shifts orgs, so cookies must not be shared between them.
    // Each region's CSV is single-org; the import route's Location-column
    // routing ingests the matching stores and skips the rest. A region
    // failing does NOT block the other region's ingest; the run still exits
    // non-zero at the end so the workflow (and its alert) goes red.
    for (const acct of ACCOUNTS) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await login(page, acct.user, acct.pass);
        const headers = await sessionHeaders(context);
        console.log(`[${acct.label}] exporting Tasks report for company ${acct.company}...`);
        const csv = await fetchTasksCsv(headers, acct.company, startDate, endDate);
        console.log(`[${acct.label}] ${csv.split("\n").length} CSV lines; posting to EPD`);
        const result = await postToEpd(csv, startDate, endDate);
        console.log(
          `[${acct.label}] EPD by_status=${JSON.stringify(result.by_status)} ` +
            `outcomes=${(result.outcomes ?? [])
              .map((o) => `${o.location_code}:${o.status}(${o.rows_upserted})`)
              .join(" ")}`
        );
      } catch (err) {
        const message = err?.message || String(err);
        console.error(`[${acct.label}] FAILED: ${message}`);
        regionFailures.push(`${acct.label}: ${message}`);
        try {
          await page.screenshot({
            path: `7tasks-harvest-failure-${acct.label}.png`,
            fullPage: true,
          });
          console.error(`Saved failure screenshot to 7tasks-harvest-failure-${acct.label}.png`);
        } catch {}
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  if (regionFailures.length > 0) {
    throw new Error(`${regionFailures.length} region(s) failed — ${regionFailures.join(" | ")}`);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error("FATAL:", err?.message || err);
  process.exit(1);
});
