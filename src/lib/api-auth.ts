import { NextResponse } from "next/server";

/**
 * Shared bearer-auth preamble for the cron/admin/feed route handlers
 * (previously copy-pasted per route). Returns the error response to send, or
 * null when authorized. Byte-identical semantics to the inlined originals:
 * missing secret -> 500 `{ error: "<label> not configured" }`, wrong/absent
 * header -> 401 `{ error: "Unauthorized" }`.
 *
 * NOT used by /api/admin/set-tattle-token — its TASKS_HARVEST_TOKEN ??
 * CAKE_HARVEST_TOKEN ?? CRON_SECRET chain is frozen (AGENTS.md).
 */
export function requireBearer(
  request: Request,
  secret: string | undefined,
  label: string
): NextResponse | null {
  if (!secret) {
    return NextResponse.json({ error: `${label} not configured` }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
