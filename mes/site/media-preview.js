// Upload a small display copy; never modify the user's original file.
export async function uploadPreview(kind,path,file,headers={}){
 if(!file.type.startsWith('image/'))return;
 let bitmap;
 try{
  bitmap=await createImageBitmap(file);
  const ratio=Math.min(1,640/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
  const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);
  const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',.78));if(!blob||blob.size>256*1024)return;
  const suffix=kind==='ticket'?path.split('/').slice(1).map(encodeURIComponent).join('/'):encodeURIComponent(path)+'/image';
  const response=await fetch(`/api/mes/previews/${kind}/${suffix}`,{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'image/jpeg',...headers},body:blob});return response.ok;
 }catch{/* Preview is optional; original upload stays valid. */}
 finally{bitmap?.close();}
}
