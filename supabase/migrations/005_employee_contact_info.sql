-- ============================================================================
-- Add contact info to employees: email and phone, captured from CSV imports.
-- ============================================================================
alter table public.employees add column email text;
alter table public.employees add column phone text;

create index idx_employees_email on public.employees(lower(email)) where email is not null;
