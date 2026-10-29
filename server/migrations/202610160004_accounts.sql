-- Admin-provisioned accounts, single-use activation and private self profiles.
create table if not exists ticket_private.credentials (
 uid text primary key, password_hash text, activation_hash text,
 activation_expires timestamptz, revision int not null default 0,
 role text not null default 'user' check(role in ('owner','user'))
);
alter table ticket_private.credentials enable row level security;
alter table ticket_private.sessions add column if not exists auth_method text not null default 'legacy';
alter table ticket_private.sessions add column if not exists credential_version int not null default 0;
create or replace function ticket_private.open_account_session(account_uid text) returns jsonb
language plpgsql security definer set search_path=ticket_private,extensions,pg_temp as $$
declare value text; version int; uname text;
begin
 select revision into version from credentials where uid=account_uid;
 select data->>'username' into uname from records where collection='users' and id=account_uid;
 if version is null or uname is null then raise exception 'Account unavailable'; end if;
 value:=encode(gen_random_bytes(32),'hex');
 delete from sessions where uid=account_uid and expires_at<now();
 insert into sessions(hash,uid,username,expires_at,auth_method,credential_version)
 values(encode(digest(value,'sha256'),'hex'),account_uid,uname,now()+interval '12 hours','password',version);
 return jsonb_build_object('sessionToken',value);
end $$;
create or replace function ticket_private.issue_account_activation(account_uid text) returns jsonb
language plpgsql security definer set search_path=ticket_private,extensions,pg_temp as $$
declare value text; uname text;
begin
 select data->>'username' into uname from records where collection='users' and id=account_uid;
 if uname is null then raise exception 'Account unavailable'; end if;
 value:=encode(gen_random_bytes(32),'hex');
 insert into credentials(uid,activation_hash,activation_expires) values(account_uid,encode(digest(value,'sha256'),'hex'),now()+interval '72 hours')
 on conflict(uid) do update set password_hash=null,activation_hash=excluded.activation_hash,activation_expires=excluded.activation_expires,revision=credentials.revision+1;
 update records set data=data||jsonb_build_object('accountState','pending') where collection='users' and id=account_uid;
 delete from sessions where uid=account_uid;
 return jsonb_build_object('uid',account_uid,'username',uname,'activationCode',value,'expiresHours',72);
end $$;
insert into ticket_private.records(collection,id,data) values('users','ticket-owner','{"username":"hpham","displayName":"Ticket Owner","active":true,"accountState":"pending"}') on conflict(collection,id) do nothing;
insert into ticket_private.credentials(uid,role) values('ticket-owner','owner') on conflict(uid) do nothing;
create or replace function public.ticket_issue_owner_activation() returns jsonb
language plpgsql security definer set search_path=ticket_private,extensions,pg_temp as $$
begin
 perform 1 from credentials where uid='ticket-owner' and role='owner' and password_hash is null for update;
 if not found then return '{"username":"hpham","status":"already-activated"}'; end if;
 return ticket_private.issue_account_activation('ticket-owner');
end $$;

