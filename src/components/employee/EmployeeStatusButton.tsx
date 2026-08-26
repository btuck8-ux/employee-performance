"use client";
import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { setEmployeeActiveAction } from "@/app/dashboard/employees/employee-status-actions";

/**
 * Deactivate / reactivate control with a radix-dialog confirm step (the
 * reserved @radix-ui/react-dialog dependency's first adoption, kickoff §5c).
 * Render-gating happens in the server components that mount this; the server
 * action re-checks tier + row scope regardless.
 *
 * §7b (epd_role spec 2026-08-26): when the person holds active rows at
 * other stores, deactivating asks about scope — "Also deactivate at
 * [other stores]?" — and DEFAULTS TO ALL: a departure is a person-level
 * fact (Micah Blakeley is what the alternative produced). The action
 * re-derives the sibling set server-side; the checkbox only carries intent.
 */
export function EmployeeStatusButton({
  employeeId,
  locationId,
  employeeName,
  active,
  returnTo,
  otherActiveStores = [],
}: {
  employeeId: string;
  locationId: string;
  employeeName: string;
  active: boolean;
  returnTo: string;
  /** Names of the person's OTHER active stores (fetchActiveSiblingStoresMap). */
  otherActiveStores?: { locationName: string }[];
}) {
  const [open, setOpen] = React.useState(false);
  const verb = active ? "Deactivate" : "Reactivate";
  const otherNames = otherActiveStores.map((s) => s.locationName).join(", ");
  const askScope = active && otherActiveStores.length > 0;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className={
            active
              ? "text-xs text-red-600 underline-offset-2 hover:underline"
              : "text-xs text-ikes-green-dark underline-offset-2 hover:underline"
          }
        >
          {verb}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[90vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-lg focus:outline-none">
          <Dialog.Title className="text-lg font-semibold">
            {verb} {employeeName}?
          </Dialog.Title>
          <Dialog.Description className="text-sm text-slate-500 mt-2">
            {active
              ? "Inactive employees stop appearing in default lists and stop receiving new time entries from feeds; their history and reports remain."
              : "The employee returns to active lists and feeds resume matching their time entries."}
          </Dialog.Description>
          <form action={setEmployeeActiveAction}>
            {askScope && (
              <label className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <input
                  type="checkbox"
                  name="deactivate_scope"
                  value="all"
                  defaultChecked
                  className="mt-0.5"
                />
                <span>
                  Also deactivate at {otherNames} — a departure is a
                  person-level fact. Uncheck to deactivate at this store only.
                </span>
              </label>
            )}
            <div className="mt-5 flex justify-end gap-3">
              <Dialog.Close asChild>
                <Button type="button" variant="outline" size="sm">
                  Cancel
                </Button>
              </Dialog.Close>
              <input type="hidden" name="employee_id" value={employeeId} />
              <input type="hidden" name="location_id" value={locationId} />
              <input type="hidden" name="next_active" value={active ? "0" : "1"} />
              <input type="hidden" name="return_to" value={returnTo} />
              <Button
                type="submit"
                variant={active ? "destructive" : "default"}
                size="sm"
              >
                {verb}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
