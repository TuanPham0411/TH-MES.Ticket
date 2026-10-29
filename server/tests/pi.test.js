import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {createApp} from '../index.js';
import {actorFor,validPath,hash} from '../security.js';
const url=process.env.TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('_test'))throw new Error('TEST_DATABASE_URL must point at a disposable database ending in _test');
const pool=new pg.Pool({connectionString:url,max:4});
let server,base,files,runtimePool;
before(async()=>{
 await pool.query("do $$ begin if not exists(select 1 from pg_roles where rolname='th_api') then create role th_api; end if; end $$;");
 // Exercise the upgrade against data written by the previous release.
 await pool.query('create table if not exists public.schema_migrations(name text primary key)');
 for(const name of (await readdir('server/migrations')).filter(n=>n.endsWith('.sql')&&n<'202610210001_workspace_upgrade.sql').sort()) {
  if((await pool.query('select 1 from public.schema_migrations where name=$1',[name])).rowCount)continue;
  await pool.query(await readFile('server/migrations/'+name,'utf8'));
  await pool.query('insert into public.schema_migrations values($1)',[name]);
 }
 const historical={subject:'Lịch sử trước nâng cấp',description:'Nội dung và liên kết gốc',attachments:[{path:'issues/preserved/slot-original'}],status:'In progress',createdAt:1700000000000,progress:47};
 const event={kind:'handling',text:'Ghi chú cũ giữ nguyên',author:'Existing user',createdAt:1700000001000};
 await pool.query("insert into mes_private.records(collection,id,data) values('issues','preserved-upgrade-test',$1),('issues/preserved-upgrade-test/timeline','old-event',$2)",[historical,event]);
 await pool.query("insert into mes_private.records(collection,id,data) values('issues','boundary-before',$1),('issues','boundary-after',$2)",[{createdAt:Date.parse('2025-12-31T16:59:59Z'),description:'Before VN new year'},{createdAt:Date.parse('2025-12-31T17:00:00Z'),description:'After VN new year'}]);
 const beforeUpgrade=(await pool.query("select collection,id,data from mes_private.records where id in ('preserved-upgrade-test','old-event') order by collection,id")).rows;
 const result=spawnSync(process.execPath,['server/migrate.js'],{env:{...process.env,DATABASE_URL:url},encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const twice=spawnSync(process.execPath,['server/migrate.js'],{env:{...process.env,DATABASE_URL:url},encoding:'utf8'});assert.equal(twice.status,0,twice.stderr);
 assert.deepEqual((await pool.query("select collection,id,data from mes_private.records where id in ('preserved-upgrade-test','old-event') order by collection,id")).rows,beforeUpgrade,'Upgrade must preserve existing ticket data and history exactly');
 const boundary=(await pool.query("select issue_id,code from public.mes_ticket_codes where issue_id in ('boundary-before','boundary-after') order by issue_id")).rows;
 assert.deepEqual(boundary,[{issue_id:'boundary-after',code:'TH2601-01'},{issue_id:'boundary-before',code:'TH2512-01'}],'Backfill uses Vietnam calendar months and resets across December/January');
 await pool.query("delete from mes_private.records where id in ('preserved-upgrade-test','old-event','boundary-before','boundary-after')");
 files=await mkdtemp(join(tmpdir(),'th-api-'));runtimePool=new pg.Pool({connectionString:url,options:'-c role=th_api'});server=createApp(runtimePool,files).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await runtimePool.end();await pool.end();await rm(files,{recursive:true,force:true});});
async function api(name,data={},cookie='',host='ticket.th.io.vn',extra={}) {
 if(name==='createIssue'&&data.occurrences===undefined)data={...data,occurrences:[{kind:'point',start:new Date().toISOString()}]};
 if(name==='createIssue'&&data.evidence===undefined)data={...data,evidence:[{name:'evidence.png',type:'image/png',size:100}]};
 const response=await fetch(base+(host==='th.io.vn'?'/api/portfolio':'/api/mes'),{method:'POST',headers:{'x-forwarded-host':host,'Content-Type':'application/json',cookie,...extra},body:JSON.stringify(host==='th.io.vn'?{action:name,data}:{name,data})});
 const text=await response.text();let body;try{body=JSON.parse(text);}catch{body=text;}
 return {status:response.status,body,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
}
async function verifiedPhoto(issue,cookie,index=0){
 const path=`issues/${issue.id}/${issue.uploadSlots[index]}`,extra={'x-forwarded-for':'192.0.2.85'};
 const grant=await api('uploadUrl',{path},cookie,'ticket.th.io.vn',extra);assert.equal(grant.status,200,JSON.stringify(grant.body));
 const put=await fetch(base+grant.body.url,{method:'PUT',headers:{'x-forwarded-host':'ticket.th.io.vn',...extra,'Content-Type':'image/png'},body:Buffer.from('verified-test-image')});assert.equal(put.status,200);
 const attached=await api('attachFiles',{issueId:issue.id,files:[{slot:issue.uploadSlots[index],name:'evidence.png'}]},cookie,'ticket.th.io.vn',extra);assert.equal(attached.status,200,JSON.stringify(attached.body));assert.equal(attached.body.published,true);
}
test('public clients cannot inject owner claims or traverse files',async()=>{
 assert.deepEqual(actorFor(null,'true'),{tester:true});
 assert.equal(validPath('issues/../secret'),false);
 assert.equal((await api('getDirectory')).status,200);
 assert.equal((await api('manageUser',{owner:true,operation:'create',username:'attacker',displayName:'Attack'})).status,401);
 assert.equal((await api('getDirectory',{},'','ticket.th.io.vn',{origin:'https://evil.test'})).status,403);
 const result=await api('getDirectory');assert.deepEqual(result.body.users,[]);
});
test('MES activation, CRUD, private files, tester restrictions, revocation',async()=>{
 const {rows:[activation]}=await pool.query('select public.mes_issue_owner_activation() as result');
 const login=await api('activateAccount',{username:'hpham',activationCode:activation.result.activationCode,password:'test-owner-password'});
 assert.equal(login.status,200,JSON.stringify(login.body));assert.ok(login.cookie);assert.equal(login.body.sessionToken,undefined);assert.match(login.headers.get('set-cookie'),/HttpOnly/);assert.match(login.headers.get('set-cookie'),/Secure/);
 const owner=login.cookie;
 assert.equal((await api('activateAccount',{username:'hpham',activationCode:activation.result.activationCode,password:'test-owner-password'})).status,401);
 const created=await api('manageUser',{operation:'create',username:'pi.user',displayName:'Pi User'},owner);assert.equal(created.status,200,JSON.stringify(created.body));
 const userLogin=await api('activateAccount',{username:'pi.user',activationCode:created.body.activationCode,password:'test-user-password'});assert.equal(userLogin.status,200);
 const user=userLogin.cookie;
 assert.equal((await api('manageUser',{operation:'create',username:'bad.user'},user)).status,403);
 const tl=await api('manageDirectory',{type:'teamLeaders',operation:'create',name:'Leader'},owner);
 const dept=await api('manageDirectory',{type:'departments',operation:'create',name:'Production'},owner);
 const issue=await api('createIssue',{subject:'Pi integration feedback',process:'Line 1',description:'A meaningful feedback description.',teamLeaderId:tl.body.id,departmentId:dept.body.id,reporterUid:created.body.uid},user);
 assert.equal(issue.status,200,JSON.stringify(issue.body));
 const path=`issues/${issue.body.id}/${issue.body.uploadSlots[0]}`;
 const grant=await api('uploadUrl',{path},user);assert.equal(grant.status,200);
 const put=await fetch(base+grant.body.url,{method:'PUT',headers:{'x-forwarded-host':'ticket.th.io.vn','Content-Type':'text/plain'},body:'attachment payload'});assert.equal(put.status,200,await put.text());
 assert.equal((await fetch(base+grant.body.url,{method:'PUT',headers:{'x-forwarded-host':'ticket.th.io.vn','Content-Type':'text/plain'},body:'overwrite'})).status,403);
 const attached=await api('attachFiles',{issueId:issue.body.id,files:[{slot:issue.body.uploadSlots[0],name:'sample.txt',size:99999,type:'image/png'}]},user);assert.equal(attached.status,200,JSON.stringify(attached.body));
 await verifiedPhoto(issue.body,user,1);
 const bundle=await api('read',{path:'issues'},user);const record=bundle.body.rows.find(r=>r.id===issue.body.id);assert.equal(record.attachments[0].size,18);assert.equal(record.attachments[0].type,'text/plain');
 const download=await api('downloadUrl',{path},user);assert.equal(download.status,200);assert.equal(await (await fetch(base+download.body.url,{headers:{'x-forwarded-host':'ticket.th.io.vn'}})).text(),'attachment payload');
 assert.equal((await api('uploadUrl',{path:'issues/../../etc/passwd'},user)).status,400);
 assert.equal((await api('deleteIssue',{id:issue.body.id},user)).status,403);
 assert.equal((await api('manageDirectory',{type:'departments',operation:'create',name:'Blocked'},owner,'ticket.th.io.vn',{'x-mes-tester':'true'})).status,403);
 assert.equal((await api('manageUser',{operation:'deactivate',uid:created.body.uid,active:false},owner)).status,200);
 assert.equal((await api('getSession',{},user)).status,401);
 assert.equal((await api('deleteIssue',{id:issue.body.id},owner)).status,200);
 assert.equal((await pool.query('select 1 from public.files where path=$1',[path])).rowCount,0);
 assert.equal((await api('logout',{},owner)).status,200);
 assert.equal((await api('getSession',{},owner)).status,401);
});
test('administrator edits, reissues and deletes accounts; self profile cannot elevate access',async()=>{
 const owner=(await api('passwordLogin',{username:'hpham',password:'test-owner-password'})).cookie;
 assert.ok(owner);
 const created=await api('manageUser',{operation:'create',username:'admin.lifecycle',displayName:'Lifecycle'},owner);
 assert.equal(created.status,200,JSON.stringify(created.body)); const uid=created.body.uid;
 const reissued=await api('resetUserActivation',{uid},owner); assert.equal(reissued.status,200,JSON.stringify(reissued.body));
 assert.notEqual(reissued.body.activationCode,created.body.activationCode);
 assert.equal((await api('activateAccount',{username:'admin.lifecycle',activationCode:created.body.activationCode,password:'test-user-password'})).status,401);
 const activated=await api('activateAccount',{username:'admin.lifecycle',activationCode:reissued.body.activationCode,password:'test-user-password'});
 assert.equal(activated.status,200); const user=activated.cookie;
 for (const name of ['manageUser','resetUserActivation']) assert.equal((await api(name,{operation:'delete',uid},user)).status,403);
 assert.equal((await api('saveProfile',{displayName:'Self edited',uid:'mes-owner',username:'hpham',owner:true,active:false,email:'self@example.com'},user)).status,200);
 const profile=(await api('getProfile',{},user)).body;assert.equal(profile.isOwner,false);assert.equal(profile.profile.username,'admin.lifecycle');assert.equal(profile.profile.active,true);
 const edited=await api('manageUser',{operation:'update',uid,username:'admin.renamed',displayName:'Admin edited',email:'edited@example.com',phone:'123',jobTitle:'Operator'},owner);
 assert.equal(edited.status,200,JSON.stringify(edited.body));assert.equal((await api('getProfile',{},user)).status,401);
 const signedIn=await api('passwordLogin',{username:'admin.renamed',password:'test-user-password'});assert.equal(signedIn.status,200);
 assert.equal((await api('getProfile',{},signedIn.cookie)).body.profile.jobTitle,'Operator');
 const reset=await api('resetUserActivation',{uid},owner);assert.equal(reset.status,200,JSON.stringify(reset.body));
 assert.equal((await api('getProfile',{},signedIn.cookie)).status,401);
 assert.equal((await api('passwordLogin',{username:'admin.renamed',password:'test-user-password'})).status,401);
 const next=await api('activateAccount',{username:'admin.renamed',activationCode:reset.body.activationCode,password:'new-user-password'});assert.equal(next.status,200);
 assert.equal((await api('manageUser',{operation:'deactivate',uid,active:false},owner)).status,200);
 assert.equal((await api('getProfile',{},next.cookie)).status,401);
 assert.equal((await api('manageUser',{operation:'deactivate',uid,active:true},owner)).status,200);
 await pool.query("insert into mes_private.records(collection,id,data) values('issues','deleted-account-history',$1)",[{reporterUid:uid,subject:'Preserve history'}]);
 const final=await api('passwordLogin',{username:'admin.renamed',password:'new-user-password'});assert.equal(final.status,200);
 assert.equal((await api('manageUser',{operation:'delete',uid},owner)).status,200);
 assert.equal((await api('getProfile',{},final.cookie)).status,401);
 assert.equal((await api('passwordLogin',{username:'admin.renamed',password:'new-user-password'})).status,401);
 for (const uid of ['mes-owner','mes-tester']) assert.equal((await api('manageUser',{operation:'delete',uid},owner)).status,403);
 assert.equal((await pool.query("select data->>'reporterUid' uid from mes_private.records where collection='issues' and id='deleted-account-history'")).rows[0].uid,uid);
 const missing=await pool.query("select count(*)::int n from mes_private.credentials where uid=$1",[uid]);assert.equal(missing.rows[0].n,0);
});
test('workspace publishing, media, categories and progress enforce roles and preserve history',async()=>{
 const owner=(await api('passwordLogin',{username:'hpham',password:'test-owner-password'})).cookie;
 const created=await api('manageUser',{operation:'create',username:'workspace.user',displayName:'Workspace User'},owner);
 const user=(await api('activateAccount',{username:'workspace.user',activationCode:created.body.activationCode,password:'workspace-password'})).cookie;
 async function ws(action,data={},cookie=owner){const response=await fetch(base+'/api/mes/workspace',{method:'POST',headers:{'x-forwarded-host':'ticket.th.io.vn','Content-Type':'application/json',cookie:cookie||''},body:JSON.stringify({action,data})});return {status:response.status,body:await response.json()};}
 assert.equal((await ws('read',{},'')).status,200);
 assert.equal((await ws('save',{kind:'announcements',title:'Denied',body:'No'},user)).status,403);
 const published=await ws('save',{kind:'announcements',title:'Production update',body:'New instructions',active:true,pinned:true});assert.equal(published.status,200,JSON.stringify(published.body));
 const draft=await ws('save',{kind:'announcements',title:'Unpublished',body:'Draft',active:false});assert.equal(draft.status,200);
 const visible=await ws('read',{},user);assert.equal(visible.status,200);assert.equal(visible.body.announcements.length,1);assert.equal(visible.body.announcements[0].title,'Production update');
 const category=await ws('save',{kind:'issueTypes',name:'Connectivity'});assert.equal(category.status,200);
 const dep=await api('manageDirectory',{type:'departments',operation:'create',name:'Workspace Department'},owner);assert.equal(dep.status,200);
 const issue=await api('createIssue',{reporterUid:created.body.uid,departmentId:dep.body.id,issueTypeId:category.body.id,issueTypeName:'Forged',process:'Station A',description:'Connection interrupted'},user);assert.equal(issue.status,200,JSON.stringify(issue.body));
 let stored=(await pool.query("select data from mes_private.records where collection='issues' and id=$1",[issue.body.id])).rows[0].data;assert.equal(stored.issueTypeName,'Connectivity');assert.equal(stored.progress,0);
 assert.equal((await api('createIssue',{reporterUid:created.body.uid,departmentId:dep.body.id,issueTypeId:'missing',process:'Station',description:'Failure'},user)).status,403);
 assert.equal((await api('updateIssue',{id:issue.body.id,operation:'handling',status:'In progress',priority:'High',progress:70},user)).status,403);
 assert.equal((await api('updateIssue',{id:issue.body.id,operation:'handling',status:'In progress',priority:'High',progress:120},owner)).status,403);
 assert.equal((await api('updateIssue',{id:issue.body.id,operation:'handling',status:'In progress',priority:'High',progress:70},owner)).status,200);
 stored=(await pool.query("select data from mes_private.records where collection='issues' and id=$1",[issue.body.id])).rows[0].data;assert.equal(stored.progress,70);
 assert.equal((await api('updateIssue',{id:issue.body.id,operation:'handling',status:'Closed',priority:'High',progress:10},owner)).status,200);
 await ws('delete',{kind:'issueTypes',id:category.body.id});stored=(await pool.query("select data from mes_private.records where collection='issues' and id=$1",[issue.body.id])).rows[0].data;assert.equal(stored.issueTypeName,'Connectivity');assert.equal(stored.progress,100);
 // Ticket video goes through the same authenticated, immutable attachment slots.
 const filePath=`issues/${issue.body.id}/${issue.body.uploadSlots[0]}`;const grant=await api('uploadUrl',{path:filePath},user);assert.equal(grant.status,200);
 const upload=await fetch(base+grant.body.url,{method:'PUT',headers:{'x-forwarded-host':'ticket.th.io.vn','Content-Type':'video/mp4'},body:Buffer.from('test-mp4')});assert.equal(upload.status,200);
 assert.equal((await api('attachFiles',{issueId:issue.body.id,files:[{slot:issue.body.uploadSlots[0],name:'evidence.mp4'}]},user)).status,200);
 assert.equal((await ws('videoUpload',{title:'Video',type:'video/mp4',size:8},user)).status,403);
 const media=await ws('videoUpload',{title:'Production training',type:'video/mp4',size:8});assert.equal(media.status,200,JSON.stringify(media.body));
 let response=await fetch(base+media.body.url,{method:'PUT',headers:{'x-forwarded-host':'ticket.th.io.vn','Content-Type':'video/mp4'},body:Buffer.from('12345678')});assert.equal(response.status,200);
 assert.equal((await fetch(base+media.body.url,{method:'PUT',headers:{'x-forwarded-host':'ticket.th.io.vn','Content-Type':'video/mp4'},body:'12345678'})).status,403);
 assert.equal((await fetch(base+`/api/mes/media/${media.body.id}`,{headers:{'x-forwarded-host':'ticket.th.io.vn'}})).status,200);
 response=await fetch(base+`/api/mes/media/${media.body.id}`,{headers:{'x-forwarded-host':'ticket.th.io.vn',cookie:user,range:'bytes=0-3'}});assert.equal(response.status,206);assert.equal(await response.text(),'1234');
 assert.equal((await ws('videoUpdate',{id:media.body.id,title:'Updated title'})).status,200);
 assert.equal((await ws('videoDelete',{id:media.body.id})).status,200);
 assert.equal((await fetch(base+`/api/mes/media/${media.body.id}`,{headers:{'x-forwarded-host':'ticket.th.io.vn',cookie:user}})).status,404);
 assert.equal((await ws('probeLog',{})).status,400);
 assert.equal((await ws('save',{kind:'networkTargets',name:'Removed'})).status,400);
});
test('200 MB video uploads stream in chunks for owner and user, with resume and notice privacy',async()=>{
 async function cookieFor(uid){return 'th_mes='+(await pool.query('select mes_private.open_account_session($1) result',[uid])).rows[0].result.sessionToken;}
 const owner=await cookieFor('mes-owner');const {rows:[person]}=await pool.query("select id from mes_private.records where collection='users' and data->>'username'='workspace.user'");const user=await cookieFor(person.id);
 async function call(path,data,cookie=owner,method='POST',headers={}){const response=await fetch(base+path,{method,headers:{'x-forwarded-host':'ticket.th.io.vn','Content-Type':'application/json',cookie,...headers},...(data===undefined?{}:{body:Buffer.isBuffer(data)?data:JSON.stringify(data)})});let body;try{body=await response.json();}catch{}return {status:response.status,body};}
 const ws=(action,data,cookie=owner)=>call('/api/mes/workspace',{action,data},cookie);
 const maximum=200*1024*1024,chunk=Buffer.alloc(4*1024*1024,93);
 const media=await ws('videoUpload',{title:'200 MB boundary',type:'video/mp4',size:maximum});assert.equal(media.status,200);
 assert.equal((await ws('videoUpload',{title:'Too large',type:'video/mp4',size:maximum+1})).status,400);
 const started=await call('/api/mes/uploads',{kind:'media',path:media.body.id,type:'video/mp4',size:maximum});assert.equal(started.status,200,JSON.stringify(started.body));
 assert.equal((await call('/api/mes/uploads/'+started.body.id,undefined,user,'GET')).status,403);
 assert.equal((await call('/api/mes/uploads/'+started.body.id,Buffer.from('x'),owner,'PATCH',{'Content-Type':'application/octet-stream','Upload-Offset':'1'})).status,409);
 for(let offset=0;offset<maximum;offset+=chunk.length){const r=await call('/api/mes/uploads/'+started.body.id,chunk,owner,'PATCH',{'Content-Type':'application/octet-stream','Upload-Offset':String(offset)});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.offset,offset+chunk.length);}
 const again=await call('/api/mes/uploads',{kind:'media',path:media.body.id,type:'video/mp4',size:maximum});assert.equal(again.body.complete,true);assert.equal(again.body.offset,maximum);
 const range=await fetch(base+`/api/mes/media/${media.body.id}`,{headers:{'x-forwarded-host':'ticket.th.io.vn',cookie:user,range:`bytes=${maximum-1}-${maximum-1}`}});assert.equal(range.status,206);assert.equal(new Uint8Array(await range.arrayBuffer())[0],93);
 const dep=(await pool.query("select id from mes_private.records where collection='departments' and (data->>'active')::boolean limit 1")).rows[0];
 const issue=await api('createIssue',{reporterUid:person.id,departmentId:dep.id,process:'Large evidence',description:'Large user video'},user);assert.equal(issue.status,200);
 const path=`issues/${issue.body.id}/${issue.body.uploadSlots[0]}`;
 assert.equal((await call('/api/mes/uploads',{kind:'ticket',path,type:'video/mp4',size:maximum+1},user)).status,400);
 const ticket=await call('/api/mes/uploads',{kind:'ticket',path,type:'video/mp4',size:maximum},user);assert.equal(ticket.status,200,JSON.stringify(ticket.body));
 for(let offset=0;offset<maximum;offset+=chunk.length){const r=await call('/api/mes/uploads/'+ticket.body.id,chunk,user,'PATCH',{'Content-Type':'application/octet-stream','Upload-Offset':String(offset)});assert.equal(r.status,200,JSON.stringify(r.body));}
 assert.equal((await api('attachFiles',{issueId:issue.body.id,files:[{slot:issue.body.uploadSlots[0],name:'200mb.mp4'}]},user)).status,200);
 assert.equal(Number((await pool.query('select size from public.files where path=$1',[path])).rows[0].size),maximum);
 const broken=await ws('mediaUpload',{purpose:'notice',title:'Retry incomplete chunk',type:'image/png',size:6});const partial=await call('/api/mes/uploads',{kind:'media',path:broken.body.id,type:'image/png',size:6});
 try{const bad=await call('/api/mes/uploads/'+partial.body.id,Buffer.from('toolongfile'),owner,'PATCH',{'Content-Type':'application/octet-stream','Upload-Offset':'0'});assert.notEqual(bad.status,200);}catch(error){assert.ok(error instanceof TypeError);}
 const partialStatus=await call('/api/mes/uploads/'+partial.body.id,undefined,owner,'GET');assert.equal(partialStatus.body.offset,0);assert.equal(partialStatus.body.complete,false);
 assert.equal((await call('/api/mes/uploads/'+partial.body.id,Buffer.from('small!'),owner,'PATCH',{'Content-Type':'application/octet-stream','Upload-Offset':'0'})).status,200);
 const image=await ws('mediaUpload',{purpose:'notice',title:'Notice photo',type:'image/png',size:8});assert.equal(image.status,200);
 const imageUpload=await call('/api/mes/uploads',{kind:'media',path:image.body.id,type:'image/png',size:8});assert.equal(imageUpload.status,200);
 assert.equal((await call('/api/mes/uploads/'+imageUpload.body.id,Buffer.from('imagepng'),owner,'PATCH',{'Content-Type':'application/octet-stream','Upload-Offset':'0'})).status,200);
 const noticeVideo=await ws('mediaUpload',{purpose:'notice',title:'Notice video',type:'video/webm',size:8});assert.equal(noticeVideo.status,200);const v=await call('/api/mes/uploads',{kind:'media',path:noticeVideo.body.id,type:'video/webm',size:8});await call('/api/mes/uploads/'+v.body.id,Buffer.from('webmtest'),owner,'PATCH',{'Content-Type':'application/octet-stream','Upload-Offset':'0'});
 const mediaGet=()=>fetch(base+`/api/mes/media/${image.body.id}`,{headers:{'x-forwarded-host':'ticket.th.io.vn',cookie:user}});
 assert.equal((await mediaGet()).status,404);
 const notice=await ws('save',{kind:'announcements',title:'Photo and video',body:'Notice attachments',active:false,media:[image.body.id,noticeVideo.body.id]});assert.equal(notice.status,200,JSON.stringify(notice.body));
 assert.equal((await mediaGet()).status,404);
 assert.equal((await ws('save',{kind:'announcements',id:notice.body.id,title:'Photo and video',body:'Notice attachments',active:true,media:[image.body.id,noticeVideo.body.id]})).status,200);
 assert.equal((await mediaGet()).status,200);
 const visible=(await ws('read',{},user)).body;assert.equal(visible.announcements.find(x=>x.id===notice.body.id).media.length,2);assert.equal(visible.videos.some(x=>x.id===image.body.id),false);assert.equal(visible.targets,undefined);
 assert.equal((await ws('save',{kind:'announcements',id:notice.body.id,title:'Denied',body:'Edit'},user)).status,403);
 assert.equal((await ws('delete',{kind:'announcements',id:notice.body.id})).status,200);assert.equal((await mediaGet()).status,404);
 assert.equal((await pool.query('select id from public.mes_media where id=any($1::text[])',[[image.body.id,noticeVideo.body.id]])).rowCount,0);
});
test('portfolio server authorization, profile, bookmarks, inquiries and reset tokens',async()=>{
 const {rows:[u]}=await pool.query("insert into portfolio.users(email,password,name,verified) values('pi@example.test',extensions.crypt('test-user-password',extensions.gen_salt('bf',4)),'Pi User',true) returning *");
 const login=await api('login',{email:u.email,password:'test-user-password'},'','th.io.vn');assert.equal(login.status,200);assert.equal(login.body.user.isAdmin,false);const cookie=login.cookie;
 const query=(action,data)=>api(action,data,cookie,'th.io.vn');
 assert.equal((await query('set',{path:`users/${u.id}/bookmarks/esp32`,data:{projectId:'esp32'}})).status,200);
 assert.equal((await query('set',{path:'users/another/bookmarks/esp32',data:{}})).status,403);
 const inquiry=await query('add',{path:'inquiries',data:{name:'Pi',message:'Please discuss this software project.',topic:'Software / data',uid:'another',email:'forged@example.test',status:'Closed'}});assert.equal(inquiry.status,200);
 const list=await query('list',{path:'inquiries'});assert.equal(list.body.rows[0].data.uid,u.id);assert.equal(list.body.rows[0].data.status,'New');
 assert.equal((await query('set',{path:`inquiries/${inquiry.body.id}`,data:{status:'Closed'}})).status,403);
 assert.equal((await query('list',{path:'users/another/bookmarks'})).status,403);
 const resetToken='a'.repeat(64);await pool.query("insert into portfolio.tokens(hash,uid,purpose) values($1,$2,'reset')",[hash(resetToken),u.id]);
 assert.equal((await api('consumeToken',{purpose:'reset',token:resetToken,password:'new-test-password'},'','th.io.vn')).status,200);
 assert.equal((await query('session',{})).body.user,null);
 assert.equal((await api('consumeToken',{purpose:'reset',token:resetToken,password:'new-test-password'},'','th.io.vn')).status,403);
});
test('runtime role cannot read private MES credentials or bootstrap owner',async()=>{
 const connection=await pool.connect();
 try {await connection.query('set role th_api');
  await assert.rejects(connection.query('select * from mes_private.credentials'),e=>e.code==='42501');
  await assert.rejects(connection.query('select public.mes_issue_owner_activation()'),e=>e.code==='42501');
 }finally{await connection.query('reset role');connection.release();}
});
test('Google OAuth validates state and verified identity, sets local owner session',async()=>{
 process.env.GOOGLE_CLIENT_ID='test-client';process.env.GOOGLE_CLIENT_SECRET='test-secret';
 const start=await fetch(base+'/api/oauth/start',{redirect:'manual',headers:{'x-forwarded-host':'ticket.th.io.vn'}});
 assert.equal(start.status,302);const target=new URL(start.headers.get('location'));assert.equal(target.hostname,'accounts.google.com');assert.equal(target.searchParams.get('code_challenge_method'),'S256');
 const cookie=start.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 const state=target.searchParams.get('state');
 const bad=await fetch(base+'/api/oauth/callback?state=wrong&code=test',{redirect:'manual',headers:{'x-forwarded-host':'ticket.th.io.vn',cookie,'sec-fetch-site':'cross-site',origin:'https://accounts.google.com'}});assert.equal(bad.status,400);
 const originalFetch=globalThis.fetch;
 let identity={email:'intruder@example.test',email_verified:true};
 globalThis.fetch=async(input,init)=>{
  if(input==='https://oauth2.googleapis.com/token')return Response.json({access_token:'test-google-access'});
  if(input==='https://openidconnect.googleapis.com/v1/userinfo')return Response.json(identity);
  return originalFetch(input,init);
 };
 try {
  const callback=()=>fetch(base+`/api/oauth/callback?state=${state}&code=test`,{redirect:'manual',headers:{'x-forwarded-host':'ticket.th.io.vn',cookie,'sec-fetch-site':'cross-site',origin:'https://accounts.google.com'}});
  assert.equal((await callback()).status,403);
  identity={email:'eric.scorp93@gmail.com',email_verified:false};assert.equal((await callback()).status,401);
  identity={email:'eric.scorp93@gmail.com',email_verified:true};const success=await callback();assert.equal(success.status,302);assert.match(success.headers.get('set-cookie'),/th_mes=.*HttpOnly/);
  assert.equal((await api('getSession',{},success.headers.getSetCookie().find(v=>v.startsWith('th_mes=')).split(';')[0])).body.isOwner,true);
  await pool.query("insert into portfolio.users(email,password,verified) values('eric.scorp93@gmail.com',extensions.crypt('attacker-password',extensions.gen_salt('bf',4)),false)");
  const attackerLogin=await api('login',{email:'eric.scorp93@gmail.com',password:'attacker-password'},'','th.io.vn');
  assert.equal(attackerLogin.status,200);
  const portfolioStart=await fetch(base+'/api/oauth/start',{redirect:'manual',headers:{'x-forwarded-host':'th.io.vn'}});
  const portfolioState=new URL(portfolioStart.headers.get('location')).searchParams.get('state');
  const portfolioCookies=portfolioStart.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const portfolioGoogle=await fetch(base+`/api/oauth/callback?state=${portfolioState}&code=test`,{redirect:'manual',headers:{'x-forwarded-host':'th.io.vn',cookie:portfolioCookies,'sec-fetch-site':'cross-site',origin:'https://accounts.google.com'}});
  assert.equal(portfolioGoogle.status,302);
  assert.equal((await api('session',{},attackerLogin.cookie,'th.io.vn')).body.user,null);
  assert.equal((await api('login',{email:'eric.scorp93@gmail.com',password:'attacker-password'},'','th.io.vn')).status,401);
  const ownerCookie=portfolioGoogle.headers.getSetCookie().find(v=>v.startsWith('th_portfolio=')).split(';')[0];
  assert.equal((await api('session',{},ownerCookie,'th.io.vn')).body.user.isAdmin,true);

 }finally{globalThis.fetch=originalFetch;delete process.env.GOOGLE_CLIENT_ID;delete process.env.GOOGLE_CLIENT_SECRET;}
});

test('users comment across tickets; access history is administrator-only and redacts secrets',async()=>{
 const owner=(await api('passwordLogin',{username:'hpham',password:'test-owner-password'})).cookie;
 const a=await api('manageUser',{operation:'create',username:'comment.a',displayName:'Comment A'},owner);
 const b=await api('manageUser',{operation:'create',username:'comment.b',displayName:'Comment B'},owner);
 const userA=(await api('activateAccount',{username:'comment.a',activationCode:a.body.activationCode,password:'test-comment-password'})).cookie;
 const userB=(await api('activateAccount',{username:'comment.b',activationCode:b.body.activationCode,password:'test-comment-password'})).cookie;
 const dept=await api('manageDirectory',{type:'departments',operation:'create',name:'Comment team'},owner);
 const leader=await api('manageDirectory',{type:'teamLeaders',operation:'create',name:'Comment leader'},owner);
 const issue=await api('createIssue',{reporterUid:a.body.uid,teamLeaderId:leader.body.id,subject:'Shared comments',process:'Station B',description:'Existing content must remain unchanged.',departmentId:dept.body.id},userA);
 assert.equal(issue.status,200,JSON.stringify(issue.body));
 await verifiedPhoto(issue.body,userA,1);
 const before=(await api('readTicket',{id:issue.body.id},userA)).body;
 const comment=await api('addComment',{issueId:issue.body.id,text:'Bổ sung từ một user khác',author:'forged',authorUid:'mes-owner'},userB);
 assert.equal(comment.status,200,JSON.stringify(comment.body));
 const after=(await api('readTicket',{id:issue.body.id},userA)).body;
 for(const field of ['subject','description','status','priority','createdBy','attachments'])assert.deepEqual(after[field],before[field]);
 const timeline=(await api('read',{path:`issues/${issue.body.id}/timeline`},userA)).body.rows;
 const added=timeline.find(e=>e.text==='Bổ sung từ một user khác');assert.equal(added.author,'Comment B');assert.equal(added.authorUid,b.body.uid);
 assert.equal((await api('updateIssue',{id:issue.body.id,operation:'handling',status:'Closed',priority:'Low'},userB)).status,403);
 assert.equal((await api('getAccessLog',{},userB)).status,403);
 await api('logAccess',{page:'detail',ticketId:issue.body.id,password:'never-log-this'},userB);
 const log=(await api('getAccessLog',{username:'comment.b'},owner)).body.rows;
 assert.ok(log.some(e=>e.event==='page'&&e.ticket_id===issue.body.id));assert.ok(log.some(e=>e.event==='activateAccount'));
 assert.ok(!JSON.stringify(log).includes('never-log-this'));assert.ok(!JSON.stringify(log).includes(b.body.activationCode));assert.ok(!JSON.stringify(log).includes('test-comment-password'));
 const fetchAdmin=(path,cookie)=>fetch(base+'/api/mes/admin/'+path,{headers:{'x-forwarded-host':'ticket.th.io.vn',cookie}});
 assert.equal((await fetchAdmin('access-log',userB)).status,403);assert.equal((await fetchAdmin('storage',userB)).status,403);
 const storage=await fetchAdmin('storage',owner);assert.equal(storage.status,200);assert.equal((await storage.json()).primary,'internal');
 const mediaPath=`issues/${issue.body.id}/${issue.body.uploadSlots[0]}`;
 const grant=(await api('uploadUrl',{path:mediaPath},userA)).body;
 const payload='0123456789'.repeat(1024);
 const uploaded=await fetch(base+grant.url,{method:'PUT',headers:{'x-forwarded-host':'ticket.th.io.vn','Content-Type':'video/mp4'},body:payload});assert.equal(uploaded.status,200);
 await api('attachFiles',{issueId:issue.body.id,files:[{slot:issue.body.uploadSlots[0],name:'evidence.mp4'}]},userA);
 const url=base+`/api/mes/attachments/${issue.body.id}/${issue.body.uploadSlots[0]}`;
 const range=await fetch(url,{headers:{'x-forwarded-host':'ticket.th.io.vn',cookie:userB,range:'bytes=2-7'}});assert.equal(range.status,206);assert.equal(await range.text(),'234567');assert.match(range.headers.get('cache-control'),/private/);assert.match(range.headers.get('accept-ranges'),/bytes/);
 assert.equal((await fetch(url,{headers:{'x-forwarded-host':'ticket.th.io.vn'}})).status,200);
 const translated=await fetch(base+'/api/mes/translation',{method:'POST',headers:{'x-forwarded-host':'ticket.th.io.vn','Content-Type':'application/json',cookie:userB},body:JSON.stringify({id:issue.body.id})});assert.equal(translated.status,403);
});
test('translation is explicit, cached and leaves original title, formatted content and history unchanged',async()=>{
 const owner=(await api('passwordLogin',{username:'hpham',password:'test-owner-password'})).cookie;
 const user=(await api('passwordLogin',{username:'comment.a',password:'test-comment-password'})).cookie;
 // Find the ticket through the same authorised collection the UI reads.
 const ticket=(await api('read',{path:'issues'},user)).body.rows.find(i=>i.reporterUsername==='comment.a');assert.ok(ticket);
 const before=(await api('readTicket',{id:ticket.id},user)).body;
 const originalFetch=globalThis.fetch,oldKey=process.env.GOOGLE_TRANSLATE_API_KEY;let calls=0;
 process.env.GOOGLE_TRANSLATE_API_KEY='test-key-not-a-secret';
 globalThis.fetch=async(url,options)=>{
  if(String(url).startsWith('https://translation.googleapis.com/')){
   calls++;const sent=JSON.parse(options.body);assert.deepEqual(sent.q,[before.subject,before.description]);assert.equal(sent.source,'vi');assert.equal(sent.target,'en');assert.equal(sent.format,'text');
   return new Response(JSON.stringify({data:{translations:[{translatedText:'English title'},{translatedText:'English feedback body'}]}}),{status:200,headers:{'Content-Type':'application/json'}});
  }return originalFetch(url,options);
 };
 try{
  const translate=()=>fetch(base+'/api/mes/translation',{method:'POST',headers:{'x-forwarded-host':'ticket.th.io.vn','Content-Type':'application/json',cookie:user},body:JSON.stringify({id:ticket.id})});
  const first=await translate();assert.equal(first.status,200,await first.clone().text());assert.equal((await first.json()).subject,'English title');assert.equal((await translate()).status,200);assert.equal(calls,1,'Unchanged content should reuse cached translation');
  assert.deepEqual((await api('readTicket',{id:ticket.id},user)).body,before);
 }finally{globalThis.fetch=originalFetch;if(oldKey===undefined)delete process.env.GOOGLE_TRANSLATE_API_KEY;else process.env.GOOGLE_TRANSLATE_API_KEY=oldKey;}
});

test('anonymous viewer reads tickets but cannot read accounts or write; layout preferences are private',async()=>{
 const owner='th_mes='+(await pool.query("select mes_private.open_account_session('mes-owner') result")).rows[0].result.sessionToken;
 const listing=await api('read',{path:'issues'});assert.equal(listing.status,200,JSON.stringify(listing.body));
 for(const issue of listing.body.rows){assert.equal(issue.uploadSlots,undefined);assert.equal(issue.reporterUid,undefined);}
 for(const path of ['users','settings','dashboardPreferences','credentials'])assert.notEqual((await api('read',{path})).status,200);
 for(const name of ['createIssue','addComment','saveDashboardPreferences','getAccessLog','getProfile'])assert.notEqual((await api(name,{})).status,200);
 assert.equal((await api('saveDashboardPreferences',{hidden:['video','notices']},owner)).status,200);
 assert.deepEqual((await api('getDashboardPreferences',{},owner)).body.hidden,['video','notices']);
 const otherUid=(await pool.query("select id from mes_private.records where collection='users' and data->>'username'='comment.b'")).rows[0].id;
 const other='th_mes='+(await pool.query('select mes_private.open_account_session($1) result',[otherUid])).rows[0].result.sessionToken;
 assert.deepEqual((await api('getDashboardPreferences',{},other)).body.hidden,[]);
 assert.equal((await api('saveDashboardPreferences',{hidden:['activity'],uid:'mes-owner'},other)).status,200);
 assert.deepEqual((await api('getDashboardPreferences',{},owner)).body.hidden,['video','notices']);
 assert.notEqual((await api('saveDashboardPreferences',{hidden:['invalid-widget']},owner)).status,200);
 const response=await fetch(base+'/api/mes/drive/callback?state=bad&code=bad',{headers:{'x-forwarded-host':'ticket.th.io.vn',referer:'https://accounts.google.com/'}});assert.equal(response.status,400);
 for(const path of ['drive/status','drive/connect','admin/storage'])assert.notEqual((await fetch(base+'/api/mes/'+path,{headers:{'x-forwarded-host':'ticket.th.io.vn'},redirect:'manual'})).status,200);
});
test('Drive uploads finish asynchronously and private cloud video supports public ticket byte ranges',async()=>{
 const {saveDriveCredentials}=await import('../drive-client.js');const {createHash}=await import('node:crypto');
 const oldFetch=global.fetch,oldToken=process.env.DRIVE_TOKEN_FILE;process.env.DRIVE_TOKEN_FILE=join(files,'drive-credentials.json');
 await saveDriveCredentials({refreshToken:'test-refresh',mediaFolder:'media-folder',backupFolder:'backup-folder'});
 let uploaded=Buffer.alloc(0);const checksum=()=>createHash('md5').update(uploaded).digest('hex');
 global.fetch=async(url,options={})=>{
  const value=String(url);if(!value.startsWith('https://'))return oldFetch(url,options);
  if(value.includes('oauth2.googleapis.com'))return Response.json({access_token:'test-token',expires_in:3600});
  if(value.includes('uploadType=resumable'))return new Response(null,{status:200,headers:{location:'https://www.googleapis.com/upload/test'}});
  if(value.endsWith('/upload/test')){await new Promise(resolve=>setTimeout(resolve,50));uploaded=Buffer.concat([uploaded,options.body]);return Response.json({id:'test-cloud-video',size:String(uploaded.length),md5Checksum:checksum()});}
  if(value.includes('test-cloud-video?alt=media')){assert.equal(options.headers.Authorization,'Bearer test-token');assert.equal(options.headers.Range,'bytes=0-3');return new Response(uploaded.subarray(0,4),{status:206,headers:{'content-range':`bytes 0-3/${uploaded.length}`,'content-length':'4'}});}
  throw new Error('Unexpected Drive request');
 };
 try{
  await pool.query("update public.mes_storage_settings set provider='drive' where id='main'");
  const owner='th_mes='+(await pool.query("select mes_private.open_account_session('mes-owner') result")).rows[0].result.sessionToken;
  const department=(await pool.query("select id from mes_private.records where collection='departments' limit 1")).rows[0].id;
  const issue=await api('createIssue',{reporterUid:'mes-owner',departmentId:department,process:'Cloud upload',description:'Cloud range test'},owner);assert.equal(issue.status,200,JSON.stringify(issue.body));
  const slot=issue.body.uploadSlots[0],path=`issues/${issue.body.id}/${slot}`,headers={'x-forwarded-host':'ticket.th.io.vn',cookie:owner,'Content-Type':'application/json'};
  const start=await oldFetch(base+'/api/mes/uploads',{method:'POST',headers,body:JSON.stringify({kind:'ticket',path,type:'video/mp4',size:8})});assert.equal(start.status,200);const info=await start.json();
  const patch=await oldFetch(base+'/api/mes/uploads/'+info.id,{method:'PATCH',headers:{...headers,'Content-Type':'application/octet-stream','Upload-Offset':'0'},body:'12345678'});assert.equal(patch.status,202);assert.equal((await patch.json()).processing,true);
  let done=false;for(let i=0;i<100;i++){const status=await oldFetch(base+'/api/mes/uploads/'+info.id,{headers});const record=await status.json();assert.equal(status.status,200,JSON.stringify(record));if(record.complete){done=true;break;}await new Promise(r=>setTimeout(r,10));}assert.equal(done,true);
  assert.equal((await api('attachFiles',{issueId:issue.body.id,files:[{slot,name:'cloud.mp4'}]},owner)).status,200);
  const response=await oldFetch(base+`/api/mes/attachments/${issue.body.id}/${slot}`,{headers:{'x-forwarded-host':'ticket.th.io.vn',range:'bytes=0-3'}});assert.equal(response.status,206);assert.equal(await response.text(),'1234');assert.equal(response.headers.get('content-range'),'bytes 0-3/8');
  assert.equal((await pool.query('select drive_id from public.mes_cloud_files where path=$1',[path])).rows[0].drive_id,'test-cloud-video');
 }finally{await pool.query("update public.mes_storage_settings set provider='local' where id='main'");global.fetch=oldFetch;if(oldToken===undefined)delete process.env.DRIVE_TOKEN_FILE;else process.env.DRIVE_TOKEN_FILE=oldToken;}
});
test('monthly ticket numbers, direct public API and the 99-ticket limit preserve original IDs and history',async()=>{
 const previousBase=base,isolated=createApp(runtimePool,files).listen(0,'127.0.0.1');await new Promise(r=>isolated.once('listening',r));base=`http://127.0.0.1:${isolated.address().port}`;
 try {
 const owner='th_mes='+(await pool.query("select mes_private.open_account_session('mes-owner') result")).rows[0].result.sessionToken;
 const department=(await pool.query("select id from mes_private.records where collection='departments' limit 1")).rows[0].id;
 const created=await Promise.all(Array.from({length:4},()=>api('createIssue',{reporterUid:'mes-owner',departmentId:department,process:'Numbered ticket',description:'Ticket number concurrency test'},owner)));
 for(const value of created){assert.equal(value.status,200,JSON.stringify(value.body));await verifiedPhoto(value.body,owner);}
 const codes=created.map(r=>r.body.ticketNumber);assert.equal(new Set(codes).size,4);for(const code of codes)assert.match(code,/^TH\d{4}-\d{2}$/);
 const item=created[0].body;const response=await fetch(base+'/api/mes/tickets/'+item.ticketNumber,{headers:{'x-forwarded-host':'ticket.th.io.vn'}});assert.equal(response.status,200);const publicIssue=await response.json();assert.equal(publicIssue.id,item.id);assert.equal(publicIssue.ticketNumber,item.ticketNumber);assert.equal(publicIssue.uploadSlots,undefined);
 assert.equal((await fetch(base+'/api/mes/tickets/TH0000-99',{headers:{'x-forwarded-host':'ticket.th.io.vn'}})).status,404);
 const listing=await api('readBundle',{paths:[{path:'issues'}]});assert.ok(listing.body.snapshots.issues.rows.some(i=>i.id===item.id&&i.ticketNumber===item.ticketNumber));
 const db=await pool.connect();try{
  await db.query('begin');const month=(await db.query("select to_char(now() at time zone 'Asia/Ho_Chi_Minh','YYMM') period")).rows[0].period;
  await db.query('update mes_private.ticket_months set allocated=98 where month_key=$1',[month]);
  await db.query("insert into mes_private.records(collection,id,data) values('issues','month-limit-test','{}')");assert.equal((await db.query("select code from public.mes_ticket_codes where issue_id='month-limit-test'")).rows[0].code,'TH'+month+'-99');
  await db.query('savepoint full_month');await assert.rejects(db.query("insert into mes_private.records(collection,id,data) values('issues','month-limit-overflow','{}')"),e=>e.code==='P0099');await db.query('rollback to savepoint full_month');
  assert.equal((await db.query("select count(*)::int n from mes_private.records where collection='issues' and id='month-limit-overflow'")).rows[0].n,0);
  await db.query('rollback');
 }finally{db.release();}
 const currentMonth=(await pool.query("select to_char(now() at time zone 'Asia/Ho_Chi_Minh','YYMM') period")).rows[0].period;
 const allocated=(await pool.query('select allocated from mes_private.ticket_months where month_key=$1',[currentMonth])).rows[0].allocated;
 try{await pool.query('update mes_private.ticket_months set allocated=99 where month_key=$1',[currentMonth]);const denied=await api('createIssue',{reporterUid:'mes-owner',departmentId:department,process:'Full month',description:'Must not create ticket 100'},owner);assert.equal(denied.status,409,JSON.stringify(denied.body));assert.equal(denied.body.code,'P0099');assert.match(denied.body.error,/99 tickets/);}finally{await pool.query('update mes_private.ticket_months set allocated=$2 where month_key=$1',[currentMonth,allocated]);}
 }finally{base=previousBase;await new Promise(r=>isolated.close(r));}
});
test('admin fully edits old tickets and replaces/removes files atomically; downloads preserve originals and history',async()=>{
 const previousBase=base,isolated=createApp(runtimePool,files).listen(0,'127.0.0.1');await new Promise(r=>isolated.once('listening',r));base=`http://127.0.0.1:${isolated.address().port}`;
 try{
 const owner='th_mes='+(await pool.query("select mes_private.open_account_session('mes-owner') result")).rows[0].result.sessionToken;
 const person=(await pool.query("select id from mes_private.records where collection='users' and data->>'username'='comment.b'")).rows[0].id;
 const user='th_mes='+(await pool.query('select mes_private.open_account_session($1) result',[person])).rows[0].result.sessionToken;
 const department=(await pool.query("select id from mes_private.records where collection='departments' limit 1")).rows[0].id;
 const created=await api('createIssue',{reporterUid:'mes-owner',departmentId:department,process:'Original process',description:'Original feedback with image'},owner);assert.equal(created.status,200,JSON.stringify(created.body));const id=created.body.id,path=`issues/${id}/${created.body.uploadSlots[0]}`;
 const grant=await api('uploadUrl',{path},owner);const original=Buffer.from('Original image bytes');assert.equal((await fetch(base+grant.body.url,{method:'PUT',headers:{'x-forwarded-host':'ticket.th.io.vn','content-type':'image/png'},body:original})).status,200);
 assert.equal((await api('attachFiles',{issueId:id,files:[{slot:created.body.uploadSlots[0],name:'old.png'}]},owner)).status,200);
 await pool.query("update mes_private.records set data=jsonb_set(data,'{createdAt}',to_jsonb((extract(epoch from now()-interval '2 days')*1000)::bigint)) where collection='issues' and id=$1",[id]);
 const previous=(await api('readTicket',{id},owner)).body;const history=(await pool.query('select id,data from mes_private.records where collection=$1 order by seq',[`issues/${id}/timeline`])).rows;
 assert.equal((await api('reserveTicketFiles',{id,indices:[0]},user)).status,403);assert.equal((await api('reserveTicketFiles',{id,indices:[0]})).status,401);
 const reserve=await api('reserveTicketFiles',{id,indices:[0,1]},owner);assert.equal(reserve.status,200,JSON.stringify(reserve.body));
 const headers={'x-forwarded-host':'ticket.th.io.vn',cookie:owner,'Content-Type':'application/json'};
 for(const file of reserve.body.files){
  const start=await fetch(base+'/api/mes/uploads',{method:'POST',headers,body:JSON.stringify({kind:'ticket',path:file.path,type:'image/png',size:8})});assert.equal(start.status,200);const info=await start.json();assert.equal((await fetch(base+'/api/mes/uploads/'+info.id,{method:'PATCH',headers:{...headers,'Content-Type':'application/octet-stream','Upload-Offset':'0'},body:'newimage'})).status,200);
  const preview=await fetch(base+`/api/mes/previews/ticket/${id}/${file.slot}`,{method:'PUT',headers:{...headers,'Content-Type':'image/jpeg'},body:Buffer.from([255,216,255,217])});assert.equal(preview.status,200,await preview.text());
 }
 const edit={id,baseUpdatedAt:previous.updatedAt,subject:'Complete admin edit',process:'New process',description:'New content',departmentId:department,issueTypeId:'general',reporterUid:person,status:'In progress',priority:'High',progress:55,assessment:'Assessment edited',occurrences:[],richDocument:{version:1,ops:[{insert:'New content '},{insert:{image:0}},{insert:{image:1}},{insert:'\n'}]},files:reserve.body.files.map((f,i)=>({path:f.path,slotIndex:i,name:`edited-${i}.png`}))};
 assert.equal((await api('saveTicketEdit',edit,user)).status,403);assert.equal((await api('saveTicketEdit',{...edit,files:[{path:'issues/other/unrelated',slotIndex:0,name:'bad.png'}]},owner)).status,403);
 const invalidHandling=await api('saveTicketEdit',{...edit,priority:'Forged'},owner);assert.equal(invalidHandling.status,403);assert.equal((await api('readTicket',{id},owner)).body.subject,previous.subject,'A late validation error rolls back text edits and timeline writes');
 const saved=await api('saveTicketEdit',edit,owner);assert.equal(saved.status,200,JSON.stringify(saved.body));const current=(await api('readTicket',{id},owner)).body;
 assert.equal(current.subject,'Complete admin edit');assert.equal(current.reporterUid,person);assert.equal(current.status,'In progress');assert.equal(current.progress,55);assert.equal(current.attachments.length,2);assert.equal(current.id,id);assert.equal(current.ticketNumber,created.body.ticketNumber);
 assert.deepEqual(await readFile(join(files,path)),original,'Replaced original bytes stay available for backups');assert.equal((await fetch(base+'/api/mes/attachments/'+path.split('/').slice(1).join('/'),{headers:{'x-forwarded-host':'ticket.th.io.vn'}})).status,403);
 const afterHistory=(await pool.query('select id,data from mes_private.records where collection=$1 order by seq',[`issues/${id}/timeline`])).rows;assert.deepEqual(afterHistory.slice(0,history.length),history);assert.ok(afterHistory.some(h=>h.data.before?.attachments?.some(f=>f.path===path)));
 const attachment=current.attachments[0];const download=await fetch(base+'/api/mes/attachments/'+attachment.path.split('/').slice(1).join('/')+'?download=1',{headers:{'x-forwarded-host':'ticket.th.io.vn'}});assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/attachment;.*edited-0.png/);assert.equal(await download.text(),'newimage');
 assert.equal((await api('saveTicketEdit',edit,owner)).status,409,'A stale edit cannot overwrite a newer version');
 const removal={...edit,baseUpdatedAt:current.updatedAt,richDocument:{version:1,ops:[{insert:'Keep one image '},{insert:{image:0}},{insert:'\n'}]},files:[{...edit.files[0],name:'renamed.png'}]};const removed=await api('saveTicketEdit',removal,owner);assert.equal(removed.status,200,JSON.stringify(removed.body));assert.equal((await api('readTicket',{id},owner)).body.attachments.length,1);assert.equal((await readFile(join(files,edit.files[1].path))).toString(),'newimage');
 }finally{base=previousBase;await new Promise(r=>isolated.close(r));}
});
test('appearance preferences are bounded, private per account, and persistent across sessions',async()=>{
 const pref=(name,data,cookie)=>api(name,data,cookie,'ticket.th.io.vn',{'x-forwarded-for':'192.0.2.40'});
 const owner='th_mes='+(await pool.query("select mes_private.open_account_session('mes-owner') result")).rows[0].result.sessionToken;
 const uid=(await pool.query("select id from mes_private.records where collection='users' and data->>'username'='comment.b'")).rows[0].id;
 const other='th_mes='+(await pool.query('select mes_private.open_account_session($1) result',[uid])).rows[0].result.sessionToken;
 for(const name of ['getAppearancePreferences','saveAppearancePreferences'])assert.notEqual((await pref(name,{font:'arial',size:18})).status,200);
 assert.notEqual((await pref('read',{path:'appearancePreferences'},owner)).status,200);
 assert.deepEqual((await pref('getAppearancePreferences',{},other)).body,{font:'calibri',size:14,custom:false});
 assert.equal((await pref('saveAppearancePreferences',{font:'georgia',size:18,uid:'mes-owner'},other)).status,200);
 assert.deepEqual((await pref('getAppearancePreferences',{},owner)).body,{font:'calibri',size:14,custom:false});
 const fresh='th_mes='+(await pool.query('select mes_private.open_account_session($1) result',[uid])).rows[0].result.sessionToken;
 assert.deepEqual((await pref('getAppearancePreferences',{},fresh)).body,{font:'georgia',size:18,custom:true});
 for(const data of [{font:'url(evil)',size:14},{font:'arial',size:999},{font:'arial',size:'18'},{font:'arial'},{size:14}])assert.notEqual((await pref('saveAppearancePreferences',data,other)).status,200);
 assert.deepEqual((await pref('getAppearancePreferences',{},other)).body,{font:'georgia',size:18,custom:true});
 assert.deepEqual((await pref('getAppearanceDefaults',{})).body,{font:'calibri',size:14});
 for(const cookie of ['',other])assert.notEqual((await pref('saveAppearanceDefaults',{font:'arial',size:16},cookie)).status,200);
 assert.notEqual((await pref('saveAppearanceDefaults',{font:'evil',size:16},owner)).status,200);
 assert.equal((await pref('saveAppearanceDefaults',{font:'arial',size:16},owner)).status,200);
 assert.deepEqual((await pref('getAppearanceDefaults',{})).body,{font:'arial',size:16});
 assert.deepEqual((await pref('getAppearancePreferences',{},owner)).body,{font:'arial',size:16,custom:false});
 assert.deepEqual((await pref('getAppearancePreferences',{},other)).body,{font:'georgia',size:18,custom:true});
 assert.deepEqual((await pref('resetAppearancePreferences',{uid:'mes-owner'},other)).body,{font:'arial',size:16,custom:false});
 assert.equal((await pref('saveAppearanceDefaults',{font:'calibri',size:14},owner)).status,200);
 assert.deepEqual((await pref('getAppearancePreferences',{},other)).body,{font:'calibri',size:14,custom:false});
});
test('content tabs publish bounded widgets and documents with owner/member/viewer permissions, revisions and retained history',async()=>{
 const previousBase=base,isolated=createApp(runtimePool,files).listen(0,'127.0.0.1');await new Promise(r=>isolated.once('listening',r));base=`http://127.0.0.1:${isolated.address().port}`;
 try{
 const owner='th_mes='+(await pool.query("select mes_private.open_account_session('mes-owner') result")).rows[0].result.sessionToken,uid=(await pool.query("select id from mes_private.records where collection='users' and data->>'username'='comment.b'")).rows[0].id,user='th_mes='+(await pool.query('select mes_private.open_account_session($1) result',[uid])).rows[0].result.sessionToken;
 const call=async(path,method='GET',data,cookie=owner)=>{const r=await fetch(base+'/api/mes/'+path,{method,headers:{'x-forwarded-host':'ticket.th.io.vn',cookie,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});let body;try{body=await r.json();}catch{}return {status:r.status,body,headers:r.headers};};
 assert.equal((await call('pages','POST',{title:'Denied'},user)).status,403);assert.equal((await call('pages','POST',{title:'Denied'},'')).status,401);
 const created=await call('pages','POST',{title:'Operations resources'});assert.equal(created.status,201,JSON.stringify(created.body));let p=created.body;assert.equal(p.active,false);assert.equal(p.visibility,'members');
 assert.equal((await call('pages/'+p.id,'GET',null,'')).status,404);
 const pdf=Buffer.from('%PDF-1.4\n% test document\n%%EOF');const reserved=await call('pages/media','POST',{name:'Training.pdf',type:'application/pdf',size:pdf.length});assert.equal(reserved.status,201);const id=reserved.body.id;
 const upload=await fetch(base+'/api/mes/uploads',{method:'POST',headers:{'x-forwarded-host':'ticket.th.io.vn',cookie:owner,'Content-Type':'application/json'},body:JSON.stringify({kind:'media',path:id,type:'application/pdf',size:pdf.length})});assert.equal(upload.status,200);const uploadId=(await upload.json()).id;assert.equal((await fetch(base+'/api/mes/uploads/'+uploadId,{method:'PATCH',headers:{'x-forwarded-host':'ticket.th.io.vn',cookie:owner,'Content-Type':'application/octet-stream','Upload-Offset':'0'},body:pdf})).status,200);
 assert.equal((await fetch(base+'/api/mes/media/'+id,{headers:{'x-forwarded-host':'ticket.th.io.vn'}})).status,404,'Unpublished page documents stay private');
 const make=(type,extra={})=>({id:crypto.randomUUID(),type,title:type,body:'Safe text',width:'half',tone:'default',links:[],media:[],...extra});const widgets=[make('heading'),make('links',{links:[{label:'Documentation',url:'https://example.com/manual'},{label:'Intranet',url:'http://192.168.1.5:8080/'},{label:'Drive',url:'Z:\\MES'},{label:'Site',url:'/page/internal'}]}),make('documents',{media:[id]})];
 assert.equal((await call('pages/'+p.id,'PUT',{...p,active:true,widgets},user)).status,403);
 assert.equal((await call('pages/'+p.id,'PUT',{...p,widgets:[make('links',{links:[{label:'Bad',url:'javascript:alert(1)'}]})]})).status,400);
 assert.equal((await call('pages/'+p.id,'PUT',{...p,widgets:[make('image',{media:[id]})]})).status,400);
 let saved=await call('pages/'+p.id,'PUT',{...p,active:true,widgets});assert.equal(saved.status,200,JSON.stringify(saved.body));p=saved.body;
 assert.deepEqual(p.widgets[1].links.map(l=>l.kind),['web','web','drive','web']);
 assert.equal((await call('pages/'+p.id,'GET',null,user)).status,200);assert.equal((await call('pages/'+p.id,'GET',null,'')).status,404);assert.equal((await call('pages','GET',null,'')).body.pages.some(x=>x.id===p.id),false);
 const memberDoc=await fetch(base+'/api/mes/media/'+id+'?inline=1',{headers:{'x-forwarded-host':'ticket.th.io.vn',cookie:user}});assert.equal(memberDoc.status,200);assert.equal(memberDoc.headers.get('content-type'),'application/pdf');assert.equal(memberDoc.headers.get('content-disposition'),null);assert.deepEqual(Buffer.from(await memberDoc.arrayBuffer()),pdf);
 assert.equal((await call('pages/'+p.id,'PUT',{...p,revision:1})).status,409);
 saved=await call('pages/'+p.id,'PUT',{...p,visibility:'public'});assert.equal(saved.status,200);p=saved.body;assert.equal((await call('pages/'+p.id,'GET',null,'')).status,200);
 const download=await fetch(base+'/api/mes/media/'+id+'?download=1',{headers:{'x-forwarded-host':'ticket.th.io.vn'}});assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/attachment;.*Training.pdf/);
 assert.equal((await call('workspace','POST',{action:'videoDelete',data:{id}})).status,409,'Playlist operations cannot remove page documents');
 assert.equal((await call('pages/'+p.id,'DELETE',{revision:p.revision},user)).status,403);assert.equal((await call('pages/'+p.id,'DELETE',{revision:p.revision})).status,200);assert.equal((await call('pages/'+p.id,'GET',null,'')).status,404);assert.equal((await fetch(base+'/api/mes/media/'+id,{headers:{'x-forwarded-host':'ticket.th.io.vn'}})).status,404);
 assert.deepEqual(await readFile(join(files,'media',id)),pdf);assert.equal((await pool.query('select count(*)::int n from public.mes_page_history where page_id=$1',[p.id])).rows[0].n,4);
 }finally{base=previousBase;await new Promise(r=>isolated.close(r));}
});

test('creation API requires photo/video evidence before allocating a ticket',async()=>{
 const isolated=createApp(runtimePool,files).listen(0,'127.0.0.1');await new Promise(resolve=>isolated.once('listening',resolve));
 const cookie='th_mes='+(await pool.query("select mes_private.open_account_session('mes-owner') result")).rows[0].result.sessionToken;
 try{for(const evidence of [undefined,null,[],[null],[{name:'notes.pdf',type:'application/pdf',size:10}]]){
 const response=await fetch(`http://127.0.0.1:${isolated.address().port}/api/mes`,{method:'POST',headers:{'x-forwarded-host':'ticket.th.io.vn','Content-Type':'application/json',cookie},body:JSON.stringify({name:'createIssue',data:{evidence,occurrences:[{kind:'point',start:new Date().toISOString()}]}})});
 assert.equal(response.status,400);assert.equal((await response.json()).code,'invalid-evidence');
 }}finally{await new Promise(resolve=>isolated.close(resolve));}
});

test('owner assigns admin/user; widget defaults inherit without overwriting personal layouts and Wi-Fi remains owner-only',async()=>{
 const previousBase=base,isolated=createApp(runtimePool,files).listen(0,'127.0.0.1');await new Promise(r=>isolated.once('listening',r));base=`http://127.0.0.1:${isolated.address().port}`;
 try{
 const session=async uid=>'th_mes='+(await pool.query('select mes_private.open_account_session($1) result',[uid])).rows[0].result.sessionToken;
 const owner=await session('mes-owner');assert.equal((await api('getSession',{},owner)).body.role,'owner');
 const account=await api('manageUser',{operation:'create',username:'widgets.admin',displayName:'Widget administrator'},owner);assert.equal(account.status,200);
 const uid=account.body.uid,user=(await api('activateAccount',{username:'widgets.admin',activationCode:account.body.activationCode,password:'test-widget-password'})).cookie;
 assert.equal((await api('getSession',{},user)).body.isAdmin,false);
 assert.equal((await api('saveDashboardDefaults',{hidden:['incidents']},user)).status,403);
 assert.equal((await api('setAccountRole',{uid:'mes-owner',role:'user'},owner)).status,403);
 assert.equal((await api('setAccountRole',{uid,role:'owner'},owner)).status,403);
 assert.equal((await api('setAccountRole',{uid,role:'admin'},user)).status,403);
 assert.equal((await api('setAccountRole',{uid,role:'admin'},owner)).status,200);
 assert.equal((await api('getSession',{},user)).status,401,'Role changes revoke old sessions');
 const admin=await session(uid);assert.equal((await api('getSession',{},admin)).body.isAdmin,true);assert.equal((await api('getSession',{},admin)).body.isOwner,false);
 assert.equal((await api('setAccountRole',{uid,role:'user'},admin)).status,403);
 assert.equal((await api('manageUser',{operation:'deactivate',uid:'mes-owner'},admin)).status,403);
 const personalBefore=(await api('getDashboardPreferences',{},owner)).body;
 assert.equal((await api('saveDashboardDefaults',{hidden:['incidents','video']},admin)).status,200);
 assert.deepEqual((await api('getDashboardDefaults')).body.hidden,['incidents','video']);
 assert.deepEqual((await api('getDashboardPreferences',{},admin)).body,{hidden:['incidents','video'],customized:false});
 assert.deepEqual((await api('getDashboardPreferences',{},owner)).body,personalBefore,'Admin defaults must preserve existing personal layouts');
 assert.equal((await api('saveDashboardPreferences',{hidden:['incidents'],uid:'mes-owner'},admin)).status,200);
 assert.deepEqual((await api('getDashboardPreferences',{},owner)).body,personalBefore,'Cannot write another account preferences');
 assert.equal((await api('saveDashboardDefaults',{hidden:['video']},admin)).status,200);
 assert.deepEqual((await api('getDashboardPreferences',{},admin)).body.hidden,['incidents']);
 assert.deepEqual((await api('resetDashboardPreferences',{},admin)).body,{hidden:['video'],customized:false});
 assert.equal((await api('saveDashboardDefaults',{hidden:['not-a-widget']},admin)).status,403);
 for(const cookie of ['',admin])for(const [path,method,body]of [['wifi','GET'],['wifi/connect','POST',{ssid:'test',password:'secret-password'}],['wifi/confirm','POST',{id:'bad'}]]){
  const response=await fetch(base+'/api/mes/'+path,{method,headers:{'x-forwarded-host':'ticket.th.io.vn',cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.notEqual(response.status,200);
 }
 const ownerWifi=await fetch(base+'/api/mes/wifi',{headers:{'x-forwarded-host':'ticket.th.io.vn',cookie:owner}});assert.equal(ownerWifi.status,200);assert.equal((await ownerWifi.json()).available,false,'No Pi broker in test environment');
 const blocked=await fetch(base+'/api/mes/wifi/connect',{method:'POST',headers:{'x-forwarded-host':'ticket.th.io.vn',cookie:owner,origin:'https://evil.test','Content-Type':'application/json'},body:'{}'});assert.equal(blocked.status,403);
 assert.equal((await api('setAccountRole',{uid,role:'user'},owner)).status,200);assert.equal((await api('getSession',{},admin)).status,401);assert.equal((await api('getSession',{},await session(uid))).body.isAdmin,false);
 assert.equal((await api('saveDashboardDefaults',{hidden:[]},owner)).status,200);
 }finally{base=previousBase;await new Promise(r=>isolated.close(r));}
});
test('dashboard includes compact state history in the existing bundle without private timeline content',async()=>{
 const id='analysis-history-test',at=Date.now();
 await pool.query("insert into mes_private.records(collection,id,data) values('issues',$1,$2)",[id,{subject:'History projection',status:'Closed',priority:'Low',createdAt:at,resolvedAt:at+2000}]);
 const events=[{kind:'handling',text:'Status: Acknowledged → Awaiting information. Priority: Critical → High. PRIVATE NOTE',authorUid:'PRIVATE AUTHOR',createdAt:at+1000},{kind:'edit',before:{priority:'High',status:'Awaiting information',description:'PRIVATE BEFORE'},after:{priority:'Low',status:'Closed',assessment:'PRIVATE ASSESSMENT'},createdAt:at+2000},{kind:'comment',text:'PRIVATE COMMENT',createdAt:at+3000}];
 for(const [index,event]of events.entries())await pool.query('insert into mes_private.records(collection,id,data) values($1,$2,$3)',[`issues/${id}/timeline`,String(index),event]);
 const listing=await api('readBundle',{paths:[{path:'issues'}]});assert.equal(listing.status,200);
 const item=listing.body.snapshots.issues.rows.find(i=>i.id===id);assert.equal(item.analysisHistory.length,2);
 assert.deepEqual(item.analysisHistory[0],{at:at+1000,beforePriority:'Critical',priority:'High',beforeStatus:'Acknowledged',status:'Awaiting information'});
 assert.equal(item.analysisHistory[1].status,'Closed');assert.ok(!JSON.stringify(item.analysisHistory).includes('PRIVATE'));
 assert.ok(!('authorUid' in item));
 await pool.query("delete from mes_private.records where (collection='issues' and id=$1) or collection=$2",[id,`issues/${id}/timeline`]);
});
test('incident colors persist per authenticated account and reject invalid colors',async()=>{
 const pref=(name,data,cookie)=>api(name,data,cookie,'ticket.th.io.vn',{'x-forwarded-for':'192.0.2.83'});
 const owner='th_mes='+(await pool.query("select mes_private.open_account_session('mes-owner') result")).rows[0].result.sessionToken;
 const uid=(await pool.query("select id from mes_private.records where collection='users' and data->>'username'='comment.b'")).rows[0].id;
 const other='th_mes='+(await pool.query('select mes_private.open_account_session($1) result',[uid])).rows[0].result.sessionToken;
 for(const name of ['getIncidentColors','saveIncidentColors'])assert.notEqual((await pref(name,{departments:{}})).status,200);
 const value={line:'#a17c00',departments:{dept:'#428c91'}};
 assert.equal((await pref('saveIncidentColors',{...value,uid:'mes-owner'},other)).status,200);
 assert.deepEqual((await pref('getIncidentColors',{},owner)).body,{});
 const fresh='th_mes='+(await pool.query('select mes_private.open_account_session($1) result',[uid])).rows[0].result.sessionToken;
 assert.deepEqual((await pref('getIncidentColors',{},fresh)).body,value);
 for(const data of [{line:'red',departments:{}},{line:null,departments:{}},{departments:[]},{departments:{dept:'url(evil)'}},{departments:{dept:123}}])assert.notEqual((await pref('saveIncidentColors',data,other)).status,200);
 assert.deepEqual((await pref('getIncidentColors',{},other)).body,value);
 assert.deepEqual((await pref('saveIncidentColors',{departments:{}},other)).body,{departments:{}});
});
test('remembered password login uses a private 30-day session and logout revokes it',async()=>{
 const request=(name,data={},cookie='')=>api(name,data,cookie,'ticket.th.io.vn',{'x-forwarded-for':'192.0.2.84'});
 const login=data=>request('passwordLogin',{username:'hpham',password:'test-owner-password',...data});
 const standard=await login({remember:false});assert.equal(standard.status,200,JSON.stringify(standard.body));assert.match(standard.headers.get('set-cookie'),/Max-Age=43200/);
 const remembered=await login({remember:true});assert.equal(remembered.status,200,JSON.stringify(remembered.body));const cookie=remembered.headers.get('set-cookie');assert.match(cookie,/Max-Age=2592000/);for(const flag of ['HttpOnly','Secure','SameSite=Lax'])assert.ok(cookie.includes(flag));assert.equal(remembered.body.sessionToken,undefined);assert.equal(remembered.body.sessionMaxAgeSeconds,undefined);
 async function remaining(session){const token=session.cookie.split('=')[1];return Number((await pool.query("select extract(epoch from expires_at-now()) seconds from mes_private.sessions where hash=$1",[hash(token)])).rows[0].seconds);}
 assert.ok(await remaining(standard)<=43200);assert.ok(await remaining(remembered)>29*86400);
 const forged=await login({remember:'true',sessionMaxAgeSeconds:2592000});assert.match(forged.headers.get('set-cookie'),/Max-Age=43200/);
 assert.equal((await request('getSession',{},remembered.cookie)).status,200);
 assert.equal((await request('logout',{},remembered.cookie)).status,200);
 assert.notEqual((await request('getSession',{},remembered.cookie)).status,200);
 assert.equal((await request('getSession',{},standard.cookie)).status,200);
});
test('metadata-only and document-only drafts stay hidden until a real image or video is attached',async()=>{
 const owner='th_mes='+(await pool.query("select mes_private.open_account_session('mes-owner') result")).rows[0].result.sessionToken;
 const department=(await pool.query("select id from mes_private.records where collection='departments' limit 1")).rows[0].id;
 const request=(name,data={},cookie=owner)=>api(name,data,cookie,'ticket.th.io.vn',{'x-forwarded-for':'192.0.2.86'});
 const created=await request('createIssue',{reporterUid:'mes-owner',departmentId:department,process:'Upload interrupted',description:'Photo metadata alone cannot publish this ticket'});assert.equal(created.status,200,JSON.stringify(created.body));const draft=created.body;assert.equal(draft.pendingEvidence,true);
 for(const cookie of ['',owner]){assert.ok(!(await request('read',{path:'issues'},cookie)).body.rows.some(i=>i.id===draft.id));assert.ok(!(await request('readBundle',{paths:[{path:'issues'}]},cookie)).body.snapshots.issues.rows.some(i=>i.id===draft.id));assert.notEqual((await request('readTicket',{id:draft.id},cookie)).status,200);}
 const fake=await request('attachFiles',{issueId:draft.id,files:[{slot:draft.uploadSlots[0],name:'fake.png',type:'image/png',size:100}]});assert.equal(fake.status,400);
 const path=`issues/${draft.id}/${draft.uploadSlots[0]}`,grant=await request('uploadUrl',{path});assert.equal(grant.status,200);
 assert.equal((await fetch(base+grant.body.url,{method:'PUT',headers:{'x-forwarded-host':'ticket.th.io.vn','x-forwarded-for':'192.0.2.86','content-type':'text/plain'},body:'only a document'})).status,200);
 const doc=await request('attachFiles',{issueId:draft.id,files:[{slot:draft.uploadSlots[0],name:'pretend.png',type:'image/png'}]});assert.equal(doc.status,200);assert.equal(doc.body.published,false);
 assert.ok(!(await request('read',{path:'issues'},'')).body.rows.some(i=>i.id===draft.id));
 await verifiedPhoto(draft,owner,1);
 for(const cookie of ['',owner]){const ticket=(await request('readTicket',{id:draft.id},cookie));assert.equal(ticket.status,200,JSON.stringify(ticket.body));assert.equal(ticket.body.pendingEvidence,false);assert.ok(ticket.body.attachments.some(f=>f.type==='image/png'));assert.ok((await request('read',{path:'issues'},cookie)).body.rows.some(i=>i.id===draft.id));}
 const edit=await request('saveTicketEdit',{id:draft.id,files:[]});assert.notEqual(edit.status,200);assert.ok((await request('readTicket',{id:draft.id})).body.attachments.some(f=>f.type==='image/png'));
});
test('only the requester can complete private pending tickets and publish without changing handling history',async()=>{
 const uid=(await pool.query("select id from mes_private.records where collection='users' and data->>'username'='comment.b'")).rows[0].id;
 const owner='th_mes='+(await pool.query("select mes_private.open_account_session('mes-owner') result")).rows[0].result.sessionToken,user='th_mes='+(await pool.query('select mes_private.open_account_session($1) result',[uid])).rows[0].result.sessionToken;
 const request=(name,data={},cookie=user)=>api(name,data,cookie,'ticket.th.io.vn',{'x-forwarded-for':'192.0.2.87'});
 const department=(await pool.query("select id from mes_private.records where collection='departments' limit 1")).rows[0].id;
 const created=await request('createIssue',{reporterUid:uid,departmentId:department,process:'Pending station',description:'MO 1234 serial ABC issue requiring evidence'});assert.equal(created.status,200,JSON.stringify(created.body));const id=created.body.id;
 const listing=await request('getMyPendingTickets');assert.equal(listing.status,200,JSON.stringify(listing.body));let pending=listing.body.rows.find(r=>r.id===id);assert.ok(pending);assert.equal(pending.submissionState,'Waiting for completion');assert.ok(pending.missingRequirements.includes('Photo or video'));assert.equal(pending.uploadSlots,undefined);
 assert.notEqual((await request('getMyPendingTickets',{},'')).status,200);assert.ok(!(await request('getMyPendingTickets',{},owner)).body.rows.some(r=>r.id===id));assert.notEqual((await request('reservePendingFiles',{id,count:1},owner)).status,200);
 await pool.query("update mes_private.records set data=data||jsonb_build_object('createdAt',(extract(epoch from now()-interval '4 days')*1000)::bigint,'status','Closed','priority','High') where collection='issues' and id=$1",[id]);
 pending=(await request('getMyPendingTickets')).body.rows.find(r=>r.id===id);
 const slot=await request('reservePendingFiles',{id,count:1});assert.equal(slot.status,200,JSON.stringify(slot.body));const path=slot.body.files[0].path;
 const grant=await request('uploadUrl',{path});assert.equal(grant.status,200,JSON.stringify(grant.body));assert.equal((await fetch(base+grant.body.url,{method:'PUT',headers:{'x-forwarded-host':'ticket.th.io.vn','x-forwarded-for':'192.0.2.87','content-type':'image/png'},body:'uploaded evidence'})).status,200);
 const data={id,occurrences:[{kind:'point',start:new Date().toISOString()}],baseUpdatedAt:pending.updatedAt,process:'Updated OP 20',departmentId:department,description:'MO 1234 serial ABC updated evidence',richDocument:{version:1,ops:[{insert:'MO 1234 serial ABC updated evidence\n'}]},files:[{path,name:'evidence.png'}],status:'New',priority:'Critical',reporterUid:'mes-owner'};
 assert.notEqual((await request('completePendingTicket',data,owner)).status,200);
 assert.notEqual((await request('completePendingTicket',{...data,files:[]})).status,200);
 assert.ok(!(await request('read',{path:'issues'},'')).body.rows.some(r=>r.id===id));
 const saved=await request('completePendingTicket',data);assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.published,true);
 assert.ok(!(await request('getMyPendingTickets')).body.rows.some(r=>r.id===id));const published=await request('readTicket',{id},'');assert.equal(published.status,200);assert.equal(published.body.status,'Closed');assert.equal(published.body.priority,'High');assert.equal(published.body.process,'Updated OP 20');assert.equal(published.body.createdAt,pending.createdAt);assert.ok((await pool.query("select 1 from mes_private.records where collection=$1 and data->>'kind'='supplemented'",[`issues/${id}/timeline`])).rowCount>0);
 const legacyId='legacy-waiting-fixture',legacy={reporterUid:uid,departmentId:department,process:'',description:'MO legacy requiring completion',status:'New',priority:'Medium',createdAt:123,updatedAt:123,attachments:[]};
 await pool.query("insert into mes_private.records(collection,id,data) values('issues',$1,$2)",[legacyId,legacy]);await pool.query('insert into mes_private.pending_ticket_legacy values($1)',[legacyId]);
 assert.deepEqual((await pool.query("select data from mes_private.records where collection='issues' and id=$1",[legacyId])).rows[0].data,legacy,'Queueing preserves original ticket JSON exactly');
 const oldPending=(await request('getMyPendingTickets')).body.rows.find(r=>r.id===legacyId);assert.ok(oldPending);assert.ok(oldPending.missingRequirements.includes('Process / Station'));assert.ok(!(await request('read',{path:'issues'},'')).body.rows.some(r=>r.id===legacyId));
 const newSlot=await request('reservePendingFiles',{id:legacyId,count:1}),newPath=newSlot.body.files[0].path,newGrant=await request('uploadUrl',{path:newPath});assert.equal(newGrant.status,200,JSON.stringify(newGrant.body));
 assert.equal((await fetch(base+newGrant.body.url,{method:'PUT',headers:{'x-forwarded-host':'ticket.th.io.vn','x-forwarded-for':'192.0.2.87','content-type':'image/png'},body:'legacy evidence'})).status,200);
 const oldSaved=await request('completePendingTicket',{...data,id:legacyId,baseUpdatedAt:123,files:[{path:newPath,name:'legacy.png'}]});assert.equal(oldSaved.status,200,JSON.stringify(oldSaved.body));assert.equal((await pool.query('select 1 from mes_private.pending_ticket_legacy where issue_id=$1',[legacyId])).rowCount,0);assert.equal((await request('readTicket',{id:legacyId},'')).status,200);

});
test('notification inboxes, templates, media and schedules enforce account/admin boundaries',async()=>{
 const users=(await pool.query("select id,data->>'username' username from mes_private.records where collection='users' and data->>'username' in ('comment.a','comment.b')")).rows;
 const a=users.find(u=>u.username==='comment.a').id,b=users.find(u=>u.username==='comment.b').id;
 await pool.query("update mes_private.credentials set role='admin' where uid=$1",[b]);
 const session=async uid=>'th_mes='+(await pool.query('select mes_private.open_account_session($1) result',[uid])).rows[0].result.sessionToken;
 const owner=await session('mes-owner'),user=await session(a),admin=await session(b);
 const request=(name,data={},cookie=admin)=>api(name,data,cookie,'ticket.th.io.vn',{'x-forwarded-for':'192.0.2.91'});
 try{
  for(const action of ['getNotifications','getNotificationAdmin','markAllNotificationsRead'])assert.notEqual((await request(action,{},'')).status,200);
  assert.notEqual((await request('getNotificationAdmin',{},user)).status,200);
  const settings=await request('getNotificationAdmin');assert.equal(settings.status,200,JSON.stringify(settings.body));assert.equal(settings.body.rules.pending.time,'08:00');
  const reservation=await request('reserveNotificationMedia',{title:'Notification image',type:'image/png',size:8});assert.equal(reservation.status,200,JSON.stringify(reservation.body));const mediaId=reservation.body.id;
  const post=async(cookie)=>fetch(base+'/api/mes/uploads',{method:'POST',headers:{'x-forwarded-host':'ticket.th.io.vn','x-forwarded-for':'192.0.2.91',cookie,'content-type':'application/json'},body:JSON.stringify({kind:'media',path:mediaId,type:'image/png',size:8})});
  assert.notEqual((await post(user)).status,200);let response=await post(admin);assert.equal(response.status,200);const upload=await response.json();response=await fetch(base+'/api/mes/uploads/'+upload.id,{method:'PATCH',headers:{'x-forwarded-host':'ticket.th.io.vn','x-forwarded-for':'192.0.2.91',cookie:admin,'content-type':'application/octet-stream','upload-offset':'0'},body:'png-data'});assert.equal(response.status,200,await response.text());
  const mediaURL=base+'/api/mes/media/'+mediaId,mediaGet=cookie=>fetch(mediaURL,{headers:{'x-forwarded-host':'ticket.th.io.vn','x-forwarded-for':'192.0.2.91',...(cookie?{cookie}:{})}});
  assert.notEqual((await mediaGet('')).status,200);assert.notEqual((await mediaGet(user)).status,200);
  const content={title:'Private notice test',description:'Personal notification',faultName:'Network error',faultMode:'Intermittent',icon:'warning',severity:'warning',media:[mediaId]};
  assert.notEqual((await request('saveNotificationTemplate',{name:'Denied',content},user)).status,200);
  const saved=await request('saveNotificationTemplate',{name:'Test template',content});assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.notEqual((await request('saveNotificationTemplate',{name:'Bad media',content:{...content,media:['not-uploaded']}})).status,200);
  const sent=await request('sendNotification',{content,audience:'selected',uids:[a],channels:['in_app','browser'],repeat:'none'});assert.equal(sent.status,200,JSON.stringify(sent.body));
  const inbox=await request('getNotifications',{},user);assert.equal(inbox.status,200,JSON.stringify(inbox.body));const notice=inbox.body.rows.find(n=>n.content.title===content.title);assert.ok(notice);assert.equal(notice.recipient_uid,undefined);assert.ok(inbox.body.media.some(m=>m.id===mediaId));assert.equal((await mediaGet(user)).status,200);
  assert.ok(!(await request('getNotifications',{},owner)).body.rows.some(n=>n.id===notice.id));
  await request('markNotificationRead',{id:String(notice.id),uid:a},admin);assert.equal((await pool.query('select read_at from mes_private.notifications where id=$1',[notice.id])).rows[0].read_at,null);
  await request('markNotificationRead',{id:String(notice.id)},user);assert.ok((await pool.query('select read_at from mes_private.notifications where id=$1',[notice.id])).rows[0].read_at);
  const broadcast=await request('sendNotification',{content:{...content,title:'Broadcast notice',media:[]},audience:'all',uids:[],channels:['in_app'],repeat:'none'});assert.equal(broadcast.status,200);
  const bNotice=(await request('getNotifications',{},admin)).body.rows.find(n=>n.content.title==='Broadcast notice');assert.ok(bNotice);await request('markAllNotificationsRead',{},user);assert.equal((await pool.query('select read_at from mes_private.notifications where id=$1',[bNotice.id])).rows[0].read_at,null);
  const future=await request('sendNotification',{content:{...content,title:'Scheduled notice',media:[]},audience:'selected',uids:[a],channels:['in_app'],repeat:'daily',sendAt:'2030-01-01T01:00:00Z'});assert.equal(future.status,200,JSON.stringify(future.body));
  assert.equal((await pool.query("select count(*)::int n from mes_private.notifications where event_key like $1",['job:'+future.body.id+':%'])).rows[0].n,0);
  for(let i=0;i<2;i++)await runtimePool.query('select public.mes_notifications_tick($1)',['2030-01-01T01:00:00Z']);assert.equal((await pool.query("select count(*)::int n from mes_private.notifications where event_key like $1",['job:'+future.body.id+':%'])).rows[0].n,1);
  await pool.query('select public.mes_notifications_tick($1)',['2030-01-02T01:00:00Z']);assert.equal((await pool.query("select count(*)::int n from mes_private.notifications where event_key like $1",['job:'+future.body.id+':%'])).rows[0].n,2);
  await request('cancelNotificationJob',{id:future.body.id});await pool.query('select public.mes_notifications_tick($1)',['2030-01-03T01:00:00Z']);assert.equal((await pool.query("select count(*)::int n from mes_private.notifications where event_key like $1",['job:'+future.body.id+':%'])).rows[0].n,2);
  const rescheduled=await request('updateNotificationJob',{id:future.body.id,content:{...content,title:'Changed schedule',media:[]},audience:'selected',uids:[a],channels:['in_app'],repeat:'none',sendAt:'2032-01-01T01:00:00Z'});assert.equal(rescheduled.status,200,JSON.stringify(rescheduled.body));
  await pool.query('select public.mes_notifications_tick($1)',['2032-01-01T01:00:00Z']);assert.equal((await pool.query("select count(*)::int n from mes_private.notifications where event_key like $1",['job:'+future.body.id+':%'])).rows[0].n,3);
  assert.notEqual((await request('sendNotification',{content,audience:'all',uids:[],channels:['in_app'],repeat:'daily',sendAt:'-infinity'})).status,200);
  assert.notEqual((await request('deleteNotificationTemplate',{id:settings.body.rules.pending.templateId})).status,200);
 }finally{await pool.query("update mes_private.credentials set role='user' where uid=$1",[b]);}
});
test('incident time is mandatory, pending reminders deduplicate daily, and ticket updates notify the requester',async()=>{
 const uid=(await pool.query("select id from mes_private.records where collection='users' and data->>'username'='comment.a'")).rows[0].id;
 const session=async id=>'th_mes='+(await pool.query('select mes_private.open_account_session($1) result',[id])).rows[0].result.sessionToken;
 const owner=await session('mes-owner'),user=await session(uid),department=(await pool.query("select id from mes_private.records where collection='departments' limit 1")).rows[0].id;
 const request=(name,data={},cookie=owner)=>api(name,data,cookie,'ticket.th.io.vn',{'x-forwarded-for':'192.0.2.92'});
 for(const occurrences of [undefined,[],[{kind:'point',start:'invalid'}],[{kind:'range',start:'2026-10-26T10:00:00Z',end:'2026-10-25T10:00:00Z'}]]){const response=await fetch(base+'/api/mes',{method:'POST',headers:{'x-forwarded-host':'ticket.th.io.vn','x-forwarded-for':'192.0.2.92',cookie:user,'content-type':'application/json'},body:JSON.stringify({name:'createIssue',data:{occurrences,evidence:[{name:'image.png',size:8,type:'image/png'}]}})});assert.equal(response.status,400);assert.equal((await response.json()).code,'invalid-incident-time');}
 const created=await request('createIssue',{reporterUid:uid,departmentId:department,process:'OP notice',description:'MO 123 notification lifecycle'},user);assert.equal(created.status,200,JSON.stringify(created.body));
 const config=(await request('getNotificationAdmin')).body.rules.pending;const rule={...config,time:'08:00',minDays:0,days:['1'],channels:['in_app','browser']};assert.equal((await request('saveNotificationRule',{id:'pending',config:rule})).status,200);
 assert.notEqual((await request('saveNotificationRule',{id:'pending',config:{...rule,time:'99:00'}})).status,200);assert.notEqual((await request('saveNotificationRule',{id:'pending',config:{...rule,days:[]}})).status,200);
 await pool.query('select public.mes_notifications_tick($1)',['2031-01-06T00:59:00Z']);const event='pending:'+uid+':2031-01-06';assert.equal((await pool.query('select count(*)::int n from mes_private.notifications where recipient_uid=$1 and event_key=$2',[uid,event])).rows[0].n,0);
 await pool.query('select public.mes_notifications_tick($1)',['2031-01-06T01:00:00Z']);await pool.query('select public.mes_notifications_tick($1)',['2031-01-06T05:00:00Z']);assert.equal((await pool.query('select count(*)::int n from mes_private.notifications where recipient_uid=$1 and event_key=$2',[uid,event])).rows[0].n,1);
 await pool.query('select public.mes_notifications_tick($1)',['2031-01-07T01:00:00Z']);assert.equal((await pool.query('select count(*)::int n from mes_private.notifications where recipient_uid=$1 and event_key=$2',[uid,'pending:'+uid+':2031-01-07'])).rows[0].n,0,'Unselected weekdays must not send reminders');
 await verifiedPhoto(created.body,user);const before=(await pool.query("select count(*)::int n from mes_private.notifications where recipient_uid=$1 and ticket_id=$2",[uid,created.body.id])).rows[0].n;
 const update={id:created.body.id,operation:'handling',status:'In progress',priority:'High',progress:30,assessment:'Working on it'};assert.equal((await request('updateIssue',update)).status,200);
 const after=(await pool.query("select content from mes_private.notifications where recipient_uid=$1 and ticket_id=$2 order by id desc",[uid,created.body.id])).rows;assert.equal(after.length,before+1);assert.ok(after[0].content.description.includes('30'));
 assert.equal((await request('updateIssue',update)).status,200);assert.equal((await pool.query('select count(*)::int n from mes_private.notifications where recipient_uid=$1 and ticket_id=$2',[uid,created.body.id])).rows[0].n,after.length);
 assert.notEqual((await request('updateIssue',{...update,progress:101})).status,200);assert.equal((await pool.query('select count(*)::int n from mes_private.notifications where recipient_uid=$1 and ticket_id=$2',[uid,created.body.id])).rows[0].n,after.length);
 const ticket=(await request('readTicket',{id:created.body.id})).body;
 const edited=await request('saveTicketEdit',{id:ticket.id,baseUpdatedAt:ticket.updatedAt,subject:'Administrator edited the description',process:ticket.process,departmentId:ticket.departmentId,issueTypeId:ticket.issueTypeId||'',reporterUid:uid,status:ticket.status,priority:ticket.priority,progress:ticket.progress,assessment:ticket.assessment||'',richDocument:{version:1,ops:[{insert:'Administrator edited the description with MO details.\n'}]},occurrences:ticket.occurrences,files:ticket.attachments.map((f,index)=>({path:f.path,name:f.name,slotIndex:f.slotIndex??index}))});assert.equal(edited.status,200,JSON.stringify(edited.body));assert.equal((await pool.query('select count(*)::int n from mes_private.notifications where recipient_uid=$1 and ticket_id=$2',[uid,ticket.id])).rows[0].n,after.length+1,'A full ticket edit must emit one notification, not one per internal update');
 const alertConfig=(await request('getNotificationAdmin')).body.rules.priority_alert;assert.equal((await request('saveNotificationRule',{id:'priority_alert',config:{...alertConfig,enabled:true,audience:'admins',priorities:['Critical']}})).status,200);
 assert.equal((await request('updateIssue',{...update,priority:'Critical',progress:40})).status,200);assert.ok((await pool.query("select 1 from mes_private.notifications where recipient_uid='mes-owner' and ticket_id=$1 and event_key like 'alert:%'",[ticket.id])).rowCount>0);assert.equal((await pool.query("select 1 from mes_private.notifications where recipient_uid=$1 and ticket_id=$2 and event_key like 'alert:%'",[uid,ticket.id])).rowCount,0);

});

test('portfolio content uses verified admin sessions, optimistic versions and private media publication',async()=>{
 const {rows:[owner]}=await pool.query("insert into portfolio.users(email,password,name,verified,admin) values('content-owner@example.test',extensions.crypt('test-owner-password',extensions.gen_salt('bf',4)),'Owner',true,true) returning *");
 const login=await api('login',{email:owner.email,password:'test-owner-password'},'','th.io.vn',{'x-forwarded-for':'192.0.2.209'});assert.equal(login.status,200);const cookie=login.cookie;
 const headers={'x-forwarded-host':'th.io.vn','x-forwarded-for':'192.0.2.210'};
 const request=(path='',options={},auth='')=>fetch(base+'/api/portfolio/content/'+path,{...options,headers:{...headers,...(auth?{cookie:auth}:{}),...options.headers}});
 assert.equal((await request('admin')).status,403);assert.equal((await request('',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 const initial=await (await request('')).json();assert.ok(initial.journey.length>=6);assert.equal(initial.family.length,0);
 const draft=await (await request('admin',{},cookie)).json();
 const bytes=Buffer.from('89504e470d0a1a0a0000000000000000','hex');
 const bad=await request('upload',{method:'POST',headers:{'Content-Type':'image/png','X-File-Name':'fake.png'},body:Buffer.from('not an image')},cookie);assert.equal(bad.status,400);
 const upload=await request('upload',{method:'POST',headers:{'Content-Type':'image/png','X-File-Name':'family.png'},body:bytes},cookie);assert.equal(upload.status,201);const photo=(await upload.json()).id;
 assert.equal((await request('media/'+photo)).status,404);assert.equal((await request('media/'+photo,{},cookie)).status,200);
 draft.family.push({id:'family-chapter',title:'Private family chapter',subtitle:'Family',description:'This is private until explicitly published.',tags:[],media:[photo],public:false});
 const save=()=>request('',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)},cookie);
 const saved=await save();assert.equal(saved.status,200,await saved.clone().text());draft.version=(await saved.json()).version;
 assert.equal((await (await request('')).json()).family.length,0);assert.equal((await request('media/'+photo)).status,404);
 draft.family[0].public=true;const published=await save();assert.equal(published.status,200);const next=(await published.json()).version;
 assert.equal((await save()).status,409,'stale editor must not overwrite');draft.version=next;
 assert.equal((await (await request('')).json()).family[0].title,'Private family chapter');assert.equal((await request('media/'+photo)).status,200);
 assert.equal((await request('media/'+photo,{method:'DELETE'},cookie)).status,409,'cannot delete referenced media');
 const originalDate=draft.journey[0].date;draft.journey[0].date='2026-02-31';assert.equal((await save()).status,400);draft.journey[0].date=originalDate;
 draft.family[0].public=false;const hidden=await save();assert.equal(hidden.status,200);draft.version=(await hidden.json()).version;assert.equal((await request('media/'+photo)).status,404,'unpublishing must revoke anonymous bytes');
 const previousPortrait=draft.profile.portrait;draft.profile.portrait=photo;const portraitSaved=await save();assert.equal(portraitSaved.status,200);draft.version=(await portraitSaved.json()).version;const portraitResponse=await request('media/'+photo);assert.equal(portraitResponse.status,200);assert.equal(portraitResponse.headers.get('cache-control'),'private, max-age=0, must-revalidate');const modified=portraitResponse.headers.get('last-modified');assert.ok(modified);await portraitResponse.arrayBuffer();draft.profile.portrait=previousPortrait;const portraitReset=await save();assert.equal(portraitReset.status,200);draft.version=(await portraitReset.json()).version;assert.equal((await request('media/'+photo,{headers:{'If-Modified-Since':modified}})).status,404,'a cached portrait must not bypass revocation');
 const audio=await request('upload',{method:'POST',headers:{'Content-Type':'audio/mpeg','X-File-Name':'sound.mp3'},body:Buffer.from('ID3-test-audio-header')},cookie);assert.equal(audio.status,201);draft.profile.music=(await audio.json()).id;draft.profile.musicPublic=false;
 const soundtrack=await save();assert.equal(soundtrack.status,200);draft.version=(await soundtrack.json()).version;assert.equal((await request('media/'+draft.profile.music)).status,404);draft.profile.musicPublic=true;
 const liveMusic=await save();assert.equal(liveMusic.status,200);draft.version=(await liveMusic.json()).version;assert.equal((await request('media/'+draft.profile.music)).status,200);
 draft.family=[];const removed=await save();assert.equal(removed.status,200);draft.version=(await removed.json()).version;
 assert.equal((await request('media/'+photo,{method:'DELETE'},cookie)).status,200);assert.equal((await request('media/'+photo,{},cookie)).status,404);
 const revoked=await api('logout',{},cookie,'th.io.vn',{'x-forwarded-for':'192.0.2.211'});assert.equal(revoked.status,200);assert.equal((await request('admin',{},cookie)).status,403);
});

test('personal home supports GIF/video chapters, private introduction posters and editable site copy',async()=>{
 const {rows:[user]}=await pool.query("insert into portfolio.users(email,password,name,verified,admin) values('home-owner@example.test',extensions.crypt('test-owner-password',extensions.gen_salt('bf',4)),'Home Owner',true,true) returning *");
 const login=await api('login',{email:user.email,password:'test-owner-password'},'','th.io.vn',{'x-forwarded-for':'192.0.2.214'});const cookie=login.cookie;
 const request=(path='',options={},auth='')=>fetch(base+'/api/portfolio/content/'+path,{...options,headers:{'x-forwarded-host':'th.io.vn','x-forwarded-for':'192.0.2.215',...(auth?{cookie:auth}:{}),...options.headers}});
 const upload=async(type,body)=>{const r=await request('upload',{method:'POST',headers:{'Content-Type':type,'X-File-Name':'sample'},body},cookie);assert.equal(r.status,201,await r.clone().text());return(await r.json()).id;};
 const gif=await upload('image/gif',Buffer.from('GIF89a-test-header'));
 const video=await upload('video/mp4',Buffer.from('000000186674797069736f6d00000000','hex'));
 const webm=await upload('video/webm',Buffer.from('1a45dfa3000000000000000000000000','hex'));
 const fake=await request('upload',{method:'POST',headers:{'Content-Type':'video/mp4'},body:Buffer.from('a fake MP4 video')},cookie);assert.equal(fake.status,400);
 const draft=await(await request('admin',{},cookie)).json();assert.ok(Array.isArray(draft.hobbies));
 draft.copy={'copy-test':'Edited plain text <script> is literal'};draft.hobbies.push({id:'my-hobby',title:'My hobby',subtitle:'Personal',description:'Editable personal content.',tags:['Personal'],media:[gif,webm],public:false});draft.journey[0].media=[video,gif];draft.profile.introVideo=video;draft.profile.introPoster=gif;draft.profile.introPublic=false;
 const save=async()=>{const r=await request('',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)},cookie);assert.equal(r.status,200,await r.clone().text());draft.version=(await r.json()).version;};await save();
 const ownerView=await(await request('',{},cookie)).json();assert.equal(ownerView.adminView,true);assert.equal(ownerView.hobbies[0].title,'My hobby');assert.equal(ownerView.profile.introPoster,gif);const guestPreview=await(await request('?view=public',{},cookie)).json();assert.equal(guestPreview.hobbies.length,0);assert.equal(guestPreview.profile.introVideo,'');
 let visible=await(await request('')).json();assert.equal(visible.hobbies.length,0);assert.equal(visible.profile.introVideo,'');assert.equal(visible.profile.introPoster,'');assert.equal(visible.mediaTypes[webm],undefined);assert.equal((await request('media/'+webm)).status,404);
 assert.equal(visible.mediaTypes[video],'video/mp4');assert.equal(visible.journey[0].media[0],video);assert.equal(visible.copy['copy-test'],draft.copy['copy-test']);
 const range=await request('media/'+video,{headers:{range:'bytes=0-7'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,8);
 draft.hobbies[0].public=true;draft.profile.introPublic=true;await save();visible=await(await request('')).json();assert.equal(visible.mediaTypes[webm],'video/webm');assert.equal(visible.profile.introPoster,gif);assert.equal((await request('media/'+webm)).status,200);
 draft.sections.hobbies=false;await save();visible=await(await request('')).json();assert.equal(visible.hobbies.length,0);assert.equal((await request('media/'+webm)).status,404,'hidden group must revoke private bytes');
 draft.profile.introVideo=gif;const wrong=await request('',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)},cookie);assert.equal(wrong.status,400,'introduction needs actual video metadata');
 const badCopy={...draft,copy:{unsafe:{html:'bad'}}};const invalid=await request('',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(badCopy)},cookie);assert.equal(invalid.status,400);
});

test('portfolio descriptions inherit media visibility, title styles persist and visit history is administrator-only',async()=>{
 const {rows:[owner]}=await pool.query("insert into portfolio.users(email,password,name,verified,admin) values('layout-owner@example.test',extensions.crypt('test-owner-password',extensions.gen_salt('bf',4)),'Layout Owner',true,true) returning *");
 const {rows:[member]}=await pool.query("insert into portfolio.users(email,password,name,verified) values('visitor-member@example.test',extensions.crypt('test-user-password',extensions.gen_salt('bf',4)),'Visitor Member',true) returning *");
 const ownerLogin=await api('login',{email:owner.email,password:'test-owner-password'},'','th.io.vn',{'x-forwarded-for':'192.0.2.231'}),memberLogin=await api('login',{email:member.email,password:'test-user-password'},'','th.io.vn',{'x-forwarded-for':'192.0.2.232'});
 const request=(path='',options={},cookie='')=>fetch(base+'/api/portfolio/content/'+path,{...options,headers:{'x-forwarded-host':'th.io.vn','x-forwarded-for':'192.0.2.233',...(cookie?{cookie}:{}),...options.headers}});
 const upload=async(type,body)=>{const r=await request('upload',{method:'POST',headers:{'Content-Type':type},body},ownerLogin.cookie);assert.equal(r.status,201);return(await r.json()).id;};
 const image=await upload('image/gif',Buffer.from('GIF89a-private-image')),child=await upload('video/webm',Buffer.from('1a45dfa3000000000000000000000000','hex'));
 const draft=await(await request('admin',{},ownerLogin.cookie)).json();draft.hobbies.push({id:'described-image',title:'Private caption parent',subtitle:'',description:'',tags:[],media:[image],public:false});draft.mediaDescriptions[image]={title:'A caption',description:'With private video',media:[child]};draft.titleStyles={'profile-name':{font:'Georgia',size:42,color:'#bbaacc'}};
 const save=async()=>{const r=await request('',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)},ownerLogin.cookie);assert.equal(r.status,200,await r.clone().text());draft.version=(await r.json()).version;};await save();
 let visible=await(await request('')).json();assert.equal(visible.mediaDescriptions[image],undefined);assert.equal((await request('media/'+child)).status,404);assert.equal((await request('media/'+child,{},ownerLogin.cookie)).status,200);
 draft.hobbies.at(-1).public=true;draft.sections.hobbies=true;await save();visible=await(await request('')).json();assert.equal(visible.mediaDescriptions[image].title,'A caption');assert.equal((await request('media/'+child)).status,200);assert.equal(visible.titleStyles['profile-name'].font,'Georgia');
 draft.titleStyles['profile-name'].font='url(unsafe)';const bad=await request('',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)},ownerLogin.cookie);assert.equal(bad.status,400);
 assert.equal((await request('visits')).status,403);assert.equal((await request('visits',{},memberLogin.cookie)).status,403);
 const payload={path:'/#experience',uid:owner.id,referrer:'https://search.example.test/path?secret=must-not-save'};
 const visit=await request('visits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});assert.equal(visit.status,204);const viewerCookie=visit.headers.get('set-cookie').split(';')[0];assert.match(visit.headers.get('set-cookie'),/HttpOnly/);assert.match(visit.headers.get('set-cookie'),/Secure/);
 const before=(await pool.query('select count(*)::int n from portfolio.visits')).rows[0].n;
 await request('visits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)},viewerCookie);assert.equal((await pool.query('select count(*)::int n from portfolio.visits')).rows[0].n,before,'reload within 30 seconds deduplicates anonymous view');
 assert.equal((await request('visits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/?password=secret'})},viewerCookie)).status,400);
 await request('visits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/#about'})},memberLogin.cookie);
 const history=await(await request('visits',{},ownerLogin.cookie)).json();assert.ok(history.rows.some(r=>r.role==='viewer'&&!r.account_email));assert.ok(history.rows.some(r=>r.role==='user'&&r.account_email===member.email));assert.ok(history.rows.every(r=>!r.visitor_hash));assert.equal(history.rows.find(r=>r.role==='viewer').referrer,'https://search.example.test');
 assert.equal((await request('visits?from=bad',{},ownerLogin.cookie)).status,400);
});

