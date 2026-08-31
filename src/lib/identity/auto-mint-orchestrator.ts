/**
 * Auto-mint run orchestration: classify, enforce the cap, mint, audit.
 *
 * Logs ONE ingest_runs row per run under source 'auto_mint' with a null
 * location_id — this is an estate-wide scan, not a per-store fan-out.
 *
 * ⚠️ THE CAP IS THE SAFETY PROPERTY. If the candidate count exceeds
 * BLAST_RADIUS_CAP the job mints NOTHING and reports. Do not "just mint the
 * first ten" — a run that large means the input changed shape, and a partial
 * mint would leave the estate in a state nobody chose.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { createCpClient } from "@/lib/ingest/culture-pulse/client";
import { startRun, finishRun } from "@/lib/ingest/sevenshifts/runs";
import { sendFatalAlert } from "@/lib/ingest/sevenshifts/alert";
import {
  loadAutoMintPool,
  BLAST_RADIUS_CAP,
  type AutoMintCandidate,
  type AutoMintResult,
} from "./auto-mint";

export interface AutoMintOptions {
  /** Classify and report without writing. Used by the admin dry-run route. */
  dryRun?: boolean;
  /** Override the cap for an operator-supervised catch-up run. */
  cap?: number;
}

export async function runAutoMint(
  options: AutoMintOptions = {}
): Promise<AutoMintResult> {
  const startedAt = new Date().toISOString();
  const epd = createAdminClient();
  const cp = createCpClient();
  const cap = options.cap ?? BLAST_RADIUS_CAP;
  const dryRun = options.dryRun ?? false;

  const runId = dryRun
    ? null
    : await startRun(epd, "auto_mint", null, startedAt, null);

  const result: AutoMintResult = {
    started_at: startedAt,
    finished_at: startedAt,
    minted: [],
    blast_radius_tripped: false,
    candidates_seen: 0,
    archived_new: [],
    archived_acknowledged: 0,
    unmappable: [],
    guard_rejected: 0,
    errors: [],
  };

  try {
    const pool = await loadAutoMintPool(cp, epd);
    result.candidates_seen = pool.candidates.length;
    result.guard_rejected = pool.guardRejected;
    result.unmappable = pool.unmappable;
    result.archived_new = pool.archived.filter((a) => !a.acknowledged);
    result.archived_acknowledged = pool.archived.filter((a) => a.acknowledged).length;

    if (pool.candidates.length > cap) {
      // Mint NOTHING. This is the designed outcome, not a failure to recover
      // from — an operator decides what a run this size should do.
      result.blast_radius_tripped = true;
      result.errors.push(
        `Blast radius ${pool.candidates.length} exceeds cap ${cap} — minted nothing. ` +
          `Candidates: ${pool.candidates
            .map((c) => `${c.sevenShiftsUserId}@${c.locationCode}`)
            .join(", ")}`
      );
    } else if (!dryRun) {
      for (const c of pool.candidates) {
        try {
          const minted = await mintOne(epd, c, runId);
          if (minted) result.minted.push(minted);
        } catch (err) {
          result.errors.push(
            `${c.name} (${c.sevenShiftsUserId}@${c.locationCode}): ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }

    result.finished_at = new Date().toISOString();
    await finishRun(epd, runId, {
      status: result.blast_radius_tripped
        ? "error"
        : result.minted.length > 0
          ? "success"
          : "empty",
      rows_in: pool.candidates.length,
      rows_upserted: result.minted.length,
      rows_skipped:
        pool.unmappable.length + pool.guardRejected + pool.archived.length,
      detail: {
        minted: result.minted,
        blast_radius_tripped: result.blast_radius_tripped,
        cap,
        archived_new: result.archived_new,
        archived_acknowledged: result.archived_acknowledged,
        unmappable: result.unmappable,
        guard_rejected: result.guard_rejected,
        errors: result.errors.slice(0, 20),
      },
      error_text: result.errors.length > 0 ? result.errors.slice(0, 3).join(" | ") : null,
      window_end: result.finished_at,
    });

    // Escalations that need a human tonight, not at the next digest read.
    if (result.blast_radius_tripped) {
      await sendFatalAlert(
        "/api/cron/auto-mint",
        `Blast radius tripped: ${pool.candidates.length} candidates > cap ${cap}. Nothing minted.`
      );
    } else if (result.unmappable.length > 0) {
      await sendFatalAlert(
        "/api/cron/auto-mint",
        `${result.unmappable.length} scheduled person(s) at a CP location with no EPD crosswalk — skipped, never guessed.`
      );
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    result.finished_at = new Date().toISOString();
    await finishRun(epd, runId, {
      status: "error",
      error_text: message,
      window_end: result.finished_at,
    });
    throw err;
  }
}

/**
 * Mint one employee and write its audit row.
 *
 * employee_code is NEVER set here — the employee_code_seq DEFAULT owns it
 * (mig 004). epd_role is NEVER set here — the 'unclassified' DEFAULT owns it,
 * and a 7shifts role string must never be translated into one ('MOD' covers a
 * GM and three shift leads). is_general_manager stays false.
 *
 * A 23505 here is the per-store unique index
 * (employees_location_seven_shifts_user_id_key) catching a race with the
 * manual triage page — treated as "someone else already minted this", not an
 * error, exactly as the triage action does.
 */
async function mintOne(
  epd: ReturnType<typeof createAdminClient>,
  c: AutoMintCandidate,
  runId: string | null
): Promise<{ employee_code: string; name: string; location_code: string } | null> {
  const { data, error } = await epd
    .from("employees")
    .insert({
      location_id: c.locationId,
      employee_name: c.name,
      email: c.email,
      seven_shifts_user_id: c.sevenShiftsUserId,
    })
    .select("id, employee_code")
    .single();

  if (error) {
    if (error.code === "23505") return null; // raced with a manual mint
    throw new Error(error.message);
  }

  // Audit AFTER the mint, and never let an audit failure roll back or mask a
  // successful mint — but do surface it loudly, because an unlogged
  // unattended write is exactly what this table exists to prevent.
  const { error: logError } = await epd.from("employee_auto_mint_log").insert({
    employee_id: data.id,
    employee_code: data.employee_code,
    employee_name: c.name,
    seven_shifts_user_id: c.sevenShiftsUserId,
    location_id: c.locationId,
    cp_location_id: c.cpLocationId,
    email: c.email,
    trigger_row: c.triggerRow,
    run_id: runId,
  });
  if (logError) {
    console.error(
      `[auto-mint] MINTED ${data.employee_code} BUT AUDIT LOG FAILED: ${logError.message}`
    );
  }

  return {
    employee_code: data.employee_code as string,
    name: c.name,
    location_code: c.locationCode,
  };
}
