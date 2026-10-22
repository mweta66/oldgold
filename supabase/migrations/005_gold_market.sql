-- Sampled Gold API reference data only. No historical signals or prices inserted.
-- Existing manual OANDA records, allocations, sessions and deliveries stay intact.
begin;
create table public.wg_market_state (
  id integer primary key default 1 check(id=1),
  enabled boolean not null default false,
  lease uuid, lease_until timestamptz, last_attempt_at timestamptz,
  last_quote_at timestamptz, last_price numeric,
  reason text not null default 'warming_up', progress_minutes integer not null default 0 check(progress_minutes between 0 and 330),
  last_error text, last_decision_at timestamptz, last_exit_at timestamptz,
  signal_id bigint references public.wg_signals(id),
  loss_used numeric not null default 0 check(loss_used>=0 and loss_used<'Infinity'::numeric),
  activated_at timestamptz
);
alter table public.wg_market_state add column scheduled_request_id bigint;
alter table public.wg_market_state add column scheduled_at timestamptz;
insert into public.wg_market_state(id) values(1);
create table public.wg_market_quotes (
  quote_at timestamptz primary key,
  price numeric not null check(price>0 and price<1000000),
  received_at timestamptz not null default clock_timestamp()
);
alter table public.wg_market_state enable row level security;
alter table public.wg_market_quotes enable row level security;
revoke all on public.wg_market_state,public.wg_market_quotes from public,anon,authenticated;
grant all on public.wg_market_state,public.wg_market_quotes to service_role;

alter table public.wg_signals drop constraint wg_signals_symbol_check;
alter table public.wg_signals add constraint wg_signals_symbol_check check(symbol in ('OANDA:XAUUSD','GOLDAPI:XAUUSD'));
alter table public.wg_signals drop constraint wg_signals_status_check;
alter table public.wg_signals add constraint wg_signals_status_check check(status in ('pending','open','target','stopped','expired','cancelled','unresolved'));
alter table public.wg_signal_events drop constraint wg_signal_events_status_check;
alter table public.wg_signal_events add constraint wg_signal_events_status_check check(status in ('pending','open','target','stopped','expired','cancelled','unresolved'));
alter table public.wg_signals add column market_strategy text;
alter table public.wg_signals add column market_resolution text;
alter table public.wg_signals add column market_observed_at timestamptz;
alter table public.wg_signals add column market_observed_price numeric;
alter table public.wg_signals add column risk_reference_pct numeric;
create unique index wg_one_automatic_position on public.wg_signals(symbol) where symbol='GOLDAPI:XAUUSD' and status in ('open','pending');

create or replace function public.wg_stamp_signal() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.status is distinct from old.status then
    if new.status='open' then new.opened_at:=coalesce(old.opened_at,now()); end if;
    if new.status in ('target','stopped','cancelled','expired','unresolved') then
      new.closed_at:=case when old.status='pending' and new.status='expired' then least(now(),old.expires_at) else now() end;
    end if;
  end if;
  return new;
end; $$;

create function public.wg_market_claim() returns jsonb
language plpgsql security definer set search_path=public as $$
declare m wg_market_state; l uuid; samples jsonb; position jsonb;
begin
  select * into m from wg_market_state where id=1 for update;
  if m.lease_until>clock_timestamp() or m.last_attempt_at>clock_timestamp()-interval '29 seconds' then return null; end if;
  l:=gen_random_uuid();
  update wg_market_state set lease=l,lease_until=clock_timestamp()+interval '60 seconds',last_attempt_at=clock_timestamp() where id=1;
  select coalesce(jsonb_agg(jsonb_build_object('at',floor(extract(epoch from q.quote_at)*1000),'price',q.price) order by q.quote_at),'[]'::jsonb)
    into samples from wg_market_quotes q where q.quote_at>=clock_timestamp()-interval '9 hours';
  select to_jsonb(s) into position from wg_signals s where s.id=m.signal_id;
  return jsonb_build_object('lease',l,'state',to_jsonb(m)-'lease'-'lease_until','quotes',samples,'signal',position);
