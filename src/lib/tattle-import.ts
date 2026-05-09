import Papa from "papaparse";

/** One CSV row → represents (tattle_id, category) pair. */
interface RawRow {
  tattle_id?: string;
  survey_id?: string;
  category?: string;
  external_id?: string;
  comment?: string;
  positive_factors?: string;
  negative_factors?: string;
  weight?: string;
  tattle_rating?: string;
  tattle_score?: string;
  location?: string;
  datetime_created?: string;
  local_datetime_created?: string;
  local_datetime_experienced?: string;
  locations_id?: string;
}

export interface ParsedTattleResponse {
  category: string;
  weight: number | null;
  comment: string | null;
  positive_factors: string | null;
  negative_factors: string | null;
  raw_row: Record<string, string>;
}

export interface ParsedTattleSurvey {
  external_tattle_id: string;
  external_survey_id: string | null;
  external_location_id: string | null;
  /** Location name from the CSV "location" column, for cross-location filtering. */
  location_label: string | null;
  datetime_experienced: string | null; // ISO timestamp string
  date_experienced: string | null;     // YYYY-MM-DD
  datetime_created: string | null;
  tattle_rating: number | null;        // 1-5
  tattle_score: number | null;         // 0-100 overall
  food_quality_score: number | null;   // weight where category Food Quality
  accuracy_score: number | null;       // weight where category Accuracy
  speed_of_service_score: number | null;
  comments_combined: string | null;
  positive_factors_combined: string | null;
  negative_factors_combined: string | null;
  responses: ParsedTattleResponse[];   // ALL categories preserved (incl. extras)
}

export interface TattleImportResult {
  rows_in_file: number;
  unique_surveys: number;
  warnings: string[];
  errors: string[];
  surveys: ParsedTattleSurvey[];
}

const STANDARD_CATEGORIES = new Set([
  "accuracy",
  "food quality",
  "speed of service",
]);

function cleanText(s: string | undefined): string | null {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  if (!t || t.toLowerCase() === "null") return null;
  return t;
}

function parseNumber(s: string | undefined): number | null {
  const cleaned = cleanText(s);
  if (cleaned === null) return null;
  const n = Number(cleaned.replace(/[$,]/g, ""));
  return Number.isNaN(n) ? null : n;
}

/** Coerce "2026-04-27 15:00:00" (local) into "2026-04-27T15:00:00" ISO-without-Z. */
function normalizeLocalDatetime(s: string | undefined): string | null {
  const cleaned = cleanText(s);
  if (!cleaned) return null;
  // Most rows look like "2026-04-27 15:00:00"
  const m = cleaned.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  if (m) return `${m[1]}T${m[2]}`;
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(cleaned)) return cleaned;
  return cleaned;
}

function dateOnly(iso: string | null): string | null {
  if (!iso) return null;
  return iso.slice(0, 10);
}

export function parseTattleCsv(csvText: string): TattleImportResult {
  const result: TattleImportResult = {
    rows_in_file: 0,
    unique_surveys: 0,
    warnings: [],
    errors: [],
    surveys: [],
  };

  const parsed = Papa.parse<RawRow>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) {
      result.errors.push(`Row ${err.row ?? "?"}: ${err.message}`);
    }
  }

  const rows = parsed.data;
  result.rows_in_file = rows.length;
  if (rows.length === 0) {
    result.errors.push("CSV is empty.");
    return result;
  }

  // Group rows by external_tattle_id
  const byTattle = new Map<string, RawRow[]>();
  for (const row of rows) {
    const tid = cleanText(row.tattle_id);
    if (!tid) continue;
    const list = byTattle.get(tid);
    if (list) list.push(row);
    else byTattle.set(tid, [row]);
  }

  for (const [tid, group] of byTattle) {
    const first = group[0];
    const dt_exp = normalizeLocalDatetime(first.local_datetime_experienced);
    const dt_created = normalizeLocalDatetime(
      first.local_datetime_created ?? first.datetime_created
    );

    const tattle_rating_raw = parseNumber(first.tattle_rating);
    const tattle_score_raw = parseNumber(first.tattle_score);

    let food_quality_score: number | null = null;
    let accuracy_score: number | null = null;
    let speed_of_service_score: number | null = null;

    const responses: ParsedTattleResponse[] = [];
    const commentsAcc: string[] = [];
    const posAcc: string[] = [];
    const negAcc: string[] = [];

    for (const row of group) {
      const category = cleanText(row.category);
      if (!category) continue;
      const norm = category.toLowerCase();
      const weight = parseNumber(row.weight);
      const comment = cleanText(row.comment);
      const pos = cleanText(row.positive_factors);
      const neg = cleanText(row.negative_factors);

      responses.push({
        category,
        weight,
        comment,
        positive_factors: pos,
        negative_factors: neg,
        raw_row: row as Record<string, string>,
      });

      if (norm === "accuracy") accuracy_score = weight;
      else if (norm === "food quality") food_quality_score = weight;
      else if (norm === "speed of service") speed_of_service_score = weight;
      // Other categories (Hospitality, Cleanliness, etc.) are kept in responses
      // but don't feed denormalized columns or scoring.

      if (comment) commentsAcc.push(`[${category}] ${comment}`);
      if (pos) posAcc.push(`[${category}] ${pos}`);
      if (neg) negAcc.push(`[${category}] ${neg}`);
    }

    // Warn if missing the standard 3 categories
    const haveStd = new Set(
      responses.map((r) => r.category.toLowerCase()).filter((c) => STANDARD_CATEGORIES.has(c))
    );
    if (haveStd.size < 3) {
      const missing = ["accuracy", "food quality", "speed of service"].filter(
        (c) => !haveStd.has(c)
      );
      result.warnings.push(
        `Survey ${tid} missing standard categories: ${missing.join(", ")}`
      );
    }

    result.surveys.push({
      external_tattle_id: tid,
      external_survey_id: cleanText(first.survey_id),
      external_location_id: cleanText(first.locations_id),
      location_label: cleanText(first.location),
      datetime_experienced: dt_exp,
      date_experienced: dateOnly(dt_exp),
      datetime_created: dt_created,
      tattle_rating: tattle_rating_raw,
      tattle_score: tattle_score_raw,
      food_quality_score,
      accuracy_score,
      speed_of_service_score,
      comments_combined: commentsAcc.length ? commentsAcc.join("\n") : null,
      positive_factors_combined: posAcc.length ? posAcc.join(" | ") : null,
      negative_factors_combined: negAcc.length ? negAcc.join(" | ") : null,
      responses,
    });
  }

  result.unique_surveys = result.surveys.length;
  return result;
}
