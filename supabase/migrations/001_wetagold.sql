-- Run once in the Supabase SQL editor. No credentials or owner email belong here.
begin;
create table if not exists public.wg_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique, role text not null default 'member' check(role in ('admin','member')),
  active boolean not null default true, must_change_password boolean not null default false,
  quota integer not null default 0 check(quota between 0 and 100000), used integer not null default 0 check(used>=0 and used<=quota),
  expires_at timestamptz, telegram_chat_id text unique, created_at timestamptz not null default now(),
  check(role='admin' or expires_at is not null)
);
create unique index if not exists wg_one_admin on public.wg_profiles(role) where role='admin';
create table if not exists public.wg_sessions (
  id text primary key, user_id uuid not null references public.wg_profiles(id) on delete cascade,
  csrf text not null, expires_at timestamptz not null
);
create table if not exists public.wg_settings (
  id integer primary key default 1 check(id=1), paused boolean not null default false,
  theme text not null default 'gold' check(theme in ('gold','ocean','emerald','ivory'))
);
insert into public.wg_settings(id) values(1) on conflict do nothing;
create table if not exists public.wg_signals (
  id bigint generated always as identity primary key, request_id text not null unique,
  symbol text not null default 'OANDA:XAUUSD' check(symbol='OANDA:XAUUSD'),
  direction text not null check(direction in ('buy','sell')), entry numeric not null check(entry>0),
  stop numeric not null check(stop>0), target numeric not null check(target>0), reference_price numeric not null check(reference_price>0),
  quote_at timestamptz not null, created_at timestamptz not null default now(), expires_at timestamptz not null default(now()+interval '15 minutes'),
  status text not null default 'pending' check(status in ('pending','open','target','stopped','expired','cancelled')),
  author_id uuid not null references public.wg_profiles(id),
  check((direction='buy' and stop<entry and target>entry) or (direction='sell' and stop>entry and target<entry))
);
create table if not exists public.wg_allocations (
  user_id uuid not null references public.wg_profiles(id), signal_id bigint not null references public.wg_signals(id),
  primary key(user_id,signal_id)
);
create table if not exists public.wg_telegram_links (
  hash text primary key, user_id uuid not null unique references public.wg_profiles(id) on delete cascade,
  expires_at timestamptz not null
);
create table if not exists public.wg_outbox (
  id bigint generated always as identity primary key, signal_id bigint not null references public.wg_signals(id),
  user_id uuid references public.wg_profiles(id), destination text not null,
  state text not null default 'pending' check(state in ('pending','processing','sent','failed','cancelled')),
  attempts integer not null default 0, next_at timestamptz not null default now(), lease_id uuid,
  unique(signal_id,destination)
);
create table if not exists public.wg_audit (
  id bigint generated always as identity primary key, actor_id uuid not null references public.wg_profiles(id),
  action text not null, subject text not null, created_at timestamptz not null default now()
);
create index if not exists wg_allocations_signal on public.wg_allocations(signal_id);
create index if not exists wg_outbox_pending on public.wg_outbox(state,next_at);
create index if not exists wg_session_expiry on public.wg_sessions(expires_at);

-- Browser roles cannot access private tables, even with a valid Auth JWT.
alter table public.wg_profiles enable row level security;
alter table public.wg_sessions enable row level security;
alter table public.wg_settings enable row level security;
alter table public.wg_signals enable row level security;
alter table public.wg_allocations enable row level security;
alter table public.wg_telegram_links enable row level security;
alter table public.wg_outbox enable row level security;
alter table public.wg_audit enable row level security;
revoke all on public.wg_profiles, public.wg_sessions, public.wg_settings, public.wg_signals, public.wg_allocations, public.wg_telegram_links, public.wg_outbox, public.wg_audit from public,anon,authenticated;
grant all on public.wg_profiles, public.wg_sessions, public.wg_settings, public.wg_signals, public.wg_allocations, public.wg_telegram_links, public.wg_outbox, public.wg_audit to service_role;
grant usage,select on sequence public.wg_signals_id_seq, public.wg_outbox_id_seq, public.wg_audit_id_seq to service_role;

create or replace function public.wg_assert_admin(p_actor uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from wg_profiles where id=p_actor and role='admin' and active and not must_change_password) then
    raise exception 'WG: صلاحية المدير مطلوبة.';
  end if;
end; $$;

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
  insert into wg_signals(request_id,direction,entry,stop,target,reference_price,quote_at,author_id)
    values(p_data->>'requestId',p_data->>'direction',e,sl,tp,ref,qt,p_actor) returning * into s;
  for u in select * from wg_profiles where role='member' and active and not must_change_password and expires_at>now() and used<quota order by id for update loop
    insert into wg_allocations(user_id,signal_id) values(u.id,s.id);
    update wg_profiles set used=used+1 where id=u.id;
    if u.telegram_chat_id is not null then insert into wg_outbox(signal_id,user_id,destination) values(s.id,u.id,u.telegram_chat_id); end if;
    total:=total+1;
  end loop;
  if nullif(p_admin_chat,'') is not null then insert into wg_outbox(signal_id,destination) values(s.id,p_admin_chat) on conflict do nothing; end if;
  insert into wg_audit(actor_id,action,subject) values(p_actor,'signal.publish',s.id::text);
  return jsonb_build_object('id',s.id,'recipients',total);
end; $$;