end; $$;

create function public.wg_market_failure(p_lease uuid,p_code text) returns void
language plpgsql security definer set search_path=public as $$
declare m wg_market_state; s wg_signals;
begin
  perform set_config('wetagold.market_worker','on',true);
  select * into m from wg_market_state where id=1 for update;
  if p_lease is null or m.lease is distinct from p_lease then return; end if;
  if p_code is null or p_code !~ '^GOLD_[A-Z_]{1,60}$' then p_code:='GOLD_WORKER_FAILED'; end if;
  if m.signal_id is not null and m.last_quote_at<clock_timestamp()-interval '90 seconds' then
    select * into s from wg_signals where id=m.signal_id for update;
    if s.status='open' then
      update wg_signals set status='unresolved',market_resolution='data_gap' where id=s.id;
      update wg_market_state set signal_id=null,last_exit_at=clock_timestamp(),loss_used=loss_used+0.5 where id=1;
      insert into wg_audit(actor_id,action,subject) values(s.author_id,'market.unresolved',s.id::text);
    end if;
  end if;
  update wg_market_state set lease=null,lease_until=null,last_error=p_code,reason='awaiting_fresh_quote',progress_minutes=0 where id=1;
end; $$;

create function public.wg_market_config(p_actor uuid,p_enabled boolean) returns void
language plpgsql security definer set search_path=public as $$
begin
  perform wg_assert_admin(p_actor);
  if p_enabled is null then raise exception 'WG: اختر حالة المحرك.'; end if;
  update wg_market_state set enabled=p_enabled,activated_at=case when p_enabled then coalesce(activated_at,clock_timestamp()) else activated_at end where id=1;
  insert into wg_audit(actor_id,action,subject) values(p_actor,'market.enabled',p_enabled::text);
end; $$;

