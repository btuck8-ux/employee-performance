import * as React from "react";
import { cn } from "@/lib/utils";
import type { ExpectationLabel } from "@/lib/types";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: "default" | "exceeds" | "meets" | "below" | "muted";
}

const TONES: Record<NonNullable<BadgeProps["tone"]>, string> = {
  default: "bg-slate-100 text-slate-800",
  exceeds: "bg-[#CCFFCC] text-black",
  meets: "bg-[#FFF2CC] text-black",
  below: "bg-[#F4CCCC] text-black",
  muted: "bg-slate-100 text-slate-500",
};

export function Badge({ className, tone = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        TONES[tone],
        className
      )}
      {...props}
    />
  );
}

export function ExpectationBadge({ label }: { label: ExpectationLabel | null }) {
  if (!label) return <span className="text-slate-400">—</span>;
  const tone =
    label === "Exceeds Expectations"
      ? "exceeds"
      : label === "Meets Expectations"
      ? "meets"
      : "below";
  return <Badge tone={tone}>{label}</Badge>;
}
