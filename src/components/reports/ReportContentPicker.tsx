"use client";
import { useState } from "react";
import { METRIC_GROUPS } from "@/lib/report-render-options";

/**
 * §5-B metric selection + §3 display toggles for the Reports builder.
 * Everything defaults ON — an untouched form generates today's full PDF
 * (render_options resolves to "no restriction"). Selection controls which
 * rows RENDER only; every metric is still computed and stored.
 *
 * Client module for the select-all/none convenience; the group list itself
 * comes from the server-safe shared module (rendering it here is fine — the
 * boundary rule forbids server pages CALLING client exports, not this).
 */
export function ReportContentPicker() {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(METRIC_GROUPS.map((g) => g.id))
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-slate-500">
          Report content (unchecked rows are left off the PDF — nothing is
          recomputed or deleted)
        </p>
        <button
          type="button"
          onClick={() => setSelected(new Set(METRIC_GROUPS.map((g) => g.id)))}
          className="text-xs text-slate-600 underline"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={() => setSelected(new Set())}
          className="text-xs text-slate-600 underline"
        >
          Select none
        </button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-1 rounded-md border border-slate-200 p-3">
        {METRIC_GROUPS.map((g) => (
          <label
            key={g.id}
            className="flex items-center gap-2 text-sm py-0.5 cursor-pointer"
          >
            <input
              type="checkbox"
              name="metrics"
              value={g.id}
              checked={selected.has(g.id)}
              onChange={() => toggle(g.id)}
              className="h-4 w-4 accent-[#702F8A]"
            />
            <span className="truncate">{g.label}</span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="include_reviews"
            value="1"
            defaultChecked
            className="h-4 w-4 accent-[#702F8A]"
          />
          Online Review rows
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="include_tattles"
            value="1"
            defaultChecked
            className="h-4 w-4 accent-[#702F8A]"
          />
          Tattle rows
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="include_manager_feedback"
            value="1"
            defaultChecked
            className="h-4 w-4 accent-[#702F8A]"
          />
          Manager feedback section
        </label>
        {/* §4-E: the 7tasks detail is a report type here, not a stray
            checkbox next to the period controls. Quarterly-only — the
            builder attaches it per employee when the period is a quarter. */}
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="include_task_detail"
            value="1"
            className="h-4 w-4 accent-[#702F8A]"
          />
          7Tasks detail report (quarterly only)
        </label>
      </div>
    </div>
  );
}
