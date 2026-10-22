-- Manual reference fields may be absent; never substitute entry or publish time.
-- Existing prices, timestamps, snapshots, allocations and deliveries stay intact.
begin;
alter table public.wg_signals alter column reference_price drop not null;
alter table public.wg_signals alter column quote_at drop not null;
alter table public.wg_signals add constraint wg_automatic_reference_required
  check(symbol<>'GOLDAPI:XAUUSD' or (reference_price is not null and quote_at is not null));

create or replace function public.wg_publish(p_actor uuid,p_data jsonb,p_admin_chat text default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s wg_signals; u wg_profiles; total integer:=0; e numeric; sl numeric; tp numeric; ref numeric; qt timestamptz; goals numeric[];
begin
  perform wg_assert_admin(p_actor);
  perform pg_advisory_xact_lock(910726431);
  select * into s from wg_signals where request_id=p_data->>'requestId';
  if found then return jsonb_build_object('id',s.id,'duplicate',true); end if;
  if (select paused from wg_settings where id=1) then raise exception 'WG: نشر الإشارات متوقف.'; end if;
  e:=(p_data->>'entry')::numeric; sl:=(p_data->>'stop')::numeric; tp:=(p_data->>'target')::numeric;
  ref:=nullif(btrim(p_data->>'referencePrice'),'')::numeric;
  qt:=nullif(btrim(p_data->>'quoteAt'),'')::timestamptz;
  if (p_data->>'requestId') is null or (p_data->>'requestId') !~ '^[A-Za-z0-9-]{16,80}$' or
     e is null or sl is null or tp is null or least(e,sl,tp)<=0 or greatest(e,sl,tp)>=1000000 or
     e='NaN'::numeric or sl='NaN'::numeric or tp='NaN'::numeric then
    raise exception 'WG: أدخل أسعار دخول ووقف وأهداف صحيحة.';
  end if;
  if ref is not null and (ref<=0 or ref>=1000000 or ref='NaN'::numeric) then
    raise exception 'WG: السعر المرجعي الاختياري غير صالح؛ صححه أو اتركه فارغًا.';
  end if;
  if qt is not null and (qt<now()-interval '5 minutes' or qt>now()+interval '5 seconds') then
    raise exception 'WG: وقت السعر الاختياري يجب أن يكون خلال آخر خمس دقائق؛ صححه أو اتركه فارغًا.';
  end if;
  if ref is not null and abs(e-ref)/ref>0.02 then
    raise exception 'WG: الدخول بعيد عن السعر المرجعي المضاف بأكثر من 2%%؛ راجع السعر أو اترك المرجع فارغًا.';
  end if;
  if p_data ? 'targets' then
    if jsonb_typeof(p_data->'targets')<>'array' then raise exception 'WG: قائمة الأهداف غير صالحة.'; end if;
    if jsonb_array_length(p_data->'targets') not between 1 and 3 then raise exception 'WG: حدّد من هدف إلى ثلاثة أهداف.'; end if;
    if exists(select 1 from jsonb_array_elements(p_data->'targets') x where jsonb_typeof(x)<>'number') then raise exception 'WG: الأهداف يجب أن تكون أسعارًا رقمية.'; end if;
    select array_agg(value::numeric order by ordinal) into goals from jsonb_array_elements_text(p_data->'targets') with ordinality as x(value,ordinal);
  else goals:=array[tp]; end if;
  if not wg_targets_valid(p_data->>'direction',e,tp,goals) then raise exception 'WG: حدّد أهدافًا مرتبة في اتجاه الصفقة والهدف النهائي مطابق لآخر هدف.'; end if;
  update wg_signals set status='expired' where status='pending' and expires_at<=now();
  if (select count(*) from wg_signals where status in ('pending','open'))>=2 then raise exception 'WG: يوجد إشارتان نشطتان بالفعل.'; end if;
  insert into wg_signals(request_id,direction,entry,stop,target,reference_price,quote_at,author_id,telegram_group_chat_id,targets)
    values(p_data->>'requestId',p_data->>'direction',e,sl,tp,ref,qt,p_actor,p_admin_chat,goals) returning * into s;
  for u in select * from wg_profiles where role='member' and active and not must_change_password and expires_at>now() and used<quota order by id for update loop
    insert into wg_allocations(user_id,signal_id) values(u.id,s.id);
    update wg_profiles set used=used+1 where id=u.id;
    if u.telegram_chat_id is not null then insert into wg_outbox(signal_id,event_id,user_id,destination) values(s.id,(select id from wg_signal_events where signal_id=s.id and kind='publish'),u.id,u.telegram_chat_id); end if;
    total:=total+1;
  end loop;
  if nullif(p_admin_chat,'') is not null then insert into wg_outbox(signal_id,event_id,destination) values(s.id,(select id from wg_signal_events where signal_id=s.id and kind='publish'),p_admin_chat) on conflict do nothing; end if;
  insert into wg_audit(actor_id,action,subject) values(p_actor,'signal.publish',s.id::text);
  return jsonb_build_object('id',s.id,'recipients',total);
end; $$;
revoke all on function public.wg_publish(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.wg_publish(uuid,jsonb,text) to service_role;
notify pgrst, 'reload schema';
commit;
