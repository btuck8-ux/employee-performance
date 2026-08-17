import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { sendFatalAlert } from "@/lib/ingest/sevenshifts/alert";
import { createAdminClient } from "@/lib/supabase/admin";
import { CSV_UPLOADS_BUCKET } from "@/lib/storage-csv";

/**
 * Orphan-CSV sweeper (Phase 8 follow-up).
 *
 * Deletes objects in `csv-uploads` older than ORPHAN_THRESHOLD_HOURS. Importer
 * actions delete their own upload in a `finally` block immediately after
 * ingest, so anything still in the bucket past the threshold is an abandoned
 * upload (user picked a file, never submitted).
 *
 * Scheduled via `vercel.json` cron (daily, 04:00 UTC). Authenticated via the
 * standard Vercel Cron `Authorization: Bearer <CRON_SECRET>` header — set
 * `CRON_SECRET` in Vercel project env and Vercel forwards it automatically.
 *
 * Returns JSON: `{ swept, bytes_freed, threshold_hours }`.
 */

const ORPHAN_THRESHOLD_HOURS = 24;
const PAGE_SIZE = 1000;

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  // Uniform fatal-alert coverage with the ingest crons: an uncaught throw
  // here (e.g. Storage client dying at the first call) would otherwise 500
  // with Vercel logs as the only evidence.
  try {
    return await sweep();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sweep-csv-uploads] fatal:", message);
    await sendFatalAlert("/api/cron/sweep-csv-uploads", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function sweep() {
  const supabase = createAdminClient();
  const cutoffMs = Date.now() - ORPHAN_THRESHOLD_HOURS * 60 * 60 * 1000;

  const orphanPaths: string[] = [];
  let totalBytes = 0;
  let offset = 0;

  // Paginate the bucket. Storage keys are flat UUIDs (crypto.randomUUID() per
  // submit, see StorageUploadForm.tsx), so no subfolder recursion is needed.
  while (true) {
    const { data, error } = await supabase.storage
      .from(CSV_UPLOADS_BUCKET)
      .list("", {
        limit: PAGE_SIZE,
        offset,
        sortBy: { column: "created_at", order: "asc" },
      });
    if (error) {
      return NextResponse.json(
        {
          error: `Failed to list ${CSV_UPLOADS_BUCKET}: ${error.message}`,
        },
        { status: 500 }
      );
    }
    if (!data || data.length === 0) break;

    for (const obj of data) {
      // Supabase may surface synthetic placeholder rows with no `created_at`
      // when a folder has just been created — guard against those.
      if (!obj.created_at) continue;
      const createdMs = new Date(obj.created_at).getTime();
      if (createdMs > cutoffMs) continue;
      orphanPaths.push(obj.name);
      const size = (obj.metadata as { size?: number } | null)?.size ?? 0;
      totalBytes += size;
    }

    if (data.length < PAGE_SIZE) break;
    offset += data.length;
  }

  if (orphanPaths.length === 0) {
    return NextResponse.json({
      swept: 0,
      bytes_freed: 0,
      threshold_hours: ORPHAN_THRESHOLD_HOURS,
    });
  }

  // Storage `.remove()` takes up to 1000 paths per call. Chunk defensively.
  let deleted = 0;
  for (let i = 0; i < orphanPaths.length; i += PAGE_SIZE) {
    const chunk = orphanPaths.slice(i, i + PAGE_SIZE);
    const { error } = await supabase.storage
      .from(CSV_UPLOADS_BUCKET)
      .remove(chunk);
    if (error) {
      console.warn(
        `[sweep-csv-uploads] partial failure after ${deleted}/${orphanPaths.length}: ${error.message}`
      );
      return NextResponse.json(
        {
          error: error.message,
          swept: deleted,
          attempted: orphanPaths.length,
          bytes_freed_so_far: totalBytes,
        },
        { status: 500 }
      );
    }
    deleted += chunk.length;
  }

  console.log(
    `[sweep-csv-uploads] swept ${deleted} orphans, freed ${totalBytes} bytes (threshold ${ORPHAN_THRESHOLD_HOURS}h)`
  );
  return NextResponse.json({
    swept: deleted,
    bytes_freed: totalBytes,
    threshold_hours: ORPHAN_THRESHOLD_HOURS,
  });
}
