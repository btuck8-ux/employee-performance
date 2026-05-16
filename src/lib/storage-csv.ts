import type { createClient } from "@/lib/supabase/server";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

export const CSV_UPLOADS_BUCKET = "csv-uploads";

/**
 * Phase 8 — direct-to-Storage upload pipeline.
 *
 * Importer server actions receive a `*_path` field instead of the file body
 * (browser uploads the CSV straight to csv-uploads/, then submits the path).
 * Sidesteps the 4.5 MB Vercel lambda body cap.
 */

export async function readCsvFromStorage(
  supabase: SupabaseServer,
  path: string
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(CSV_UPLOADS_BUCKET)
    .download(path);
  if (error || !data) {
    throw new Error(
      `Failed to download ${path} from ${CSV_UPLOADS_BUCKET}: ${error?.message ?? "no data"}`
    );
  }
  return await data.text();
}

/** Best-effort cleanup — logs but never throws. */
export async function deleteCsvFromStorage(
  supabase: SupabaseServer,
  path: string
): Promise<void> {
  if (!path) return;
  const { error } = await supabase.storage
    .from(CSV_UPLOADS_BUCKET)
    .remove([path]);
  if (error) {
    console.warn(
      `[storage-csv] failed to delete ${path} from ${CSV_UPLOADS_BUCKET}: ${error.message}`
    );
  }
}
