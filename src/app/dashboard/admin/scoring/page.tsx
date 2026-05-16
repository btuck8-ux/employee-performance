import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { fetchCustomerServiceWeights } from "@/lib/customer-service-score";
import { createClient } from "@/lib/supabase/server";
import { updateCustomerServiceWeightsAction } from "./actions";

// Recompute fan-out can touch every (employee × quarter) row, which on the
// largest dataset runs ~25 employees × ~4 quarters × ~5 RPC calls per. Reuse
// the same 300s ceiling used by POS upload actions.
export const maxDuration = 300;

export default async function ScoringAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const supabase = await createClient();
  const weights = await fetchCustomerServiceWeights(supabase);

  const error = typeof search.error === "string" ? search.error : null;
  const saved = search.saved === "1";
  const recomputed =
    typeof search.recomputed === "string" ? search.recomputed : null;
  const failures = typeof search.failures === "string" ? search.failures : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Scoring</h1>
        <p className="text-sm text-slate-500 mt-1">
          Admin-only settings for the Customer Service Score composite.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {error}
        </div>
      )}
      {saved && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Weights saved.
          {recomputed !== null && (
            <>
              {" "}
              Recomputed {recomputed} performance record
              {recomputed === "1" ? "" : "s"}
              {failures && Number(failures) > 0
                ? ` (${failures} failed — check server logs)`
                : ""}
              .
            </>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Customer Service Score weights</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600 mb-4">
            Three component weights blend into a single 0–100 composite per
            employee per quarter. They must sum to <strong>1.000</strong>{" "}
            (enforced by a CHECK constraint at the database level). Changing
            weights affects every stored composite; tick &quot;Recompute&quot;
            to refresh all <code>performance_records</code> in one pass.
          </p>

          <form
            action={updateCustomerServiceWeightsAction}
            className="space-y-4 max-w-xl"
          >
            <WeightInput
              label="Tattle"
              name="weight_tattle"
              defaultValue={weights.weight_tattle}
              hint="Tattle survey rating, 0.40 default"
            />
            <WeightInput
              label="Customer reviews"
              name="weight_reviews"
              defaultValue={weights.weight_reviews}
              hint="Google / Yelp rating, 0.40 default"
            />
            <WeightInput
              label="Tip-rate delta"
              name="weight_tip"
              defaultValue={weights.weight_tip}
              hint="Tip-rate vs location avg (±2pp window), 0.20 default"
            />

            <p className="text-xs text-slate-500">
              Current sum:{" "}
              <span className="font-medium tabular-nums">
                {(
                  weights.weight_tattle +
                  weights.weight_reviews +
                  weights.weight_tip
                ).toFixed(3)}
              </span>{" "}
              (must equal 1.000 to save)
            </p>

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                name="recompute"
                value="1"
                defaultChecked={true}
                className="h-4 w-4"
              />
              Recompute all performance records after saving
            </label>

            <div className="flex justify-end">
              <SubmitButton pendingLabel="Saving + recomputing…">
                Save weights
              </SubmitButton>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reference: spec snapshot</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="text-sm text-slate-700 space-y-1.5 list-disc list-inside">
            <li>
              <strong>Normalization:</strong> ratings use <code>(rating − 1) /
              4 × 100</code>. Tip uses <code>(delta + 2) / 4 × 100</code>,
              clamped to [0, 100].
            </li>
            <li>
              <strong>Bands:</strong> Green ≥ 85 · Yellow 70–&lt;85 · Red
              &lt; 70 (same for composite AND per-component).
            </li>
            <li>
              <strong>Null handling:</strong> ≥2 of 3 components present →
              composite with pro-rata re-weight; 1 of 3 → single-source
              annotation; 0 of 3 → em-dash.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function WeightInput({
  label,
  name,
  defaultValue,
  hint,
}: {
  label: string;
  name: string;
  defaultValue: number;
  hint: string;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[160px,1fr] gap-2 sm:items-center">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <div>
        <input
          id={name}
          name={name}
          type="number"
          step="0.001"
          min="0"
          max="1"
          defaultValue={defaultValue.toFixed(3)}
          required
          className="w-32 rounded-md border border-slate-300 px-3 py-1.5 text-sm tabular-nums focus:border-slate-500 focus:outline-none"
        />
        <p className="text-xs text-slate-500 mt-0.5">{hint}</p>
      </div>
    </div>
  );
}
