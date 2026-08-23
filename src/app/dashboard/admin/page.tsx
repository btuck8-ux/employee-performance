import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";

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
];

export default async function AdminIndexPage() {
  const { role } = await getSessionRole();
  if (role !== "system_admin") redirect("/dashboard");

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
            <h2 className="text-base font-semibold">{s.title}</h2>
            <p className="text-sm text-slate-500 mt-1">{s.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
