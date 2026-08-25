import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import { buildCrosswalkPageData } from "./data";
import {
  confirmToastMatchAction,
  undoToastMatchAction,
  archiveEmployeeAction,
  unarchiveEmployeeAction,
} from "./actions";

/**
 * SA-only Toast employee crosswalk triage (ruling §3/§4, 2026-08-23).
 * Server component — Toast credentials and roster names stay server-side;
 * the ./actions.ts server actions re-check system_admin independently.
 *
 * The queue lists unmatched Toast employees WITH punches (the broken
 * population — roster-only unmatched guids surface lazily via run detail,
 * per ruling §3). Names/emails on a card are HINTS for the human; every
 * match is committed by id. Recent auto/manual matches are listed with an
 * undo so a wrong auto-commit is reversible (ruling §4 guard 3).
 */

export default async function ToastCrosswalkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const { role, supabase } = await getSessionRole();
  if (role !== "system_admin") redirect("/dashboard");

  const data = await buildCrosswalkPageData(supabase);

  const str = (v: string | string[] | undefined): string | null =>
    typeof v === "string" && v ? v : null;
  const confirmed = search.confirmed === "1";
  const already = search.already === "1";
  const undone = search.undone === "1";
  const archived = search.archived === "1";
  const unarchived = search.unarchived === "1";
  const archivedEmpId = str(search.emp);
  const bannerCode = str(search.code);
  const error = str(search.error);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Toast crosswalk</h1>
        <p className="text-sm text-slate-500 mt-1">
          Map Toast punch accounts to EPD employees. Email matches commit
          automatically; unambiguous schedule-overlap matches auto-commit with
          evidence; everything else waits here for your call. Names are hints —
          matches are committed by id, never by name. GM-tagged candidates
          punch irregularly by nature (offsite work, on-call time that never
          reaches a time clock), so a loose-looking overlap on a GM is not
          necessarily a weak match.
        </p>
      </div>

      {confirmed && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Mapping confirmed{bannerCode ? ` for ${bannerCode}` : ""} — stored
          punches are now attributed.
        </div>
      )}
      {already && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          That Toast employee is already mapped — nothing changed.
        </div>
      )}
      {undone && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Mapping removed — its punches are unattributed again.
        </div>
      )}
      {archived && (
        <div className="flex items-center justify-between rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>
            {bannerCode ? `${bannerCode} archived` : "Employee archived"} —
            their rows leave the CP and THQ score feeds. Nothing was deleted;
            their schedule rows remain the vendor&apos;s record.
          </span>
          {archivedEmpId && (
            <form action={unarchiveEmployeeAction}>
              <input type="hidden" name="employee_id" value={archivedEmpId} />
              <button type="submit" className="text-xs text-amber-900 underline">
                Undo
              </button>
            </form>
          )}
        </div>
      )}
      {unarchived && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {bannerCode ? `${bannerCode} restored` : "Employee restored"} — back
          on the roster and the feeds.
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {data.stores.map((s) => (
          <div
            key={s.location_code}
            className="rounded-lg border border-slate-200 bg-white p-3"
          >
            <div className="text-sm font-semibold">{s.location_code}</div>
            <div className="text-xs text-slate-500 mt-1">
              {s.crosswalk_rows} mapped
            </div>
            <div
              className={`text-xs mt-0.5 ${s.unmatched_with_punches > 0 ? "text-amber-700" : "text-slate-500"}`}
            >
              {s.unmatched_with_punches} unmatched with punches
            </div>
            {s.roster_error && (
              <div className="text-xs text-red-600 mt-1">
                Toast roster unavailable
              </div>
            )}
          </div>
        ))}
      </div>

      {data.unmapped_scheduled.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">
            Unmapped scheduled employees ({data.unmapped_scheduled.length})
          </h2>
          <p className="text-sm text-slate-500">
            The reverse check: scheduled post-go-live with no crosswalk row.
            EPD cannot see their punches, so their attendance reads
            not-computable (null) until a mapping lands — their account is
            likely sitting in the queue below. This list should be empty.
          </p>
          <div className="overflow-x-auto rounded-lg border border-amber-200 bg-amber-50">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-amber-200 text-left text-xs text-amber-900">
                  <th className="px-3 py-2">Employee</th>
                  <th className="px-3 py-2">Store</th>
                  <th className="px-3 py-2">Scheduled days</th>
                  <th className="px-3 py-2">Last scheduled</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {data.unmapped_scheduled.map((u) => (
                  <tr key={u.employee_id} className="border-b border-amber-100 last:border-0">
                    <td className="px-3 py-2">
                      {u.employee_code} — {u.employee_name}
                      {u.is_general_manager && (
                        <span className="ml-2 rounded bg-white px-1.5 py-0.5 text-xs text-slate-600">
                          GM
                        </span>
                      )}
                      {!u.active && (
                        <span className="ml-2 rounded bg-white px-1.5 py-0.5 text-xs text-slate-500">
                          inactive
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">{u.location_code}</td>
                    <td className="px-3 py-2">{u.scheduled_days}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {u.last_scheduled ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      {/* Archive (spec 2026-08-25 §2): the consequence is
                          named and confirmed, never silent — this removes
                          them from the CP/THQ feeds. Nothing is deleted;
                          schedule rows stay the vendor's record. */}
                      <form
                        action={archiveEmployeeAction}
                        className="flex items-center gap-2"
                      >
                        <input type="hidden" name="employee_id" value={u.employee_id} />
                        <label className="flex items-center gap-1 text-xs text-amber-900">
                          <input
                            type="checkbox"
                            name="confirm_feed_consequence"
                            value="1"
                            required
                            className="h-3 w-3"
                          />
                          departed — remove from CP/THQ feeds
                        </label>
                        <button
                          type="submit"
                          className="rounded-md border border-amber-300 bg-white px-2 py-1 text-xs text-amber-900 hover:bg-amber-100"
                        >
                          Archive
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Unmatched punch accounts ({data.queue.length})
        </h2>
        {data.queue.length === 0 && (
          <p className="text-sm text-slate-500">
            Every stored punch is attributed. New unmatched accounts appear
            here after the nightly sync.
          </p>
        )}
        {data.queue.map((q) => (
          <div
            key={q.toast_employee_guid}
            className="rounded-lg border border-slate-200 bg-white p-4"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm font-semibold">
                {q.toast_name ?? "(name unavailable)"}
              </span>
              {q.toast_email && (
                <span className="text-xs text-slate-500">{q.toast_email}</span>
              )}
              <span className="text-xs rounded bg-slate-100 px-1.5 py-0.5">
                {q.location_code}
              </span>
              {q.toast_deleted && (
                <span className="text-xs rounded bg-slate-100 px-1.5 py-0.5">
                  deleted in Toast
                </span>
              )}
              {q.stuck && (
                <span
                  className="text-xs rounded bg-red-100 px-1.5 py-0.5 text-red-800"
                  title="Below the 6-day auto-commit floor and idle >14 days — it can never accumulate enough overlap for the nightly matcher. Needs a human decision."
                >
                  stuck — needs a human
                </span>
              )}
              <span className="text-xs text-slate-400 font-mono">
                {q.toast_employee_guid.slice(0, 8)}…
              </span>
            </div>
            <div className="text-xs text-slate-500 mt-1">
              {q.punch_days} punch day{q.punch_days === 1 ? "" : "s"}
              {q.first_punch && (
                <>
                  {" "}
                  ({q.first_punch} → {q.last_punch})
                </>
              )}
              {q.candidates[0] && q.candidates[0].overlap_days > 0 && (
                <>
                  {" "}
                  · best schedule overlap: {q.candidates[0].employee_name} (
                  {q.candidates[0].overlap_days}d)
                </>
              )}
            </div>
            <form
              action={confirmToastMatchAction}
              className="mt-3 flex flex-wrap items-center gap-2"
            >
              <input
                type="hidden"
                name="toast_employee_guid"
                value={q.toast_employee_guid}
              />
              <select
                name="employee_id"
                required
                defaultValue=""
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                <option value="" disabled>
                  Choose the EPD employee…
                </option>
                {q.candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.employee_code} — {c.employee_name}
                    {c.is_general_manager ? " [GM]" : ""}
                    {c.overlap_days > 0 ? ` (${c.overlap_days}d overlap)` : ""}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-md bg-ikes-green px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
              >
                Confirm mapping
              </button>
            </form>
            {/* Archive (spec 2026-08-25 §2): for a stuck entry whose owner
                has genuinely left, the SA archives the EMPLOYEE (the GUID
                stays queued as the vendor's record). Same candidate select;
                the feed consequence is confirmed, never silent. */}
            <form
              action={archiveEmployeeAction}
              className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2"
            >
              <select
                name="employee_id"
                required
                defaultValue=""
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
              >
                <option value="" disabled>
                  Archive a departed employee…
                </option>
                {q.candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.employee_code} — {c.employee_name}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs text-amber-900">
                <input
                  type="checkbox"
                  name="confirm_feed_consequence"
                  value="1"
                  required
                  className="h-3 w-3"
                />
                departed — remove from CP/THQ feeds
              </label>
              <button
                type="submit"
                className="rounded-md border border-amber-300 bg-white px-2 py-1 text-xs text-amber-900 hover:bg-amber-100"
              >
                Archive
              </button>
            </form>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Recent auto &amp; manual matches</h2>
        {data.recent_matches.length === 0 && (
          <p className="text-sm text-slate-500">None yet.</p>
        )}
        {data.recent_matches.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="px-3 py-2">Employee</th>
                  <th className="px-3 py-2">Store</th>
                  <th className="px-3 py-2">Method</th>
                  <th className="px-3 py-2">Evidence</th>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {data.recent_matches.map((m) => (
                  <tr
                    key={m.toast_employee_guid}
                    className="border-b border-slate-100 last:border-0"
                  >
                    <td className="px-3 py-2">
                      {m.employee_code} — {m.employee_name}
                      {m.is_general_manager && (
                        <span
                          className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600"
                          title="General manager — irregular punch patterns are expected"
                        >
                          GM
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">{m.location_code}</td>
                    <td className="px-3 py-2">{m.match_method}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {m.match_method === "auto_behavioural" && m.evidence
                        ? `${String(m.evidence["best_overlap_days"] ?? "?")}d overlap over ${String(m.evidence["punch_days"] ?? "?")} punch days`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {m.created_at.slice(0, 10)}
                    </td>
                    <td className="px-3 py-2">
                      <form action={undoToastMatchAction}>
                        <input
                          type="hidden"
                          name="toast_employee_guid"
                          value={m.toast_employee_guid}
                        />
                        <button
                          type="submit"
                          className="text-xs text-red-700 hover:underline"
                        >
                          Undo
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
