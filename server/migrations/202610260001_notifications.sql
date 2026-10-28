-- Persistent per-account inbox, templates and schedules. Ticket/history JSON stays intact.
create index if not exists mes_issue_reporter_uid_idx on mes_private.records((data->>'reporterUid')) where collection='issues';
create table mes_private.notification_templates(id text primary key default gen_random_uuid()::text,name text not null,content jsonb not null,updated_by text,updated_at timestamptz not null default now());
create table mes_private.notification_rules(id text primary key,config jsonb not null);
create table mes_private.notification_jobs(id text primary key default gen_random_uuid()::text,content jsonb not null,audience text not null,uids jsonb not null default '[]',channels jsonb not null default '["in_app"]',next_run timestamptz not null,repeat_mode text not null default 'none' check(repeat_mode in ('none','daily','weekly')),enabled boolean not null default true,created_by text not null,created_at timestamptz not null default now(),last_sent timestamptz,deliveries integer not null default 0);
create index on mes_private.notification_jobs(next_run) where enabled;
create table mes_private.notifications(id bigint generated always as identity primary key,recipient_uid text not null,event_key text not null,content jsonb not null,channels jsonb not null,created_at timestamptz not null default now(),read_at timestamptz,ticket_id text,pending_ticket boolean not null default false,unique(recipient_uid,event_key));
create index on mes_private.notifications(recipient_uid,id desc);
create index on mes_private.notifications(recipient_uid) where read_at is null;
create table mes_private.notification_media(media_id text primary key references public.mes_media(id) on delete cascade,owner_uid text not null);
alter table public.mes_media drop constraint mes_media_purpose_check;
alter table public.mes_media add constraint mes_media_purpose_check check(purpose in ('playlist','notice','page','notification'));
insert into mes_private.notification_templates(id,name,content) values
 ('00000000-0000-4000-8000-000000000001','Nhắc ticket chờ bổ sung','{"title":"Bạn có {pendingCount} ticket chờ bổ sung","description":"Ticket: {ticketNumber}. Vui lòng mở Ticket của tôi và bổ sung: {pendingReasons}.","faultName":"","faultMode":"","severity":"warning","icon":"bell","media":[]}'),
 ('00000000-0000-4000-8000-000000000002','Ticket được cập nhật','{"title":"Ticket {ticketNumber} được cập nhật","description":"{ticketTitle}\nThay đổi: {changes}. Trạng thái: {status}. Tiến độ: {progress}%.","faultName":"","faultMode":"","severity":"info","icon":"info","media":[]}'),
 ('00000000-0000-4000-8000-000000000003','Cảnh báo mức độ nghiêm trọng','{"title":"Cảnh báo: ticket {ticketNumber}","description":"{ticketTitle} — Mức độ {priority}. Trạng thái: {status}.","faultName":"{ticketTitle}","faultMode":"","severity":"critical","icon":"warning","media":[]}');
insert into mes_private.notification_rules values
 ('pending','{"enabled":true,"templateId":"00000000-0000-4000-8000-000000000001","time":"08:00","minDays":0,"audience":"reporter","uids":[],"channels":["in_app","browser"]}'),
 ('ticket_update','{"enabled":true,"templateId":"00000000-0000-4000-8000-000000000002","audience":"reporter","uids":[],"channels":["in_app","browser"],"fields":["subject","description","status","progress","priority","assessment","process","departmentId","issueTypeId","attachments","occurrences"]}'),
 ('priority_alert','{"enabled":false,"templateId":"00000000-0000-4000-8000-000000000003","audience":"reporter","uids":[],"channels":["in_app","browser"],"priorities":["Critical"]}');
