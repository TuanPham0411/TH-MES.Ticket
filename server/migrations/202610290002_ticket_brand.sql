-- Change only system-supplied owner labels; preserve user content and account IDs.
update mes_private.records set data=jsonb_set(data,'{displayName}','"TH.Ticket Owner"'::jsonb)
 where collection='users' and id='mes-owner' and data->>'displayName'='MES Owner';
do $$
declare entry record; definition text;
begin
 for entry in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'mes_%' and p.prokind='f'
 loop
  definition:=pg_get_functiondef(entry.oid);
  if strpos(definition,'''MES Owner''')>0 then
   execute replace(definition,'''MES Owner''','''TH.Ticket Owner''');
  end if;
 end loop;
end $$;
