import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { readCsvFromStorage, deleteCsvFromStorage } from "@/lib/storage-csv";

/**
 * Shared scaffold for the dashboard CSV upload server actions (the seven
 * upload-*-actions.ts files). The scaffold owns exactly what was copy-pasted:
 * formData extraction, guard redirects, read-from-storage (+ its error
 * redirect), fatal-parse redirect, location/targets fetch, the final banner
 * redirect, and the finally-delete of the staged CSV. Everything per-source
 * (ingest, aggregation, logging, revalidatePath set, banner params) stays in
 * the `run` callback.
 *
 * NOTE: `redirect()` throws NEXT_REDIRECT — the finally-delete runs on every
 * exit path, exactly as the inlined originals did.
 */

export type LocationRow = { id: string; name: string; csv_aliases: string[] | null };
type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Single-location upload: form fields `location_id` + `file_path`. */
export async function runSingleUpload<P>(opts: {
  formData: FormData;
  /** Error searchParam key, e.g. "tattle_error". */
  errorParam: string;
  parse: (text: string) => P;
  /** Return the error string for a fatally-failed parse, else null. */
  fatalParseError: (parsed: P) => string | null;
  /** Ingest + log + revalidate; returns the success-banner params. */
  run: (supabase: Supabase, parsed: P, location: LocationRow) => Promise<URLSearchParams>;
}): Promise<void> {
  const { formData, errorParam } = opts;
  const location_id = String(formData.get("location_id") ?? "");
  const storagePath = String(formData.get("file_path") ?? "");

  if (!location_id) {
    redirect(`/dashboard/locations?${errorParam}=${encodeURIComponent("Missing location.")}`);
  }
  if (!storagePath) {
    redirect(
      `/dashboard/locations/${location_id}?${errorParam}=${encodeURIComponent("No file uploaded.")}`
    );
  }

  const supabase = await createClient();

  let text: string;
  try {
    text = await readCsvFromStorage(supabase, storagePath);
  } catch (err) {
    await deleteCsvFromStorage(supabase, storagePath);
    redirect(
      `/dashboard/locations/${location_id}?${errorParam}=${encodeURIComponent(
        err instanceof Error ? err.message : "Failed to read uploaded file."
      )}`
    );
  }

  try {
    const parsed = opts.parse(text);

    const fatal = opts.fatalParseError(parsed);
    if (fatal !== null) {
      redirect(
        `/dashboard/locations/${location_id}?${errorParam}=${encodeURIComponent(fatal)}`
      );
    }

    const { data: locRow } = await supabase
      .from("locations")
      .select("id, name, csv_aliases")
      .eq("id", location_id)
      .single();
    const location = (locRow as LocationRow | null) ?? {
      id: location_id,
      name: "",
      csv_aliases: null,
    };

    const params = await opts.run(supabase, parsed, location);

    redirect(`/dashboard/locations/${location_id}?${params.toString()}`);
  } finally {
    await deleteCsvFromStorage(supabase, storagePath);
  }
}

/**
 * Bulk upload: form fields `scope` (client|all), `client_id`, `file_path`.
 * The kit resolves targets (`id, name, csv_aliases`, name-ordered, client
 * scoped when asked) and redirects on the empty-targets case; `run` receives
 * them plus the redirect context.
 */
export async function runBulkUpload<P>(opts: {
  formData: FormData;
  /** Error searchParam key, e.g. "bulk_tattle_error". */
  errorParam: string;
  parse: (text: string) => P;
  fatalParseError: (parsed: P) => string | null;
  run: (
    supabase: Supabase,
    parsed: P,
    targets: LocationRow[],
    ctx: { scope: "client" | "all"; client_id: string | null; redirectBase: string }
  ) => Promise<URLSearchParams>;
}): Promise<void> {
  const { formData, errorParam } = opts;
  const scope = String(formData.get("scope") ?? "all") as "client" | "all";
  const client_id = scope === "client" ? String(formData.get("client_id") ?? "") : null;
  const storagePath = String(formData.get("file_path") ?? "");

  const redirectBase =
    scope === "client" && client_id ? `/dashboard/clients/${client_id}` : `/dashboard/uploads`;

  if (!storagePath) {
    redirect(`${redirectBase}?${errorParam}=${encodeURIComponent("No file uploaded.")}`);
  }

  const supabase = await createClient();

  let text: string;
  try {
    text = await readCsvFromStorage(supabase, storagePath);
  } catch (err) {
    await deleteCsvFromStorage(supabase, storagePath);
    redirect(
      `${redirectBase}?${errorParam}=${encodeURIComponent(
        err instanceof Error ? err.message : "Failed to read uploaded file."
      )}`
    );
  }

  try {
    const parsed = opts.parse(text);

    const fatal = opts.fatalParseError(parsed);
    if (fatal !== null) {
      redirect(`${redirectBase}?${errorParam}=${encodeURIComponent(fatal)}`);
    }

    let q = supabase.from("locations").select("id, name, csv_aliases").order("name");
    if (scope === "client" && client_id) q = q.eq("client_id", client_id);
    const { data: targetsRaw } = await q;
    const targets = (targetsRaw ?? []) as LocationRow[];
    if (targets.length === 0) {
      redirect(
        `${redirectBase}?${errorParam}=${encodeURIComponent(
          scope === "client" ? "No locations under this client." : "No locations exist yet."
        )}`
      );
    }

    const params = await opts.run(supabase, parsed, targets, { scope, client_id, redirectBase });

    redirect(`${redirectBase}?${params.toString()}`);
  } finally {
    await deleteCsvFromStorage(supabase, storagePath);
  }
}

/**
 * Bulk helper: count rows whose location label matches NO target name and no
 * target alias (the "truly unmatched" banner stat).
 */
export function countTrulyUnmatched(
  labels: Array<string | null | undefined>,
  targets: LocationRow[]
): number {
  const targetNames = new Set<string>();
  for (const l of targets) {
    targetNames.add(l.name.toLowerCase());
    if (l.csv_aliases) {
      for (const a of l.csv_aliases) {
        if (a) targetNames.add(a.trim().toLowerCase());
      }
    }
  }
  let trulyUnmatched = 0;
  for (const raw of labels) {
    const lbl = (raw ?? "").trim().toLowerCase();
    if (lbl && !targetNames.has(lbl)) trulyUnmatched += 1;
  }
  return trulyUnmatched;
}
