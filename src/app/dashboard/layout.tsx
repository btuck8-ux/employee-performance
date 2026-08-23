import Image from "next/image";
import { redirect } from "next/navigation";
import { getSessionRole, type EpdRole } from "@/lib/authz";
import { NavLinks, type NavLinkItem } from "@/components/nav-links";

const NAV: Record<string, NavLinkItem> = {
  overview: { href: "/dashboard", label: "Overview", icon: "overview" },
  clients: { href: "/dashboard/clients", label: "Clients", icon: "clients" },
  locations: { href: "/dashboard/locations", label: "Locations", icon: "locations" },
  employees: { href: "/dashboard/employees", label: "Employees", icon: "employees" },
  guestFeedback: {
    href: "/dashboard/guest-feedback",
    label: "Guest Feedback",
    icon: "guest-feedback",
  },
  reports: { href: "/dashboard/reports", label: "Reports", icon: "reports" },
  uploads: { href: "/dashboard/uploads", label: "Uploads", icon: "uploads" },
  // Settings group (2026-08-23 §4-D1): Scoring kept its route; Employee
  // triage moved in from the Employees-header chip (the chip stays as a
  // shortcut); Users is new. /dashboard/admin is a real index page.
  settings: {
    href: "/dashboard/admin",
    label: "Settings",
    icon: "settings",
    children: [
      { href: "/dashboard/admin/scoring", label: "Scoring", icon: "scoring" },
      {
        href: "/dashboard/admin/employee-triage",
        label: "Employee triage",
        icon: "triage",
      },
      { href: "/dashboard/admin/users", label: "Users", icon: "users" },
    ],
  },
};

/**
 * Role-gated nav (kickoff §4, decision A: RA/AA ride the manager nav).
 * Hiding is UX, not security — every gated page/action enforces its own
 * server-side check, and RLS trims data regardless. SA loses the Locations
 * item deliberately: client cards on /dashboard/clients link to each store.
 * Guest Feedback is visible to EVERY signed-in tier (kickoff 2026-08-17
 * §4b) — RLS trims its rows, and a location-less session just sees empty
 * tabs.
 */
function navItemsForRole(role: EpdRole | null): NavLinkItem[] {
  switch (role) {
    case "system_admin":
      return [
        NAV.overview,
        NAV.clients,
        NAV.employees,
        NAV.guestFeedback,
        NAV.reports,
        NAV.uploads,
        NAV.settings,
      ];
    case "regional_admin":
    case "area_admin":
    case "manager":
      return [NAV.overview, NAV.locations, NAV.employees, NAV.guestFeedback, NAV.reports];
    case "user":
    default:
      // user tier is self-scoped; a null role (uninvited sign-in) fails
      // closed to the same minimal surface.
      return [NAV.overview, NAV.guestFeedback];
  }
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, role } = await getSessionRole();
  if (!user) redirect("/auth/login");

  const items = navItemsForRole(role);

  return (
    <div className="min-h-screen flex bg-slate-50">
      <aside className="w-60 bg-white border-r border-slate-200 flex flex-col">
        <div className="px-5 py-4 border-b border-slate-200">
          <Image
            src="/brand/logo-primary-t.png"
            alt="Ike's Love & Sandwiches"
            width={170}
            height={56}
            priority
            className="h-auto w-full max-w-[170px]"
          />
          <p className="text-xs text-slate-500 mt-1.5">Employee Performance</p>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          <NavLinks items={items} />
        </nav>
        <div className="border-t border-slate-200 px-4 py-3">
          <p className="text-xs text-slate-500 truncate" title={user.email ?? ""}>
            {user.email}
          </p>
          <form action="/auth/logout" method="post">
            <button
              type="submit"
              className="text-xs text-slate-600 hover:text-slate-900 mt-1"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
