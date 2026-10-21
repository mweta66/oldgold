-- Apply after 001–003 with publishers and delivery workers paused.
-- No existing event snapshots, deliveries, quotas or timestamps are rewritten.
begin;
alter table public.wg_signals add column targets numeric[];
alter table public.wg_signals add column targets_hit integer not null default 0;
update public.wg_signals set targets=array[target],targets_hit=case when status='target' then 1 else 0 end;
alter table public.wg_signals alter column targets set not null;

create function public.wg_targets_valid(direction text,entry numeric,final_target numeric,levels numeric[]) returns boolean
language plpgsql immutable set search_path=public as $$
declare previous numeric:=entry; price numeric;
begin
  if levels is null or array_ndims(levels)<>1 or array_lower(levels,1)<>1 or cardinality(levels) not between 1 and 3 or final_target is distinct from levels[cardinality(levels)] then return false; end if;
  foreach price in array levels loop
    if price is null or price='NaN'::numeric or price<=0 or price>=1000000 or
      (direction='buy' and price<=previous) or (direction='sell' and price>=previous) then return false; end if;
    previous:=price;
  end loop;
  return direction in ('buy','sell');
end; $$;

create function public.wg_prepare_targets() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  -- Legacy one-target inserts/status updates remain compatible.
  if new.targets is null then new.targets:=array[new.target]; end if;
  if new.status='target' and cardinality(new.targets)=1 then new.targets_hit:=1; end if;
  if tg_op='UPDATE' then
    if new.targets is distinct from old.targets then raise exception 'WG: لا تُعدّل مستويات الأهداف بعد النشر.'; end if;
    if new.targets_hit<old.targets_hit or new.targets_hit>old.targets_hit+1 then raise exception 'WG: سجّل الأهداف بالترتيب دون تراجع أو تخطّي.'; end if;
    if new.targets_hit>old.targets_hit and (old.status<>'open' or new.status<>(case when new.targets_hit=cardinality(new.targets) then 'target' else 'open' end)) then raise exception 'WG: تقدّم الهدف يحتاج إشارة مفتوحة وحالة مطابقة.'; end if;
  end if;
  return new;
end; $$;
create trigger wg_prepare_targets before insert or update on public.wg_signals for each row execute function public.wg_prepare_targets();
alter table public.wg_signals add constraint wg_targets_order check(public.wg_targets_valid(direction,entry,target,targets));
alter table public.wg_signals add constraint wg_targets_progress check(
  targets_hit between 0 and cardinality(targets) and
  ((status='target' and targets_hit=cardinality(targets)) or (status<>'target' and targets_hit<cardinality(targets))) and
  (status not in ('pending','expired') or targets_hit=0)
);

alter table public.wg_signal_events drop constraint wg_signal_events_kind_check;
alter table public.wg_signal_events add constraint wg_signal_events_kind_check check(kind in ('publish','status','tp1','tp2','tp3'));
create or replace function public.wg_record_signal_event() returns trigger
language plpgsql security definer set search_path=public as $$
declare e bigint; k text; stamp timestamptz;
begin
  if tg_op='UPDATE' and new.status is not distinct from old.status and new.targets_hit is not distinct from old.targets_hit then return new; end if;
  k:=case when tg_op='INSERT' then 'publish' when new.targets_hit>old.targets_hit and cardinality(new.targets)>1 then 'tp'||new.targets_hit else 'status' end;
  stamp:=case when tg_op='INSERT' then new.created_at else now() end;
  insert into wg_signal_events(signal_id,kind,status,snapshot,created_at,delivery_until)
    values(new.id,k,new.status,to_jsonb(new),stamp,case when k='publish' then new.expires_at else stamp+interval '24 hours' end) returning id into e;
  if tg_op='UPDATE' then
    insert into wg_outbox(signal_id,event_id,user_id,destination)
      select new.id,e,p.id,p.telegram_chat_id from wg_allocations a join wg_profiles p on p.id=a.user_id
      where a.signal_id=new.id and p.active and not p.must_change_password and p.expires_at>now() and p.telegram_chat_id is not null;
    if new.telegram_group_chat_id is not null then
      insert into wg_outbox(signal_id,event_id,destination) values(new.id,e,new.telegram_group_chat_id) on conflict do nothing;
    end if;
  end if;
  return new;
end; $$;
drop trigger wg_signal_events on public.wg_signals;
create trigger wg_signal_events after insert or update of status,targets_hit on public.wg_signals for each row execute function public.wg_record_signal_event();

