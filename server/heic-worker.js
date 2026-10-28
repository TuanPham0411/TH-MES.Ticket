import {parentPort,workerData} from 'node:worker_threads';
import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import convert from 'heic-convert';
import {validateHeicDimensions} from './heic-format.js';
async function run(){
const path=workerData.path,temporary=path+'.jpeg';
try{
 const input=await readFile(path);validateHeicDimensions(input);
 const output=Buffer.from(await convert({buffer:input,format:'JPEG',quality:.88}));
 if(output.length>12*1024*1024)throw Error('Converted image exceeds 12 MB; choose a smaller image');
 if(output[0]!==255||output[1]!==216||output[2]!==255)throw Error('HEIC conversion failed');
 await writeFile(temporary,output,{flag:'wx',mode:0o600});await rename(temporary,path);
 parentPort.postMessage({size:output.length,type:'image/jpeg'});
}catch(error){await rm(temporary,{force:true});parentPort.postMessage({error:error.message||'HEIC conversion failed'});}

}
run();
