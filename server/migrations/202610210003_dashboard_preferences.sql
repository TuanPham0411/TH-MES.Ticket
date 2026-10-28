alter function public.mes_dispatch(text,jsonb,jsonb) rename to dispatch_before_dashboard_preferences;
alter function public.dispatch_before_dashboard_preferences(text,jsonb,jsonb) set schema mes_private;
create function public.mes_dispatch(action text,payload jsonb,actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=mes_private,extensions,pg_temp as $$
declare current_session jsonb; uid_value text; hidden jsonb; item jsonb; result jsonb;
begin
 if action in ('getDashboardPreferences','saveDashboardPreferences') then
  current_session:=mes_private.dispatch_before_dashboard_preferences('getSession','{}',actor);uid_value:=current_session->'user'->>'uid';
  if action='getDashboardPreferences' then
   select data into result from records where collection='dashboardPreferences' and id=uid_value;
   return coalesce(result,'{"hidden":[]}'::jsonb);
  end if;
  hidden:=payload->'hidden';
  if jsonb_typeof(hidden) is distinct from 'array' or jsonb_array_length(hidden)>15 then raise exception 'Invalid dashboard preferences';end if;
  for item in select value from jsonb_array_elements(hidden) loop
   if jsonb_typeof(item)<>'string' or (item#>>'{}') not in ('metrics','notices','video','activity','status','performance','priority','types','department-progress','departments','recent','aging','priority-detail','resolution-detail','department-detail') then raise exception 'Unknown widget';end if;
  end loop;
  result:=jsonb_build_object('hidden',hidden);
  insert into records(collection,id,data) values('dashboardPreferences',uid_value,result) on conflict(collection,id) do update set data=excluded.data;
  return result;
 end if;
 return mes_private.dispatch_before_dashboard_preferences(action,payload,actor);
end $$;
