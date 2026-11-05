-- Broker OHLC-only rebound and price-action engine. No Gold API fallback.
begin;
select pg_advisory_xact_lock(910726431);
select pg_advisory_xact_lock(910726432);
create table public.wg_mt5_source (
 id integer primary key check(id=1),symbol text not null check(symbol='xauusd.s'),server text,
 check(server is null or length(server) between 1 and 128)
);
insert into public.wg_mt5_source values(1,'xauusd.s',null);
create table public.wg_mt5_signal_bars (
 symbol text not null,server text not null,time bigint not null check(time>0 and time%60=0),
 open numeric not null,high numeric not null,low numeric not null,close numeric not null,
 observed_ms bigint not null,primary key(symbol,server,time),
 check(low>0 and high<1000000 and low<=least(open,close) and high>=greatest(open,close))
);
alter table public.wg_mt5_source enable row level security;
alter table public.wg_mt5_signal_bars enable row level security;
revoke all on public.wg_mt5_source,public.wg_mt5_signal_bars from public,anon,authenticated;
grant all on public.wg_mt5_source,public.wg_mt5_signal_bars to service_role;
alter table public.wg_signals drop constraint wg_signals_symbol_check;
alter table public.wg_signals add constraint wg_signals_symbol_check check(symbol in ('OANDA:XAUUSD','GOLDAPI:XAUUSD','MT5:xauusd.s'));
create unique index wg_one_mt5_position on public.wg_signals(symbol) where symbol='MT5:xauusd.s' and status in ('open','pending');
alter function public.wg_mt5_ingest(jsonb) rename to wg_mt5_ingest_chart_legacy;
-- Internal chart storage helper; no browser role can invoke it.
revoke all on function public.wg_mt5_ingest_chart_legacy(jsonb) from public,anon,authenticated,service_role;
create function public.wg_mt5_rebound_evidence(p_closes jsonb,p_direction text,p_entry numeric) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare prices numeric[]; times bigint[]; n integer; s integer; i integer; j integer; level numeric; d numeric;
 armed boolean; touched boolean; breached boolean; broken boolean; broken_run integer; entered bigint; extreme numeric; bounces jsonb; candidate jsonb; best jsonb; best_distance numeric;
begin
 s:=case p_direction when 'buy' then 1 when 'sell' then -1 else 0 end;
 if s=0 or p_entry is null or p_entry<=0 or jsonb_typeof(p_closes) is distinct from 'array' or jsonb_array_length(p_closes)<>240 then return null;end if;
 select array_agg((x->>'price')::numeric order by ord),array_agg((x->>'time')::bigint order by ord)
 into prices,times from jsonb_array_elements(p_closes) with ordinality t(x,ord);
 n:=cardinality(prices);
 for i in 1..n loop
  if prices[i] is null or prices[i]<=0 or times[i] is null or (i>1 and times[i]<>times[i-1]+60000) then return null;end if;
 end loop;
 for i in 3..n-2 loop
  level:=prices[i];
  if s*(p_entry-level)<=5 or s*(prices[i-2]-level)<0 or s*(prices[i-1]-level)<0 or s*(prices[i+1]-level)<0 or s*(prices[i+2]-level)<0 or (prices[i-2]=level and prices[i-1]=level and prices[i+1]=level and prices[i+2]=level) then continue;end if;
  armed:=false;touched:=false;breached:=false;broken:=false;broken_run:=0;bounces:='[]'::jsonb;
  for j in 1..n loop
   d:=s*(prices[j]-level);
   broken_run:=case when d< -5 then broken_run+1 else 0 end;
   if broken_run>=2 then broken:=true;exit;end if;
   if d>5 then
    if touched and not breached then bounces:=bounces||jsonb_build_array(jsonb_build_object('enteredAt',entered,'exitedAt',times[j],'extreme',extreme));end if;
    armed:=true;touched:=false;breached:=false;
   elsif armed then
    if not touched then entered:=times[j];extreme:=prices[j];
    elsif s*(prices[j]-extreme)<0 then extreme:=prices[j];end if;
    touched:=true;
    if d< -5 then breached:=true;end if;
   end if;
  end loop;
  if not broken and jsonb_array_length(bounces)>=3 then
   candidate:=jsonb_build_object('method','mt5-m1-rebounds-4h-zone5-v1','kind',case when s=1 then 'support' else 'resistance' end,'level',level,'lower',level-5,'upper',level+5,'zoneUSD',5,'windowMinutes',240,'touches',jsonb_array_length(bounces),'bounces',bounces,'windowStart',times[1],'windowEnd',times[n]+60000);
   if best is null or abs(p_entry-level)<best_distance or (abs(p_entry-level)=best_distance and jsonb_array_length(bounces)>(best->>'touches')::integer) or
    (abs(p_entry-level)=best_distance and jsonb_array_length(bounces)=(best->>'touches')::integer and (bounces->-1->>'exitedAt')::bigint>(best->'bounces'->-1->>'exitedAt')::bigint) then
    best:=candidate;best_distance:=abs(p_entry-level);
   end if;
  end if;
 end loop;
 return best;
