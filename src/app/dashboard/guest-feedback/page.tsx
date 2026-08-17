import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExpandableText } from "@/components/guest-feedback/ExpandableText";
import { getSessionRole } from "@/lib/authz";
import { formatRating } from "@/lib/format";

/**
 * Guest Feedback — EPD's own customer_reviews + tattle_surveys tables, one
 * page with two sub-tabs (locked decision 2026-08-17: not a merged feed).
 *
 * Every query rides the AUTHENTICATED server client: the post-047 read
 * policies trim rows to the session's purview, so there is no service-role
 * import anywhere on this page. A location-less session (uninvited sign-in,
 * user tier with no link) simply sees empty tabs — that's a state, not an
 * error. Both tables are unbounded, so both tabs paginate server-side.
 */

type SearchParams = Record<string, string | string[] | undefined>;

function pickStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

const PAGE_SIZE = 50;
const DEFAULT_WINDOW_DAYS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/** 1-based page param, safe-integer guarded (the /api/scores/range pattern). */
function parsePage(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return 1;
  return n;
}

function pageHref(
  tab: "reviews" | "tattles",
  store: string,
  from: string,
  to: string,
  pageParam: string,
  page: number
): string {
  const params = new URLSearchParams({ tab, from, to });
  if (store) params.set("store", store);
  params.set(pageParam, String(page));
  return `/dashboard/guest-feedback?${params.toString()}`;
}

