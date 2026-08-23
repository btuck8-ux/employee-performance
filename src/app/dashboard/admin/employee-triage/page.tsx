import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import { createCpClient } from "@/lib/ingest/culture-pulse/client";
import { fetchPendingDetections } from "@/lib/triage/detections";
import { enrichDetections } from "@/lib/triage/enrich";
import { DetectionCard } from "@/components/triage/DetectionCard";

/**
 * SA-only detected-employee triage (kickoff-employee-triage-mint-ui
 * 2026-08-21): CP's uncoded schedule-feed detections, enriched from the
 * 7shifts user-detail endpoint, each reviewable and mintable via the
 * confirm card. Server component — the CP bridge client and 7shifts tokens
 * stay on this side of the boundary; DetectionCard gets plain values only.
 * The ./actions.ts server actions re-check system_admin independently.
 */

export default async function EmployeeTriagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const { role, supabase } = await getSessionRole();
  if (role !== "system_admin") redirect("/dashboard");

  const cp = createCpClient();
  const detections = await fetchPendingDetections(cp, supabase);
  const enrichment = await enrichDetections(supabase, detections);

  const str = (v: string | string[] | undefined): string | null =>
    typeof v === "string" && v ? v : null;
  const minted = search.minted === "1";
  const already = search.already === "1";
  const dismissed = search.dismissed === "1";
  const bannerName = str(search.name);
  const bannerCode = str(search.code);
  const bannerSite = str(search.site);
  const error = str(search.error);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Detected employees
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          People CP&apos;s schedule feed found working shifts without an
          employee code. Review each card, fix any typos, and confirm to mint —
          or dismiss false detections. {detections.length} pending.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {error}
        </div>
      )}
      {minted && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {bannerName ?? "Employee"} is now {bannerCode ?? "on the roster"}
          {bannerSite ? ` at ${bannerSite}` : ""}.
        </div>
      )}
      {already && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          {bannerName ?? "This person"} was already minted
          {bannerCode ? ` as ${bannerCode}` : ""}
          {bannerSite ? ` at ${bannerSite}` : ""} — nothing to do.
        </div>
      )}
      {dismissed && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Dismissed {bannerName ?? "detection"}
          {bannerSite ? ` at ${bannerSite}` : ""} — it won&apos;t reappear
          there. The same person detected at another site stays visible.
        </div>
      )}

      {detections.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No new detections — everyone on the schedule has a code.
        </div>
      ) : (
        <div className="space-y-4">
          {detections.map((d) => {
            const e = enrichment.get(d.cpId);
            return (
              <DetectionCard
                key={d.cpId}
                name={d.name}
                email={d.email}
                phone={d.phone}
                sevenShiftsUserId={d.sevenShiftsUserId}
                firstSeenAt={d.firstSeenAt}
                lastSeenAt={d.lastSeenAt}
                locationId={d.location?.id ?? null}
                locationName={d.location?.name ?? null}
                similar={d.similar}
                mintedElsewhere={d.mintedElsewhere}
                wage={e?.wage ?? null}
                wagePayType={e?.wagePayType ?? null}
                enrichError={e?.error ?? null}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