end; $$;


-- Exact rules on CLOSED real M1 candles. The live candle is never confirmation.
create function public.wg_mt5_candle_confirmation(p_bars jsonb,p_direction text,p_zone jsonb) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare n integer;i integer;c jsonb;p jsonb;o numeric;h numeric;l numeric;cl numeric;po numeric;pc numeric;
 body numeric;r numeric;upper_wick numeric;lower_wick numeric;kind text;buy boolean;
begin
 if p_direction not in ('buy','sell') or jsonb_typeof(p_bars) is distinct from 'array' or jsonb_array_length(p_bars)<3 or p_zone is null then return null;end if;
 buy:=p_direction='buy';n:=jsonb_array_length(p_bars);
 for i in reverse n-1..n-2 loop
  c:=p_bars->i;p:=p_bars->(i-1);
  if (c->>'time')::bigint<>(p->>'time')::bigint+60 then continue;end if;
  o:=(c->>'open')::numeric;h:=(c->>'high')::numeric;l:=(c->>'low')::numeric;cl:=(c->>'close')::numeric;
  po:=(p->>'open')::numeric;pc:=(p->>'close')::numeric;
  body:=abs(cl-o);r:=h-l;upper_wick:=h-greatest(o,cl);lower_wick:=least(o,cl)-l;
  if r<=0 or body<=0 or (buy and cl<=o) or (not buy and cl>=o) then continue;end if;
  if buy then
   if l<(p_zone->>'lower')::numeric or l>(p_zone->>'upper')::numeric or cl<=(p_zone->>'level')::numeric or cl<h-r*0.25 then continue;end if;
  else
   if h<(p_zone->>'lower')::numeric or h>(p_zone->>'upper')::numeric or cl>=(p_zone->>'level')::numeric or cl>l+r*0.25 then continue;end if;
  end if;
  kind:=null;
  if body>=r*0.5 and ((buy and pc<po and o<=pc and cl>=po) or (not buy and pc>po and o>=pc and cl<=po)) then kind:='engulfing';
  elsif body>=r*0.1 and ((buy and lower_wick>=2*body and upper_wick<=body) or (not buy and upper_wick>=2*body and lower_wick<=body)) then kind:='rejection';end if;
  if kind is not null then return jsonb_build_object('pattern',kind,'direction',p_direction,'time',(c->>'time')::bigint,'offset',n-1-i,'open',o,'high',h,'low',l,'close',cl);end if;
 end loop;
 return null;
end; $$;

create function public.wg_mt5_market_plan() returns jsonb
language plpgsql security invoker set search_path=public as $$
declare f wg_mt5_feed;cfg wg_mt5_source;cutoff bigint;bars jsonb;closes jsonb;trends double precision[];prices numeric[];
 fast double precision;slow double precision;direction text;entry numeric;distance numeric;volatility numeric;sgn integer;
 zone jsonb;candle jsonb;why text:='awaiting_mt5';n integer;
