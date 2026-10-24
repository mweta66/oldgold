-- Optional cloud-only collector. No external request/job is started by this
-- migration; enable only after a real provider probe and scheduler verification.
begin;
alter table public.wg_market_state add column sampling_seconds integer not null default 30 check(sampling_seconds in (3,30));
create table public.wg_market_poller (
  id integer primary key default 1 check(id=1),enabled boolean not null default false,
  request_id bigint,requested_at timestamptz,next_poll_at timestamptz,
  telegram_request_id bigint,telegram_requested_at timestamptz,
  last_processed_at timestamptz,last_error text,enabled_at timestamptz,last_cleanup_at timestamptz
);
insert into public.wg_market_poller(id) values(1);
alter table public.wg_market_poller enable row level security;
revoke all on public.wg_market_poller from public,anon,authenticated;
grant all on public.wg_market_poller to service_role;

create function public.wg_market_ema(p_values double precision[],p_length integer) returns double precision
language plpgsql immutable set search_path=public as $$
declare e double precision:=0; i integer;
begin
  if cardinality(p_values)<p_length then return null; end if;
  for i in 1..p_length loop e:=e+p_values[i]; end loop;e:=e/p_length;
  for i in p_length+1..cardinality(p_values) loop e:=e+((p_values[i]-e)*2)/(p_length+1); end loop;
  return e;
end; $$;

create function public.wg_market_cloud_plan(p_at timestamptz,p_price numeric) returns jsonb
language plpgsql security definer set search_path=public as $$
declare coverage jsonb; cutoff timestamptz:=date_trunc('minute',p_at); prices double precision[]; trends double precision[];
  fast double precision; slow double precision; direction text; why text; n integer; structure jsonb;
begin
  coverage:=wg_market_window(p_at);
  with samples as materialized (
    select quote_at,price,quote_at-lag(quote_at) over(order by quote_at) gap from wg_market_quotes where quote_at>=cutoff-interval '480 minutes' and quote_at<=p_at
  ), minutes as materialized (
    select distinct on(date_trunc('minute',quote_at)) date_trunc('minute',quote_at) t,price,
      bool_or(coalesce(gap,interval '0 seconds')>interval '90 seconds') over(partition by date_trunc('minute',quote_at)) bad
      from samples where quote_at<cutoff order by date_trunc('minute',quote_at),quote_at desc
  ), bars as (
    select date_bin(interval '15 minutes',t,timestamptz '1970-01-01 00:00:00+00') t,(array_agg(price order by t desc))[1] price
    from minutes group by 1 having count(*)=15 and not bool_or(bad)
  ) select (select array_agg(price::double precision order by t) from minutes where t>=cutoff-interval '5 hours'),
      (select array_agg(price::double precision order by t) from bars) into prices,trends;
  if coalesce(cardinality(trends),0)<21 then why:='warming_up';
  elsif (coverage->>'observed')::integer<295 or (coverage->>'maxGapMs')::numeric>180000 then why:='history_gap';
  elsif (coverage->>'recent')::integer<>30 or (coverage->>'recentMaxGapMs')::numeric>90000 then why:='recent_gap';
  else
    fast:=wg_market_ema(trends,8);slow:=wg_market_ema(trends,21);n:=cardinality(prices);
    if fast>slow and trends[cardinality(trends)]>fast and prices[n]>(select max(v) from unnest(prices[n-20:n-1]) v) and p_price>=prices[n] then direction:='buy';
    elsif fast<slow and trends[cardinality(trends)]<fast and prices[n]<(select min(v) from unnest(prices[n-20:n-1]) v) and p_price<=prices[n] then direction:='sell';
    end if;
    if direction is null then why:='no_setup'; else structure:=wg_market_structure(p_at,direction,round(p_price,2));why:=structure->>'reason'; end if;
  end if;
  return jsonb_build_object('strategy','sampled-m15-8-21-m1-structure-v3','reason',why,'progress',(coverage->>'observed')::integer,'window',coverage,
    'decision',case when why='ready' then structure->'decision'||jsonb_build_object('at',extract(epoch from cutoff)::bigint*1000,'direction',direction) else null end);
