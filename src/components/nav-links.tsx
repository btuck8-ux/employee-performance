"use client";
import * as React from "react";
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
  SlidersHorizontal,
  UserPlus,
  UserCog,
  ChevronDown,
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
  scoring: SlidersHorizontal,
  settings: Settings,
  triage: UserPlus,
  users: UserCog,
};

export interface NavLinkItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  /** Present = collapsible group (the Settings parent, 2026-08-23 §4-D1). */
  children?: NavLinkItem[];
}

function isActive(pathname: string, href: string): boolean {
  return href === "/dashboard"
    ? pathname === "/dashboard"
    : pathname === href || pathname.startsWith(`${href}/`);
}

function LeafLink({
  item,
  pathname,
  nested = false,
}: {
  item: NavLinkItem;
  pathname: string;
  nested?: boolean;
}) {
  const Icon = ICONS[item.icon] ?? LayoutDashboard;
  const active = isActive(pathname, item.href);
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
        nested && "ml-4",
        active
          ? "bg-ikes-purple text-white font-medium"
          : "text-slate-700 hover:bg-ikes-green/10 hover:text-ikes-green-dark"
      )}
    >
      <Icon className="h-4 w-4" />
      {item.label}
    </Link>
  );
}

function NavGroup({
  item,
  pathname,
}: {
  item: NavLinkItem;
  pathname: string;
}) {
  const children = item.children ?? [];
  const inGroup =
    isActive(pathname, item.href) ||
    children.some((c) => isActive(pathname, c.href));
  const [open, setOpen] = React.useState(inGroup);
  // Landing inside the group (e.g. via the Employees-page triage chip) must
  // reveal the children even if the group was collapsed earlier.
  React.useEffect(() => {
    if (inGroup) setOpen(true);
  }, [inGroup]);
  const Icon = ICONS[item.icon] ?? Settings;
  return (
    <div>
      <div
        className={cn(
          "flex items-center rounded-md text-sm transition-colors",
          inGroup && !children.some((c) => isActive(pathname, c.href))
            ? "bg-ikes-purple text-white font-medium"
            : "text-slate-700 hover:bg-ikes-green/10 hover:text-ikes-green-dark"
        )}
      >
        <Link
          href={item.href}
          className="flex items-center gap-3 px-3 py-2 flex-1"
        >
          <Icon className="h-4 w-4" />
          {item.label}
        </Link>
        <button
          type="button"
          aria-label={open ? `Collapse ${item.label}` : `Expand ${item.label}`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="px-2 py-2"
        >
          <ChevronDown
            className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
          />
        </button>
      </div>
      {open && (
        <div className="mt-0.5 space-y-0.5">
          {children.map((c) => (
            <LeafLink key={c.href} item={c} pathname={pathname} nested />
          ))}
        </div>
      )}
    </div>
  );
}

export function NavLinks({ items }: { items: NavLinkItem[] }) {
  const pathname = usePathname();
  return (
    <>
      {items.map((item) =>
        item.children && item.children.length > 0 ? (
          <NavGroup key={item.href} item={item} pathname={pathname} />
        ) : (
          <LeafLink key={item.href} item={item} pathname={pathname} />
        )
      )}
    </>
  );
}
