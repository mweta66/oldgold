-- Freeze the cutover per trade, not per restart, clock or message id.
-- History, events, allocations, message roots and all sent deliveries survive.
begin;
lock table public.wg_signals,public.wg_outbox in share row exclusive mode;
alter table public.wg_signals add column telegram_suppressed boolean not null default false;
update public.wg_signals set telegram_suppressed=true;
update public.wg_outbox set state='cancelled',lease_id=null
  where state in ('pending','processing','failed');

-- Also protect against older workers and future events of a legacy trade.
-- Recording a TP/SL is still allowed; only its Telegram delivery is silenced.
create function public.wg_telegram_new_signals_only() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from wg_signals where id=new.signal_id and not telegram_suppressed) then
    new.state:='cancelled'; new.lease_id:=null;
  end if;
  return new;
end; $$;
create trigger wg_telegram_new_signals_only before insert or update of state on public.wg_outbox
  for each row execute function public.wg_telegram_new_signals_only();
revoke all on function public.wg_telegram_new_signals_only() from public,anon,authenticated;
grant execute on function public.wg_telegram_new_signals_only() to service_role;
notify pgrst, 'reload schema';
commit;
