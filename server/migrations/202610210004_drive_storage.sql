create table public.mes_cloud_files(path text primary key,drive_id text not null,type text not null,size bigint not null,checksum text not null,created_at timestamptz not null default now());
create table public.mes_storage_settings(id text primary key check(id='main'),provider text not null default 'local' check(provider in ('local','drive')));
insert into public.mes_storage_settings(id) values('main');
grant select,insert,update,delete on public.mes_cloud_files,public.mes_storage_settings to th_api;
