-- Add stable public identifiers without rewriting existing issue/history JSON.
create table public.ticket_codes (
 issue_id text primary key, month_key text not null, ordinal integer not null check(ordinal between 1 and 99),
 code text not null unique, unique(month_key,ordinal)
);
create table ticket_private.ticket_months(month_key text primary key, allocated integer not null check(allocated between 1 and 99));
with numbered as (
 select id,to_char(to_timestamp(coalesce((data->>'createdAt')::numeric,extract(epoch from now())*1000)/1000) at time zone 'Asia/Ho_Chi_Minh','YYMM') month_key,
 row_number() over(partition by to_char(to_timestamp(coalesce((data->>'createdAt')::numeric,extract(epoch from now())*1000)/1000) at time zone 'Asia/Ho_Chi_Minh','YYMM') order by (data->>'createdAt')::numeric nulls last,seq,id) ordinal
 from ticket_private.records where collection='issues'
)
insert into public.ticket_codes select id,month_key,ordinal,'TH'||month_key||'-'||lpad(ordinal::text,2,'0') from numbered where ordinal<=99;
insert into ticket_private.ticket_months select month_key,max(ordinal) from public.ticket_codes group by month_key;
create function ticket_private.assign_ticket_number() returns trigger language plpgsql security definer set search_path=ticket_private,pg_temp as $$
declare month_value text:=to_char(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh','YYMM'); n integer;
begin
 if new.collection<>'issues' then return new;end if;
 insert into ticket_months values(month_value,1) on conflict(month_key) do update set allocated=ticket_months.allocated+1 where ticket_months.allocated<99 returning allocated into n;
 if n is null then raise exception using errcode='P0099',message='This month has reached the limit of 99 tickets. Please try again next month.';end if;
 insert into public.ticket_codes values(new.id,month_value,n,'TH'||month_value||'-'||lpad(n::text,2,'0'));
 return new;
end $$;
create trigger ticket_number after insert on ticket_private.records for each row execute function ticket_private.assign_ticket_number();
grant select on public.ticket_codes to th_api;
create function ticket_private.ticket_number_result(action text,payload jsonb,result jsonb) returns jsonb language plpgsql security definer set search_path=ticket_private,pg_temp as $$
declare item jsonb; output jsonb:='[]'; code_value text; snapshots jsonb:='{}'; k text;
begin
 if action='readBundle' then
  for k,item in select * from jsonb_each(result->'snapshots') loop snapshots:=snapshots||jsonb_build_object(k,ticket_private.ticket_number_result('read',jsonb_build_object('path',k),item));end loop;
  return result||jsonb_build_object('snapshots',snapshots);
 elsif action='read' and payload->>'path' in ('issues','myIssues') then
  for item in select value from jsonb_array_elements(result->'rows') loop
   select code into code_value from public.ticket_codes where issue_id=item->>'id';
   output:=output||jsonb_build_array(item||jsonb_build_object('ticketNumber',code_value));
  end loop;
  return result||jsonb_build_object('rows',output);
 elsif action in ('createIssue','readTicket') then
  select code into code_value from public.ticket_codes where issue_id=result->>'id';
  return result||jsonb_build_object('ticketNumber',code_value);
 end if;
 return result;
end $$;
alter function public.ticket_dispatch(text,jsonb,jsonb) rename to dispatch_before_ticket_numbers;
alter function public.dispatch_before_ticket_numbers(text,jsonb,jsonb) set schema ticket_private;
create function public.ticket_dispatch(action text,payload jsonb,actor jsonb default '{}'::jsonb) returns jsonb language sql security definer set search_path=ticket_private,pg_temp as $$
 select ticket_private.ticket_number_result(action,payload,ticket_private.dispatch_before_ticket_numbers(action,payload,actor));
$$;
alter function public.ticket_view(text,jsonb) rename to view_before_ticket_numbers;
alter function public.view_before_ticket_numbers(text,jsonb) set schema ticket_private;
-- Recursive readBundle in the older facade resolves this wrapper at runtime.
create function public.ticket_view(action text,payload jsonb default '{}'::jsonb) returns jsonb language sql security definer set search_path=ticket_private,pg_temp as $$
 select ticket_private.ticket_number_result(action,payload,ticket_private.view_before_ticket_numbers(action,payload));
$$;
