import {downloadFile} from './th-storage/client.mjs';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {baseline,restore,operatorBroker,verifyWriteThrough} from './th-storage/operator.mjs';
async function main(){
const db=new pg.Client({connectionString:process.env.DATABASE_URL,options:'-c th_storage.authorized=1'});
await db.connect();
try{
 const action=process.argv[2];
 if(action==='install'){await db.query(await readFile(join(dirname(process.argv[1]),'storage-capture.sql'),'utf8'));console.log('Storage capture installed');}
 else if(action==='baseline')console.log(JSON.stringify(await baseline(db,operatorBroker('ticket'))));
 else if(action==='probe'){const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});try{console.log(JSON.stringify(await verifyWriteThrough(pool,operatorBroker('ticket'))));}finally{await pool.end();}}
 else if(action==='restore-empty')console.log(JSON.stringify(await restore(db,operatorBroker('ticket'),{confirmEmpty:true,restoreFile:file=>downloadFile({application:'ticket',socketPath:process.env.TH_STORAGE_SOCKET,token:process.env.TH_STORAGE_TOKEN},file,process.env.FILES_ROOT||'/data/files')})));
 else throw Error('Choose install, baseline or restore-empty');
}finally{await db.end();}

}
main().catch(()=>{console.error('Storage operator failed; production data retained. Check broker availability, identity and recovery target.');process.exitCode=1;});
