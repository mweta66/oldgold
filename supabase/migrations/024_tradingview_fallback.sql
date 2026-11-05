-- TradingView OANDA M1 backup. Independent source histories and per-trade source pinning.
begin;
select pg_advisory_xact_lock(910726431);
create table public.wg_tv_feed(id integer primary key check(id=1),price numeric not null check(price>0 and price<1000000),time_ms bigint not null,sent_ms bigint not null,received_at timestamptz not null default clock_timestamp());
create table public.wg_tv_bars(time bigint primary key check(time>0 and time%60=0),open numeric not null,high numeric not null,low numeric not null,close numeric not null,
 check(low>0 and high<1000000 and low<=least(open,close) and high>=greatest(open,close)));
alter table public.wg_tv_feed enable row level security;
alter table public.wg_tv_bars enable row level security;
revoke all on public.wg_tv_feed,public.wg_tv_bars from public,anon,authenticated;
grant all on public.wg_tv_feed,public.wg_tv_bars to service_role;
alter table public.wg_signals drop constraint wg_signals_symbol_check;
alter table public.wg_signals add constraint wg_signals_symbol_check check(symbol in ('OANDA:XAUUSD','GOLDAPI:XAUUSD','MT5:xauusd.s','TV:OANDA:XAUUSD'));
create unique index wg_one_tv_position on public.wg_signals(symbol) where symbol='TV:OANDA:XAUUSD' and status in ('open','pending');
create function public.wg_tv_ingest(p_payload jsonb) returns jsonb language plpgsql security invoker set search_path=public as $$
declare b jsonb;stamp bigint:=floor(extract(epoch from clock_timestamp())*1000);prior wg_tv_feed;bar_time bigint;last_close numeric;
begin
 perform pg_advisory_xact_lock(910726435);
 if p_payload->>'symbol' is distinct from 'OANDA:XAUUSD' or p_payload->>'interval' is distinct from '1' or jsonb_typeof(p_payload->'bars') is distinct from 'array' or jsonb_array_length(p_payload->'bars') not between 1 and 80 or coalesce((p_payload->>'timeMs')::bigint,0) not between stamp-90000 and stamp+5000 or (p_payload->>'timeMs')::bigint%60000<>0 or coalesce((p_payload->>'sentMs')::bigint,0) not between stamp-90000 and stamp+5000 or (p_payload->>'sentMs')::bigint<(p_payload->>'timeMs')::bigint or coalesce((p_payload->>'price')::numeric,0)<=0 then raise exception 'TRADINGVIEW_DATA_INVALID';end if;
 select * into prior from wg_tv_feed where id=1 for update;
 if prior.time_ms>(p_payload->>'timeMs')::bigint then return jsonb_build_object('ok',true,'skipped',true);end if;
 if prior.time_ms=(p_payload->>'timeMs')::bigint and prior.price is distinct from (p_payload->>'price')::numeric then raise exception 'TRADINGVIEW_QUOTE_CONFLICT';end if;
 for b in select value from jsonb_array_elements(p_payload->'bars') loop
  if jsonb_typeof(b) is distinct from 'array' or jsonb_array_length(b)<>5 then raise exception 'TRADINGVIEW_BAR_INVALID';end if;
  bar_time:=(b->>0)::bigint;
  if bar_time is null or bar_time*1000>= (p_payload->>'timeMs')::bigint or bar_time*1000<stamp-604800000 then raise exception 'TRADINGVIEW_BAR_TIME_INVALID';end if;
  insert into wg_tv_bars(time,open,high,low,close) values(bar_time,(b->>1)::numeric,(b->>2)::numeric,(b->>3)::numeric,(b->>4)::numeric) on conflict(time) do update set open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close;
 end loop;
 select close into last_close from wg_tv_bars where time=(p_payload->>'timeMs')::bigint/1000-60;
 if last_close is distinct from (p_payload->>'price')::numeric then raise exception 'TRADINGVIEW_LAST_CLOSE_MISMATCH';end if;
 insert into wg_tv_feed(id,price,time_ms,sent_ms) values(1,(p_payload->>'price')::numeric,(p_payload->>'timeMs')::bigint,(p_payload->>'sentMs')::bigint)
 on conflict(id) do update set price=excluded.price,time_ms=excluded.time_ms,sent_ms=excluded.sent_ms,received_at=clock_timestamp();
 delete from wg_tv_bars where time<floor(extract(epoch from clock_timestamp()-interval '7 days'));
 return jsonb_build_object('ok',true,'skipped',false);
