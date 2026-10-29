-- Administrative account editing and deletion; historical feedback stays intact.
DO $upgrade$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('public.ticket_dispatch(text,jsonb,jsonb)'::regprocedure);
 IF position($old$  if action='manageUser' and op='update' then
    ident:=payload->>'uid';uname:=lower(trim(payload->>'username'));
    if ident in ('ticket-owner','ticket-tester') or uname is null or uname !~ '^[a-z0-9][a-z0-9._-]{0,63}$' or position('..' in uname)>0 or uname in ('hpham','ticket.tester') then raise exception 'Invalid username'; end if;
    perform pg_advisory_xact_lock(hashtextextended(uname,1));
    if exists(select 1 from records where collection='users' and data->>'username'=uname and id<>ident) then raise exception 'Username already exists'; end if;
    update records set data=data||jsonb_build_object('username',uname,'updatedAt',tick) where collection='users' and id=ident;
    if not found then raise exception 'User not found'; end if;
    update credentials set revision=revision+1 where credentials.uid=ident;
    delete from sessions where sessions.uid=ident;
    return jsonb_build_object('uid',ident);
  end if;
$old$ in definition)=0 THEN RAISE EXCEPTION 'Account dispatcher differs'; END IF;
 definition:=replace(definition,$old$  if action='manageUser' and op='update' then
    ident:=payload->>'uid';uname:=lower(trim(payload->>'username'));
    if ident in ('ticket-owner','ticket-tester') or uname is null or uname !~ '^[a-z0-9][a-z0-9._-]{0,63}$' or position('..' in uname)>0 or uname in ('hpham','ticket.tester') then raise exception 'Invalid username'; end if;
    perform pg_advisory_xact_lock(hashtextextended(uname,1));
    if exists(select 1 from records where collection='users' and data->>'username'=uname and id<>ident) then raise exception 'Username already exists'; end if;
    update records set data=data||jsonb_build_object('username',uname,'updatedAt',tick) where collection='users' and id=ident;
    if not found then raise exception 'User not found'; end if;
    update credentials set revision=revision+1 where credentials.uid=ident;
    delete from sessions where sessions.uid=ident;
    return jsonb_build_object('uid',ident);
  end if;
$old$,$new$  if action='manageUser' and op in ('update','delete','deactivate') then
    ident:=payload->>'uid';
    if ident is null or ident in ('ticket-owner','ticket-tester') or ident=uid then raise exception 'Reserved account'; end if;
    select data into u from records where collection='users' and id=ident for update;
    if u is null then raise exception 'User not found'; end if;
    if op='delete' then
      delete from sessions where sessions.uid=ident;
      delete from credentials where credentials.uid=ident;
      delete from records where collection='users' and id=ident;
      return '{"ok":true}';
    end if;
    if op='deactivate' then
      if jsonb_typeof(payload->'active') is distinct from 'boolean' then raise exception 'Invalid account state'; end if;
      update records set data=data||jsonb_build_object('active',payload->'active','updatedAt',tick) where collection='users' and id=ident;
      delete from sessions where sessions.uid=ident;
      return '{"ok":true}';
    end if;
    uname:=lower(trim(coalesce(payload->>'username',u->>'username')));
    display:=trim(coalesce(payload->>'displayName',u->>'displayName'));
    if uname !~ '^[a-z0-9][a-z0-9._-]{0,63}$' or position('..' in uname)>0 or uname in ('hpham','ticket.tester') or display is null or char_length(display) not between 1 and 80 or char_length(coalesce(payload->>'email',''))>160 or char_length(coalesce(payload->>'phone',''))>32 or char_length(coalesce(payload->>'jobTitle',''))>80 then raise exception 'Invalid account details'; end if;
    perform pg_advisory_xact_lock(hashtextextended(uname,1));
    if exists(select 1 from records where collection='users' and data->>'username'=uname and id<>ident) then raise exception 'Username already exists'; end if;
    update records set data=data||jsonb_build_object('username',uname,'displayName',display,'email',coalesce(payload->>'email',u->>'email',''),'phone',coalesce(payload->>'phone',u->>'phone',''),'jobTitle',coalesce(payload->>'jobTitle',u->>'jobTitle',''),'updatedAt',tick) where collection='users' and id=ident;
    if uname is distinct from u->>'username' then
      update credentials set revision=revision+1 where credentials.uid=ident;
      delete from sessions where sessions.uid=ident;
    end if;
    return jsonb_build_object('uid',ident);
  end if;
$new$);
 EXECUTE definition;
END $upgrade$;