create function mes_private.notification_validate_content(value jsonb) returns void language plpgsql security definer set search_path=mes_private,pg_temp as $$
declare item jsonb;
begin
 if jsonb_typeof(value) is distinct from 'object' or jsonb_typeof(value->'title') is distinct from 'string' or char_length(trim(value->>'title')) not between 1 and 160 or jsonb_typeof(value->'description') is distinct from 'string' or char_length(value->>'description')>4000 or coalesce(value->>'severity','') not in ('info','success','warning','critical') or coalesce(value->>'icon','') not in ('bell','info','warning','check','maintenance','issue') or jsonb_typeof(value->'media') is distinct from 'array' or jsonb_array_length(value->'media')>5 then raise exception 'Invalid notification content';end if;
 if coalesce(char_length(value->>'faultName'),0)>160 or coalesce(char_length(value->>'faultMode'),0)>160 then raise exception 'Fault fields are too long';end if;
 for item in select v from jsonb_array_elements(value->'media') v loop if jsonb_typeof(item) is distinct from 'string' or not exists(select 1 from public.mes_media m where m.id=item#>>'{}' and m.ready and m.purpose='notification') then raise exception 'Notification media upload is incomplete';end if;end loop;
end $$;
create function mes_private.notification_validate_audience(value text,uids jsonb,channels jsonb,rule boolean default false) returns void language plpgsql security definer set search_path=mes_private,pg_temp as $$
declare item jsonb;
begin
 if value is null or value not in ('all','selected','reporter','admins') or (not rule and value in ('reporter','admins')) or jsonb_typeof(uids) is distinct from 'array' or jsonb_array_length(uids)>200 or (value='selected' and jsonb_array_length(uids)=0) or jsonb_typeof(channels) is distinct from 'array' or not channels ? 'in_app' then raise exception 'Choose notification recipients and channels';end if;
 for item in select v from jsonb_array_elements(channels) v loop if item#>>'{}' not in ('in_app','browser') then raise exception 'Unsupported delivery channel';end if;end loop;
 for item in select v from jsonb_array_elements(uids) v loop if jsonb_typeof(item) is distinct from 'string' or not exists(select 1 from records where collection='users' and id=item#>>'{}' and coalesce((data->>'active')::boolean,false) and not coalesce((data->>'isTester')::boolean,false)) then raise exception 'Choose an active account';end if;end loop;
end $$;
create function mes_private.notification_targets(audience text,uids jsonb,reporter text default null) returns setof text language sql stable security definer set search_path=mes_private,pg_temp as $$
 select r.id from records r left join credentials c on c.uid=r.id where r.collection='users' and coalesce((r.data->>'active')::boolean,false) and not coalesce((r.data->>'isTester')::boolean,false) and (audience='all' or (audience='selected' and uids ? r.id) or (audience='reporter' and r.id=reporter) or (audience='admins' and c.role in ('owner','admin')));
$$;
create function mes_private.notification_render(content jsonb,context jsonb) returns jsonb language plpgsql immutable as $$
declare output jsonb:=content;field text;k text;v jsonb;value text;
begin
 foreach field in array array['title','description','faultName','faultMode'] loop value:=coalesce(content->>field,'');for k,v in select * from jsonb_each(context) loop value:=replace(value,'{'||k||'}',coalesce(v#>>'{}',''));end loop;output:=jsonb_set(output,array[field],to_jsonb(left(value,case when field='description' then 4000 else 240 end)));end loop;return output;
end $$;
create function mes_private.notification_emit(rule_id text,context jsonb,ticket text,waiting boolean,event text,reporter text,at_time timestamptz default now()) returns integer language plpgsql security definer set search_path=mes_private,pg_temp as $$
declare cfg jsonb;body jsonb;n integer;
begin
 select config into cfg from notification_rules where id=rule_id;if cfg->'enabled' is distinct from 'true'::jsonb then return 0;end if;
 select content into body from notification_templates where id=cfg->>'templateId';if body is null then return 0;end if;
 insert into notifications(recipient_uid,event_key,content,channels,ticket_id,pending_ticket,created_at) select uid,event,notification_render(body,context),cfg->'channels',ticket,waiting,at_time from notification_targets(cfg->>'audience',cfg->'uids',reporter) uid on conflict(recipient_uid,event_key) do nothing;get diagnostics n=row_count;return n;
end $$;
create function public.mes_notifications_tick(at_time timestamptz default clock_timestamp()) returns jsonb language plpgsql security definer set search_path=mes_private,pg_temp as $$
declare job record;person record;cfg jsonb;body jsonb;ctx jsonb;ticket_list text;reasons text;pending_count integer;total integer:=0;n integer;next_time timestamptz;
begin
 if not pg_try_advisory_xact_lock(74529087) then return '{"busy":true}';end if;
 for job in select * from notification_jobs where enabled and next_run<=at_time order by next_run limit 100 for update skip locked loop
  insert into notifications(recipient_uid,event_key,content,channels,created_at) select uid,'job:'||job.id||':'||job.next_run::text,job.content,job.channels,at_time from notification_targets(job.audience,job.uids) uid on conflict(recipient_uid,event_key) do nothing;get diagnostics n=row_count;total:=total+n;
  next_time:=job.next_run;if job.repeat_mode<>'none' then while next_time<=at_time loop next_time:=next_time+case when job.repeat_mode='daily' then interval '1 day' else interval '7 days' end;end loop;end if;
  update notification_jobs set enabled=job.repeat_mode<>'none',next_run=next_time,last_sent=at_time,deliveries=deliveries+n where id=job.id;
 end loop;
 select config into cfg from notification_rules where id='pending';
 if cfg->'enabled'='true'::jsonb and to_char(at_time at time zone 'Asia/Ho_Chi_Minh','HH24:MI')>=cfg->>'time' and (not cfg ? 'days' or cfg->'days' ? extract(dow from at_time at time zone 'Asia/Ho_Chi_Minh')::integer::text) then
  for person in select u.id,u.data from records u where u.collection='users' and coalesce((u.data->>'active')::boolean,false) and not coalesce((u.data->>'isTester')::boolean,false) and exists(select 1 from records r where r.collection='issues' and r.data->>'reporterUid'=u.id and not coalesce((r.data->>'deleting')::boolean,false) and (r.data->'pendingEvidence'='true'::jsonb or exists(select 1 from pending_ticket_legacy q where q.issue_id=r.id))) loop
   select count(*)::integer,string_agg(coalesce(c.code,left(r.id,12)),', ' order by r.seq) into pending_count,ticket_list from records r left join public.mes_ticket_codes c on c.issue_id=r.id where r.collection='issues' and r.data->>'reporterUid'=person.id and not coalesce((r.data->>'deleting')::boolean,false) and (r.data->'pendingEvidence'='true'::jsonb or exists(select 1 from pending_ticket_legacy q where q.issue_id=r.id)) and (at_time-to_timestamp((r.data->>'createdAt')::numeric/1000))>=make_interval(days=>coalesce((cfg->>'minDays')::integer,0));
   if pending_count>0 then
    select string_agg(distinct reason#>>'{}',', ') into reasons from records r cross join lateral jsonb_array_elements(ticket_missing_requirements(r.data)) reason where r.collection='issues' and r.data->>'reporterUid'=person.id and (r.data->'pendingEvidence'='true'::jsonb or exists(select 1 from pending_ticket_legacy q where q.issue_id=r.id));
    ctx:=jsonb_build_object('userName',person.data->>'displayName','pendingCount',pending_count,'ticketNumber',left(ticket_list,1500),'pendingReasons',coalesce(reasons,'Complete required information'));
    total:=total+notification_emit('pending',ctx,null,true,'pending:'||person.id||':'||to_char(at_time at time zone 'Asia/Ho_Chi_Minh','YYYY-MM-DD'),person.id,at_time);
   end if;
  end loop;
 end if;
 return jsonb_build_object('created',total);
end $$;
-- Time must be explicitly supplied; never substitute the ticket creation time.
create function mes_private.require_incident_times(value jsonb) returns void language plpgsql as $$
declare item jsonb;from_time timestamptz;to_time timestamptz;
begin
 if jsonb_typeof(value) is distinct from 'array' or jsonb_array_length(value) not between 1 and 20 then raise exception 'Add at least one incident time';end if;
 for item in select v from jsonb_array_elements(value) v loop
  if coalesce(item->>'kind','') not in ('point','range') or jsonb_typeof(item->'start') is distinct from 'string' then raise exception 'Choose a valid incident time';end if;
  begin from_time:=(item->>'start')::timestamptz;if item->>'kind'='range' then to_time:=(item->>'end')::timestamptz;end if;exception when others then raise exception 'Choose a valid incident time';end;
  if from_time is null or extract(year from from_time)<2000 or extract(year from from_time)>2100 or (item->>'kind'='range' and (to_time is null or to_time<from_time or extract(year from to_time)>2100)) then raise exception 'Choose a valid incident time';end if;
 end loop;
end $$;
-- Add missing-time checks to the completion queue without changing legacy tickets.
create or replace function mes_private.ticket_missing_requirements(ticket jsonb) returns jsonb language plpgsql stable security definer set search_path=mes_private,pg_temp as $$
declare missing jsonb:='[]';
begin
 if nullif(trim(ticket->>'process'),'') is null then missing:=missing||'"Process / Station"'::jsonb;end if;
 if nullif(trim(ticket->>'description'),'') is null then missing:=missing||'"Feedback"'::jsonb;end if;
 if nullif(ticket->>'departmentId','') is null then missing:=missing||'"Department"'::jsonb;end if;
 if not exists(select 1 from jsonb_array_elements(coalesce(ticket->'attachments','[]')) a where nullif(a->>'path','') is not null and (a->>'type' like 'image/%' or a->>'type' like 'video/%')) then missing:=missing||'"Photo or video"'::jsonb;end if;
 begin perform require_incident_times(ticket->'occurrences');exception when others then missing:=missing||'"Incident time"'::jsonb;end;
 return missing;
end $$;
alter function public.mes_dispatch(text,jsonb,jsonb) rename to dispatch_before_notifications;
alter function public.dispatch_before_notifications(text,jsonb,jsonb) set schema mes_private;
create function public.mes_dispatch(action text,payload jsonb,actor jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=mes_private,extensions,pg_temp as $$
declare sess jsonb;uid_value text;admin_value boolean;result jsonb;body jsonb;cfg jsonb;item jsonb;ident text;before_ticket jsonb;after_ticket jsonb;field text;changed jsonb:='[]';changed_text text;ctx jsonb;event text;content jsonb;at_time timestamptz;targets jsonb;count_value integer;before_id bigint;
begin
 if action in ('createIssue','completePendingTicket') then perform require_incident_times(payload->'occurrences');end if;
 if action='completePendingTicket' then
  result:=mes_private.dispatch_before_notifications(action,payload,actor);
  -- The original completion handler keeps all handling fields intact.
  update records set data=data||jsonb_build_object('occurrences',payload->'occurrences') where collection='issues' and id=payload->>'id';
  return result;
 end if;
 if action in ('getNotifications','markNotificationRead','markAllNotificationsRead','getNotificationAdmin','saveNotificationTemplate','deleteNotificationTemplate','saveNotificationRule','sendNotification','updateNotificationJob','cancelNotificationJob','reserveNotificationMedia','authorizeNotificationMedia','canReadNotificationMedia','updateIssue','saveTicketEdit') then
  sess:=mes_private.dispatch_before_notifications('getSession','{}',actor);uid_value:=sess->'user'->>'uid';admin_value:=coalesce((sess->>'isOwner')::boolean,false) or coalesce((sess->>'isAdmin')::boolean,false);
  if uid_value is null then raise exception 'Sign in first' using errcode='28000';end if;
  if action='getNotifications' then
   if payload ? 'before' and (payload->>'before' !~ '^[0-9]{1,18}$') then raise exception 'Invalid inbox cursor';end if;
   before_id:=coalesce((payload->>'before')::bigint,9223372036854775807);
   select coalesce(jsonb_agg(to_jsonb(n)-array['recipient_uid','event_key'] order by n.id desc),'[]') into body from (select * from notifications where recipient_uid=uid_value and id<before_id order by id desc limit 30) n;
   select count(*)::integer into count_value from notifications where recipient_uid=uid_value and read_at is null;
   select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'type',m.type,'title',m.title,'size',m.size)),'[]') into content from public.mes_media m where m.ready and m.purpose='notification' and exists(select 1 from jsonb_array_elements(body) n where n->'content'->'media' ? m.id);
   return jsonb_build_object('rows',body,'unread',count_value,'media',content);
  elsif action='markNotificationRead' then
   if payload->>'id' !~ '^[0-9]{1,18}$' then raise exception 'Invalid notification';end if;
   update notifications set read_at=coalesce(read_at,now()) where recipient_uid=uid_value and id=(payload->>'id')::bigint;return '{"ok":true}';
  elsif action='markAllNotificationsRead' then update notifications set read_at=now() where recipient_uid=uid_value and read_at is null;return '{"ok":true}';
  elsif action='canReadNotificationMedia' then
   if admin_value or exists(select 1 from notifications n where n.recipient_uid=uid_value and n.content->'media' ? (payload->>'id')) then return '{"ok":true}';end if;raise exception 'Media unavailable';
  end if;
  if action in ('updateIssue','saveTicketEdit') then
   ident:=payload->>'id';select data into before_ticket from records where collection='issues' and id=ident for update;
   result:=mes_private.dispatch_before_notifications(action,payload,actor);
   select data into after_ticket from records where collection='issues' and id=ident;
   if admin_value and after_ticket is not null and before_ticket is not null and after_ticket->'pendingEvidence' is distinct from 'true'::jsonb and not coalesce((after_ticket->>'deleting')::boolean,false) and not exists(select 1 from pending_ticket_legacy q where q.issue_id=ident) then
    select config into cfg from notification_rules where id='ticket_update';
    foreach field in array array['subject','description','status','progress','priority','assessment','process','departmentId','issueTypeId','attachments','occurrences'] loop if before_ticket->field is distinct from after_ticket->field and coalesce(cfg->'fields','[]') ? field then changed:=changed||to_jsonb(field);end if;end loop;
    select string_agg(value,', ') into changed_text from jsonb_array_elements_text(changed);
    ctx:=jsonb_build_object('ticketNumber',coalesce((select code from public.mes_ticket_codes where issue_id=ident),left(ident,12)),'ticketTitle',after_ticket->>'subject','status',after_ticket->>'status','progress',coalesce(after_ticket->>'progress','0'),'priority',after_ticket->>'priority','changes',coalesce(changed_text,''),'userName',after_ticket->>'reporterName');
    event:='ticket:'||ident||':'||coalesce(after_ticket->>'updatedAt','0')||':'||md5(before_ticket::text||after_ticket::text);
    if jsonb_array_length(changed)>0 then perform notification_emit('ticket_update',ctx,ident,false,event,after_ticket->>'reporterUid');end if;
    select config into cfg from notification_rules where id='priority_alert';if before_ticket->'priority' is distinct from after_ticket->'priority' and coalesce(cfg->'priorities','["Critical"]') ? (after_ticket->>'priority') then perform notification_emit('priority_alert',ctx,ident,false,'alert:'||event,after_ticket->>'reporterUid');end if;
   end if;
   return result;
  end if;
  if not admin_value then raise exception 'Administrator access required';end if;
  if action='getNotificationAdmin' then
   select coalesce(jsonb_agg(to_jsonb(t) order by t.updated_at desc),'[]') into body from notification_templates t;
   select coalesce(jsonb_object_agg(id,config),'{}') into cfg from notification_rules;
   select coalesce(jsonb_agg(jsonb_build_object('uid',r.id,'name',r.data->>'displayName','username',r.data->>'username') order by r.data->>'displayName'),'[]') into targets from records r where r.collection='users' and coalesce((r.data->>'active')::boolean,false) and not coalesce((r.data->>'isTester')::boolean,false);
   select coalesce(jsonb_agg(to_jsonb(j) order by j.created_at desc),'[]') into content from (select * from notification_jobs order by created_at desc limit 50) j;
   select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'type',m.type,'title',m.title,'size',m.size) order by m.created_at desc),'[]') into result from public.mes_media m where m.purpose='notification' and m.ready;
   return jsonb_build_object('templates',body,'rules',cfg,'users',targets,'jobs',content,'media',result,'timezone','Asia/Ho_Chi_Minh');
  elsif action='saveNotificationTemplate' then
   perform notification_validate_content(payload->'content');if jsonb_typeof(payload->'name') is distinct from 'string' or char_length(trim(payload->>'name')) not between 1 and 100 then raise exception 'Enter a template name';end if;
   ident:=coalesce(nullif(payload->>'id',''),gen_random_uuid()::text);
   insert into notification_templates(id,name,content,updated_by) values(ident,trim(payload->>'name'),payload->'content',uid_value) on conflict(id) do update set name=excluded.name,content=excluded.content,updated_by=excluded.updated_by,updated_at=now();return jsonb_build_object('id',ident,'ok',true);
  elsif action='deleteNotificationTemplate' then
   if exists(select 1 from notification_rules where config->>'templateId'=payload->>'id') then raise exception 'This template is used by an automatic rule';end if;delete from notification_templates where id=payload->>'id';return '{"ok":true}';
  elsif action='saveNotificationRule' then
   ident:=payload->>'id';cfg:=payload->'config';if ident is null or ident not in ('pending','ticket_update','priority_alert') or jsonb_typeof(cfg->'enabled') is distinct from 'boolean' or not exists(select 1 from notification_templates where id=cfg->>'templateId') then raise exception 'Invalid automatic notification rule';end if;
   perform notification_validate_audience(cfg->>'audience',cfg->'uids',cfg->'channels',true);
   if ident='pending' and (coalesce(cfg->>'time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(cfg->>'minDays','') !~ '^[0-9]{1,3}$') then raise exception 'Choose reminder time and minimum age';end if;
   if ident='pending' and cfg ? 'days' then if jsonb_typeof(cfg->'days') is distinct from 'array' or jsonb_array_length(cfg->'days') not between 1 and 7 then raise exception 'Choose reminder days';end if;for item in select v from jsonb_array_elements(cfg->'days') v loop if item#>>'{}' not in ('0','1','2','3','4','5','6') then raise exception 'Invalid reminder day';end if;end loop;end if;
   if ident='ticket_update' then if jsonb_typeof(cfg->'fields') is distinct from 'array' then raise exception 'Choose changed fields';end if;for item in select v from jsonb_array_elements(cfg->'fields') v loop if item#>>'{}' not in ('subject','description','status','progress','priority','assessment','process','departmentId','issueTypeId','attachments','occurrences') then raise exception 'Invalid changed field';end if;end loop;end if;
   if ident='priority_alert' then if jsonb_typeof(cfg->'priorities') is distinct from 'array' then raise exception 'Choose alert priorities';end if;for item in select v from jsonb_array_elements(cfg->'priorities') v loop if item#>>'{}' not in ('Low','Medium','High','Critical') then raise exception 'Invalid alert priority';end if;end loop;end if;
   update notification_rules set config=cfg where id=ident;return '{"ok":true}';
  elsif action in ('sendNotification','updateNotificationJob') then
   perform notification_validate_content(payload->'content');perform notification_validate_audience(payload->>'audience',payload->'uids',payload->'channels');
   if coalesce(payload->>'repeat','') not in ('none','daily','weekly') then raise exception 'Choose a valid schedule';end if;
   begin at_time:=coalesce(nullif(payload->>'sendAt','')::timestamptz,clock_timestamp());exception when others then raise exception 'Choose a valid send time';end;
   if not isfinite(at_time) or at_time<clock_timestamp()-interval '1 day' or at_time>clock_timestamp()+interval '10 years' then raise exception 'Choose a send time within the next ten years';end if;
   if action='updateNotificationJob' then
    ident:=payload->>'id';update notification_jobs set content=payload->'content',audience=payload->>'audience',uids=payload->'uids',channels=payload->'channels',next_run=at_time,repeat_mode=payload->>'repeat',enabled=true where id=ident;if not found then raise exception 'Schedule unavailable';end if;
   else
    ident:=gen_random_uuid()::text;insert into notification_jobs(id,content,audience,uids,channels,next_run,repeat_mode,created_by) values(ident,payload->'content',payload->>'audience',payload->'uids',payload->'channels',at_time,payload->>'repeat',uid_value);
   end if;
   if at_time<=clock_timestamp() then perform public.mes_notifications_tick();end if;return jsonb_build_object('id',ident,'ok',true);
  elsif action='cancelNotificationJob' then update notification_jobs set enabled=false where id=payload->>'id';return '{"ok":true}';
  elsif action='reserveNotificationMedia' then
   if jsonb_typeof(payload->'title') is distinct from 'string' or char_length(trim(payload->>'title')) not between 1 and 180 or payload->>'type' is null or payload->>'type' not in ('image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime') or jsonb_typeof(payload->'size') is distinct from 'number' or payload->>'size' !~ '^[0-9]{1,10}$' or (payload->>'size')::bigint not between 1 and (case when payload->>'type' like 'video/%' then 209715200 else 10485760 end) then raise exception 'Invalid notification media';end if;
   perform pg_advisory_xact_lock(74529082);
   if (select coalesce(sum(size),0) from public.mes_media)+(select coalesce(sum(size),0) from public.files)+(select coalesce(sum(size),0) from public.mes_uploads where kind='ticket' and not complete and expires>now())+(payload->>'size')::bigint>coalesce((payload->>'storageQuota')::bigint,68719476736) then raise exception 'Storage quota reached';end if;
   delete from public.mes_media m where m.purpose='notification' and not m.ready and m.created_at<now()-interval '1 day' and not exists(select 1 from public.mes_uploads u where u.kind='media' and u.path=m.id);
   ident:=gen_random_uuid()::text;insert into public.mes_media(id,title,type,size,purpose) values(ident,trim(payload->>'title'),payload->>'type',(payload->>'size')::bigint,'notification');insert into notification_media values(ident,uid_value);return jsonb_build_object('id',ident);
  elsif action='authorizeNotificationMedia' then
   if exists(select 1 from notification_media where media_id=payload->>'id' and (owner_uid=uid_value or coalesce((sess->>'isOwner')::boolean,false))) then return '{"ok":true}';end if;raise exception 'Not your upload';
  end if;
 end if;
 return mes_private.dispatch_before_notifications(action,payload,actor);
end $$;
-- The completion queue must validate the supplied incident times, not the old draft.
do $upgrade$
declare definition text;
begin
 select pg_get_functiondef('mes_private.dispatch_before_notifications(text,jsonb,jsonb)'::regprocedure) into definition;
 if position($needle$'richDocument',payload->'richDocument','departmentId'$needle$ in definition)=0 then raise exception 'Pending completion function differs';end if;
 definition:=replace(definition,$needle$'richDocument',payload->'richDocument','departmentId'$needle$,$replacement$'richDocument',payload->'richDocument','occurrences',payload->'occurrences','departmentId'$replacement$);execute definition;
end $upgrade$;