end;$$;
create function public.wg_tv_market_plan() returns jsonb
language plpgsql security invoker set search_path=public as $$
declare f wg_tv_feed;cutoff bigint;bars jsonb;closes jsonb;trends double precision[];prices numeric[];
 fast double precision;slow double precision;direction text;entry numeric;distance numeric;volatility numeric;sgn integer;
 zone jsonb;candle jsonb;why text:='awaiting_tradingview';n integer;
begin
 select * into f from wg_tv_feed where id=1;
 if f.time_ms is null or f.time_ms<floor(extract(epoch from clock_timestamp())*1000)-90000 or f.time_ms>floor(extract(epoch from clock_timestamp())*1000)+5000 or f.received_at<clock_timestamp()-interval '90 seconds' then
 return jsonb_build_object('reason','awaiting_tradingview','decision',null);end if;
 cutoff:=floor(f.time_ms/60000.0)::bigint*60;
 select jsonb_agg(jsonb_build_object('time',time,'open',open,'high',high,'low',low,'close',close) order by time),array_agg(close order by time)
 into bars,prices from wg_tv_bars where time>=cutoff-480*60 and time<cutoff;
 n:=coalesce(cardinality(prices),0);
 if n<315 then return jsonb_build_object('reason','warming_up','decision',null);end if;
 with b as (select floor(time/900.0)::bigint bucket,(array_agg(close order by time desc))[1] close from wg_tv_bars where time>=cutoff-480*60 and time<cutoff group by 1 having count(*)=15)
 select array_agg(close::double precision order by bucket) into trends from b;
 if coalesce(cardinality(trends),0)<21 then return jsonb_build_object('reason','warming_up','decision',null);end if;
 select jsonb_agg(jsonb_build_object('time',time*1000,'price',close) order by time) into closes from wg_tv_bars where time>=cutoff-240*60 and time<cutoff;
 if coalesce(jsonb_array_length(closes),0)<>240 or (closes->-1->>'time')::bigint<>(cutoff-60)*1000 then return jsonb_build_object('reason','history_gap','decision',null);end if;
 fast:=wg_market_ema(trends,8);slow:=wg_market_ema(trends,21);
 if fast>slow and trends[cardinality(trends)]>fast then direction:='buy';
 elsif fast<slow and trends[cardinality(trends)]<fast then direction:='sell';
 else return jsonb_build_object('reason','no_setup','decision',null);end if;
 sgn:=case when direction='buy' then 1 else -1 end;
 entry:=round(f.price,2);
 -- A pending current visit is allowed only with three prior COMPLETE rebounds.
 zone:=wg_mt5_rebound_evidence(closes,direction,entry);
 if zone is null then return jsonb_build_object('reason','no_structure','decision',null);end if;
 candle:=wg_mt5_candle_confirmation(bars,direction,zone);
 if candle is null or (direction='buy' and f.price<(candle->>'close')::numeric) or (direction='sell' and f.price>(candle->>'close')::numeric) then return jsonb_build_object('reason','no_price_action','decision',null);end if;
 select avg(abs(prices[i]-prices[i-1])) into volatility from generate_series(n-19,n) i;
 distance:=ceil(greatest(volatility*3,entry*0.001)*100)/100;
 return jsonb_build_object('reason','ready','strategy','tv-oanda-m15-8-21-m1-pa-rebound-v1','decision',jsonb_build_object(
 'at',cutoff*1000,'direction',direction,'entry',entry,'stop',round(entry-sgn*(distance+3),2),
 'targets',jsonb_build_array(round(entry+sgn*distance,2),round(entry+sgn*distance*2,2),round(entry+sgn*distance*3,2)),
 'levelsBasis',jsonb_build_object('method','tv-m1-pa-rebounds-v1','support',zone,'candle',candle,'symbol','OANDA:XAUUSD','priceBasis','closed-M1-reference','price',f.price,'quoteMs',f.time_ms)));
end; $$;


