create table public.files(path text primary key,size bigint not null,type text not null,name text);
create table public.file_grants(hash text primary key,action text not null,path text not null,actor jsonb not null,expires timestamptz not null default now()+interval '60 seconds');
create index on public.file_grants(expires);
create index on portfolio.sessions(expires);
