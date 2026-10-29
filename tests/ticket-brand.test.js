import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {runtimeSites} from '../server/sites.js';
test('Ticket public origin and visible branding use TH.Ticket',()=>{
 assert.equal(runtimeSites({}).mes,'https://ticket.th.io.vn');
 const files=readdirSync(new URL('../mes/site/',import.meta.url)).filter(p=>/\.(html|js)$/.test(p));
 for(const file of files){
  const text=readFileSync(new URL('../mes/site/'+file,import.meta.url),'utf8').replaceAll('X-MES-Tester','');
  assert.doesNotMatch(text,/\bMES\b|\[TH\] P\+F MES/,file);
 }
 const html=readFileSync(new URL('../mes/site/index.html',import.meta.url),'utf8');
 assert.match(html,/<title>TH\.Ticket<\/title>/);
 assert.match(html,/<span class="brand-icon">T<\/span>/);
});
