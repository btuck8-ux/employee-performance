/**
 * Nightly CAKE timesheet harvester (runs in GitHub Actions).
 *
 * CAKE has no export and a confidential Keycloak OIDC client, so we drive the
 * real browser login with Playwright, then replay the portal's internal
 * `getShifts` API from the authenticated page session, and hand the result to
 * EPD's existing /api/admin/cake-timesheet-import route (idempotent upsert +
 * recompute). Pulls a rolling window (default last 3 days) so late clock-outs
 * and edits get re-captured; the upsert makes overlap free.
 *
 * Required env (GitHub repo secrets):
 *   CAKE_USERNAME      CAKE login email (e.g. tbascom@loveandsandwiches.com)
 *   CAKE_PASSWORD      CAKE login password
 *   EPD_BASE_URL       e.g. https://employee-performance-one.vercel.app
 *   EPD_CRON_SECRET    the EPD CRON_SECRET (authorizes the admin routes)
 * Optional:
 *   DAYS_BACK          rolling window size in days (default 3)
 *   CAKE_ACCOUNT_ID    default 11527572 (NOLA)
 *   HEADLESS           "false" to watch locally (default true)
 */

import { chromium } from "playwright";

const {
  CAKE_USERNAME,
  CAKE_PASSWORD,
  EPD_BASE_URL,
  EPD_CRON_SECRET,
  DAYS_BACK = "3",
  CAKE_ACCOUNT_ID = "11527572",
  HEADLESS = "true",
} = process.env;

const TZ = "America/Chicago";
const MERCHANT_ID = `c0070-${CAKE_ACCOUNT_ID}`;
const STAFF_URL = `https://staff.cake.net/timesheets?appClient=MP&accountId=${CAKE_ACCOUNT_ID}`;
const GETSHIFTS_URL = `https://payroll.cake.net/${CAKE_ACCOUNT_ID}/getShifts`;

function requireEnv() {
  const missing = ["CAKE_USERNAME", "CAKE_PASSWORD", "EPD_BASE_URL", "EPD_CRON_SECRET"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(", ")}`);
    process.exit(1);
  }
}

/** YYYY-MM-DD for a Date in America/Chicago. */
function chicagoDate(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return chicagoDate(d);
}

async function fetchProfileIds() {
  const res = await fetch(`${EPD_BASE_URL}/api/admin/cake-profile-ids`, {
    headers: { Authorization: `Bearer ${EPD_CRON_SECRET}` },
  });
  if (!res.ok) throw new Error(`cake-profile-ids ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (!Array.isArray(json.profile_ids) || json.profile_ids.length === 0) {
    throw new Error(`No profile ids returned from EPD: ${JSON.stringify(json)}`);
  }
  return json.profile_ids;
}

