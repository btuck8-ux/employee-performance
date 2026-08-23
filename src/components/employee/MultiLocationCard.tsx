"use client";
import * as React from "react";
import Link from "next/link";
import {
  combineQuarterMetrics,
  type LocationQuarterMetrics,
} from "@/lib/multi-location-metrics";

/**
 * Multi-location performance card (2026-08-23 sprint §4-B). Rendered ONLY on
 * profiles of people holding roster rows at 2+ sites — single-location
 * profiles never see it (§4-B1). Client component: the location checkboxes
 * recombine the server-assembled per-location parts locally via the same
 * pure combineQuarterMetrics the tests pin — no averaging path exists here.
 * Props are plain serializable values; all queries stayed server-side.
 */

export interface MultiLocationCardProps {
  currentEmployeeId: string;
  siblings: Array<{
    employeeId: string;
    employeeCode: string;
    locationId: string;
    locationName: string;
  }>;
  quarters: Array<{ id: string; label: string }>;
  perLocationQuarter: LocationQuarterMetrics[];
}

function fmtPct(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1)}%`;
}

function fmtRating(v: number | null): string {
  return v === null ? "—" : v.toFixed(2);
}

export function MultiLocationCard({
  currentEmployeeId,
  siblings,
  quarters,
  perLocationQuarter,
}: MultiLocationCardProps) {
  const [checked, setChecked] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(siblings.map((s) => [s.employeeId, true]))
  );
  const selectedIds = siblings
    .filter((s) => checked[s.employeeId])
    .map((s) => s.employeeId);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">
            Multi-location performance
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            This person works at {siblings.length} sites. Rates below are
            recomputed from combined counts — never averaged across sites.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {siblings.map((s) =>
            s.employeeId === currentEmployeeId ? (
              <span
                key={s.employeeId}
                className="rounded-full bg-slate-900 text-white px-3 py-1"
              >
                {s.locationName} ({s.employeeCode})
              </span>
            ) : (
              <Link
                key={s.employeeId}
                href={`/dashboard/employees/${s.employeeId}`}
                className="rounded-full border border-slate-300 px-3 py-1 text-slate-700 hover:bg-slate-50"
              >
                {s.locationName} ({s.employeeCode}) →
              </Link>
            )
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="text-slate-500">Combine:</span>
        {siblings.map((s) => (
          <label key={s.employeeId} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={checked[s.employeeId] ?? false}
              onChange={(e) =>
                setChecked((prev) => ({
                  ...prev,
                  [s.employeeId]: e.target.checked,
                }))
              }
            />
            {s.locationName}
          </label>
        ))}
      </div>

      {selectedIds.length === 0 ? (
        <p className="text-sm text-slate-500">
          Pick at least one site to combine.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3 font-medium">Quarter</th>
                <th className="py-2 pr-3 font-medium">Attendance</th>
                <th className="py-2 pr-3 font-medium">On-time</th>
                <th className="py-2 pr-3 font-medium">On-time (grace)</th>
                <th className="py-2 pr-3 font-medium">Survey eng.</th>
                <th className="py-2 pr-3 font-medium" title="Available per-location only — the per-list count behind this mean isn't stored, so a combined value would be a different metric wearing the same label.">
                  Task lists*
                </th>
                <th className="py-2 pr-3 font-medium">CS rating</th>
                <th className="py-2 pr-3 font-medium">Tattle</th>
                <th className="py-2 pr-3 font-medium">Food</th>
                <th className="py-2 pr-3 font-medium">Accuracy</th>
                <th className="py-2 pr-3 font-medium">Speed</th>
              </tr>
            </thead>
            <tbody>
              {quarters.map((q) => {
                const subset = perLocationQuarter.filter(
                  (p) =>
                    p.quarterId === q.id && selectedIds.includes(p.employeeId)
                );
                const c = combineQuarterMetrics(subset);
                return (
                  <tr key={q.id} className="border-b border-slate-100">
                    <td className="py-2 pr-3 font-medium">{q.label}</td>
                    <td className="py-2 pr-3 tabular-nums">
                      {fmtPct(c.attendance_pct)}
                      {c.scheduled_count > 0 && (
                        <span className="text-xs text-slate-400">
                          {" "}
                          ({c.attended_count}/{c.scheduled_count})
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {fmtPct(c.on_time_pct)}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {fmtPct(c.on_time_grace_pct)}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {fmtPct(c.survey_engagement_pct)}
                      {c.surveys_assigned > 0 && (
                        <span className="text-xs text-slate-400">
                          {" "}
                          ({c.surveys_completed}/{c.surveys_assigned})
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-slate-400">—</td>
                    <td className="py-2 pr-3 tabular-nums">
                      {fmtRating(c.customer_service_rating)}
                      {c.customer_review_quantity > 0 && (
                        <span className="text-xs text-slate-400">
                          {" "}
                          (n={c.customer_review_quantity})
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {fmtRating(c.tattle_rating)}
                      {c.tattle_quantity > 0 && (
                        <span className="text-xs text-slate-400">
                          {" "}
                          (n={c.tattle_quantity})
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {fmtRating(c.tattle_score_food_quality)}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {fmtRating(c.tattle_score_accuracy)}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {fmtRating(c.tattle_score_speed_of_service)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs text-slate-400 mt-2">
            * Task-list completion is available per-location only — its
            per-list mean can&apos;t be combined from stored data without
            becoming a different metric.
          </p>
        </div>
      )}
    </div>
  );
}