-- Prefer MT5 for NEW positions. An open position always keeps its own source.
create function public.wg_market_selected_source() returns jsonb
language plpgsql security invoker set search_path=public as $$
declare s wg_signals;f wg_mt5_feed;t wg_tv_feed;p jsonb;chosen text;bars integer;
begin
 select x.* into s from wg_signals x join wg_market_state m on x.id=m.signal_id where m.id=1 and x.status='open';
 if s.symbol='TV:OANDA:XAUUSD' then chosen:='TV:OANDA:XAUUSD';p:=wg_tv_market_plan();
 elsif s.symbol='MT5:xauusd.s' then chosen:='MT5:xauusd.s';p:=wg_mt5_market_plan();
 else
  p:=wg_mt5_market_plan();chosen:='MT5:xauusd.s';
  if p->>'reason'='awaiting_mt5' then
   p:=wg_tv_market_plan();chosen:='TV:OANDA:XAUUSD';
   if p->>'reason'='awaiting_tradingview' then p:=jsonb_build_object('reason','awaiting_sources','decision',null);end if;
  end if;
 end if;
 if chosen='MT5:xauusd.s' then
  select * into f from wg_mt5_feed where id=1;
  select count(*) into bars from wg_mt5_signal_bars where symbol=f.symbol and server=f.server and time>=floor(f.quote_ms/60000.0)::bigint*60-480*60 and time<floor(f.quote_ms/60000.0)::bigint*60;
  return jsonb_build_object('source',chosen,'quote_ms',f.quote_ms,'display_price',f.bid,'monitor_buy',f.bid,'monitor_sell',f.ask,'plan',p,'progress',least(330,bars));
 end if;
 select * into t from wg_tv_feed where id=1;
 select count(*) into bars from wg_tv_bars where time>=floor(t.time_ms/60000.0)::bigint*60-480*60 and time<floor(t.time_ms/60000.0)::bigint*60;
 -- TradingView reports a CLOSED reference price, never a fabricated bid or ask.
 return jsonb_build_object('source',chosen,'quote_ms',t.time_ms,'display_price',t.price,'monitor_buy',t.price,'monitor_sell',t.price,'plan',p,'progress',least(330,bars));
end; $$;

