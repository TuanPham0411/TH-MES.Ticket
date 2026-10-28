import {runtimeSites} from './sites.js';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
const tokenPath=()=>process.env.DRIVE_TOKEN_FILE||'/var/lib/th-app/drive-credentials.json';
const client=()=>({id:process.env.GOOGLE_DRIVE_CLIENT_ID||process.env.GOOGLE_CLIENT_ID,secret:process.env.GOOGLE_DRIVE_CLIENT_SECRET||process.env.GOOGLE_CLIENT_SECRET});
let access;
export async function driveCredentials(){try{return JSON.parse(await readFile(tokenPath(),'utf8'));}catch{return null;}}
export async function saveDriveCredentials(value){const path=tokenPath();await mkdir(new URL('.', 'file://'+path),{recursive:true});await writeFile(path+'.tmp',JSON.stringify(value),{mode:0o600});await rename(path+'.tmp',path);access=null;}
export const driveConfigured=()=>!!(client().id&&client().secret);
export function driveAuthorization(state,verifier){const c=client();return 'https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({client_id:c.id,redirect_uri:runtimeSites().mes+'/api/mes/drive/callback',response_type:'code',scope:'openid email https://www.googleapis.com/auth/drive.file',access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});}
async function jsonResponse(response){if(!response.ok)throw Object.assign(new Error('Google Drive request failed. Check the connection, permissions and available Drive storage.'),{status:502,expose:true});return response.json();}
export async function exchangeDriveCode(code,verifier){const c=client();return jsonResponse(await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:c.id,client_secret:c.secret,code,code_verifier:verifier,grant_type:'authorization_code',redirect_uri:runtimeSites().mes+'/api/mes/drive/callback'}),signal:AbortSignal.timeout(30000)}));}
export async function driveToken(){
 if(access&&access.expires>Date.now()+60000)return access.token;
 const value=await driveCredentials(),c=client();if(!value?.refreshToken)throw Object.assign(new Error('Connect Google Drive in Administration first.'),{status:409,expose:true});
 const result=await jsonResponse(await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:c.id,client_secret:c.secret,refresh_token:value.refreshToken,grant_type:'refresh_token'}),signal:AbortSignal.timeout(30000)}));access={token:result.access_token,expires:Date.now()+(result.expires_in||3600)*1000};return access.token;
}
export async function driveApi(path,options={}){const token=await driveToken();return fetch('https://www.googleapis.com/drive/v3/'+path,{...options,headers:{Authorization:'Bearer '+token,...options.headers},signal:options.signal||AbortSignal.timeout(30000)});}
export async function createDriveFolder(name,parent,token){const response=await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink',{method:'POST',headers:{Authorization:'Bearer '+(token||await driveToken()),'Content-Type':'application/json'},body:JSON.stringify({name,mimeType:'application/vnd.google-apps.folder',...(parent?{parents:[parent]}:{})}),signal:AbortSignal.timeout(30000)});return jsonResponse(response);}
export async function beginDriveUpload(name,type,parent,properties={},size){
 const token=await driveToken();const response=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,md5Checksum,webViewLink',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Upload-Content-Type':type,...(size!==undefined?{'X-Upload-Content-Length':String(size)}:{})},body:JSON.stringify({name,parents:[parent],appProperties:properties}),signal:AbortSignal.timeout(30000)});
 if(!response.ok)await jsonResponse(response);const url=response.headers.get('location');if(!url||new URL(url).origin!=='https://www.googleapis.com')throw new Error('Invalid Drive upload session');return url;
}
export async function uploadDriveStream(stream,{name,type,parent,size,properties={}}){
 const url=await beginDriveUpload(name,type,parent,properties,size);let offset=0,pending=Buffer.alloc(0),result;const digest=createHash('md5');const CHUNK=4*1024*1024;
 async function send(buffer,total){
  let response;
  for(let attempt=0;attempt<3;attempt++){
   response=await fetch(url,{method:'PUT',headers:{'Content-Type':type,'Content-Length':String(buffer.length),'Content-Range':`bytes ${offset}-${offset+buffer.length-1}/${total??'*'}`},body:buffer,signal:AbortSignal.timeout(180000)});
   if(response.status===308||response.ok)break;
   if(response.status<500)await jsonResponse(response);
   await new Promise(r=>setTimeout(r,1000*(attempt+1)));
  }
  if(!response.ok&&response.status!==308)await jsonResponse(response);
  if(response.status===308&&response.headers.get('range')!==`bytes=0-${offset+buffer.length-1}`)throw new Error('Drive acknowledged a different upload offset; original was kept');
  if(response.ok)result=await response.json();offset+=buffer.length;
 }
 for await(const incoming of stream){digest.update(incoming);pending=Buffer.concat([pending,incoming]);while(pending.length>CHUNK){await send(pending.subarray(0,CHUNK),size);pending=pending.subarray(CHUNK);}}
 if(pending.length)await send(pending,size??offset+pending.length);
 if(!result?.id)throw new Error('Drive upload did not finish');if(Number(result.size)!==offset||result.md5Checksum!==digest.digest('hex'))throw new Error('Drive stream checksum differs; original was kept');return result;
}
export async function hashFile(path){const digest=createHash('md5');for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest('hex');}
export async function uploadDriveFile(path,relative,type,size){const credentials=await driveCredentials();const checksum=await hashFile(path);const result=await uploadDriveStream(createReadStream(path),{name:relative.split('/').at(-1),type,parent:credentials.mediaFolder,size,properties:{thPathHash:createHash('sha256').update(relative).digest('hex')}});if(result.md5Checksum!==checksum||Number(result.size)!==Number(size))throw new Error('Google Drive copy checksum differs; original was kept');return {...result,checksum};}
