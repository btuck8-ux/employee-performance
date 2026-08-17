import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
// Server-safe module — importing these helpers from TimeWindowPicker (a
// "use client" file) makes them client references and calling one during the
// server render throws, killing the whole profile to an error/404 (Next 16).
import {
  resolveAllTimeWindow,
  resolveQuarterWindow,
  type QuarterOption,
  type TimeWindow,
} from "@/components/teams/time-window";
import { fetchRankingsAction, type RankingRow } from "./fetch-rankings-actions";
import { RankingsView } from "./RankingsView";

// Non-quarter ranges fan out a per-employee compute pool (concurrency 6) for
// every active employee in scope. At platform scale this can run long. Lift
// the page-level timeout to the 300s ceiling used by other heavy paths.
export const maxDuration = 300;

export default async function LocationRankingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: location } = await supabase
    .from("locations")
    .select("id, name, clients(id, name)")
    .eq("id", id)
    .single();
  if (!location) notFound();
  const client = location.clients as unknown as { id: string; name: string } | null;
  if (!client) notFound();

  // Quarters that have any performance_records at this location. Default
  // scope is "this location" so we pick from these. If empty, fall back to
  // an all-time window anchored at the location's earliest worked entry.
  const { data: periodRows } = await supabase
    .from("performance_records")
    .select("report_periods!inner(id, label, period_start, period_end)")
    .eq("location_id", id);
  type PeriodRowShape = {
    report_periods: QuarterOption | null;
  };
  const seen = new Map<string, QuarterOption>();
  for (const row of (periodRows ?? []) as unknown as PeriodRowShape[]) {
    if (row.report_periods) seen.set(row.report_periods.id, row.report_periods);
  }
  const quarters = Array.from(seen.values()).sort((a, b) =>
    b.period_start.localeCompare(a.period_start)
  );

  const todayDate = new Date().toISOString().slice(0, 10);
  const { data: earliest } = await supabase
    .from("time_entries")
    .select("entry_date")
    .eq("location_id", id)
    .order("entry_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  const earliestDate = (earliest?.entry_date as string | undefined) ?? null;

  let initialWindow: TimeWindow;
  if (quarters.length > 0) {
    initialWindow = resolveQuarterWindow(quarters[0]);
  } else {
    initialWindow = resolveAllTimeWindow(earliestDate, todayDate);
  }

  let initialRows: RankingRow[] = [];
  if (initialWindow.mode === "quarter" && initialWindow.quarterId) {
    const res = await fetchRankingsAction({
      mode: "quarter",
      scope: "location",
      scope_id: id,
      start_date: initialWindow.startDate,
      end_date: initialWindow.endDate,
      quarter_id: initialWindow.quarterId,
    });
    if (res.ok) initialRows = res.rows;
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-slate-500">
          <Link href={`/dashboard/locations/${id}`} className="hover:underline">
            ← {location.name}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">
          Total Impact Score rankings
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          On-demand ranking of employees by Total Impact Score. Switch scope
          to compare within this location, this client, or the full platform.
          Quarter is the default range; pick all-time or custom for ad-hoc
          windows. Ranks are competition-style (ties share a position, next
          slot skips).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Rankings</CardTitle>
        </CardHeader>
        <CardContent>
          <RankingsView
            locationId={id}
            locationName={location.name as string}
            clientId={client.id}
            clientName={client.name}
            quarters={quarters}
            earliestDate={earliestDate}
            latestDate={todayDate}
            initialWindow={initialWindow}
            initialScope="location"
            initialRows={initialRows}
          />
        </CardContent>
      </Card>
    </div>
  );
}
