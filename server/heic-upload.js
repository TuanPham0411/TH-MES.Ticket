import {Worker} from 'node:worker_threads';
import {existsSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
let queue=Promise.resolve(),pending=0;
const failure=(status,message)=>Object.assign(new Error(message),{status,expose:true});
export async function normalizeHeicFile(path){
 if(pending>=3)throw failure(429,'Image conversion is busy. Please try again shortly.');
 pending++;const previous=queue;let release;queue=new Promise(resolve=>release=resolve);await previous;
 try{return await new Promise((resolveResult,reject)=>{
  const bundled=join(dirname(process.argv[1]||''),'heic-worker.cjs'),filename=existsSync(bundled)?bundled:resolve('server/heic-worker.js');
  const worker=new Worker(filename,{workerData:{path},resourceLimits:{maxOldGenerationSizeMb:512,maxYoungGenerationSizeMb:64}});let done=false;
  const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);worker.terminate().then(()=>err?reject(err):resolveResult(value),()=>err?reject(err):resolveResult(value));};
  const timer=setTimeout(()=>finish(failure(422,'HEIC conversion timed out. Try a smaller image.')),90000);
  worker.once('message',value=>finish(value.error?failure(400,'Unable to convert HEIC: '+value.error):null,value));worker.once('error',()=>finish(failure(400,'Unable to decode this HEIC image. Try another image.')));worker.once('exit',()=>{if(!done)finish(failure(400,'Unable to decode this HEIC image.'));});
 });}finally{try{await rm(path+'.jpeg',{force:true});}finally{pending--;release();}}
}
