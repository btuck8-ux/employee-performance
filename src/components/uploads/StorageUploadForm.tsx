"use client";
import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

interface StorageUploadFormProps {
  /**
   * Server action invoked once every file in `fileFields` has been uploaded
   * to csv-uploads/. The FormData passed in has each original `<input
   * type=file name="X">` replaced by a hidden `X_path` string field whose
   * value is the storage object key.
   */
  action: (formData: FormData) => Promise<unknown>;
  /**
   * Names of the file inputs inside `children` whose contents should be
   * uploaded to Storage before the action is called. Inputs left empty (no
   * file selected) are silently skipped — matches the time-data importer
   * which accepts either or both of two CSVs.
   */
  fileFields: readonly string[];
  pendingLabel?: string;
  submitLabel: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

/**
 * Phase 8 wrapper. The browser uploads each chosen CSV straight to the
 * csv-uploads/ Supabase bucket, then calls the server action with the
 * storage key — bypassing the 4.5 MB Vercel lambda body cap that the old
 * FormData path tripped on DT's 4.6 MB POS export.
 */
export function StorageUploadForm({
  action,
  fileFields,
  pendingLabel = "Working…",
  submitLabel,
  className,
  children,
}: StorageUploadFormProps) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<{
    name: string;
    index: number;
    total: number;
  } | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);

    const form = e.currentTarget;
    const formData = new FormData(form);

    // Phase 1 — upload files. Bail out on any upload error.
    try {
      const supabase = createClient();
      const filesToUpload: Array<{ field: string; file: File }> = [];
      for (const fieldName of fileFields) {
        const value = formData.get(fieldName);
        // Drop the raw file from FormData so it doesn't try to ride along.
        formData.delete(fieldName);
        if (value instanceof File && value.size > 0) {
          filesToUpload.push({ field: fieldName, file: value });
        }
      }

      let i = 0;
      for (const { field, file } of filesToUpload) {
        i += 1;
        setProgress({ name: file.name, index: i, total: filesToUpload.length });
        const safeName = file.name
          .replace(/[^a-zA-Z0-9._-]+/g, "_")
          .slice(-80);
        const key = `${crypto.randomUUID()}-${safeName}`;
        const { error: upErr } = await supabase.storage
          .from("csv-uploads")
          .upload(key, file, {
            contentType: file.type || "text/csv",
            upsert: false,
          });
        if (upErr) {
          throw new Error(`Upload failed for ${file.name}: ${upErr.message}`);
        }
        formData.set(`${field}_path`, key);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
      setPending(false);
      setProgress(null);
      return;
    }

    setProgress(null);

    // Phase 2 — invoke the server action. The action's normal completion path
    // calls `redirect()`, which Next.js surfaces to the client as a thrown
    // RedirectError. Because importers redirect to the SAME URL (a soft
    // revalidation of the current page), this component does NOT unmount —
    // it re-renders with the new server data. Without `finally`, the throw
    // would skip `setPending(false)` and the button would stay locked in its
    // "pending" state forever (observed on DT POS 2026-05-16).
    try {
      await action(formData);
    } finally {
      setPending(false);
      setProgress(null);
    }
  }

  return (
    <form onSubmit={handleSubmit} className={className}>
      {children}
      {error && (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      {progress && (
        <p className="text-xs text-slate-500">
          {progress.total > 1
            ? `Uploading ${progress.index} of ${progress.total}: ${progress.name}…`
            : `Uploading ${progress.name}…`}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {pendingLabel}
          </>
        ) : (
          submitLabel
        )}
      </Button>
    </form>
  );
}
