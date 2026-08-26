import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Settings index (2026-08-23 §4-D1) — /dashboard/admin was a dead-end URL
 * once it became the nav group's parent; this page lists the three admin
 * surfaces. SA-only, same gate as its children.
 */

const SURFACES = [
  {
    href: "/dashboard/admin/scoring",
    title: "Scoring",
    description:
      "Composite-score weights and the nine metric targets (shared with Training HQ — changes ship both apps together).",
  },
  {
    href: "/dashboard/admin/employee-triage",
    title: "Employee triage",
    description:
      "Detected employees from the CP schedule feed — review, mint codes, or dismiss, per site.",
  },
  {
    href: "/dashboard/admin/users",
    title: "Users",
    description:
      "Dashboard accounts: invite, scope, and revoke roles. Invitations only — sign-in credentials are set by the invitee, never here.",
  },
  {
    href: "/dashboard/admin/toast-crosswalk",
    title: "Toast crosswalk",
    description:
      "Map Toast punch accounts to EPD employees. Unmatched accounts with punches queue here; auto-matches are listed and reversible.",
  },
  {
    href: "/dashboard/admin/departure-candidates",
    title: "Departure candidates",
    description:
      "The sweep is a notifier: people dormant 30 days at every associated store queue here. Dismiss or deactivate — a human decides, never the sweep.",
  },
  {
    href: "/dashboard/admin/unclassified-tiers",
    title: "Unclassified tiers",
    description:
      "People no human has decided a tier for — new imports land here by default. A safe state, not a permanent one: classify as soon as possible.",
  },
];

export default async function AdminIndexPage() {
  const { role } = await getSessionRole();
  if (role !== "system_admin") redirect("/dashboard");

  // The unclassified count is the "steady pressure" chip Tucker required
  // (CSU memo §6). Non-fatal: the index renders without it.
  let unclassifiedCount: number | null = null;
  try {
    const { count, error } = await createAdminClient()
      .from("employees")
      .select("id", { count: "exact", head: true })
      .eq("epd_role", "unclassified");
    if (error) {
      // supabase-js reports query failures in-band, not by throwing — an
      // ignored error here would render a silent 0 (Codex nit).
      console.warn("[admin-index] unclassified count query failed", {
        message: error.message,
      });
    } else {
      unclassifiedCount = count ?? 0;
    }
  } catch (err) {
    console.warn("[admin-index] unclassified count unavailable", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-slate-500 mt-1">
          System-admin surfaces. Every action here re-checks your role
          server-side.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {SURFACES.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="rounded-lg border border-slate-200 bg-white p-5 hover:border-ikes-green transition-colors"
          >
            <h2 className="text-base font-semibold">
              {s.title}
              {s.href === "/dashboard/admin/unclassified-tiers" &&
                unclassifiedCount !== null &&
                unclassifiedCount > 0 && (
                  <span className="ml-2 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-normal text-amber-900">
                    {unclassifiedCount} awaiting
                  </span>
                )}
            </h2>
            <p className="text-sm text-slate-500 mt-1">{s.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
