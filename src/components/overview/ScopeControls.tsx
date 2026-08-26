"use client";
import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import { ChevronDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Overview scope controls (kickoff §5a + Tucker's §8-E override): store
 * multi-select (radix dialog with checkboxes + all/none), period picker
 * (radix select), and a custom date-range mode. Selection persists in the
 * URL (?stores=CPD,COS&quarter=…  or  ?from=…&to=…) — shareable, no
 * localStorage, server-component-friendly.
 *
 * WEEKLY PRIMARY (demarcation packet 2026-08-26 §2, Tucker's ruling):
 * "This week" is the default period — no period params in the URL means
 * the current ISO week to date. Quarterly stays available (it grows more
 * useful each quarter as post-floor data accrues); custom ranges remain
 * the most important horizon and are clamped to each store's demarcation
 * floor server-side, with the clamp disclosed, never silent.
 */

export interface StoreOption {
  location_code: string;
  name: string;
}

export interface QuarterOption {
  id: string;
  label: string;
}

export function ScopeControls({
  stores,
  selectedCodes,
  quarters,
  selectedQuarterId,
  rangeFrom,
  rangeTo,
}: {
  stores: StoreOption[];
  selectedCodes: string[];
  quarters: QuarterOption[];
  selectedQuarterId: string | null;
  rangeFrom: string | null;
  rangeTo: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const isRangeMode = !!(rangeFrom && rangeTo);

  const [storesOpen, setStoresOpen] = React.useState(false);
  const [draftCodes, setDraftCodes] = React.useState<string[]>(selectedCodes);
  const [draftFrom, setDraftFrom] = React.useState(rangeFrom ?? "");
  const [draftTo, setDraftTo] = React.useState(rangeTo ?? "");

  const allSelected = selectedCodes.length === stores.length;

  function push(params: {
    codes?: string[];
    quarterId?: string | null;
    from?: string | null;
    to?: string | null;
  }) {
    const q = new URLSearchParams();
    const codes = params.codes ?? selectedCodes;
    if (codes.length > 0 && codes.length < stores.length) {
      q.set("stores", codes.join(","));
    }
    const from = params.from === undefined ? rangeFrom : params.from;
    const to = params.to === undefined ? rangeTo : params.to;
    if (from && to) {
      q.set("from", from);
      q.set("to", to);
    } else {
      const quarterId =
        params.quarterId === undefined ? selectedQuarterId : params.quarterId;
      if (quarterId) q.set("quarter", quarterId);
    }
    router.push(`${pathname}${q.size > 0 ? `?${q}` : ""}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* ---- Store multi-select ---- */}
      <Dialog.Root
        open={storesOpen}
        onOpenChange={(open) => {
          setStoresOpen(open);
          if (open) setDraftCodes(selectedCodes);
        }}
      >
        <Dialog.Trigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            Stores{" "}
            <span className="text-slate-500">
              {allSelected ? "(all)" : `(${selectedCodes.length}/${stores.length})`}
            </span>
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/30 z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[90vw] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-lg focus:outline-none">
            <Dialog.Title className="text-base font-semibold">
              Store scope
            </Dialog.Title>
            <Dialog.Description className="text-xs text-slate-500 mt-1">
              Metrics below average only the checked stores.
            </Dialog.Description>
            <div className="flex gap-3 mt-3 text-xs">
              <button
                type="button"
                className="text-ikes-blue hover:underline"
                onClick={() => setDraftCodes(stores.map((s) => s.location_code))}
              >
                All
              </button>
              <button
                type="button"
                className="text-ikes-blue hover:underline"
                onClick={() => setDraftCodes([])}
              >
                None
              </button>
            </div>
            <ul className="mt-2 space-y-1 max-h-72 overflow-y-auto">
              {stores.map((s) => {
                const checked = draftCodes.includes(s.location_code);
                return (
                  <li key={s.location_code}>
                    <label className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50 cursor-pointer">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[#702F8A]"
                        checked={checked}
                        onChange={(e) =>
                          setDraftCodes((prev) =>
                            e.target.checked
                              ? [...prev, s.location_code]
                              : prev.filter((c) => c !== s.location_code)
                          )
                        }
                      />
                      <span>{s.name}</span>
                      <span className="text-xs text-slate-400">{s.location_code}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="mt-4 flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button variant="outline" size="sm">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button
                size="sm"
                disabled={draftCodes.length === 0}
                onClick={() => {
                  setStoresOpen(false);
                  push({ codes: draftCodes });
                }}
              >
                Apply
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ---- Period picker: This week (default) | quarters | custom ---- */}
      <Select.Root
        value={
          isRangeMode ? "__custom" : (selectedQuarterId ?? "__week")
        }
        onValueChange={(value) => {
          if (value === "__custom") {
            const today = new Date().toISOString().slice(0, 10);
            const monthAgo = new Date();
            monthAgo.setDate(monthAgo.getDate() - 29);
            const from = monthAgo.toISOString().slice(0, 10);
            setDraftFrom(from);
            setDraftTo(today);
            push({ from, to: today });
          } else if (value === "__week") {
            // The default: no period params = this week to date.
            push({ quarterId: null, from: null, to: null });
          } else {
            push({ quarterId: value, from: null, to: null });
          }
        }}
      >
        <Select.Trigger className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-sm hover:bg-slate-50">
          <Select.Value placeholder="Period" />
          <Select.Icon>
            <ChevronDown className="h-3.5 w-3.5" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            position="popper"
            sideOffset={4}
            className="z-50 min-w-40 rounded-md border border-slate-200 bg-white p-1 shadow-md"
          >
            <Select.Viewport>
              <Select.Item
                value="__week"
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-100"
              >
                <Select.ItemText>This week</Select.ItemText>
                <Select.ItemIndicator>
                  <Check className="h-3.5 w-3.5 text-ikes-purple" />
                </Select.ItemIndicator>
              </Select.Item>
              {quarters.map((q) => (
                <Select.Item
                  key={q.id}
                  value={q.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-100"
                >
                  <Select.ItemText>{q.label}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check className="h-3.5 w-3.5 text-ikes-purple" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
              <Select.Item
                value="__custom"
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-100"
              >
                <Select.ItemText>Custom range…</Select.ItemText>
                <Select.ItemIndicator>
                  <Check className="h-3.5 w-3.5 text-ikes-purple" />
                </Select.ItemIndicator>
              </Select.Item>
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>

      {/* ---- Custom range inputs (visible in range mode) ---- */}
      {isRangeMode && (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draftFrom && draftTo && draftFrom <= draftTo) {
              push({ from: draftFrom, to: draftTo });
            }
          }}
        >
          <input
            type="date"
            value={draftFrom}
            onChange={(e) => setDraftFrom(e.target.value)}
            className="rounded-md border border-slate-200 px-2.5 py-1.5 text-sm"
            aria-label="Range start"
          />
          <span className="text-slate-400 text-sm pb-1.5">–</span>
          <input
            type="date"
            value={draftTo}
            onChange={(e) => setDraftTo(e.target.value)}
            className="rounded-md border border-slate-200 px-2.5 py-1.5 text-sm"
            aria-label="Range end"
          />
          <Button type="submit" size="sm" variant="outline">
            Apply
          </Button>
        </form>
      )}
    </div>
  );
}
