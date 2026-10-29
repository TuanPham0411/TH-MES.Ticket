-- All business writes and reads pass through the authenticated Edge API.
-- Private tables have no browser grants or policies. The dispatcher is service-only.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists ticket_private;
create table ticket_private.records (
  collection text not null, id text not null, data jsonb not null,
  seq bigint generated always as identity,
  primary key(collection,id)
);
create table ticket_private.sessions (
  hash text primary key, uid text not null, username text not null,
  device_id text, expires_at timestamptz not null
);
alter table ticket_private.records enable row level security;
alter table ticket_private.sessions enable row level security;
insert into ticket_private.records values ('settings','policy','{"requiresWindows":true}');

create or replace function public.ticket_dispatch(action text, payload jsonb, actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = ticket_private, extensions, pg_temp as $$
declare
  own boolean := coalesce((actor->>'owner')::boolean,false);
  who jsonb; u jsonb; r jsonb; d jsonb; old jsonb; changes jsonb; ev jsonb;
  ident text; uid text := actor->>'uid'; col text; op text := payload->>'operation';
  uname text; display text; nonce text; secret text; token text; did text; path text;
  win boolean; verified boolean := false; tick bigint := (extract(epoch from clock_timestamp())*1000)::bigint;
  sess ticket_private.sessions%rowtype; rec record; rows jsonb; slots jsonb; files jsonb;
  message text; kind text; n int; allowed text[] := array['New','Acknowledged','In progress','Awaiting information','Resolved','Closed'];
begin
  if jsonb_typeof(payload)<>'object' then raise exception 'Invalid payload'; end if;
  if action in ('createIssue','updateIssue') and (action='createIssue' or op='edit') then
    if jsonb_typeof(payload->'subject') is distinct from 'string' or jsonb_typeof(payload->'process') is distinct from 'string' or jsonb_typeof(payload->'description') is distinct from 'string' then raise exception 'Feedback fields must be strings'; end if;
  end if;
  select coalesce((data->>'requiresWindows')::boolean,true) into win from records where collection='settings' and id='policy';
  win := coalesce(win,true);
  if not own and actor ? 'session' then
    select * into sess from sessions where hash=encode(digest(actor->>'session','sha256'),'hex') and expires_at>now();
    if found then
      uid:=sess.uid;
      select data into u from records where collection='users' and id=uid;
      if (u->>'active')::boolean and u->>'username'=sess.username then
        verified := not win or (sess.device_id is not null and exists(select 1 from records where collection='devices' and id=sess.device_id and (data->>'active')::boolean));
      end if;
    end if;
  end if;
  if own then who:=jsonb_build_object('uid',uid,'username','hpham','displayName',coalesce(actor->>'name','TICKET Owner'),'owner',true);
  elsif verified then who:=u || jsonb_build_object('uid',uid,'owner',false);
  end if;
  if action='getDirectory' then
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'username',data->>'username','displayName',data->>'displayName','active',true)),'[]') into rows from records where collection='users' and (data->>'active')::boolean;
    return jsonb_build_object('users',rows,'requiresWindows',win);
  end if;
  if action='startWindowsChallenge' then
    uname:=lower(trim(payload->>'username'));
    if uname is null or uname !~ '^[a-z0-9][a-z0-9._-]{0,63}$' or (uname='hpham' or position('..' in uname)>0) then raise exception 'Invalid username'; end if;
    select id,data into uid,u from records where collection='users' and data->>'username'=uname and (data->>'active')::boolean;
    if uid is null then raise exception 'User unavailable'; end if;
    perform pg_advisory_xact_lock(hashtextextended(uid,0));
    select data into r from records where collection='challengeRates' and id=uid;
    if tick-coalesce((r->>'lastAt')::bigint,0)<3000 then raise exception 'Wait before retrying'; end if;
    insert into records values('challengeRates',uid,jsonb_build_object('lastAt',tick)) on conflict(collection,id) do update set data=excluded.data;
    delete from records where collection='challenges' and (data->>'expiresAt')::bigint<tick;
    nonce:=encode(gen_random_bytes(32),'hex'); ident:=gen_random_uuid()::text;
    insert into records values('challenges',ident,jsonb_build_object('uid',uid,'username',uname,'nonceHash',encode(digest(nonce,'sha256'),'hex'),'expiresAt',tick+300000,'used',false));
    return jsonb_build_object('challengeId',ident,'nonce',nonce,'username',uname);
  end if;
  if action in ('completeWindowsChallenge','loginManagedUser') then
    if action='completeWindowsChallenge' then
      did:=payload->>'deviceId';
      select data into d from records where collection='devices' and id=did for update;
      if not coalesce((d->>'active')::boolean,false) then raise exception 'Device revoked'; end if;
      secret:=d->>'secret';
      if coalesce(payload->>'nonce','') !~ '^[a-f0-9]{64}$' or coalesce(payload->>'signature','') !~ '^[a-f0-9]{64}$' or payload->>'challengeId' is null or payload->>'username' is null or encode(hmac(convert_to((payload->>'challengeId')||E'\n'||(payload->>'nonce')||E'\n'||(payload->>'username')||E'\n'||did,'UTF8'),decode(secret,'base64'),'sha256'),'hex') <> payload->>'signature' then raise exception 'Invalid Windows proof'; end if;
      select data into r from records where collection='challenges' and id=payload->>'challengeId' for update;
      if r is null or (r->>'used')::boolean or (r->>'expiresAt')::bigint<tick or r->>'nonceHash'<>encode(digest(payload->>'nonce','sha256'),'hex') or r->>'username'<>payload->>'username' then raise exception 'Challenge expired or already used'; end if;
      uid:=r->>'uid';
      update records set data=data||'{"used":true}' where collection='challenges' and id=payload->>'challengeId';
    else
      if win then raise exception 'Signed Windows verification is required'; end if;
      uid:=payload->>'uid';
    end if;
    select data into u from records where collection='users' and id=uid for update;
    if not coalesce((u->>'active')::boolean,false) or (action='completeWindowsChallenge' and u->>'username'<>payload->>'username') then raise exception 'User inactive or changed'; end if;
    delete from sessions where expires_at<now();
    token:=encode(gen_random_bytes(32),'hex');
    insert into sessions values(encode(digest(token,'sha256'),'hex'),uid,u->>'username',did,now()+interval '12 hours');
    return jsonb_build_object('sessionToken',token);
  end if;
  if who is null then raise exception 'Access denied. Verify your Windows identity again'; end if;
  if action='logout' then
    delete from sessions where hash=encode(digest(actor->>'session','sha256'),'hex'); return '{"ok":true}';
  end if;
  if action='getSession' then return jsonb_build_object('user',who,'isOwner',own,'requiresWindows',win); end if;
  if action='readBundle' then
    if jsonb_typeof(payload->'paths') is distinct from 'array' or jsonb_array_length(payload->'paths')>8 then raise exception 'Invalid read bundle'; end if;
    rows:='{}';
    for d in select value from jsonb_array_elements(payload->'paths') loop
      rows:=rows||jsonb_build_object(d->>'path', public.ticket_dispatch('read',d,actor));
    end loop;
    return jsonb_build_object('snapshots',rows);
  end if;
  if action='read' then
    path:=payload->>'path'; col:=path;
    if path='settings/policy' then return jsonb_build_object('rows',jsonb_build_array(jsonb_build_object('requiresWindows',win))); end if;
    if path ~ '^issues/[a-zA-Z0-9_-]+/timeline$' then col:=path;
    elsif path not in ('users','issues','teamLeaders','departments') or (path='users' and not own) then raise exception 'Access denied'; end if;
    select coalesce(jsonb_agg(data||jsonb_build_object('id',id) order by case when payload->>'order'='asc' then (data->>'createdAt')::bigint end asc, case when payload->>'order'='desc' then (data->>'createdAt')::bigint end desc, seq asc),'[]') into rows from records where collection=col and (own or not coalesce((data->>'deleting')::boolean,false));
    return jsonb_build_object('rows',rows);
  end if;
  if action in ('uploadUrl','downloadUrl','attachFiles') then
    ident:=case when action='attachFiles' then payload->>'issueId' else split_part(payload->>'path','/',2) end;
    select data into r from records where collection='issues' and id=ident for update;
    if r is null or coalesce((r->>'deleting')::boolean,false) then raise exception 'Issue unavailable'; end if;
    if action='downloadUrl' then
      if not exists(select 1 from jsonb_array_elements(r->'attachments') f where f->>'path'=payload->>'path') then raise exception 'Unknown attachment'; end if;
      return '{"ok":true}';
    end if;
    if not own and r->>'createdBy'<>uid then raise exception 'Not your upload'; end if;
    if action='uploadUrl' then
      path:=payload->>'path';
      if path <> 'issues/'||ident||'/'||split_part(path,'/',3) or not (r->'uploadSlots' ? split_part(path,'/',3)) or tick-(r->>'createdAt')::bigint>900000 then raise exception 'Upload slot invalid or expired'; end if;
      return '{"ok":true}';
    end if;
    files:=payload->'files';
    if jsonb_typeof(files) is distinct from 'array' or jsonb_array_length(files)>5 then raise exception 'Maximum five attachments'; end if;
    rows:=r->'attachments'; n:=0;
    for d in select value from jsonb_array_elements(files) loop
      if not (d ?& array['slot','path','name','size','type']) or jsonb_typeof(d->'name') is distinct from 'string' or jsonb_typeof(d->'size') is distinct from 'number' or not (r->'uploadSlots' ? (d->>'slot')) or d->>'path'<>'issues/'||ident||'/'||(d->>'slot') or char_length(trim(d->>'name')) not between 1 and 180 or (d->>'size')::bigint not between 1 and 10485760 or d->>'type' not in ('image/jpeg','image/png','image/webp','application/pdf','text/plain','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') then raise exception 'Invalid attachment'; end if;
      if not exists(select 1 from jsonb_array_elements(rows) f where f->>'path'=d->>'path') then rows:=rows||jsonb_build_array(d-'slot'); n:=n+1; end if;
    end loop;
    if jsonb_array_length(rows)>5 then raise exception 'Maximum five attachments'; end if;
    if n=0 then return '{"ok":true}'; end if;
    update records set data=data||jsonb_build_object('attachments',rows,'updatedAt',tick) where collection='issues' and id=ident;
    kind:='attachments'; message:=n||' attachment(s) added.';
  elsif action='createIssue' then
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
  else
    if not own then raise exception 'Only the registered Google owner can do this'; end if;
    if action='setPolicy' then
      if jsonb_typeof(payload->'requiresWindows')<>'boolean' then raise exception 'Invalid policy'; end if;
      update records set data=jsonb_build_object('requiresWindows',payload->'requiresWindows') where collection='settings' and id='policy'; return '{"ok":true}';
    elsif action='manageDirectory' then
      col:=payload->>'type';
      if col is null or col not in ('teamLeaders','departments') then raise exception 'Invalid directory'; end if;
      ident:=case when op='create' then gen_random_uuid()::text else payload->>'id' end;
      if op in ('create','update') and (payload->>'name' is null or char_length(trim(payload->>'name')) not between 1 and 80) then raise exception 'Invalid name'; end if;
      if op='create' then insert into records values(col,ident,jsonb_build_object('name',trim(payload->>'name'),'active',true,'createdAt',tick));
      elsif op='update' then update records set data=data||jsonb_build_object('name',trim(payload->>'name')) where collection=col and id=ident;
      elsif op='deactivate' then update records set data=data||jsonb_build_object('active',coalesce((payload->>'active')::boolean,false)) where collection=col and id=ident;
      else raise exception 'Invalid operation'; end if;
      return jsonb_build_object('id',ident);
    elsif action='manageUser' then
      ident:=case when op='create' then gen_random_uuid()::text else payload->>'uid' end;
      select data into old from records where collection='users' and id=ident for update;
      if op in ('create','update') then
        uname:=lower(trim(payload->>'username')); display:=trim(payload->>'displayName');
        if uname is null or uname !~ '^[a-z0-9][a-z0-9._-]{0,63}$' or uname='hpham' or position('..' in uname)>0 or display is null or char_length(display) not between 1 and 80 then raise exception 'Invalid user'; end if;
        perform pg_advisory_xact_lock(hashtextextended(uname,1));
        if exists(select 1 from records where collection='users' and data->>'username'=uname and id<>ident) then raise exception 'Username already exists'; end if;
        if op='create' then insert into records values('users',ident,jsonb_build_object('username',uname,'displayName',display,'active',true,'createdAt',tick));
        else
          if old is null then raise exception 'User not found'; end if;
          update records set data=data||jsonb_build_object('username',uname,'displayName',display) where collection='users' and id=ident;
          if old->>'username'<>uname then delete from sessions where sessions.uid=ident; end if;
        end if;
      elsif op='deactivate' then
        update records set data=data||jsonb_build_object('active',coalesce((payload->>'active')::boolean,false)) where collection='users' and id=ident;
        delete from sessions where sessions.uid=ident;
      else raise exception 'Invalid operation'; end if;
      return jsonb_build_object('uid',ident);
    elsif action='registerDevice' then
      if payload->>'label' is null or char_length(trim(payload->>'label')) not between 1 and 80 then raise exception 'Invalid device label'; end if;
      ident:=gen_random_uuid()::text; secret:=encode(gen_random_bytes(32),'base64');
      insert into records values('devices',ident,jsonb_build_object('label',trim(payload->>'label'),'secret',secret,'active',true,'createdAt',tick));
      return jsonb_build_object('deviceId',ident,'secret',secret,'label',payload->>'label','allowedOrigins',jsonb_build_array('https://ticket.th.io.vn'));
    elsif action='listDevices' then
      select coalesce(jsonb_agg((data-'secret')||jsonb_build_object('id',id)),'[]') into rows from records where collection='devices'; return jsonb_build_object('devices',rows);
    elsif action='revokeDevice' then
      update records set data=data||'{"active":false}' where collection='devices' and id=payload->>'id'; delete from sessions where device_id=payload->>'id'; return '{"ok":true}';
    elsif action in ('deleteIssue','finishDelete') then
      ident:=payload->>'id';
      if action='deleteIssue' then
        update records set data=data||'{"deleting":true}' where collection='issues' and id=ident;
        return '{"ok":true}';
      end if;
      delete from records where (collection='issues' and id=ident) or collection='issues/'||ident||'/timeline'; return '{"ok":true}';
    elsif action in ('updateIssue','addComment') then
      ident:=coalesce(payload->>'id',payload->>'issueId');
      select data into old from records where collection='issues' and id=ident for update;
      if old is null or coalesce((old->>'deleting')::boolean,false) then raise exception 'Issue unavailable'; end if;
      changes:=jsonb_build_object('updatedAt',tick); ev:='{}';
      if action='addComment' then
        message:=trim(payload->>'text'); kind:='comment';
        if message is null or char_length(message) not between 1 and 3000 then raise exception 'Invalid comment'; end if;
      elsif op='edit' then
        if not(payload ?& array['subject','process','description']) or char_length(trim(payload->>'subject')) not between 1 and 160 or char_length(trim(payload->>'process')) not between 1 and 120 or char_length(trim(payload->>'description')) not between 10 and 5000 then raise exception 'Invalid feedback details'; end if;
        changes:=changes||jsonb_build_object('subject',trim(payload->>'subject'),'process',trim(payload->>'process'),'description',trim(payload->>'description'));
        ev:=jsonb_build_object('before',jsonb_build_object('subject',old->'subject','process',old->'process','description',old->'description'),'after',changes-'updatedAt');
        kind:='edit'; message:='Owner edited the feedback details.';
      elsif op='handling' then
        if payload->>'status' is null or not(payload->>'status'=any(allowed)) or payload->>'priority' is null or payload->>'priority' not in ('Low','Medium','High','Critical') or char_length(coalesce(payload->>'assessment',''))>3000 or char_length(coalesce(payload->>'note',''))>500 then raise exception 'Invalid handling fields'; end if;
        changes:=changes||jsonb_build_object('status',payload->>'status','priority',payload->>'priority','assessment',coalesce(payload->>'assessment',''));
        if payload->>'status' in ('Resolved','Closed') then changes:=changes||jsonb_build_object('resolvedAt',coalesce((old->>'resolvedAt')::bigint,tick)); else old:=old-'resolvedAt'; end if;
        kind:='handling'; message:='Status: '||(old->>'status')||' → '||(payload->>'status')||'. Priority: '||(old->>'priority')||' → '||(payload->>'priority')||'. '||coalesce(payload->>'note','')||E'\nAssessment: '||coalesce(payload->>'assessment','');
      else raise exception 'Invalid operation'; end if;
      update records set data=old||changes where collection='issues' and id=ident;
    else raise exception 'Unknown action'; end if;
  end if;
  insert into records values('issues/'||ident||'/timeline',gen_random_uuid()::text,coalesce(ev,'{}')||jsonb_build_object('kind',kind,'text',message,'authorUid',uid,'author',who->>'displayName','createdAt',tick));
  return jsonb_build_object('id',ident,'uploadSlots',slots,'ok',true);
end $$;
-- No storage.objects browser policies: Edge issues scoped, short-lived signed URLs.
