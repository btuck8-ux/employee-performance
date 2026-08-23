"use client";
import * as React from "react";
import { SubmitButton } from "@/components/ui/submit-button";
import { inviteUserAction } from "@/app/dashboard/admin/users/actions";

/**
 * Invite form for the Users surface (2026-08-23 §4-D2/D5). Client component
 * only because the scope fields react to the chosen role; ids come from the
 * server page (never hardcoded), humans see names, the form submits ids.
 * Invitation-only: there is deliberately no credential field of any kind —
 * the invitee sets their own on first sign-in (§4-D3).
 */

export interface UserInviteFormProps {
  territories: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string }>;
  employees: Array<{ id: string; label: string }>;
}

const ROLE_OPTIONS = [
  { value: "system_admin", label: "System Admin — everything, all clients" },
  { value: "regional_admin", label: "Regional Admin — one territory" },
  { value: "area_admin", label: "Area Admin — a set of locations" },
  { value: "manager", label: "Manager — one location" },
  { value: "user", label: "User — self-scoped (optional employee link)" },
];

const inputCls =
  "w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm";

export function UserInviteForm({
  territories,
  locations,
  employees,
}: UserInviteFormProps) {
  const [role, setRole] = React.useState("");

  return (
    <form action={inviteUserAction} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Email</label>
          <input type="email" name="email" required className={inputCls} />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">
            Confirm email
          </label>
          <input
            type="email"
            name="email_confirm"
            required
            className={inputCls}
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-slate-500 mb-1">Role</label>
        <select
          name="role"
          required
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className={inputCls}
        >
          <option value="">Pick a role…</option>
          {ROLE_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {role === "regional_admin" && (
        <div>
          <label className="block text-xs text-slate-500 mb-1">Territory</label>
          <select name="territory_id" required className={inputCls}>
            <option value="">Pick a territory…</option>
            {territories.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {role === "area_admin" && (
        <fieldset>
          <legend className="block text-xs text-slate-500 mb-1">
            Locations (pick at least one)
          </legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {locations.map((l) => (
              <label key={l.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="location_ids" value={l.id} />
                {l.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {role === "manager" && (
        <div>
          <label className="block text-xs text-slate-500 mb-1">Location</label>
          <select name="location_id" required className={inputCls}>
            <option value="">Pick a location…</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {role === "user" && (
        <div>
          <label className="block text-xs text-slate-500 mb-1">
            Link to employee (optional)
          </label>
          <select name="employee_id" className={inputCls}>
            <option value="">No link</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-slate-400">
          Sends a Supabase Auth invitation — the invitee sets their own
          credentials. Accounts that already hold a role are refused, never
          modified.
        </p>
        <SubmitButton size="sm" pendingLabel="Inviting…">
          Send invite
        </SubmitButton>
      </div>
    </form>
  );
}
