-- Explicit read-only facade. No account/session or private-directory access.
create function public.ticket_view(action text,payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=ticket_private,extensions,pg_temp as $$
declare path text; item jsonb; result jsonb; ticket jsonb; ident text;
begin
 if jsonb_typeof(payload) is distinct from 'object' then raise exception 'Invalid viewer request';end if;
 if action='readBundle' then
  if jsonb_typeof(payload->'paths') is distinct from 'array' or jsonb_array_length(payload->'paths')>8 then raise exception 'Invalid read bundle';end if;
  result:='{}';
  for item in select value from jsonb_array_elements(payload->'paths') loop
   result:=result||jsonb_build_object(item->>'path',public.ticket_view('read',item));
  end loop;
  return jsonb_build_object('snapshots',result);
 end if;
 if action in ('readTicket','downloadUrl') then
  ident:=case when action='readTicket' then payload->>'id' else split_part(payload->>'path','/',2) end;
  select data into ticket from records where collection='issues' and id=ident and not coalesce((data->>'deleting')::boolean,false);
  if ticket is null then raise exception 'Issue unavailable';end if;
  if action='downloadUrl' then
   if not exists(select 1 from jsonb_array_elements(coalesce(ticket->'attachments','[]')) f where f->>'path'=payload->>'path') then raise exception 'Unknown attachment';end if;
   return '{"ok":true}';
  end if;
  return (ticket-array['uploadSlots','reporterUid','reporterUsername','createdBy'])||jsonb_build_object('id',ident);
 end if;
 if action='read' then
  path:=payload->>'path';
  if path='issues' then
   select coalesce(jsonb_agg((data-array['uploadSlots','reporterUid','reporterUsername','createdBy'])||jsonb_build_object('id',id) order by (data->>'createdAt')::bigint desc,seq),'[]') into result from records where collection='issues' and not coalesce((data->>'deleting')::boolean,false);
  elsif path='departments' then
   select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',data->>'name','active',data->'active') order by seq),'[]') into result from records where collection='departments';
  elsif path ~ '^issues/[a-zA-Z0-9_-]{1,128}/timeline$' then
   if not exists(select 1 from records where collection='issues' and id=split_part(path,'/',2) and not coalesce((data->>'deleting')::boolean,false)) then raise exception 'Issue unavailable';end if;
   select coalesce(jsonb_agg((data-'authorUid')||jsonb_build_object('id',id) order by (data->>'createdAt')::bigint,seq),'[]') into result from records where collection=path;
  else raise exception 'Viewer read access denied';end if;
  return jsonb_build_object('rows',result);
 end if;
 raise exception 'Viewer is read only';
end $$;
