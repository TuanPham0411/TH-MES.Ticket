import {validateTimelineLayout} from '../site/manual-timeline-layout.js';
import {isHeic} from './heic-format.js';
import {normalizeHeicFile} from './heic-upload.js';
import {Router} from 'express';
import {randomUUID} from 'node:crypto';
import {mkdir,rm,open} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {dirname} from 'node:path';
import {hash,token} from './security.js';
import {filePath,storageQuota,deleteEverywhere} from './storage.js';
import {defaultPortfolio,publicPortfolio,referencedMedia,validatePortfolio,normalizePortfolio,groups} from '../site/portfolio-model.js';
const error=(status,message)=>Object.assign(new Error(message),{status,expose:true});
const types=new Set(['image/heic','image/heif','image/heic-sequence','image/heif-sequence','image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','audio/mpeg','audio/mp4','audio/ogg','audio/wav']);
export function portfolioContentRouter(pool,root){
 const router=Router();
 async function admin(req){const {rows:[user]}=await pool.query('select u.id from portfolio.users u join portfolio.sessions s on s.uid=u.id where s.hash=$1 and s.expires>now() and u.admin and u.verified',[hash(req.cookies.th_portfolio||'')]);return user;}
 async function load(db=pool){const {rows:[row]}=await db.query("select version,data from portfolio.content where id='main'");const value=normalizePortfolio(row?{...row.data,version:row.version}:defaultPortfolio);const all=referencedMedia(value);for(const [id,desc]of Object.entries(value.mediaDescriptions)){all.add(id);for(const child of desc.media)all.add(child);}const ids=[...all].filter(id=>/^[a-f0-9-]{36}$/.test(id));const {rows}=await db.query('select id,type from portfolio.media where ready and id=any($1::uuid[])',[ids]);value.mediaTypes=Object.fromEntries(rows.map(m=>[m.id,m.type]));for(const id of Object.keys(value.mediaDescriptions))if(!id.startsWith('asset:')&&!value.mediaTypes[id])delete value.mediaDescriptions[id];return value;}

 router.get('/',async(req,res)=>{const value=await load();res.json(req.query.view!=='public'&&await admin(req)?{...value,adminView:true}:publicPortfolio(value));});
 router.get('/admin',async(req,res)=>{if(!await admin(req))throw error(403,'Administrator required');res.json(await load());});
 router.put('/',async(req,res)=>{
 const user=await admin(req);if(!user)throw error(403,'Administrator required');
 let value;try{value=validatePortfolio(req.body);}catch(e){throw error(400,e.message);}
 const allRefs=referencedMedia(value);for(const [id,desc]of Object.entries(value.mediaDescriptions)){allRefs.add(id);for(const child of desc.media)allRefs.add(child);}const refs=[...allRefs].filter(id=>!id.startsWith('asset:'));
 for(const ref of allRefs)if(ref.startsWith('asset:')&&!['asset:/images/profile.webp','asset:/images/ot-hero.webp'].includes(ref))throw error(400,'Invalid built-in image');
 if(refs.some(id=>!/^[a-f0-9-]{36}$/.test(id)))throw error(400,'Invalid media');
 const db=await pool.connect();try{await db.query('begin');await db.query('select pg_advisory_xact_lock(74529101)');
 const {rows}=await db.query('select id,type from portfolio.media where ready and id=any($1::uuid[])',[refs]);if(rows.length!==refs.length)throw error(400,'Upload images and music before saving');
 const metadata=new Map(rows.map(m=>[m.id,m.type]));
 if(value.profile.music&&!metadata.get(value.profile.music)?.startsWith('audio/'))throw error(400,'Choose an audio track');
 if(value.profile.portrait&&!value.profile.portrait.startsWith('asset:')&&!metadata.get(value.profile.portrait)?.startsWith('image/'))throw error(400,'Choose a portrait image');
 for(const key of ['portrait','heroImage','aboutImage','introPoster'])if(value.profile[key]&&!value.profile[key].startsWith('asset:')&&!metadata.get(value.profile[key])?.startsWith('image/'))throw error(400,'Choose an image for '+key);
 if(value.profile.introVideo&&!metadata.get(value.profile.introVideo)?.startsWith('video/'))throw error(400,'Choose an MP4 or WebM introduction video');
 for(const key of groups)for(const item of value[key])for(const id of item.media)if(!id.startsWith('asset:')&&!/^(image|video)\//.test(metadata.get(id)||''))throw error(400,'Galleries accept images, GIF and video');
 for(const [id,desc]of Object.entries(value.mediaDescriptions)){
 if(!id.startsWith('asset:')&&!metadata.get(id)?.startsWith('image/')){
  const found=await db.query('select type from portfolio.media where id::text=$1 and ready',[id]);if(!found.rows[0]?.type.startsWith('image/'))throw error(400,'Descriptions require an uploaded image');
 }
 for(const child of desc.media)if(!child.startsWith('asset:')&&!/^(image|video)\//.test(metadata.get(child)||''))throw error(400,'Description media must be published through its parent image');
 }
 value.mediaTypes=Object.fromEntries(metadata);
 const data={...value};delete data.version;delete data.adminView;
 const result=await db.query("insert into portfolio.content(id,version,data,updated_by) select 'main',1,$2,$3 where $1=0 on conflict(id) do nothing returning version",[value.version,data,user.id]);
 const saved=result.rowCount?result:await db.query("update portfolio.content set data=$2,version=version+1,updated_by=$3,updated_at=now() where id='main' and version=$1 returning version",[value.version,data,user.id]);
 if(!saved.rowCount)throw error(409,'Content changed in another tab. Reload before editing.');await db.query('commit');res.json({version:saved.rows[0].version});
 }catch(e){await db.query('rollback');throw e;}finally{db.release();}
 });
 router.patch('/layout',async(req,res)=>{
 const user=await admin(req);if(!user)throw error(403,'Administrator required');
 let positions;try{positions=validateTimelineLayout(req.body?.positions);}catch(e){throw error(400,e.message);}
 if(!Number.isInteger(req.body?.version))throw error(400,'Invalid content version');const db=await pool.connect();
 try{await db.query('begin');await db.query('select pg_advisory_xact_lock(74529101)');const current=await load(db);if(current.version!==req.body.version)throw error(409,'Content changed in another tab. Reload before saving the layout.');
 const saved=await db.query("update portfolio.content set data=jsonb_set(data,'{timelineLayout}',$2::jsonb),version=version+1,updated_by=$3,updated_at=now() where id='main' and version=$1 returning version",[current.version,JSON.stringify(positions),user.id]);
 let version=saved.rows[0]?.version;if(!version){const data={...current,timelineLayout:positions};delete data.version;await db.query("insert into portfolio.content(id,version,data,updated_by) values('main',1,$1,$2)",[data,user.id]);version=1;}await db.query('commit');res.json({version,positions});
 }catch(e){await db.query('rollback');throw e;}finally{db.release();}
 });
 router.post('/upload',async(req,res)=>{
 const user=await admin(req);if(!user)throw error(403,'Administrator required');
 let type=req.headers['content-type']?.split(';')[0];const size=Number(req.headers['content-length']);
 let name;try{name=decodeURIComponent(req.headers['x-file-name']||'Upload').slice(0,180);}catch{throw error(400,'Invalid filename');}
 if((!type||type==='application/octet-stream')&&/\.hei[cf]$/i.test(name))type='image/heic';
 if(!types.has(type)||!Number.isSafeInteger(size)||size<=0||size>(type.startsWith('video/')?96:type.startsWith('audio/')?40:12)*1024*1024)throw error(400,'Use JPG, PNG, WebP, GIF, HEIC/HEIF (12 MB), MP4/WebM (96 MB) or audio (40 MB)');
 const id=randomUUID(),db=await pool.connect();
 try{await db.query('begin');await db.query('select pg_advisory_xact_lock(74529101)');const {rows:[used]}=await db.query('select coalesce(sum(size),0)::bigint size from portfolio.media');if(Number(used.size)+size>Math.min(storageQuota(),2*1024**3))throw error(413,'Portfolio media storage limit reached');await db.query('insert into portfolio.media(id,type,size,name,created_by) values($1,$2,$3,$4,$5)',[id,type,size,name,user.id]);await db.query('commit');}catch(e){await db.query('rollback');throw e;}finally{db.release();}
 let path,total=0;
 try{path=await filePath(root,`portfolio/${id}`,true);await mkdir(dirname(path),{recursive:true});await pipeline(req,new Transform({transform(chunk,enc,cb){total+=chunk.length;cb(total>size?error(413,'Upload too large'):null,chunk);}}),createWriteStream(path,{flags:'wx',mode:0o600}));if(total!==size)throw error(400,'Incomplete upload');
 const file=await open(path,'r');let b;try{b=Buffer.alloc(16);await file.read(b,0,16,0);}finally{await file.close();}
 const heic=/^image\/hei[cf]/.test(type);const valid=heic?isHeic(b):type==='image/gif'?['GIF87a','GIF89a'].includes(b.toString('ascii',0,6)):type==='video/mp4'?b.toString('ascii',4,8)==='ftyp':type==='video/webm'?b.subarray(0,4).equals(Buffer.from([26,69,223,163])):type==='image/png'?b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):type==='image/jpeg'?b[0]===255&&b[1]===216&&b[2]===255:type==='image/webp'?b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP':type==='audio/ogg'?b.toString('ascii',0,4)==='OggS':type==='audio/wav'?b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WAVE':type==='audio/mp4'?b.toString('ascii',4,8)==='ftyp':b.toString('ascii',0,3)==='ID3'||b[0]===255&&(b[1]&224)===224;
 if(!valid)throw error(400,'File contents do not match the selected format');
 let savedType=type,savedSize=size;
 if(heic){const converted=await normalizeHeicFile(path);savedType=converted.type;savedSize=converted.size;name=name.replace(/\.hei[cf]$/i,'').slice(0,176)+'.jpg';}
 const final=await pool.connect();try{await final.query('begin');await final.query('select pg_advisory_xact_lock(74529101)');const {rows:[used]}=await final.query('select coalesce(sum(size),0)::bigint size from portfolio.media');if(Number(used.size)-size+savedSize>Math.min(storageQuota(),2*1024**3))throw error(413,'Portfolio media storage limit reached');await final.query('update portfolio.media set ready=true,type=$2,size=$3,name=$4 where id=$1',[id,savedType,savedSize,name]);await final.query('commit');}catch(e){await final.query('rollback');throw e;}finally{final.release();}
 res.status(201).json({id,type:savedType,name});
 }catch(e){if(path)await rm(path,{force:true});await pool.query('delete from portfolio.media where id=$1',[id]);throw e;}
 });

 router.post('/visits',async(req,res)=>{
  const data=req.body||{},path=data.path;
  if(typeof path!=='string'||!/^\/(?:resume\.html)?(?:#[a-zA-Z0-9_-]{1,80})?$/.test(path))throw error(400,'Invalid page path');
  let visitor=req.cookies.th_visit;if(!/^[a-f0-9]{64}$/.test(visitor||'')){visitor=token();res.cookie('th_visit',visitor,{httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:86400000});}
  const {rows:[account]}=await pool.query('select u.* from portfolio.users u join portfolio.sessions s on s.uid=u.id where s.hash=$1 and s.expires>now()',[hash(req.cookies.th_portfolio||'')]);
  let referrer='';try{if(data.referrer)referrer=new URL(data.referrer).origin.slice(0,200);}catch{}
  const values=[hash(visitor),account?.id||null,account?.name||'',account?.email||'',account?(account.admin&&account.verified?'admin':'user'):'viewer',path,referrer,String(req.headers['user-agent']||'').slice(0,180)];
  await pool.query(`insert into portfolio.visits(visitor_hash,uid,account_name,account_email,role,path,referrer,browser) select $1,$2,$3,$4,$5,$6,$7,$8 where not exists(select 1 from portfolio.visits where visitor_hash=$1 and uid is not distinct from $2::text and path=$6 and created_at>now()-interval '30 seconds')`,values);
  await pool.query("delete from portfolio.visits where created_at<now()-interval '90 days'");res.status(204).end();
 });
 router.get('/visits',async(req,res)=>{
  if(!await admin(req))throw error(403,'Administrator required');
  const from=req.query.from||new Date(Date.now()-7*86400000).toISOString(),to=req.query.to||new Date().toISOString(),role=req.query.role||'',search=String(req.query.search||'').slice(0,120),before=req.query.before||'9999-12-31T00:00:00Z';
  if(![from,to,before].every(x=>typeof x==='string'&&Number.isFinite(Date.parse(x)))||Date.parse(from)>Date.parse(to)||!['','viewer','user','admin'].includes(role))throw error(400,'Invalid visit filters');
  const args=[from,to,role,'%'+search+'%',before];
  const {rows}=await pool.query(`select id,substring(visitor_hash,1,12) visitor,account_name,account_email,role,path,referrer,browser,created_at,last_seen from portfolio.visits where created_at between $1::timestamptz and $2::timestamptz and ($3='' or role=$3) and (account_name ilike $4 or account_email ilike $4 or substring(visitor_hash,1,12) ilike $4 or path ilike $4) and created_at<$5::timestamptz order by created_at desc limit 51`,args);
  const summary=await pool.query(`select count(*)::int views,count(distinct visitor_hash)::int visitors,count(distinct uid)::int accounts from portfolio.visits where created_at between $1::timestamptz and $2::timestamptz`,[from,to]);
  res.json({rows:rows.slice(0,50),hasMore:rows.length>50,summary:summary.rows[0],retentionDays:90});
 });

 router.get('/library',async(req,res)=>{if(!await admin(req))throw error(403,'Administrator required');res.json({rows:(await pool.query('select id,type,size,name from portfolio.media where ready order by created_at desc limit 500')).rows});});
 router.delete('/media/:id',async(req,res)=>{
 if(!await admin(req))throw error(403,'Administrator required');if(!/^[a-f0-9-]{36}$/.test(req.params.id))throw error(400,'Invalid media');
 const db=await pool.connect();try{await db.query('begin');await db.query('select pg_advisory_xact_lock(74529101)');const content=await load(db);if(referencedMedia(content).has(req.params.id)||Object.values(content.mediaDescriptions).some(desc=>desc.media.includes(req.params.id)))throw error(409,'Remove this media from content and save before deleting');await deleteEverywhere(root,`portfolio/${req.params.id}`);await db.query('delete from portfolio.media where id=$1',[req.params.id]);await db.query('commit');}catch(e){await db.query('rollback');throw e;}finally{db.release();}res.json({ok:true});
 });
 router.get('/media/:id',async(req,res)=>{if(!/^[a-f0-9-]{36}$/.test(req.params.id))return res.sendStatus(404);const content=publicPortfolio(await load());if(!referencedMedia(content).has(req.params.id)&&!await admin(req))return res.sendStatus(404);const {rows:[file]}=await pool.query('select type from portfolio.media where id=$1 and ready',[req.params.id]);if(!file)return res.sendStatus(404);res.type(file.type);res.set({'Cache-Control':content.profile.portrait===req.params.id?'private, max-age=0, must-revalidate':'private, no-store','Content-Security-Policy':"default-src 'none'; sandbox"});res.sendFile(await filePath(root,`portfolio/${req.params.id}`));});
 return router;
}
