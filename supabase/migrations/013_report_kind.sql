-- Distinguish PDF kinds in generated_reports.
alter table public.generated_reports
  add column report_kind text not null default 'performance';

create index idx_reports_kind_current
  on public.generated_reports(employee_id, report_period_id, report_kind)
  where superseded_at is null;
