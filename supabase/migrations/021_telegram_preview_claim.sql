-- Claim an explicitly requested, isolated Telegram layout test once.
-- Audit only: never creates a signal, allocation, delivery or trading instruction.
begin;
create function public.wg_telegram_preview_claim(p_run uuid) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare actor uuid;
begin
  if p_run is null then raise exception 'WG: معرّف اختبار مطلوب.';end if;
  perform pg_advisory_xact_lock(910726438);
  if exists(select 1 from wg_audit where action='telegram.preview.run' and subject=p_run::text) then
    return jsonb_build_object('claimed',false);
  end if;
  select id into actor from wg_profiles where role='admin' and active and not must_change_password;
  if actor is null then raise exception 'WG: حساب المدير غير متاح.';end if;
  insert into wg_audit(actor_id,action,subject) values(actor,'telegram.preview.run',p_run::text);
  return jsonb_build_object('claimed',true,'actorId',actor);
end; $$;
revoke all on function public.wg_telegram_preview_claim(uuid) from public,anon,authenticated;
grant execute on function public.wg_telegram_preview_claim(uuid) to service_role;
notify pgrst,'reload schema';
commit;
