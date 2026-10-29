-- Additive content store: no changes to existing accounts or Ticket tickets.
create table portfolio.content (id text primary key check(id='main'), version integer not null default 1, data jsonb not null, updated_by text references portfolio.users(id), updated_at timestamptz not null default now());
create table portfolio.media (id uuid primary key, type text not null, size bigint not null check(size>0), name text not null, ready boolean not null default false, created_by text references portfolio.users(id), created_at timestamptz not null default now());
