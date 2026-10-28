const brands=new Set(['heic','heix','hevc','hevx','mif1','msf1']);
export function isHeic(buffer){return buffer.length>=16&&buffer.toString('ascii',4,8)==='ftyp'&&brands.has(buffer.toString('ascii',8,12));}
export function validateHeicDimensions(buffer){
 if(!isHeic(buffer))throw Error('File contents do not match HEIC/HEIF');
 let boxes=0;
 function walk(start,end,depth){if(depth>8)throw Error('Invalid HEIC metadata');for(let offset=start;offset+8<=end;){if(++boxes>10000)throw Error('Invalid HEIC metadata');let size=buffer.readUInt32BE(offset),header=8;const type=buffer.toString('ascii',offset+4,offset+8);if(size===1){if(offset+16>end)throw Error('Invalid HEIC metadata');const large=buffer.readBigUInt64BE(offset+8);if(large>BigInt(end-offset))throw Error('Invalid HEIC metadata');size=Number(large);header=16;}if(size===0)size=end-offset;if(size<header||offset+size>end)throw Error('Invalid HEIC metadata');const body=offset+header;
 if(type==='ispe'){if(size<header+12)throw Error('Invalid HEIC dimensions');const width=buffer.readUInt32BE(body+4),height=buffer.readUInt32BE(body+8);if(!width||!height||width>16384||height>16384||width*height>64000000)throw Error('HEIC images must be at most 64 megapixels');}
 if(['meta','iprp','ipco'].includes(type))walk(body+(type==='meta'?4:0),offset+size,depth+1);offset+=size;}}
 walk(0,buffer.length,0);
}
