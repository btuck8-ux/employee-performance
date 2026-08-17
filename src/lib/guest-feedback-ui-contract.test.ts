/**
 * Text-level pins for the Guest Feedback page + Reports rework (kickoff
 * 2026-08-17 §4). Two invariants worth freezing:
 *
 *  1. PURVIEW SAFETY — both pages read through the authenticated server
 *     client (getSessionRole → RLS-trimmed queries). A service-role import
 *     in a dashboard page would silently bypass every read policy.
 *
 *  2. NAV SHAPE — "Guest Feedback" sits between Employees and Reports and
 *     is present for every signed-in tier; its icon key exists client-side.
 *
 * Plus the 4a ruling: the Reports page shows ONLY the builder + a 7-day
 * card — superseded excluded with no toggle (the per-employee archive with
 * its toggle lives on the profile page).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const guestPage = read("src/app/dashboard/guest-feedback/page.tsx");
const reportsPage = read("src/app/dashboard/reports/page.tsx");
const layout = read("src/app/dashboard/layout.tsx");
const navLinks = read("src/components/nav-links.tsx");

test("guest-feedback page reads through the authenticated client only", () => {
  assert.match(guestPage, /getSessionRole/, "uses the session client");
  assert.doesNotMatch(
    guestPage,
    /supabase\/admin|createAdminClient|SUPABASE_SERVICE_ROLE/,
    "no service-role access from a dashboard page"
  );
  // Server page: rendering the client ExpandableText component is fine;
  // gaining a "use client" directive itself would break the server render.
  assert.doesNotMatch(guestPage, /^\s*["']use client["'];?\s*$/m);
});

test("guest-feedback page paginates server-side on both tables", () => {
  assert.match(guestPage, /from\("customer_reviews"\)[\s\S]*?\.range\(/);
  assert.match(guestPage, /from\("tattle_surveys"\)[\s\S]*?\.range\(/);
  // Unbounded tables — a fetch-all (no .range) regression is the trap here.
  assert.match(guestPage, /count: "exact"/);
});

test("nav: Guest Feedback between Employees and Reports, every tier, icon wired", () => {
  const emp = layout.indexOf("NAV.employees,");
  const gf = layout.indexOf("NAV.guestFeedback,");
  const rep = layout.indexOf("NAV.reports,");
  assert.ok(emp !== -1 && gf !== -1 && rep !== -1, "all three nav items present");
  assert.ok(emp < gf && gf < rep, "Guest Feedback sits between Employees and Reports");
  assert.match(layout, /label: "Guest Feedback"/);
  // Every role branch carries it — including the self-scoped user/null tier.
  const userBranch = layout.slice(layout.indexOf('case "user":'));
  assert.match(userBranch, /NAV\.guestFeedback/, "user tier sees Guest Feedback");
  assert.match(navLinks, /"guest-feedback": \w+/, "icon key registered in ICONS");
});

test("reports page: 7-day card, superseded excluded, no toggle, no archive list", () => {
  assert.match(reportsPage, /RECENT_WINDOW_DAYS = 7/);
  assert.match(reportsPage, /\.is\("superseded_at", null\)/, "superseded excluded");
  assert.doesNotMatch(
    reportsPage,
    /include_superseded/,
    "the superseded toggle lives on the profile archive, not here"
  );
  assert.match(reportsPage, /getSessionRole/);
  assert.doesNotMatch(reportsPage, /supabase\/admin|createAdminClient/);
});
