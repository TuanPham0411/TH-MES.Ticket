// Run as postgres, never as the runtime role. Each migration is transactional.
import pg from 'pg';
import {readdir,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
const migrationRoot=join(dirname(process.argv[1]),'migrations');
async function main() {
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const client=await pool.connect();
try {
 await client.query('select pg_advisory_lock(74529081)');
 await client.query('create table if not exists public.schema_migrations(name text primary key)');
 for(const name of (await readdir(migrationRoot)).filter(f=>f.endsWith('.sql')).sort()) {
  if((await client.query('select 1 from public.schema_migrations where name=$1',[name])).rowCount)continue;
  await client.query('begin');
  try{await client.query(await readFile(join(migrationRoot,name),'utf8'));await client.query('insert into public.schema_migrations values($1)',[name]);await client.query('commit');}
  catch(e){await client.query('rollback');throw e;}
 }
 await client.query(`revoke all on schema ticket_private from public;
 revoke all on all tables in schema ticket_private from public,th_api;
 revoke execute on all functions in schema ticket_private from public,th_api;
 revoke execute on all functions in schema public from public,th_api;
 grant execute on function public.ticket_dispatch(text,jsonb,jsonb),public.ticket_google_owner_session(),public.ticket_view(text,jsonb),public.ticket_notifications_tick(timestamptz) to th_api;
 grant usage on schema public,portfolio,extensions to th_api;
 grant select,insert,update,delete on all tables in schema portfolio to th_api;
 grant select,insert,update,delete on public.files,public.file_grants to th_api;`);
}finally{await client.query('select pg_advisory_unlock(74529081)');client.release();await pool.end();}

}
main().catch(e=>{console.error(e);process.exitCode=1;});
