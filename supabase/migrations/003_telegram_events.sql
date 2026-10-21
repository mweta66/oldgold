-- Apply after 001 and 002. Existing queue records are preserved; no past updates are sent retroactively.
begin;
alter table public.wg_signals add column if not exists telegram_group_chat_id text;
create table public.wg_signal_events (
  id bigint generated always as identity primary key,
  signal_id bigint not null references public.wg_signals(id),
  kind text not null check(kind in ('publish','status')),
  status text not null check(status in ('pending','open','target','stopped','expired','cancelled')),
  snapshot jsonb not null, created_at timestamptz not null, delivery_until timestamptz not null,
  unique(signal_id,kind,status)
);
alter table public.wg_signal_events enable row level security;
revoke all on public.wg_signal_events from public,anon,authenticated;
grant all on public.wg_signal_events to service_role;
grant usage,select on sequence public.wg_signal_events_id_seq to service_role;
alter table public.wg_outbox add column event_id bigint references public.wg_signal_events(id);
update public.wg_signals s set telegram_group_chat_id=(select o.destination from public.wg_outbox o where o.signal_id=s.id and o.user_id is null order by o.id limit 1);
insert into public.wg_signal_events(signal_id,kind,status,snapshot,created_at,delivery_until)
  select s.id,'publish','pending',to_jsonb(s)||jsonb_build_object('status','pending','opened_at',null,'closed_at',null),s.created_at,s.expires_at
  from public.wg_signals s where exists(select 1 from public.wg_outbox o where o.signal_id=s.id);
update public.wg_outbox o set event_id=e.id from public.wg_signal_events e where e.signal_id=o.signal_id and e.kind='publish';
alter table public.wg_outbox alter column event_id set not null;
alter table public.wg_outbox drop constraint wg_outbox_signal_id_destination_key;
alter table public.wg_outbox add constraint wg_outbox_event_destination_key unique(event_id,destination);
create index wg_outbox_destination_order on public.wg_outbox(destination,id) where state in ('pending','processing');

create or replace function public.wg_record_signal_event() returns trigger
language plpgsql security definer set search_path=public as $$
declare e bigint; k text; stamp timestamptz;
begin
  if tg_op='UPDATE' and new.status is not distinct from old.status then return new; end if;
  k:=case when tg_op='INSERT' then 'publish' else 'status' end;
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
create trigger wg_signal_events after insert or update of status on public.wg_signals for each row execute function public.wg_record_signal_event();

create or replace function public.wg_publish(p_actor uuid,p_data jsonb,p_admin_chat text default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s wg_signals; u wg_profiles; total integer:=0; e numeric; sl numeric; tp numeric; ref numeric; qt timestamptz;
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
  update wg_signals set status='expired' where status='pending' and expires_at<=now();
  if (select count(*) from wg_signals where status in ('pending','open'))>=2 then raise exception 'WG: يوجد إشارتان نشطتان بالفعل.'; end if;
  insert into wg_signals(request_id,direction,entry,stop,target,reference_price,quote_at,author_id,telegram_group_chat_id)
    values(p_data->>'requestId',p_data->>'direction',e,sl,tp,ref,qt,p_actor,p_admin_chat) returning * into s;
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


drop function public.wg_signal_status(uuid,bigint,text);
create or replace function public.wg_signal_status(p_actor uuid,p_id bigint,p_status text,p_group_chat text default null) returns void
language plpgsql security definer set search_path=public as $$
declare current_status text;
begin
  perform wg_assert_admin(p_actor);
  select status into current_status from wg_signals where id=p_id for update;
  if not found then raise exception 'WG: الإشارة غير موجودة.'; end if;
  if current_status='pending' and (select expires_at<=now() from wg_signals where id=p_id) then current_status:='expired'; end if;
  if not((current_status='pending' and p_status in ('open','expired','cancelled')) or (current_status='open' and p_status in ('target','stopped','cancelled'))) then raise exception 'WG: تغيير حالة الإشارة غير مسموح.'; end if;
  update wg_signals set status=p_status,telegram_group_chat_id=coalesce(p_group_chat,telegram_group_chat_id) where id=p_id;
  insert into wg_audit(actor_id,action,subject) values(p_actor,'signal.'||p_status,p_id::text);
end; $$;


create or replace function public.wg_claim_delivery(p_limit integer default 10) returns setof wg_outbox
language plpgsql security definer set search_path=public as $$
begin
  delete from wg_sessions where expires_at<=now();
  delete from wg_telegram_links where expires_at<=now();
  update wg_signals set status='expired' where status='pending' and expires_at<=now();
  update wg_outbox set state='pending' where state='processing' and next_at<=now();
  update wg_outbox o set state='cancelled' from wg_signal_events e,wg_signals s
    where e.id=o.event_id and s.id=o.signal_id and o.state='pending' and
      (e.delivery_until<=now() or (e.kind='publish' and s.status not in ('pending','open')));
  update wg_outbox o set state='cancelled' from wg_profiles p where p.id=o.user_id and o.state='pending' and (not p.active or p.must_change_password or p.expires_at<=now() or p.telegram_chat_id is distinct from o.destination);
  update wg_outbox o set state='cancelled' where o.state='pending' and exists(
    select 1 from wg_outbox newer where newer.signal_id=o.signal_id and newer.destination=o.destination and newer.event_id>o.event_id and newer.state='sent'
  );
  return query update wg_outbox set state='processing',next_at=now()+interval '2 minutes',lease_id=gen_random_uuid()
    where id in (
      select o.id from wg_outbox o where o.state='pending' and o.next_at<=now() and not exists(
        select 1 from wg_outbox earlier where earlier.destination=o.destination and earlier.id<o.id and earlier.state in ('pending','processing')
      ) order by (o.user_id is null) desc,o.id for update of o skip locked limit least(greatest(p_limit,1),20)
    ) returning *;
end; $$;

revoke all on function public.wg_record_signal_event(),public.wg_signal_status(uuid,bigint,text,text) from public,anon,authenticated;
grant execute on function public.wg_record_signal_event(),public.wg_signal_status(uuid,bigint,text,text) to service_role;
notify pgrst, 'reload schema';
commit;
