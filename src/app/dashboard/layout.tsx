import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  LayoutDashboard,
  Building2,
  MapPin,
  Users,
  FileText,
  Upload,
  Settings,
} from "lucide-react";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/clients", label: "Clients", icon: Building2 },
  { href: "/dashboard/locations", label: "Locations", icon: MapPin },
  { href: "/dashboard/employees", label: "Employees", icon: Users },
  { href: "/dashboard/reports", label: "Reports", icon: FileText },
  { href: "/dashboard/uploads", label: "Uploads", icon: Upload },
  { href: "/dashboard/admin/scoring", label: "Scoring", icon: Settings },
];

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  return (
    <div className="min-h-screen flex bg-slate-50">
      <aside className="w-60 bg-white border-r border-slate-200 flex flex-col">
        <div className="px-6 py-5 border-b border-slate-200">
          <h1 className="text-sm font-semibold tracking-tight">Employee Performance</h1>
          <p className="text-xs text-slate-500 mt-0.5">Internal platform</p>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
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
