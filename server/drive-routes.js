import {brokerRequest} from './th-storage/client.mjs';
import {Router} from 'express';
import {randomBytes,createHash} from 'node:crypto';
import {actorFor} from './security.js';
import {driveConfigured,driveCredentials,saveDriveCredentials,driveAuthorization,exchangeDriveCode,createDriveFolder} from './drive-client.js';
import {mediaProvider} from './cloud-media.js';
export function driveRouter(pool){
 const router=Router(),pending=new Map();
 async function owner(req){const actor=actorFor(req.cookies.th_ticket,req.headers['x-ticket-tester']);const value=(await pool.query('select public.ticket_dispatch($1,$2,$3) result',['getSession',{},actor])).rows[0].result;if(!value.isOwner)throw Object.assign(new Error('Administrator required'),{status:403});return actor;}
 if(process.env.TH_STORAGE_MODE==='drive-first'){
  router.get('/drive/status',async(req,res)=>{await owner(req);res.json(await brokerRequest({application:'ticket',socketPath:process.env.TH_STORAGE_SOCKET,token:process.env.TH_STORAGE_TOKEN},'/v1/status',{}));});
  router.use('/drive',async(req,res)=>{await owner(req);res.status(409).json({error:'Drive storage is managed by TH-RPI.Server. Use the server storage configuration.',code:'server-managed-storage'});});
  return router;
 }
 router.get('/drive/connect',async(req,res)=>{
  await owner(req);if(!driveConfigured())return res.status(503).send('Google OAuth credentials are not configured on the Pi.');
  const state=randomBytes(32).toString('hex'),verifier=randomBytes(32).toString('hex');for(const [key,value]of pending)if(value.expires<Date.now())pending.delete(key);
  pending.set(state,{verifier,session:req.cookies.th_ticket,expires:Date.now()+600000});res.cookie('drive_state',state,{httpOnly:true,secure:true,sameSite:'lax',path:'/api/ticket/drive',maxAge:600000});res.redirect(driveAuthorization(state,verifier));
 });
 router.get('/drive/callback',async(req,res)=>{
  const state=req.query.state,value=pending.get(state);pending.delete(state);res.clearCookie('drive_state',{path:'/api/ticket/drive',httpOnly:true,secure:true,sameSite:'lax'});
  if(!value||value.expires<Date.now()||req.cookies.drive_state!==state||req.cookies.th_ticket!==value.session||typeof req.query.code!=='string')return res.status(400).send('Invalid Drive OAuth state.');
  await owner(req);const credentials=await exchangeDriveCode(req.query.code,value.verifier);if(!credentials.refresh_token)throw Object.assign(new Error('Google did not provide offline access. Connect again and approve access.'),{status:400,expose:true});
  const response=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer '+credentials.access_token},signal:AbortSignal.timeout(20000)});const identity=await response.json();if(!response.ok||!identity.email_verified)throw new Error('Verified Google Drive account required');
  const previous=await driveCredentials();if(previous&&previous.email!==identity.email&&(await pool.query('select 1 from public.ticket_cloud_files limit 1')).rowCount)return res.status(409).send('Existing cloud files belong to another Drive account. Copy them back locally before changing accounts.');
  let root=previous?.email===identity.email?{id:previous.folderId}:await createDriveFolder('TH.Ticket',null,credentials.access_token);
  const media=previous?.email===identity.email?{id:previous.mediaFolder}:await createDriveFolder('Media',root.id,credentials.access_token);
  const backups=previous?.email===identity.email?{id:previous.backupFolder}:await createDriveFolder('Backups',root.id,credentials.access_token);
  await saveDriveCredentials({refreshToken:credentials.refresh_token,email:identity.email,folderId:root.id,mediaFolder:media.id,backupFolder:backups.id,connectedAt:Date.now()});res.redirect('/?drive=connected');
 });
 router.get('/drive/status',async(req,res)=>{await owner(req);const value=await driveCredentials();res.json({configured:driveConfigured(),connected:!!value,email:value?.email,folderId:value?.folderId,provider:await mediaProvider(pool),cloudFiles:Number((await pool.query('select count(*) from public.ticket_cloud_files')).rows[0].count)});});
 return router;
}

