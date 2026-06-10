/**
 * Source A — Tattle Snapshot responses (handoff §2, merchant 2685).
 *
 * Endpoint (captured live 2026-06-10):
 *   GET https://gettattle.com/v2/api/data/snapshots/raw-responses-csv
 *       ?merchants_id=<merchant>&start=YYYY-MM-DD&end=YYYY-MM-DD
 * Despite the `-csv` name it returns JSON `{ meta, data:[…] }`; each `data[]`
 * row already matches parseTattleCsv's RawRow column shape (tattle_id, survey_id,
 * category, …, location, locations_id). One call covers all locations — the row
 * `location` field distinguishes stores.
 *
 * To honor the handoff mandate ("reuse the existing parsers — they own the
 * dedup/grouping/normalization"), we DON'T hand-map JSON into ParsedTattleSurvey.
 * Instead we serialize `data[]` back into the importer's CSV column shape with
 * Papa.unparse and feed it through parseTattleCsv — identical grouping to the
 * manual upload path.
 *
 * Pagination: meta.pagination.page_size was 30000; if page_count > 1 we fetch
 * the extra pages with `&page=N` and concatenate before unparsing.
 */

import Papa from "papaparse";
import { parseTattleCsv, type TattleImportResult } from "@/lib/tattle-import";
import { TATTLE_MERCHANT_ID } from "./secrets";
import { tattleFetch } from "./tattle-fetch";

const SNAPSHOTS_URL =
  "https://gettattle.com/v2/api/data/snapshots/raw-responses-csv";

/** The RawRow columns parseTattleCsv reads, in importer order (handoff §1). */
const TATTLE_COLUMNS = [
  "tattle_id",
  "survey_id",
  "category",
  "external_id",
  "comment",
  "positive_factors",
  "negative_factors",
  "weight",
  "tattle_rating",
  "tattle_score",
  "location",
  "datetime_created",
  "local_datetime_created",
  "local_datetime_experienced",
  "locations_id",
] as const;

interface SnapshotResponse {
  meta?: {
    pagination?: {
      page?: number;
      page_size?: number;
      page_count?: number;
      total?: number;
    };
  };
  data?: Array<Record<string, unknown>>;
}

function buildUrl(merchantId: string, start: string, end: string, page?: number): string {
  const url = new URL(SNAPSHOTS_URL);
  url.searchParams.set("merchants_id", merchantId);
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);
  if (page && page > 1) url.searchParams.set("page", String(page));
  return url.toString();
}

/** Normalize a JSON data[] row to the importer's string-keyed CSV shape. */
function toCsvRow(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const col of TATTLE_COLUMNS) {
    const v = row[col];
    out[col] = v === null || v === undefined ? "" : String(v);
  }
  return out;
}

/**
 * Fetch all Tattle snapshot rows for [start, end] (YYYY-MM-DD), serialize to the
 * importer CSV shape, and parse via parseTattleCsv. Returns the same
 * TattleImportResult the manual upload produces, ready for ingestTattlesForLocation.
 */
export async function fetchTattleSnapshots(
  start: string,
  end: string
): Promise<TattleImportResult> {
  const merchantId = TATTLE_MERCHANT_ID;
  const allRows: Array<Record<string, unknown>> = [];

  const firstRes = await tattleFetch(buildUrl(merchantId, start, end));
  const firstBody = (await firstRes.json()) as SnapshotResponse;
  for (const r of firstBody.data ?? []) allRows.push(r);

  const pageCount = firstBody.meta?.pagination?.page_count ?? 1;
  for (let page = 2; page <= pageCount; page += 1) {
    const res = await tattleFetch(buildUrl(merchantId, start, end, page));
    const body = (await res.json()) as SnapshotResponse;
    for (const r of body.data ?? []) allRows.push(r);
  }

  const csv = Papa.unparse(
    { fields: [...TATTLE_COLUMNS], data: allRows.map(toCsvRow) },
    { quotes: true }
  );
  return parseTattleCsv(csv);
}
