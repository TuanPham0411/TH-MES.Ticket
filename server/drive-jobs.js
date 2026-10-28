import {createReadStream,createWriteStream} from 'node:fs';
import {access,rm,mkdir,stat,rename} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash,randomUUID} from 'node:crypto';
import tar from 'tar-stream';
import {once} from 'node:events';
import {filePath,deleteEverywhere,storageCommand} from './storage.js';
import {driveCredentials,uploadDriveFile,driveApi,uploadDriveStream,hashFile} from './drive-client.js';
import {cloudRecord,mediaProvider} from './cloud-media.js';
export async function allMedia(pool){return (await pool.query("select path,type,size from public.files union all select 'media/'||id path,type,size from public.mes_media where ready")).rows;}
async function putMapping(pool,row,file){await pool.query('insert into public.mes_cloud_files(path,drive_id,type,size,checksum) values($1,$2,$3,$4,$5) on conflict(path) do update set drive_id=excluded.drive_id,type=excluded.type,size=excluded.size,checksum=excluded.checksum',[file.path,row.id,file.type,file.size,row.checksum]);}
export async function moveToDrive(pool,root,{mode='copy'}={}){
 if(!['copy','move'].includes(mode))throw new Error('Choose Copy or Move');const credentials=await driveCredentials();if(!credentials)throw new Error('Connect Google Drive first.');
 const files=await allMedia(pool);let copied=0,removed=0;
 const operation=await storageCommand('cloudBegin');
 try{
  for(const file of files){const previous=await cloudRecord(pool,file.path);if(previous){const response=await driveApi(`files/${encodeURIComponent(previous.drive_id)}?fields=id,size,md5Checksum`);if(response.ok){const value=await response.json();if(Number(value.size)===Number(file.size)&&value.md5Checksum===previous.checksum){copied++;continue;}}throw new Error('An existing Drive file is unavailable. Originals were kept.');}
   const source=await filePath(root,file.path),result=await uploadDriveFile(source,file.path,file.type,file.size);await putMapping(pool,result,file);copied++;
  }
  for(const file of files){if(!file.type.startsWith('image/')||await cloudRecord(pool,file.path+'.preview.jpg'))continue;
   let preview;try{preview=await filePath(root,file.path+'.preview.jpg');await access(preview);}catch{continue;}
   const size=(await stat(preview)).size,result=await uploadDriveFile(preview,file.path+'.preview.jpg','image/jpeg',size);await putMapping(pool,result,{path:file.path+'.preview.jpg',type:'image/jpeg',size});
  }
  await pool.query("update public.mes_storage_settings set provider='drive' where id='main'");
  if(mode==='move')for(const file of files){const entry=await cloudRecord(pool,file.path),check=await driveApi(`files/${encodeURIComponent(entry.drive_id)}?fields=id,size,md5Checksum`);if(!check.ok)throw new Error('Drive verification failed; remaining originals were retained');const metadata=await check.json();if(metadata.md5Checksum!==entry.checksum||Number(metadata.size)!==Number(file.size))throw new Error('Drive file differs; originals were retained');await deleteEverywhere(root,file.path);removed++;}
  return {kind:'drive-media',copied,removed,provider:'drive',files:files.length};
 }finally{await storageCommand('cloudEnd',{id:operation.id}).catch(()=>{});}
}
export async function copyFromDrive(pool,root,{target,mode='copy'}={}){
 if(!['copy','move'].includes(mode))throw new Error('Choose Copy or Move');
 const files=(await pool.query('select * from public.mes_cloud_files order by path')).rows;const operation=await storageCommand('cloudBegin');let copied=0;
 try{
  for(const file of files){let dest=(await storageCommand('destination',{key:target,path:file.path})).path;try{await access(dest);if(await hashFile(dest)!==file.checksum)throw new Error('An existing local file differs. No file was overwritten.');copied++;continue;}catch(error){if(error.code!=='ENOENT')throw error;}
   await mkdir(new URL('.', 'file://'+dest),{recursive:true});const temporary=dest+'.'+randomUUID()+'.tmp';
   try{const response=await driveApi(`files/${encodeURIComponent(file.drive_id)}?alt=media`,{signal:AbortSignal.timeout(180000),headers:{'Accept-Encoding':'identity'}});if(!response.ok)throw new Error('Drive source unavailable');await pipeline(Readable.fromWeb(response.body),createWriteStream(temporary,{flags:'wx',mode:0o600}));if(await hashFile(temporary)!==file.checksum)throw new Error('Local copy checksum differs');const {publishFile}=await import('./publish.js');await publishFile(temporary,dest);copied++;}finally{await rm(temporary,{force:true});}
  }
  await storageCommand('select',{mode:'primary',id:target});
  await pool.query("update public.mes_storage_settings set provider='local' where id='main'");
  if(mode==='move')for(const file of files){const response=await driveApi(`files/${encodeURIComponent(file.drive_id)}`,{method:'DELETE'});if(!response.ok&&response.status!==404)throw new Error('Local copy is complete; some Drive originals could not be removed');await pool.query('delete from public.mes_cloud_files where path=$1',[file.path]);}
  return {kind:'drive-to-local',copied,provider:'local',files:files.length};
 }finally{await storageCommand('cloudEnd',{id:operation.id}).catch(()=>{});}
}
export async function backupToDrive(pool,root){
 const credentials=await driveCredentials();if(!credentials)throw new Error('Connect Google Drive first.');const operation=await storageCommand('cloudBegin');const pack=tar.pack();let failure;
 const name='TH-MES-'+new Date().toISOString().replaceAll(':','-')+'.tar';
 const uploaded=uploadDriveStream(pack,{name,type:'application/x-tar',parent:credentials.backupFolder,properties:{thKind:'full-backup'}});
 // Handle rejection immediately so a failed upload cannot become an unhandled promise.
 uploaded.catch(error=>{failure=error;pack.destroy(error);});
 try{
  const dump=await storageCommand('cloudDatabaseDump',{id:operation.id},180000);const files=await allMedia(pool),manifest={version:1,kind:'full-backup',createdAt:Date.now(),files:[],database:'database.dump',originalUrlsPreserved:true};
  async function entry(name,size,input){if(failure)throw failure;const hash=createHash('sha256');let complete,failed;const done=new Promise((resolve,reject)=>{complete=resolve;failed=reject;});done.catch(()=>{});const target=pack.entry({name,size,mode:0o600},error=>error?failed(error):complete());target.on('error',failed);for await(const chunk of input){hash.update(chunk);if(!target.write(chunk))await once(target,'drain');}target.end();await done;return hash.digest('hex');}
  manifest.databaseSha256=await entry('database.dump',dump.size,createReadStream(dump.path));
  for(const file of files){const cloud=await cloudRecord(pool,file.path);let input;
   if(cloud&&await mediaProvider(pool)==='drive'){const response=await driveApi(`files/${encodeURIComponent(cloud.drive_id)}?alt=media`,{headers:{'Accept-Encoding':'identity'},signal:AbortSignal.timeout(180000)});if(!response.ok)throw new Error('A cloud attachment is missing. Backup was not completed.');input=Readable.fromWeb(response.body);}
   else{try{input=createReadStream(await filePath(root,file.path));}catch(error){if(!cloud)throw error;const response=await driveApi(`files/${encodeURIComponent(cloud.drive_id)}?alt=media`);if(!response.ok)throw new Error('Attachment unavailable');input=Readable.fromWeb(response.body);}}
   const sha256=await entry('files/'+file.path,Number(file.size),input);manifest.files.push({path:file.path,size:Number(file.size),sha256});
  }
  const json=Buffer.from(JSON.stringify(manifest,null,2));await entry('manifest.json',json.length,Readable.from([json]));pack.finalize();const result=await uploaded;
  return {kind:'drive-backup',id:result.id,name,files:manifest.files.length,folder:'https://drive.google.com/drive/folders/'+credentials.backupFolder};
 }catch(error){pack.destroy(error);await uploaded.catch(()=>{});throw error;}
 finally{await storageCommand('cloudEnd',{id:operation.id}).catch(()=>{});}
}
