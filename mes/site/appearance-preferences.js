import {api} from './backend.js';
import {t} from './i18n.js';
const fonts={calibri:'Calibri, Carlito, Arial, sans-serif',arial:'Arial, sans-serif',segoe:'"Segoe UI", Arial, sans-serif',tahoma:'Tahoma, Arial, sans-serif',verdana:'Verdana, Arial, sans-serif',georgia:'Georgia, serif',times:'"Times New Roman", serif',courier:'"Courier New", monospace'};
const defaults={font:'calibri',size:14},sizes=[12,14,16,18,20];
const $=id=>document.getElementById(id);
let generation=0,key=null,loading=false,site={...defaults},custom=false;
function valid(value){return value&&Object.hasOwn(fonts,value.font)&&sizes.includes(value.size)?{font:value.font,size:value.size}:{...defaults};}
function apply(value){document.documentElement.style.setProperty('--ui-font',fonts[value.font]);document.documentElement.style.fontSize=`${16*value.size/14}px`;}
function controls(value){$('appearance-font').value=value.font;$('appearance-size').value=value.size;$('appearance-inherit').checked=!custom;$('appearance-font').disabled=$('appearance-size').disabled=!custom;}
function cache(value){try{localStorage.setItem('th-mes-appearance:'+key,JSON.stringify({...value,custom}));}catch{}}
function adminControls(){$('appearance-default-font').value=site.font;$('appearance-default-size').value=site.size;}
export async function loadAppearancePreferences(user,preview=false){
 const epoch=++generation;key=user?.uid||null;loading=true;$('appearance-save').disabled=true;$('appearance-status').textContent='';
 let value={...site};custom=false;try{if(key){const cached=JSON.parse(localStorage.getItem('th-mes-appearance:'+key));if(cached&&cached.custom!==false){custom=true;value=valid(cached);}}}catch{}
 apply(value);controls(value);
 try{const [global,personal]=await Promise.all([preview?site:api('getAppearanceDefaults'),user&&!preview?api('getAppearancePreferences'):null]);if(epoch!==generation)return;site=valid(global);custom=!!personal?.custom;const stored=custom?valid(personal):site;apply(stored);controls(stored);adminControls();if(user)cache(stored);}
 catch{if(epoch===generation)$('appearance-status').textContent=t('Could not load appearance settings. Press Refresh to try again.');}
 finally{if(epoch===generation){loading=false;$('appearance-save').disabled=!user;}}
}
export function initAppearancePreferences(getContext){
 const admin=document.createElement('article');admin.className='card';admin.id='appearance-default-card';admin.hidden=true;admin.innerHTML='<h2>Default display settings</h2><p class="helper">Applies to viewers and accounts using site defaults. Personal choices are preserved. Changes appear on the next Refresh or sign-in.</p><form id="appearance-default-form" class="profile-form"><label>Site font<select id="appearance-default-font"></select></label><label>Base text size<select id="appearance-default-size"></select></label><button id="appearance-default-save" class="button primary">Save site defaults</button><p id="appearance-default-status" role="status"></p></form>';$('settings-page').append(admin);
 $('appearance-default-font').innerHTML=$('appearance-font').innerHTML;$('appearance-default-size').innerHTML=$('appearance-size').innerHTML;adminControls();
 $('appearance-inherit').onchange=()=>{const inherit=$('appearance-inherit').checked;$('appearance-font').disabled=$('appearance-size').disabled=inherit;if(inherit){$('appearance-font').value=site.font;$('appearance-size').value=site.size;}};
 $('appearance-form').onsubmit=async event=>{event.preventDefault();const context=getContext();if(!context.user||loading)return;const epoch=generation,inherit=$('appearance-inherit').checked,value=valid({font:$('appearance-font').value,size:Number($('appearance-size').value)});$('appearance-save').disabled=true;$('appearance-status').textContent='';
 try{const saved=context.preview?{...value,custom:!inherit}:await api(inherit?'resetAppearancePreferences':'saveAppearancePreferences',inherit?{}:value);if(epoch!==generation)return;custom=!inherit;const next=valid(saved);cache(next);apply(next);controls(next);$('appearance-status').textContent=t('Appearance saved. This applies only to your account.');}
 catch{if(epoch===generation)$('appearance-status').textContent=t('Could not save appearance settings. Please try again.');}
 finally{if(epoch===generation)$('appearance-save').disabled=false;}
 };
 $('appearance-reset').onclick=()=>{$('appearance-inherit').checked=true;$('appearance-inherit').onchange();};
 $('appearance-default-form').onsubmit=async event=>{event.preventDefault();const context=getContext();if(!context.isOwner||loading)return;const epoch=generation,value=valid({font:$('appearance-default-font').value,size:Number($('appearance-default-size').value)});$('appearance-default-save').disabled=true;
 try{const saved=context.preview?value:await api('saveAppearanceDefaults',value);if(epoch!==generation)return;site=valid(saved);adminControls();if(!custom){apply(site);controls(site);cache(site);}$('appearance-default-status').textContent=t('Site defaults saved. Personal choices were preserved.');}
 catch{$('appearance-default-status').textContent=t('Could not save appearance settings. Please try again.');}
 finally{$('appearance-default-save').disabled=false;}
 };
 document.addEventListener('mes:identity',()=>{admin.hidden=!getContext().isOwner;$('appearance-default-status').textContent='';});
 document.addEventListener('mes:refresh',()=>{const context=getContext();loadAppearancePreferences(context.user,context.preview);});
}
