export type ExpectationLabel =
  | "Below Expectations"
  | "Meets Expectations"
  | "Exceeds Expectations";

export type FixedMetricKey =
  | "on_time_pct"
  | "attendance_pct"
  | "survey_engagement_pct";

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

export type MetricKey = FixedMetricKey | ThresholdedMetricKey | CountMetricKey;

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
  employee_name: string;
  hire_date: string | null;
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
