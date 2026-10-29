import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDocument,documentText} from '../ticket/site/rich-document.js';
test('rich feedback preserves bounded text styles and reserved image references',()=>{
 const rich=normalizeDocument({version:1,ops:[{insert:'Ticket report',attributes:{bold:true,size:'24px',font:'monospace',color:'#123456'}},{insert:'\n',attributes:{header:2}},{insert:{image:0}},{insert:'\n'}]});
 assert.equal(documentText(rich),'Ticket report'); assert.equal(rich.ops[0].attributes.size,'24px');assert.equal(rich.ops[2].insert.image,0);
 assert.equal(documentText(normalizeDocument({version:1,ops:[{insert:{image:1}},{insert:'\n'}]})),'Image feedback');
});
test('rich feedback cannot store remote images, scripts, unsafe styles or unbounded content',()=>{
 for(const insert of [{image:'https://evil.example/track.png'},{image:'data:image/svg+xml,bad'},{image:-1},{image:5},{image:0,html:'<script>'}])assert.throws(()=>normalizeDocument({version:1,ops:[{insert}]}));
 const safe=normalizeDocument({version:1,ops:[{insert:'<script>alert(1)</script>',attributes:{onclick:'alert(1)',color:'url(javascript:alert(1))',size:'999px',bold:true}}]});assert.deepEqual(safe.ops[0].attributes,{bold:true});
 assert.throws(()=>normalizeDocument({version:1,ops:[{insert:'x'.repeat(5002)}]}));assert.throws(()=>normalizeDocument({version:1,ops:Array(257).fill({insert:'x'})}));assert.throws(()=>normalizeDocument({version:2,ops:[]}));
});
test('additional feedback fonts survive storage while arbitrary font CSS is discarded',()=>{
 for(const font of ['calibri','arial','cambria','georgia','times','tahoma','verdana','trebuchet','segoe','courier','consolas'])assert.equal(normalizeDocument({version:1,ops:[{insert:'Tiếng Việt',attributes:{font}}]}).ops[0].attributes.font,font);
 const op=normalizeDocument({version:1,ops:[{insert:'safe',attributes:{font:'url(https://tracker.example)'}}]}).ops[0];assert.equal(op.attributes,undefined);
});
