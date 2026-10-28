-- Admin edit drafts use fresh immutable file paths; old originals/history stay intact.
create table mes_private.attachment_drafts(path text primary key,issue_id text not null,owner_uid text not null,slot_index integer not null check(slot_index between 0 and 4),expires timestamptz not null default now()+interval '2 hours');
alter function public.mes_dispatch(text,jsonb,jsonb) rename to dispatch_before_full_edit;
alter function public.dispatch_before_full_edit(text,jsonb,jsonb) set schema mes_private;
create function public.mes_dispatch(action text,payload jsonb,actor jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=mes_private,extensions,pg_temp as $$
declare s jsonb;old jsonb;updated jsonb;changes jsonb;d jsonb;f jsonb;rows jsonb:='[]';item jsonb;ident text;uid text;idx integer;reserved text;seen integer[]:='{}';slots jsonb:='[]';tick bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if action in ('reserveTicketFiles','saveTicketEdit') or (action='uploadUrl' and exists(select 1 from attachment_drafts where path=payload->>'path' and expires>now())) then
  s:=mes_private.dispatch_before_full_edit('getSession','{}',actor);
  if not coalesce((s->>'isOwner')::boolean,false) then raise exception 'Administrator required';end if;
  uid:=s->'user'->>'uid';ident:=coalesce(payload->>'id',split_part(payload->>'path','/',2));
  select data into old from records where collection='issues' and id=ident for update;
  if old is null or coalesce((old->>'deleting')::boolean,false) then raise exception 'Issue unavailable';end if;
  if action='uploadUrl' then
   if not exists(select 1 from attachment_drafts where path=payload->>'path' and issue_id=ident and owner_uid=uid and expires>now()) then raise exception 'Invalid edit upload';end if;
   return '{"ok":true}';
  end if;
  if action='reserveTicketFiles' then
   if jsonb_typeof(payload->'indices') is distinct from 'array' or jsonb_array_length(payload->'indices') not between 1 and 5 then raise exception 'Invalid attachment slots';end if;
   delete from attachment_drafts where expires<now();
   if (select count(*) from attachment_drafts where issue_id=ident)>40 then raise exception 'Too many pending edits; retry later';end if;
   for item in select value from jsonb_array_elements(payload->'indices') loop
    if item::text !~ '^[0-4]$' then raise exception 'Invalid attachment slot';end if;
    idx:=item::text::integer;reserved:=gen_random_uuid()::text;
    insert into attachment_drafts(path,issue_id,owner_uid,slot_index) values('issues/'||ident||'/'||reserved,ident,uid,idx);
    rows:=rows||jsonb_build_array(jsonb_build_object('slot',reserved,'path','issues/'||ident||'/'||reserved,'slotIndex',idx));
   end loop;
   return jsonb_build_object('files',rows);
  end if;
  if payload->'baseUpdatedAt' is distinct from old->'updatedAt' then raise exception using errcode='P0409',message='This ticket changed while you were editing. Reopen the editor and try again.';end if;
  if jsonb_typeof(payload->'files') is distinct from 'array' or jsonb_array_length(payload->'files')>5 then raise exception 'Maximum five attachments';end if;
  for f in select value from jsonb_array_elements(payload->'files') loop
   if jsonb_typeof(f->'slotIndex') is distinct from 'number' or f->>'slotIndex' !~ '^[0-4]$' or f->>'name' is null or char_length(trim(f->>'name')) not between 1 and 180 then raise exception 'Invalid attachment';end if;
   idx:=(f->>'slotIndex')::integer;
   if idx=any(seen) then raise exception 'Duplicate attachment slot';end if;seen:=array_append(seen,idx);
   if not exists(select 1 from jsonb_array_elements(coalesce(old->'attachments','[]')) a where a->>'path'=f->>'path') and not exists(select 1 from attachment_drafts where path=f->>'path' and issue_id=ident and owner_uid=uid and slot_index=idx and expires>now()) then raise exception 'Attachment is not part of this edit';end if;
   select jsonb_build_object('path',p.path,'type',p.type,'size',p.size,'name',trim(f->>'name'),'slotIndex',idx) into d from public.files p where p.path=f->>'path';
   if d is null then raise exception 'Upload is incomplete';end if;rows:=rows||jsonb_build_array(d);
  end loop;
  for item in select value from jsonb_array_elements(coalesce(payload->'richDocument'->'ops','[]')) loop
   if jsonb_typeof(item->'insert')='object' and not exists(select 1 from jsonb_array_elements(rows) a where a->>'slotIndex'=item->'insert'->>'image' and a->>'type' like 'image/%') then raise exception 'Remove the missing inline image before saving';end if;
  end loop;
  changes:='{}';
  for ident in select unnest(array['departmentId','issueTypeId','reporterUid']) loop
   select data into d from records where collection=case ident when 'departmentId' then 'departments' else 'users' end and id=payload->>ident;
   if ident='issueTypeId' then select data into d from public.mes_workspace where kind='issueTypes' and id=payload->>ident;end if;
   if d is null and nullif(payload->>ident,'') is not distinct from old->>ident then continue;end if;
   if d is null or (payload->>ident is distinct from old->>ident and not coalesce((d->>'active')::boolean,true)) then raise exception 'Choose an existing active directory entry';end if;
   changes:=changes||case ident when 'departmentId' then jsonb_build_object('departmentId',payload->>ident,'departmentName',d->>'name') when 'issueTypeId' then jsonb_build_object('issueTypeId',payload->>ident,'issueTypeName',d->>'name') else jsonb_build_object('reporterUid',payload->>ident,'reporterName',d->>'displayName','reporterUsername',d->>'username') end;
  end loop;
  ident:=payload->>'id';
  -- Existing validation and timeline recording remain the authority for text/handling.
  perform mes_private.dispatch_before_full_edit('updateIssue',payload||'{"operation":"edit"}',actor);
  perform mes_private.dispatch_before_full_edit('updateIssue',payload||'{"operation":"handling"}',actor);
  for idx in 0..4 loop select split_part(a->>'path','/',3) into reserved from jsonb_array_elements(rows) a where (a->>'slotIndex')::integer=idx;slots:=slots||jsonb_build_array(coalesce(reserved,gen_random_uuid()::text));end loop;
  update records set data=data||changes||jsonb_build_object('attachments',rows,'uploadSlots',slots,'updatedAt',tick) where collection='issues' and id=ident returning data into updated;
  for f in select value from jsonb_array_elements(rows) loop update public.files set name=f->>'name' where path=f->>'path';end loop;
  insert into records(collection,id,data) values('issues/'||ident||'/timeline',gen_random_uuid()::text,jsonb_build_object('kind','edit','text','Administrator updated ticket fields and attachments. Removed originals are retained in storage.','before',old-array['uploadSlots','reporterUid','reporterUsername','createdBy'],'after',updated-array['uploadSlots','reporterUid','reporterUsername','createdBy'],'authorUid',uid,'author',s->'user'->>'displayName','createdAt',tick));
  delete from attachment_drafts where issue_id=ident and owner_uid=uid;
  return jsonb_build_object('ok',true,'id',ident);
 end if;
 return mes_private.dispatch_before_full_edit(action,payload,actor);
end $$;
