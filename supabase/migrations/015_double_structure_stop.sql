-- New signals only: nearest confirmed support/resistance anchors a doubled stop distance.
-- Entry/targets and the original setup reward filter are preserved. Actual reward/risk is recorded.
begin;
create or replace function public.wg_market_structure(p_at timestamptz,p_direction text,p_entry numeric) returns jsonb
language plpgsql security definer set search_path=public as $$
declare points jsonb; pivots jsonb:='[]'; bad bigint[]; c jsonb; p jsonb; anchor jsonb;
  cutoff timestamptz:=date_trunc('minute',p_at); stamp bigint; confirmed bigint;
  n integer; i integer; j integer; valid boolean; lo boolean; hi boolean;
  vol numeric:=0; buffer numeric; stop numeric; risk numeric; base_stop numeric; base_risk numeric; target numeric; rr numeric; base_rr numeric;
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
  base_stop:=case when buy then floor(((anchor->>'price')::numeric-buffer)*100)/100 else ceil(((anchor->>'price')::numeric+buffer)*100)/100 end;
  base_risk:=abs(p_entry-base_stop);
  stop:=case when buy then floor((p_entry-2*base_risk)*100)/100 else ceil((p_entry+2*base_risk)*100)/100 end;
  risk:=abs(p_entry-stop);
  if stop<=0 or risk<0.01 or risk>p_entry*0.01 then return jsonb_build_object('reason','no_structure','decision',null); end if;
  for p in select x from jsonb_array_elements(pivots) x where x->>'kind'=case when buy then 'high' else 'low' end and
    (case when buy then (x->>'price')::numeric>p_entry else (x->>'price')::numeric<p_entry end)
    order by (case when buy then 1 else -1 end)*(x->>'price')::numeric,(x->>'time')::bigint desc loop
    target:=case when buy then floor(((p->>'price')::numeric-buffer)*100)/100 else ceil(((p->>'price')::numeric+buffer)*100)/100 end;
    if (buy and target<=p_entry) or (not buy and target>=p_entry) or (last_goal is not null and abs(target-last_goal)<greatest(0.02,buffer)) then continue; end if;
    goals:=goals||jsonb_build_array(target);swings:=swings||jsonb_build_array(p);last_goal:=target;
    exit when jsonb_array_length(goals)=3;
  end loop;
  if jsonb_array_length(goals)=0 then return jsonb_build_object('reason','no_structure','decision',null); end if;
  rr:=round(abs((goals->>0)::numeric-p_entry)/risk,8);
  base_rr:=round(abs((goals->>0)::numeric-p_entry)/base_risk,8);
  if base_rr<1.2 then return jsonb_build_object('reason','poor_reward','decision',null); end if;
  return jsonb_build_object('reason','ready','decision',jsonb_build_object('entry',p_entry,'stop',stop,'targets',goals,'levelsBasis',jsonb_build_object('method','confirmed-sampled-pivots-double-stop-v2','baseStop',base_stop,'stopDistanceMultiplier',2,'baseFirstRewardRisk',base_rr,'volatility',vol,'buffer',buffer,'stopSwing',anchor,'targetSwings',swings,'firstRewardRisk',rr)));
end; $$;

notify pgrst,'reload schema';
commit;
