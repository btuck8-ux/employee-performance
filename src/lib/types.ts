export type ExpectationLabel =
  | "Below Expectations"
  | "Meets Expectations"
  | "Exceeds Expectations";

/**
 * Two-tier labels for the nine target-driven metrics (2026-08-14 targets
 * sprint, THQ-aligned). Composites (CS Score / TIS) and the tip/kitchen
 * badges keep the three-tier ExpectationLabel above.
 */
export type TargetLabel = "On Target" | "Below Target";

/**
 * The nine metrics evaluated against `metric_targets` (mig 051). Keys match
 * the table's CHECK'd metric_key set and the wire names on /api/scores —
 * note on-time classifies the GRACE variant (the displayed/wire value), and
 * avg_task_list_completion_pct joined the classified set with this sprint.
 * The exactly-nine-keys pin lives in metric-targets-contract.test.ts.
 */
export type TargetMetricKey =
  | "on_time_grace_pct"
  | "attendance_pct"
  | "survey_engagement_pct"
  | "tattle_rating"
  | "customer_service_rating"
  | "tattle_score_food_quality"
  | "tattle_score_accuracy"
  | "tattle_score_speed_of_service"
  | "avg_task_list_completion_pct";

export type ThresholdedMetricKey =
  | "customer_service_rating"
  | "tattle_rating"
  | "tattle_score_food_quality"
  | "tattle_score_accuracy"
  | "tattle_score_speed_of_service";

export type CountMetricKey =
  | "covered_shifts"
  | "customer_review_quantity"
  | "tattle_quantity";

export type MetricKey = TargetMetricKey | ThresholdedMetricKey | CountMetricKey;

export interface Client {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface Location {
  id: string;
  client_id: string;
  name: string;
  active: boolean;
  last_data_uploaded_at: string | null;
  last_report_generated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Employee {
  id: string;
  location_id: string;
  external_id: string | null;
  employee_code: string;          // app-generated, e.g. "EMP-100001"
  employee_name: string;
  email: string | null;
  phone: string | null;
  hire_date: string | null;
  wage: number | null;
  wage_pay_type: string | null;   // e.g. "Hourly", "Salary"
  active: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReportPeriod {
  id: string;
  label: string;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  period_start: string;
  period_end: string;
  created_at: string;
}

export interface MetricThreshold {
  id: string;
  location_id: string;
  report_period_id: string | null;
  metric_key: ThresholdedMetricKey;
  good_min: number;
  needs_min: number;
  avg_value: number | null;
  created_at: string;
  updated_at: string;
}

export interface PerformanceRecord {
  id: string;
  employee_id: string;
  location_id: string;
  report_period_id: string;
  on_time_pct: number | null;
  attendance_pct: number | null;
  covered_shifts: number | null;
  survey_engagement_pct: number | null;
  customer_service_rating: number | null;
  customer_review_quantity: number | null;
  tattle_rating: number | null;
  tattle_quantity: number | null;
  tattle_score_food_quality: number | null;
  tattle_score_accuracy: number | null;
  tattle_score_speed_of_service: number | null;
  manager_feedback: string | null;
  source: "ui" | "csv_upload" | "xlsx_upload";
  source_upload_id: string | null;
  raw_row: unknown;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}
