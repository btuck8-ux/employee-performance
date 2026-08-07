import type { ReactNode } from "react";

/**
 * Shared shells for the post-upload searchParam banners (locations/[id],
 * uploads, clients/[id]). The per-source stat sentence stays at the call site
 * as children; these own only the div/paragraph chrome that was copy-pasted.
 * The searchParam→toast rework is a separate, future project — these preserve
 * the current rendered DOM exactly.
 */

/** Red failure banner; renders nothing without an error. */
export function ImportErrorBanner({
  label,
  error,
}: {
  /** e.g. "Tattle import failed" */
  label: string;
  error: string | null;
}) {
  if (!error) return null;
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <strong>{label}:</strong> {error}
    </div>
  );
}

/**
 * Emerald success banner. `children` is the per-source stat sentence (and any
 * source-specific paragraphs). The three optional props render the common
 * trailing paragraphs in the shared order skipped → failures → warnings; a
 * call site whose original order differs inlines its paragraphs in children
 * instead.
 */
export function ImportSummaryBanner({
  show,
  title,
  children,
  skippedNote,
  failures,
  warnings,
}: {
  show: boolean;
  /** e.g. "Tattle data imported." */
  title: string;
  children: ReactNode;
  skippedNote?: string | null;
  failures?: string | null;
  warnings?: string | null;
}) {
  if (!show) return null;
  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
      <strong>{title}</strong> {children}
      {skippedNote && <p className="mt-1 text-xs text-emerald-800/80">{skippedNote}</p>}
      {failures && <p className="mt-1 text-xs text-red-700">Failures: {failures}</p>}
      {warnings && <p className="mt-1 text-xs text-emerald-800/80">Warnings: {warnings}</p>}
    </div>
  );
}
