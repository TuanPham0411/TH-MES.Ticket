create schema portfolio;
create table portfolio.users (
 id text primary key default extensions.gen_random_uuid()::text,
 email text not null unique, password text not null, name text not null default '',
 verified boolean not null default false, admin boolean not null default false
);
create table portfolio.sessions (hash text primary key, uid text references portfolio.users(id) on delete cascade, expires timestamptz not null default now()+interval '12 hours');
create table portfolio.tokens (hash text primary key, uid text references portfolio.users(id) on delete cascade, purpose text not null, expires timestamptz not null default now()+interval '1 hour');
create table portfolio.records (path text primary key, uid text references portfolio.users(id) on delete cascade, data jsonb not null);
-- Called only by the local backend after Google validates the configured owner.
create function public.ticket_google_owner_session() returns jsonb language plpgsql security definer set search_path=ticket_private,extensions,pg_temp as $$
begin
 update credentials set password_hash=coalesce(password_hash,crypt(encode(gen_random_bytes(32),'hex'),gen_salt('bf',10))) , activation_hash=null,activation_expires=null where uid='ticket-owner';
 update records set data=data||'{"accountState":"ready"}' where collection='users' and id='ticket-owner';
 return ticket_private.open_account_session('ticket-owner');
end $$;
revoke all on function public.ticket_google_owner_session() from public;
