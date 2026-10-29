import {cloudRecord,commitCloudRecord,mediaProvider} from './cloud-media.js';
import {uploadDriveFile} from './drive-client.js';
import {publishFile} from './publish.js';
import {Router} from 'express';
import {createWriteStream} from 'node:fs';
import {access,rm,link} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {filePath} from './storage.js';
import {actorFor,validPath,token} from './security.js';
export async function displayPath(root,relative,preview=false){
 const original=await filePath(root,relative);
 if(preview){try{await access(original+'.preview.jpg');return original+'.preview.jpg';}catch{}}
 return original;
}
export function previewRouter(pool,root){
 const router=Router();
 router.put('/previews/:kind/:id/:slot',async(req,res)=>{
  const {kind,id,slot}=req.params;const actor=actorFor(req.cookies.th_ticket,req.headers['x-ticket-tester']);
  const dispatch=async(name,data)=>(await pool.query('select public.ticket_dispatch($1,$2,$3) result',[name,data,actor])).rows[0].result;
  let relative;
  if(kind==='ticket'){
   relative=`issues/${id}/${slot}`;if(!validPath(relative))return res.sendStatus(400);
   const session=await dispatch('getSession',{});
   if(session.isOwner){try{await dispatch('downloadUrl',{path:relative});}catch{await dispatch('uploadUrl',{path:relative});}}else await dispatch('uploadUrl',{path:relative});
   const {rows:[f]}=await pool.query('select type from public.files where path=$1',[relative]);if(!f?.type.startsWith('image/'))return res.sendStatus(400);
  }else if(kind==='media'){
   if(!/^[a-f0-9-]{36}$/.test(id)||slot!=='image')return res.sendStatus(400);
   const s=await dispatch('getSession',{});if(!s.isOwner)return res.sendStatus(403);
   const {rows:[f]}=await pool.query('select type from public.ticket_media where id=$1 and ready',[id]);if(!f?.type.startsWith('image/'))return res.sendStatus(400);relative=`media/${id}`;
  }else return res.sendStatus(400);
  if(req.headers['content-type']!=='image/jpeg')return res.sendStatus(400);
  const cloud=await cloudRecord(pool,relative),cloudMode=!!cloud&&await mediaProvider(pool)==='drive';
  if(cloudMode&&await cloudRecord(pool,relative+'.preview.jpg')){req.resume();return res.json({ok:true});}
  const dest=cloudMode?await filePath(root,'.cache/preview-'+token(),true):(await filePath(root,relative))+'.preview.jpg';
  await (await import('node:fs/promises')).mkdir(new URL('.', 'file://'+dest),{recursive:true});
  const temporary=dest+'.'+token()+'.tmp';let size=0,first=true;
  try{
   const limiter=new Transform({transform(chunk,_encoding,cb){size+=chunk.length;if(first){first=false;if(chunk.length<2||chunk[0]!==255||chunk[1]!==216)return cb(Object.assign(new Error('JPEG preview required'),{status:400}));}cb(size>256*1024?Object.assign(new Error('Preview too large'),{status:413}):null,chunk);}});
   await pipeline(req,limiter,createWriteStream(temporary,{flags:'wx',mode:0o600}));if(!size)return res.sendStatus(400);
   if(cloudMode){const uploaded=await uploadDriveFile(temporary,relative+'.preview.jpg','image/jpeg',size);await commitCloudRecord(pool,{path:relative+'.preview.jpg',drive_id:uploaded.id,type:'image/jpeg',size,checksum:uploaded.checksum});}
   else{try{await publishFile(temporary,dest);}catch(e){if(e.code!=='EEXIST')throw e;}}res.json({ok:true});
  }finally{await rm(temporary,{force:true});}
 });return router;
}