export default async function GuestFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const search = await searchParams;
  const tab = pickStr(search.tab) === "tattles" ? "tattles" : "reviews";
  const fromParam = pickStr(search.from);
  const toParam = pickStr(search.to);
  let from = DATE_RE.test(fromParam)
    ? fromParam
    : isoDateDaysAgo(DEFAULT_WINDOW_DAYS);
  let to = DATE_RE.test(toParam) ? toParam : isoDateDaysAgo(0);
  // An inverted range is a typo, not a request for the empty set.
  if (from > to) [from, to] = [to, from];
  const reviewsPage = parsePage(pickStr(search.rpage));
  const tattlesPage = parsePage(pickStr(search.tpage));

  const { supabase } = await getSessionRole();

  // Store filter options = the session's purview (RLS trims the read).
  const { data: locationRows } = await supabase
    .from("locations")
    .select("id, name")
    .order("name");
  const locations = (locationRows ?? []).map((l) => ({
    id: l.id as string,
    name: l.name as string,
  }));
  const locationName = new Map(locations.map((l) => [l.id, l.name]));
  // An out-of-purview (or stale) store param is ignored, not errored.
  const storeParam = pickStr(search.store);
  const store = locationName.has(storeParam) ? storeParam : "";
  const multiStore = locations.length > 1;

  // ---- Online Reviews page ----
  const buildReviewsQ = (page: number) => {
    let q = supabase
      .from("customer_reviews")
      .select(
        "id, review_date, location_id, rating, provider_name, reviewer, review_text, review_url, response_status",
        { count: "exact" }
      )
      .gte("review_date", from)
      .lte("review_date", to)
      .order("review_date", { ascending: false })
      .order("id", { ascending: true })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    if (store) q = q.eq("location_id", store);
    return q;
  };
  const reviewsFirst = await buildReviewsQ(reviewsPage);
  const reviewCount = reviewsFirst.count;
  let reviewRows = reviewsFirst.data;
  let reviewsError = reviewsFirst.error;
  const reviewPages = Math.max(1, Math.ceil((reviewCount ?? 0) / PAGE_SIZE));
  // A page param past the end (stale link, hand-edited URL) clamps to the
  // last real page instead of presenting a false "no rows" state.
  let reviewsPageEff = reviewsPage;
  if (!reviewsError && (reviewCount ?? 0) > 0 && reviewsPage > reviewPages) {
    reviewsPageEff = reviewPages;
    ({ data: reviewRows, error: reviewsError } = await buildReviewsQ(reviewPages));
  }

  // ---- Tattle Surveys page ----
  const buildTattlesQ = (page: number) => {
    let q = supabase
      .from("tattle_surveys")
      .select(
        "id, date_experienced, location_id, tattle_rating, food_quality_score, accuracy_score, speed_of_service_score, comments_combined",
        { count: "exact" }
      )
      .gte("date_experienced", from)
      .lte("date_experienced", to)
      .order("date_experienced", { ascending: false })
      .order("id", { ascending: true })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    if (store) q = q.eq("location_id", store);
    return q;
  };
  const tattlesFirst = await buildTattlesQ(tattlesPage);
  const tattleCount = tattlesFirst.count;
  let tattleRows = tattlesFirst.data;
  let tattlesError = tattlesFirst.error;
  const tattlePages = Math.max(1, Math.ceil((tattleCount ?? 0) / PAGE_SIZE));
  let tattlesPageEff = tattlesPage;
  if (!tattlesError && (tattleCount ?? 0) > 0 && tattlesPage > tattlePages) {
    tattlesPageEff = tattlePages;
    ({ data: tattleRows, error: tattlesError } = await buildTattlesQ(tattlePages));
  }

  const reviews = (reviewRows ?? []).map((r) => ({
    id: r.id as string,
    review_date: (r.review_date as string | null) ?? "—",
    store: locationName.get(r.location_id as string) ?? "—",
    rating: r.rating as number | string | null,
    provider_name: (r.provider_name as string | null) ?? "—",
    reviewer: (r.reviewer as string | null) ?? "—",
    review_text: (r.review_text as string | null) ?? "",
    review_url: r.review_url as string | null,
    response_status: (r.response_status as string | null) ?? null,
  }));
  const tattles = (tattleRows ?? []).map((t) => ({
    id: t.id as string,
    date_experienced: (t.date_experienced as string | null) ?? "—",
    store: locationName.get(t.location_id as string) ?? "—",
    tattle_rating: t.tattle_rating as number | null,
    food_quality_score: t.food_quality_score as number | string | null,
    accuracy_score: t.accuracy_score as number | string | null,
    speed_of_service_score: t.speed_of_service_score as number | string | null,
    comments: (t.comments_combined as string | null) ?? "",
  }));

  const filterForm = (forTab: "reviews" | "tattles") => (
    <form method="get" className="flex flex-wrap items-end gap-3 mb-4">
      <input type="hidden" name="tab" value={forTab} />
      {multiStore && (
        <div>
          <label className="block text-xs text-slate-500 mb-1">Store</label>
          <select
            name="store"
            defaultValue={store}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm min-w-[180px]"
          >
            <option value="">All stores</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label className="block text-xs text-slate-500 mb-1">From</label>
        <input
          type="date"
          name="from"
          defaultValue={from}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="block text-xs text-slate-500 mb-1">To</label>
        <input
          type="date"
          name="to"
          defaultValue={to}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        />
      </div>
      <button
        type="submit"
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
      >
        Apply
      </button>
      <Link
        href={`/dashboard/guest-feedback?tab=${forTab}`}
        className="text-xs text-slate-600 underline self-center"
      >
        Reset
      </Link>
    </form>
  );

  const pager = (
    forTab: "reviews" | "tattles",
    page: number,
    pages: number,
    total: number,
    pageParam: string
  ) =>
    total > 0 && (
      <div className="flex items-center gap-3 mt-4 text-sm text-slate-600">
        {page > 1 ? (
          <Link
            href={pageHref(forTab, store, from, to, pageParam, page - 1)}
            className="underline hover:text-slate-900"
          >
            ← Newer
          </Link>
        ) : (
          <span className="text-slate-300">← Newer</span>
        )}
        <span className="text-xs">
          Page {Math.min(page, pages)} of {pages} · {total} total
        </span>
        {page < pages ? (
          <Link
            href={pageHref(forTab, store, from, to, pageParam, page + 1)}
            className="underline hover:text-slate-900"
          >
            Older →
          </Link>
        ) : (
          <span className="text-slate-300">Older →</span>
        )}
      </div>
    );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Guest Feedback</h1>
        <p className="text-sm text-slate-500 mt-1">
          Online reviews and Tattle surveys across your stores. Attribution to
          individual employees lives on each profile — this is the raw guest
          voice, store by store.
        </p>
      </div>

      <Tabs defaultValue={tab}>
        <TabsList>
          <TabsTrigger value="reviews">Online Reviews</TabsTrigger>
          <TabsTrigger value="tattles">Tattle Surveys</TabsTrigger>
        </TabsList>

        <TabsContent value="reviews">
          <Card>
            <CardHeader>
              <CardTitle>Online Reviews</CardTitle>
              <CardDescription>
                {from} → {to}
                {store ? ` · ${locationName.get(store)}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {filterForm("reviews")}
              {reviewsError ? (
                <p className="text-sm text-red-700">
                  Couldn&apos;t load reviews: {reviewsError.message}
                </p>
              ) : reviews.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No online reviews in this window. Review flow is legitimately
                  sparse at some stores — try widening the date range.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-slate-500 uppercase border-b border-slate-200">
                      <tr>
                        <th className="py-2 pr-4">Date</th>
                        {multiStore && <th className="py-2 pr-4">Store</th>}
                        <th className="py-2 pr-4">Rating</th>
                        <th className="py-2 pr-4">Source</th>
                        <th className="py-2 pr-4">Reviewer</th>
                        <th className="py-2 pr-4">Review</th>
                        <th className="py-2 pr-4">Response</th>
                        <th className="py-2 pr-4"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reviews.map((r) => (
                        <tr key={r.id} className="align-top">
                          <td className="py-2 pr-4 whitespace-nowrap">
                            {r.review_date}
                          </td>
                          {multiStore && (
                            <td className="py-2 pr-4 whitespace-nowrap">
                              {r.store}
                            </td>
                          )}
                          <td className="py-2 pr-4 whitespace-nowrap">
                            {formatRating(r.rating)} / 5
                          </td>
                          <td className="py-2 pr-4 whitespace-nowrap">
                            {r.provider_name}
                          </td>
                          <td className="py-2 pr-4">{r.reviewer}</td>
                          <td className="py-2 pr-4 max-w-md">
                            {r.review_text ? (
                              <ExpandableText text={r.review_text} />
                            ) : (
                              <span className="text-slate-400">
                                (no text — rating only)
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-4 whitespace-nowrap text-xs text-slate-600">
                            {r.response_status ?? "—"}
                          </td>
                          <td className="py-2 pr-4 whitespace-nowrap">
                            {r.review_url && (
                              <a
                                href={r.review_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs underline hover:text-slate-900"
                              >
                                Open ↗
                              </a>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {pager("reviews", reviewsPageEff, reviewPages, reviewCount ?? 0, "rpage")}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tattles">
          <Card>
            <CardHeader>
              <CardTitle>Tattle Surveys</CardTitle>
              <CardDescription>
                {from} → {to}
                {store ? ` · ${locationName.get(store)}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {filterForm("tattles")}
              {tattlesError ? (
                <p className="text-sm text-red-700">
                  Couldn&apos;t load surveys: {tattlesError.message}
                </p>
              ) : tattles.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No Tattle surveys in this window — try widening the date
                  range.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-slate-500 uppercase border-b border-slate-200">
                      <tr>
                        <th className="py-2 pr-4">Experienced</th>
                        {multiStore && <th className="py-2 pr-4">Store</th>}
                        <th className="py-2 pr-4">Overall</th>
                        <th className="py-2 pr-4">Food quality</th>
                        <th className="py-2 pr-4">Accuracy</th>
                        <th className="py-2 pr-4">Speed</th>
                        <th className="py-2 pr-4">Comments</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {tattles.map((t) => (
                        <tr key={t.id} className="align-top">
                          <td className="py-2 pr-4 whitespace-nowrap">
                            {t.date_experienced}
                          </td>
                          {multiStore && (
                            <td className="py-2 pr-4 whitespace-nowrap">
                              {t.store}
                            </td>
                          )}
                          <td className="py-2 pr-4 whitespace-nowrap">
                            {formatRating(t.tattle_rating)} / 5
                          </td>
                          <td className="py-2 pr-4 whitespace-nowrap">
                            {formatRating(t.food_quality_score)}
                          </td>
                          <td className="py-2 pr-4 whitespace-nowrap">
                            {formatRating(t.accuracy_score)}
                          </td>
                          <td className="py-2 pr-4 whitespace-nowrap">
                            {formatRating(t.speed_of_service_score)}
                          </td>
                          <td className="py-2 pr-4 max-w-md">
                            {t.comments ? (
                              <ExpandableText text={t.comments} />
                            ) : (
                              <span className="text-slate-400">
                                (no comments)
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {pager("tattles", tattlesPageEff, tattlePages, tattleCount ?? 0, "tpage")}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
