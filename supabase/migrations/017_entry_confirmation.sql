-- New entries only: symmetric M15 slope, two closed-minute moves, no chasing.
-- Uses sampled reference closes, NOT broker OHLC candles or volume.
-- Preserve bounded structural levels, old positions, and disabled cumulative limit.
begin;
select pg_advisory_xact_lock(910726431);
create or replace function public.wg_market_cloud_plan(p_at timestamptz,p_price numeric) returns jsonb
language plpgsql security definer set search_path=public as $$
declare coverage jsonb; cutoff timestamptz:=date_trunc('minute',p_at); prices double precision[]; trends double precision[];
  fast double precision; slow double precision; direction text; why text; n integer; structure jsonb; previous_fast double precision; volatility double precision; entry_delay numeric; entry_drift numeric; sign integer; confirmation jsonb;
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
    if direction is null then why:='no_setup';
    else
      sign:=case when direction='buy' then 1 else -1 end;
      previous_fast:=wg_market_ema(trends[1:cardinality(trends)-1],8);
      select avg(abs(prices[i]-prices[i-1])) into volatility from generate_series(n-19,n) i;
      entry_delay:=extract(epoch from (p_at-cutoff))*1000;
      entry_drift:=round(abs(p_price-prices[n]::numeric),8);
      if sign*(fast-previous_fast)<=0 or sign*(trends[cardinality(trends)]-trends[cardinality(trends)-1])<=0 or
        sign*(prices[n-1]-prices[n-2])<=0 or sign*(prices[n]-prices[n-1])<=0 or sign*(prices[n]-prices[n-2])<volatility then why:='weak_momentum';
      elsif entry_delay>15000 then why:='late_entry';
      elsif entry_drift>1 then why:='stretched_entry';
      else
        structure:=wg_market_structure(p_at,direction,round(p_price,2));why:=structure->>'reason';
        if why='ready' then
          confirmation:=jsonb_build_object('method','closed-reference-momentum-v1','confirmedMinute',extract(epoch from cutoff)::bigint*1000,
            'closedReferences',to_jsonb(prices[n-2:n]),'entryDelayMs',entry_delay,'entryDrift',entry_drift,'maxEntryDelayMs',15000,'maxEntryDrift',1,'trendSlopeConfirmed',true);
          structure:=jsonb_set(structure,'{decision,levelsBasis,entryConfirmation}',confirmation);
        end if;
      end if;
    end if;
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
  strategy text; coverage jsonb; rolling boolean; structure jsonb; entry_plan jsonb;
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
  why:=case when p_plan->>'reason' in ('warming_up','history_gap','recent_gap','no_setup','no_structure','poor_reward','weak_momentum','late_entry','stretched_entry','ready') then p_plan->>'reason' else 'warming_up' end;
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
        entry_plan:=wg_market_cloud_plan(qt,px);
        if entry_plan->>'reason' is distinct from 'ready' or entry_plan->'decision'->>'direction' is distinct from plan->>'direction' then raise exception 'WG: تأكيد الدخول أو الزخم غير مطابق للسوق المسجل.'; end if;
        structure:=jsonb_set(structure,'{decision,levelsBasis,entryConfirmation}',entry_plan->'decision'->'levelsBasis'->'entryConfirmation');
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
notify pgrst,'reload schema';
commit;
