-- ============================================================================
-- Add wage tracking and internal employee codes (EMP-XXXXXX format).
-- Punch ID / Employee ID from source systems are ignored on import going
-- forward; the app generates and tracks its own employee_code.
-- ============================================================================

-- Wage columns
alter table public.employees add column wage numeric;
alter table public.employees add column wage_pay_type text;

-- Internal employee code: human-readable, app-generated, unique.
create sequence if not exists public.employee_code_seq start with 100000 minvalue 100000;

alter table public.employees
  add column employee_code text;

-- Backfill any existing rows with codes (idempotent: only fills nulls).
update public.employees
   set employee_code = 'EMP-' || lpad(nextval('public.employee_code_seq')::text, 6, '0')
 where employee_code is null;

-- Make it required + auto-generated for new rows + unique.
alter table public.employees alter column employee_code set not null;
alter table public.employees
  alter column employee_code
  set default ('EMP-' || lpad(nextval('public.employee_code_seq')::text, 6, '0'));
alter table public.employees add constraint employees_code_unique unique (employee_code);
