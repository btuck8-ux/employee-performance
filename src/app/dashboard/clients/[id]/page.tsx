import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import { createLocationAction } from "./actions";
import { uploadEmployeesCsvBulkAction } from "@/app/dashboard/locations/[id]/upload-actions";
import { uploadTimeDataBulkAction } from "@/app/dashboard/locations/[id]/upload-time-actions";
import { uploadTattleCsvBulkAction } from "@/app/dashboard/locations/[id]/upload-tattle-actions";

// Bulk upload paths fan out across all of this client's locations and run
// recompute per (employee, quarter, location); 300s gives them headroom on
// Vercel Pro for clients with 6+ locations.
export const maxDuration = 300;

export default async function ClientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const search = await searchParams;
  const supabase = await createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("id, name")
    .eq("id", id)
    .single();
  if (!client) notFound();

  const { data: locations } = await supabase
    .from("locations")
    .select("id, name, active, last_data_uploaded_at")
    .eq("client_id", id)
    .order("name");

  // ---- Bulk upload result banners ----
  const bulkError = typeof search.bulk_error === "string" ? search.bulk_error : null;
  const bulkInserted = Number(search.bulk_inserted ?? 0);
  const bulkUpdated = Number(search.bulk_updated ?? 0);
  const bulkFailed = Number(search.bulk_failed ?? 0);
  const bulkInactiveSkipped = Number(search.bulk_inactive_skipped ?? 0);
  const bulkUnmatched = Number(search.bulk_unmatched ?? 0);
  const bulkLocations = Number(search.bulk_locations ?? 0);
  const bulkBreakdown =
    typeof search.bulk_breakdown === "string" ? search.bulk_breakdown : null;
  const showBulkEmployees = bulkInserted + bulkUpdated + bulkFailed > 0 || bulkLocations > 0;

  const bulkTimeError =
    typeof search.bulk_time_error === "string" ? search.bulk_time_error : null;
  const bulkTimeLocations = Number(search.bulk_time_locations ?? 0);
  const bulkSchedIn = Number(search.bulk_sched_in ?? 0);
  const bulkSchedUp = Number(search.bulk_sched_up ?? 0);
  const bulkWorkIn = Number(search.bulk_work_in ?? 0);
  const bulkWorkUp = Number(search.bulk_work_up ?? 0);
  const bulkRecomputed = Number(search.bulk_recomputed ?? 0);
  const bulkUnknown =
    typeof search.bulk_unknown === "string" ? search.bulk_unknown : null;
  const bulkTimeBreakdown =
    typeof search.bulk_time_breakdown === "string" ? search.bulk_time_breakdown : null;
  const bulkDerivedCreated = Number(search.bulk_derived_created ?? 0);
  const bulkDerivedFailed = Number(search.bulk_derived_failed ?? 0);
  const showBulkTime =
    bulkSchedIn + bulkSchedUp + bulkWorkIn + bulkWorkUp + bulkTimeLocations > 0;

  // ---- Bulk tattle upload result banners ----
  const bulkTattleError =
    typeof search.bulk_tattle_error === "string" ? search.bulk_tattle_error : null;
  const bulkTattleLocations = Number(search.bulk_tattle_locations ?? 0);
  const bulkTattleIn = Number(search.bulk_tattle_in ?? 0);
  const bulkTattleUp = Number(search.bulk_tattle_up ?? 0);
  const bulkTattleAtt = Number(search.bulk_tattle_att ?? 0);
  const bulkTattleOnshift = Number(search.bulk_tattle_onshift ?? 0);
  const bulkTattleWorkday = Number(search.bulk_tattle_workday ?? 0);
  const bulkTattleUnatt = Number(search.bulk_tattle_unatt ?? 0);
  const bulkTattleRecomputed = Number(search.bulk_tattle_recomputed ?? 0);
  const bulkTattleUnmatched = Number(search.bulk_tattle_unmatched ?? 0);
  const bulkTattleBreakdown =
    typeof search.bulk_tattle_breakdown === "string" ? search.bulk_tattle_breakdown : null;
  const bulkTattleFailures =
    typeof search.bulk_tattle_failures === "string" ? search.bulk_tattle_failures : null;
  const showBulkTattle =
    bulkTattleIn + bulkTattleUp + bulkTattleAtt + bulkTattleLocations > 0;

  const locCount = locations?.length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-slate-500">
          <Link href="/dashboard/clients" className="hover:underline">
            ← All clients
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">{client.name}</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add location</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createLocationAction} className="flex items-end gap-3 max-w-md">
            <input type="hidden" name="client_id" value={client.id} />
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="loc_name">Location name</Label>
              <Input id="loc_name" name="name" placeholder="e.g. Downtown" required />
            </div>
            <Button type="submit">Add</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Locations</CardTitle>
        </CardHeader>
        <CardContent>
          {!locations || locations.length === 0 ? (
            <p className="text-sm text-slate-500">No locations yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {locations.map((loc) => (
                <li key={loc.id} className="py-3 flex items-center justify-between">
                  <Link
                    href={`/dashboard/locations/${loc.id}`}
                    className="font-medium hover:underline"
                  >
                    {loc.name}
                  </Link>
                  <span className="text-xs text-slate-500">
                    {loc.last_data_uploaded_at
                      ? `Last upload: ${new Date(loc.last_data_uploaded_at).toLocaleDateString()}`
                      : "Never uploaded"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {locCount > 0 && (
        <>
          <div>
            <h2 className="text-lg font-semibold tracking-tight mt-4">
              Bulk upload (fans out across all {locCount} location{locCount === 1 ? "" : "s"})
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              Upload one all-locations CSV here and it auto-routes rows to each
              location based on the CSV&apos;s Location column. Rows tagged for
              clients other than this one are silently skipped.
            </p>
          </div>

          {/* ---- Employees bulk upload ---- */}
          {bulkError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
              <strong>Employees bulk upload failed:</strong> {bulkError}
            </div>
          )}
          {showBulkEmployees && !bulkError && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              <strong>Employees imported across {bulkLocations} location{bulkLocations === 1 ? "" : "s"}.</strong>{" "}
              {bulkInserted > 0 && <>Added {bulkInserted}. </>}
              {bulkUpdated > 0 && <>Updated {bulkUpdated}. </>}
              {bulkInactiveSkipped > 0 && <>Skipped {bulkInactiveSkipped} inactive. </>}
              {bulkUnmatched > 0 && <>Skipped {bulkUnmatched} for other clients. </>}
              {bulkFailed > 0 && (
                <span className="text-red-700">{bulkFailed} failed.</span>
              )}
              {bulkBreakdown && (
                <p className="mt-1 text-xs text-emerald-800/80">
                  Breakdown: {bulkBreakdown}
                </p>
              )}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Bulk upload — employees</CardTitle>
            </CardHeader>
            <CardContent>
              <form action={uploadEmployeesCsvBulkAction} className="space-y-3">
                <input type="hidden" name="scope" value="client" />
                <input type="hidden" name="client_id" value={client.id} />
                <div className="space-y-1.5">
                  <Label htmlFor="bulk_emp_file">Employees CSV (all locations)</Label>
                  <Input
                    id="bulk_emp_file"
                    name="file"
                    type="file"
                    accept=".csv,text/csv"
                    required
                  />
                  <p className="text-xs text-slate-500">
                    Each row&apos;s Location column routes that row to the matching
                    location under {client.name}. Rows tagged for other clients
                    are skipped.
                  </p>
                </div>
                <SubmitButton pendingLabel="Importing & fanning out…">
                  Upload to all {locCount} location{locCount === 1 ? "" : "s"}
                </SubmitButton>
              </form>
            </CardContent>
          </Card>

          {/* ---- Time data bulk upload ---- */}
          {bulkTimeError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
              <strong>Time bulk upload failed:</strong> {bulkTimeError}
            </div>
          )}
          {showBulkTime && !bulkTimeError && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              <strong>Time data imported across {bulkTimeLocations} location{bulkTimeLocations === 1 ? "" : "s"}.</strong>{" "}
              Scheduled: {bulkSchedIn} new, {bulkSchedUp} updated · Worked: {bulkWorkIn} new, {bulkWorkUp} updated.
              {" "}
              Recomputed performance for {bulkRecomputed} {bulkRecomputed === 1 ? "employee-quarter" : "employee-quarters"}.
              {bulkDerivedCreated > 0 && (
                <p className="mt-1 text-xs text-emerald-800/80">
                  Auto-created {bulkDerivedCreated} employee{bulkDerivedCreated === 1 ? "" : "s"} from time data
                  {bulkDerivedFailed > 0 && (
                    <> ({bulkDerivedFailed} failed)</>
                  )}
                  .
                </p>
              )}
              {bulkUnknown && (
                <p className="mt-1 text-xs text-amber-800">
                  Unknown employees (not in any of this client&apos;s rosters): {bulkUnknown}
                </p>
              )}
              {bulkTimeBreakdown && (
                <p className="mt-1 text-xs text-emerald-800/80">
                  Breakdown: {bulkTimeBreakdown}
                </p>
              )}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Bulk upload — time data (scheduled + worked)</CardTitle>
            </CardHeader>
            <CardContent>
              <form action={uploadTimeDataBulkAction} className="space-y-4">
                <input type="hidden" name="scope" value="client" />
                <input type="hidden" name="client_id" value={client.id} />
                <div className="space-y-1.5">
                  <Label htmlFor="bulk_sched_file">Scheduled hours CSV</Label>
                  <Input
                    id="bulk_sched_file"
                    name="scheduled_file"
                    type="file"
                    accept=".csv,text/csv"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bulk_work_file">Worked hours CSV</Label>
                  <Input
                    id="bulk_work_file"
                    name="worked_file"
                    type="file"
                    accept=".csv,text/csv"
                  />
                </div>
                <p className="text-xs text-slate-500">
                  Upload one or both files. Each row&apos;s Location column routes it
                  to the matching location. Recompute fires per (employee, quarter)
                  in each location after ingest.
                </p>
                <label className="flex items-start gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    name="derive_employees"
                    value="1"
                    className="mt-0.5 h-4 w-4"
                  />
                  <span>
                    <strong>Auto-create employees from this time data.</strong> For any
                    name in the CSV that doesn&apos;t exist at the routed location, create
                    one (active = true, hire date = earliest worked entry, wage from the
                    CSV if present). Use this when you don&apos;t have an employee roster
                    CSV for the locations under this client.
                  </span>
                </label>
                <SubmitButton pendingLabel="Importing & recomputing…">
                  Upload time data to all {locCount} location{locCount === 1 ? "" : "s"}
                </SubmitButton>
              </form>
            </CardContent>
          </Card>

          {/* ---- Tattle bulk upload ---- */}
          {bulkTattleError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
              <strong>Tattle bulk upload failed:</strong> {bulkTattleError}
            </div>
          )}
          {showBulkTattle && !bulkTattleError && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              <strong>Tattle data imported across {bulkTattleLocations} location{bulkTattleLocations === 1 ? "" : "s"}.</strong>{" "}
              Surveys: {bulkTattleIn} new, {bulkTattleUp} updated · Attributions: {bulkTattleAtt} ({bulkTattleOnshift} on shift, {bulkTattleWorkday} worked-that-day, {bulkTattleUnatt} unattributed).
              {" "}
              Recomputed performance for {bulkTattleRecomputed} {bulkTattleRecomputed === 1 ? "employee-quarter" : "employee-quarters"}.
              {bulkTattleUnmatched > 0 && (
                <p className="mt-1 text-xs text-amber-800">
                  Skipped {bulkTattleUnmatched} survey{bulkTattleUnmatched === 1 ? "" : "s"} tagged for other clients.
                </p>
              )}
              {bulkTattleBreakdown && (
                <p className="mt-1 text-xs text-emerald-800/80">
                  Breakdown: {bulkTattleBreakdown}
                </p>
              )}
              {bulkTattleFailures && (
                <p className="mt-1 text-xs text-red-700">Failures: {bulkTattleFailures}</p>
              )}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Bulk upload — tattle survey data</CardTitle>
            </CardHeader>
            <CardContent>
              <form action={uploadTattleCsvBulkAction} className="space-y-3">
                <input type="hidden" name="scope" value="client" />
                <input type="hidden" name="client_id" value={client.id} />
                <div className="space-y-1.5">
                  <Label htmlFor="bulk_tattle_file">Tattle responses CSV (all locations)</Label>
                  <Input
                    id="bulk_tattle_file"
                    name="file"
                    type="file"
                    accept=".csv,text/csv"
                    required
                  />
                  <p className="text-xs text-slate-500">
                    Each survey&apos;s Location column routes it to the matching
                    location under {client.name}. For each survey, attribution
                    runs against that location&apos;s worked time entries: anyone
                    on shift at the experienced timestamp, falling back to anyone
                    who worked that day. Time data must be uploaded first so
                    attribution can resolve correctly.
                  </p>
                </div>
                <SubmitButton pendingLabel="Importing & attributing…">
                  Upload tattles to all {locCount} location{locCount === 1 ? "" : "s"}
                </SubmitButton>
              </form>
            </CardContent>
          </Card>

          <p className="text-xs text-slate-500">
            <strong>Note:</strong> Customer reviews, surveys, and tasks still
            use the per-location upload on each location&apos;s page. Bulk
            paths for those data types coming next.
          </p>
        </>
      )}
    </div>
  );
}