async function login(page) {
  console.log("Navigating to CAKE (will redirect to Keycloak login)...");
  await page.goto(STAFF_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Keycloak login form (default theme ids: username / password / kc-login).
  const userSel = 'input#username, input[name="username"], input[type="email"]';
  const passSel = 'input#password, input[name="password"], input[type="password"]';
  await page.waitForSelector(userSel, { timeout: 30000 });
  await page.fill(userSel, CAKE_USERNAME);
  await page.fill(passSel, CAKE_PASSWORD);
  await Promise.all([
    page.waitForURL("**staff.cake.net/**", { timeout: 60000 }),
    page.click('#kc-login, button[type="submit"], input[type="submit"]'),
  ]);
  // Settle the SPA + ensure the account context is loaded.
  await page.goto(STAFF_URL, { waitUntil: "networkidle", timeout: 60000 });
  console.log("Logged in; landed on", page.url());
}

/** Pull + normalize shifts for one profile id, in the authenticated page context. */
async function pullProfile(page, userId, dateFromMs, dateToMs) {
  return page.evaluate(
    async ({ userId, dateFromMs, dateToMs, MERCHANT_ID, GETSHIFTS_URL, TZ }) => {
      const dFmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const tFmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      const localDate = (ms) => dFmt.format(new Date(ms));
      const localTime = (ms) => {
        if (ms == null) return null;
        const t = tFmt.format(new Date(ms));
        return t === "24:00:00" ? "00:00:00" : t;
      };

      const out = [];
      let offset = 0;
      let total = Infinity;
      let guard = 0;
      while (offset < total && guard < 40) {
        guard++;
        const body = {
          merchantId: MERCHANT_ID,
          userId,
          timezone: TZ,
          dateFrom: dateFromMs,
          dateTo: dateToMs,
          offset,
          limit: 25,
        };
        const r = await fetch(GETSHIFTS_URL, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (r.status !== 200) throw new Error(`getShifts ${userId} HTTP ${r.status}`);
        const j = await r.json();
        total = j.total || 0;
        const shifts = j.shifts || [];
        for (const s of shifts) {
          if (s.endTime == null) continue; // open shift — not finalized
          const cios = (s.clockInOuts || []).filter((c) => c.inTime != null);
          let inMs = s.startTime;
          let outMs = s.endTime;
          if (cios.length) {
            inMs = Math.min(...cios.map((c) => c.inTime));
            const outs = cios.map((c) => c.outTime).filter((x) => x != null);
            outMs = outs.length ? Math.max(...outs) : s.endTime;
          }
          const role =
            (s.jobAssignmentsList || []).find((j2) => j2.jobAssignmentId === s.jobAssignmentId)
              ?.jobTitle ||
            (s.jobAssignmentsList && s.jobAssignmentsList[0] && s.jobAssignmentsList[0].jobTitle) ||
            "";
          out.push({
            cake_profile_id: s.userId,
            first_name: s.firstName || "",
            last_name: s.lastName || "",
            business_date: localDate(inMs),
            clock_in: localTime(inMs),
            clock_out: localTime(outMs),
            paid_hours: Number(s.paidHours) || 0,
            hourly_rate: s.hourlyRate != null ? Number(s.hourlyRate) : "",
            job_title: role,
          });
        }
        offset += 25;
        if (shifts.length === 0) break;
      }
      return out;
    },
    { userId, dateFromMs, dateToMs, MERCHANT_ID, GETSHIFTS_URL, TZ }
  );
}

function toCsv(rows) {
  const cols = [
    "cake_profile_id",
    "first_name",
    "last_name",
    "business_date",
    "clock_in",
    "clock_out",
    "paid_hours",
    "hourly_rate",
    "job_title",
  ];
  const esc = (v) => {
    v = v == null ? "" : String(v);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(","));
  return lines.join("\n");
}

async function postToEpd(csv, windowStart, windowEnd) {
  const url = `${EPD_BASE_URL}/api/admin/cake-timesheet-import?window_start=${windowStart}&window_end=${windowEnd}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${EPD_CRON_SECRET}`, "Content-Type": "text/csv" },
    body: csv,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`import route ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function main() {
  requireEnv();

  const today = chicagoDate(new Date());
  const windowEnd = addDays(today, -1); // yesterday (Chicago)
  const windowStart = addDays(windowEnd, -(parseInt(DAYS_BACK, 10) - 1));
  // Pull a slightly wider epoch range; the import route trims by business date.
  const dateFromMs = new Date(`${addDays(windowStart, -2)}T00:00:00-06:00`).getTime();
  const dateToMs = new Date(`${addDays(today, 1)}T00:00:00-06:00`).getTime();
  console.log(`Window: ${windowStart} .. ${windowEnd} (today=${today})`);

  const profileIds = await fetchProfileIds();
  console.log(`Pulling ${profileIds.length} NOLA profiles from CAKE`);

  const browser = await chromium.launch({ headless: HEADLESS !== "false" });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await login(page);

    const allRows = [];
    for (const userId of profileIds) {
      const rows = await pullProfile(page, userId, dateFromMs, dateToMs);
      allRows.push(...rows);
      console.log(`  profile ${userId}: ${rows.length} shift rows`);
    }

    if (allRows.length === 0) {
      console.warn("No shift rows pulled in window — nothing to import.");
    }
    const csv = toCsv(allRows);
    const result = await postToEpd(csv, windowStart, windowEnd);
    console.log("EPD import result:", JSON.stringify(result.outcome ?? result, null, 2));

    const unmapped = result?.outcome?.unmapped_profile_ids ?? [];
    if (unmapped.length) {
      console.warn(`⚠️ Unmapped CAKE profile ids (not in crosswalk): ${unmapped.join(", ")}`);
    }
    console.log(
      `Done. NOLA max(entry_date) before=${result?.coverage?.nola_max_entry_date_before} after=${result?.coverage?.nola_max_entry_date_after}`
    );
  } catch (err) {
    try {
      await page.screenshot({ path: "cake-harvest-failure.png", fullPage: true });
      console.error("Saved failure screenshot to cake-harvest-failure.png");
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
