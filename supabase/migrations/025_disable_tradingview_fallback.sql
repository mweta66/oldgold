-- Owner cancelled the paid TradingView fallback. Preserve all history and MT5 rules.
begin;
select pg_advisory_xact_lock(910726431);
select pg_advisory_xact_lock(910726435);
create or replace function public.wg_mt5_market_tick(p_group text default null) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare m wg_market_state;f wg_mt5_feed;s wg_signals;plan jsonb;d jsonb;why text;goals numeric[];actor uuid;u wg_profiles;ev bigint;px numeric;hit integer;last_at timestamptz;recipients integer:=0;
begin
 perform pg_advisory_xact_lock(910726431);
 perform pg_advisory_xact_lock(910726432);
 perform set_config('wetagold.market_worker','on',true);
 select * into m from wg_market_state where id=1 for update;
 select * into f from wg_mt5_feed where id=1;
 if m.signal_id is not null then
  select * into s from wg_signals where id=m.signal_id for update;
  if s.status='open' and s.market_strategy is distinct from 'mt5-m15-8-21-m1-pa-rebound-v1' then
   update wg_signals set status='unresolved',market_resolution='data_gap' where id=s.id;
   update wg_market_state set signal_id=null,last_exit_at=clock_timestamp() where id=1;
   insert into wg_audit(actor_id,action,subject) values(s.author_id,'market.unresolved',s.id::text);
   m.signal_id:=null;m.last_exit_at:=clock_timestamp();
  end if;
 end if;
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


create or replace function public.wg_tv_ingest(p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path=public as $$begin raise exception 'TRADINGVIEW_DISABLED';end;$$;
create or replace function public.wg_tv_market_plan() returns jsonb
language sql security invoker set search_path=public as $$select jsonb_build_object('reason','disabled','decision',null)$$;
create or replace function public.wg_market_selected_source() returns jsonb
language sql security invoker set search_path=public as $$select jsonb_build_object('source','MT5:xauusd.s','plan',wg_mt5_market_plan())$$;
revoke all on function public.wg_tv_ingest(jsonb),public.wg_tv_market_plan() from public,anon,authenticated,service_role;
update wg_market_state set reason='awaiting_mt5',last_error='MT5_OFFLINE',analysis=jsonb_build_object('source','MT5:xauusd.s') where id=1 and signal_id is null;
notify pgrst,'reload schema';
commit;
