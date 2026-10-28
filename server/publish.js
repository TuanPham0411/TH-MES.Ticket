import {link,copyFile} from 'node:fs/promises';
import {constants} from 'node:fs';
// ext4 can publish by hardlink. exFAT/NTFS may not support links: copy without
// replacement and expose metadata only after the copy finishes. Originals stay immutable.
export async function publishFile(source,destination,{linkFile=link}={}){
 try{await linkFile(source,destination);return;}
 catch(error){if(!['EXDEV','EPERM','EOPNOTSUPP','ENOSYS'].includes(error.code))throw error;}
 try{await copyFile(source,destination,constants.COPYFILE_EXCL);}
 catch(error){
  // COPYFILE_EXCL never overwrites an existing slot. Node removes its own partial
  // destination on copy errors; do not remove an existing destination here.
  throw error;
 }
}
