import http from 'node:http';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {access,mkdir,statfs,readdir,rm} from 'node:fs/promises';
export const backupActive=()=>existsSync('/run/th-storage/backup-active');
const managed=root=>root==='/var/lib/th-app/files' && process.env.NODE_ENV!=='test';
export function storageCommand(action,data={},timeout=30000){
 return new Promise((resolve,reject)=>{
  const body=JSON.stringify({action,data});
  const req=http.request({socketPath:process.env.NODE_ENV==='test'&&process.env.TEST_STORAGE_SOCKET||'/run/th-storage/control.sock',path:'/',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
   let text='';res.on('data',b=>text+=b);res.on('end',()=>{try{const value=JSON.parse(text);if(res.statusCode!==200)throw Object.assign(new Error(value.error||'Storage unavailable'),{status:409,expose:true,code:value.code});resolve(value);}catch(e){reject(e);}});
  });req.setTimeout(timeout,()=>req.destroy(new Error('Storage operation timed out')));req.on('error',reject);req.end(body);
 });
}
export async function filePath(root,relative,write=false){
 if(!managed(root))return join(root,relative);
 return (await storageCommand('resolve',{path:relative,write})).path;
}
export async function deleteEverywhere(root,relative,options={force:true}){
 if(!managed(root))return rm(join(root,relative),options);
 const {paths}=await storageCommand('locations',{path:relative});
 for(const path of paths){await rm(path,options);if(!options.recursive)await rm(path+'.preview.jpg',{force:true});}
}
export const storageQuota=()=>Number(process.env.STORAGE_QUOTA_BYTES)||64*1024*1024*1024;
export async function storageStatus(root){
 if(managed(root))return storageCommand('status');
 await mkdir(root,{recursive:true});const s=await statfs(root);return {primary:'internal',overflow:null,volumes:[],disks:[],backups:[],internal:{free:s.bavail*s.bsize,total:s.blocks*s.bsize}};
}
// Freeze all API requests which can write while a complete DB+file backup is made.
export function maintenanceGate(){
 let blocked=false,active=0;
 const readNames=new Set(['read','readBundle','getSession','getDirectory','listDevices']);
 return {
  middleware(req,res,next){
   const route=req.path.replace(/\/$/,'');
   const read=req.method==='GET'||req.method==='HEAD'||(route==='/api/mes'&&readNames.has(req.body?.name))||(route==='/api/mes/workspace'&&req.body?.action==='read');
   if(read||req.path.startsWith('/api/mes/admin'))return next();
   if(blocked||backupActive()){res.set('Retry-After','10');return res.status(503).json({error:'Backup in progress. Please retry after it completes.',code:'backup-in-progress'});}
   active++;let done=false;const finish=()=>{if(!done){done=true;active--;}};res.once('finish',finish);res.once('close',finish);next();
  },
  async background(work){
   if(blocked||backupActive())return false;
   active++;try{await work();return true;}finally{active--;}
  },
  async exclusive(work){
   if(blocked||backupActive())throw Object.assign(new Error('A storage operation is already running'),{status:409,expose:true});
   blocked=true;
   try{
    const deadline=Date.now()+60*60*1000;
    while(active){if(Date.now()>deadline)throw new Error('Active uploads have not finished; retry backup later');await new Promise(r=>setTimeout(r,100));}
    return await work();
   }finally{blocked=false;}
  },
  get blocked(){return blocked;}
 };
}
