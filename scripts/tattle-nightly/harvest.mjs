/**
 * Nightly Tattle token refresher (runs in GitHub Actions).
 *
 * Tattle auth is OIDC (oidc-client-ts) and its refresh cannot be replayed
 * server-side (rotating refresh tokens, form-encoded token endpoint), so —
 * like CAKE and 7Tasks — the durable path is a real Playwright login fresh
 * each run. After login the oidc-client library stores the session in
 * localStorage under an `oidc.user:…` key; we read `access_token` out of it
 * and POST it to EPD's /api/admin/set-tattle-token, where the guest-feedback
 * harvester picks it up (app_settings, env fallback). The 09:30 UTC Vercel
 * cron then runs Tattle+Reviews with a token at most ~20h old.
 *
 * Required env (GitHub repo secrets):
 *   TATTLE_USERNAME    Tattle dashboard login email (MFA-free account!)
 *   TATTLE_PASSWORD    Tattle dashboard password
 *   EPD_BASE_URL       e.g. https://employee-performance-one.vercel.app
 *   EPD_HARVEST_TOKEN  matches Vercel TASKS_HARVEST_TOKEN/CAKE_HARVEST_TOKEN
 * Optional:
 *   TATTLE_APP_URL     default https://dashboard.gettattle.com
 *   HEADLESS           "false" to watch locally (default true)
 */

import { chromium } from "playwright";

const {
  TATTLE_USERNAME,
  TATTLE_PASSWORD,
  EPD_BASE_URL,
  EPD_HARVEST_TOKEN,
  TATTLE_APP_URL = "https://dashboard.gettattle.com",
  HEADLESS = "true",
} = process.env;

function requireEnv() {
  const missing = ["TATTLE_USERNAME", "TATTLE_PASSWORD", "EPD_BASE_URL", "EPD_HARVEST_TOKEN"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function login(page) {
  console.log(`Navigating to ${TATTLE_APP_URL} (will redirect to login)...`);
  await page.goto(TATTLE_APP_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  const userSel = 'input[type="email"], input[name="email"], input[name="username"], input#username';
  const passSel = 'input[type="password"], input[name="password"], input#password';
  await page.waitForSelector(userSel, { timeout: 30000 });
  await page.fill(userSel, TATTLE_USERNAME);
  await page.fill(passSel, TATTLE_PASSWORD);
  await page.click('button[type="submit"], input[type="submit"]');
  // Let the OIDC redirect dance settle back on the dashboard.
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  console.log("Post-login URL:", page.url());
}

/**
 * Read the fresh access token from the authenticated session's storage.
 * Primary: oidc-client-ts `oidc.user:<authority>:<client>` localStorage key
 * (JSON with access_token). Fallbacks: the legacy `ngStorage-token` key and
 * sessionStorage variants.
 */
async function extractAccessToken(page) {
  return page.evaluate(() => {
    const stores = [window.localStorage, window.sessionStorage];
    for (const store of stores) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (!key) continue;
        if (key.startsWith("oidc.user:")) {
          try {
            const parsed = JSON.parse(store.getItem(key) ?? "");
            if (parsed?.access_token) return { key, token: parsed.access_token };
          } catch {}
        }
      }
    }
    for (const store of stores) {
      const legacy = store.getItem("ngStorage-token");
      if (legacy) {
        try {
          const parsed = JSON.parse(legacy);
          const token = typeof parsed === "string" ? parsed : parsed?.token ?? parsed?.access_token;
          if (token) return { key: "ngStorage-token", token };
        } catch {
          return { key: "ngStorage-token", token: legacy };
        }
      }
    }
    return null;
  });
}

async function postToken(token) {
  const res = await fetch(`${EPD_BASE_URL}/api/admin/set-tattle-token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${EPD_HARVEST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`set-tattle-token ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function main() {
  requireEnv();

  const browser = await chromium.launch({ headless: HEADLESS !== "false" });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await login(page);

    // Give the OIDC client a moment to persist the user after the redirect.
    let found = null;
    for (let attempt = 0; attempt < 10 && !found; attempt++) {
      found = await extractAccessToken(page);
      if (!found) await page.waitForTimeout(2000);
    }
    if (!found) {
      throw new Error("No access token found in local/sessionStorage after login");
    }
    console.log(`Token captured from storage key "${found.key}" (${found.token.length} chars)`);

    const result = await postToken(found.token);
    console.log(`EPD stored token; expires ${result.token_expires ?? "unknown"}`);
    console.log("Done.");
  } catch (err) {
    try {
      await page.screenshot({ path: "tattle-harvest-failure.png", fullPage: true });
      console.error("Saved failure screenshot to tattle-harvest-failure.png");
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
