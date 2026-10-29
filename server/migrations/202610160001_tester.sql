-- Incremental, repeatable update. Preserves existing issues, users, files and policy.
-- Upgrade the installed dispatcher instead of copying its complete large body.
DO $tester_upgrade$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('public.ticket_dispatch(text,jsonb,jsonb)'::regprocedure);
  IF position('Tester unavailable' in definition) = 0 THEN
    IF position($before$  if not own and actor ? 'session' then$before$ in definition) = 0 THEN
      RAISE EXCEPTION 'TICKET dispatcher version differs; stop and review upgrade';
    END IF;
    definition := replace(definition, $before$  if not own and actor ? 'session' then$before$, $after$  if own and actor->>'tester'='true' then
    uid:='ticket-tester';
    select data into u from records where collection='users' and id=uid;
    if not coalesce((u->>'active')::boolean,false) or not coalesce((u->>'isTester')::boolean,false) then raise exception 'Tester unavailable'; end if;
    own:=false; verified:=true;
  end if;
  if not own and actor ? 'session' then$after$);
    IF position($before$where collection='users' and (data->>'active')::boolean;$before$ in definition) = 0 THEN
      RAISE EXCEPTION 'TICKET dispatcher version differs; stop and review upgrade';
    END IF;
    definition := replace(definition, $before$where collection='users' and (data->>'active')::boolean;$before$, $after$where collection='users' and (data->>'active')::boolean and not coalesce((data->>'isTester')::boolean,false);$after$);
    IF position($before$where collection='users' and data->>'username'=uname and (data->>'active')::boolean;$before$ in definition) = 0 THEN
      RAISE EXCEPTION 'TICKET dispatcher version differs; stop and review upgrade';
    END IF;
    definition := replace(definition, $before$where collection='users' and data->>'username'=uname and (data->>'active')::boolean;$before$, $after$where collection='users' and data->>'username'=uname and (data->>'active')::boolean and not coalesce((data->>'isTester')::boolean,false);$after$);
    IF position($before$if not coalesce((u->>'active')::boolean,false) or (action=$before$ in definition) = 0 THEN
      RAISE EXCEPTION 'TICKET dispatcher version differs; stop and review upgrade';
    END IF;
    definition := replace(definition, $before$if not coalesce((u->>'active')::boolean,false) or (action=$before$, $after$if coalesce((u->>'isTester')::boolean,false) or not coalesce((u->>'active')::boolean,false) or (action=$after$);
    EXECUTE definition;
  END IF;
END
$tester_upgrade$;
INSERT INTO ticket_private.records(collection,id,data)
VALUES ('users','ticket-tester',jsonb_build_object(
  'username','ticket.tester','displayName','Tester','active',true,'isTester',true,
  'createdAt',(extract(epoch from now())*1000)::bigint
)) ON CONFLICT(collection,id) DO NOTHING;
