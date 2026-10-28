-- Additive content tabs; existing tickets, files, accounts and history are untouched.
alter table public.mes_media drop constraint mes_media_purpose_check;
alter table public.mes_media add constraint mes_media_purpose_check check(purpose in ('playlist','notice','page'));
create table public.mes_pages(id text primary key,title text not null,visibility text not null default 'members' check(visibility in ('admin','members','public')),active boolean not null default false,deleted boolean not null default false,position integer not null default 0,revision integer not null default 1,widgets jsonb not null default '[]'::jsonb,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table public.mes_page_history(id bigint generated always as identity primary key,page_id text not null,actor_uid text,revision integer not null,snapshot jsonb not null,created_at timestamptz not null default now());
grant select,insert,update,delete on public.mes_pages,public.mes_page_history to th_api;
grant usage,select on sequence public.mes_page_history_id_seq to th_api;
