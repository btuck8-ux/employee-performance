"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";

/**
 * "Generated this visit" viewer (kickoff §5e): inline PDF display via the
 * scope-checked /api/reports/[id] route (it 302s to a short-lived signed
 * URL). Printing uses a new tab — the PDF renders from the storage origin,
 * so a cross-origin iframe can't be scripted into window.print().
 */
export interface GeneratedReportItem {
  id: string;
  label: string;
}

export function ReportViewer({ reports }: { reports: GeneratedReportItem[] }) {
  const [activeId, setActiveId] = React.useState<string | null>(
    reports[0]?.id ?? null
  );

  if (reports.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {reports.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setActiveId(r.id)}
            className={
              activeId === r.id
                ? "rounded-md bg-ikes-purple px-3 py-1.5 text-xs font-medium text-white"
                : "rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs hover:bg-slate-50"
            }
          >
            {r.label}
          </button>
        ))}
      </div>
      {activeId && (
        <>
          <div className="flex gap-2">
            <Button asChild size="sm" variant="outline">
              <a
                href={`/api/reports/${activeId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in new tab / print
              </a>
            </Button>
          </div>
          <iframe
            key={activeId}
            src={`/api/reports/${activeId}`}
            title="Generated report"
            className="w-full h-[70vh] rounded-md border border-slate-200 bg-white"
          />
        </>
      )}
    </div>
  );
}
