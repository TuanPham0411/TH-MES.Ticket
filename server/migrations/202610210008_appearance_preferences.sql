-- Personal presentation preferences only; ticket data and authored formatting stay intact.
alter function public.mes_dispatch(text,jsonb,jsonb) rename to dispatch_before_appearance_preferences;
alter function public.dispatch_before_appearance_preferences(text,jsonb,jsonb) set schema mes_private;
create function public.mes_dispatch(action text,payload jsonb,actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=mes_private,extensions,pg_temp as $$
declare current_session jsonb; uid_value text; result jsonb;
begin
 if action in ('getAppearancePreferences','saveAppearancePreferences') then
  current_session:=mes_private.dispatch_before_appearance_preferences('getSession','{}',actor);
  uid_value:=current_session->'user'->>'uid';
  if uid_value is null then raise exception 'Sign in first';end if;
  if action='getAppearancePreferences' then
   select data into result from records where collection='appearancePreferences' and id=uid_value;
   return coalesce(result,'{"font":"calibri","size":14}'::jsonb);
  end if;
  if jsonb_typeof(payload->'font') is distinct from 'string' or payload->>'font' not in ('calibri','arial','segoe','tahoma','verdana','georgia','times','courier') or jsonb_typeof(payload->'size') is distinct from 'number' or payload->>'size' not in ('12','14','16','18','20') then raise exception 'Invalid appearance preferences';end if;
  result:=jsonb_build_object('font',payload->>'font','size',(payload->>'size')::integer);
  insert into records(collection,id,data) values('appearancePreferences',uid_value,result) on conflict(collection,id) do update set data=excluded.data;
  return result;
 end if;
 return mes_private.dispatch_before_appearance_preferences(action,payload,actor);
end $$;