DO $accounts_upgrade$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('public.ticket_dispatch(text,jsonb,jsonb)'::regprocedure);
 IF position('Account lifecycle v1' in definition)=0 THEN
  IF position($before$  if own and actor->>'tester'='true' then
    uid:='ticket-tester';
    select data into u from records where collection='users' and id=uid;
    if not coalesce((u->>'active')::boolean,false) or not coalesce((u->>'isTester')::boolean,false) then raise exception 'Tester unavailable'; end if;
    own:=false; verified:=true;
  end if;
$before$ in definition)=0 THEN RAISE EXCEPTION 'Ticket dispatcher differs; run full installer'; END IF;
  definition:=replace(definition,$before$  if own and actor->>'tester'='true' then
    uid:='ticket-tester';
    select data into u from records where collection='users' and id=uid;
    if not coalesce((u->>'active')::boolean,false) or not coalesce((u->>'isTester')::boolean,false) then raise exception 'Tester unavailable'; end if;
    own:=false; verified:=true;
  end if;
$before$,$after$$after$);
  IF position($before$  if not own and actor ? 'session' then
    select * into sess from sessions where hash=encode(digest(actor->>'session','sha256'),'hex') and expires_at>now();
    if found then
      uid:=sess.uid;
      select data into u from records where collection='users' and id=uid;
      if (u->>'active')::boolean and u->>'username'=sess.username then
        verified := not win or (sess.device_id is not null and exists(select 1 from records where collection='devices' and id=sess.device_id and (data->>'active')::boolean));
      end if;
    end if;
  end if;$before$ in definition)=0 THEN RAISE EXCEPTION 'Ticket dispatcher differs; run full installer'; END IF;
  definition:=replace(definition,$before$  if not own and actor ? 'session' then
    select * into sess from sessions where hash=encode(digest(actor->>'session','sha256'),'hex') and expires_at>now();
    if found then
      uid:=sess.uid;
      select data into u from records where collection='users' and id=uid;
      if (u->>'active')::boolean and u->>'username'=sess.username then
        verified := not win or (sess.device_id is not null and exists(select 1 from records where collection='devices' and id=sess.device_id and (data->>'active')::boolean));
      end if;
    end if;
  end if;$before$,$after$  if not own and actor ? 'session' then
    select * into sess from sessions where hash=encode(digest(actor->>'session','sha256'),'hex') and expires_at>now() and auth_method='password';
    if found then
      uid:=sess.uid;
      select data into u from records where collection='users' and id=uid;
      if coalesce((u->>'active')::boolean,false) and u->>'username'=sess.username and not coalesce((u->>'isTester')::boolean,false) then
        select jsonb_build_object('revision',revision,'role',role) into r from credentials where credentials.uid=sess.uid and password_hash is not null;
        verified := r is not null and (r->>'revision')::int=sess.credential_version;
        own := verified and uid='ticket-owner' and r->>'role'='owner';
        if own then actor:=actor||jsonb_build_object('name',u->>'displayName'); end if;
      end if;
    end if;
  end if;
  if own and actor->>'tester'='true' then
    uid:='ticket-tester';
    select data into u from records where collection='users' and id=uid;
    if not coalesce((u->>'active')::boolean,false) or not coalesce((u->>'isTester')::boolean,false) then raise exception 'Tester unavailable'; end if;
    own:=false; verified:=true;
  end if;
$after$);
  IF position($before$  select coalesce((data->>'requiresWindows')::boolean,true) into win from records where collection='settings' and id='policy';$before$ in definition)=0 THEN RAISE EXCEPTION 'Ticket dispatcher differs; run full installer'; END IF;
  definition:=replace(definition,$before$  select coalesce((data->>'requiresWindows')::boolean,true) into win from records where collection='settings' and id='policy';$before$,$after$  -- Account lifecycle v1. Public operations return generic failures without leaking account existence.
  if action in ('startWindowsChallenge','completeWindowsChallenge','loginManagedUser') then raise exception 'Legacy sign-in disabled'; end if;
  if action in ('passwordLogin','activateAccount') then
    uname:=lower(trim(payload->>'username'));
    if uname is null or uname !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then return '{"errorCode":"invalid-credentials"}'; end if;
    perform pg_advisory_xact_lock(hashtextextended('login:'||uname,0));
    select data into r from records where collection='loginRates' and id=uname;
    if r is null or tick-coalesce((r->>'windowStart')::bigint,0)>=900000 then r:=jsonb_build_object('windowStart',tick,'count',0); end if;
    if (r->>'count')::int>=10 then return '{"errorCode":"rate-limited"}'; end if;
    insert into records(collection,id,data) values('loginRates',uname,r||jsonb_build_object('count',(r->>'count')::int+1)) on conflict(collection,id) do update set data=excluded.data;
    select id,data into uid,u from records where collection='users' and data->>'username'=uname for update;
    if uid is null or not coalesce((u->>'active')::boolean,false) or coalesce((u->>'isTester')::boolean,false) then return '{"errorCode":"invalid-credentials"}'; end if;
    select jsonb_build_object('passwordHash',password_hash,'activationHash',activation_hash,'expiresAt',extract(epoch from activation_expires)*1000,'revision',revision) into d from credentials where credentials.uid=ticket_account.uid for update;
    if d is null then return '{"errorCode":"invalid-credentials"}'; end if;
    if action='activateAccount' then
      if coalesce(payload->>'activationCode','') !~ '^[a-f0-9]{64}$' or d->>'activationHash' is null or (d->>'expiresAt')::numeric<tick or d->>'activationHash'<>encode(digest(payload->>'activationCode','sha256'),'hex') then return '{"errorCode":"invalid-credentials"}'; end if;
      if jsonb_typeof(payload->'password') is distinct from 'string' or char_length(payload->>'password')<10 or octet_length(payload->>'password')>72 then return '{"errorCode":"password-policy"}'; end if;
      update credentials set password_hash=crypt(payload->>'password',gen_salt('bf',10)),activation_hash=null,activation_expires=null,revision=revision+1 where credentials.uid=ticket_account.uid;
      update records set data=data||jsonb_build_object('accountState','ready','updatedAt',tick) where collection='users' and id=uid;
      delete from sessions where sessions.uid=ticket_account.uid;
    else
      if d->>'passwordHash' is null or jsonb_typeof(payload->'password') is distinct from 'string' or octet_length(payload->>'password')>72 or crypt(payload->>'password',d->>'passwordHash')<>d->>'passwordHash' then return '{"errorCode":"invalid-credentials"}'; end if;
    end if;
    delete from records where collection='loginRates' and id=uname;
    return ticket_private.open_account_session(uid);
  end if;
  select coalesce((data->>'requiresWindows')::boolean,true) into win from records where collection='settings' and id='policy';$after$);
  IF position($before$  if action='getSession' then$before$ in definition)=0 THEN RAISE EXCEPTION 'Ticket dispatcher differs; run full installer'; END IF;
  definition:=replace(definition,$before$  if action='getSession' then$before$,$after$  if action='getProfile' then return jsonb_build_object('profile',who,'isOwner',own); end if;
  if action='saveProfile' then
    if who->>'isTester'='true' then raise exception 'Tester profile is read only'; end if;
    if jsonb_typeof(payload->'displayName') is distinct from 'string' or char_length(trim(payload->>'displayName')) not between 1 and 80 or char_length(coalesce(payload->>'email',''))>160 or char_length(coalesce(payload->>'phone',''))>32 or char_length(coalesce(payload->>'jobTitle',''))>80 then raise exception 'Invalid profile'; end if;
    select data into u from records where collection='users' and id=uid for update;
    if u is null then insert into records(collection,id,data) values('users',uid,jsonb_build_object('username',who->>'username','displayName',who->>'displayName','active',true)); end if;
    update records set data=data||jsonb_build_object('displayName',trim(payload->>'displayName'),'email',coalesce(payload->>'email',''),'phone',coalesce(payload->>'phone',''),'jobTitle',coalesce(payload->>'jobTitle',''),'updatedAt',tick) where collection='users' and id=uid;
    return '{"ok":true}';
  end if;
  if action='changePassword' then
    if who->>'isTester'='true' then raise exception 'Tester cannot change credentials'; end if;
    perform pg_advisory_xact_lock(hashtextextended('password-change:'||uid,0));
    select data into r from records where collection='passwordRates' and id=uid;
    if r is null or tick-coalesce((r->>'windowStart')::bigint,0)>=900000 then r:=jsonb_build_object('windowStart',tick,'count',0); end if;
    if (r->>'count')::int>=10 then return '{"errorCode":"rate-limited"}'; end if;
    insert into records(collection,id,data) values('passwordRates',uid,r||jsonb_build_object('count',(r->>'count')::int+1)) on conflict(collection,id) do update set data=excluded.data;
    select password_hash into secret from credentials where credentials.uid=ticket_account.uid for update;
    if secret is null or payload->>'currentPassword' is null or octet_length(payload->>'currentPassword')>72 or crypt(payload->>'currentPassword',secret)<>secret then return '{"errorCode":"invalid-credentials"}'; end if;
    if jsonb_typeof(payload->'password') is distinct from 'string' or char_length(payload->>'password')<10 or octet_length(payload->>'password')>72 then return '{"errorCode":"password-policy"}'; end if;
    delete from records where collection='passwordRates' and id=uid;
    update credentials set password_hash=crypt(payload->>'password',gen_salt('bf',10)),revision=revision+1 where credentials.uid=ticket_account.uid;
    delete from sessions where sessions.uid=ticket_account.uid;
    return ticket_private.open_account_session(uid);
  end if;
  if action='resetUserActivation' then
    if not own then raise exception 'Only owner can reset accounts'; end if;
    ident:=payload->>'uid';
    if ident in ('ticket-owner','ticket-tester') or ident=uid then raise exception 'Reserved account'; end if;
    select data into u from records where collection='users' and id=ident for update;
    if u is null or not coalesce((u->>'active')::boolean,false) then raise exception 'User unavailable'; end if;
    return ticket_private.issue_account_activation(ident);
  end if;
  if action='read' and payload->>'path'='myIssues' then
    select coalesce(jsonb_agg(data||jsonb_build_object('id',id) order by (data->>'updatedAt')::bigint desc),'[]') into rows from records where collection='issues' and (data->>'reporterUid'=uid or (own and data->>'reporterUsername'='hpham')) and not coalesce((data->>'deleting')::boolean,false);
    return jsonb_build_object('rows',rows);
  end if;
  if action='manageUser' and not own then raise exception 'Only owner can manage accounts'; end if;
  if action='manageUser' and op='create' then
    uname:=lower(trim(payload->>'username'));display:=coalesce(nullif(trim(payload->>'displayName'),''),uname);
    if uname is null or uname !~ '^[a-z0-9][a-z0-9._-]{0,63}$' or position('..' in uname)>0 or uname in ('hpham','ticket.tester') or char_length(display)>80 then raise exception 'Invalid username'; end if;
    perform pg_advisory_xact_lock(hashtextextended(uname,1));
    if exists(select 1 from records where collection='users' and data->>'username'=uname) then raise exception 'Username already exists'; end if;
    ident:=gen_random_uuid()::text;
    insert into records(collection,id,data) values('users',ident,jsonb_build_object('username',uname,'displayName',display,'active',true,'createdAt',tick,'accountState','pending'));
    return ticket_private.issue_account_activation(ident);
  end if;
  if action='manageUser' and op='update' then
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
  if action='manageUser' and op='deactivate' and payload->>'uid'='ticket-owner' then raise exception 'Reserved owner account'; end if;
  if action='getSession' then$after$);
  IF position($before$  if action='getDirectory' then$before$ in definition)=0 THEN RAISE EXCEPTION 'Ticket dispatcher differs; run full installer'; END IF;
  definition:=replace(definition,$before$  if action='getDirectory' then$before$,$after$  if action='getDirectory' then return '{"users":[],"requiresWindows":false,"accountMode":"password","accountVersion":1}'; end if;
  if action='getDirectory' then$after$);
  definition:=replace(definition,'win := coalesce(win,true);','win := false;');
  definition:=replace(definition,$before$if own then who:=jsonb_build_object('uid',uid,'username','hpham','displayName',coalesce(actor->>'name','Ticket Owner'),'owner',true);$before$,$after$if own then
    select data into u from records where collection='users' and id=uid;
    who:=coalesce(u,'{}')||jsonb_build_object('uid',uid,'username','hpham','displayName',coalesce(u->>'displayName',actor->>'name','Ticket Owner'),'owner',true);$after$);
  definition:=replace(definition,E'declare\n',E'<<ticket_account>>\ndeclare\n');
  definition:=replace(definition,$before$if who is null then raise exception 'Access denied. Verify your Windows identity again'; end if;$before$,$after$if who is null then raise exception 'Session expired or account inactive' using errcode='28000'; end if;$after$);
  definition:=replace(definition,$before$jsonb_build_object('user',who,'isOwner',own,'requiresWindows',win)$before$,$after$jsonb_build_object('user',who,'isOwner',own,'requiresWindows',false,'accountVersion',1)$after$);
  EXECUTE definition;
 END IF;
END
$accounts_upgrade$;
