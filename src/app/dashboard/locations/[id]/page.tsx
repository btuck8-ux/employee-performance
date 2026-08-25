import Link from "next/link";
import { notFound } from "next/navigation";

// Bulk-generate fans out N PDFs serially; bump the route's serverless function
// timeout so a 30-employee location can finish in one shot. This applies to
// every server action on this route, not just bulk generation. 300s = Vercel
// Pro cap; on hobby it'll silently cap at 60s, which is still fine for ≤15
// employees with task detail.
export const maxDuration = 300;
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ImportErrorBanner, ImportSummaryBanner } from "@/components/import-summary-banner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import { StorageUploadForm } from "@/components/uploads/StorageUploadForm";
import { createEmployeeAction } from "./actions";
import { uploadEmployeesCsvAction } from "./upload-actions";
import { uploadTimeDataAction } from "./upload-time-actions";
import { uploadTattleCsvAction } from "./upload-tattle-actions";
import { uploadCustomerReviewsCsvAction } from "./upload-review-actions";
import { uploadSurveyCsvAction } from "./upload-survey-actions";
import { uploadTasksCsvAction } from "./upload-tasks-actions";
import { uploadPOSCsvAction } from "./upload-pos-actions";
import { generateBulkLocationReportsAction } from "./generate-bulk-reports-actions";
import { computeStoreAttendance, type StoreAttendanceBothWays } from "@/lib/store-attendance";
import { currentQuarter } from "@/lib/quarter";

