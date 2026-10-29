-- Upgrade the existing dispatcher; preserve all stored feedback and historical leaders.
DO $feedback_upgrade$
DECLARE definition text;
BEGIN
  definition:=pg_get_functiondef('public.ticket_dispatch(text,jsonb,jsonb)'::regprocedure);
  IF position('Maximum 20 incident times' in definition)=0 THEN
    IF position($before$  if jsonb_typeof(payload)<>'object' then raise exception 'Invalid payload'; end if;$before$ in definition)=0 THEN RAISE EXCEPTION 'TICKET dispatcher differs; review upgrade'; END IF;
    definition:=replace(definition,$before$  if jsonb_typeof(payload)<>'object' then raise exception 'Invalid payload'; end if;$before$,$after$  if jsonb_typeof(payload)<>'object' then raise exception 'Invalid payload'; end if;
  if action='createIssue' then
    if jsonb_typeof(payload->'description') is distinct from 'string' then raise exception 'Feedback must be text'; end if;
    payload:=payload||jsonb_build_object('subject',left(split_part(trim(payload->>'description'),E'\n',1),100));
    if jsonb_typeof(coalesce(payload->'occurrences','[]'::jsonb)) is distinct from 'array' or jsonb_array_length(coalesce(payload->'occurrences','[]'::jsonb))>20 then raise exception 'Maximum 20 incident times'; end if;
    for d in select value from jsonb_array_elements(coalesce(payload->'occurrences','[]'::jsonb)) loop
      if d->>'kind' is null or d->>'kind' not in ('point','range') or jsonb_typeof(d->'start') is distinct from 'string' or d->>'start' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then raise exception 'Invalid incident time'; end if;
      if not isfinite((d->>'start')::timestamptz) or (d->>'start')::timestamptz<'2000-01-01'::timestamptz or (d->>'start')::timestamptz>='2101-01-01'::timestamptz then raise exception 'Invalid incident time'; end if;
      if d->>'kind'='range' and (jsonb_typeof(d->'end') is distinct from 'string' or (d->>'end')::timestamptz<(d->>'start')::timestamptz or not isfinite((d->>'end')::timestamptz) or (d->>'end')::timestamptz>='2101-01-01'::timestamptz) then raise exception 'Invalid incident interval'; end if;
    end loop;
  end if;$after$);
    IF position($before$  elsif action='createIssue' then
    if char_length(trim(payload->>'subject')) not between 1 and 160 or char_length(trim(payload->>'process')) not between 1 and 120 or char_length(trim(payload->>'description')) not between 10 and 5000 or not (payload ?& array['subject','process','description','teamLeaderId','departmentId','reporterUid']) then raise exception 'Invalid feedback fields'; end if;
    if not own and payload->>'reporterUid'<>uid then raise exception 'Reporter does not match verified identity'; end if;
    select data into d from records where collection='teamLeaders' and id=payload->>'teamLeaderId';
    select data into old from records where collection='departments' and id=payload->>'departmentId';
    if not coalesce((d->>'active')::boolean,false) or not coalesce((old->>'active')::boolean,false) then raise exception 'Select active team leader and department'; end if;
    u:=who;
    if own and payload->>'reporterUid'<>uid then
      select data||jsonb_build_object('uid',id) into u from records where collection='users' and id=payload->>'reporterUid' and (data->>'active')::boolean;
      if u is null then raise exception 'Reporter inactive'; end if;
    end if;
    perform pg_advisory_xact_lock(hashtextextended(uid,0));
    select data into r from records where collection='submissionRates' and id=uid;
    if r is null or tick-(r->>'windowStart')::bigint>=600000 then r:=jsonb_build_object('windowStart',tick,'count',0); end if;
    if (r->>'count')::int>=10 then raise exception 'Maximum 10 submissions per 10 minutes'; end if;
    insert into records values('submissionRates',uid,r||jsonb_build_object('count',(r->>'count')::int+1)) on conflict(collection,id) do update set data=excluded.data;
    ident:=gen_random_uuid()::text;
    select jsonb_agg(gen_random_uuid()::text) into slots from generate_series(1,5);
    r:=jsonb_build_object('subject',trim(payload->>'subject'),'process',trim(payload->>'process'),'description',trim(payload->>'description'),'reporterUid',u->>'uid','reporterName',u->>'displayName','reporterUsername',u->>'username','createdBy',uid,'teamLeaderId',payload->>'teamLeaderId','teamLeaderName',d->>'name','departmentId',payload->>'departmentId','departmentName',old->>'name','status','New','priority','Medium','assessment','','deleting',false,'attachments','[]'::jsonb,'uploadSlots',slots,'createdAt',tick,'updatedAt',tick);
    insert into records values('issues',ident,r);
    kind:='created'; message:='Feedback submitted.';
$before$ in definition)=0 THEN RAISE EXCEPTION 'TICKET dispatcher differs; review upgrade'; END IF;
    definition:=replace(definition,$before$  elsif action='createIssue' then
    if char_length(trim(payload->>'subject')) not between 1 and 160 or char_length(trim(payload->>'process')) not between 1 and 120 or char_length(trim(payload->>'description')) not between 10 and 5000 or not (payload ?& array['subject','process','description','teamLeaderId','departmentId','reporterUid']) then raise exception 'Invalid feedback fields'; end if;
    if not own and payload->>'reporterUid'<>uid then raise exception 'Reporter does not match verified identity'; end if;
    select data into d from records where collection='teamLeaders' and id=payload->>'teamLeaderId';
    select data into old from records where collection='departments' and id=payload->>'departmentId';
    if not coalesce((d->>'active')::boolean,false) or not coalesce((old->>'active')::boolean,false) then raise exception 'Select active team leader and department'; end if;
    u:=who;
    if own and payload->>'reporterUid'<>uid then
      select data||jsonb_build_object('uid',id) into u from records where collection='users' and id=payload->>'reporterUid' and (data->>'active')::boolean;
      if u is null then raise exception 'Reporter inactive'; end if;
    end if;
    perform pg_advisory_xact_lock(hashtextextended(uid,0));
    select data into r from records where collection='submissionRates' and id=uid;
    if r is null or tick-(r->>'windowStart')::bigint>=600000 then r:=jsonb_build_object('windowStart',tick,'count',0); end if;
    if (r->>'count')::int>=10 then raise exception 'Maximum 10 submissions per 10 minutes'; end if;
    insert into records values('submissionRates',uid,r||jsonb_build_object('count',(r->>'count')::int+1)) on conflict(collection,id) do update set data=excluded.data;
    ident:=gen_random_uuid()::text;
    select jsonb_agg(gen_random_uuid()::text) into slots from generate_series(1,5);
    r:=jsonb_build_object('subject',trim(payload->>'subject'),'process',trim(payload->>'process'),'description',trim(payload->>'description'),'reporterUid',u->>'uid','reporterName',u->>'displayName','reporterUsername',u->>'username','createdBy',uid,'teamLeaderId',payload->>'teamLeaderId','teamLeaderName',d->>'name','departmentId',payload->>'departmentId','departmentName',old->>'name','status','New','priority','Medium','assessment','','deleting',false,'attachments','[]'::jsonb,'uploadSlots',slots,'createdAt',tick,'updatedAt',tick);
    insert into records values('issues',ident,r);
    kind:='created'; message:='Feedback submitted.';
$before$,$after$  elsif action='createIssue' then
    if char_length(trim(payload->>'subject')) not between 1 and 160 or char_length(trim(payload->>'process')) not between 1 and 120 or char_length(trim(payload->>'description')) not between 1 and 5000 or not (payload ?& array['process','description','departmentId','reporterUid']) then raise exception 'Invalid feedback fields'; end if;
    if not own and payload->>'reporterUid'<>uid then raise exception 'Reporter does not match verified identity'; end if;
    select data into old from records where collection='departments' and id=payload->>'departmentId';
    if not coalesce((old->>'active')::boolean,false) then raise exception 'Select an active department'; end if;
    u:=who;
    if own and payload->>'reporterUid'<>uid then
      select data||jsonb_build_object('uid',id) into u from records where collection='users' and id=payload->>'reporterUid' and (data->>'active')::boolean;
      if u is null then raise exception 'Reporter inactive'; end if;
    end if;
    perform pg_advisory_xact_lock(hashtextextended(uid,0));
    select data into r from records where collection='submissionRates' and id=uid;
    if r is null or tick-(r->>'windowStart')::bigint>=600000 then r:=jsonb_build_object('windowStart',tick,'count',0); end if;
    if (r->>'count')::int>=10 then raise exception 'Maximum 10 submissions per 10 minutes'; end if;
    insert into records values('submissionRates',uid,r||jsonb_build_object('count',(r->>'count')::int+1)) on conflict(collection,id) do update set data=excluded.data;
    ident:=gen_random_uuid()::text;
    select jsonb_agg(gen_random_uuid()::text) into slots from generate_series(1,5);
    r:=jsonb_build_object('subject',trim(payload->>'subject'),'process',trim(payload->>'process'),'description',trim(payload->>'description'),'reporterUid',u->>'uid','reporterName',u->>'displayName','reporterUsername',u->>'username','createdBy',uid,'occurrences',coalesce(payload->'occurrences','[]'::jsonb),'departmentId',payload->>'departmentId','departmentName',old->>'name','status','New','priority','Medium','assessment','','deleting',false,'attachments','[]'::jsonb,'uploadSlots',slots,'createdAt',tick,'updatedAt',tick);
    insert into records values('issues',ident,r);
    kind:='created'; message:='Feedback submitted.';
$after$);
    definition:=replace(definition, 'not between 10 and 5000', 'not between 1 and 5000');
    EXECUTE definition;
  END IF;
END
$feedback_upgrade$;
