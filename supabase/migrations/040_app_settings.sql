-- ============================================================================
-- 040_app_settings.sql — small service-role key/value store
-- ============================================================================
-- First consumer: the durable Tattle auth path (handoff 2026-07-27 Part 3).
-- The Tattle bearer used by the guest-feedback harvester expires and its
-- OIDC refresh can't be replayed server-side, so a nightly Playwright harness
-- (scripts/tattle-nightly/) logs into dashboard.gettattle.com, captures a
-- fresh access token, and POSTs it to /api/admin/set-tattle-token — which
-- stores it here (key 'tattle_bearer_token'). tattle-fetch.ts reads this row
-- first and falls back to the TATTLE_BEARER_TOKEN env var, so nothing breaks
-- before the harness is live.
--
-- RLS enabled with NO policies: only the service-role key (server routes) can
-- read/write. Values here are secrets — never expose via anon/authenticated.
--
-- Idempotent. Apply to prod via Supabase MCP for repo<->prod parity.
-- ============================================================================

create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
