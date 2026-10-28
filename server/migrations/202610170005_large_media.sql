alter table public.mes_media add column purpose text not null default 'playlist' check(purpose in ('playlist','notice'));
create table public.mes_uploads(id uuid primary key,kind text not null check(kind in ('ticket','media')),path text not null,owner_uid text not null,type text not null,size bigint not null check(size between 1 and 209715200),offset_bytes bigint not null default 0,complete boolean not null default false,expires timestamptz not null default now()+interval '2 hours',unique(kind,path));
create index on public.mes_uploads(expires);
grant select,insert,update,delete on public.mes_uploads to th_api;
-- Monitoring has been removed at the user's request.
update public.mes_workspace set data=data||'{"active":false}'::jsonb where kind='networkTargets';
DO $upgrade$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('public.mes_dispatch(text,jsonb,jsonb)'::regprocedure);
 definition:=replace(definition,'then 26214400 else 10485760','then 209715200 else 10485760');
 definition:=replace(definition,'tick-(r->>''createdAt'')::bigint>900000','tick-(r->>''createdAt'')::bigint>7200000');
 EXECUTE definition;
END $upgrade$;