create or replace function public.wg_mt5_market_tick(p_group text default null) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare m wg_market_state;f record;s wg_signals;plan jsonb;d jsonb;why text;goals numeric[];actor uuid;u wg_profiles;ev bigint;px numeric;hit integer;last_at timestamptz;recipients integer:=0;
begin
 perform pg_advisory_xact_lock(910726431);
 perform pg_advisory_xact_lock(910726432);
 perform pg_advisory_xact_lock(910726435);
 perform set_config('wetagold.market_worker','on',true);
 select * into m from wg_market_state where id=1 for update;
 if m.signal_id is not null then
  select * into s from wg_signals where id=m.signal_id for update;
  if s.status='open' and s.market_strategy is distinct from 'mt5-m15-8-21-m1-pa-rebound-v1' and s.market_strategy is distinct from 'tv-oanda-m15-8-21-m1-pa-rebound-v1' then
   update wg_signals set status='unresolved',market_resolution='data_gap' where id=s.id;
   update wg_market_state set signal_id=null,last_exit_at=clock_timestamp() where id=1;
   insert into wg_audit(actor_id,action,subject) values(s.author_id,'market.unresolved',s.id::text);
   m.signal_id:=null;m.last_exit_at:=clock_timestamp();
  end if;
 end if;
 select * into f from jsonb_to_record(wg_market_selected_source()) as x(source text,quote_ms bigint,display_price numeric,monitor_buy numeric,monitor_sell numeric,plan jsonb,progress integer);
 plan:=f.plan;why:=plan->>'reason';
 if why in ('awaiting_mt5','awaiting_tradingview','awaiting_sources') then
  update wg_market_state set last_attempt_at=clock_timestamp(),reason=why,last_error='PRICE_SOURCE_OFFLINE',lease=null,lease_until=null where id=1;
  return jsonb_build_object('ok',true,'reason',why,'source',f.source);end if;
 last_at:=to_timestamp(f.quote_ms/1000.0);
 if m.analysis->>'source'=f.source and m.last_quote_at is not null and last_at<=m.last_quote_at then return jsonb_build_object('ok',true,'duplicate',true,'reason',m.reason);end if;
 if m.signal_id is not null then
  select * into s from wg_signals where id=m.signal_id for update;
  if s.status='open' then
   px:=case when s.direction='buy' then f.monitor_buy else f.monitor_sell end;hit:=s.targets_hit;
   if s.symbol is distinct from f.source or (m.last_quote_at is not null and last_at-m.last_quote_at>interval '90 seconds') then
    update wg_signals set status='unresolved',market_resolution='data_gap' where id=s.id;
   else
    update wg_signals set market_observed_at=last_at,market_observed_price=px,market_resolution='observing' where id=s.id;
    if (s.direction='buy' and px<=s.stop) or (s.direction='sell' and px>=s.stop) then
     update wg_signals set status='stopped',market_resolution='observed_stop' where id=s.id;
    else
     while hit<cardinality(s.targets) and ((s.direction='buy' and px>=s.targets[hit+1]) or (s.direction='sell' and px<=s.targets[hit+1])) loop
      hit:=hit+1;update wg_signals set targets_hit=hit,status=case when hit=cardinality(targets) then 'target' else 'open' end,market_resolution='observed_target' where id=s.id;
     end loop;
     if hit<cardinality(s.targets) and clock_timestamp()-s.opened_at>=interval '120 minutes' then update wg_signals set status='unresolved',market_resolution='time_limit' where id=s.id;end if;
    end if;
   end if;
  end if;
  select * into s from wg_signals where id=m.signal_id;
  if s.status<>'open' then update wg_market_state set signal_id=null,last_exit_at=clock_timestamp() where id=1;end if;
  why:='active_position'; -- Never close and open in the same tick.
 elsif not m.enabled then why:='disabled';
 elsif (select paused from wg_settings where id=1) then why:='paused';
 elsif m.last_exit_at>clock_timestamp()-interval '15 minutes' then why:='cooldown';
 elsif exists(select 1 from wg_signals where status in ('open','pending') and (status='open' or expires_at>now())) then why:='active_position';
 elsif plan->'decision' is not null and jsonb_typeof(plan->'decision')='object' then
  d:=plan->'decision';
  if m.last_decision_at is null or to_timestamp((d->>'at')::numeric/1000)>m.last_decision_at then
   select array_agg(value::numeric order by ord) into goals from jsonb_array_elements_text(d->'targets') with ordinality t(value,ord);
   select id into actor from wg_profiles where role='admin' and active and not must_change_password;
   if actor is null then raise exception 'WG: حساب المدير غير متاح.';end if;
   insert into wg_signals(request_id,symbol,direction,entry,stop,target,targets,reference_price,quote_at,status,opened_at,author_id,telegram_group_chat_id,market_strategy,market_resolution,market_observed_at,market_observed_price,risk_reference_pct,market_levels)
    values(case when f.source='MT5:xauusd.s' then 'mt5-pa-v1-' else 'tv-pa-v1-' end||(d->>'at'),f.source,d->>'direction',(d->>'entry')::numeric,(d->>'stop')::numeric,goals[3],goals,(d->>'entry')::numeric,last_at,'open',clock_timestamp(),actor,p_group,plan->>'strategy','observing',last_at,case when d->>'direction'='buy' then f.monitor_buy else f.monitor_sell end,0.5,d->'levelsBasis') returning * into s;
   select id into ev from wg_signal_events where signal_id=s.id and kind='publish';
   for u in select * from wg_profiles where role='member' and active and not must_change_password and expires_at>now() and used<quota order by id for update loop
    insert into wg_allocations(user_id,signal_id) values(u.id,s.id);update wg_profiles set used=used+1 where id=u.id;
    if u.telegram_chat_id is not null then insert into wg_outbox(signal_id,event_id,user_id,destination) values(s.id,ev,u.id,u.telegram_chat_id);end if;
    recipients:=recipients+1;
   end loop;
   if nullif(p_group,'') is not null then insert into wg_outbox(signal_id,event_id,destination) values(s.id,ev,p_group);end if;
   update wg_market_state set signal_id=s.id,last_decision_at=to_timestamp((d->>'at')::numeric/1000) where id=1;
   insert into wg_audit(actor_id,action,subject) values(actor,'market.publish',s.id::text);
   why:='active_position';
  end if;
 end if;
 update wg_market_state set last_attempt_at=clock_timestamp(),last_quote_at=last_at,last_price=f.display_price,reason=why,last_error=null,lease=null,lease_until=null,progress_minutes=f.progress,analysis=jsonb_build_object('source',f.source,'strategy',plan->>'strategy') where id=1;
 return jsonb_build_object('ok',true,'reason',why,'source',f.source,'recipients',recipients);
end; $$;


revoke all on function public.wg_tv_ingest(jsonb),public.wg_tv_market_plan(),public.wg_market_selected_source() from public,anon,authenticated;
grant execute on function public.wg_tv_ingest(jsonb),public.wg_tv_market_plan(),public.wg_market_selected_source() to service_role;
notify pgrst,'reload schema';
commit;
