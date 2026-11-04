-- Read-only owner execution feed. Does not place, modify or close broker trades.
begin;
create function public.wg_mt5_execution_feed(p_after bigint) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare stamp timestamptz:=clock_timestamp(); latest bigint; s wg_signals;
begin
  if p_after is null or p_after< -1 or p_after>9007199254740991 then raise exception 'WG: رقم متابعة غير صالح.';end if;
  select coalesce(max(id),0) into latest from wg_signals;
  -- First connection ignores all prior signals. A pause consumes the backlog.
  if p_after= -1 or (select paused or telegram_paused from wg_settings where id=1) then
    return jsonb_build_object('serverTime',floor(extract(epoch from stamp)*1000),'cursor',latest,'signal',null);
  end if;
  -- Leave cursor unchanged while a new publication is still awaiting Telegram;
  -- do not lose it by advancing to the latest database ID before delivery.
  select x.* into s from wg_signals x
    where x.id>p_after and x.status in ('pending','open') and x.targets_hit=0
      and not x.telegram_suppressed and x.created_at>=stamp-interval '60 seconds'
      and x.created_at<=stamp and x.expires_at>stamp and x.telegram_group_chat_id is not null
      and exists(select 1 from wg_outbox o join wg_signal_events e on e.id=o.event_id
        where o.signal_id=x.id and e.signal_id=x.id and e.kind='publish'
          and o.destination=x.telegram_group_chat_id and o.user_id is null and o.state='sent'
          and o.telegram_message_id is not null)
    order by x.id limit 1;
  return jsonb_build_object('serverTime',floor(extract(epoch from stamp)*1000),
    'cursor',case when s.id is null then p_after else s.id end,
    'signal',case when s.id is null then null else jsonb_build_object(
      'id',s.id,'createdAt',floor(extract(epoch from s.created_at)*1000),
      'expiresAt',floor(extract(epoch from s.expires_at)*1000),
      'direction',s.direction,'entry',s.entry,'stop',s.stop,'targets',to_jsonb(s.targets)) end);
end; $$;
revoke all on function public.wg_mt5_execution_feed(bigint) from public,anon,authenticated;
grant execute on function public.wg_mt5_execution_feed(bigint) to service_role;
notify pgrst,'reload schema';
commit;
