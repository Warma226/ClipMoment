-- ============================================================
-- ClipMoment v2 : logo enregistré dans le compte + import par lien (YouTube, Facebook…)
-- Déjà appliqué sur le projet Supabase « clipmoment ». À coller dans le SQL Editor
-- seulement pour un nouveau projet, APRÈS schema.sql.
-- ============================================================

-- ---------- Logo et réglages de marque du client ----------
alter table public.profiles add column if not exists brand jsonb;
grant update (brand) on public.profiles to authenticated;
drop policy if exists "profil: marque" on public.profiles;
create policy "profil: marque" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
-- Garde-fou : un logo trop lourd est refusé (environ 300 Ko maximum).
alter table public.profiles drop constraint if exists brand_taille;
alter table public.profiles add constraint brand_taille check (brand is null or octet_length(brand::text) < 300000);

-- ---------- Import par lien ----------
insert into public.settings(key, value) values ('link_fee', '3'::jsonb) on conflict (key) do nothing;

create table if not exists public.link_imports (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  url         text not null,
  run_id      text,
  status      text not null default 'en_cours',   -- en_cours | pret | echec
  fee         integer not null default 0,
  video_url   text,
  title       text,
  duration    real,
  file_size   bigint,
  refunded    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists link_imports_user_idx on public.link_imports(user_id, created_at desc);
alter table public.link_imports enable row level security;
drop policy if exists "imports: lecture" on public.link_imports;
create policy "imports: lecture" on public.link_imports for select using (user_id = auth.uid());
revoke insert, update, delete on public.link_imports from anon, authenticated;

create or replace function public.start_link_import(p_user uuid, p_url text)
returns json language plpgsql security definer set search_path = public as $$
declare fee integer; bal integer; iid uuid;
begin
  select coalesce((value)::text::integer, 3) into fee from public.settings where key = 'link_fee';
  fee := greatest(coalesce(fee, 3), 0);
  if (select count(*) from public.link_imports where user_id = p_user and status = 'en_cours' and created_at > now() - interval '20 minutes') >= 2 then
    raise exception 'IMPORTS_EN_COURS';
  end if;
  update public.profiles set credits = credits - fee where id = p_user and credits >= fee returning credits into bal;
  if bal is null then raise exception 'CREDITS_INSUFFISANTS'; end if;
  insert into public.link_imports(user_id, url, fee) values (p_user, left(p_url, 500), fee) returning id into iid;
  if fee > 0 then
    insert into public.credit_events(user_id, delta, reason, note) values (p_user, -fee, 'import', left(p_url, 200));
  end if;
  return json_build_object('import_id', iid, 'fee', fee, 'credits', bal);
end $$;

create or replace function public.get_link_import(p_user uuid, p_id uuid)
returns public.link_imports language sql stable security definer set search_path = public as $$
  select * from public.link_imports where id = p_id and user_id = p_user;
$$;

create or replace function public.set_link_import_run(p_id uuid, p_run text)
returns void language sql security definer set search_path = public as $$
  update public.link_imports set run_id = p_run, updated_at = now() where id = p_id;
$$;

-- Termine un import ; en cas d'échec, les crédits sont rendus une seule fois.
create or replace function public.finish_link_import(p_id uuid, p_status text, p_video_url text, p_title text, p_duration real, p_file_size bigint)
returns json language plpgsql security definer set search_path = public as $$
declare li public.link_imports; bal integer;
begin
  select * into li from public.link_imports where id = p_id for update;
  if not found then return json_build_object('ok', false); end if;
  if p_status = 'pret' then
    update public.link_imports set status = 'pret', video_url = p_video_url, title = left(p_title, 300), duration = p_duration,
      file_size = p_file_size, updated_at = now() where id = p_id;
    return json_build_object('ok', true);
  end if;
  update public.link_imports set status = 'echec', updated_at = now() where id = p_id;
  if not li.refunded and li.fee > 0 then
    update public.link_imports set refunded = true where id = p_id;
    update public.profiles set credits = credits + li.fee where id = li.user_id returning credits into bal;
    insert into public.credit_events(user_id, delta, reason, note) values (li.user_id, li.fee, 'remboursement', 'Import par lien échoué');
  end if;
  return json_build_object('ok', true, 'refunded', case when li.refunded then 0 else li.fee end, 'credits', bal);
end $$;

revoke execute on function public.start_link_import(uuid, text) from public, anon, authenticated;
revoke execute on function public.get_link_import(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.set_link_import_run(uuid, text) from public, anon, authenticated;
revoke execute on function public.finish_link_import(uuid, text, text, text, real, bigint) from public, anon, authenticated;
grant execute on function public.start_link_import(uuid, text) to service_role;
grant execute on function public.get_link_import(uuid, uuid) to service_role;
grant execute on function public.set_link_import_run(uuid, text) to service_role;
grant execute on function public.finish_link_import(uuid, text, text, text, real, bigint) to service_role;

-- La page admin peut régler le prix d'un import par lien.
create or replace function public.admin_set_setting(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'ACCES_REFUSE'; end if;
  if p_key not in ('welcome_credits', 'max_minutes', 'packs', 'payment', 'link_fee') then raise exception 'REGLAGE_INCONNU'; end if;
  insert into public.settings(key, value) values (p_key, p_value)
    on conflict (key) do update set value = excluded.value;
end $$;