begin
 select * into cfg from wg_mt5_source where id=1;
 select * into f from wg_mt5_feed where id=1;
 if cfg.server is null or f.symbol is distinct from cfg.symbol or f.server is distinct from cfg.server or
  f.quote_ms<floor(extract(epoch from clock_timestamp())*1000)-15000 or f.quote_ms>floor(extract(epoch from clock_timestamp())*1000)+5000 or f.received_at<clock_timestamp()-interval '15 seconds' or f.quote_ms is null then
  return jsonb_build_object('reason',why,'decision',null);end if;
 cutoff:=floor(f.quote_ms/60000.0)::bigint*60;
 select jsonb_agg(jsonb_build_object('time',time,'open',open,'high',high,'low',low,'close',close) order by time),array_agg(close order by time)
 into bars,prices from wg_mt5_signal_bars where symbol=cfg.symbol and server=cfg.server and time>=cutoff-480*60 and time<cutoff;
 n:=coalesce(cardinality(prices),0);
 if n<315 then return jsonb_build_object('reason','warming_up','decision',null);end if;
 with b as (select floor(time/900.0)::bigint bucket,(array_agg(close order by time desc))[1] close from wg_mt5_signal_bars where symbol=cfg.symbol and server=cfg.server and time>=cutoff-480*60 and time<cutoff group by 1 having count(*)=15)
 select array_agg(close::double precision order by bucket) into trends from b;
 if coalesce(cardinality(trends),0)<21 then return jsonb_build_object('reason','warming_up','decision',null);end if;
 select jsonb_agg(jsonb_build_object('time',time*1000,'price',close) order by time) into closes from wg_mt5_signal_bars where symbol=cfg.symbol and server=cfg.server and time>=cutoff-240*60 and time<cutoff;
 if coalesce(jsonb_array_length(closes),0)<>240 or (closes->-1->>'time')::bigint<>(cutoff-60)*1000 then return jsonb_build_object('reason','history_gap','decision',null);end if;
 fast:=wg_market_ema(trends,8);slow:=wg_market_ema(trends,21);
 if fast>slow and trends[cardinality(trends)]>fast then direction:='buy';
 elsif fast<slow and trends[cardinality(trends)]<fast then direction:='sell';
 else return jsonb_build_object('reason','no_setup','decision',null);end if;
 sgn:=case when direction='buy' then 1 else -1 end;
 entry:=round(case when direction='buy' then f.ask else f.bid end,2);
 -- A pending current visit is allowed only with three prior COMPLETE rebounds.
 zone:=wg_mt5_rebound_evidence(closes,direction,entry);
 if zone is null then return jsonb_build_object('reason','no_structure','decision',null);end if;
 candle:=wg_mt5_candle_confirmation(bars,direction,zone);
 if candle is null or (direction='buy' and f.bid<(candle->>'close')::numeric) or (direction='sell' and f.bid>(candle->>'close')::numeric) then return jsonb_build_object('reason','no_price_action','decision',null);end if;
 select avg(abs(prices[i]-prices[i-1])) into volatility from generate_series(n-19,n) i;
 distance:=ceil(greatest(volatility*3,entry*0.001)*100)/100;
 return jsonb_build_object('reason','ready','strategy','mt5-m15-8-21-m1-pa-rebound-v1','decision',jsonb_build_object(
 'at',cutoff*1000,'direction',direction,'entry',entry,'stop',round(entry-sgn*(distance+3),2),
 'targets',jsonb_build_array(round(entry+sgn*distance,2),round(entry+sgn*distance*2,2),round(entry+sgn*distance*3,2)),
 'levelsBasis',jsonb_build_object('method','mt5-m1-pa-rebounds-v1','support',zone,'candle',candle,'symbol',cfg.symbol,'server',cfg.server,'bid',f.bid,'ask',f.ask,'quoteMs',f.quote_ms)));
