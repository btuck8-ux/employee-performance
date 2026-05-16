import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { fetchCustomerServiceWeights } from "@/lib/customer-service-score";
import { fetchTotalImpactWeights } from "@/lib/total-impact-score";
import { createClient } from "@/lib/supabase/server";
import {
  updateCustomerServiceWeightsAction,
  updateTotalImpactWeightsAction,
} from "./actions";

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
  const tisWeights = await fetchTotalImpactWeights(supabase);

  const error = typeof search.error === "string" ? search.error : null;
  const saved = search.saved === "1";
  const recomputed =
    typeof search.recomputed === "string" ? search.recomputed : null;
  const failures = typeof search.failures === "string" ? search.failures : null;
  const tisError = typeof search.tis_error === "string" ? search.tis_error : null;
  const tisSaved = search.tis_saved === "1";
  const tisRecomputed =
    typeof search.tis_recomputed === "string" ? search.tis_recomputed : null;
  const tisFailures =
    typeof search.tis_failures === "string" ? search.tis_failures : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Scoring</h1>
        <p className="text-sm text-slate-500 mt-1">
          Admin-only settings for the Customer Service Score and Total Impact
          Score composites.
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

      {tisError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {tisError}
        </div>
      )}
      {tisSaved && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Total Impact Score weights saved.
          {tisRecomputed !== null && (
            <>
              {" "}
              Recomputed {tisRecomputed} performance record
              {tisRecomputed === "1" ? "" : "s"}
              {tisFailures && Number(tisFailures) > 0
                ? ` (${tisFailures} failed — check server logs)`
                : ""}
              .
            </>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Total Impact Score weights</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600 mb-4">
            Five component weights blend into a single 0–100 composite per
            employee per quarter. They must sum to <strong>1.000</strong>
            {" "}(enforced by a CHECK constraint at the database level). The
            Customer Service Score itself unrolls into Tattle / Reviews / Tip
            using its own weights above. Changing TIS weights affects every
            stored composite; tick &quot;Recompute&quot; to refresh all{" "}
            <code>performance_records</code> in one pass.
          </p>

          <form
            action={updateTotalImpactWeightsAction}
            className="space-y-4 max-w-xl"
          >
            <WeightInput
              label="Customer Service"
              name="weight_cs_score"
              defaultValue={tisWeights.weight_cs_score}
              hint="Phase 9 CS Score composite, 0.40 default"
            />
            <WeightInput
              label="Attendance"
              name="weight_attendance"
              defaultValue={tisWeights.weight_attendance}
              hint="attendance_pct, 0.15 default"
            />
            <WeightInput
              label="On-time (grace)"
              name="weight_on_time"
              defaultValue={tisWeights.weight_on_time}
              hint="on_time_grace_pct (3-min grace), 0.15 default"
            />
            <WeightInput
              label="Task completion"
              name="weight_tasks"
              defaultValue={tisWeights.weight_tasks}
              hint="avg_task_list_completion_pct, 0.15 default"
            />
            <WeightInput
              label="Survey engagement"
              name="weight_survey"
              defaultValue={tisWeights.weight_survey}
              hint="survey_engagement_pct (7taps), 0.15 default"
            />

            <p className="text-xs text-slate-500">
              Current sum:{" "}
              <span className="font-medium tabular-nums">
                {(
                  tisWeights.weight_cs_score +
                  tisWeights.weight_attendance +
                  tisWeights.weight_on_time +
                  tisWeights.weight_tasks +
                  tisWeights.weight_survey
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
                Save TIS weights
              </SubmitButton>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reference: TIS spec snapshot</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="text-sm text-slate-700 space-y-1.5 list-disc list-inside">
            <li>
              <strong>Components:</strong> CS Score · Attendance · On-time
              (grace) · Avg task-list completion · Survey engagement. All
              five are already on a 0–100 scale; defensive clamp to [0, 100]
              before weighting.
            </li>
            <li>
              <strong>Bands:</strong> Green ≥ 85 · Yellow 70–&lt;85 · Red
              &lt; 70 (matches CS Score).
            </li>
            <li>
              <strong>Null handling:</strong> ≥4 of 5 components present →
              composite with pro-rata re-weight; &lt; 4 → em-dash + not
              ranked. CS Score&apos;s single-source state (Phase 9 1-of-3)
              counts as NULL for the 5-component check.
            </li>
            <li>
              <strong>Eligibility for ranking:</strong> Active = true AND ≥
              40 all-time worked hours at the location. Ineligible employees
              get a TIS displayed on their detail page but do not appear in
              the rankings list.
            </li>
            <li>
              <strong>Ranks:</strong> never stored — always computed on-demand
              over the chosen range (location / client / platform scopes).
              Competition ranking: ties share a position, the next slot skips.
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