export default async function LocationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const search = await searchParams;
  const supabase = await createClient();

  const { data: location } = await supabase
    .from("locations")
    .select("id, name, last_data_uploaded_at, last_report_generated_at, clients(id, name)")
    .eq("id", id)
    .single();
  if (!location) notFound();

  const client = location.clients as unknown as { id: string; name: string } | null;

  const { data: employees } = await supabase
    .from("employees")
    .select("id, employee_code, employee_name, hire_date, wage, wage_pay_type, active")
    .eq("location_id", id)
    .order("employee_name");

  // Store-wide attendance & punctuality, both ways (mig 057 §1): all staff
  // AND excluding management, side by side — neither is "the" number. GMs
  // stay in the metric; a fetch failure degrades to no card, never a 500.
  const storeQuarter = currentQuarter();
  let storeAttendance: StoreAttendanceBothWays | null = null;
  try {
    storeAttendance = await computeStoreAttendance(
      supabase,
      id,
      storeQuarter.periodStart.toISOString().slice(0, 10),
      storeQuarter.periodEnd.toISOString().slice(0, 10)
    );
  } catch (err) {
    console.warn("[location] store attendance unavailable", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Quarters this location has performance_records for — used to populate
  // the bulk-generate dropdown. Sorted newest-first so the most recent
  // quarter is the default.
  const { data: bulkQuartersRaw } = await supabase
    .from("performance_records")
    .select("report_periods!inner(id, label, period_start, year, quarter)")
    .eq("location_id", id);
  type BulkQuarterPeriod = {
    id: string;
    label: string;
    period_start: string;
    year: number;
    quarter: number;
  };
  const seenPeriodIds = new Set<string>();
  const bulkQuarters: BulkQuarterPeriod[] = [];
  for (const row of (bulkQuartersRaw ?? []) as unknown as Array<{
    report_periods: BulkQuarterPeriod | null;
  }>) {
    const rp = row.report_periods;
    if (rp && !seenPeriodIds.has(rp.id)) {
      seenPeriodIds.add(rp.id);
      bulkQuarters.push(rp);
    }
  }
  bulkQuarters.sort((a, b) => b.period_start.localeCompare(a.period_start));

  // Surface feedback from the most recent bulk-generate run
  const bulkOk = Number(search.bulk_ok ?? 0);
  const bulkFailed = Number(search.bulk_failed ?? 0);
  const bulkSkippedNoData = Number(search.bulk_skipped_no_data ?? 0);
  const bulkBundled = Number(search.bulk_bundled ?? 0);
  const bulkNoDataNames =
    typeof search.bulk_no_data_names === "string" ? search.bulk_no_data_names : null;
  const bulkFailures =
    typeof search.bulk_failures === "string" ? search.bulk_failures : null;
  const bulkError =
    typeof search.bulk_error === "string" ? search.bulk_error : null;
  const showBulkSummary =
    bulkOk + bulkFailed + bulkSkippedNoData > 0 || bulkError !== null;

  // Surface feedback from the most recent employee CSV import
  const inserted = Number(search.inserted ?? 0);
  const updated = Number(search.updated ?? 0);
  const failed = Number(search.failed ?? 0);
  const inactiveSkipped = Number(search.inactive_skipped ?? 0);
  const importError = typeof search.import_error === "string" ? search.import_error : null;
  const warnings = typeof search.warnings === "string" ? search.warnings : null;
  const failureDetail =
    typeof search.failure_detail === "string" ? search.failure_detail : null;
  const skippedOtherLocation = Number(search.skipped_other_location ?? 0);
  const showImportSummary = inserted > 0 || updated > 0 || failed > 0 || inactiveSkipped > 0 || skippedOtherLocation > 0;
  const timeSkippedOtherLocation = Number(search.time_skipped_other_location ?? 0);
  const tattleSkippedOtherLocation = Number(search.tattle_skipped_other_location ?? 0);
  const timeDerivedCreated = Number(search.time_derived_created ?? 0);
  const timeDerivedFailed = Number(search.time_derived_failed ?? 0);
  const reviewSkippedOtherLocation = Number(search.review_skipped_other_location ?? 0);
  const taskSkippedOtherLocation = Number(search.task_skipped_other_location ?? 0);

  // Surface feedback from the most recent time data import
  const schedIn = Number(search.sched_in ?? 0);
  const schedUp = Number(search.sched_up ?? 0);
  const workIn = Number(search.work_in ?? 0);
  const workUp = Number(search.work_up ?? 0);
  const recomputed = Number(search.recomputed ?? 0);
  const unknownEmps = typeof search.unknown === "string" ? search.unknown : null;
  const inactiveTimeEmps = typeof search.inactive === "string" ? search.inactive : null;
  const timeWarnings = typeof search.warnings === "string" && search.recomputed ? search.warnings : null;
  const timeFailures = typeof search.failures === "string" ? search.failures : null;
  const timeError = typeof search.time_error === "string" ? search.time_error : null;
  const showTimeSummary = schedIn + schedUp + workIn + workUp + recomputed > 0 || timeError !== null;

  // Surface feedback from the most recent tattle import
  const tattleIn = Number(search.tattle_in ?? 0);
  const tattleUp = Number(search.tattle_up ?? 0);
  const tattleResp = Number(search.tattle_resp ?? 0);
  const tattleAtt = Number(search.tattle_att ?? 0);
  const tattleOnshift = Number(search.tattle_onshift ?? 0);
  const tattleWorkday = Number(search.tattle_workday ?? 0);
  const tattleUnatt = Number(search.tattle_unatt ?? 0);
  const tattleRecomputed = Number(search.tattle_recomputed ?? 0);
  const tattleError = typeof search.tattle_error === "string" ? search.tattle_error : null;
  const tattleWarnings = typeof search.tattle_warnings === "string" ? search.tattle_warnings : null;
  const tattleFailures = typeof search.tattle_failures === "string" ? search.tattle_failures : null;
  const showTattleSummary =
    tattleIn + tattleUp + tattleResp + tattleAtt > 0 || tattleError !== null;

  // Surface feedback from the most recent customer review import
  const reviewIn = Number(search.review_in ?? 0);
  const reviewUp = Number(search.review_up ?? 0);
  const reviewAtt = Number(search.review_att ?? 0);
  const reviewOnshift = Number(search.review_onshift ?? 0);
  const reviewWorkday = Number(search.review_workday ?? 0);
  const reviewUnatt = Number(search.review_unatt ?? 0);
  const reviewRecomputed = Number(search.review_recomputed ?? 0);
  const reviewError = typeof search.review_error === "string" ? search.review_error : null;
  const reviewWarnings = typeof search.review_warnings === "string" ? search.review_warnings : null;
  const reviewFailures = typeof search.review_failures === "string" ? search.review_failures : null;
  const showReviewSummary =
    reviewIn + reviewUp + reviewAtt > 0 || reviewError !== null;

  // Surface feedback from the most recent survey import
  const surveyIn = Number(search.survey_in ?? 0);
  const surveyUp = Number(search.survey_up ?? 0);
  const assnIn = Number(search.assn_in ?? 0);
  const assnUp = Number(search.assn_up ?? 0);
  const surveyMatches = Number(search.matches ?? 0);
  const matchBreakdown = typeof search.match_breakdown === "string" ? search.match_breakdown : null;
  const surveyRecomputed = Number(search.survey_recomputed ?? 0);
  const surveyError = typeof search.survey_error === "string" ? search.survey_error : null;
  const surveyUnmatched = typeof search.survey_unmatched === "string" ? search.survey_unmatched : null;
  const surveyAmbiguous = typeof search.survey_ambiguous === "string" ? search.survey_ambiguous : null;
  const surveyWarnings = typeof search.survey_warnings === "string" ? search.survey_warnings : null;
  const surveyFailures = typeof search.survey_failures === "string" ? search.survey_failures : null;
  const surveyInactiveSkipped = Number(search.survey_inactive_skipped ?? 0);
  const showSurveySummary =
    surveyIn + surveyUp + assnIn + assnUp > 0 || surveyError !== null;

  // Surface feedback from the most recent tasks import
  const taskIn = Number(search.task_in ?? 0);
  const taskUp = Number(search.task_up ?? 0);
  const taskDone = Number(search.task_done ?? 0);
  const taskUndone = Number(search.task_undone ?? 0);
  const taskAcct = Number(search.task_acct ?? 0);
  const taskRecomputed = Number(search.task_recomputed ?? 0);
  const taskError = typeof search.task_error === "string" ? search.task_error : null;
  const taskWarnings = typeof search.task_warnings === "string" ? search.task_warnings : null;
  const taskFailures = typeof search.task_failures === "string" ? search.task_failures : null;
  const showTaskSummary = taskIn + taskUp + taskAcct > 0 || taskError !== null;

  // Surface feedback from the most recent POS sales import
  const posIn = Number(search.pos_in ?? 0);
  const posUp = Number(search.pos_up ?? 0);
  const posSplit = Number(search.pos_split ?? 0);
  const posRefunds = Number(search.pos_refunds ?? 0);
  const posQuarters = Number(search.pos_quarters ?? 0);
  const posRecomputed = Number(search.pos_recomputed ?? 0);
  const posTeams = Number(search.pos_teams ?? 0);
  const posSkippedOtherLocation = Number(search.pos_skipped_other_location ?? 0);
  const posError = typeof search.pos_error === "string" ? search.pos_error : null;
  const posWarnings = typeof search.pos_warnings === "string" ? search.pos_warnings : null;
  const posFailures = typeof search.pos_failures === "string" ? search.pos_failures : null;
  // Also surface a banner when the action ran cleanly but ingested 0 rows AND
  // emitted warnings — the previous behavior was silent, which made it look
  // like nothing happened.
  const showPosSummary =
    posIn + posUp > 0 ||
    posError !== null ||
    (search.pos_in !== undefined && (posWarnings !== null || posFailures !== null));

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-slate-500">
          {client && (
            <Link href={`/dashboard/clients/${client.id}`} className="hover:underline">
              ← {client.name}
            </Link>
          )}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">{location.name}</h1>
        <p className="text-sm text-slate-500 mt-1">
          Last upload:{" "}
          {location.last_data_uploaded_at
            ? new Date(location.last_data_uploaded_at).toLocaleString()
            : "—"}
          {" · "}
          Last report run:{" "}
          {location.last_report_generated_at
            ? new Date(location.last_report_generated_at).toLocaleString()
            : "—"}
        </p>
        <div className="mt-3 flex gap-2">
          <Link
            href={`/dashboard/locations/${id}/teams`}
            className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 hover:bg-slate-50"
          >
            Teams analytics →
          </Link>
          <Link
            href={`/dashboard/locations/${id}/rankings`}
            className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 hover:bg-slate-50"
          >
            Total Impact rankings →
          </Link>
        </div>
      </div>

      <ImportErrorBanner label="Import failed" error={importError} />

      <ImportSummaryBanner show={showImportSummary} title="Import complete." warnings={warnings}>
        {inserted > 0 && <>Added {inserted} new employee{inserted === 1 ? "" : "s"}. </>}
        {updated > 0 && <>Updated {updated} existing employee{updated === 1 ? "" : "s"}. </>}
        {inactiveSkipped > 0 && (
          <>Skipped {inactiveSkipped} inactive row{inactiveSkipped === 1 ? "" : "s"}. </>
        )}
        {skippedOtherLocation > 0 && (
          <>Skipped {skippedOtherLocation} row{skippedOtherLocation === 1 ? "" : "s"} tagged for other locations. </>
        )}
        {failed > 0 && (
          <span className="text-red-700">
            {failed} row{failed === 1 ? "" : "s"} failed
            {failureDetail ? `: ${failureDetail}` : "."}
          </span>
        )}
      </ImportSummaryBanner>

      {storeAttendance && (
        <Card>
          <CardHeader>
            <CardTitle>
              Store attendance &amp; punctuality — {storeQuarter.label} to date
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full max-w-2xl text-sm">
              <thead className="text-left text-xs text-slate-500 uppercase border-b border-slate-200">
                <tr>
                  <th className="py-2 pr-4" />
                  <th className="py-2 pr-4">All staff</th>
                  <th className="py-2 pr-4">
                    Excluding management ({storeAttendance.gmCount} GM
                    {storeAttendance.gmCount === 1 ? "" : "s"})
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(
                  [
                    {
                      label: "Attendance",
                      all: storeAttendance.allStaff.attendancePct,
                      excl: storeAttendance.excludingManagement.attendancePct,
                      allDetail: `${storeAttendance.allStaff.parts.attended}/${storeAttendance.allStaff.parts.scheduled}`,
                      exclDetail: `${storeAttendance.excludingManagement.parts.attended}/${storeAttendance.excludingManagement.parts.scheduled}`,
                    },
                    {
                      label: "On time",
                      all: storeAttendance.allStaff.onTimePct,
                      excl: storeAttendance.excludingManagement.onTimePct,
                      allDetail: `${storeAttendance.allStaff.parts.onTime}/${storeAttendance.allStaff.parts.attended}`,
                      exclDetail: `${storeAttendance.excludingManagement.parts.onTime}/${storeAttendance.excludingManagement.parts.attended}`,
                    },
                    {
                      label: "On time (3-min grace)",
                      all: storeAttendance.allStaff.onTimeGracePct,
                      excl: storeAttendance.excludingManagement.onTimeGracePct,
                      allDetail: `${storeAttendance.allStaff.parts.onTimeGrace}/${storeAttendance.allStaff.parts.attended}`,
                      exclDetail: `${storeAttendance.excludingManagement.parts.onTimeGrace}/${storeAttendance.excludingManagement.parts.attended}`,
                    },
                  ] as const
                ).map((row) => (
                  <tr key={row.label}>
                    <td className="py-2 pr-4 text-slate-600">{row.label}</td>
                    <td className="py-2 pr-4">
                      {row.all !== null ? `${row.all.toFixed(1)}%` : "—"}
                      <span className="ml-1.5 text-xs text-slate-400">
                        {row.allDetail}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      {row.excl !== null ? `${row.excl.toFixed(1)}%` : "—"}
                      <span className="ml-1.5 text-xs text-slate-400">
                        {row.exclDetail}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-slate-500 mt-3">
              Both figures are computed from summed shift counts, never averaged
              percentages, and neither is &ldquo;the&rdquo; number — GMs stay in
              store metrics. GM punch patterns are expected to be irregular
              (offsite work, on-call time that never reaches a time clock).
              Evidenced non-punchers are excluded from both sides. Toast stores
              count the pruned 7shifts schedule against Toast punches — the
              same sources as the employee metrics.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Bulk import employees</CardTitle>
          </CardHeader>
          <CardContent>
            <StorageUploadForm
              action={uploadEmployeesCsvAction}
              fileFields={["file"]}
              pendingLabel="Importing employees…"
              submitLabel="Upload CSV"
              className="space-y-3"
            >
              <input type="hidden" name="location_id" value={location.id} />
              <div className="space-y-1.5">
                <Label htmlFor="employee_csv">Employee CSV file</Label>
                <Input id="employee_csv" name="file" type="file" accept=".csv,text/csv" required />
                <p className="text-xs text-slate-500">
                  Required: First name, Last name. Optional: Hire date, Wage, Pay type, User
                  status. Only rows with status &quot;Active&quot; are imported. Multiple rows for the same
                  person collapse to one record (max wage wins). The app generates each
                  employee&apos;s internal ID automatically.
                </p>
              </div>
            </StorageUploadForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Add a single employee</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={createEmployeeAction} className="space-y-3">
              <input type="hidden" name="location_id" value={location.id} />
              <div className="space-y-1.5">
                <Label htmlFor="employee_name">Name</Label>
                <Input id="employee_name" name="employee_name" required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email (optional)</Label>
                  <Input id="email" name="email" type="email" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="phone">Phone (optional)</Label>
                  <Input id="phone" name="phone" type="tel" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="hire_date">Hire date (optional)</Label>
                  <Input id="hire_date" name="hire_date" type="date" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wage">Wage (optional)</Label>
                  <Input id="wage" name="wage" type="number" step="0.01" min="0" />
                </div>
              </div>
              <SubmitButton pendingLabel="Adding…">Add employee</SubmitButton>
              <p className="text-xs text-slate-500">
                The app assigns an Employee ID automatically.
              </p>
            </form>
          </CardContent>
        </Card>
      </div>

      <ImportErrorBanner label="Time data import failed" error={timeError} />

      <ImportSummaryBanner
        show={showTimeSummary && !timeError}
        title="Time data imported."
        failures={timeFailures}
        warnings={timeWarnings}
      >
        Scheduled: {schedIn} new, {schedUp} updated · Worked: {workIn} new, {workUp} updated.
        {" "}
        Recomputed performance for {recomputed} {recomputed === 1 ? "employee-quarter" : "employee-quarters"}.
        {unknownEmps && (
          <p className="mt-1 text-xs text-emerald-800/80">
            Skipped (no matching active employee): {unknownEmps}
          </p>
        )}
        {inactiveTimeEmps && (
          <p className="mt-1 text-xs text-emerald-800/80">
            Skipped (employee inactive): {inactiveTimeEmps}
          </p>
        )}
        {timeSkippedOtherLocation > 0 && (
          <p className="mt-1 text-xs text-emerald-800/80">
            Skipped {timeSkippedOtherLocation} row{timeSkippedOtherLocation === 1 ? "" : "s"} tagged for other locations.
          </p>
        )}
        {timeDerivedCreated > 0 && (
          <p className="mt-1 text-xs text-emerald-800/80">
            Auto-created {timeDerivedCreated} employee{timeDerivedCreated === 1 ? "" : "s"} from time data
            {timeDerivedFailed > 0 && (
              <> ({timeDerivedFailed} failed)</>
            )}
            .
          </p>
        )}
      </ImportSummaryBanner>

      <Card>
        <CardHeader>
          <CardTitle>Upload time data (scheduled + worked)</CardTitle>
        </CardHeader>
        <CardContent>
          <StorageUploadForm
            action={uploadTimeDataAction}
            fileFields={["scheduled_file", "worked_file"]}
            pendingLabel="Importing & recomputing…"
            submitLabel="Upload time data"
            className="space-y-3"
          >
            <input type="hidden" name="location_id" value={location.id} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="scheduled_file">Scheduled hours CSV</Label>
                <Input
                  id="scheduled_file"
                  name="scheduled_file"
                  type="file"
                  accept=".csv,text/csv"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="worked_file">Worked hours CSV</Label>
                <Input
                  id="worked_file"
                  name="worked_file"
                  type="file"
                  accept=".csv,text/csv"
                />
              </div>
            </div>
            <p className="text-xs text-slate-500">
              Upload both files to recompute attendance, on-time %, and covered shifts. You can
              upload one without the other (e.g., re-upload only worked data after corrections);
              metrics will recompute against whatever data is now in the database. Multiple
              shifts on the same day collapse to one (earliest in, latest out). Inactive
              employees in the data are skipped.
            </p>
            <label className="flex items-start gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                name="derive_employees"
                value="1"
                className="mt-0.5 h-4 w-4"
              />
              <span>
                <strong>Auto-create employees from this time data.</strong> Any
                employee name in the CSV that doesn&apos;t already exist at this
                location is created on the fly with hire date set to their
                earliest worked entry, active = true, wage from the CSV if
                present. Use this when you don&apos;t have a separate employee
                roster CSV available. Leave unchecked if you&apos;ve already
                imported a canonical roster.
              </span>
            </label>
          </StorageUploadForm>
        </CardContent>
      </Card>

      <ImportErrorBanner label="Tattle import failed" error={tattleError} />

      <ImportSummaryBanner
        show={showTattleSummary && !tattleError}
        title="Tattle data imported."
        skippedNote={
          tattleSkippedOtherLocation > 0
            ? `Skipped ${tattleSkippedOtherLocation} survey${tattleSkippedOtherLocation === 1 ? "" : "s"} tagged for other locations.`
            : null
        }
        failures={tattleFailures}
        warnings={tattleWarnings}
      >
        Surveys: {tattleIn} new, {tattleUp} updated · Responses upserted: {tattleResp} ·
        Attributions written: {tattleAtt} ({tattleOnshift} on shift, {tattleWorkday} worked-that-day, {tattleUnatt} unattributed).
        {" "}
        Recomputed performance for {tattleRecomputed} {tattleRecomputed === 1 ? "employee-quarter" : "employee-quarters"}.
      </ImportSummaryBanner>

      <Card>
        <CardHeader>
          <CardTitle>Upload Tattle survey CSV</CardTitle>
        </CardHeader>
        <CardContent>
          <StorageUploadForm
            action={uploadTattleCsvAction}
            fileFields={["file"]}
            pendingLabel="Importing & attributing…"
            submitLabel="Upload tattles"
            className="space-y-3"
          >
            <input type="hidden" name="location_id" value={location.id} />
            <div className="space-y-1.5">
              <Label htmlFor="tattle_file">Tattle responses CSV</Label>
              <Input
                id="tattle_file"
                name="file"
                type="file"
                accept=".csv,text/csv"
                required
              />
              <p className="text-xs text-slate-500">
                Each row in the source CSV is one (tattle_id, category) pair. The importer
                rolls them up to one survey per tattle_id and attributes each survey to the
                employees on shift at the experienced timestamp. If no one was on shift, the
                survey falls back to attribution by anyone who worked that day. Tattle data
                must be uploaded after time data so attribution can resolve correctly.
              </p>
            </div>
          </StorageUploadForm>
        </CardContent>
      </Card>

      <ImportErrorBanner label="Review import failed" error={reviewError} />

      <ImportSummaryBanner
        show={showReviewSummary && !reviewError}
        title="Customer reviews imported."
        skippedNote={
          reviewSkippedOtherLocation > 0
            ? `Skipped ${reviewSkippedOtherLocation} review${reviewSkippedOtherLocation === 1 ? "" : "s"} tagged for other locations.`
            : null
        }
        failures={reviewFailures}
        warnings={reviewWarnings}
      >
        Reviews: {reviewIn} new, {reviewUp} updated · Attributions written: {reviewAtt} ({reviewOnshift} on shift, {reviewWorkday} worked-that-day, {reviewUnatt} unattributed).
        {" "}
        Recomputed performance for {reviewRecomputed} {reviewRecomputed === 1 ? "employee-quarter" : "employee-quarters"}.
      </ImportSummaryBanner>

      <Card>
        <CardHeader>
          <CardTitle>Upload customer reviews CSV</CardTitle>
        </CardHeader>
        <CardContent>
          <StorageUploadForm
            action={uploadCustomerReviewsCsvAction}
            fileFields={["file"]}
            pendingLabel="Importing & attributing…"
            submitLabel="Upload reviews"
            className="space-y-3"
          >
            <input type="hidden" name="location_id" value={location.id} />
            <div className="space-y-1.5">
              <Label htmlFor="review_file">Online reviews CSV (Google, Yelp, etc.)</Label>
              <Input
                id="review_file"
                name="file"
                type="file"
                accept=".csv,text/csv"
                required
              />
              <p className="text-xs text-slate-500">
                Each row is one review. Attribution mirrors tattles: employees on shift at the
                review timestamp get credit; if no one was, the review falls back to anyone
                who worked that day. Yelp reviews are date-only (00:00:00) and always go
                through the worked-that-day fallback.
              </p>
            </div>
          </StorageUploadForm>
        </CardContent>
      </Card>

      <ImportErrorBanner label="Survey import failed" error={surveyError} />

      <ImportSummaryBanner
        show={showSurveySummary && !surveyError}
        title="Survey data imported."
        failures={surveyFailures}
        warnings={surveyWarnings}
      >
        Surveys: {surveyIn} new, {surveyUp} updated · Assignments: {assnIn} new, {assnUp} updated · Matched completions: {surveyMatches} · Recomputed performance for {surveyRecomputed} {surveyRecomputed === 1 ? "employee-quarter" : "employee-quarters"}.
        {matchBreakdown && (
          <p className="mt-1 text-xs text-emerald-800/80 font-mono">
            Match confidence: {matchBreakdown}
          </p>
        )}
        {surveyInactiveSkipped > 0 && (
          <p className="mt-1 text-xs text-emerald-800/80">
            Skipped {surveyInactiveSkipped} time-entry{surveyInactiveSkipped === 1 ? "" : " entries"} from currently-inactive employees (excluded from the engagement pool).
          </p>
        )}
        {surveyUnmatched && (
          <p className="mt-1 text-xs text-amber-800">
            Unmatched typed names (no candidate close enough): {surveyUnmatched}
          </p>
        )}
        {surveyAmbiguous && (
          <p className="mt-1 text-xs text-amber-800">
            Ambiguous matches (skipped — please disambiguate): {surveyAmbiguous}
          </p>
        )}
      </ImportSummaryBanner>

      <Card>
        <CardHeader>
          <CardTitle>Upload survey engagement CSV (7taps)</CardTitle>
        </CardHeader>
        <CardContent>
          <StorageUploadForm
            action={uploadSurveyCsvAction}
            fileFields={["file"]}
            pendingLabel="Importing & recomputing…"
            submitLabel="Upload survey CSV"
            className="space-y-3"
          >
            <input type="hidden" name="location_id" value={location.id} />
            <div className="space-y-1.5">
              <Label htmlFor="survey_file">Survey assignments CSV</Label>
              <Input
                id="survey_file"
                name="file"
                type="file"
                accept=".csv,text/csv"
                required
              />
              <p className="text-xs text-slate-500">
                One row per (employee, survey) with columns: employee_name, survey_title,
                sent_date (YYYY-MM-DD), completed (Yes/No), completion_date, optional
                response_data. Survey engagement % is computed as completed ÷ assigned over
                the quarter the survey was sent in.
              </p>
            </div>
          </StorageUploadForm>
        </CardContent>
      </Card>

      <ImportErrorBanner label="Tasks import failed" error={taskError} />

      <ImportSummaryBanner
        show={showTaskSummary && !taskError}
        title="Tasks imported."
        skippedNote={
          taskSkippedOtherLocation > 0
            ? `Skipped ${taskSkippedOtherLocation} task row${taskSkippedOtherLocation === 1 ? "" : "s"} tagged for other locations.`
            : null
        }
        failures={taskFailures}
        warnings={taskWarnings}
      >
        Tasks: {taskIn} new, {taskUp} updated ({taskDone} complete, {taskUndone} incomplete) ·
        Accountability rows: {taskAcct} ·
        Recomputed performance for {taskRecomputed} {taskRecomputed === 1 ? "employee-quarter" : "employee-quarters"}.
      </ImportSummaryBanner>

      <Card>
        <CardHeader>
          <CardTitle>Upload tasks report CSV</CardTitle>
        </CardHeader>
        <CardContent>
          <StorageUploadForm
            action={uploadTasksCsvAction}
            fileFields={["file"]}
            pendingLabel="Importing & computing accountability…"
            submitLabel="Upload tasks"
            className="space-y-3"
          >
            <input type="hidden" name="location_id" value={location.id} />
            <div className="space-y-1.5">
              <Label htmlFor="task_file">Tasks report CSV</Label>
              <Input
                id="task_file"
                name="file"
                type="file"
                accept=".csv,text/csv"
                required
              />
              <p className="text-xs text-slate-500">
                Each row is one completion event. Multiple rows per task collapse to one
                instance — complete if ANY row is marked Complete. Accountability is
                computed per task instance: any active employee whose worked shift overlaps
                the task window for ≥ 1 hour is accountable. Upload one file at a time
                (e.g., per month) — re-uploading is idempotent and overwrites.
              </p>
            </div>
          </StorageUploadForm>
        </CardContent>
      </Card>

      <ImportErrorBanner label="POS sales import failed" error={posError} />

      <ImportSummaryBanner
        show={showPosSummary && !posError}
        title="POS sales imported."
        skippedNote={
          posSkippedOtherLocation > 0
            ? `Skipped ${posSkippedOtherLocation} row${posSkippedOtherLocation === 1 ? "" : "s"} tagged for other locations.`
            : null
        }
        failures={posFailures}
        warnings={posWarnings}
      >
        Receipts: {posIn} new, {posUp} updated · Split-tender: {posSplit} · Refunds: {posRefunds} ·
        Recomputed performance for {posRecomputed} {posRecomputed === 1 ? "employee-quarter" : "employee-quarters"}
        {posQuarters > 0 && ` across ${posQuarters} ${posQuarters === 1 ? "quarter" : "quarters"}`}.
        {posTeams > 0 && (
          <> Refreshed {posTeams} co-presence team{posTeams === 1 ? "" : "s"} for the Teams view.</>
        )}
      </ImportSummaryBanner>

      <Card>
        <CardHeader>
          <CardTitle>Upload POS sales CSV</CardTitle>
        </CardHeader>
        <CardContent>
          <StorageUploadForm
            action={uploadPOSCsvAction}
            fileFields={["file"]}
            pendingLabel="Importing sales & recomputing tips…"
            submitLabel="Upload POS sales"
            className="space-y-3"
          >
            <input type="hidden" name="location_id" value={location.id} />
            <div className="space-y-1.5">
              <Label htmlFor="pos_file">POS sales &amp; refunds CSV</Label>
              <Input
                id="pos_file"
                name="file"
                type="file"
                accept=".csv,text/csv"
                required
              />
              <p className="text-xs text-slate-500">
                One row per transaction (Ike&apos;s POS export). Split-tender legs
                collapse to one receipt; refunds carry signed values. Tip
                attribution is presence-based — the POS&apos;s &ldquo;Employee&rdquo;
                field is stored for audit but never used for tip math (Ike&apos;s
                pools tips). The $175 cap excludes catering and large group
                orders from the tip-rate baseline. Re-uploading is idempotent —
                same receipt + timestamp upserts in place. Every active employee
                at this location gets their performance row recomputed for every
                quarter the import touches.
              </p>
            </div>
          </StorageUploadForm>
        </CardContent>
      </Card>

      <Card id="bulk-generate">
        <CardHeader>
          <CardTitle>Bulk-generate reports</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500 mb-4">
            Pick a quarter and generate Performance reports for every active
            employee at this location in one click. Each new report supersedes
            the previous one for the same (employee, quarter); the older
            version is still available in the Reports archive marked
            &ldquo;Superseded.&rdquo; Employees with no performance record for
            the chosen quarter (e.g. hired afterwards) are skipped.
          </p>

          {bulkError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 mb-4">
              {bulkError}
            </div>
          )}

          {showBulkSummary && !bulkError && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 mb-4 space-y-1">
              <p>
                <span className="font-semibold">{bulkOk}</span> generated
                {bulkBundled > 0 && (
                  <> ({bulkBundled} with task detail bundled)</>
                )}
                {bulkFailed > 0 && (
                  <>
                    , <span className="font-semibold">{bulkFailed}</span> failed
                  </>
                )}
                {bulkSkippedNoData > 0 && (
                  <>
                    , <span className="font-semibold">{bulkSkippedNoData}</span>{" "}
                    skipped (no performance record for the chosen quarter)
                  </>
                )}
                .
              </p>
              {bulkNoDataNames && (
                <p className="text-xs">Skipped: {bulkNoDataNames}</p>
              )}
              {bulkFailures && (
                <p className="text-xs text-amber-800">Failures: {bulkFailures}</p>
              )}
            </div>
          )}

          {bulkQuarters.length === 0 ? (
            <p className="text-sm text-slate-500">
              No quarters are available yet. Upload time data for this location
              first to populate performance records.
            </p>
          ) : (
            <form
              action={generateBulkLocationReportsAction}
              className="flex flex-wrap items-end gap-3"
            >
              <input type="hidden" name="location_id" value={location.id} />
              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  Quarter
                </label>
                <select
                  name="report_period_id"
                  defaultValue={bulkQuarters[0]?.id ?? ""}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm min-w-[160px]"
                >
                  {bulkQuarters.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.label}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700 mb-1.5">
                <input
                  type="checkbox"
                  name="include_task_detail"
                  value="1"
                  className="h-4 w-4"
                />
                Bundle task detail into each report
              </label>
              <SubmitButton
                variant="outline"
                size="sm"
                pendingLabel="Generating reports…"
              >
                Generate for all {employees?.filter((e) => e.active).length ?? 0} active employees
              </SubmitButton>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Employees ({employees?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {!employees || employees.length === 0 ? (
            <p className="text-sm text-slate-500">No employees yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {employees.map((emp) => (
                <li key={emp.id} className="py-3 flex items-center justify-between">
                  <div>
                    <Link
                      href={`/dashboard/employees/${emp.id}`}
                      className="font-medium hover:underline"
                    >
                      {emp.employee_name}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {emp.employee_code} · {emp.active ? "Active" : "Inactive"}
                      {emp.wage !== null && (
                        <>
                          {" "}
                          · ${Number(emp.wage).toFixed(2)}
                          {emp.wage_pay_type ? ` ${emp.wage_pay_type.toLowerCase()}` : ""}
                        </>
                      )}
                    </p>
                  </div>
                  <span className="text-xs text-slate-500">
                    {emp.hire_date
                      ? `Hired ${new Date(emp.hire_date).toLocaleDateString()}`
                      : "No hire date"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
