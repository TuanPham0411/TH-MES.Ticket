import {backupToDrive,moveToDrive,copyFromDrive} from './drive-jobs.js';
import {driveCredentials} from './drive-client.js';
import {Router} from 'express';
import {actorFor} from './security.js';
import {storageCommand,storageStatus,storageQuota} from './storage.js';
export function adminRouter(pool,root,gate){
 const router=Router();let job=null,jobSession=null;
 const actor=req=>actorFor(req.cookies.th_mes,req.headers['x-mes-tester']);
 const dispatch=async(name,data,identity)=>(await pool.query('select public.mes_dispatch($1,$2,$3) result',[name,data,identity])).rows[0].result;
 router.use(async(req,res,next)=>{if(req.method==='GET'&&req.path==='/storage'&&job?.state==='running'&&req.cookies.th_mes===jobSession)return next();const s=await dispatch('getSession',{},actor(req));if(!s.isOwner)return res.sendStatus(403);next();});
 router.get('/storage',async(req,res)=>res.json({...await storageStatus(root),quota:storageQuota(),job,hostStorage:!req.app.locals.mesOnly}));
 router.use((req,res,next)=>{if(req.app.locals.mesOnly&&['/storage','/mount','/folders','/transfer-plan','/transfer','/database-plan','/database-move','/backup','/drive-recover','/drive-backup','/drive-transfer','/drive-to-local'].includes(req.path))return res.status(501).json({error:'Host storage and bulk backup operations require the Raspberry Pi storage broker. Use your hosting platform backup tools.',code:'host-storage-unavailable'});next();});
 router.post('/storage',async(req,res)=>{
  if(!['primary','overflow'].includes(req.body.mode)||!(req.body.id===null||typeof req.body.id==='string'))return res.sendStatus(400);
  await gate.exclusive(()=>storageCommand('select',req.body));if(req.body.mode==='primary')await pool.query("update public.mes_storage_settings set provider='local' where id='main'");res.json({ok:true});
 });
 router.post('/mount',async(req,res)=>{if(typeof req.body.id!=='string')return res.sendStatus(400);res.json(await gate.exclusive(()=>storageCommand('mount',{id:req.body.id})));});
 router.post('/backup',async(req,res)=>{
  if(typeof req.body.id!=='string')return res.sendStatus(400);
  if(job?.state==='running')return res.status(409).json({error:'Backup is already running'});
  job={state:'running',startedAt:Date.now()};
  gate.exclusive(()=>storageCommand('backup',{id:req.body.id},60*60*1000)).then(result=>{job={...job,state:'complete',finishedAt:Date.now(),result};}).catch(error=>{job={...job,state:'failed',finishedAt:Date.now(),error:error.expose?error.message:'Backup failed. Check the USB connection and available space.'};});
  res.status(202).json(job);
 });
 function startJob(req,res,action,data,kind){
  if(job?.state==='running')return res.status(409).json({error:'A storage operation is already running'});
  job={kind,state:'running',startedAt:Date.now()};jobSession=req.cookies.th_mes;
  gate.exclusive(()=>storageCommand(action,data,60*60*1000)).then(result=>{job={...job,state:'complete',finishedAt:Date.now(),result};}).catch(error=>{job={...job,state:'failed',finishedAt:Date.now(),error:error.message||'Storage operation failed. Originals were retained.'};});
  res.status(202).json(job);
 }
 router.get('/folders',async(req,res)=>res.json(await storageCommand('browse',{device:req.query.device,folder:req.query.folder||''})));
 router.post('/folders',async(req,res)=>{const result=await gate.exclusive(()=>storageCommand('register',{device:req.body.device,folder:req.body.folder,activate:req.body.activate===true}));if(req.body.activate===true)await pool.query("update public.mes_storage_settings set provider='local' where id='main'");res.json(result);});
 router.post('/transfer-plan',async(req,res)=>res.json(await storageCommand('transferPlan',{source:req.body.source,target:req.body.target})));
 router.post('/transfer',async(req,res)=>startJob(req,res,'transfer',{source:req.body.source,target:req.body.target,mode:req.body.mode,activate:req.body.activate!==false},'files'));
 router.post('/database-plan',async(req,res)=>res.json(await storageCommand('databasePlan',{device:req.body.device,folder:req.body.folder,sizeGiB:req.body.sizeGiB})));
 router.post('/database-move',async(req,res)=>startJob(req,res,'databaseMove',{device:req.body.device,folder:req.body.folder,sizeGiB:req.body.sizeGiB},'database'));
 function startCloud(req,res,work,kind){
  if(job?.state==='running')return res.status(409).json({error:'A storage operation is already running'});
  job={kind,state:'running',startedAt:Date.now()};jobSession=req.cookies.th_mes;
  gate.exclusive(work).then(result=>job={...job,state:'complete',result,finishedAt:Date.now()}).catch(error=>job={...job,state:'failed',error:error.message,finishedAt:Date.now()});res.status(202).json(job);
 }
 router.post('/drive-recover',async(req,res)=>{if(job?.state==='running')return res.status(409).json({error:'Operation is still running'});const status=await storageStatus(root);if(status.cloudOperation)await storageCommand('cloudEnd',{id:status.cloudOperation.id});res.json({ok:true});});
 router.post('/drive-provider',async(req,res)=>{if(!['local','drive'].includes(req.body.provider))return res.sendStatus(400);if(req.body.provider==='drive'&&!await driveCredentials())return res.status(409).json({error:'Connect Google Drive first.'});await gate.exclusive(()=>pool.query("update public.mes_storage_settings set provider=$1 where id='main'",[req.body.provider]));res.json({ok:true});});
 router.post('/drive-backup',async(req,res)=>startCloud(req,res,()=>backupToDrive(pool,root),'drive-backup'));
 router.post('/drive-transfer',async(req,res)=>{if(!['copy','move'].includes(req.body.mode))return res.sendStatus(400);startCloud(req,res,()=>moveToDrive(pool,root,{mode:req.body.mode}),'drive-media');});
 router.post('/drive-to-local',async(req,res)=>{if(!['copy','move'].includes(req.body.mode)||typeof req.body.target!=='string')return res.sendStatus(400);startCloud(req,res,()=>copyFromDrive(pool,root,req.body),'drive-to-local');});
 router.get('/access-log'  ,async(req,res)=>{
  if(req.query.before&&!/^\d{1,19}$/.test(req.query.before))return res.sendStatus(400);
  const result=await dispatch('getAccessLog',{before:req.query.before,username:req.query.username},actor(req));res.json(result);
 });
 return router;
}
