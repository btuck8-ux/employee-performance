import { NextResponse } from "next/server";
import { storeTattleBearer } from "@/lib/ingest/guest-feedback/token-store";

/**
 * Receive a fresh Tattle bearer from the nightly Playwright harness
 * (scripts/tattle-nightly/) and stash it in app_settings (migration 040),
 * where tattle-fetch.ts reads it before falling back to the hand-pasted
 * TATTLE_BEARER_TOKEN env var. This is what makes Tattle/Reviews stop
 * depending on a human re-pasting a token (handoff 2026-07-27 Part 3a).
 *
 * AUTH: Bearer — TASKS_HARVEST_TOKEN / CAKE_HARVEST_TOKEN (the harness
 * family token) or CRON_SECRET. /api/admin/* is middleware-exempt.
 *
 * BODY: JSON { "token": "<access token>" } or the raw token as text/plain.
 */

export const dynamic = "force-dynamic";

/** Decode a JWT's exp claim for the response log; null if not a JWT. */
function jwtExpiry(token: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString()
    ) as { exp?: number };
    return payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const secret =
    process.env.TASKS_HARVEST_TOKEN ??
    process.env.CAKE_HARVEST_TOKEN ??
    process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "harvest token not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const contentType = request.headers.get("content-type") ?? "";
    let token: string;
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { token?: string };
      token = (body.token ?? "").trim();
    } else {
      token = (await request.text()).trim();
    }
    if (token.length < 20) {
      return NextResponse.json(
        { error: "Body must carry the Tattle access token (JSON {token} or raw text)." },
        { status: 400 }
      );
    }

    await storeTattleBearer(token);
    const expires = jwtExpiry(token);
    console.log(`[set-tattle-token] stored fresh bearer (exp ${expires ?? "unknown"})`);
    return NextResponse.json({ ok: true, token_expires: expires });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[set-tattle-token] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