end; $$;

create function public.wg_mt5_ingest(p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare cfg wg_mt5_source;outcome jsonb;b jsonb;
begin
 perform pg_advisory_xact_lock(910726432);
 select * into cfg from wg_mt5_source where id=1 for update;
 if p_payload->>'symbol' is distinct from cfg.symbol or coalesce(length(p_payload->>'server'),0) not between 1 and 128 or
 (cfg.server is not null and p_payload->>'server' is distinct from cfg.server) then raise exception 'MT5_SOURCE_MISMATCH';end if;
 -- Only a successfully validated, token-authenticated first packet may bind the server.
 if cfg.server is null then delete from wg_mt5_feed;end if;
 outcome:=wg_mt5_ingest_chart_legacy(p_payload);
 if coalesce((outcome->>'skipped')::boolean,false) then return outcome;end if;
 if cfg.server is null then update wg_mt5_source set server=p_payload->>'server' where id=1;end if;
 for b in select value from jsonb_array_elements(p_payload->'bars') loop
  insert into wg_mt5_signal_bars(symbol,server,time,open,high,low,close,observed_ms)
   values(p_payload->>'symbol',p_payload->>'server',(b->>'time')::bigint,(b->>'open')::numeric,(b->>'high')::numeric,(b->>'low')::numeric,(b->>'close')::numeric,(p_payload->>'observedMs')::bigint)
  on conflict(symbol,server,time) do update set open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,observed_ms=excluded.observed_ms where excluded.observed_ms>=wg_mt5_signal_bars.observed_ms;
 end loop;
 delete from wg_mt5_signal_bars where time<floor(extract(epoch from clock_timestamp()-interval '7 days'));
 return outcome;
end; $$;
grant execute on function public.wg_mt5_ingest_chart_legacy(jsonb) to service_role;

create function public.wg_mt5_market_tick(p_group text default null) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare m wg_market_state;f wg_mt5_feed;s wg_signals;plan jsonb;d jsonb;why text;goals numeric[];actor uuid;u wg_profiles;ev bigint;px numeric;hit integer;last_at timestamptz;recipients integer:=0;
begin
 perform pg_advisory_xact_lock(910726431);
 perform pg_advisory_xact_lock(910726432);
 perform set_config('wetagold.market_worker','on',true);
 select * into m from wg_market_state where id=1 for update;
 select * into f from wg_mt5_feed where id=1;
 plan:=wg_mt5_market_plan();why:=plan->>'reason';
 if why='awaiting_mt5' then
  update wg_market_state set last_attempt_at=clock_timestamp(),reason=why,last_error='MT5_OFFLINE',lease=null,lease_until=null where id=1;
  return jsonb_build_object('ok',true,'reason',why,'source','MT5:xauusd.s');end if;
 last_at:=to_timestamp(f.quote_ms/1000.0);
 if m.last_quote_at is not null and last_at<=m.last_quote_at then return jsonb_build_object('ok',true,'duplicate',true,'reason',m.reason);end if;
 if m.signal_id is not null then
  select * into s from wg_signals where id=m.signal_id for update;
  if s.status='open' then
   px:=case when s.direction='buy' then f.bid else f.ask end;hit:=s.targets_hit;
   if s.market_strategy is distinct from 'mt5-m15-8-21-m1-pa-rebound-v1' or (m.last_quote_at is not null and last_at-m.last_quote_at>interval '90 seconds') then
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
    values('mt5-pa-v1-'||(d->>'at'),'MT5:xauusd.s',d->>'direction',(d->>'entry')::numeric,(d->>'stop')::numeric,goals[3],goals,(d->>'entry')::numeric,last_at,'open',clock_timestamp(),actor,p_group,plan->>'strategy','observing',last_at,case when d->>'direction'='buy' then f.bid else f.ask end,0.5,d->'levelsBasis') returning * into s;
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
 update wg_market_state set last_attempt_at=clock_timestamp(),last_quote_at=last_at,last_price=f.bid,reason=why,last_error=null,lease=null,lease_until=null,progress_minutes=least(330,(select count(*) from wg_mt5_signal_bars where symbol=f.symbol and server=f.server and time>=floor(f.quote_ms/60000.0)::bigint*60-480*60 and time<floor(f.quote_ms/60000.0)::bigint*60)),analysis=jsonb_build_object('source','MT5:xauusd.s','server',f.server,'strategy','mt5-m15-8-21-m1-pa-rebound-v1') where id=1;
 return jsonb_build_object('ok',true,'reason',why,'source','MT5:xauusd.s','recipients',recipients);
end; $$;

-- Retire every old source entry path. Old histories and helpers remain readable.
create or replace function public.wg_market_commit(p_lease uuid,p_quote jsonb,p_plan jsonb,p_group_chat text default null) returns jsonb
language plpgsql security invoker set search_path=public as $$begin raise exception 'MT5_ONLY: Gold API decisions are retired';end;$$;
create or replace function public.wg_market_cloud_quote(p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path=public as $$begin raise exception 'MT5_ONLY: Gold API prices are retired';end;$$;
create or replace function public.wg_market_claim() returns jsonb language sql security invoker set search_path=public as $$select null::jsonb$$;

create or replace function public.wg_market_poll() returns void
language plpgsql security definer set search_path=public as $$
declare p wg_market_poller;origin text;secret text;group_id text;
begin
 if not pg_try_advisory_xact_lock(910726434) then return;end if;
 select * into p from wg_market_poller where id=1 for update;
 if not p.enabled then return;end if;
 select decrypted_secret into group_id from vault.decrypted_secrets where name='xgold_telegram_group_id';
 perform wg_mt5_market_tick(group_id);
 -- Existing private Telegram delivery, leases, mute and reply checks stay intact.
 if not (select telegram_paused from wg_settings where id=1) and exists(select 1 from wg_outbox where state='pending' and next_at<=clock_timestamp()) and
 (p.telegram_request_id is null or exists(select 1 from net._http_response where id=p.telegram_request_id) or p.telegram_requested_at<clock_timestamp()-interval '25 seconds') then
  select decrypted_secret into origin from vault.decrypted_secrets where name='wetagold_site_origin';
  select decrypted_secret into secret from vault.decrypted_secrets where name='wetagold_cron_secret';
  if origin is not null and secret is not null then
   update wg_market_poller set telegram_request_id=net.http_get(url:=origin||'/api/jobs/telegram',headers:=jsonb_build_object('Authorization','Bearer '||secret),timeout_milliseconds:=20000),telegram_requested_at=clock_timestamp() where id=1;
  end if;
 end if;
end; $$;
update wg_market_poller set request_id=null,last_error=null,next_poll_at=null where id=1;
update wg_market_state set lease=null,lease_until=null,last_quote_at=null,last_price=null,reason='awaiting_mt5',last_error='MT5_OFFLINE',analysis=jsonb_build_object('source','MT5:xauusd.s'),progress_minutes=0 where id=1;
revoke all on function public.wg_mt5_ingest(jsonb),public.wg_mt5_rebound_evidence(jsonb,text,numeric),public.wg_mt5_candle_confirmation(jsonb,text,jsonb),public.wg_mt5_market_plan(),public.wg_mt5_market_tick(text) from public,anon,authenticated;
grant execute on function public.wg_mt5_ingest(jsonb),public.wg_mt5_rebound_evidence(jsonb,text,numeric),public.wg_mt5_candle_confirmation(jsonb,text,jsonb),public.wg_mt5_market_plan(),public.wg_mt5_market_tick(text) to service_role;
notify pgrst,'reload schema';
commit;
