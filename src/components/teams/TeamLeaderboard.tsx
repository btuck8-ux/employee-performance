"use client";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  formatDeltaPP,
  formatMoney,
  formatPercent,
} from "@/lib/format";
import { CohortTimelineModal } from "./CohortTimelineModal";

export interface TeamRow {
  memberIds: string[];
  memberNames: string[];
  memberCount: number;
  hoursTogether: number;
  salesDuring: number;
  tipsDuring: number;
  tipRatePct: number | null;
  deltaVsLocPp: number | null;
}

interface TeamLeaderboardProps {
  teams: TeamRow[];
  locationId: string;
  windowStart: string | null;
  windowEnd: string | null;
  windowLabel: string;
}

/** Default ranking: hours_together × |delta_pp|. Teams without delta sink. */
function impactScore(t: TeamRow): number {
  if (t.deltaVsLocPp === null) return 0;
  return t.hoursTogether * Math.abs(t.deltaVsLocPp);
}

type SortKey = "impact" | "hours" | "delta_desc" | "delta_asc" | "rate";

export function TeamLeaderboard({
  teams,
  locationId,
  windowStart,
  windowEnd,
  windowLabel,
}: TeamLeaderboardProps) {
  const [sort, setSort] = useState<SortKey>("impact");
  const [sizeFilter, setSizeFilter] = useState<number | "all">("all");
  const [selectedTeam, setSelectedTeam] = useState<TeamRow | null>(null);
  const drilldownAvailable = Boolean(windowStart && windowEnd);

  const filtered = useMemo(() => {
    const list =
      sizeFilter === "all"
        ? teams.slice()
        : teams.filter((t) => t.memberCount === sizeFilter);

    list.sort((a, b) => {
      switch (sort) {
        case "impact":
          return impactScore(b) - impactScore(a);
        case "hours":
          return b.hoursTogether - a.hoursTogether;
        case "delta_desc":
          return (b.deltaVsLocPp ?? -Infinity) - (a.deltaVsLocPp ?? -Infinity);
        case "delta_asc":
          return (a.deltaVsLocPp ?? Infinity) - (b.deltaVsLocPp ?? Infinity);
        case "rate":
          return (b.tipRatePct ?? -Infinity) - (a.tipRatePct ?? -Infinity);
        default:
          return 0;
      }
    });
    return list.slice(0, 20);
  }, [teams, sort, sizeFilter]);

  if (teams.length === 0) {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-8 text-sm text-slate-500">
        No co-presence cohorts for this quarter. This usually means POS data
        hasn&apos;t been ingested yet — upload sales CSV on the location page.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <p className="text-sm text-slate-700">
          Top 20 teams by impact (hours together × magnitude of tip-rate delta
          vs the location average). Same group across many shifts rolls up into
          one row.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <span className="uppercase tracking-wide">Sort</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs"
            >
              <option value="impact">Impact score</option>
              <option value="hours">Most hours together</option>
              <option value="delta_desc">Biggest lifters (Δ ↑)</option>
              <option value="delta_asc">Biggest draggers (Δ ↓)</option>
              <option value="rate">Highest tip rate</option>
            </select>
          </label>
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <span className="uppercase tracking-wide">Size</span>
            <select
              value={sizeFilter}
              onChange={(e) => {
                const v = e.target.value;
                setSizeFilter(v === "all" ? "all" : Number(v));
              }}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs"
            >
              <option value="all">Any</option>
              <option value="1">Solo</option>
              <option value="2">Pairs</option>
              <option value="3">Trios</option>
              <option value="4">Quads</option>
              <option value="5">5+ (peak)</option>
            </select>
          </label>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500 uppercase border-b border-slate-200">
            <tr>
              <th className="py-2 pr-3 w-8">#</th>
              <th className="py-2 pr-4">Members</th>
              <th className="py-2 pr-4 text-right">Size</th>
              <th className="py-2 pr-4 text-right">Hours</th>
              <th className="py-2 pr-4 text-right">Sales</th>
              <th className="py-2 pr-4 text-right">Tip rate</th>
              <th className="py-2 pr-4 text-right">Δ vs loc</th>
              <th className="py-2 pr-4 text-right">Impact</th>
              {drilldownAvailable && <th className="py-2 pl-2 w-20" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((t, idx) => {
              const tone =
                t.deltaVsLocPp === null
                  ? null
                  : t.deltaVsLocPp > 0.25
                    ? "exceeds"
                    : t.deltaVsLocPp < -0.25
                      ? "below"
                      : "meets";
              const arrow =
                tone === "exceeds" ? "↑" : tone === "below" ? "↓" : tone === "meets" ? "→" : "—";
              const clickable = drilldownAvailable;
              return (
                <tr
                  key={t.memberIds.join("|")}
                  className={
                    clickable ? "cursor-pointer hover:bg-slate-50/80 transition-colors" : undefined
                  }
                  onClick={() => clickable && setSelectedTeam(t)}
                >
                  <td className="py-2 pr-3 text-xs text-slate-500 tabular-nums">
                    {idx + 1}
                  </td>
                  <td className="py-2 pr-4">
                    <div className="flex flex-wrap gap-x-2 gap-y-1">
                      {t.memberNames.map((n) => (
                        <span
                          key={n}
                          className="inline-block rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                        >
                          {n}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {t.memberCount}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {t.hoursTogether.toFixed(1)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatMoney(t.salesDuring)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatPercent(t.tipRatePct)}
                  </td>
                  <td className="py-2 pr-4 text-right">
                    {tone ? (
                      <Badge tone={tone}>
                        <span aria-hidden>{arrow}</span>
                        <span className="ml-1 tabular-nums">
                          {formatDeltaPP(t.deltaVsLocPp)}
                        </span>
                      </Badge>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-xs text-slate-600">
                    {impactScore(t).toFixed(1)}
                  </td>
                  {drilldownAvailable && (
                    <td className="py-2 pl-2 text-right">
                      <span
                        className="text-xs text-slate-500 group-hover:text-slate-900"
                        aria-label="View timeline"
                      >
                        Timeline →
                      </span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <p className="text-sm text-slate-500">
          No cohorts match the current filter. Try widening the size filter.
        </p>
      )}

      {drilldownAvailable && selectedTeam && windowStart && windowEnd && (
        <CohortTimelineModal
          open
          onClose={() => setSelectedTeam(null)}
          memberIds={selectedTeam.memberIds}
          memberNames={selectedTeam.memberNames}
          locationId={locationId}
          startDate={windowStart}
          endDate={windowEnd}
          windowLabel={windowLabel}
          summary={{
            hoursTogether: selectedTeam.hoursTogether,
            salesDuring: selectedTeam.salesDuring,
            tipRatePct: selectedTeam.tipRatePct,
            deltaVsLocPp: selectedTeam.deltaVsLocPp,
          }}
        />
      )}
    </div>
  );
}
