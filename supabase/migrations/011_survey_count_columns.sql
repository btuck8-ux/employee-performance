-- ============================================================================
-- Persist survey assigned/completed counts on performance_records.
-- ============================================================================
alter table public.performance_records
  add column surveys_assigned  int,
  add column surveys_completed int;

update public.performance_records pr
   set surveys_assigned  = sub.assigned,
       surveys_completed = sub.completed
  from (
    select pr.id as pr_id,
           count(*)                                            as assigned,
           count(*) filter (where sa.completed)                as completed
      from public.performance_records pr
      join public.surveys s
        on s.location_id = pr.location_id
      join public.report_periods rp
        on rp.id = pr.report_period_id
      join public.survey_assignments sa
        on sa.survey_id = s.id and sa.employee_id = pr.employee_id
     where s.sent_date between rp.period_start and rp.period_end
     group by pr.id
  ) sub
 where sub.pr_id = pr.id;
