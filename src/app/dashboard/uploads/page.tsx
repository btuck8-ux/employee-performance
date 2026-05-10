import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import { uploadEmployeesCsvBulkAction } from "@/app/dashboard/locations/[id]/upload-actions";
import { uploadTimeDataBulkAction } from "@/app/dashboard/locations/[id]/upload-time-actions";
import { uploadTattleCsvBulkAction } from "@/app/dashboard/locations/[id]/upload-tattle-actions";

// Bulk upload paths fan out across every location across every client; recompute
// runs per (employee, quarter, location). Bumped to Vercel Pro's 300s cap.
export const maxDuration = 300;

export default async function UploadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const supabase = await createClient();

  const { data: locations } = await supabase
    .from("locations")
    .select("id, name, clients(name)")
    .order("name");
  const locCount = locations?.length ?? 0;

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

  // Tattle bulk banners
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Bulk Uploads</h1>
        <p className="text-sm text-slate-500 mt-1">
          Upload an all-locations CSV here and it fans out to every location
          across every client ({locCount} location{locCount === 1 ? "" : "s"} total).
          Each row&apos;s Location column routes it to the right location. To
          scope an upload to a single client&apos;s locations, use the Client
          detail page instead.
        </p>
      </div>

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
          {bulkUnmatched > 0 && <>Skipped {bulkUnmatched} unmatched. </>}
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
          <CardTitle>Employees</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={uploadEmployeesCsvBulkAction} className="space-y-3">
            <input type="hidden" name="scope" value="all" />
            <div className="space-y-1.5">
              <Label htmlFor="bulk_emp_file_all">Employees CSV (all locations)</Label>
              <Input
                id="bulk_emp_file_all"
                name="file"
                type="file"
                accept=".csv,text/csv"
                required
              />
              <p className="text-xs text-slate-500">
                Routes each row to the matching location (case-insensitive name
                match on the Location column). Rows tagged for locations not in
                the system are silently skipped.
              </p>
            </div>
            <SubmitButton pendingLabel="Importing & fanning out…">
              Upload to all {locCount} location{locCount === 1 ? "" : "s"}
            </SubmitButton>
          </form>
        </CardContent>
      </Card>

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
              Unknown employees (not on any roster): {bulkUnknown}
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
          <CardTitle>Time data (scheduled + worked)</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={uploadTimeDataBulkAction} className="space-y-4">
            <input type="hidden" name="scope" value="all" />
            <div className="space-y-1.5">
              <Label htmlFor="bulk_sched_file_all">Scheduled hours CSV</Label>
              <Input
                id="bulk_sched_file_all"
                name="scheduled_file"
                type="file"
                accept=".csv,text/csv"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bulk_work_file_all">Worked hours CSV</Label>
              <Input
                id="bulk_work_file_all"
                name="worked_file"
                type="file"
                accept=".csv,text/csv"
              />
            </div>
            <p className="text-xs text-slate-500">
              Upload one or both files. Each row&apos;s Location column routes
              it to the matching location across all clients.
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
                name in the CSV that doesn&apos;t exist at its routed location, create
                one (active = true, hire date = earliest worked entry, wage from the
                CSV if present). Use this only if you don&apos;t have the canonical
                roster CSV. Note: applies across ALL clients here — leave OFF for
                Houston / New Orleans where you have rosters.
              </span>
            </label>
            <SubmitButton pendingLabel="Importing & recomputing…">
              Upload time data to all {locCount} location{locCount === 1 ? "" : "s"}
            </SubmitButton>
          </form>
        </CardContent>
      </Card>

      {/* ---- Tattle bulk ---- */}
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
              Skipped {bulkTattleUnmatched} survey{bulkTattleUnmatched === 1 ? "" : "s"} tagged for locations not in the system.
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
          <CardTitle>Tattle survey data</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={uploadTattleCsvBulkAction} className="space-y-3">
            <input type="hidden" name="scope" value="all" />
            <div className="space-y-1.5">
              <Label htmlFor="bulk_tattle_file_all">Tattle responses CSV (all locations)</Label>
              <Input
                id="bulk_tattle_file_all"
                name="file"
                type="file"
                accept=".csv,text/csv"
                required
              />
              <p className="text-xs text-slate-500">
                Each survey&apos;s Location column routes it to the matching
                location across all clients. Attribution runs per location
                against that location&apos;s worked time entries. Time data must
                be uploaded first so attribution can resolve correctly.
              </p>
            </div>
            <SubmitButton pendingLabel="Importing & attributing…">
              Upload tattles to all {locCount} location{locCount === 1 ? "" : "s"}
            </SubmitButton>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reviews · Surveys · Tasks</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">
            Bulk paths for these data types are coming next. For now, upload
            them on each location&apos;s individual page — the location-column
            filter still skips out-of-location rows correctly, you just have to
            visit each location once.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
