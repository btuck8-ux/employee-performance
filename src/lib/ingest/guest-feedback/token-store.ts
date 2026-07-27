/**
 * DB-backed Tattle bearer storage (app_settings, migration 040).
 *
 * The durable Tattle auth path: the nightly Playwright harness
 * (scripts/tattle-nightly/) logs into dashboard.gettattle.com, captures a
 * fresh OIDC access token, and POSTs it to /api/admin/set-tattle-token,
 * which lands it here. tattle-fetch.ts reads this row before falling back to
 * the hand-pasted TATTLE_BEARER_TOKEN env var — so the env var becomes the
 * bootstrap/fallback, not the operational dependency.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export const TATTLE_BEARER_KEY = "tattle_bearer_token";

export async function readStoredTattleBearer(): Promise<string | null> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", TATTLE_BEARER_KEY)
      .maybeSingle();
    if (error) {
      console.warn(`[tattle/token-store] read failed: ${error.message}`);
      return null;
    }
    return (data?.value as string | undefined) ?? null;
  } catch (err) {
    console.warn(
      `[tattle/token-store] read threw: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

export async function storeTattleBearer(token: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("app_settings")
    .upsert(
      { key: TATTLE_BEARER_KEY, value: token, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
  if (error) throw new Error(`app_settings upsert: ${error.message}`);
}
