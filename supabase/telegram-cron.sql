-- Run manually AFTER enabling pg_cron + pg_net and storing both values in Vault.
-- No production URLs or secret values belong in this repository.
do $$
begin
  if not exists(select 1 from vault.decrypted_secrets where name='wetagold_site_origin') or
     not exists(select 1 from vault.decrypted_secrets where name='wetagold_cron_secret') then
    raise exception 'Store both WetaGold scheduler secrets in Vault first.';
  end if;
  if exists(select 1 from cron.job where jobname='wetagold-telegram') then
    raise exception 'WetaGold job already exists; review it in Cron before changing it.';
  end if;
end; $$;

select cron.schedule('wetagold-telegram', '* * * * *', $job$
  select net.http_get(
    url := rtrim((select decrypted_secret from vault.decrypted_secrets where name='wetagold_site_origin'), '/') || '/api/jobs/telegram',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='wetagold_cron_secret')),
    timeout_milliseconds := 15000
  );
$job$);
