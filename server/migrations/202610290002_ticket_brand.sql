-- Change only system-supplied owner labels; preserve user content and account IDs.
update ticket_private.records set data=jsonb_set(data,'{displayName}','"TH.Ticket Owner"'::jsonb)
 where collection='users' and id='ticket-owner' and data->>'displayName'='Ticket Owner';
do $$
declare entry record; definition text;
begin
 for entry in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'ticket_%' and p.prokind='f'
 loop
  definition:=pg_get_functiondef(entry.oid);
  if strpos(definition,'''Ticket Owner''')>0 or strpos(definition,'ticket.th.io.vn')>0 then
   execute replace(replace(definition,'''Ticket Owner''','''TH.Ticket Owner'''),'ticket.th.io.vn','ticket.th.io.vn');
  end if;
 end loop;
end $$;
