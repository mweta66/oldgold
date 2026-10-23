-- No historical message ids are invented. No signal, event, quota, status or
-- existing delivery is rewritten or requeued by this upgrade.
begin;
create table public.wg_telegram_threads (
  signal_id bigint not null references public.wg_signals(id),
  destination text not null,
  message_id bigint not null check(message_id between 1 and 9007199254740991),
  root_kind text not null check(root_kind in ('publication','context')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(signal_id,destination)
);
alter table public.wg_telegram_threads enable row level security;
revoke all on public.wg_telegram_threads from public,anon,authenticated;
grant all on public.wg_telegram_threads to service_role;
alter table public.wg_outbox add column telegram_message_id bigint check(telegram_message_id between 1 and 9007199254740991);
alter table public.wg_outbox add column reply_to_message_id bigint check(reply_to_message_id between 1 and 9007199254740991);

create function public.wg_telegram_record_root(p_id bigint,p_lease uuid,p_message_id bigint,p_previous bigint default null) returns bigint
language plpgsql security definer set search_path=public as $$
declare o wg_outbox; t wg_telegram_threads; k text;
begin
  select * into o from wg_outbox where id=p_id for update;
  if not found or p_lease is null or o.lease_id is distinct from p_lease or o.state<>'processing' then raise exception 'WG: انتهت صلاحية عامل الرسالة.'; end if;
  if p_message_id is null or p_message_id not between 1 and 9007199254740991 then raise exception 'WG: رقم رسالة Telegram غير صالح.'; end if;
  select kind into k from wg_signal_events where id=o.event_id and signal_id=o.signal_id;
  if not found then raise exception 'WG: حدث الرسالة غير مطابق.'; end if;
  select * into t from wg_telegram_threads where signal_id=o.signal_id and destination=o.destination for update;
  if not found then
    insert into wg_telegram_threads(signal_id,destination,message_id,root_kind)
      values(o.signal_id,o.destination,p_message_id,case when k='publish' then 'publication' else 'context' end) returning * into t;
  elsif p_previous is not null and t.message_id=p_previous and k<>'publish' then
    update wg_telegram_threads set message_id=p_message_id,root_kind='context',updated_at=clock_timestamp()
      where signal_id=o.signal_id and destination=o.destination returning * into t;
  end if;
  return t.message_id;
end; $$;

create function public.wg_telegram_mark_sent(p_id bigint,p_lease uuid,p_message_id bigint,p_root_id bigint) returns boolean
language plpgsql security definer set search_path=public as $$
declare o wg_outbox; t wg_telegram_threads; k text;
begin
  select * into o from wg_outbox where id=p_id for update;
  if not found or p_lease is null or o.lease_id is distinct from p_lease or o.state<>'processing' then return false; end if;
  if p_message_id is null or p_message_id not between 1 and 9007199254740991 then raise exception 'WG: رقم رسالة Telegram غير صالح.'; end if;
  select * into t from wg_telegram_threads where signal_id=o.signal_id and destination=o.destination;
  if not found or t.message_id is distinct from p_root_id then raise exception 'WG: رسالة الصفقة غير مطابقة للوجهة.'; end if;
  select kind into k from wg_signal_events where id=o.event_id and signal_id=o.signal_id;
  if not found or (k='publish' and p_message_id<>p_root_id) then raise exception 'WG: تأكيد الرسالة غير مطابق.'; end if;
  update wg_outbox set state='sent',telegram_message_id=p_message_id,reply_to_message_id=case when k='publish' then null else p_root_id end where id=o.id;
  return true;
end; $$;
revoke all on function public.wg_telegram_record_root(bigint,uuid,bigint,bigint),public.wg_telegram_mark_sent(bigint,uuid,bigint,bigint) from public,anon,authenticated;
grant execute on function public.wg_telegram_record_root(bigint,uuid,bigint,bigint),public.wg_telegram_mark_sent(bigint,uuid,bigint,bigint) to service_role;
notify pgrst, 'reload schema';
commit;
