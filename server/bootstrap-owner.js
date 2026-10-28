// Local operator command only; never exposed through HTTP or run during deploy.
import pg from 'pg';
import {runtimeSites} from './sites.js';
async function main(){
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
try {
 const {rows:[row]}=await pool.query('select public.mes_issue_owner_activation() result');
 if(!row.result.activationCode){console.log('The owner is already activated. No credentials were changed.');}
 else console.log('Private owner activation link (expires in 72 hours):\n'+runtimeSites().mes+'/#'+new URLSearchParams({activate:row.result.activationCode,username:'hpham'}));
} catch {console.error('Owner bootstrap failed. Use the migration/operator database connection after migrations.');process.exitCode=1;}
finally{await pool.end();}

}
main();
