-- New signals only. Restore structure filtering in the actual cloud planner.
-- Nearest support/resistance stop: $6-$10; each target $1 before its level.
-- 013 cumulative-risk policy stays disabled; no historical rows are changed.
begin;
select pg_advisory_xact_lock(910726431);
create or replace function public.wg_market_structure(p_at timestamptz,p_direction text,p_entry numeric) returns jsonb
language plpgsql security definer set search_path=public as $$
declare points jsonb; pivots jsonb:='[]'; bad bigint[]; c jsonb; p jsonb; anchor jsonb;
  cutoff timestamptz:=date_trunc('minute',p_at); stamp bigint; confirmed bigint;
  n integer; i integer; j integer; valid boolean; lo boolean; hi boolean;
  vol numeric:=0; buffer numeric; stop numeric; risk numeric; target numeric; rr numeric;
  goals jsonb:='[]'; swings jsonb:='[]'; buy boolean:=p_direction='buy'; last_goal numeric;
begin
  if p_at is null or p_direction not in ('buy','sell') or p_entry is null or p_entry<=0 or p_entry<>round(p_entry,2) then return jsonb_build_object('reason','no_structure','decision',null); end if;
  with samples as (
    select quote_at,price,quote_at-lag(quote_at) over(order by quote_at) gap
    from wg_market_quotes where quote_at>=cutoff-interval '480 minutes' and quote_at<cutoff
  ), minutes as (
    select distinct on(date_trunc('minute',quote_at)) date_trunc('minute',quote_at) t,price from samples order by date_trunc('minute',quote_at),quote_at desc
  ) select (select jsonb_agg(jsonb_build_object('time',extract(epoch from t)::bigint*1000,'price',price) order by t) from minutes),
    (select array_agg(distinct extract(epoch from date_trunc('minute',quote_at))::bigint*1000) from samples where gap>interval '90 seconds') into points,bad;
  n:=coalesce(jsonb_array_length(points),0);
  if n<21 then return jsonb_build_object('reason','no_structure','decision',null); end if;
  for i in n-20..n-1 loop vol:=vol+abs((points->i->>'price')::numeric-(points->(i-1)->>'price')::numeric); end loop;
  vol:=round(vol/20,8); buffer:=round(greatest(0.02,vol*0.5),8);
  if vol<=0 then return jsonb_build_object('reason','no_structure','decision',null); end if;
  for i in 2..n-3 loop
    c:=points->i;stamp:=(c->>'time')::bigint;valid:=true;lo:=true;hi:=true;
    for j in i-2..i+2 loop
      p:=points->j;
      if (p->>'time')::bigint<>stamp+(j-i)*60000 or (p->>'time')::bigint=any(bad) then valid:=false; exit; end if;
      if j<>i then
        if (c->>'price')::numeric>=(p->>'price')::numeric then lo:=false; end if;
        if (c->>'price')::numeric<=(p->>'price')::numeric then hi:=false; end if;
      end if;
    end loop;
    if not valid or not (lo or hi) then continue; end if;
    confirmed:=stamp+180000;
    if exists(select 1 from jsonb_array_elements(points) x where (x->>'time')::bigint>=confirmed and
      ((lo and (x->>'price')::numeric<=(c->>'price')::numeric) or (hi and (x->>'price')::numeric>=(c->>'price')::numeric))) then continue; end if;
    pivots:=pivots||jsonb_build_array(c||jsonb_build_object('confirmedAt',confirmed,'kind',case when lo then 'low' else 'high' end));
  end loop;
  select x into anchor from jsonb_array_elements(pivots) x where x->>'kind'=case when buy then 'low' else 'high' end and
    (x->>'time')::bigint>=extract(epoch from cutoff-interval '90 minutes')::bigint*1000 and
    (case when buy then (x->>'price')::numeric<p_entry else (x->>'price')::numeric>p_entry end) order by abs((x->>'price')::numeric-p_entry),(x->>'time')::bigint desc limit 1;
  if anchor is null then return jsonb_build_object('reason','no_structure','decision',null); end if;
  stop:=case when buy then floor(((anchor->>'price')::numeric-buffer)*100)/100 else ceil(((anchor->>'price')::numeric+buffer)*100)/100 end;
  risk:=abs(p_entry-stop);
  if stop<=0 or risk<6 or risk>10 then return jsonb_build_object('reason','no_structure','decision',null); end if;
  for p in select x from jsonb_array_elements(pivots) x where x->>'kind'=case when buy then 'high' else 'low' end and
    (case when buy then (x->>'price')::numeric>p_entry else (x->>'price')::numeric<p_entry end)
    order by (case when buy then 1 else -1 end)*(x->>'price')::numeric,(x->>'time')::bigint desc loop
    target:=case when buy then floor(((p->>'price')::numeric-1)*100)/100 else ceil(((p->>'price')::numeric+1)*100)/100 end;
    if (buy and target<=p_entry) or (not buy and target>=p_entry) then return jsonb_build_object('reason','poor_reward','decision',null); end if;
    if last_goal is not null and abs(target-last_goal)<0.01 then continue; end if;
    goals:=goals||jsonb_build_array(target);swings:=swings||jsonb_build_array(p);last_goal:=target;
    exit when jsonb_array_length(goals)=3;
  end loop;
  if jsonb_array_length(goals)=0 then return jsonb_build_object('reason','no_structure','decision',null); end if;
  rr:=round(abs((goals->>0)::numeric-p_entry)/risk,8);
  if rr<1.2 then return jsonb_build_object('reason','poor_reward','decision',null); end if;
  return jsonb_build_object('reason','ready','decision',jsonb_build_object('entry',p_entry,'stop',stop,'targets',goals,'levelsBasis',jsonb_build_object('method','confirmed-sampled-pivots-bounded-stop-v3','minStopDistance',6,'maxStopDistance',10,'targetBuffer',1,'volatility',vol,'buffer',buffer,'stopSwing',anchor,'targetSwings',swings,'firstRewardRisk',rr)));
end; $$;

create or replace function public.wg_market_cloud_plan(p_at timestamptz,p_price numeric) returns jsonb
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


notify pgrst, 'reload schema';
commit;