end; $$;

create or replace function public.wg_market_commit(p_lease uuid,p_quote jsonb,p_plan jsonb,p_group_chat text default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare m wg_market_state; s wg_signals; u wg_profiles; actor uuid;
  qt timestamptz; px numeric; existing numeric; plan jsonb; track jsonb;
  decision_at timestamptz; e numeric; sl numeric; goals numeric[]; goal integer; event_id bigint;
  recipients integer:=0; loss numeric; why text; duplicate boolean:=false;
  strategy text; coverage jsonb; rolling boolean; structure jsonb;
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
    duplicate:=(m.last_quote_at is not distinct from qt);
  else insert into wg_market_quotes(quote_at,price) values(qt,px); end if;
  strategy:=coalesce(p_plan->>'strategy','sampled-m15-8-21-m1-breakout-20-v1');
  if strategy not in ('sampled-m15-8-21-m1-breakout-20-v1','sampled-m15-8-21-m1-breakout-20-rolling5h-v2','sampled-m15-8-21-m1-structure-v3') then raise exception 'WG: استراتيجية سوق غير معروفة.'; end if;
  rolling:=strategy in ('sampled-m15-8-21-m1-breakout-20-rolling5h-v2','sampled-m15-8-21-m1-structure-v3');
  if rolling then coverage:=wg_market_window(qt); end if;
  why:=case when p_plan->>'reason' in ('warming_up','history_gap','recent_gap','no_setup','no_structure','poor_reward','ready') then p_plan->>'reason' else 'warming_up' end;
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
  if m.signal_id is null then
    if not m.enabled then why:='disabled';
    elsif (select paused from wg_settings where id=1) then why:='paused';
    elsif m.loss_used+0.5>10 then why:='risk_halted';
    elsif m.last_exit_at>clock_timestamp()-interval '15 minutes' then why:='cooldown';
    elsif exists(select 1 from wg_signals where status in ('open','pending') and (status='open' or expires_at>now())) then why:='active_position';
    elsif not duplicate and p_plan->'decision' is not null and jsonb_typeof(p_plan->'decision')='object' then
      plan:=p_plan->'decision'; decision_at:=to_timestamp((plan->>'at')::numeric/1000);
      if decision_at is null or decision_at<>date_trunc('minute',qt) or decision_at<=m.last_decision_at or (not rolling and coalesce((p_plan->>'progress')::integer,0)<330) then raise exception 'WG: وقت أو تهيئة القرار غير صحيح.'; end if;
      if rolling and (why<>'ready' or p_plan->'window' is distinct from coverage or
        coalesce((p_plan->>'progress')::integer,-1)<>(coverage->>'observed')::integer or
        (coverage->>'observed')::integer<295 or (coverage->>'recent')::integer<>30 or
        (coverage->>'maxGapMs')::numeric>180000 or (coverage->>'recentMaxGapMs')::numeric>90000 or
        (coverage->>'trendBars')::integer<21) then raise exception 'WG: بيانات نافذة القرار غير مكتملة أو غير مطابقة.'; end if;
      e:=(plan->>'entry')::numeric; sl:=(plan->>'stop')::numeric;
      if jsonb_typeof(plan->'targets')<>'array' or jsonb_array_length(plan->'targets') not between 1 and 3 then raise exception 'WG: أهداف آلية غير صالحة.'; end if;
      select array_agg(value::numeric order by ordinal) into goals from jsonb_array_elements_text(plan->'targets') with ordinality as x(value,ordinal);
      if plan->>'direction' not in ('buy','sell') or e is null or sl is null or abs(e-px)>0.011 or sl<=0 or sl>=1000000 or (strategy<>'sampled-m15-8-21-m1-structure-v3' and abs(e-sl)<e*0.00099) or not wg_targets_valid(plan->>'direction',e,goals[cardinality(goals)],goals) or (plan->>'direction'='buy' and sl>=e) or (plan->>'direction'='sell' and sl<=e) then raise exception 'WG: مستويات آلية غير صالحة.'; end if;
      if strategy='sampled-m15-8-21-m1-structure-v3' then
        structure:=wg_market_structure(qt,plan->>'direction',e);
        if structure->>'reason'<>'ready' or (structure->'decision'->>'stop')::numeric is distinct from sl or structure->'decision'->'targets' is distinct from to_jsonb(goals) then raise exception 'WG: مستويات الدعم والمقاومة غير مطابقة للسوق المسجّل.'; end if;
      end if;
      select id into actor from wg_profiles where role='admin' and active and not must_change_password;
      if actor is null then raise exception 'WG: حساب المدير غير متاح.'; end if;
      insert into wg_signals(request_id,symbol,direction,entry,stop,target,targets,reference_price,quote_at,status,opened_at,author_id,telegram_group_chat_id,market_strategy,market_resolution,market_observed_at,market_observed_price,risk_reference_pct,market_levels)
        values((case when strategy='sampled-m15-8-21-m1-structure-v3' then 'goldapi-v3-' when rolling then 'goldapi-v2-' else 'goldapi-v1-' end)||extract(epoch from decision_at)::bigint,'GOLDAPI:XAUUSD',plan->>'direction',e,sl,goals[cardinality(goals)],goals,px,qt,'open',clock_timestamp(),actor,p_group_chat,strategy,'observing',qt,px,0.5,structure->'decision'->'levelsBasis') returning * into s;
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
    progress_minutes=case when rolling then (coverage->>'observed')::integer else greatest(0,least(coalesce((p_plan->>'progress')::integer,0),330)) end,
    analysis=coalesce(coverage,'{}'::jsonb),reason=why where id=1;
  delete from wg_market_quotes where quote_at<clock_timestamp()-interval '7 days';
  return jsonb_build_object('duplicate',duplicate,'reason',why,'recipients',recipients);
end; $$;

create or replace function public.wg_market_claim() returns jsonb
language plpgsql security definer set search_path=public as $$
declare m wg_market_state; l uuid; samples jsonb; position jsonb;
begin
  if exists(select 1 from wg_market_poller where id=1 and enabled) then return null;end if;
  select * into m from wg_market_state where id=1 for update;
  if m.lease_until>clock_timestamp() or m.last_attempt_at>clock_timestamp()-interval '29 seconds' then return null; end if;
  l:=gen_random_uuid();
  update wg_market_state set lease=l,lease_until=clock_timestamp()+interval '60 seconds',last_attempt_at=clock_timestamp() where id=1;
  select coalesce(jsonb_agg(jsonb_build_object('at',floor(extract(epoch from q.quote_at)*1000),'price',q.price) order by q.quote_at),'[]'::jsonb)
    into samples from wg_market_quotes q where q.quote_at>=clock_timestamp()-interval '9 hours';
  select to_jsonb(s) into position from wg_signals s where s.id=m.signal_id;
  return jsonb_build_object('lease',l,'state',to_jsonb(m)-'lease'-'lease_until','quotes',samples,'signal',position);
end; $$;

create function public.wg_market_cloud_quote(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare m wg_market_state; s wg_signals; qt timestamptz; px numeric; prior numeric; l uuid;
  plan jsonb; tracking jsonb; hit integer; why text; status text; group_id text;
begin
  perform pg_advisory_xact_lock(910726431);
  select * into m from wg_market_state where id=1 for update;
  if m.lease_until>clock_timestamp() then return jsonb_build_object('skipped',true); end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or p_payload->>'symbol' is distinct from 'XAU' or p_payload->>'currency' is distinct from 'USD' or (p_payload->>'exchangeRate')::numeric is distinct from 1 or
    jsonb_typeof(p_payload->'price') is distinct from 'number' or jsonb_typeof(p_payload->'updatedAt') is distinct from 'string' or coalesce(p_payload->>'updatedAt','')!~ '(Z|[+]00:00)$' then raise exception 'GOLD_QUOTE_INVALID'; end if;
  qt:=(p_payload->>'updatedAt')::timestamptz;px:=(p_payload->>'price')::numeric;
  if qt is null or px is null or px<=0 or px>=1000000 or qt<clock_timestamp()-interval '90 seconds' or qt>clock_timestamp()+interval '5 seconds' or qt<m.last_quote_at then raise exception 'GOLD_QUOTE_STALE';end if;
  update wg_market_state set last_attempt_at=clock_timestamp() where id=1;
  if qt=m.last_quote_at then
    if px<>m.last_price then raise exception 'GOLD_QUOTE_CONFLICT';end if;
    return jsonb_build_object('duplicate',true);
  end if;
  select price into prior from wg_market_quotes where quote_at=qt;
  if found and prior<>px then raise exception 'GOLD_QUOTE_CONFLICT';end if;
  insert into wg_market_quotes(quote_at,price) values(qt,px) on conflict do nothing;
  if m.signal_id is null and m.enabled and not (select paused from wg_settings where id=1) and m.loss_used+0.5<=10 and
    (m.last_exit_at is null or m.last_exit_at<=clock_timestamp()-interval '15 minutes') then
    plan:=wg_market_cloud_plan(qt,px);
  else
    plan:=jsonb_build_object('strategy','sampled-m15-8-21-m1-structure-v3','reason','no_setup','progress',(wg_market_window(qt)->>'observed')::integer,'window',wg_market_window(qt),'decision',null);
  end if;
  if m.signal_id is not null then
    select * into s from wg_signals where id=m.signal_id;
    if s.status='open' then
      hit:=s.targets_hit;why:='observing';status:='open';
      if qt-m.last_quote_at>interval '90 seconds' then status:='unresolved';why:='data_gap';
      elsif (s.direction='buy' and px<=s.stop) or (s.direction='sell' and px>=s.stop) then status:='stopped';why:='observed_stop';
      else
        while hit<cardinality(s.targets) and ((s.direction='buy' and px>=s.targets[hit+1]) or (s.direction='sell' and px<=s.targets[hit+1])) loop hit:=hit+1;end loop;
        if hit=cardinality(s.targets) then status:='target';why:='observed_target';
        elsif qt-s.opened_at>=interval '120 minutes' then status:='unresolved';why:='time_limit';end if;
      end if;
      tracking:=jsonb_build_object('status',status,'targetsHit',hit,'reason',why);
    end if;
  end if;
  plan:=plan||jsonb_build_object('signalId',m.signal_id,'tracking',tracking);
  l:=gen_random_uuid();update wg_market_state set lease=l,lease_until=clock_timestamp()+interval '60 seconds' where id=1;
  select decrypted_secret into group_id from vault.decrypted_secrets where name='xgold_telegram_group_id';
  return wg_market_commit(l,jsonb_build_object('at',qt,'price',px),plan,group_id);
end; $$;

create function public.wg_market_cloud_failure(p_code text) returns void
language plpgsql security definer set search_path=public as $$
declare l uuid;
begin
  perform pg_advisory_xact_lock(910726431);
  if exists(select 1 from wg_market_state where id=1 and lease_until>clock_timestamp()) then return;end if;
  l:=gen_random_uuid();update wg_market_state set lease=l,lease_until=clock_timestamp()+interval '60 seconds',last_attempt_at=clock_timestamp() where id=1;
  perform wg_market_failure(l,p_code);
end; $$;

-- One global, non-overlapping request, at most once per 3 seconds. All source
-- data stays inside the database: no full-history REST transfer every 3s.
create function public.wg_market_poll() returns void
language plpgsql security definer set search_path=public as $$
declare p wg_market_poller; response record; payload jsonb; origin text; secret text; backoff integer; retry text;
begin
  if not pg_try_advisory_xact_lock(910726434) then return;end if;
  select * into p from wg_market_poller where id=1 for update;
  if not p.enabled then return;end if;
  if p.request_id is not null then
    select r.status_code,r.timed_out,r.content,coalesce(to_jsonb(r)->'headers','{}'::jsonb) headers into response from net._http_response r where r.id=p.request_id;
    if found then
      begin
        if response.status_code<>200 or response.timed_out or response.content is null or octet_length(response.content)>16384 then raise exception 'GOLD_HTTP_ERROR';end if;
        payload:=response.content::jsonb;perform wg_market_cloud_quote(payload);
        update wg_market_poller set last_processed_at=clock_timestamp(),last_error=null,request_id=null where id=1;
      exception when others then
        backoff:=case when response.status_code in (401,403) then 60 else 15 end;
        retry:=coalesce(response.headers->>'retry-after',response.headers->>'Retry-After');
        if response.status_code=429 and retry~'^[0-9]{1,5}$' then backoff:=greatest(15,least(3600,retry::integer));end if;
        update wg_market_poller set last_error='GOLD_CLOUD_SOURCE_UNAVAILABLE',request_id=null,next_poll_at=clock_timestamp()+make_interval(secs=>backoff) where id=1;
        perform wg_market_cloud_failure('GOLD_CLOUD_SOURCE_UNAVAILABLE');
      end;
    elsif p.requested_at<clock_timestamp()-interval '12 seconds' then
      update wg_market_poller set request_id=null,last_error='GOLD_CLOUD_TIMEOUT',next_poll_at=clock_timestamp()+interval '15 seconds' where id=1;
      perform wg_market_cloud_failure('GOLD_CLOUD_TIMEOUT');
    end if;
  end if;
  select * into p from wg_market_poller where id=1;
  if p.request_id is null and (p.next_poll_at is null or p.next_poll_at<=clock_timestamp()) then
    update wg_market_poller set request_id=net.http_get(url:='https://api.gold-api.com/price/XAU',headers:='{"Accept":"application/json"}'::jsonb,timeout_milliseconds:=8000),requested_at=clock_timestamp(),next_poll_at=clock_timestamp()+interval '3 seconds' where id=1;
  end if;
  -- Wake the existing protected Telegram worker only when messages are due.
  -- All privacy, cutover, mute, entitlement and reply/lease rules remain there.
  if not (select telegram_paused from wg_settings where id=1) and exists(select 1 from wg_outbox where state='pending' and next_at<=clock_timestamp()) and
    (p.telegram_request_id is null or exists(select 1 from net._http_response where id=p.telegram_request_id) or p.telegram_requested_at<clock_timestamp()-interval '25 seconds') then
    select decrypted_secret into origin from vault.decrypted_secrets where name='wetagold_site_origin';
    select decrypted_secret into secret from vault.decrypted_secrets where name='wetagold_cron_secret';
    if origin is not null and secret is not null then
      update wg_market_poller set telegram_request_id=net.http_get(url:=origin||'/api/jobs/telegram',headers:=jsonb_build_object('Authorization','Bearer '||secret),timeout_milliseconds:=20000),telegram_requested_at=clock_timestamp() where id=1;
    end if;
  end if;
  -- Bound only this new collector's future operational logs, not trade history
  -- or the pre-upgrade scheduler audit. pg_net retains its own response cache.
  if p.last_cleanup_at is null or p.last_cleanup_at<clock_timestamp()-interval '1 hour' then
    if to_regclass('cron.job_run_details') is not null and p.enabled_at is not null then
      delete from cron.job_run_details where jobid in (select jobid from cron.job where jobname='wetagold-market')
        and start_time>=p.enabled_at and end_time<clock_timestamp()-interval '7 days' and status in ('succeeded','failed');
    end if;
    update wg_market_poller set last_cleanup_at=clock_timestamp() where id=1;
  end if;
end; $$;

revoke all on function public.wg_market_ema(double precision[],integer),public.wg_market_cloud_plan(timestamptz,numeric),public.wg_market_cloud_quote(jsonb),public.wg_market_cloud_failure(text),public.wg_market_poll() from public,anon,authenticated;
grant execute on function public.wg_market_ema(double precision[],integer),public.wg_market_cloud_plan(timestamptz,numeric),public.wg_market_cloud_quote(jsonb),public.wg_market_cloud_failure(text),public.wg_market_poll() to service_role;
notify pgrst, 'reload schema';
commit;
