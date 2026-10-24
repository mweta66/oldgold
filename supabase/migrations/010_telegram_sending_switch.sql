-- Independent of website publishing and market collection. No backfill.
begin;
alter table public.wg_settings add column telegram_paused boolean not null default false;

create or replace function public.wg_telegram_new_signals_only() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if (select telegram_paused from wg_settings where id=1) or
     not exists(select 1 from wg_signals where id=new.signal_id and not telegram_suppressed) then
    new.state:='cancelled'; new.lease_id:=null;
  end if;
  return new;
end; $$;

-- Trades first published while muted must never start sending TP/SL after
-- resuming: recipients were not offered their entry by this bot.
create function public.wg_telegram_prepare_signal() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if (select telegram_paused from wg_settings where id=1) then new.telegram_suppressed:=true; end if;
  return new;
end; $$;
create trigger wg_telegram_prepare_signal before insert on public.wg_signals
  for each row execute function public.wg_telegram_prepare_signal();

create function public.wg_telegram_sending(p_actor uuid,p_enabled boolean) returns jsonb
language plpgsql security definer set search_path=public as $$
declare paused boolean; cancelled integer;
begin
  perform wg_assert_admin(p_actor);
  if p_enabled is null then raise exception 'WG: حالة إرسال البوت غير صالحة.'; end if;
  -- Serialize with wg_publish so no publication straddles the switch.
  perform pg_advisory_xact_lock(910726431);
  select telegram_paused into paused from wg_settings where id=1 for update;
  if paused = not p_enabled then return jsonb_build_object('enabled',p_enabled,'changed',false); end if;
  update wg_settings set telegram_paused=not p_enabled where id=1;
  -- Both transitions discard unsent backlog; repeating the same desired state
  -- does not discard legitimate new messages or add duplicate audit entries.
  update wg_outbox set state='cancelled',lease_id=null where state in ('pending','processing','failed');
  get diagnostics cancelled=row_count;
  insert into wg_audit(actor_id,action,subject) values(p_actor,'telegram.sending',case when p_enabled then 'enabled' else 'paused' end);
  return jsonb_build_object('enabled',p_enabled,'changed',true,'cancelled',cancelled);
end; $$;
revoke all on function public.wg_telegram_prepare_signal(),public.wg_telegram_sending(uuid,boolean) from public,anon,authenticated;
grant execute on function public.wg_telegram_prepare_signal(),public.wg_telegram_sending(uuid,boolean) to service_role;
notify pgrst, 'reload schema';
commit;
