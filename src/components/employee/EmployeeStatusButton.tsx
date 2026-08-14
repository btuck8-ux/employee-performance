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
 */
export function EmployeeStatusButton({
  employeeId,
  locationId,
  employeeName,
  active,
  returnTo,
}: {
  employeeId: string;
  locationId: string;
  employeeName: string;
  active: boolean;
  returnTo: string;
}) {
  const [open, setOpen] = React.useState(false);
  const verb = active ? "Deactivate" : "Reactivate";

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
          <div className="mt-5 flex justify-end gap-3">
            <Dialog.Close asChild>
              <Button type="button" variant="outline" size="sm">
                Cancel
              </Button>
            </Dialog.Close>
            <form action={setEmployeeActiveAction}>
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
            </form>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
