-- Site defaults are separate from each account's explicit override.
alter function public.mes_dispatch(text,jsonb,jsonb) rename to dispatch_before_appearance_defaults;
alter function public.dispatch_before_appearance_defaults(text,jsonb,jsonb) set schema mes_private;
create function public.mes_dispatch(action text,payload jsonb,actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=mes_private,extensions,pg_temp as $$
declare current_session jsonb; uid_value text; result jsonb; defaults jsonb;
begin
 if action in ('getAppearanceDefaults','saveAppearanceDefaults','getAppearancePreferences','resetAppearancePreferences') then
  select data into defaults from records where collection='siteAppearance' and id='default';
  defaults:=coalesce(defaults,'{"font":"calibri","size":14}'::jsonb);
  if action='getAppearanceDefaults' then return defaults;end if;
  current_session:=mes_private.dispatch_before_appearance_defaults('getSession','{}',actor);
  uid_value:=current_session->'user'->>'uid';
  if uid_value is null then raise exception 'Sign in first';end if;
  if action='saveAppearanceDefaults' then
   if not coalesce((current_session->>'isOwner')::boolean,false) then raise exception 'Administrator required';end if;
   if jsonb_typeof(payload->'font') is distinct from 'string' or payload->>'font' not in ('calibri','arial','segoe','tahoma','verdana','georgia','times','courier') or jsonb_typeof(payload->'size') is distinct from 'number' or payload->>'size' not in ('12','14','16','18','20') then raise exception 'Invalid appearance defaults';end if;
   result:=jsonb_build_object('font',payload->>'font','size',(payload->>'size')::integer);
   insert into records(collection,id,data) values('siteAppearance','default',result) on conflict(collection,id) do update set data=excluded.data;
   return result;
  end if;
  if action='resetAppearancePreferences' then delete from records where collection='appearancePreferences' and id=uid_value;end if;
  select data into result from records where collection='appearancePreferences' and id=uid_value;
  if result is null then return defaults||'{"custom":false}'::jsonb;end if;
  return result||'{"custom":true}'::jsonb;
 end if;
 return mes_private.dispatch_before_appearance_defaults(action,payload,actor);
end $$;
