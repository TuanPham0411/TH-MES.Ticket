import test from 'node:test';import assert from 'node:assert/strict';
import {vi,translate,initializeLanguage} from '../ticket/site/i18n.js';
test('operational controls and messages have Vietnamese translations',()=>{
 for(const text of ['Add files','Assessment','Loading…','Refresh','Choose personal color','Save personal','Width','Issue details','Update name','Could not save changes.'])assert.notEqual(translate(text,'vi'),text,text);
 assert.equal(translate('A user wrote this title','vi'),'A user wrote this title');
 assert.equal(translate('Loading…','en'),'Loading…');assert.equal(translate('Đang tải…','en'),'Loading…');
});
test('VI to EN to VI restores dynamic text and changed accessibility labels without translating user data',async()=>{
 const select={value:'vi'},node={nodeValue:'Loading…',parentElement:{closest:()=>null}},user={nodeValue:'Refresh',parentElement:{closest:()=>true}};
 const attrs=new Map([['title','Refresh']]);const element={closest:()=>null,hasAttribute:k=>attrs.has(k),getAttribute:k=>attrs.get(k),setAttribute:(k,v)=>attrs.set(k,v)};
 let callback;globalThis.MutationObserver=class{constructor(fn){callback=fn}observe(){}disconnect(){}};globalThis.NodeFilter={SHOW_TEXT:4};globalThis.localStorage={setItem(){}};
 globalThis.document={documentElement:{},body:{},createTreeWalker(){let n=0;return{nextNode:()=>[node,user][n++]||null}},querySelectorAll:()=>[element],getElementById:()=>select};
 initializeLanguage(()=>{});assert.equal(node.nodeValue,'Đang tải…');assert.equal(user.nodeValue,'Refresh');assert.equal(attrs.get('title'),'Làm mới');
 select.value='en';select.onchange();assert.equal(node.nodeValue,'Loading…');assert.equal(attrs.get('title'),'Refresh');
 attrs.set('title','Cancel');callback();await new Promise(queueMicrotask);assert.equal(attrs.get('title'),'Cancel');
 select.value='vi';select.onchange();assert.equal(attrs.get('title'),'Hủy');assert.equal(node.nodeValue,'Đang tải…');assert.equal(user.nodeValue,'Refresh');
 for(const key of ['document','MutationObserver','NodeFilter','localStorage'])delete globalThis[key];
});
