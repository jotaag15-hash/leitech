begin;

create table if not exists public.tenants (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null unique references auth.users(id) on delete cascade,
    dairy_name text not null,
    contact_name text not null,
    contact_email text not null,
    phone text not null,
    created_at timestamptz not null default now()
);

create table if not exists public.authorized_users (
    email text primary key check (email = lower(email)),
    is_admin boolean not null default false,
    created_at timestamptz not null default now()
);

alter table public.authorized_users
add column if not exists is_admin boolean not null default false;

create or replace function public.is_authorized_user()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1
        from public.authorized_users
        where email = lower(coalesce(auth.jwt() ->> 'email', ''))
    );
$$;

create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1
        from public.authorized_users
        where email = lower(coalesce(auth.jwt() ->> 'email', ''))
          and is_admin
    );
$$;

create table if not exists public.producers (
    id text primary key,
    name text not null,
    property text not null default '',
    phone text not null default '',
    created_at timestamptz not null default now()
);

create table if not exists public.deliveries (
    id text primary key,
    producer_id text,
    date date not null,
    liters numeric(12, 2) not null check (liters > 0),
    price numeric(12, 2) not null check (price >= 0),
    created_at timestamptz not null default now()
);

create index if not exists deliveries_date_idx on public.deliveries (date desc);
create index if not exists deliveries_producer_id_idx on public.deliveries (producer_id);

create table if not exists public.app_settings (
    id integer primary key check (id = 1),
    default_price text not null default '',
    dairy_name text not null default '',
    company_name text not null default 'LeiTech - Gestão de Leite',
    updated_at timestamptz not null default now()
);

insert into public.app_settings (id)
values (1)
on conflict (id) do nothing;

alter table public.producers
add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;

alter table public.deliveries
add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;

alter table public.app_settings
drop constraint if exists app_settings_id_check;

create sequence if not exists public.app_settings_id_seq;

select setval(
    'public.app_settings_id_seq',
    coalesce((select max(id) from public.app_settings), 0) + 1,
    false
);

alter table public.app_settings
alter column id set default nextval('public.app_settings_id_seq');

alter table public.app_settings
add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;

create unique index if not exists app_settings_tenant_id_key
on public.app_settings (tenant_id);

