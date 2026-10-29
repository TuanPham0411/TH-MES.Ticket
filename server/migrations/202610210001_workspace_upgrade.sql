-- Additive upgrade. Existing tickets, accounts, attachments and timeline rows stay intact.
create table ticket_private.access_log (
 id bigint generated always as identity primary key,
 created_at timestamptz not null default now(), uid text, username text,
 event text not null, page text, ticket_id text, ip text, agent text, success boolean not null default true
);
create index on ticket_private.access_log(created_at desc,id desc);
create table public.ticket_translations (
 issue_id text not null, source_hash text not null, data jsonb not null, created_at timestamptz not null default now(), primary key(issue_id,source_hash)
);
grant select,insert,update,delete on public.ticket_translations to th_api;
alter function public.ticket_dispatch(text,jsonb,jsonb) rename to dispatch_before_20261021;
alter function public.dispatch_before_20261021(text,jsonb,jsonb) set schema ticket_private;
create function public.ticket_dispatch(action text,payload jsonb,actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=ticket_private,extensions,pg_temp as $$
declare current_user_data jsonb; result jsonb; issue jsonb; ident text; text_value text; uid_value text; uname text; event_value text; tick bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if action in ('addComment','logAccess','getAccessLog','readTicket') then
  current_user_data:=ticket_private.dispatch_before_20261021('getSession','{}',actor);
  uid_value:=current_user_data->'user'->>'uid';
  uname:=current_user_data->'user'->>'username';
  if action='getAccessLog' then
   if not coalesce((current_user_data->>'isOwner')::boolean,false) then raise exception 'Administrator required';end if;
   select coalesce(jsonb_agg(to_jsonb(r)),'[]') into result from (
    select * from access_log where id<coalesce(nullif(payload->>'before','')::bigint,9223372036854775807)
     and (nullif(payload->>'username','') is null or username=left(payload->>'username',64))
     order by id desc limit 100
   ) r;
   return jsonb_build_object('rows',result);
  end if;
  if action='logAccess' then
   if payload->>'page' is null or payload->>'page' not in ('dashboard','my-dashboard','issues','my-issues','create','profile','detail','settings') then raise exception 'Invalid page';end if;
   if payload->>'page'='settings' and not coalesce((current_user_data->>'isOwner')::boolean,false) then raise exception 'Administrator required';end if;
   if (select count(*) from access_log where uid=uid_value and event='page' and created_at>now()-interval '1 minute')>=60 then return '{"ok":true}';end if;
   insert into access_log(uid,username,event,page,ticket_id,ip,agent) values(uid_value,uname,'page',payload->>'page',left(payload->>'ticketId',128),left(actor->>'ip',80),left(actor->>'agent',240));
   return '{"ok":true}';
  end if;
  ident:=coalesce(payload->>'issueId',payload->>'id');
  select data into issue from records where collection='issues' and id=ident for update;
  if issue is null or coalesce((issue->>'deleting')::boolean,false) then raise exception 'Issue unavailable';end if;
  if action='readTicket' then return issue||jsonb_build_object('id',ident);end if;
  text_value:=trim(payload->>'text');
  if jsonb_typeof(payload->'text') is distinct from 'string' or char_length(text_value) not between 1 and 3000 then raise exception 'Invalid comment';end if;
  perform pg_advisory_xact_lock(hashtextextended('comment:'||uid_value,0));
  if (select count(*) from records where collection like 'issues/%/timeline' and data->>'kind'='comment' and data->>'authorUid'=uid_value and (data->>'createdAt')::bigint>tick-60000)>=10 then raise exception 'Maximum 10 comments per minute';end if;
  insert into records(collection,id,data) values('issues/'||ident||'/timeline',gen_random_uuid()::text,jsonb_build_object('kind','comment','text',text_value,'authorUid',uid_value,'author',current_user_data->'user'->>'displayName','createdAt',tick));
  update records set data=data||jsonb_build_object('updatedAt',tick) where collection='issues' and id=ident;
  return '{"ok":true}';
 end if;
 if action='logout' then
  current_user_data:=ticket_private.dispatch_before_20261021('getSession','{}',actor);
 end if;
 result:=ticket_private.dispatch_before_20261021(action,payload,actor);
 if action in ('passwordLogin','activateAccount','logout') then
  if result ? 'sessionToken' then current_user_data:=ticket_private.dispatch_before_20261021('getSession','{}',jsonb_build_object('session',result->>'sessionToken'));end if;
  insert into access_log(uid,username,event,ip,agent,success) values(current_user_data->'user'->>'uid',coalesce(current_user_data->'user'->>'username',left(payload->>'username',64)),action,left(actor->>'ip',80),left(actor->>'agent',240),not (result ? 'errorCode'));
 end if;
 return result;
end $$;
