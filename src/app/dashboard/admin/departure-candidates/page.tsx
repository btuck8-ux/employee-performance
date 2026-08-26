import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  resolveDepartureCandidateAction,
  runDepartureSweepAction,
} from "./actions";

/**
 * §7c (epd_role spec 2026-08-26) — the departure-candidate queue: a
 * SURFACE, not just a table. The sweep (mig 072) only writes rows here;
 * a human dismisses or deactivates. Each open candidate shows days
 * dormant and EVERY associated store of the person (stores accumulate,
 * §7a — none is ever retired). Deactivate is person-level by design:
 * a departure is a person-level fact (§7b).
 *
 * SA-only, the triage-page pattern. Reads ride the admin client after the
 * gate — candidates reference people at every store, purview is total.
 */

export default async function DepartureCandidatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const { role } = await getSessionRole();
  if (role !== "system_admin") redirect("/dashboard");

  const admin = createAdminClient();

  type CandidateRow = {
    id: string;
    employee_id: string;
    detected_at: string;
    last_worked_at: string | null;
    last_scheduled_at: string | null;
    days_dormant: number;
    reason: string;
    employees: {
      id: string;
      employee_code: string;
      employee_name: string;
      seven_shifts_user_id: number | string | null;
      active: boolean;
      locations: { name: string } | null;
    } | null;
  };
  const { data: candidateData, error: candError } = await admin
    .from("departure_candidates")
    .select(
      "id, employee_id, detected_at, last_worked_at, last_scheduled_at, days_dormant, reason, employees(id, employee_code, employee_name, seven_shifts_user_id, active, locations(name))"
    )
    .eq("status", "open")
    .order("days_dormant", { ascending: false });
  if (candError) throw new Error(`candidate read: ${candError.message}`);
  const candidates = (candidateData ?? []) as unknown as CandidateRow[];

  // Every associated store of each surfaced person (§7a: accumulated, active
  // or not) — one batched lookup on seven_shifts_user_id.
  const personIds = [
    ...new Set(
      candidates
        .map((c) => c.employees?.seven_shifts_user_id)
        .filter((v): v is number | string => v !== null && v !== undefined)
        .map((v) => Number(v))
        .filter((v) => Number.isSafeInteger(v))
    ),
  ];
  const storesByPerson = new Map<number, { name: string; active: boolean }[]>();
  if (personIds.length > 0) {
    const { data: rows, error: storesError } = await admin
      .from("employees")
      .select("seven_shifts_user_id, active, locations(name)")
      .in("seven_shifts_user_id", personIds);
    if (storesError) throw new Error(`stores read: ${storesError.message}`);
    for (const r of (rows ?? []) as unknown as {
      seven_shifts_user_id: number | string;
      active: boolean;
      locations: { name: string } | null;
    }[]) {
      const key = Number(r.seven_shifts_user_id);
      storesByPerson.set(key, [
        ...(storesByPerson.get(key) ?? []),
        { name: r.locations?.name ?? "—", active: !!r.active },
      ]);
    }
  }

  const str = (v: string | string[] | undefined): string | null =>
    typeof v === "string" && v ? v : null;
  const error = str(search.error);
  const dismissedName = search.dismissed === "1" ? (str(search.name) ?? "Candidate") : null;
  const actionedName = search.actioned === "1" ? (str(search.name) ?? "Candidate") : null;
  const swept = str(search.swept);
  const already = search.already === "1";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Departure candidates
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            The sweep is a notifier: people with no punch or schedule in 30
            days at any associated store land here, and a human decides.
            Nothing is deactivated until you act. {candidates.length} open.
          </p>
        </div>
        <form action={runDepartureSweepAction}>
          <Button type="submit" variant="outline" size="sm">
            Run sweep now
          </Button>
        </form>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {error}
        </div>
      )}
      {dismissedName && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Dismissed {dismissedName} — not a departure. They will not resurface
          while evidence stays fresh; a new dormant stretch surfaces them
          again.
        </div>
      )}
      {actionedName && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Deactivated {actionedName} at every associated store. History and
          reports remain; feeds stop matching new rows.
        </div>
      )}
      {already && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          That candidate was already resolved — nothing to do.
        </div>
      )}
      {swept !== null && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Sweep complete — {swept} new candidate{swept === "1" ? "" : "s"}{" "}
          surfaced. Re-running is a no-op on anyone already listed.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Open candidates</CardTitle>
        </CardHeader>
        <CardContent>
          {candidates.length === 0 ? (
            <p className="text-sm text-slate-500">
              No open candidates. Everyone active has punched or been
              scheduled within 30 days at at least one of their stores.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500 uppercase border-b border-slate-200">
                <tr>
                  <th className="py-2 pr-4">Employee</th>
                  <th className="py-2 pr-4">Stores</th>
                  <th className="py-2 pr-4">Days dormant</th>
                  <th className="py-2 pr-4">Last worked</th>
                  <th className="py-2 pr-4">Last scheduled</th>
                  <th className="py-2 pr-4">Detected</th>
                  <th className="py-2 pr-4">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {candidates.map((c) => {
                  const emp = c.employees;
                  const key =
                    emp?.seven_shifts_user_id !== null &&
                    emp?.seven_shifts_user_id !== undefined
                      ? Number(emp.seven_shifts_user_id)
                      : null;
                  const stores =
                    key !== null && storesByPerson.has(key)
                      ? storesByPerson.get(key)!
                      : [{ name: emp?.locations?.name ?? "—", active: !!emp?.active }];
                  return (
                    <tr key={c.id}>
                      <td className="py-2 pr-4">
                        {emp ? (
                          <Link
                            href={`/dashboard/employees/${emp.id}`}
                            className="font-medium hover:underline"
                          >
                            {emp.employee_name}
                          </Link>
                        ) : (
                          "—"
                        )}
                        <span className="ml-2 font-mono text-xs text-slate-500">
                          {emp?.employee_code ?? ""}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-xs">
                        {stores.map((s, i) => (
                          <span key={`${c.id}-${s.name}-${i}`}>
                            {i > 0 && ", "}
                            <span className={s.active ? "" : "text-slate-400"}>
                              {s.name}
                            </span>
                          </span>
                        ))}
                      </td>
                      <td className="py-2 pr-4">{c.days_dormant}</td>
                      <td className="py-2 pr-4 text-xs">
                        {c.last_worked_at ?? "never"}
                      </td>
                      <td className="py-2 pr-4 text-xs">
                        {c.last_scheduled_at ?? "never"}
                      </td>
                      <td className="py-2 pr-4 text-xs">
                        {new Date(c.detected_at).toLocaleDateString()}
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-3">
                          <form action={resolveDepartureCandidateAction}>
                            <input type="hidden" name="candidate_id" value={c.id} />
                            <input type="hidden" name="resolution" value="dismissed" />
                            <button
                              type="submit"
                              className="text-xs text-slate-600 underline-offset-2 hover:underline"
                            >
                              Dismiss
                            </button>
                          </form>
                          <form action={resolveDepartureCandidateAction}>
                            <input type="hidden" name="candidate_id" value={c.id} />
                            <input type="hidden" name="resolution" value="actioned" />
                            <button
                              type="submit"
                              className="text-xs text-red-600 underline-offset-2 hover:underline"
                              title="Deactivates every active row of this person — a departure is a person-level fact"
                            >
                              Deactivate (all stores)
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