create or replace function public.provision_tenant_for_user(
    p_user_id uuid,
    p_email text,
    p_contact_name text,
    p_dairy_name text,
    p_phone text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    new_tenant_id uuid;
    tenant_count bigint;
begin
    if p_user_id is null
       or nullif(trim(coalesce(p_email, '')), '') is null
       or nullif(trim(coalesce(p_contact_name, '')), '') is null
       or nullif(trim(coalesce(p_dairy_name, '')), '') is null
       or nullif(trim(coalesce(p_phone, '')), '') is null then
        raise exception 'Informe o responsável, o laticínio, o e-mail e o telefone.';
    end if;

    perform pg_advisory_xact_lock(741852963);

    insert into public.tenants (owner_id, dairy_name, contact_name, contact_email, phone)
    values (p_user_id, trim(p_dairy_name), trim(p_contact_name), lower(trim(p_email)), trim(p_phone))
    returning id into new_tenant_id;

    select count(*) into tenant_count from public.tenants;
    if tenant_count = 1 then
        update public.producers
        set tenant_id = new_tenant_id
        where tenant_id is null;

        update public.deliveries
        set tenant_id = new_tenant_id
        where tenant_id is null;

        update public.app_settings
        set tenant_id = new_tenant_id,
            dairy_name = trim(p_dairy_name),
            company_name = trim(p_dairy_name)
        where tenant_id is null;
    end if;

    insert into public.app_settings (tenant_id, dairy_name, company_name)
    values (new_tenant_id, trim(p_dairy_name), trim(p_dairy_name))
    on conflict (tenant_id) do nothing;

    return new_tenant_id;
end;
$$;

revoke all on function public.provision_tenant_for_user(uuid, text, text, text, text) from public;

create or replace function public.handle_new_tenant_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if new.email_confirmed_at is null then
        return new;
    end if;

    perform public.provision_tenant_for_user(
        new.id,
        new.email,
        new.raw_user_meta_data ->> 'contact_name',
        new.raw_user_meta_data ->> 'dairy_name',
        new.raw_user_meta_data ->> 'phone'
    );
    return new;
end;
$$;

revoke all on function public.handle_new_tenant_user() from public;

drop trigger if exists on_auth_user_created_leitech on auth.users;
create trigger on_auth_user_created_leitech
after insert on auth.users
for each row execute procedure public.handle_new_tenant_user();

drop trigger if exists on_auth_user_confirmed_leitech on auth.users;
create trigger on_auth_user_confirmed_leitech
after update of email_confirmed_at on auth.users
for each row
when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
execute procedure public.handle_new_tenant_user();

create or replace function public.complete_tenant_setup(
    p_contact_name text,
    p_dairy_name text,
    p_phone text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    current_user_id uuid := auth.uid();
    current_email text;
begin
    if current_user_id is null then
        raise exception 'Entre na sua conta para concluir o cadastro.';
    end if;

    select email into current_email
    from auth.users
    where id = current_user_id;

    if exists (select 1 from public.tenants where owner_id = current_user_id) then
        raise exception 'Esta conta já está vinculada a um laticínio.';
    end if;

    return public.provision_tenant_for_user(
        current_user_id,
        current_email,
        p_contact_name,
        p_dairy_name,
        p_phone
    );
end;
$$;

revoke all on function public.complete_tenant_setup(text, text, text) from public;
grant execute on function public.complete_tenant_setup(text, text, text) to authenticated;

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select id
    from public.tenants
    where owner_id = auth.uid()
    limit 1;
$$;

revoke all on function public.current_tenant_id() from public;
grant execute on function public.current_tenant_id() to authenticated;

alter table public.tenants enable row level security;
alter table public.producers enable row level security;
alter table public.deliveries enable row level security;
alter table public.app_settings enable row level security;
alter table public.authorized_users enable row level security;

revoke all on public.authorized_users, public.tenants, public.producers, public.deliveries, public.app_settings from anon, public;
grant usage on schema public to authenticated;

drop policy if exists authorized_users_read_own on public.authorized_users;
drop policy if exists tenant_read_own on public.tenants;
create policy tenant_read_own
on public.tenants for select
to authenticated
using (owner_id = auth.uid());

drop policy if exists authorized_users_all on public.producers;
drop policy if exists public_access on public.producers;
drop policy if exists tenant_access on public.producers;
create policy tenant_access
on public.producers for all
to authenticated
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

drop policy if exists authorized_users_all on public.deliveries;
drop policy if exists public_access on public.deliveries;
drop policy if exists tenant_access on public.deliveries;
create policy tenant_access
on public.deliveries for all
to authenticated
using (tenant_id = public.current_tenant_id())
with check (tenant_id = public.current_tenant_id());

drop policy if exists authorized_users_all on public.app_settings;
drop policy if exists authorized_users_read_settings on public.app_settings;
drop policy if exists public_read_settings on public.app_settings;
drop policy if exists public_access on public.app_settings;
drop policy if exists tenant_read_own on public.app_settings;
create policy tenant_read_own
on public.app_settings for select
to authenticated
using (tenant_id = public.current_tenant_id());

create or replace function public.save_shared_settings(
    p_default_price text,
    p_dairy_name text,
    p_company_name text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    tenant_id_for_user uuid := public.current_tenant_id();
begin
    if tenant_id_for_user is null then
        raise exception 'A conta não está vinculada a um laticínio.';
    end if;

    insert into public.app_settings (tenant_id, default_price, dairy_name, company_name, updated_at)
    values (
        tenant_id_for_user,
        coalesce(p_default_price, ''),
        coalesce(p_dairy_name, ''),
        coalesce(p_company_name, 'LeiTech - Gestão de Leite'),
        now()
    )
    on conflict (tenant_id) do update
    set default_price = excluded.default_price,
        dairy_name = excluded.dairy_name,
        company_name = excluded.company_name,
        updated_at = excluded.updated_at;

    update public.tenants
    set dairy_name = coalesce(nullif(trim(p_dairy_name), ''), dairy_name)
    where id = tenant_id_for_user;
end;
$$;

revoke all on function public.save_shared_settings(text, text, text) from public;
grant execute on function public.save_shared_settings(text, text, text) to authenticated;

create or replace function public.clear_shared_data()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    tenant_id_for_user uuid := public.current_tenant_id();
begin
    if tenant_id_for_user is null then
        raise exception 'A conta não está vinculada a um laticínio.';
    end if;

    delete from public.deliveries where tenant_id = tenant_id_for_user;
    delete from public.producers where tenant_id = tenant_id_for_user;
end;
$$;

revoke all on function public.clear_shared_data() from public;
grant execute on function public.clear_shared_data() to authenticated;

create or replace function public.restore_shared_backup(
    producers_json jsonb,
    deliveries_json jsonb,
    settings_json jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    tenant_id_for_user uuid := public.current_tenant_id();
begin
    if tenant_id_for_user is null then
        raise exception 'A conta não está vinculada a um laticínio.';
    end if;

    delete from public.deliveries where tenant_id = tenant_id_for_user;
    delete from public.producers where tenant_id = tenant_id_for_user;

    insert into public.producers (id, tenant_id, name, property, phone)
    select p.id, tenant_id_for_user, p.name, coalesce(p.property, ''), coalesce(p.phone, '')
    from jsonb_to_recordset(coalesce(producers_json, '[]'::jsonb)) as p(
        id text,
        name text,
        property text,
        phone text
    );

    insert into public.deliveries (id, tenant_id, producer_id, date, liters, price)
    select d.id, tenant_id_for_user, d."producerId", d.date::date, d.liters, coalesce(d.price, 0)
    from jsonb_to_recordset(coalesce(deliveries_json, '[]'::jsonb)) as d(
        id text,
        "producerId" text,
        date text,
        liters numeric,
        price numeric
    );

    insert into public.app_settings (tenant_id, default_price, dairy_name, company_name, updated_at)
    values (
        tenant_id_for_user,
        coalesce(settings_json ->> 'defaultPrice', ''),
        coalesce(settings_json ->> 'dairyName', ''),
        coalesce(settings_json ->> 'companyName', 'LeiTech - Gestão de Leite'),
        now()
    )
    on conflict (tenant_id) do update
    set default_price = excluded.default_price,
        dairy_name = excluded.dairy_name,
        company_name = excluded.company_name,
        updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.restore_shared_backup(jsonb, jsonb, jsonb) from public;
grant execute on function public.restore_shared_backup(jsonb, jsonb, jsonb) to authenticated;

grant select on public.tenants to authenticated;
grant select, insert, update, delete on public.producers to authenticated;
grant select, insert, update, delete on public.deliveries to authenticated;
grant select on public.app_settings to authenticated;
revoke insert, update, delete on public.app_settings from anon, authenticated;

do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'producers'
        ) then
            alter publication supabase_realtime add table public.producers;
        end if;
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'deliveries'
        ) then
            alter publication supabase_realtime add table public.deliveries;
        end if;
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_settings'
        ) then
            alter publication supabase_realtime add table public.app_settings;
        end if;
    end if;
end;
$$;

create table if not exists public.password_recovery_challenges (
    user_id uuid primary key references auth.users(id) on delete cascade,
    phone text not null,
    code_hash text not null,
    expires_at timestamptz not null,
    attempt_count integer not null default 0 check (attempt_count >= 0),
    last_sent_at timestamptz not null,
    window_started_at timestamptz not null,
    request_count integer not null default 1 check (request_count >= 1),
    consumed_at timestamptz
);

alter table public.password_recovery_challenges enable row level security;
revoke all on public.password_recovery_challenges from public, anon, authenticated;

create or replace function public.issue_whatsapp_password_recovery(
    p_phone text,
    p_code_hash text,
    p_expires_at timestamptz,
    p_now timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    matching_users uuid[];
    issued_user_id uuid;
begin
    if p_phone is null
       or p_phone !~ '^[0-9]{10,11}$'
       or p_code_hash is null
       or nullif(p_code_hash, '') is null
       or p_now is null
       or p_expires_at is null
       or p_expires_at <= p_now then
        raise exception 'Solicitação de recuperação inválida.';
    end if;

    select array_agg(distinct owner_id)
    into matching_users
    from public.tenants
    where regexp_replace(phone, '[^0-9]', '', 'g') = p_phone;

    if coalesce(cardinality(matching_users), 0) <> 1 then
        return null;
    end if;

    insert into public.password_recovery_challenges (
        user_id, phone, code_hash, expires_at, attempt_count,
        last_sent_at, window_started_at, request_count, consumed_at
    )
    values (
        matching_users[1], p_phone, p_code_hash, p_expires_at, 0,
        p_now, p_now, 1, null
    )
    on conflict (user_id) do update
    set phone = excluded.phone,
        code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        attempt_count = 0,
        last_sent_at = excluded.last_sent_at,
        window_started_at = case
            when public.password_recovery_challenges.window_started_at <= p_now - interval '1 hour'
            then p_now
            else public.password_recovery_challenges.window_started_at
        end,
        request_count = case
            when public.password_recovery_challenges.window_started_at <= p_now - interval '1 hour'
            then 1
            else public.password_recovery_challenges.request_count + 1
        end,
        consumed_at = null
    where public.password_recovery_challenges.last_sent_at <= p_now - interval '60 seconds'
      and (
          public.password_recovery_challenges.window_started_at <= p_now - interval '1 hour'
          or public.password_recovery_challenges.request_count < 5
      )
    returning user_id into issued_user_id;

    return issued_user_id;
end;
$$;

create or replace function public.consume_whatsapp_password_recovery(
    p_phone text,
    p_code_hash text,
    p_now timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    challenge public.password_recovery_challenges%rowtype;
begin
    if p_phone is null
       or p_phone !~ '^[0-9]{10,11}$'
       or p_code_hash is null
       or p_code_hash !~ '^[a-f0-9]{64}$'
       or p_now is null then
        return null;
    end if;

    select *
    into challenge
    from public.password_recovery_challenges
    where phone = p_phone
      and consumed_at is null
    order by last_sent_at desc
    limit 1
    for update;

    if not found or challenge.expires_at <= p_now or challenge.attempt_count >= 5 then
        return null;
    end if;

    if challenge.code_hash <> p_code_hash then
        update public.password_recovery_challenges
        set attempt_count = attempt_count + 1,
            consumed_at = case when attempt_count + 1 >= 5 then p_now else null end
        where user_id = challenge.user_id;
        return null;
    end if;

    update public.password_recovery_challenges
    set consumed_at = p_now
    where user_id = challenge.user_id;

    return challenge.user_id;
end;
$$;

revoke all on function public.issue_whatsapp_password_recovery(text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.consume_whatsapp_password_recovery(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.issue_whatsapp_password_recovery(text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.consume_whatsapp_password_recovery(text, text, timestamptz) to service_role;

commit;
