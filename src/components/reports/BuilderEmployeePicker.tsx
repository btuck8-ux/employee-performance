"use client";
import { useMemo, useState } from "react";

export interface BuilderEmployee {
  id: string;
  name: string;
  code: string;
}

/**
 * Employee checklist for the Reports builder (§5-D: type-to-filter search
 * over the already-loaded list — client-side filter only, the list itself is
 * server-loaded). Also owns the §5-C manager-feedback TEXT field, which the
 * locked decision scopes to a single-employee quarterly run: the field
 * renders only when exactly one employee is checked (multi-employee runs get
 * it disabled — the delegated micro-call; the server action enforces the
 * same rule regardless). The include/exclude section toggle lives with the
 * other content toggles, not here — it applies to bulk runs too.
 *
 * Checkbox semantics are unchanged from the server-rendered original:
 * none checked = every active employee (the bulk case).
 */
export function BuilderEmployeePicker({
  employees,
  defaultSelectedId,
}: {
  employees: BuilderEmployee[];
  defaultSelectedId?: string;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(
        defaultSelectedId && employees.some((e) => e.id === defaultSelectedId)
          ? [defaultSelectedId]
          : []
      )
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter(
      (e) =>
        e.name.toLowerCase().includes(q) || e.code.toLowerCase().includes(q)
    );
  }, [employees, query]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-slate-500">
          Employees ({employees.length} active — none checked = all)
        </p>
        {/* Filter input is display-only: no name attribute, never submitted. */}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type to filter…"
          className="rounded-md border border-slate-300 px-2 py-1 text-xs min-w-[180px]"
        />
        <button
          type="button"
          onClick={() => setSelected(new Set())}
          className="text-xs text-slate-600 underline"
        >
          Clear selection
        </button>
        {selected.size > 0 && (
          <span className="text-xs text-slate-500">{selected.size} selected</span>
        )}
      </div>
      {/* Submission rides these state-driven hidden inputs, NOT the visible
          checkboxes — a checked employee filtered out of view unmounts their
          checkbox, and losing that value would flip the submit into the
          "none checked = all active" bulk path (Codex PR-2 finding 1). */}
      {[...selected].map((id) => (
        <input key={id} type="hidden" name="employee_ids" value={id} />
      ))}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-1 max-h-56 overflow-y-auto rounded-md border border-slate-200 p-3">
        {visible.map((e) => (
          <label
            key={e.id}
            className="flex items-center gap-2 text-sm py-0.5 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={selected.has(e.id)}
              onChange={() => toggle(e.id)}
              className="h-4 w-4 accent-[#702F8A]"
            />
            <span className="truncate">{e.name}</span>
          </label>
        ))}
        {visible.length === 0 && (
          <p className="text-xs text-slate-500 col-span-full">
            No employees match “{query}”. Checked employees stay selected while
            filtered out of view.
          </p>
        )}
      </div>

      {selected.size === 1 && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 space-y-1">
          <label className="block text-xs font-medium text-slate-700">
            Manager feedback (optional)
          </label>
          <textarea
            name="manager_feedback_text"
            rows={3}
            placeholder="Leave empty to keep the stored feedback unchanged."
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
          <p className="text-xs text-slate-500">
            Saves to this employee&apos;s quarter record — it stays on their
            profile and all future reports until edited again. Applies to
            quarterly runs only; leaving it empty never clears stored
            feedback. Use the &quot;Manager feedback section&quot; toggle
            above to keep it off this PDF.
          </p>
        </div>
      )}
    </div>
  );
}
