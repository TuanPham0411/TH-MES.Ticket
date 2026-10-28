-- First-party visit records; anonymous visitors use an expiring random session.
create table portfolio.visits (
 id uuid primary key default extensions.gen_random_uuid(),
 visitor_hash text not null, uid text references portfolio.users(id) on delete set null,
 account_name text not null default '', account_email text not null default '',
 role text not null check(role in ('viewer','user','admin')),
 path text not null, referrer text not null default '', browser text not null default '',
 created_at timestamptz not null default now(), last_seen timestamptz not null default now()
);
create index portfolio_visits_time on portfolio.visits(created_at desc,id);
create index portfolio_visits_user on portfolio.visits(uid,created_at desc);
create index portfolio_visits_session on portfolio.visits(visitor_hash,created_at desc);
