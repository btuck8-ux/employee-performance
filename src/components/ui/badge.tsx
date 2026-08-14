import * as React from "react";
import { cn } from "@/lib/utils";
import type { ExpectationLabel, TargetLabel } from "@/lib/types";

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

/**
 * Renders both label families: the three-tier ExpectationLabel (composites,
 * kitchen/tip badges) and the two-tier TargetLabel of the nine target-driven
 * metrics (2026-08-14 sprint). Band colors keep their semantic values —
 * On Target shares green with Exceeds, Below Target shares red with Below.
 */
export function ExpectationBadge({
  label,
}: {
  label: ExpectationLabel | TargetLabel | null;
}) {
  if (!label) return <span className="text-slate-400">—</span>;
  const tone =
    label === "Exceeds Expectations" || label === "On Target"
      ? "exceeds"
      : label === "Meets Expectations"
      ? "meets"
      : "below";
  return <Badge tone={tone}>{label}</Badge>;
}
