"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  TimeWindowPicker,
  type QuarterOption,
  type TimeWindow,
} from "@/components/teams/TimeWindowPicker";
import {
  classifyTotalImpactScore,
  formatTotalImpactScore,
  toneForTotalImpactScore,
  TIS_ELIGIBILITY_MIN_HOURS,
} from "@/lib/total-impact-score";
import { Badge } from "@/components/ui/badge";
import {
  fetchRankingsAction,
  type RankingRow,
  type RankingScope,
} from "./fetch-rankings-actions";

interface Props {
  locationId: string;
  locationName: string;
  clientId: string;
  clientName: string;
  quarters: QuarterOption[];
  earliestDate: string | null;
  latestDate: string;
  initialWindow: TimeWindow;
  initialScope: RankingScope;
  initialRows: RankingRow[];
}

type SortKey =
  | "scope_rank"
  | "employee_name"
  | "location_name"
  | "total_impact_score"
  | "location_rank"
  | "client_rank"
  | "platform_rank"
  | "components_count";
type SortDir = "asc" | "desc";

export function RankingsView({
  locationId,
  locationName,
  clientId,
  clientName,
  quarters,
  earliestDate,
  latestDate,
  initialWindow,
  initialScope,
  initialRows,
}: Props) {
  const [window, setWindow] = useState<TimeWindow>(initialWindow);
  const [scope, setScope] = useState<RankingScope>(initialScope);
  const [showIneligible, setShowIneligible] = useState(false);
  const [rows, setRows] = useState<RankingRow[]>(initialRows);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("scope_rank");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const requestKey = useMemo(
    () =>
      `${window.mode}|${window.startDate}|${window.endDate}|${window.quarterId ?? ""}|${scope}`,
    [window, scope]
  );
  const initialKey = useMemo(
    () =>
      `${initialWindow.mode}|${initialWindow.startDate}|${initialWindow.endDate}|${initialWindow.quarterId ?? ""}|${initialScope}`,
    [initialWindow, initialScope]
  );

  useEffect(() => {
    if (requestKey === initialKey) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    const scopeId =
      scope === "location"
        ? locationId
        : scope === "client"
          ? clientId
          : null;
    fetchRankingsAction({
      mode: window.mode,
      scope,
      scope_id: scopeId,
      start_date: window.startDate,
      end_date: window.endDate,
      quarter_id: window.quarterId,
    })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setRows(res.rows);
        else setError(res.error);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, initialKey, scope, window, locationId, clientId]);

  const sorted = useMemo(() => {
    const filtered = showIneligible ? rows : rows.filter((r) => r.eligible);
    const cmp = (a: RankingRow, b: RankingRow): number => {
      const dir = sortDir === "asc" ? 1 : -1;
      const safe = (n: number | null | undefined) =>
        n === null || n === undefined ? Number.POSITIVE_INFINITY : n;
      switch (sortKey) {
        case "scope_rank":
          return (safe(a.scope_rank) - safe(b.scope_rank)) * dir;
        case "location_rank":
          return (safe(a.location_rank) - safe(b.location_rank)) * dir;
        case "client_rank":
          return (safe(a.client_rank) - safe(b.client_rank)) * dir;
        case "platform_rank":
          return (safe(a.platform_rank) - safe(b.platform_rank)) * dir;
        case "total_impact_score":
          return (
            ((a.total_impact_score ?? -Infinity) - (b.total_impact_score ?? -Infinity)) *
            dir
          );
        case "components_count":
          return (a.components_count - b.components_count) * dir;
        case "employee_name":
          return a.employee_name.localeCompare(b.employee_name) * dir;
        case "location_name":
          return a.location_name.localeCompare(b.location_name) * dir;
      }
    };
    // Ineligible employees always render at the bottom (greyed) regardless of
    // sort direction — spec requires they don't intermix with the ranked pool.
    const elig = filtered.filter((r) => r.eligible);
    const inelig = filtered.filter((r) => !r.eligible);
    return [...elig.sort(cmp), ...inelig.sort(cmp)];
  }, [rows, sortKey, sortDir, showIneligible]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(
        key === "scope_rank" ||
          key === "location_rank" ||
          key === "client_rank" ||
          key === "platform_rank"
          ? "asc"
          : "desc"
      );
    }
  };

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  const scopeLabel =
    scope === "location"
      ? `this location · ${locationName}`
      : scope === "client"
        ? `this client · ${clientName}`
        : "all clients";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <TimeWindowPicker
          quarters={quarters}
          earliestDate={earliestDate}
          latestDate={latestDate}
          value={window}
          onChange={setWindow}
        />
        <label className="flex items-center gap-1.5 text-xs">
          <span className="uppercase tracking-wide text-slate-500">Scope</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as RankingScope)}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs"
          >
            <option value="location">This location</option>
            <option value="client">This client</option>
            <option value="platform">All clients</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={showIneligible}
            onChange={(e) => setShowIneligible(e.target.checked)}
            className="h-4 w-4"
          />
          Show ineligible
        </label>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {error}
        </div>
      )}

      <p className="text-xs text-slate-500">
        Ranking <strong>{scopeLabel}</strong> over{" "}
        <strong>{window.label}</strong>
        {loading && <span className="ml-2 italic">Loading…</span>}
        {!loading && (
          <>
            {" "}
            · {sorted.filter((r) => r.eligible).length} eligible
            {showIneligible && (
              <>, {sorted.filter((r) => !r.eligible).length} ineligible</>
            )}
          </>
        )}
      </p>

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <Th onClick={() => toggleSort("scope_rank")}>Rank{sortArrow("scope_rank")}</Th>
              <Th onClick={() => toggleSort("employee_name")}>Employee{sortArrow("employee_name")}</Th>
              {scope !== "location" && (
                <Th onClick={() => toggleSort("location_name")}>Location{sortArrow("location_name")}</Th>
              )}
              <Th onClick={() => toggleSort("total_impact_score")} align="right">TIS{sortArrow("total_impact_score")}</Th>
              <Th onClick={() => toggleSort("location_rank")} align="right">Loc rank{sortArrow("location_rank")}</Th>
              <Th onClick={() => toggleSort("client_rank")} align="right">Client rank{sortArrow("client_rank")}</Th>
              <Th onClick={() => toggleSort("platform_rank")} align="right">Platform rank{sortArrow("platform_rank")}</Th>
              <Th onClick={() => toggleSort("components_count")} align="right">Components{sortArrow("components_count")}</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={scope === "location" ? 7 : 8} className="px-3 py-6 text-center text-slate-500">
                  No employees to rank in this scope &amp; range.
                </td>
              </tr>
            ) : (
              sorted.map((r) => {
                const tone = toneForTotalImpactScore(r.total_impact_score);
                const label = classifyTotalImpactScore(r.total_impact_score);
                return (
                  <tr
                    key={r.employee_id}
                    className={`border-b border-slate-100 last:border-b-0 hover:bg-slate-50 ${
                      r.eligible ? "" : "opacity-60"
                    }`}
                  >
                    <td className="px-3 py-2 font-semibold tabular-nums">
                      {r.eligible && r.scope_rank !== null ? r.scope_rank : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/dashboard/employees/${r.employee_id}`}
                        className="font-medium hover:underline"
                      >
                        {r.employee_name}
                      </Link>
                      {!r.eligible && (
                        <p className="text-xs text-amber-700">
                          Not eligible ({Math.round(r.all_time_hours_worked)} /{" "}
                          {TIS_ELIGIBILITY_MIN_HOURS} hrs)
                        </p>
                      )}
                      {!r.active && (
                        <p className="text-xs text-slate-500">Inactive</p>
                      )}
                    </td>
                    {scope !== "location" && (
                      <td className="px-3 py-2 text-slate-700">{r.location_name}</td>
                    )}
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center justify-end gap-2">
                        <span className="tabular-nums font-medium">
                          {formatTotalImpactScore(r.total_impact_score)}
                        </span>
                        {label && (
                          <Badge
                            tone={
                              label === "Exceeds Expectations"
                                ? "exceeds"
                                : label === "Meets Expectations"
                                  ? "meets"
                                  : "below"
                            }
                          >
                            {tone === "green" ? "G" : tone === "yellow" ? "Y" : "R"}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.eligible && r.location_rank !== null
                        ? `${r.location_rank} of ${r.location_total}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.eligible && r.client_rank !== null
                        ? `${r.client_rank} of ${r.client_total}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.eligible && r.platform_rank !== null
                        ? `${r.platform_rank} of ${r.platform_total}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.components_count} / 5
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({
  children,
  onClick,
  align,
}: {
  children: React.ReactNode;
  onClick: () => void;
  align?: "right";
}) {
  return (
    <th
      onClick={onClick}
      className={`cursor-pointer select-none px-3 py-2 ${
        align === "right" ? "text-right" : ""
      } hover:bg-slate-100`}
    >
      {children}
    </th>
  );
}
