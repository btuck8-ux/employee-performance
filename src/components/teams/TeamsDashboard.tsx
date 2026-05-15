"use client";
import { useRouter } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmployeeScatter, type ScatterRow } from "./EmployeeScatter";
import { TeamLeaderboard, type TeamRow } from "./TeamLeaderboard";
import { PairHeatmap } from "./PairHeatmap";

export interface Quarter {
  id: string;
  label: string;
  period_start: string;
}

interface TeamsDashboardProps {
  quarters: Quarter[];
  selectedQuarterId: string | null;
  locationId: string;
  employees: Array<{ id: string; employee_name: string }>;
  scatterRows: ScatterRow[];
  teams: TeamRow[];
}

export function TeamsDashboard({
  quarters,
  selectedQuarterId,
  locationId,
  employees,
  scatterRows,
  teams,
}: TeamsDashboardProps) {
  const router = useRouter();

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
          <TabsTrigger value="leaderboard">Team leaderboard</TabsTrigger>
          <TabsTrigger value="heatmap">Pair heatmap</TabsTrigger>
        </TabsList>

        <TabsContent value="scatter">
          <EmployeeScatter rows={scatterRows} />
        </TabsContent>

        <TabsContent value="leaderboard">
          <TeamLeaderboard teams={teams} />
        </TabsContent>

        <TabsContent value="heatmap">
          <PairHeatmap teams={teams} employees={employees} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