create function public.wg_market_commit(p_lease uuid,p_quote jsonb,p_plan jsonb,p_group_chat text default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare m wg_market_state; s wg_signals; u wg_profiles; actor uuid;
  qt timestamptz; px numeric; existing numeric; plan jsonb; track jsonb;
  decision_at timestamptz; e numeric; sl numeric; goals numeric[]; goal integer; event_id bigint;
  recipients integer:=0; loss numeric; why text; duplicate boolean:=false;
begin
  perform pg_advisory_xact_lock(910726431);
  perform set_config('wetagold.market_worker','on',true);
  select * into m from wg_market_state where id=1 for update;
  if p_lease is null or m.lease is null or m.lease_until is null or m.lease is distinct from p_lease or m.lease_until<clock_timestamp() then raise exception 'WG: انتهت مهلة عامل السوق.'; end if;
  qt:=(p_quote->>'at')::timestamptz; px:=(p_quote->>'price')::numeric;
  if qt is null or px is null or px<=0 or px>=1000000 or qt<clock_timestamp()-interval '90 seconds' or qt>clock_timestamp()+interval '5 seconds' or qt<m.last_quote_at then raise exception 'WG: قراءة سوق غير صالحة أو قديمة.'; end if;
  select price into existing from wg_market_quotes where quote_at=qt;
  if found then
    if existing<>px then raise exception 'WG: قراءتان متعارضتان لنفس وقت المصدر.'; end if;
    duplicate:=true;
  else insert into wg_market_quotes(quote_at,price) values(qt,px); end if;
  why:=case when p_plan->>'reason' in ('warming_up','no_setup','ready') then p_plan->>'reason' else 'warming_up' end;
  if not duplicate and m.signal_id is not null then
    select * into s from wg_signals where id=m.signal_id for update;
    if s.status<>'open' then
      -- A manual cancellation never silently replenishes the reference loss budget.
      update wg_market_state set signal_id=null,last_exit_at=clock_timestamp(),loss_used=loss_used+0.5 where id=1;
    else
      track:=p_plan->'tracking';
      if (p_plan->>'signalId')::bigint is distinct from s.id or track is null or jsonb_typeof(track)<>'object' then raise exception 'WG: خطة متابعة غير مطابقة.'; end if;
      if qt-m.last_quote_at>interval '90 seconds' then
        track:=jsonb_build_object('status','unresolved','targetsHit',s.targets_hit,'reason','data_gap','loss',0.5);
      end if;
      if coalesce(track->>'status','') not in ('open','target','stopped','unresolved') or coalesce((track->>'targetsHit')::integer,-1) not between s.targets_hit and cardinality(s.targets) or coalesce(track->>'reason','') not in ('observing','observed_target','observed_stop','data_gap','time_limit') or ((track->>'status'='target') is distinct from ((track->>'targetsHit')::integer=cardinality(s.targets))) then raise exception 'WG: انتقال متابعة غير صالح.'; end if;
      update wg_signals set market_observed_at=qt,market_observed_price=px,market_resolution=track->>'reason' where id=s.id;
      for goal in s.targets_hit+1..(track->>'targetsHit')::integer loop
        if (s.direction='buy' and px<s.targets[goal]) or (s.direction='sell' and px>s.targets[goal]) then raise exception 'WG: لم يُرصد عبور الهدف.'; end if;
        update wg_signals set targets_hit=goal,status=case when goal=cardinality(targets) then 'target' else 'open' end where id=s.id;
      end loop;
      if track->>'status'='stopped' then
        if (s.direction='buy' and px>s.stop) or (s.direction='sell' and px<s.stop) then raise exception 'WG: لم يُرصد عبور الوقف.'; end if;
        update wg_signals set status='stopped' where id=s.id;
      elsif track->>'status'='unresolved' then
        update wg_signals set status='unresolved' where id=s.id;
      end if;
      if track->>'status'<>'open' then
        loss:=case when track->>'status'='stopped' then 0.5*greatest(1,abs(px-s.entry)/abs(s.entry-s.stop)) when track->>'status'='unresolved' then 0.5 else 0 end;
        update wg_market_state set signal_id=null,last_exit_at=clock_timestamp(),loss_used=loss_used+loss where id=1;
        insert into wg_audit(actor_id,action,subject) values(s.author_id,'market.'||(track->>'status'),s.id::text);
      end if;
    end if;
  end if;
  -- Do not open a second position in the observation that closes the first.
  if not duplicate and m.signal_id is null then
    if not m.enabled then why:='disabled';
    elsif (select paused from wg_settings where id=1) then why:='paused';
    elsif m.loss_used+0.5>10 then why:='risk_halted';
    elsif m.last_exit_at>clock_timestamp()-interval '15 minutes' then why:='cooldown';
    elsif exists(select 1 from wg_signals where status in ('open','pending') and (status='open' or expires_at>now())) then why:='active_position';
    elsif p_plan->'decision' is not null and jsonb_typeof(p_plan->'decision')='object' then
      plan:=p_plan->'decision'; decision_at:=to_timestamp((plan->>'at')::numeric/1000);
      if decision_at is null or decision_at<>date_trunc('minute',qt) or decision_at<=m.last_decision_at or least((p_plan->>'progress')::integer,330)<>330 then raise exception 'WG: وقت أو تهيئة القرار غير صحيح.'; end if;
      e:=(plan->>'entry')::numeric; sl:=(plan->>'stop')::numeric;
      if jsonb_typeof(plan->'targets')<>'array' or jsonb_array_length(plan->'targets')<>3 then raise exception 'WG: أهداف آلية غير صالحة.'; end if;
      select array_agg(value::numeric order by ordinal) into goals from jsonb_array_elements_text(plan->'targets') with ordinality as x(value,ordinal);
      if plan->>'direction' not in ('buy','sell') or e is null or sl is null or abs(e-px)>0.011 or sl<=0 or sl>=1000000 or abs(e-sl)<e*0.00099 or not wg_targets_valid(plan->>'direction',e,goals[3],goals) or (plan->>'direction'='buy' and sl>=e) or (plan->>'direction'='sell' and sl<=e) then raise exception 'WG: مستويات آلية غير صالحة.'; end if;
      select id into actor from wg_profiles where role='admin' and active and not must_change_password;
      if actor is null then raise exception 'WG: حساب المدير غير متاح.'; end if;
      insert into wg_signals(request_id,symbol,direction,entry,stop,target,targets,reference_price,quote_at,status,opened_at,author_id,telegram_group_chat_id,market_strategy,market_resolution,market_observed_at,market_observed_price,risk_reference_pct)
        values('goldapi-v1-'||extract(epoch from decision_at)::bigint,'GOLDAPI:XAUUSD',plan->>'direction',e,sl,goals[3],goals,px,qt,'open',clock_timestamp(),actor,p_group_chat,'sampled-m15-8-21-m1-breakout-20-v1','observing',qt,px,0.5) returning * into s;
      select id into event_id from wg_signal_events where signal_id=s.id and kind='publish';
      for u in select * from wg_profiles where role='member' and active and not must_change_password and expires_at>now() and used<quota order by id for update loop
        insert into wg_allocations(user_id,signal_id) values(u.id,s.id);
        update wg_profiles set used=used+1 where id=u.id;
        if u.telegram_chat_id is not null then insert into wg_outbox(signal_id,event_id,user_id,destination) values(s.id,event_id,u.id,u.telegram_chat_id); end if;
        recipients:=recipients+1;
      end loop;
      if nullif(p_group_chat,'') is not null then insert into wg_outbox(signal_id,event_id,destination) values(s.id,event_id,p_group_chat); end if;
      update wg_market_state set signal_id=s.id,last_decision_at=decision_at where id=1;
      insert into wg_audit(actor_id,action,subject) values(actor,'market.publish',s.id::text);
      why:='active_position';
    end if;
  elsif m.signal_id is not null then why:='active_position';
  end if;
  update wg_market_state set lease=null,lease_until=null,last_quote_at=qt,last_price=px,last_error=null,
    progress_minutes=greatest(0,least(coalesce((p_plan->>'progress')::integer,0),330)),reason=case when duplicate then reason else why end where id=1;
  delete from wg_market_quotes where quote_at<clock_timestamp()-interval '7 days';
  return jsonb_build_object('duplicate',duplicate,'reason',why,'recipients',recipients);
end; $$;

create function public.wg_guard_market_signal() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if old.market_strategy is not null and current_setting('wetagold.market_worker',true) is distinct from 'on' and
    (new.targets_hit is distinct from old.targets_hit or (new.status is distinct from old.status and new.status<>'cancelled')) then
    raise exception 'WG: الأهداف والوقف الآليان من قراءات المصدر فقط؛ يمكنك إلغاء المتابعة.';
  end if;
  return new;
end; $$;
create trigger wg_guard_market_signal before update on public.wg_signals for each row execute function public.wg_guard_market_signal();

create or replace function public.wg_history(p_user uuid,p_page integer default 1,p_status text default 'all',p_direction text default 'all',p_from timestamptz default null,p_to timestamptz default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare u wg_profiles; payload jsonb;
begin
  select * into u from wg_profiles where id=p_user;
  if not found or not u.active or u.must_change_password or (u.role<>'admin' and u.expires_at<=now()) then raise exception 'WG: الحساب غير مفعّل.'; end if;
  if p_page is null or p_page<1 or p_page>999999 or p_status is null or p_status not in ('all','pending','open','target','stopped','expired','cancelled','unresolved') or p_direction is null or p_direction not in ('all','buy','sell') or (p_from is not null and p_to is not null and p_from>=p_to) then raise exception 'WG: فلاتر السجل غير صالحة.'; end if;
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

revoke all on function public.wg_guard_market_signal(),public.wg_market_claim(),public.wg_market_failure(uuid,text),public.wg_market_config(uuid,boolean),public.wg_market_commit(uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.wg_market_claim(),public.wg_market_failure(uuid,text),public.wg_market_config(uuid,boolean),public.wg_market_commit(uuid,jsonb,jsonb,text) to service_role;
notify pgrst, 'reload schema';
commit;
