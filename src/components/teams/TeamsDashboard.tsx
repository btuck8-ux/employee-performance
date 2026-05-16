"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmployeeScatter, type ScatterRow } from "./EmployeeScatter";
import { TeamLeaderboard, type TeamRow } from "./TeamLeaderboard";
import { PairHeatmap } from "./PairHeatmap";
import { HourlyTipRateView } from "./HourlyTipRateView";
import { EmployeeDeltaBar } from "./EmployeeDeltaBar";
import { resolveQuarterWindow, resolveAllTimeWindow } from "./TimeWindowPicker";

export interface Quarter {
  id: string;
  label: string;
  period_start: string;
  period_end: string;
}

interface TeamsDashboardProps {
  quarters: Quarter[];
  selectedQuarterId: string | null;
  locationId: string;
  employees: Array<{ id: string; employee_name: string }>;
  scatterRows: ScatterRow[];
  teams: TeamRow[];
  earliestSalesDate: string | null;
  latestSalesDate: string | null;
}

export function TeamsDashboard({
  quarters,
  selectedQuarterId,
  locationId,
  employees,
  scatterRows,
  teams,
  earliestSalesDate,
  latestSalesDate,
}: TeamsDashboardProps) {
  const router = useRouter();

  // Hourly tab state: selected employee. Empty string = nobody selected yet
  // (default state, user prompted to pick one).
  const [hourlyEmployeeId, setHourlyEmployeeId] = useState<string>("");
  const hourlyEmployee = employees.find((e) => e.id === hourlyEmployeeId) ?? null;
  const selectedQuarter = quarters.find((q) => q.id === selectedQuarterId) ?? null;
  // Default the Hourly tab's time window to the currently-selected quarter
  // for context consistency with the rest of the dashboard.
  const hourlyInitialWindow = selectedQuarter
    ? resolveQuarterWindow(selectedQuarter)
    : earliestSalesDate
      ? resolveAllTimeWindow(earliestSalesDate, latestSalesDate)
      : null;

  const lifters = teams.filter(
    (t) => t.deltaVsLocPp !== null && t.deltaVsLocPp > 0.25
  ).length;
  const draggers = teams.filter(
    (t) => t.deltaVsLocPp !== null && t.deltaVsLocPp < -0.25
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <span className="text-xs uppercase tracking-wide text-slate-500">
            Quarter
          </span>
          <select
            value={selectedQuarterId ?? ""}
            onChange={(e) =>
              router.push(
                `/dashboard/locations/${locationId}/teams?q=${encodeURIComponent(
                  e.target.value
                )}`
              )
            }
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm min-w-[160px]"
          >
            {quarters.map((q) => (
              <option key={q.id} value={q.id}>
                {q.label}
              </option>
            ))}
          </select>
        </label>
        <div className="text-xs text-slate-500 flex items-center gap-4 flex-wrap">
          <span>
            <strong className="text-slate-700">{teams.length}</strong> cohort
            {teams.length === 1 ? "" : "s"}
          </span>
          <span>
            <strong className="text-emerald-700">{lifters}</strong> lifter
            {lifters === 1 ? "" : "s"}
          </span>
          <span>
            <strong className="text-red-700">{draggers}</strong> dragger
            {draggers === 1 ? "" : "s"}
          </span>
          <span>
            <strong className="text-slate-700">{scatterRows.length}</strong>{" "}
            active employee{scatterRows.length === 1 ? "" : "s"} with tip data
          </span>
        </div>
      </div>

      <Tabs defaultValue="scatter" className="w-full">
        <TabsList>
          <TabsTrigger value="scatter">Employee scatter</TabsTrigger>
          <TabsTrigger value="ranking">Delta ranking</TabsTrigger>
          <TabsTrigger value="leaderboard">Team leaderboard</TabsTrigger>
          <TabsTrigger value="heatmap">Pair heatmap</TabsTrigger>
          <TabsTrigger value="hourly">Hourly tip rate</TabsTrigger>
        </TabsList>

        <TabsContent value="scatter">
          <EmployeeScatter rows={scatterRows} />
        </TabsContent>

        <TabsContent value="ranking">
          <EmployeeDeltaBar rows={scatterRows} />
        </TabsContent>

        <TabsContent value="leaderboard">
          <TeamLeaderboard
            teams={teams}
            locationId={locationId}
            windowStart={selectedQuarter?.period_start ?? null}
            windowEnd={selectedQuarter?.period_end ?? null}
            windowLabel={selectedQuarter?.label ?? "—"}
          />
        </TabsContent>

        <TabsContent value="heatmap">
          <PairHeatmap teams={teams} employees={employees} />
        </TabsContent>

        <TabsContent value="hourly">
          <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">
                  Employee
                </span>
                <select
                  value={hourlyEmployeeId}
                  onChange={(e) => setHourlyEmployeeId(e.target.value)}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm min-w-[200px]"
                >
                  <option value="">— Select an employee —</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.employee_name}
                    </option>
                  ))}
                </select>
              </label>
              {employees.length === 0 && (
                <span className="text-xs text-slate-500">
                  No active employees at this location.
                </span>
              )}
            </div>
            {hourlyEmployee && hourlyInitialWindow ? (
              <HourlyTipRateView
                // Forcing remount on employee change keeps the loaded-key
                // ref/state cleanly scoped per employee.
                key={hourlyEmployee.id}
                employeeId={hourlyEmployee.id}
                employeeName={hourlyEmployee.employee_name}
                locationId={locationId}
                initialRows={[]}
                initialWindow={hourlyInitialWindow}
                quarters={quarters}
                earliestDate={earliestSalesDate}
                latestDate={latestSalesDate}
              />
            ) : (
              <p className="text-sm text-slate-500">
                Pick an employee above to see their per-hour tip rate compared
                to the location average over the same window.
              </p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
