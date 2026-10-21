-- Apply after 001_wetagold.sql, including on projects already running version 1.
begin;
alter table public.wg_signals add column if not exists opened_at timestamptz;
alter table public.wg_signals add column if not exists closed_at timestamptz;
create index if not exists wg_signals_history on public.wg_signals(created_at desc,id desc);

-- Recover historical times only from recorded audit events, never guessed dates.
update public.wg_signals s set
  opened_at=coalesce(s.opened_at,(select min(a.created_at) from public.wg_audit a where a.subject=s.id::text and a.action='signal.open')),
  closed_at=coalesce(s.closed_at,(select max(a.created_at) from public.wg_audit a where a.subject=s.id::text and a.action='signal.'||s.status and s.status in ('target','stopped','cancelled','expired')));

create or replace function public.wg_stamp_signal() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.status is distinct from old.status then
    if new.status='open' then new.opened_at:=coalesce(old.opened_at,now()); end if;
    if new.status in ('target','stopped','cancelled','expired') then
      new.closed_at:=case when old.status='pending' and new.status='expired' then least(now(),old.expires_at) else now() end;
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists wg_signal_times on public.wg_signals;
create trigger wg_signal_times before update of status on public.wg_signals for each row execute function public.wg_stamp_signal();

-- Never hide a still-open signal solely because its publication is old.
create or replace function public.wg_get_signals(p_user uuid) returns setof wg_signals
language plpgsql security definer set search_path=public as $$
declare u wg_profiles;
begin
  select * into u from wg_profiles where id=p_user;
  if not found or not u.active or u.must_change_password or (u.role<>'admin' and u.expires_at<=now()) then raise exception 'WG: الحساب غير مفعّل.'; end if;
  update wg_signals set status='expired' where status='pending' and expires_at<=now();
  return query select s.* from wg_signals s
    where (s.created_at>=now()-interval '90 days' or s.status in ('pending','open')) and
      (u.role='admin' or exists(select 1 from wg_allocations a where a.signal_id=s.id and a.user_id=p_user))
    order by (s.status in ('pending','open')) desc,s.id desc limit 200;
end; $$;

create or replace function public.wg_history(p_user uuid,p_page integer default 1,p_status text default 'all',p_direction text default 'all',p_from timestamptz default null,p_to timestamptz default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare u wg_profiles; payload jsonb;
begin
  select * into u from wg_profiles where id=p_user;
  if not found or not u.active or u.must_change_password or (u.role<>'admin' and u.expires_at<=now()) then raise exception 'WG: الحساب غير مفعّل.'; end if;
  if p_page is null or p_page<1 or p_page>999999 or p_status is null or p_status not in ('all','pending','open','target','stopped','expired','cancelled') or p_direction is null or p_direction not in ('all','buy','sell') or (p_from is not null and p_to is not null and p_from>=p_to) then raise exception 'WG: فلاتر السجل غير صالحة.'; end if;
  update wg_signals set status='expired' where status='pending' and expires_at<=now();
  with available as materialized (
    select s.* from wg_signals s where u.role='admin' or exists(select 1 from wg_allocations a where a.user_id=p_user and a.signal_id=s.id)
  ), filtered as materialized (
    select * from available s where (p_status='all' or s.status=p_status) and (p_direction='all' or s.direction=p_direction) and (p_from is null or s.created_at>=p_from) and (p_to is null or s.created_at<p_to)
  ), page_rows as (
    select * from filtered order by created_at desc,id desc limit 20 offset ((p_page-1)*20)
  ) select jsonb_build_object(
    'available',(select count(*) from available),'total',(select count(*) from filtered),
    'page',p_page,'pageSize',20,'signals',coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at desc,s.id desc) from page_rows s),'[]'::jsonb)
  ) into payload;
  return payload;
end; $$;

revoke all on function public.wg_history(uuid,integer,text,text,timestamptz,timestamptz),public.wg_stamp_signal() from public,anon,authenticated;
grant execute on function public.wg_history(uuid,integer,text,text,timestamptz,timestamptz),public.wg_stamp_signal() to service_role;
notify pgrst, 'reload schema';
commit;
