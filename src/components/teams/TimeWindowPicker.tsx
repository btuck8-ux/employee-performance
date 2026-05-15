"use client";
import { useState } from "react";

export type TimeWindowMode = "quarter" | "all_time" | "custom";

export interface TimeWindow {
  mode: TimeWindowMode;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  label: string;
  /** When mode === "quarter", the selected period's id (useful as a cache key) */
  quarterId?: string;
}

export interface QuarterOption {
  id: string;
  label: string;
  period_start: string;
  period_end: string;
}

interface TimeWindowPickerProps {
  quarters: QuarterOption[];
  /** Earliest date with data at the location (used for All time mode). */
  earliestDate: string | null;
  /** Latest date with data at the location (used for All time mode); defaults to today. */
  latestDate?: string | null;
  value: TimeWindow;
  onChange: (next: TimeWindow) => void;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

export function resolveQuarterWindow(q: QuarterOption): TimeWindow {
  return {
    mode: "quarter",
    startDate: q.period_start,
    endDate: q.period_end,
    label: q.label,
    quarterId: q.id,
  };
}

export function resolveAllTimeWindow(
  earliestDate: string | null,
  latestDate: string | null
): TimeWindow {
  const start = earliestDate ?? todayIso();
  const end = latestDate ?? todayIso();
  return {
    mode: "all_time",
    startDate: start,
    endDate: end,
    label: "All time",
  };
}

export function resolveCustomWindow(start: string, end: string): TimeWindow {
  return {
    mode: "custom",
    startDate: start,
    endDate: end,
    label: `${start} → ${end}`,
  };
}

export function TimeWindowPicker({
  quarters,
  earliestDate,
  latestDate,
  value,
  onChange,
}: TimeWindowPickerProps) {
  // Local state for the custom range inputs — only commits via Apply button.
  // Initial values seed from the parent's current window so the picker feels
  // pre-populated when the user first switches to Custom mode. The picker is
  // the sole writer of the custom range (no external control updates it
  // mid-session), so no sync-from-prop effect is needed.
  const [customStart, setCustomStart] = useState(value.startDate);
  const [customEnd, setCustomEnd] = useState(value.endDate);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="uppercase tracking-wide text-slate-500">Mode</span>
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden">
          {(
            [
              { v: "quarter", label: "Quarter" },
              { v: "all_time", label: "All time" },
              { v: "custom", label: "Custom range" },
            ] as Array<{ v: TimeWindowMode; label: string }>
          ).map((opt) => {
            const active = value.mode === opt.v;
            return (
              <button
                key={opt.v}
                type="button"
                onClick={() => {
                  if (opt.v === "quarter") {
                    const q = quarters[0];
                    if (q) onChange(resolveQuarterWindow(q));
                  } else if (opt.v === "all_time") {
                    onChange(
                      resolveAllTimeWindow(
                        earliestDate,
                        latestDate ?? todayIso()
                      )
                    );
                  } else {
                    onChange(resolveCustomWindow(customStart, customEnd));
                  }
                }}
                className={
                  "px-3 py-1.5 text-xs transition-colors " +
                  (active
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-700 hover:bg-slate-50")
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {value.mode === "quarter" && quarters.length > 0 && (
        <label className="flex items-center gap-1.5 text-xs">
          <span className="uppercase tracking-wide text-slate-500">Quarter</span>
          <select
            value={value.quarterId ?? ""}
            onChange={(e) => {
              const q = quarters.find((x) => x.id === e.target.value);
              if (q) onChange(resolveQuarterWindow(q));
            }}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs"
          >
            {quarters.map((q) => (
              <option key={q.id} value={q.id}>
                {q.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {value.mode === "all_time" && (
        <span className="text-xs text-slate-500">
          {earliestDate ?? "—"} → {latestDate ?? todayIso()}
        </span>
      )}

      {value.mode === "custom" && (
        <div className="flex items-center gap-1.5 text-xs">
          <input
            type="date"
            value={customStart}
            onChange={(e) => setCustomStart(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs"
          />
          <span className="text-slate-500">→</span>
          <input
            type="date"
            value={customEnd}
            onChange={(e) => setCustomEnd(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs"
          />
          <button
            type="button"
            onClick={() => onChange(resolveCustomWindow(customStart, customEnd))}
            disabled={
              !customStart ||
              !customEnd ||
              customStart > customEnd ||
              (customStart === value.startDate && customEnd === value.endDate)
            }
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
