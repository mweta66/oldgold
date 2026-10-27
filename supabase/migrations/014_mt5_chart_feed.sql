-- Isolated read-only broker feed for the admin chart. Does not switch the
-- signal engine, rewrite trades, send Telegram, or start any scheduler.
begin;
create table public.wg_mt5_feed (
  id integer primary key check(id=1),
  symbol text not null check(length(symbol) between 1 and 64),
  server text not null check(length(server) between 1 and 128),
  bid numeric not null check(bid>0 and bid<1000000),
  ask numeric not null check(ask>=bid and ask<1000000),
  quote_ms bigint not null, observed_ms bigint not null,
  received_at timestamptz not null default clock_timestamp()
);
create table public.wg_mt5_bars (
  time bigint primary key check(time>0 and time%60=0),
  open numeric not null check(open>0 and open<1000000),
  high numeric not null check(high>0 and high<1000000),
  low numeric not null check(low>0 and low<1000000),
  close numeric not null check(close>0 and close<1000000),
  volume bigint not null check(volume>=0 and volume<=1000000000000),
  observed_ms bigint not null,
  check(low<=least(open,close) and high>=greatest(open,close) and low<=high)
);
alter table public.wg_mt5_feed enable row level security;
alter table public.wg_mt5_bars enable row level security;
revoke all on public.wg_mt5_feed,public.wg_mt5_bars from public,anon,authenticated;
grant all on public.wg_mt5_feed,public.wg_mt5_bars to service_role;

create function public.wg_mt5_ingest(p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare previous wg_mt5_feed; b jsonb; stamp bigint:=floor(extract(epoch from clock_timestamp())*1000);
begin
  perform pg_advisory_xact_lock(910726432);
  if jsonb_typeof(p_payload) is distinct from 'object' or
    jsonb_typeof(p_payload->'bars') is distinct from 'array' or
    jsonb_array_length(p_payload->'bars')>80 or
    coalesce((p_payload->>'timeMs')::bigint,0) not between stamp-15000 and stamp+5000 or
    coalesce((p_payload->>'observedMs')::bigint,0) not between stamp-15000 and stamp+5000 or
    (p_payload->>'observedMs')::bigint<(p_payload->>'timeMs')::bigint then
    raise exception 'MT5_DATA_INVALID';
  end if;
  select * into previous from wg_mt5_feed where id=1 for update;
  if found then
    if previous.symbol is distinct from p_payload->>'symbol' or previous.server is distinct from p_payload->>'server' then
      raise exception 'MT5_SOURCE_MISMATCH';
    end if;
    if (p_payload->>'timeMs')::bigint<previous.quote_ms or (p_payload->>'observedMs')::bigint<previous.observed_ms then
      return jsonb_build_object('ok',true,'skipped',true);
    end if;
  end if;
  insert into wg_mt5_feed(id,symbol,server,bid,ask,quote_ms,observed_ms)
  values(1,p_payload->>'symbol',p_payload->>'server',(p_payload->>'bid')::numeric,
    (p_payload->>'ask')::numeric,(p_payload->>'timeMs')::bigint,(p_payload->>'observedMs')::bigint)
  on conflict(id) do update set bid=excluded.bid,ask=excluded.ask,quote_ms=excluded.quote_ms,
    observed_ms=excluded.observed_ms,received_at=clock_timestamp();
  for b in select value from jsonb_array_elements(p_payload->'bars') loop
    if coalesce((b->>'time')::bigint,0)*1000 not between stamp-604800000 and stamp+5000 then
      raise exception 'MT5_BAR_TIME_INVALID';
    end if;
    insert into wg_mt5_bars(time,open,high,low,close,volume,observed_ms)
    values((b->>'time')::bigint,(b->>'open')::numeric,(b->>'high')::numeric,
      (b->>'low')::numeric,(b->>'close')::numeric,(b->>'volume')::bigint,(p_payload->>'observedMs')::bigint)
    on conflict(time) do update set open=excluded.open,high=excluded.high,low=excluded.low,
      close=excluded.close,volume=excluded.volume,observed_ms=excluded.observed_ms
      where excluded.observed_ms>=wg_mt5_bars.observed_ms;
  end loop;
  delete from wg_mt5_bars where time<floor(extract(epoch from clock_timestamp()-interval '7 days'));
  return jsonb_build_object('ok',true,'skipped',false);
end; $$;
revoke all on function public.wg_mt5_ingest(jsonb) from public,anon,authenticated;
grant execute on function public.wg_mt5_ingest(jsonb) to service_role;
notify pgrst,'reload schema';
commit;