test('portfolio HEIC uploads become verified private JPEGs and malformed HEIC is removed',async()=>{
 const {rows:[owner]}=await pool.query("insert into portfolio.users(email,password,name,verified,admin) values('heic-owner@example.test',extensions.crypt('test-owner-password',extensions.gen_salt('bf',4)),'HEIC Owner',true,true) returning *");
 const login=await api('login',{email:owner.email,password:'test-owner-password'},'','th.io.vn',{'x-forwarded-for':'192.0.2.241'});
 const request=(path='',options={},cookie=login.cookie)=>fetch(base+'/api/portfolio/content/'+path,{...options,headers:{'x-forwarded-host':'th.io.vn','x-forwarded-for':'192.0.2.242',...(cookie?{cookie}:{}),...options.headers}});
 const input=Buffer.from(await readFile('tests/fixtures/two-colors.heic.base64','utf8'),'base64');
 const upload=await request('upload',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':'phone.HEIC'},body:input});assert.equal(upload.status,201,await upload.clone().text());const image=await upload.json();assert.equal(image.type,'image/jpeg');assert.equal(image.name,'phone.jpg');
 assert.equal((await request('media/'+image.id,{},'')).status,404);const rendered=await request('media/'+image.id);assert.equal(rendered.status,200);assert.match(rendered.headers.get('content-type'),/image\/jpeg/);assert.deepEqual([...new Uint8Array(await rendered.arrayBuffer()).subarray(0,3)],[255,216,255]);
 const {rows:[saved]}=await pool.query('select ready,type,size from portfolio.media where id=$1',[image.id]);assert.equal(saved.ready,true);assert.equal(saved.type,'image/jpeg');assert.ok(Number(saved.size)>0);
 const before=Number((await pool.query('select count(*) from portfolio.media')).rows[0].count);
 const broken=await request('upload',{method:'POST',headers:{'Content-Type':'image/heic','X-File-Name':'bad.heic'},body:Buffer.from('000000186674797068656963000000006d69663168656963','hex')});assert.equal(broken.status,400);assert.equal(Number((await pool.query('select count(*) from portfolio.media')).rows[0].count),before);
});

test('only the owner can save timeline layout; positions persist without overwriting content',async()=>{
 const {rows:[owner]}=await pool.query("insert into portfolio.users(email,password,name,verified,admin) values('layout-drag-owner@example.test',extensions.crypt('test-owner-password',extensions.gen_salt('bf',4)),'Layout Owner',true,true) returning *");
 const login=await api('login',{email:owner.email,password:'test-owner-password'},'','th.io.vn',{'x-forwarded-for':'192.0.2.251'});
 const request=(path='',options={},cookie=login.cookie)=>fetch(base+'/api/portfolio/content/'+path,{...options,headers:{'x-forwarded-host':'th.io.vn','x-forwarded-for':'192.0.2.252',...(cookie?{cookie}:{}),...options.headers}});
 const current=await(await request('admin')).json(),positions={'2016-10-01':{dx:40,dy:80,width:280,height:120},'2001-02-03':{dx:0,dy:50}};
 const patch=(version,positions,cookie=login.cookie)=>request('layout',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({version,positions})},cookie);
 assert.equal((await patch(current.version,positions,'')).status,403);const saved=await patch(current.version,positions);assert.equal(saved.status,200,await saved.clone().text());const result=await saved.json();assert.equal(result.version,current.version+1);
 const next=await(await request('admin')).json();assert.deepEqual(next.timelineLayout,positions);assert.deepEqual(next.profile,current.profile);assert.deepEqual(next.journey,current.journey);assert.equal((await patch(current.version,{})).status,409);assert.equal((await patch(result.version,{present:{dx:10000,dy:0}})).status,400);const visible=await(await request('',{},'')).json();assert.equal(visible.timelineLayout['2001-02-03'],undefined);assert.deepEqual(visible.timelineLayout['2016-10-01'],positions['2016-10-01']);
});
