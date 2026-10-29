-- Bounded workspace publishing and network telemetry. Runtime access stays server-only.
create table public.ticket_workspace(kind text not null,id text not null,data jsonb not null,primary key(kind,id));
create table public.ticket_media(id text primary key,title text not null,type text not null,size bigint not null default 0,ready boolean not null default false,created_at timestamptz not null default now());
create table public.ticket_probes(id bigint generated always as identity primary key,target_id text not null,checked_at timestamptz not null default now(),ok boolean not null,latency_ms double precision,mbps double precision,bytes int not null default 0,status int,error text);
create index on public.ticket_probes(target_id,checked_at desc);
insert into public.ticket_workspace values('issueTypes','general','{"name":"General","active":true}');
grant select,insert,update,delete on public.ticket_workspace,public.ticket_media,public.ticket_probes to th_api;
grant usage,select on sequence public.ticket_probes_id_seq to th_api;
DO $upgrade$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('public.ticket_dispatch(text,jsonb,jsonb)'::regprocedure);
 definition:=replace(definition,$old$  elsif action='createIssue' then$old$,$new$  elsif action='createIssue' then
    select w.data into d from public.ticket_workspace w where w.kind='issueTypes' and w.id=coalesce(payload->>'issueTypeId','general') and w.data->>'active'='true';
    if d is null then raise exception 'Select an active issue type'; end if;
    payload:=payload||jsonb_build_object('issueTypeId',coalesce(payload->>'issueTypeId','general'),'issueTypeName',d->>'name');
$new$);
 definition:=replace(definition,$old$'departmentName',old->>'name','status','New'$old$,$new$'departmentName',old->>'name','issueTypeId',payload->>'issueTypeId','issueTypeName',payload->>'issueTypeName','progress',0,'status','New'$new$);
 definition:=replace(definition,$old$      elsif op='handling' then$old$,$new$      elsif op='handling' then
        if payload ? 'progress' and (jsonb_typeof(payload->'progress') is distinct from 'number' or (payload->>'progress')::numeric not between 0 and 100 or trunc((payload->>'progress')::numeric)<>(payload->>'progress')::numeric) then raise exception 'Progress must be an integer from 0 to 100'; end if;
        changes:=changes||jsonb_build_object('progress',case when payload->>'status' in ('Resolved','Closed') then 100 else coalesce((payload->>'progress')::int,case payload->>'status' when 'New' then 0 when 'Acknowledged' then 15 when 'In progress' then 50 when 'Awaiting information' then 35 else 0 end) end);
$new$);
 definition:=replace(definition,$old$'. Priority: '||(old->>'priority')$old$,$new$'. Progress: '||coalesce(old->>'progress','0')||'% → '||(changes->>'progress')||'%. Priority: '||(old->>'priority')$new$);
 definition:=replace(definition,'(d->>''size'')::bigint not between 1 and 10485760','(d->>''size'')::bigint not between 1 and (case when d->>''type'' like ''video/%'' then 26214400 else 10485760 end)');
 definition:=replace(definition,$old$'image/webp','application/pdf'$old$,$new$'image/webp','video/mp4','video/webm','video/quicktime','application/pdf'$new$);
 EXECUTE definition;
END $upgrade$;
