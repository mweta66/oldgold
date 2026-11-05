-- Same October-29 v2 entries and original targets. New signals only.
-- Buy SL = original SL - $3; sell SL = original SL + $3.
begin;
select pg_advisory_xact_lock(910726431);
CREATE OR REPLACE FUNCTION public.wg_market_cloud_plan(p_at timestamp with time zone, p_price numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare coverage jsonb; cutoff timestamptz:=date_trunc('minute',p_at); prices double precision[]; trends double precision[];
  fast double precision; slow double precision; direction text; why text; n integer; volatility numeric; entry numeric; distance numeric; sign integer; sl numeric; base_stop numeric; goals numeric[];
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
    select avg(abs(prices[i]-prices[i-1]))::numeric into volatility from generate_series(n-19,n) i;
    if direction is null or coalesce(volatility,0)<=0 then why:='no_setup';
    else
      entry:=round(p_price,2);distance:=ceil(greatest(volatility*3,entry*0.001)*100)/100;
      sign:=case when direction='buy' then 1 else -1 end;
      base_stop:=round(entry-sign*distance,2);
      sl:=round(base_stop-sign*3,2);
      goals:=array[round(entry+sign*distance,2),round(entry+sign*distance*2,2),round(entry+sign*distance*3,2)];
      why:=case when least(sl,goals[1],goals[2],goals[3])>0 then 'ready' else 'no_setup' end;
    end if;
  end if;
  return jsonb_build_object('strategy','sampled-m15-8-21-m1-breakout-20-rolling5h-v2','reason',why,'progress',(coverage->>'observed')::integer,'window',coverage,
    'decision',case when why='ready' then jsonb_build_object('at',extract(epoch from cutoff)::bigint*1000,'direction',direction,'entry',entry,'stop',sl,'targets',to_jsonb(goals)) else null end);
end; $function$;
notify pgrst,'reload schema';
commit;