create or replace function public.wg_publish(p_actor uuid,p_data jsonb,p_admin_chat text default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s wg_signals; u wg_profiles; total integer:=0; e numeric; sl numeric; tp numeric; ref numeric; qt timestamptz; goals numeric[];
begin
  perform wg_assert_admin(p_actor);
  perform pg_advisory_xact_lock(910726431);
  select * into s from wg_signals where request_id=p_data->>'requestId';
  if found then return jsonb_build_object('id',s.id,'duplicate',true); end if;
  if (select paused from wg_settings where id=1) then raise exception 'WG: نشر الإشارات متوقف.'; end if;
  e:=(p_data->>'entry')::numeric; sl:=(p_data->>'stop')::numeric; tp:=(p_data->>'target')::numeric; ref:=(p_data->>'referencePrice')::numeric; qt:=(p_data->>'quoteAt')::timestamptz;
  if (p_data->>'requestId') is null or (p_data->>'requestId') !~ '^[A-Za-z0-9-]{16,80}$' or e is null or sl is null or tp is null or ref is null or qt is null or
     least(e,sl,tp,ref)<=0 or greatest(e,sl,tp,ref)>=1000000 or ref='NaN'::numeric or e='NaN'::numeric or sl='NaN'::numeric or tp='NaN'::numeric or
     qt<now()-interval '5 minutes' or qt>now()+interval '5 seconds' or abs(e-ref)/ref>0.02 then
    raise exception 'WG: الأسعار أو وقت السعر المرجعي غير صالح.';
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

create or replace function public.wg_signal_status(p_actor uuid,p_id bigint,p_status text,p_group_chat text default null) returns void
language plpgsql security definer set search_path=public as $$
declare s wg_signals; current_status text;
begin
  perform wg_assert_admin(p_actor);
  select * into s from wg_signals where id=p_id for update;
  if not found then raise exception 'WG: الإشارة غير موجودة.'; end if;
  current_status:=s.status;
  if current_status='pending' and s.expires_at<=now() then current_status:='expired'; end if;
  if not((current_status='pending' and p_status in ('open','expired','cancelled')) or (current_status='open' and p_status in ('target','stopped','cancelled'))) then raise exception 'WG: تغيير حالة الإشارة غير مسموح.'; end if;
  if p_status='target' and cardinality(s.targets)>1 then raise exception 'WG: سجّل الأهداف المتعددة بالترتيب من أزرار TP.'; end if;
  update wg_signals set status=p_status,targets_hit=case when p_status='target' then 1 else targets_hit end,telegram_group_chat_id=coalesce(p_group_chat,telegram_group_chat_id) where id=p_id;
  insert into wg_audit(actor_id,action,subject) values(p_actor,'signal.'||p_status,p_id::text);
end; $$;

create function public.wg_target_hit(p_actor uuid,p_id bigint,p_index integer,p_group_chat text default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s wg_signals;
begin
  perform wg_assert_admin(p_actor);
  select * into s from wg_signals where id=p_id for update;
  if not found then raise exception 'WG: الإشارة غير موجودة.'; end if;
  if p_index is null or p_index<1 or p_index>cardinality(s.targets) then raise exception 'WG: رقم الهدف غير صحيح.'; end if;
  if p_index<=s.targets_hit then return jsonb_build_object('ok',true,'duplicate',true); end if;
  if s.status<>'open' or p_index<>s.targets_hit+1 then raise exception 'WG: افتح الإشارة وسجّل الأهداف بالترتيب دون تخطّي.'; end if;
  update wg_signals set targets_hit=p_index,status=case when p_index=cardinality(targets) then 'target' else 'open' end,telegram_group_chat_id=coalesce(p_group_chat,telegram_group_chat_id) where id=p_id;
  insert into wg_audit(actor_id,action,subject) values(p_actor,'signal.tp'||p_index,p_id::text);
  return jsonb_build_object('ok',true,'duplicate',false);
end; $$;

revoke all on function public.wg_targets_valid(text,numeric,numeric,numeric[]),public.wg_prepare_targets(),public.wg_target_hit(uuid,bigint,integer,text) from public,anon,authenticated;
grant execute on function public.wg_targets_valid(text,numeric,numeric,numeric[]),public.wg_prepare_targets(),public.wg_target_hit(uuid,bigint,integer,text) to service_role;
notify pgrst, 'reload schema';
commit;
