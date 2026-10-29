import {access,rm} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {filePath} from './storage.js';
import {driveApi,uploadDriveFile} from './drive-client.js';
export async function mediaProvider(pool){return (await pool.query("select provider from public.ticket_storage_settings where id='main'")).rows[0]?.provider||'local';}
export async function cloudRecord(pool,path){return (await pool.query('select * from public.ticket_cloud_files where path=$1',[path])).rows[0];}
export async function prepareCloudOriginal(pool,path,relative,type,size){if(await mediaProvider(pool)!=='drive')return null;const uploaded=await uploadDriveFile(path,relative,type,size);return {path:relative,drive_id:uploaded.id,type,size,checksum:uploaded.checksum};}
export async function commitCloudRecord(db,record){await db.query('insert into public.ticket_cloud_files(path,drive_id,type,size,checksum) values($1,$2,$3,$4,$5)',[record.path,record.drive_id,record.type,record.size,record.checksum]);}
export async function removeCloudFile(pool,path){if(!path.endsWith('.preview.jpg'))await removeCloudFile(pool,path+'.preview.jpg');const row=await cloudRecord(pool,path);if(!row)return;const response=await driveApi(`files/${encodeURIComponent(row.drive_id)}`,{method:'DELETE'});if(!response.ok&&response.status!==404)throw new Error('Cloud file could not be removed');await pool.query('delete from public.ticket_cloud_files where path=$1',[path]);}
export async function serveCloudMedia(pool,root,path,req,res,type){
 const original=await cloudRecord(pool,path);if(!original)return false;
 const record=req.query.preview==='1'&&type.startsWith('image/')?(await cloudRecord(pool,path+'.preview.jpg')||original):original;
 if(record!==original)type='image/jpeg';
 if(await mediaProvider(pool)!=='drive'){try{await access(await filePath(root,path));return false;}catch{}}
 const etag='"drive-'+record.checksum+'"';res.set({'ETag':etag,'Cache-Control':'private, max-age=0, must-revalidate','Content-Type':type,'X-Accel-Buffering':'no','Accept-Ranges':'bytes','X-Media-Preview':record!==original?'ready':'original'});
 if(req.headers['if-none-match']===etag&&!req.headers.range){res.status(304).end();return true;}
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);const abort=()=>controller.abort();res.once('close',abort);
 try{
  const response=await driveApi(`files/${encodeURIComponent(record.drive_id)}?alt=media`,{headers:{'Accept-Encoding':'identity',...(req.headers.range?{Range:req.headers.range}:{})},signal:controller.signal});clearTimeout(timer);
  if(!response.ok){res.status(response.status===404?404:502).end();return true;}
  res.status(response.status);for(const name of ['content-length','content-range'])if(response.headers.has(name))res.set(name,response.headers.get(name));
  if(req.method==='HEAD'){controller.abort();res.end();return true;}
  await pipeline(Readable.fromWeb(response.body),res);return true;
 }finally{clearTimeout(timer);res.off('close',abort);}
}
