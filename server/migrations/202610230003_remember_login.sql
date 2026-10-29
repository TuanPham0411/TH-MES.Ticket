-- Explicitly remembered password sessions last 30 days. Existing revocation,
-- account-state and credential-revision checks still apply on every request.
alter function public.ticket_dispatch(text,jsonb,jsonb) rename to dispatch_before_remember_login;
alter function public.dispatch_before_remember_login(text,jsonb,jsonb) set schema ticket_private;
create function public.ticket_dispatch(action text,payload jsonb,actor jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=ticket_private,extensions,pg_temp as $$
declare result jsonb;
begin
 result:=ticket_private.dispatch_before_remember_login(action,payload,actor);
 if action='passwordLogin' and result ? 'sessionToken' then
  if payload->'remember'='true'::jsonb then
   update sessions set expires_at=now()+interval '30 days' where hash=encode(digest(result->>'sessionToken','sha256'),'hex');
   result:=result||jsonb_build_object('sessionMaxAgeSeconds',2592000);
  else
   result:=result||jsonb_build_object('sessionMaxAgeSeconds',43200);
  end if;
 end if;
 return result;
end $$;
