"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Building2,
  MapPin,
  MessageSquare,
  Users,
  FileText,
  Upload,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Icons live client-side keyed by name — component functions can't cross the
// server→client prop boundary.
const ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  clients: Building2,
  locations: MapPin,
  employees: Users,
  "guest-feedback": MessageSquare,
  reports: FileText,
  uploads: Upload,
  scoring: Settings,
};

export interface NavLinkItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
}

export function NavLinks({ items }: { items: NavLinkItem[] }) {
  const pathname = usePathname();
  return (
    <>
      {items.map(({ href, label, icon }) => {
        const Icon = ICONS[icon] ?? LayoutDashboard;
        const active =
          href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
              active
                ? "bg-ikes-purple text-white font-medium"
                : "text-slate-700 hover:bg-ikes-green/10 hover:text-ikes-green-dark"
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        );
      })}
    </>
  );
}
