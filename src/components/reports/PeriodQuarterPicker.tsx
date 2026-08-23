"use client";
import { useState } from "react";

/**
 * Period + Quarter selects for the Reports builder (2026-08-23 §4-F). The
 * two were independent uncontrolled selects, so a specific quarter showed
 * alongside a custom range and read as a bug. On "Custom range" the Quarter
 * select reads N/A and is DISABLED — a disabled select submits nothing,
 * report_period_id arrives as "" via builder-actions.ts's `?? ""` default,
 * and only the quarter branch ever requires it (verified §4-F; re-confirmed
 * with this change). Client component: the page stays a server component
 * and only renders this — never calls it (§8 boundary scar).
 */

export interface PeriodQuarterPickerProps {
  quarters: Array<{ id: string; label: string }>;
  defaultQuarterId: string;
}

export function PeriodQuarterPicker({
  quarters,
  defaultQuarterId,
}: PeriodQuarterPickerProps) {
  const [mode, setMode] = useState<"quarter" | "range">("quarter");
  const isRange = mode === "range";
  return (
    <>
      <div>
        <label className="block text-xs text-slate-500 mb-1">Period</label>
        <select
          name="period_mode"
          value={mode}
          onChange={(e) => setMode(e.target.value === "range" ? "range" : "quarter")}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        >
          <option value="quarter">Quarter</option>
          <option value="range">Custom range</option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-slate-500 mb-1">Quarter</label>
        {isRange ? (
          <select
            disabled
            aria-label="Quarter (not applicable for a custom range)"
            className="rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-400"
          >
            <option>N/A</option>
          </select>
        ) : (
          <select
            name="report_period_id"
            defaultValue={defaultQuarterId}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          >
            {quarters.map((q) => (
              <option key={q.id} value={q.id}>
                {q.label}
              </option>
            ))}
          </select>
        )}
      </div>
    </>
  );
}
