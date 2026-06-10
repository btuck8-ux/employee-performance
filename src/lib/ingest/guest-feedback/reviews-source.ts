/**
 * Source B — Online Reviews (handoff §2, merchant 2685).
 *
 * Endpoint (captured live 2026-06-10):
 *   POST https://api.tattleapp.io/v3/api/merchants/<merchant>/SocialMediaReview/export
 *   body: { merchantId, startDate, endDate, locationIds:[], groupIds:[], questionnaireIds:[] }
 *         (empty arrays = all locations/groups/questionnaires)
 *   → 200 { downloadLinks: ["https://cdn.tattleapp.io/reports/social_media…"], expiresAt }
 *
 * The signed `downloadLinks[0]` is CORS-blocked in-browser but self-authorizes
 * server-side, so we fetch it WITHOUT the bearer → CSV → parseCustomerReviewsCsv.
 * Same Tattle Bearer as Source A guards the export POST (tattleFetch handles
 * the 401/403 → refresh/SessionExpired path).
 */

import { parseCustomerReviewsCsv, type ReviewImportResult } from "@/lib/customer-review-import";
import { TATTLE_MERCHANT_ID } from "./secrets";
import { tattleFetch } from "./tattle-fetch";

interface ExportResponse {
  downloadLinks?: string[];
  expiresAt?: string;
}

function exportUrl(merchantId: string): string {
  return `https://api.tattleapp.io/v3/api/merchants/${merchantId}/SocialMediaReview/export`;
}

/**
 * Fetch all online reviews for [startDate, endDate] (YYYY-MM-DD): request the
 * export, follow the signed download link to its CSV, and parse via
 * parseCustomerReviewsCsv. Returns the same ReviewImportResult the manual
 * upload produces, ready for ingestReviewsForLocation.
 */
export async function fetchReviews(
  startDate: string,
  endDate: string
): Promise<ReviewImportResult> {
  const merchantId = TATTLE_MERCHANT_ID;

  const res = await tattleFetch(exportUrl(merchantId), {
    method: "POST",
    body: {
      merchantId: Number(merchantId),
      startDate,
      endDate,
      locationIds: [],
      groupIds: [],
      questionnaireIds: [],
    },
  });
  const body = (await res.json()) as ExportResponse;
  const link = body.downloadLinks?.[0];
  if (!link) {
    // No link = nothing exported for the window. Return an empty parse result
    // rather than throwing, so the source logs `empty`, not `error`.
    return {
      rows_in_file: 0,
      unique_reviews: 0,
      warnings: ["Reviews export returned no download link (no reviews in window)."],
      errors: [],
      reviews: [],
    };
  }

  // The signed CDN link self-authorizes — plain fetch, no bearer.
  const csvRes = await fetch(link);
  if (!csvRes.ok) {
    const t = await csvRes.text().catch(() => "");
    throw new Error(
      `Reviews download ${csvRes.status} ${csvRes.statusText}: ${t.slice(0, 300)}`
    );
  }
  const csv = await csvRes.text();
  return parseCustomerReviewsCsv(csv);
}
