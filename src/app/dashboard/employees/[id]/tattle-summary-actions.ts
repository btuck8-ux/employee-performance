"use server";
import Anthropic from "@anthropic-ai/sdk";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

interface SummaryInputs {
  employee_name: string;
  period_label: string;
  attribution_method_breakdown: { onShift: number; workedDay: number };
  surveys: Array<{
    date: string;
    rating: number | null;
    score: number | null;
    food_quality_score: number | null;
    accuracy_score: number | null;
    speed_of_service_score: number | null;
    comments: string | null;
    positive_factors: string | null;
    negative_factors: string | null;
  }>;
}

function buildPrompt(inputs: SummaryInputs): string {
  const lines: string[] = [];
  lines.push(
    `You are summarizing customer feedback (Tattle survey responses) attributed to a single restaurant employee for a single performance period. Write a concise, balanced 2-3 paragraph summary covering: overall sentiment, recurring strengths, recurring areas for improvement, and any notable patterns. Stay grounded in the actual feedback — don't invent details. Use the employee's first name only.`
  );
  lines.push("");
  lines.push(`Employee: ${inputs.employee_name}`);
  lines.push(`Period: ${inputs.period_label}`);
  lines.push(
    `Total surveys attributed: ${inputs.surveys.length} (${inputs.attribution_method_breakdown.onShift} on shift at experienced time, ${inputs.attribution_method_breakdown.workedDay} attributed because no one was on shift but they worked that day)`
  );
  lines.push("");
  lines.push("Survey responses:");
  inputs.surveys.forEach((s, i) => {
    lines.push(
      `${i + 1}. [${s.date}] rating=${s.rating ?? "—"}/5, overall_score=${s.score ?? "—"}, accuracy=${s.accuracy_score ?? "—"}, food_quality=${s.food_quality_score ?? "—"}, speed=${s.speed_of_service_score ?? "—"}`
    );
    if (s.comments) lines.push(`   comments: ${s.comments.replace(/\s+/g, " ")}`);
    if (s.positive_factors) lines.push(`   positive_factors: ${s.positive_factors}`);
    if (s.negative_factors) lines.push(`   negative_factors: ${s.negative_factors}`);
  });
  return lines.join("\n");
}

export async function generateTattleSummaryAction(formData: FormData) {
  const employee_id = String(formData.get("employee_id") ?? "");
  const performance_record_id = String(formData.get("performance_record_id") ?? "");
  if (!employee_id || !performance_record_id) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const supabase = await createClient();
    await supabase
      .from("performance_records")
      .update({
        tattle_summary:
          "[Cannot generate: ANTHROPIC_API_KEY is not set in the environment.]",
        tattle_summary_generated_at: new Date().toISOString(),
      })
      .eq("id", performance_record_id);
    revalidatePath(`/dashboard/employees/${employee_id}`);
    return;
  }

  const supabase = await createClient();

  const { data: pr } = await supabase
    .from("performance_records")
    .select(
      "id, employee_id, report_period_id, employees(employee_name), report_periods(label, period_start, period_end)"
    )
    .eq("id", performance_record_id)
    .single();
  if (!pr) return;

  const period = (pr.report_periods as unknown as {
    label: string;
    period_start: string;
    period_end: string;
  } | null);
  const employeeName =
    (pr.employees as unknown as { employee_name: string } | null)?.employee_name ?? "";
  if (!period || !employeeName) return;

  const { data: rows } = await supabase
    .from("tattle_attributions")
    .select(
      "attribution_method, tattle_surveys!inner(date_experienced, tattle_rating, tattle_score, food_quality_score, accuracy_score, speed_of_service_score, comments_combined, positive_factors_combined, negative_factors_combined)"
    )
    .eq("employee_id", pr.employee_id)
    .gte("tattle_surveys.date_experienced", period.period_start)
    .lte("tattle_surveys.date_experienced", period.period_end);

  type Row = {
    attribution_method: "on_shift_at_experienced" | "worked_that_day";
    tattle_surveys: {
      date_experienced: string | null;
      tattle_rating: number | string | null;
      tattle_score: number | string | null;
      food_quality_score: number | string | null;
      accuracy_score: number | string | null;
      speed_of_service_score: number | string | null;
      comments_combined: string | null;
      positive_factors_combined: string | null;
      negative_factors_combined: string | null;
    };
  };
  const surveys = ((rows ?? []) as unknown as Row[]).map((r) => r);

  if (surveys.length === 0) {
    await supabase
      .from("performance_records")
      .update({
        tattle_summary: "No tattles were attributed to this employee in this period.",
        tattle_summary_generated_at: new Date().toISOString(),
      })
      .eq("id", performance_record_id);
    revalidatePath(`/dashboard/employees/${employee_id}`);
    return;
  }

  const numOrNull = (v: number | string | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === "string" ? Number(v) : v;
    return Number.isNaN(n) ? null : n;
  };

  const inputs: SummaryInputs = {
    employee_name: employeeName,
    period_label: period.label,
    attribution_method_breakdown: {
      onShift: surveys.filter((s) => s.attribution_method === "on_shift_at_experienced").length,
      workedDay: surveys.filter((s) => s.attribution_method === "worked_that_day").length,
    },
    surveys: surveys.map((r) => ({
      date: r.tattle_surveys.date_experienced ?? "—",
      rating: numOrNull(r.tattle_surveys.tattle_rating),
      score: numOrNull(r.tattle_surveys.tattle_score),
      food_quality_score: numOrNull(r.tattle_surveys.food_quality_score),
      accuracy_score: numOrNull(r.tattle_surveys.accuracy_score),
      speed_of_service_score: numOrNull(r.tattle_surveys.speed_of_service_score),
      comments: r.tattle_surveys.comments_combined,
      positive_factors: r.tattle_surveys.positive_factors_combined,
      negative_factors: r.tattle_surveys.negative_factors_combined,
    })),
  };

  const prompt = buildPrompt(inputs);

  const client = new Anthropic({ apiKey });
  let summary: string;
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    summary =
      textBlock && textBlock.type === "text" ? textBlock.text : "[No text returned from Claude.]";
  } catch (e) {
    summary = `[Generation failed: ${(e as Error).message}]`;
  }

  await supabase
    .from("performance_records")
    .update({
      tattle_summary: summary,
      tattle_summary_generated_at: new Date().toISOString(),
    })
    .eq("id", performance_record_id);

  revalidatePath(`/dashboard/employees/${employee_id}`);
}
