import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionRole, type EpdRole } from "@/lib/authz";
import {
  LayoutDashboard,
  Building2,
  MapPin,
  Users,
  FileText,
  Upload,
  Settings,
  type LucideIcon,
} from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV: Record<string, NavItem> = {
  overview: { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  clients: { href: "/dashboard/clients", label: "Clients", icon: Building2 },
  locations: { href: "/dashboard/locations", label: "Locations", icon: MapPin },
  employees: { href: "/dashboard/employees", label: "Employees", icon: Users },
  reports: { href: "/dashboard/reports", label: "Reports", icon: FileText },
  uploads: { href: "/dashboard/uploads", label: "Uploads", icon: Upload },
  scoring: { href: "/dashboard/admin/scoring", label: "Scoring", icon: Settings },
};

/**
 * Role-gated nav (kickoff §4, decision A: RA/AA ride the manager nav).
 * Hiding is UX, not security — every gated page/action enforces its own
 * server-side check, and RLS trims data regardless. SA loses the Locations
 * item deliberately: client cards on /dashboard/clients link to each store.
 */
function navItemsForRole(role: EpdRole | null): NavItem[] {
  switch (role) {
    case "system_admin":
      return [NAV.overview, NAV.clients, NAV.employees, NAV.reports, NAV.uploads, NAV.scoring];
    case "regional_admin":
    case "area_admin":
    case "manager":
      return [NAV.overview, NAV.locations, NAV.employees, NAV.reports];
    case "user":
    default:
      // user tier is self-scoped; a null role (uninvited sign-in) fails
      // closed to the same minimal surface.
      return [NAV.overview];
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
        <div className="px-6 py-5 border-b border-slate-200">
          <h1 className="text-sm font-semibold tracking-tight">Employee Performance</h1>
          <p className="text-xs text-slate-500 mt-0.5">Internal platform</p>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {items.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-slate-700 hover:bg-slate-100"
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
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
