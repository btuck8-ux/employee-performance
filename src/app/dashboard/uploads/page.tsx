import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import { uploadEmployeesCsvBulkAction } from "@/app/dashboard/locations/[id]/upload-actions";
import { uploadTimeDataBulkAction } from "@/app/dashboard/locations/[id]/upload-time-actions";

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
  const showBulkTime =
    bulkSchedIn + bulkSchedUp + bulkWorkIn + bulkWorkUp + bulkTimeLocations > 0;

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
            <SubmitButton pendingLabel="Importing & recomputing…">
              Upload time data to all {locCount} location{locCount === 1 ? "" : "s"}
            </SubmitButton>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tattles · Reviews · Surveys · Tasks</CardTitle>
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
