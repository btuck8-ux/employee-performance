import Papa from "papaparse";

interface RawRow {
  employee_name?: string;
  survey_title?: string;
  sent_date?: string;
  completed?: string;
  completion_date?: string;
  response_data?: string;
  external_survey_id?: string;
}

export interface ParsedAssignment {
  employee_name_key: string;
  employee_name_display: string;
  survey_title: string;
  sent_date: string | null;
  external_survey_id: string | null;
  completed: boolean;
  completion_date: string | null;
  response_data: unknown;
  /** Captured Location/Store/Site value from the row, used by the upload
   *  action to filter multi-location master CSVs down to one location at a
   *  time. Null if the CSV had no location column or the value was empty. */
  location_label: string | null;
}

export interface SurveyImportResult {
  rows_in_file: number;
  unique_assignments: number;
  unique_surveys: number;
  warnings: string[];
  errors: string[];
  assignments: ParsedAssignment[];
}

const HEADER_ALIASES: Record<string, string> = {
  // employee
  employeename: "employee_name",
  employee: "employee_name",
  name: "employee_name",
  fullname: "employee_name",
  user: "employee_name",
  recipient: "employee_name",

  // survey
  surveytitle: "survey_title",
  survey: "survey_title",
  title: "survey_title",
  topic: "survey_title",
  course: "survey_title",
  module: "survey_title",
  externalsurveyid: "external_survey_id",
  surveyid: "external_survey_id",

  // dates
  sentdate: "sent_date",
  datesent: "sent_date",
  assigneddate: "sent_date",
  completeddate: "completion_date",
  completiondate: "completion_date",
  datecompleted: "completion_date",
  finisheddate: "completion_date",

  // status
  completed: "completed",
  status: "completed",
  done: "completed",
  finished: "completed",

  // response payload
  responsedata: "response_data",
  responses: "response_data",
  answers: "response_data",
  responsejson: "response_data",

  // location label — captured per row so multi-location master CSVs can
  // be filtered per location at ingest time.
  location: "location_label",
  store: "location_label",
  storename: "location_label",
  site: "location_label",
  sitename: "location_label",
};

const SILENTLY_IGNORED_HEADERS = new Set<string>([]);

function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getField(
  row: Record<string, string>,
  canonical: string,
  headerMap: Record<string, string>
): string | undefined {
  for (const [rawHeader, canonField] of Object.entries(headerMap)) {
    if (canonField === canonical) {
      const value = row[rawHeader];
      if (value !== undefined && value !== null && value !== "") return String(value).trim();
    }
  }
  return undefined;
}

function parseCompleted(s: string | undefined): boolean {
  if (!s) return false;
  const t = s.trim().toLowerCase();
  return ["yes", "y", "true", "t", "1", "completed", "complete", "finished", "done"].includes(t);
}

function isoDate(s: string | undefined): string | null {
  if (!s) return null;
  const cleaned = s.trim();
  if (!cleaned) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;
  // Try to coerce common variants like "01/15/2026" or "2026-01-15T..." to YYYY-MM-DD
  const m = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const mm = m[1].padStart(2, "0");
    const dd = m[2].padStart(2, "0");
    return `${m[3]}-${mm}-${dd}`;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(cleaned)) return cleaned.slice(0, 10);
  return null;
}

function tryParseJson(s: string | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // Not JSON — keep as raw text
    return s;
  }
}

export function parseSurveyCsv(csvText: string): SurveyImportResult {
  const result: SurveyImportResult = {
    rows_in_file: 0,
    unique_assignments: 0,
    unique_surveys: 0,
    warnings: [],
    errors: [],
    assignments: [],
  };

  const parsed = Papa.parse<Record<string, string>>(csvText, {
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

  const rawHeaders = parsed.meta.fields ?? [];
  const headerMap: Record<string, string> = {};
  const unmatched: string[] = [];
  for (const raw of rawHeaders) {
    const norm = normalizeHeader(raw);
    const canonical = HEADER_ALIASES[norm];
    if (canonical) headerMap[raw] = canonical;
    else if (!SILENTLY_IGNORED_HEADERS.has(norm)) unmatched.push(raw);
  }
  if (unmatched.length > 0) {
    result.warnings.push(
      `Ignored ${unmatched.length} unrecognized column${unmatched.length === 1 ? "" : "s"}: ${unmatched.join(", ")}`
    );
  }

  const canon = new Set(Object.values(headerMap));
  if (!canon.has("employee_name") || !canon.has("survey_title")) {
    result.errors.push(
      "Missing required columns. Need employee_name and survey_title at minimum."
    );
    return result;
  }

  // Dedupe on (employee_name lower, survey_title lower, sent_date)
  const groups = new Map<string, ParsedAssignment>();
  const surveyKeys = new Set<string>();

  for (const row of rows) {
    const empName = getField(row, "employee_name", headerMap);
    const surveyTitle = getField(row, "survey_title", headerMap);
    if (!empName || !surveyTitle) continue;

    const sentDate = isoDate(getField(row, "sent_date", headerMap));
    const completionDate = isoDate(getField(row, "completion_date", headerMap));
    const completed = parseCompleted(getField(row, "completed", headerMap)) || !!completionDate;
    const externalSurveyId = getField(row, "external_survey_id", headerMap) ?? null;
    const responseData = tryParseJson(getField(row, "response_data", headerMap));

    const locationLabel = getField(row, "location_label", headerMap) ?? null;

    const empKey = empName.toLowerCase();
    const titleKey = surveyTitle.toLowerCase();
    // Dedupe key now includes location so the same (name, title, date) at two
    // different locations (e.g. multi-location master CSV) doesn't collapse.
    const dedupeKey = `${(locationLabel ?? "").toLowerCase()}|${empKey}|${titleKey}|${sentDate ?? ""}`;
    surveyKeys.add(`${titleKey}|${sentDate ?? ""}`);

    const existing = groups.get(dedupeKey);
    if (!existing) {
      groups.set(dedupeKey, {
        employee_name_key: empKey,
        employee_name_display: empName,
        survey_title: surveyTitle,
        sent_date: sentDate,
        external_survey_id: externalSurveyId,
        completed,
        completion_date: completionDate,
        response_data: responseData,
        location_label: locationLabel,
      });
    } else {
      // Merge: any "completed" wins, earliest completion date wins, prefer non-null values.
      if (completed) existing.completed = true;
      if (
        completionDate &&
        (!existing.completion_date || completionDate < existing.completion_date)
      ) {
        existing.completion_date = completionDate;
      }
      if (!existing.external_survey_id && externalSurveyId) {
        existing.external_survey_id = externalSurveyId;
      }
      if (existing.response_data === null && responseData !== null) {
        existing.response_data = responseData;
      }
      if (!existing.location_label && locationLabel) {
        existing.location_label = locationLabel;
      }
    }
  }

  result.assignments = Array.from(groups.values());
  result.unique_assignments = result.assignments.length;
  result.unique_surveys = surveyKeys.size;
  return result;
}