create or replace function public.wg_signal_status(p_actor uuid,p_id bigint,p_status text) returns void
language plpgsql security definer set search_path=public as $$
declare current_status text;
begin
  perform wg_assert_admin(p_actor);
  select status into current_status from wg_signals where id=p_id for update;
  if not found then raise exception 'WG: الإشارة غير موجودة.'; end if;
  if current_status='pending' and (select expires_at<=now() from wg_signals where id=p_id) then current_status:='expired'; end if;
  if not((current_status='pending' and p_status in ('open','expired','cancelled')) or (current_status='open' and p_status in ('target','stopped','cancelled'))) then raise exception 'WG: تغيير حالة الإشارة غير مسموح.'; end if;
  update wg_signals set status=p_status where id=p_id;
  insert into wg_audit(actor_id,action,subject) values(p_actor,'signal.'||p_status,p_id::text);
end; $$;

-- Join inside PostgreSQL so large lifetime quotas never become a truncated
-- PostgREST allocation list or an oversized URL with thousands of signal IDs.
create or replace function public.wg_get_signals(p_user uuid) returns setof wg_signals
language plpgsql security definer set search_path=public as $$
declare u wg_profiles;
begin
  select * into u from wg_profiles where id=p_user;
  if not found or not u.active or u.must_change_password or (u.role<>'admin' and u.expires_at<=now()) then
    raise exception 'WG: الحساب غير مفعّل.';
  end if;
  update wg_signals set status='expired' where status='pending' and expires_at<=now();
  return query select s.* from wg_signals s
    where s.created_at>=now()-interval '90 days' and
      (u.role='admin' or exists(select 1 from wg_allocations a where a.signal_id=s.id and a.user_id=p_user))
    order by s.id desc limit 200;
end; $$;

create or replace function public.wg_delivery_counts(p_actor uuid) returns table(state text,count bigint)
language plpgsql security definer set search_path=public as $$
begin
  perform wg_assert_admin(p_actor);
  return query select o.state,count(*) from wg_outbox o group by o.state;
end; $$;

create or replace function public.wg_member_update(p_actor uuid,p_id uuid,p_quota integer,p_expires timestamptz,p_active boolean) returns void
language plpgsql security definer set search_path=public as $$
declare u wg_profiles;
begin
  perform wg_assert_admin(p_actor);
  select * into u from wg_profiles where id=p_id and role='member' for update;
  if not found or p_quota is null or p_quota<u.used or p_expires is null or p_active is null then raise exception 'WG: الحساب أو الصلاحيات غير صالحة.'; end if;
  update wg_profiles set quota=p_quota,expires_at=p_expires,active=p_active where id=p_id;
  if not p_active then
    delete from wg_sessions where user_id=p_id;
    update wg_outbox set state='cancelled' where user_id=p_id and state in ('pending','processing');
  end if;
  insert into wg_audit(actor_id,action,subject) values(p_actor,'user.update',p_id::text);
end; $$;

create or replace function public.wg_settings_update(p_actor uuid,p_data jsonb) returns void
language plpgsql security definer set search_path=public as $$
begin
  perform wg_assert_admin(p_actor);
  update wg_settings set paused=coalesce((p_data->>'paused')::boolean,paused), theme=coalesce(p_data->>'theme',theme) where id=1;
  insert into wg_audit(actor_id,action,subject) values(p_actor,'settings.update',p_data::text);
end; $$;

create or replace function public.wg_link_telegram(p_hash text,p_chat text) returns boolean
language plpgsql security definer set search_path=public as $$
declare u uuid;
begin
  select l.user_id into u from wg_telegram_links l join wg_profiles p on p.id=l.user_id
    where l.hash=p_hash and l.expires_at>now() and p.active and not p.must_change_password and (p.role='admin' or p.expires_at>now()) for update of l;
  if u is null or exists(select 1 from wg_profiles where telegram_chat_id=p_chat and id<>u) then return false; end if;
  update wg_outbox set state='cancelled' where user_id=u and state in ('pending','processing');
  update wg_profiles set telegram_chat_id=p_chat where id=u;
  delete from wg_telegram_links where user_id=u;
  return true;
end; $$;

create or replace function public.wg_claim_delivery(p_limit integer default 10) returns setof wg_outbox
language plpgsql security definer set search_path=public as $$
begin
  delete from wg_sessions where expires_at<=now();
  delete from wg_telegram_links where expires_at<=now();
  update wg_outbox set state='pending' where state='processing' and next_at<=now();
  update wg_outbox o set state='cancelled' from wg_signals s where s.id=o.signal_id and o.state='pending' and (s.expires_at<=now() or s.status not in ('pending','open'));
  update wg_outbox o set state='cancelled' from wg_profiles p where p.id=o.user_id and o.state='pending' and (not p.active or p.must_change_password or p.expires_at<=now() or p.telegram_chat_id is distinct from o.destination);
  return query update wg_outbox set state='processing',next_at=now()+interval '2 minutes',lease_id=gen_random_uuid()
   where id in (select id from wg_outbox where state='pending' and next_at<=now() order by id for update skip locked limit least(greatest(p_limit,1),20)) returning *;
end; $$;

-- RPC functions are server-only. Never grant these to browser roles.
revoke all on function public.wg_assert_admin(uuid), public.wg_publish(uuid,jsonb,text), public.wg_signal_status(uuid,bigint,text), public.wg_member_update(uuid,uuid,integer,timestamptz,boolean), public.wg_settings_update(uuid,jsonb), public.wg_link_telegram(text,text), public.wg_claim_delivery(integer) from public,anon,authenticated;
grant execute on function public.wg_assert_admin(uuid), public.wg_publish(uuid,jsonb,text), public.wg_signal_status(uuid,bigint,text), public.wg_member_update(uuid,uuid,integer,timestamptz,boolean), public.wg_settings_update(uuid,jsonb), public.wg_link_telegram(text,text), public.wg_claim_delivery(integer) to service_role;
revoke all on function public.wg_get_signals(uuid), public.wg_delivery_counts(uuid) from public,anon,authenticated;
grant execute on function public.wg_get_signals(uuid), public.wg_delivery_counts(uuid) to service_role;
commit;
