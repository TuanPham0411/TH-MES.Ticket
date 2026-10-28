-- Incremental rich-text update; preserves reports, attachments and existing plain text.
DO $rich_upgrade$
DECLARE definition text;
BEGIN
  definition:=pg_get_functiondef('public.mes_dispatch(text,jsonb,jsonb)'::regprocedure);
  IF position('Rich feedback v1' in definition)=0 THEN
    IF position($before$  if jsonb_typeof(payload)<>'object' then raise exception 'Invalid payload'; end if;$before$ in definition)=0 THEN RAISE EXCEPTION 'MES dispatcher differs; review rich-text upgrade'; END IF;
    definition:=replace(definition,$before$  if jsonb_typeof(payload)<>'object' then raise exception 'Invalid payload'; end if;$before$,$after$  if jsonb_typeof(payload)<>'object' then raise exception 'Invalid payload'; end if;
  -- Rich feedback v1: images reference reserved slots, never remote URLs or HTML.
  if (action='createIssue' or (action='updateIssue' and op='edit')) and payload ? 'richDocument' then
    d:=payload->'richDocument';
    if jsonb_typeof(d) is distinct from 'object' or coalesce(d->>'version','')<>'1' or jsonb_typeof(d->'ops') is distinct from 'array' or jsonb_array_length(d->'ops')>256 or char_length(d::text)>30000 then raise exception 'Invalid rich feedback'; end if;
    for r in select value from jsonb_array_elements(d->'ops') loop
      if jsonb_typeof(r->'insert')='object' then
        if jsonb_typeof(r->'insert'->'image') is distinct from 'number' or r->'insert'->>'image' !~ '^[0-4]$' or (select count(*) from jsonb_object_keys(r->'insert'))<>1 then raise exception 'Invalid image slot'; end if;
      elsif jsonb_typeof(r->'insert') is distinct from 'string' then raise exception 'Invalid formatted text'; end if;
      if r ? 'attributes' and jsonb_typeof(r->'attributes') is distinct from 'object' then raise exception 'Invalid text attributes'; end if;
    end loop;
  end if;$after$);
    IF position($before$'description',trim(payload->>'description'),'reporterUid'$before$ in definition)=0 THEN RAISE EXCEPTION 'MES dispatcher differs; review rich-text upgrade'; END IF;
    definition:=replace(definition,$before$'description',trim(payload->>'description'),'reporterUid'$before$,$after$'description',trim(payload->>'description'),'richDocument',payload->'richDocument','reporterUid'$after$);
    IF position($before$        ev:=jsonb_build_object('before'$before$ in definition)=0 THEN RAISE EXCEPTION 'MES dispatcher differs; review rich-text upgrade'; END IF;
    definition:=replace(definition,$before$        ev:=jsonb_build_object('before'$before$,$after$        changes:=changes||jsonb_build_object('richDocument',payload->'richDocument');
        ev:=jsonb_build_object('before'$after$);
    IF position($before$'description',old->'description'),'after',changes-'updatedAt'$before$ in definition)=0 THEN RAISE EXCEPTION 'MES dispatcher differs; review rich-text upgrade'; END IF;
    definition:=replace(definition,$before$'description',old->'description'),'after',changes-'updatedAt'$before$,$after$'description',old->'description','richDocument',old->'richDocument'),'after',changes-'updatedAt'$after$);
    IF position($before$or tick-(r->>'createdAt')::bigint>900000$before$ in definition)=0 THEN RAISE EXCEPTION 'MES dispatcher differs; review rich-text upgrade'; END IF;
    definition:=replace(definition,$before$or tick-(r->>'createdAt')::bigint>900000$before$,$after$or (not own and tick-(r->>'createdAt')::bigint>900000)$after$);
    EXECUTE definition;
  END IF;
END
$rich_upgrade$;
