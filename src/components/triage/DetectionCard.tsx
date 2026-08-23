"use client";
import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  confirmDetectionAction,
  dismissDetectionAction,
} from "@/app/dashboard/admin/employee-triage/actions";

/**
 * "Detected new employee — is this correct?" review card (kickoff §3b).
 *
 * Client component so name/email/phone are editable pre-confirm (the CP copy
 * may carry typos; the admin is the review layer). Everything else is
 * display-only: site comes from the crosswalk (a wrong site is an upstream
 * data problem, not an edit), the 7shifts id is the matching key, and the
 * wage line is 7shifts enrichment that rides hidden fields into the mint.
 * Props are plain serializable values — CP bridge credentials never reach
 * this boundary. The server actions re-check system_admin regardless.
 */

export interface DetectionCardProps {
  name: string;
  email: string | null;
  phone: string | null;
  sevenShiftsUserId: number | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
  locationId: string | null;
  locationName: string | null;
  similar: Array<{ employee_code: string; employee_name: string }>;
  /** Other sites already holding this 7shifts id (§4-A4 second-site mints). */
  mintedElsewhere: Array<{ locationName: string; employeeCode: string | null }>;
  wage: number | null;
  wagePayType: string | null;
  enrichError: string | null;
}

/** Deterministic YYYY-MM-DD — avoids locale hydration mismatches. */
function datePart(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

function Field({
  label,
  name,
  defaultValue,
  type = "text",
}: {
  label: string;
  name: string;
  defaultValue: string;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-slate-500 mb-1">{label}</label>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue}
        className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
      />
    </div>
  );
}

export function DetectionCard(props: DetectionCardProps) {
  const {
    name,
    email,
    phone,
    sevenShiftsUserId,
    firstSeenAt,
    lastSeenAt,
    locationId,
    locationName,
    similar,
    mintedElsewhere,
    wage,
    wagePayType,
    enrichError,
  } = props;
  const [dismissOpen, setDismissOpen] = React.useState(false);

  const isPhantom = sevenShiftsUserId === 0;
  const mintable = sevenShiftsUserId !== null && sevenShiftsUserId > 0 && locationId !== null;
  const dismissable = sevenShiftsUserId !== null && sevenShiftsUserId >= 0;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{name}</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Detected new employee — is this correct?
          </p>
        </div>
        <div className="text-right text-xs text-slate-500 shrink-0">
          <div>
            7shifts id:{" "}
            <span className="font-mono text-slate-700">
              {sevenShiftsUserId ?? "—"}
            </span>
          </div>
          <div>
            First seen {datePart(firstSeenAt)} · last seen {datePart(lastSeenAt)}
          </div>
        </div>
      </div>

      {mintedElsewhere.length > 0 && (
        <div className="rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          Already on the roster at{" "}
          {mintedElsewhere
            .map((m) =>
              m.employeeCode
                ? `${m.locationName} (${m.employeeCode})`
                : m.locationName
            )
            .join(", ")}
          . Confirming mints a separate code for{" "}
          {locationName ?? "this site"} — one person working two sites is two
          roster rows by design.
        </div>
      )}

      {similar.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Similar name already on roster:{" "}
          {similar
            .map((s) => `${s.employee_name} (${s.employee_code})`)
            .join(", ")}{" "}
          — confirm this is a different person.
        </div>
      )}

      {isPhantom && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          7shifts user 0 is a known phantom detection — it can only be
          dismissed, never minted.
        </div>
      )}
      {locationId === null && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          This CP location isn&apos;t in the location crosswalk — fix the
          upstream mapping before minting.
        </div>
      )}
      {!isPhantom && sevenShiftsUserId === null && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          No usable 7shifts user id on this detection — it can&apos;t be minted
          or dismissed until CP carries one.
        </div>
      )}

      <form action={confirmDetectionAction} className="space-y-4">
        {/* The site is NOT posted — the action re-derives it from CP + the
            crosswalk (location is display-only, never client input). */}
        <input
          type="hidden"
          name="seven_shifts_user_id"
          value={sevenShiftsUserId ?? ""}
        />
        <input type="hidden" name="wage" value={wage ?? ""} />
        <input type="hidden" name="wage_pay_type" value={wagePayType ?? ""} />

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name" name="employee_name" defaultValue={name} />
          <Field
            label="Email"
            name="email"
            defaultValue={email ?? ""}
            type="email"
          />
          <Field label="Phone" name="phone" defaultValue={phone ?? ""} />
        </div>

        <div className="text-sm text-slate-600 space-y-1">
          <div>
            Site: <span className="font-medium">{locationName ?? "Unknown"}</span>{" "}
            <span className="text-xs text-slate-400">
              (from the schedule crosswalk — a wrong site is fixed upstream, not
              here)
            </span>
          </div>
          <div>
            Wage (7shifts):{" "}
            {wage !== null ? (
              <span className="font-medium tabular-nums">
                ${wage.toFixed(2)}
                {wagePayType ? ` ${wagePayType.toLowerCase()}` : ""}
              </span>
            ) : (
              <span className="text-slate-400">
                not available{enrichError ? " (7shifts detail unreachable)" : ""}
              </span>
            )}{" "}
            {wage !== null && (
              <span className="text-xs text-slate-400">— written at mint</span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3">
          <Dialog.Root open={dismissOpen} onOpenChange={setDismissOpen}>
            <Dialog.Trigger asChild>
              <button
                type="button"
                disabled={!dismissable}
                className="text-xs text-red-600 underline-offset-2 hover:underline disabled:text-slate-300 disabled:no-underline"
              >
                Not an employee / ignore
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
              <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[90vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-lg focus:outline-none">
                <Dialog.Title className="text-lg font-semibold">
                  Dismiss {name}
                  {locationName ? ` at ${locationName}` : ""}?
                </Dialog.Title>
                <Dialog.Description className="text-sm text-slate-500 mt-2">
                  The detection disappears from this page for{" "}
                  {locationName ?? "this site"} only and no employee code is
                  minted — the same person detected at another site stays
                  visible. Use this for phantom or one-off schedule artifacts;
                  a real hire should be confirmed instead.
                </Dialog.Description>
                <div className="mt-5 flex justify-end gap-3">
                  <Dialog.Close asChild>
                    <Button type="button" variant="outline" size="sm">
                      Cancel
                    </Button>
                  </Dialog.Close>
                  <form action={dismissDetectionAction}>
                    <input
                      type="hidden"
                      name="seven_shifts_user_id"
                      value={sevenShiftsUserId ?? ""}
                    />
                    <input type="hidden" name="employee_name" value={name} />
                    <SubmitButton
                      variant="destructive"
                      size="sm"
                      pendingLabel="Dismissing…"
                    >
                      Dismiss
                    </SubmitButton>
                  </form>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <SubmitButton
            size="sm"
            disabled={!mintable}
            pendingLabel="Minting…"
          >
            Confirm — mint employee code
          </SubmitButton>
        </div>
      </form>
    </div>
  );
}
