import Papa from "papaparse";

interface RawRow {
  reviewid?: string;
  locationid?: string;
  locationlabel?: string;
  locationexternalid?: string;
  providername?: string;
  rating?: string;
  reviewer?: string;
  reviewtext?: string;
  reviewurl?: string;
  reviewdate?: string;
  responsetext?: string;
  responsedate?: string;
  responsestatus?: string;
  responseusername?: string;
  responsetype?: string;
}

export interface ParsedReview {
  external_review_id: string;
  provider_name: string | null;
  external_location_id: string | null;
  external_location_label: string | null;
  rating: number | null;
  reviewer: string | null;
  review_text: string | null;
  review_url: string | null;
  review_datetime: string | null; // "YYYY-MM-DDTHH:MM:SS"
  review_date: string | null;     // "YYYY-MM-DD"
  response_text: string | null;
  response_datetime: string | null;
  response_status: string | null;
  response_username: string | null;
  response_type: string | null;
}

export interface ReviewImportResult {
  rows_in_file: number;
  unique_reviews: number;
  warnings: string[];
  errors: string[];
  reviews: ParsedReview[];
}

function cleanText(s: string | undefined): string | null {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  if (!t) return null;
  return t;
}

function parseNumber(s: string | undefined): number | null {
  const cleaned = cleanText(s);
  if (cleaned === null) return null;
  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n;
}

function normalizeLocalDatetime(s: string | undefined): string | null {
  const cleaned = cleanText(s);
  if (!cleaned) return null;
  const m = cleaned.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  if (m) return `${m[1]}T${m[2]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return `${cleaned}T00:00:00`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(cleaned)) return cleaned;
  return cleaned;
}

function dateOnly(iso: string | null): string | null {
  if (!iso) return null;
  return iso.slice(0, 10);
}

export function parseCustomerReviewsCsv(csvText: string): ReviewImportResult {
  const result: ReviewImportResult = {
    rows_in_file: 0,
    unique_reviews: 0,
    warnings: [],
    errors: [],
    reviews: [],
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

  const seen = new Set<string>();
  for (const row of rows) {
    const reviewId = cleanText(row.reviewid);
    if (!reviewId) {
      result.warnings.push("Skipped row missing reviewid.");
      continue;
    }
    if (seen.has(reviewId)) {
      // Last occurrence wins
      result.reviews = result.reviews.filter((r) => r.external_review_id !== reviewId);
    }
    seen.add(reviewId);

    const reviewDt = normalizeLocalDatetime(row.reviewdate);
    const responseDt = normalizeLocalDatetime(row.responsedate);

    result.reviews.push({
      external_review_id: reviewId,
      provider_name: cleanText(row.providername),
      external_location_id: cleanText(row.locationexternalid),
      external_location_label: cleanText(row.locationlabel),
      rating: parseNumber(row.rating),
      reviewer: cleanText(row.reviewer),
      review_text: cleanText(row.reviewtext),
      review_url: cleanText(row.reviewurl),
      review_datetime: reviewDt,
      review_date: dateOnly(reviewDt),
      response_text: cleanText(row.responsetext),
      response_datetime: responseDt,
      response_status: cleanText(row.responsestatus),
      response_username: cleanText(row.responseusername),
      response_type: cleanText(row.responsetype),
    });
  }

  result.unique_reviews = result.reviews.length;
  return result;
}
